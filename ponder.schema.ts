import { index, onchainTable, primaryKey } from "ponder";

/** Current state of each vault. Amounts are raw base units. */
export const vault = onchainTable("vault", (t) => ({
  address: t.hex().primaryKey(),
  chainId: t.integer().notNull(),
  name: t.text().notNull(),
  symbol: t.text().notNull(),
  asset: t.hex().notNull(),
  /** Vault share decimals = asset decimals + decimals offset. */
  decimals: t.integer().notNull(),
  totalAssets: t.bigint().notNull(),
  totalSupply: t.bigint().notNull(),
  /** convertToAssets(10 ** decimals): asset base units per 1 whole share. */
  sharePrice: t.bigint().notNull(),
  /** WAD (1e18 = 100%). */
  fee: t.bigint().notNull(),
  /** Seconds. */
  timelock: t.bigint().notNull(),
  depositCap: t.bigint().notNull(),
  paused: t.boolean().notNull(),
  owner: t.hex().notNull(),
  curator: t.hex().notNull(),
  guardian: t.hex().notNull(),
  feeRecipient: t.hex().notNull(),
  createdAtBlock: t.bigint().notNull(),
  updatedAt: t.bigint().notNull(),
  updatedAtBlock: t.bigint().notNull(),
}));

/** Time series of vault state. One row per (vault, block). */
export const vaultSnapshot = onchainTable(
  "vault_snapshot",
  (t) => ({
    id: t.text().primaryKey(), // `${vault}-${blockNumber}`
    vault: t.hex().notNull(),
    timestamp: t.bigint().notNull(),
    blockNumber: t.bigint().notNull(),
    totalAssets: t.bigint().notNull(),
    totalSupply: t.bigint().notNull(),
    sharePrice: t.bigint().notNull(),
  }),
  (table) => ({
    vaultTimeIdx: index().on(table.vault, table.timestamp),
  }),
);

export const strategy = onchainTable(
  "strategy",
  (t) => ({
    address: t.hex().primaryKey(),
    vault: t.hex().notNull(),
    /** Underlying ERC-4626 the strategy deposits into. */
    target: t.hex().notNull(),
    cap: t.bigint().notNull(),
    /** Cap submitted but not yet accepted (0 = none). */
    pendingCap: t.bigint().notNull(),
    enabled: t.boolean().notNull(),
    assets: t.bigint().notNull(),
    addedAt: t.bigint(), // timestamp of StrategyAdded, null while only submitted
    updatedAt: t.bigint().notNull(),
  }),
  (table) => ({
    vaultIdx: index().on(table.vault),
  }),
);

/** Share balance and cumulative flows per (vault, account). */
export const userPosition = onchainTable(
  "user_position",
  (t) => ({
    vault: t.hex().notNull(),
    account: t.hex().notNull(),
    shares: t.bigint().notNull(),
    depositedAssets: t.bigint().notNull(),
    withdrawnAssets: t.bigint().notNull(),
    updatedAt: t.bigint().notNull(),
  }),
  (table) => ({
    pk: primaryKey({ columns: [table.vault, table.account] }),
  }),
);

/** ERC-4626 Deposit / Withdraw logs. */
export const depositWithdraw = onchainTable(
  "deposit_withdraw",
  (t) => ({
    id: t.text().primaryKey(), // `${txHash}-${logIndex}`
    vault: t.hex().notNull(),
    kind: t.text().notNull(), // "deposit" | "withdraw"
    sender: t.hex().notNull(),
    receiver: t.hex().notNull(),
    owner: t.hex().notNull(),
    assets: t.bigint().notNull(),
    shares: t.bigint().notNull(),
    txHash: t.hex().notNull(),
    blockNumber: t.bigint().notNull(),
    logIndex: t.integer().notNull(),
    timestamp: t.bigint().notNull(),
  }),
  (table) => ({
    vaultIdx: index().on(table.vault, table.blockNumber),
    ownerIdx: index().on(table.owner),
  }),
);

/** Rebalances and governance actions, for the transparency feed. */
export const vaultEvent = onchainTable(
  "vault_event",
  (t) => ({
    id: t.text().primaryKey(), // `${txHash}-${logIndex}`
    vault: t.hex().notNull(),
    type: t.text().notNull(),
    txHash: t.hex().notNull(),
    blockNumber: t.bigint().notNull(),
    logIndex: t.integer().notNull(),
    timestamp: t.bigint().notNull(),
    /** Decoded event args; bigints as decimal strings. */
    args: t.json().notNull(),
  }),
  (table) => ({
    vaultOrderIdx: index().on(table.vault, table.blockNumber, table.logIndex),
    typeIdx: index().on(table.vault, table.type),
  }),
);
