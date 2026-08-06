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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  try {
    const client = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
    const chainId = await client.getChainId();
    if (chainId !== MANIFEST_CHAIN_ID) {
      throw new Error(
        `BASE_RPC_URL returned chain ${chainId}; manifest reads are pinned to ${MANIFEST_CHAIN_ID}`,
      );
    }

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
    const toBlock = toReceipt?.blockNumber ?? 'latest';

    const [openLogs, commitLogs, sealLogs, run] = await Promise.all([
      client.getLogs({
        address,
        event: RUN_OPENED_EVENT,
        args: { runId: args.runIdOnchain },
        fromBlock,
        toBlock,
      }),
      client.getLogs({
        address,
        event: ACTION_COMMITTED_EVENT,
        args: { runId: args.runIdOnchain },
        fromBlock,
        toBlock,
      }),
      client.getLogs({
        address,
        event: RUN_SEALED_EVENT,
        args: { runId: args.runIdOnchain },
        fromBlock,
        toBlock,
      }),
      client.readContract({
        address,
        abi: REGISTRY_READ_ABI,
        functionName: 'runs',
        args: [args.runIdOnchain],
      }),
    ]);

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
    return {
      available: false,
      chainId: MANIFEST_CHAIN_ID,
      contractAddress: address,
      error: errorMessage(error),
    };
  }
}
