import { ponder } from "ponder:registry";
import schema from "ponder:schema";
import { zeroAddress } from "viem";

import {
  bumpPosition,
  ensureStrategy,
  ensureVault,
  lower,
  patchStrategy,
  patchVault,
  recordEvent,
  refreshVault,
} from "./lib/vault";

/* ----------------------------- periodic snapshots ---------------------------- */

ponder.on("VaultSnapshot:block", async ({ event, context }) => {
  for (const address of context.contracts.KassoraVault.address) {
    // Skip vaults that have not been deployed / seen yet at this block.
    const v = await context.db.find(schema.vault, { address: lower(address) });
    if (!v) continue;
    await refreshVault(context, v.address, event.block, { strategies: true });
  }
});

/* ------------------------------- deposits/exits ------------------------------ */

ponder.on("KassoraVault:Deposit", async ({ event, context }) => {
  const vault = event.log.address;
  await context.db.insert(schema.depositWithdraw).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    vault: lower(vault),
    kind: "deposit",
    sender: lower(event.args.sender),
    receiver: lower(event.args.owner), // ERC-4626 Deposit(sender, owner=receiver, ...)
    owner: lower(event.args.owner),
    assets: event.args.assets,
    shares: event.args.shares,
    txHash: event.transaction.hash,
    blockNumber: event.block.number,
    logIndex: event.log.logIndex,
    timestamp: event.block.timestamp,
  });
  await bumpPosition(context, vault, event.args.owner, event.block.timestamp, { deposited: event.args.assets });
  await refreshVault(context, vault, event.block);
});

ponder.on("KassoraVault:Withdraw", async ({ event, context }) => {
  const vault = event.log.address;
  await context.db.insert(schema.depositWithdraw).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    vault: lower(vault),
    kind: "withdraw",
    sender: lower(event.args.sender),
    receiver: lower(event.args.receiver),
    owner: lower(event.args.owner),
    assets: event.args.assets,
    shares: event.args.shares,
    txHash: event.transaction.hash,
    blockNumber: event.block.number,
    logIndex: event.log.logIndex,
    timestamp: event.block.timestamp,
  });
  await bumpPosition(context, vault, event.args.owner, event.block.timestamp, { withdrawn: event.args.assets });
  // Withdrawals may pull liquidity from strategies.
  await refreshVault(context, vault, event.block, { strategies: true });
});

ponder.on("KassoraVault:Transfer", async ({ event, context }) => {
  const { from, to, value } = event.args;
  if (value === 0n) return;
  const vault = event.log.address;
  if (from !== zeroAddress) await bumpPosition(context, vault, from, event.block.timestamp, { shares: -value });
  if (to !== zeroAddress) await bumpPosition(context, vault, to, event.block.timestamp, { shares: value });
});

ponder.on("KassoraVault:AccrueFee", async ({ event, context }) => {
  // Fires on every deposit/withdraw/rebalance; only keep the ones that minted fee shares.
  if (event.args.feeShares > 0n) await recordEvent(context, event, "AccrueFee");
});

/* --------------------------------- rebalances -------------------------------- */

ponder.on("KassoraVault:Allocate", async ({ event, context }) => {
  await recordEvent(context, event, "Allocate");
  await refreshVault(context, event.log.address, event.block, { strategies: true });
});

ponder.on("KassoraVault:Deallocate", async ({ event, context }) => {
  await recordEvent(context, event, "Deallocate");
  await refreshVault(context, event.log.address, event.block, { strategies: true });
});

ponder.on("KassoraVault:EmergencyExit", async ({ event, context }) => {
  await recordEvent(context, event, "EmergencyExit");
  await refreshVault(context, event.log.address, event.block, { strategies: true });
});

ponder.on("KassoraVault:ForceRemoveStrategy", async ({ event, context }) => {
  await recordEvent(context, event, "ForceRemoveStrategy");
  await refreshVault(context, event.log.address, event.block, { strategies: true });
});

/* --------------------------------- strategies -------------------------------- */

ponder.on("KassoraVault:SubmitCap", async ({ event, context }) => {
  await ensureVault(context, event.log.address, event.block);
  await patchStrategy(context, event.log.address, event.args.strategy, event.block, { pendingCap: event.args.cap });
  await recordEvent(context, event, "SubmitCap");
});

ponder.on("KassoraVault:SetCap", async ({ event, context }) => {
  // Every SetCap path (lower now, acceptCap, emergencyExit) leaves nothing pending.
  await patchStrategy(context, event.log.address, event.args.strategy, event.block, {
    cap: event.args.cap,
    pendingCap: 0n,
  });
  await recordEvent(context, event, "SetCap");
});

ponder.on("KassoraVault:RevokePendingCap", async ({ event, context }) => {
  await patchStrategy(context, event.log.address, event.args.strategy, event.block, { pendingCap: 0n });
  await recordEvent(context, event, "RevokePendingCap");
});

ponder.on("KassoraVault:StrategyAdded", async ({ event, context }) => {
  await ensureStrategy(context, event.log.address, event.args.strategy, event.block);
  await patchStrategy(context, event.log.address, event.args.strategy, event.block, {
    enabled: true,
    addedAt: event.block.timestamp,
  });
  await recordEvent(context, event, "StrategyAdded");
});

ponder.on("KassoraVault:StrategyRemoved", async ({ event, context }) => {
  await patchStrategy(context, event.log.address, event.args.strategy, event.block, {
    enabled: false,
    cap: 0n,
    pendingCap: 0n,
    assets: 0n,
  });
  await recordEvent(context, event, "StrategyRemoved");
});

ponder.on("KassoraVault:SetWithdrawQueue", async ({ event, context }) => {
  await recordEvent(context, event, "SetWithdrawQueue");
});

/* --------------------------------- governance -------------------------------- */

ponder.on("KassoraVault:OwnershipTransferred", async ({ event, context }) => {
  await patchVault(context, event.log.address, event.block, { owner: lower(event.args.newOwner) });
  await recordEvent(context, event, "OwnershipTransferred");
});

ponder.on("KassoraVault:OwnershipTransferStarted", async ({ event, context }) => {
  await recordEvent(context, event, "OwnershipTransferStarted");
});

ponder.on("KassoraVault:SetCurator", async ({ event, context }) => {
  await patchVault(context, event.log.address, event.block, { curator: lower(event.args.curator) });
  await recordEvent(context, event, "SetCurator");
});

ponder.on("KassoraVault:SetGuardian", async ({ event, context }) => {
  await patchVault(context, event.log.address, event.block, { guardian: lower(event.args.guardian) });
  await recordEvent(context, event, "SetGuardian");
});

ponder.on("KassoraVault:SetFeeRecipient", async ({ event, context }) => {
  await patchVault(context, event.log.address, event.block, { feeRecipient: lower(event.args.feeRecipient) });
  await recordEvent(context, event, "SetFeeRecipient");
});

ponder.on("KassoraVault:SetDepositCap", async ({ event, context }) => {
  await patchVault(context, event.log.address, event.block, { depositCap: event.args.depositCap });
  await recordEvent(context, event, "SetDepositCap");
});

ponder.on("KassoraVault:SubmitTimelock", async ({ event, context }) => {
  await recordEvent(context, event, "SubmitTimelock");
});

ponder.on("KassoraVault:SetTimelock", async ({ event, context }) => {
  await patchVault(context, event.log.address, event.block, { timelock: event.args.newTimelock });
  await recordEvent(context, event, "SetTimelock");
});

ponder.on("KassoraVault:RevokePendingTimelock", async ({ event, context }) => {
  await recordEvent(context, event, "RevokePendingTimelock");
});

ponder.on("KassoraVault:SubmitFee", async ({ event, context }) => {
  await recordEvent(context, event, "SubmitFee");
});

ponder.on("KassoraVault:SetFee", async ({ event, context }) => {
  await patchVault(context, event.log.address, event.block, { fee: event.args.newFee });
  await recordEvent(context, event, "SetFee");
});

ponder.on("KassoraVault:RevokePendingFee", async ({ event, context }) => {
  await recordEvent(context, event, "RevokePendingFee");
});

ponder.on("KassoraVault:Paused", async ({ event, context }) => {
  await patchVault(context, event.log.address, event.block, { paused: true });
  await recordEvent(context, event, "Paused");
});

ponder.on("KassoraVault:Unpaused", async ({ event, context }) => {
  await patchVault(context, event.log.address, event.block, { paused: false });
  await recordEvent(context, event, "Unpaused");
});
