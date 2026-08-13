import { createPublicClient, http, parseAbi, parseAbiItem, type Address, type Hex } from 'viem';
import { baseSepolia } from 'viem/chains';

export const MANIFEST_CHAIN_ID = 84532 as const;

const RUN_OPENED_EVENT = parseAbiItem(
  'event RunOpened(bytes32 indexed runId, address indexed operator, uint64 at)',
);
const ACTION_COMMITTED_EVENT = parseAbiItem(
  'event ActionCommitted(bytes32 indexed runId, uint256 indexed idx, bytes32 payloadHash, uint32 seq, uint64 at)',
);
const RUN_SEALED_EVENT = parseAbiItem(
  'event RunSealed(bytes32 indexed runId, uint32 committedCount, uint64 at)',
);

const REGISTRY_READ_ABI = parseAbi([
  'function runs(bytes32 runId) view returns (uint8 state, address operator, uint64 openedAt, uint64 sealedAt, uint32 committedCount)',
  'function committed(bytes32 runId, uint256 idx) view returns (bool)',
  'function payloadHash(bytes32 runId, uint256 idx) view returns (bytes32)',
]);

export interface RegistryRunEvent {
  readonly transactionHash: Hex;
  readonly blockNumber: string;
  readonly at: string;
}

export interface RegistryOpenEvent extends RegistryRunEvent {
  readonly operator: Address;
}

export interface RegistryCommitEvent extends RegistryRunEvent {
  readonly idx: number;
  readonly payloadHash: Hex;
  readonly sequence: number;
}

export interface RegistryRunState {
  readonly state: 'NONE' | 'OPEN' | 'SEALED' | 'UNKNOWN';
  readonly operator: Address;
  readonly openedAt: string;
  readonly sealedAt: string | null;
  readonly committedCount: number;
}

export interface RegistryItemState {
  readonly idx: number;
  readonly committed: boolean;
  readonly payloadHash: Hex;
}

export interface RegistrySnapshot {
  readonly available: true;
  readonly chainId: typeof MANIFEST_CHAIN_ID;
  readonly contractAddress: Address;
  readonly openEvents: readonly RegistryOpenEvent[];
  readonly commitEvents: readonly RegistryCommitEvent[];
  readonly sealEvents: readonly (RegistryRunEvent & { readonly committedCount: number })[];
  readonly runState: RegistryRunState;
  readonly itemState: readonly RegistryItemState[];
}

export interface RegistryUnavailable {
  readonly available: false;
  readonly chainId: typeof MANIFEST_CHAIN_ID;
  readonly contractAddress: string | null;
  readonly error: string;
}

export type RegistryReadResult = RegistrySnapshot | RegistryUnavailable;

function unixSeconds(value: bigint): string {
  return new Date(Number(value) * 1_000).toISOString();
}

function registryState(value: number): RegistryRunState['state'] {
  if (value === 0) return 'NONE';
  if (value === 1) return 'OPEN';
  if (value === 2) return 'SEALED';
  return 'UNKNOWN';
}

export function sanitizeProviderError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/https?:\/\/[^\s'"`]+/gi, '<rpc-url-redacted>')
    .replace(/(authorization|api[-_]?key|token|secret|password)=([^\s&'"`]+)/gi, '$1=<redacted>')
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer <redacted>')
    .replace(/([?&][^=\s]+)=([^&\s'"`]+)/g, '$1=<redacted>');
}

export function registryBlockRanges(
  fromBlock: bigint,
  toBlock: bigint,
): readonly [bigint, bigint][] {
  if (fromBlock > toBlock) return [];
  const ranges: [bigint, bigint][] = [];
  for (let start = fromBlock; start <= toBlock; start += 10n) {
    ranges.push([start, start + 9n > toBlock ? toBlock : start + 9n]);
  }
  return ranges;
}

function rpcChainId(url: string, fetchImpl: typeof fetch): Promise<number> {
  return fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
  }).then(async (response) => {
    if (!response.ok) throw new Error(`RPC chain id request failed with HTTP ${response.status}`);
    const body = (await response.json()) as { result?: unknown };
    if (typeof body.result !== 'string') throw new Error('RPC chain id response was unavailable');
    const chainId = Number.parseInt(body.result, 16);
    if (!Number.isInteger(chainId)) throw new Error('RPC chain id response was invalid');
    return chainId;
  });
}

function uniqueLogs<
  T extends {
    transactionHash?: string | null;
    blockHash?: string | null;
    blockNumber?: bigint | null;
    logIndex?: number | null;
  },
>(logs: readonly T[]): T[] {
  const seen = new Set<string>();
  return [...logs]
    .sort(
      (left, right) =>
        Number(left.blockNumber ?? 0n) - Number(right.blockNumber ?? 0n) ||
        Number(left.logIndex ?? 0) - Number(right.logIndex ?? 0) ||
        String(left.transactionHash ?? '').localeCompare(String(right.transactionHash ?? '')),
    )
    .filter((log) => {
      const key = `${log.transactionHash ?? ''}:${log.blockHash ?? ''}:${log.blockNumber?.toString() ?? ''}:${log.logIndex ?? ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export function sortAndDedupeRegistryLogs<
  T extends {
    transactionHash?: string | null;
    blockHash?: string | null;
    blockNumber?: bigint | null;
    logIndex?: number | null;
  },
>(logs: readonly T[]): T[] {
  return uniqueLogs(logs);
}

function required<T>(value: T | undefined, field: string): T {
  if (value === undefined) throw new Error(`registry log omitted ${field}`);
  return value;
}

/**
 * Read the registry leg from the dedicated Base Sepolia RPC.
 *
 * The receipt `to` and `from` fields are relay addresses for sponsored calls
 * (G-24), so reconciliation keys on logs emitted by this contract and the
 * operator recorded by RunOpened/storage instead.
 */
export async function readRegistrySnapshot(args: {
  readonly runIdOnchain: Hex;
  readonly itemIndices: readonly number[];
  readonly fromTransactionHash?: Hex;
  readonly toTransactionHash?: Hex;
  readonly rpcUrl?: string;
  readonly registryAddress?: string;
  readonly fetchImpl?: typeof fetch;
}): Promise<RegistryReadResult> {
  const rpcUrl = args.rpcUrl ?? process.env['BASE_RPC_URL'];
  const registryAddress = args.registryAddress ?? process.env['CONVOY_REGISTRY_ADDR'];

  if (rpcUrl === undefined || rpcUrl.trim() === '') {
    return {
      available: false,
      chainId: MANIFEST_CHAIN_ID,
      contractAddress: registryAddress ?? null,
      error: 'BASE_RPC_URL is not set; the registry source could not be read',
    };
  }
  if (registryAddress === undefined || !/^0x[0-9a-fA-F]{40}$/.test(registryAddress)) {
    return {
      available: false,
      chainId: MANIFEST_CHAIN_ID,
      contractAddress: registryAddress ?? null,
      error: 'CONVOY_REGISTRY_ADDR is missing or invalid',
    };
  }

  const address = registryAddress as Address;
  const urls = [rpcUrl, process.env['BASE_RPC_URL_FALLBACK']].filter(
    (url, index, all): url is string =>
      typeof url === 'string' && url.trim() !== '' && all.indexOf(url) === index,
  );
  const fetchImpl = args.fetchImpl ?? fetch;
  let lastError: unknown;
  for (const candidate of urls) {
    try {
      const chainId = await rpcChainId(candidate, fetchImpl);
      if (chainId !== MANIFEST_CHAIN_ID) {
        throw new Error(
          `RPC returned chain ${chainId}; manifest reads are pinned to ${MANIFEST_CHAIN_ID}`,
        );
      }
      const client = createPublicClient({
        chain: baseSepolia,
        transport: http(candidate, { fetchFn: fetchImpl }),
      });

      if (args.fromTransactionHash === undefined) {
        throw new Error('ledger has no RunOpened transaction hash to bound the registry log scan');
      }
      const [fromReceipt, toReceipt] = await Promise.all([
        client.getTransactionReceipt({ hash: args.fromTransactionHash }),
        args.toTransactionHash === undefined
          ? Promise.resolve(null)
          : client.getTransactionReceipt({ hash: args.toTransactionHash }),
      ]);
      const fromBlock = fromReceipt.blockNumber;
      const toBlock = toReceipt?.blockNumber ?? (await client.getBlockNumber());
      const ranges = registryBlockRanges(fromBlock, toBlock);
      const [openChunks, commitChunks, sealChunks, run] = await Promise.all([
        Promise.all(
          ranges.map(([rangeStart, rangeEnd]) =>
            client.getLogs({
              address,
              event: RUN_OPENED_EVENT,
              args: { runId: args.runIdOnchain },
              fromBlock: rangeStart,
              toBlock: rangeEnd,
            }),
          ),
        ),
        Promise.all(
          ranges.map(([rangeStart, rangeEnd]) =>
            client.getLogs({
              address,
              event: ACTION_COMMITTED_EVENT,
              args: { runId: args.runIdOnchain },
              fromBlock: rangeStart,
              toBlock: rangeEnd,
            }),
          ),
        ),
        Promise.all(
          ranges.map(([rangeStart, rangeEnd]) =>
            client.getLogs({
              address,
              event: RUN_SEALED_EVENT,
              args: { runId: args.runIdOnchain },
              fromBlock: rangeStart,
              toBlock: rangeEnd,
            }),
          ),
        ),
        client.readContract({
          address,
          abi: REGISTRY_READ_ABI,
          functionName: 'runs',
          args: [args.runIdOnchain],
        }),
      ]);
      const openLogs = uniqueLogs(openChunks.flat());
      const commitLogs = uniqueLogs(commitChunks.flat());
      const sealLogs = uniqueLogs(sealChunks.flat());

      const storageCalls = args.itemIndices.flatMap((idx) => [
        {
          address,
          abi: REGISTRY_READ_ABI,
          functionName: 'committed' as const,
          args: [args.runIdOnchain, BigInt(idx)] as const,
        },
        {
          address,
          abi: REGISTRY_READ_ABI,
          functionName: 'payloadHash' as const,
          args: [args.runIdOnchain, BigInt(idx)] as const,
        },
      ]);
      const storage =
        storageCalls.length === 0
          ? []
          : await client.multicall({ contracts: storageCalls, allowFailure: false });

      const itemState = args.itemIndices.map((idx, position) => ({
        idx,
        committed: storage[position * 2] as boolean,
        payloadHash: storage[position * 2 + 1] as Hex,
      }));

      return {
        available: true,
        chainId: MANIFEST_CHAIN_ID,
        contractAddress: address,
        openEvents: openLogs.map((log) => ({
          transactionHash: log.transactionHash,
          blockNumber: log.blockNumber.toString(),
          operator: required(log.args.operator, 'RunOpened.operator'),
          at: unixSeconds(required(log.args.at, 'RunOpened.at')),
        })),
        commitEvents: commitLogs.map((log) => ({
          transactionHash: log.transactionHash,
          blockNumber: log.blockNumber.toString(),
          idx: Number(required(log.args.idx, 'ActionCommitted.idx')),
          payloadHash: required(log.args.payloadHash, 'ActionCommitted.payloadHash'),
          sequence: Number(required(log.args.seq, 'ActionCommitted.seq')),
          at: unixSeconds(required(log.args.at, 'ActionCommitted.at')),
        })),
        sealEvents: sealLogs.map((log) => ({
          transactionHash: log.transactionHash,
          blockNumber: log.blockNumber.toString(),
          committedCount: Number(required(log.args.committedCount, 'RunSealed.committedCount')),
          at: unixSeconds(required(log.args.at, 'RunSealed.at')),
        })),
        runState: {
          state: registryState(run[0]),
          operator: run[1],
          openedAt: unixSeconds(run[2]),
          sealedAt: run[3] === 0n ? null : unixSeconds(run[3]),
          committedCount: Number(run[4]),
        },
        itemState,
      };
    } catch (error) {
      lastError = error;
    }
  }
  return {
    available: false,
    chainId: MANIFEST_CHAIN_ID,
    contractAddress: address,
    error: sanitizeProviderError(lastError ?? 'registry provider unavailable'),
  };
}
