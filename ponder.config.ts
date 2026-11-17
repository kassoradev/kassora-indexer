import { createConfig } from "ponder";

import { KassoraVaultAbi } from "./abis/KassoraVaultAbi";
import {
  readChainId,
  readRpcUrl,
  readSnapshotInterval,
  readStartBlock,
  readVaultAddresses,
} from "./src/lib/env";

// One config for mainnet (4663), testnet (46630) and local anvil (31337).
// Everything network-specific comes from the environment; see .env.example.
const chainId = readChainId();
const vaults = readVaultAddresses();
const startBlock = readStartBlock();

export default createConfig({
  database: process.env.DATABASE_URL
    ? { kind: "postgres", connectionString: process.env.DATABASE_URL }
    : { kind: "pglite" },
  chains: {
    robinhood: {
      id: chainId,
      rpc: readRpcUrl(chainId),
      pollingInterval: Number(process.env.PONDER_POLLING_INTERVAL_MS ?? 1_000),
    },
  },
  contracts: {
    KassoraVault: {
      chain: "robinhood",
      abi: KassoraVaultAbi,
      address: vaults,
      startBlock,
    },
  },
  blocks: {
    // Periodic state reads for the share-price / TVL time series.
    VaultSnapshot: {
      chain: "robinhood",
      startBlock,
      interval: readSnapshotInterval(),
    },
  },
});
