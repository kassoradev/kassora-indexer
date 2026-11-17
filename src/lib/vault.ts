import type { Context } from "ponder:registry";
import schema from "ponder:schema";
import type { Address, Hex } from "viem";

import { ERC4626StrategyAbi } from "../../abis/ERC4626StrategyAbi";
import { KassoraVaultAbi } from "../../abis/KassoraVaultAbi";

type Block = { number: bigint; timestamp: bigint };

export const lower = (a: string) => a.toLowerCase() as Address;

/** Make decoded event args JSON-safe: bigints to decimal strings, addresses lowercase. */
export function toJsonArgs(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return /^0x[0-9a-fA-F]{40}$/.test(value) ? value.toLowerCase() : value;
  if (Array.isArray(value)) return value.map(toJsonArgs);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toJsonArgs(v)]));
  }
  return value;
}

/** Load the vault row, creating it from on-chain reads the first time the vault is seen. */
export async function ensureVault(context: Context, address: Address, block: Block) {
  const vault = lower(address);
  const existing = await context.db.find(schema.vault, { address: vault });
  if (existing) return existing;

  const read = <const fn extends string>(functionName: fn) =>
    context.client.readContract({ abi: KassoraVaultAbi, address: vault, functionName } as never);

  const [name, symbol, asset, decimals, fee, timelock, depositCap, paused, owner, curator, guardian, feeRecipient] =
    (await Promise.all([
      read("name"),
      read("symbol"),
      read("asset"),
      read("decimals"),
      read("fee"),
      read("timelock"),
      read("depositCap"),
      read("paused"),
      read("owner"),
      read("curator"),
      read("guardian"),
      read("feeRecipient"),
    ])) as [string, string, Address, number, bigint, bigint, bigint, boolean, Address, Address, Address, Address];

  const stats = (await readStats(context, vault, decimals)) ?? { totalAssets: 0n, totalSupply: 0n, sharePrice: 0n };

  return context.db
    .insert(schema.vault)
    .values({
      address: vault,
      chainId: context.chain.id,
      name,
      symbol,
      asset: lower(asset),
      decimals: Number(decimals),
      ...stats,
      fee,
      timelock,
      depositCap,
      paused,
      owner: lower(owner),
      curator: lower(curator),
      guardian: lower(guardian),
      feeRecipient: lower(feeRecipient),
      createdAtBlock: block.number,
      updatedAt: block.timestamp,
      updatedAtBlock: block.number,
    })
    .onConflictDoNothing()
    .then(async (row) => row ?? (await context.db.find(schema.vault, { address: vault }))!);
}

/**
 * Totals and share price at this block, or null when a read reverts. totalAssets() reverts while
 * a strategy's views revert (until the guardian force-removes it), and that must not halt indexing.
 */
async function readStats(context: Context, vault: Address, decimals: number) {
  try {
    const [totalAssets, totalSupply, sharePrice] = await Promise.all([
      context.client.readContract({ abi: KassoraVaultAbi, address: vault, functionName: "totalAssets" }),
      context.client.readContract({ abi: KassoraVaultAbi, address: vault, functionName: "totalSupply" }),
      context.client.readContract({
        abi: KassoraVaultAbi,
        address: vault,
        functionName: "convertToAssets",
        args: [10n ** BigInt(decimals)],
      }),
    ]);
    return { totalAssets, totalSupply, sharePrice };
  } catch (err) {
    console.warn(`readStats(${vault}) reverted; skipping snapshot`, (err as Error).message);
    return null;
  }
}

/** Patch vault fields that an event changed directly, bumping updatedAt. */
export async function patchVault(
  context: Context,
  address: Address,
  block: Block,
  patch: Partial<typeof schema.vault.$inferInsert>,
) {
  await ensureVault(context, address, block);
  await context.db
    .update(schema.vault, { address: lower(address) })
    .set({ ...patch, updatedAt: block.timestamp, updatedAtBlock: block.number });
}

/**
 * Re-read totals and share price at this block, write them to the vault row, and
 * upsert a snapshot. Optionally refresh `assets` for every strategy in the withdraw queue.
 */
export async function refreshVault(
  context: Context,
  address: Address,
  block: Block,
  opts: { strategies?: boolean } = {},
) {
  const v = await ensureVault(context, address, block);
  const stats = await readStats(context, v.address, v.decimals);
  if (stats) await writeStats(context, v.address, block, stats);
  if (opts.strategies) await refreshStrategyAssets(context, v.address, block);
}

async function writeStats(
  context: Context,
  vault: Address,
  block: Block,
  stats: { totalAssets: bigint; totalSupply: bigint; sharePrice: bigint },
) {
  const v = { address: vault };
  await context.db
    .update(schema.vault, { address: v.address })
    .set({ ...stats, updatedAt: block.timestamp, updatedAtBlock: block.number });

  await context.db
    .insert(schema.vaultSnapshot)
    .values({
      id: `${v.address}-${block.number}`,
      vault: v.address,
      timestamp: block.timestamp,
      blockNumber: block.number,
      ...stats,
    })
    .onConflictDoUpdate(stats);
}

async function refreshStrategyAssets(context: Context, vault: Address, block: Block) {
  const len = await context.client.readContract({
    abi: KassoraVaultAbi,
    address: vault,
    functionName: "withdrawQueueLength",
  });
  for (let i = 0n; i < len; i++) {
    const strat = lower(
      await context.client.readContract({
        abi: KassoraVaultAbi,
        address: vault,
        functionName: "withdrawQueue",
        args: [i],
      }),
    );
    let assets: bigint;
    try {
      assets = await context.client.readContract({
        abi: ERC4626StrategyAbi,
        address: strat,
        functionName: "totalAssets",
      });
    } catch {
      continue; // broken strategy: keep the last known value
    }
    await ensureStrategy(context, vault, strat, block);
    await context.db.update(schema.strategy, { address: strat }).set({ assets, updatedAt: block.timestamp });
  }
}

/** Load the strategy row, creating it (disabled, cap 0) the first time it is referenced. */
export async function ensureStrategy(context: Context, vault: Address, address: Address, block: Block) {
  const strat = lower(address);
  const existing = await context.db.find(schema.strategy, { address: strat });
  if (existing) return existing;
  // target() exists on ERC4626Strategy only; other IStrategy adapters get the zero address.
  const target = await context.client
    .readContract({ abi: ERC4626StrategyAbi, address: strat, functionName: "target" })
    .catch(() => "0x0000000000000000000000000000000000000000" as Address);
  return context.db.insert(schema.strategy).values({
    address: strat,
    vault: lower(vault),
    target: lower(target),
    cap: 0n,
    pendingCap: 0n,
    enabled: false,
    assets: 0n,
    addedAt: null,
    updatedAt: block.timestamp,
  });
}

export async function patchStrategy(
  context: Context,
  vault: Address,
  address: Address,
  block: Block,
  patch: Partial<typeof schema.strategy.$inferInsert>,
) {
  await ensureStrategy(context, vault, address, block);
  await context.db
    .update(schema.strategy, { address: lower(address) })
    .set({ ...patch, updatedAt: block.timestamp });
}

/** Append to the governance / rebalance feed. */
export async function recordEvent(
  context: Context,
  event: { args: unknown; block: Block; log: { address: Address; logIndex: number }; transaction: { hash: Hex } },
  type: string,
) {
  await context.db
    .insert(schema.vaultEvent)
    .values({
      id: `${event.transaction.hash}-${event.log.logIndex}`,
      vault: lower(event.log.address),
      type,
      txHash: event.transaction.hash,
      blockNumber: event.block.number,
      logIndex: event.log.logIndex,
      timestamp: event.block.timestamp,
      args: toJsonArgs(event.args ?? {}),
    })
    .onConflictDoNothing();
}

/** Apply a share delta to an account's position. */
export async function bumpPosition(
  context: Context,
  vault: Address,
  account: Address,
  timestamp: bigint,
  delta: { shares?: bigint; deposited?: bigint; withdrawn?: bigint },
) {
  const key = { vault: lower(vault), account: lower(account) };
  await context.db
    .insert(schema.userPosition)
    .values({
      ...key,
      shares: delta.shares ?? 0n,
      depositedAssets: delta.deposited ?? 0n,
      withdrawnAssets: delta.withdrawn ?? 0n,
      updatedAt: timestamp,
    })
    .onConflictDoUpdate((row) => ({
      shares: row.shares + (delta.shares ?? 0n),
      depositedAssets: row.depositedAssets + (delta.deposited ?? 0n),
      withdrawnAssets: row.withdrawnAssets + (delta.withdrawn ?? 0n),
      updatedAt: timestamp,
    }));
}
