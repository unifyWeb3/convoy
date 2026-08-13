/**
 * Deployment-only operator script for ConvoyInference.
 *
 * This file is never imported by Convoy runtime. It requires a deployment-only
 * Bradbury account and test GEN, deploys the stateless contract once, and
 * prints the address needed for CONVOY_GENLAYER_CONTRACT. The runtime provider
 * deliberately has no account/deployment surface.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAccount, createClient } from 'genlayer-js';
import { testnetBradbury } from 'genlayer-js/chains';
import { TransactionStatus, type TransactionHash } from 'genlayer-js/types';

import { readGenLayerDeploymentKey } from './deployment_config.js';

const account = createAccount(readGenLayerDeploymentKey());
const client = createClient({ chain: testnetBradbury, account });
const contractPath = resolve(dirname(fileURLToPath(import.meta.url)), 'convoy_inference.py');
const code = new Uint8Array(readFileSync(contractPath));

const txHash = (await client.deployContract({ code, args: [] })) as TransactionHash;
const receipt = await client.waitForTransactionReceipt({
  hash: txHash,
  status: TransactionStatus.ACCEPTED,
  retries: 200,
});

// SDK receipt fields vary slightly across Bradbury releases.
const decoded = receipt as unknown as {
  txDataDecoded?: { contractAddress?: string };
  toAddress?: string;
  to_address?: string;
  data?: { contract_address?: string };
};
const contractAddress =
  decoded.txDataDecoded?.contractAddress ??
  decoded.toAddress ??
  decoded.to_address ??
  decoded.data?.contract_address;
if (contractAddress === undefined) {
  throw new Error(
    `deployment accepted but contract address was not present in receipt: ${JSON.stringify(receipt)}`,
  );
}

console.log(`CONVOY_GENLAYER_CONTRACT=${contractAddress}`);
console.log(`GENLAYER_DEPLOYMENT_TX=${txHash}`);
