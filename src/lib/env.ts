import { getAddress, isAddress, type Address } from "viem";

/** Chains this indexer knows how to run against. */
export const SUPPORTED_CHAINS = {
  4663: "robinhood",
  46630: "robinhood-testnet",
  31337: "anvil",
} as const;

export type SupportedChainId = keyof typeof SUPPORTED_CHAINS;

function fail(message: string): never {
  throw new Error(`[kassora-indexer] ${message}`);
}

export function readChainId(): SupportedChainId {
  const raw = process.env.CHAIN_ID ?? "4663";
  const id = Number(raw);
  if (!(id in SUPPORTED_CHAINS)) {
    fail(`CHAIN_ID=${raw} is not supported. Use one of ${Object.keys(SUPPORTED_CHAINS).join(", ")}.`);
  }
  return id as SupportedChainId;
}

export function readRpcUrl(chainId: SupportedChainId): string {
  const key = `PONDER_RPC_URL_${chainId}`;
  const url = process.env[key];
  if (!url) fail(`${key} is not set. The RPC URL must come from the environment.`);
  return url;
}

/** VAULT_ADDRESS may be a single address or a comma-separated list. Returned lowercase. */
export function readVaultAddresses(): Address[] {
  const raw = process.env.VAULT_ADDRESS;
  if (!raw) fail("VAULT_ADDRESS is not set.");
  const list = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.length === 0) fail("VAULT_ADDRESS is empty.");
  return list.map((a) => {
    if (!isAddress(a, { strict: false })) fail(`VAULT_ADDRESS entry "${a}" is not an address.`);
    return getAddress(a).toLowerCase() as Address;
  });
}

function readInt(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) fail(`${name}=${raw} must be an integer >= ${min}.`);
  return n;
}

export const readStartBlock = () => readInt("VAULT_START_BLOCK", 0, 0);
export const readSnapshotInterval = () => readInt("SNAPSHOT_INTERVAL_BLOCKS", 3600, 1);
