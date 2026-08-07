import {
  checkAndExecute,
  type AttemptRef,
  type CheckAndExecuteResult,
  type ContractCallParams,
  type KhClient,
} from '@convoy/kh-client';

import { REGISTRY_ABI } from '../abis.js';

/**
 * The app-side gate proves every declared dependency is LANDED. KeeperHub's
 * endpoint supports one condition, so the additional atomic guard uses the
 * lowest declared dependency index deterministically. It never replaces the
 * all-dependencies ledger check and it never causes a second target write.
 */
export function selectOnchainDependency(dependsOn: readonly number[]): number | undefined {
  return [...dependsOn].sort((a, b) => a - b)[0];
}

export async function executeWithDependencyGate(args: {
  readonly kh: KhClient;
  readonly registryAddr: string;
  readonly runIdOnchain: string;
  readonly dependencyIdx: number;
  readonly action: ContractCallParams;
  readonly ref: AttemptRef;
}): Promise<CheckAndExecuteResult> {
  return await checkAndExecute(
    args.kh,
    {
      check: {
        contractAddress: args.registryAddr,
        functionName: 'isCommitted',
        functionArgs: [args.runIdOnchain, String(args.dependencyIdx)],
        abi: REGISTRY_ABI as unknown as readonly unknown[],
      },
      condition: { operator: 'eq', value: true },
      action: args.action,
    },
    args.ref,
  );
}
