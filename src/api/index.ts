import { db } from "ponder:api";
import schema from "ponder:schema";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { and, asc, desc, eq, inArray, lt, lte, or, sql } from "ponder";
import { isAddress, type Address } from "viem";

import { annualize } from "../lib/apy";

// Note: GET /health, /ready, /status and /metrics are served by Ponder itself
// (they are reserved and cannot be redefined here). /health returns 200 once the
// process is up; /ready returns 200 once historical indexing has caught up.

const app = new Hono();

app.use("*", cors({ origin: "*", allowMethods: ["GET", "HEAD", "OPTIONS"], maxAge: 86400 }));

/* ------------------------------ serialization ------------------------------ */

type VaultRow = typeof schema.vault.$inferSelect;
type SnapshotRow = typeof schema.vaultSnapshot.$inferSelect;

const str = (b: bigint) => b.toString();

function serializeVault(v: VaultRow) {
  return {
    address: v.address,
    chainId: v.chainId,
    name: v.name,
    symbol: v.symbol,
    asset: v.asset,
    decimals: v.decimals,
    totalAssets: str(v.totalAssets),
    totalSupply: str(v.totalSupply),
    sharePrice: str(v.sharePrice),
    fee: str(v.fee),
    timelock: str(v.timelock),
    depositCap: str(v.depositCap),
    paused: v.paused,
    owner: v.owner,
    curator: v.curator,
    guardian: v.guardian,
    feeRecipient: v.feeRecipient,
    updatedAt: Number(v.updatedAt),
    updatedAtBlock: Number(v.updatedAtBlock),
  };
}

function serializeSnapshot(s: Pick<SnapshotRow, "timestamp" | "blockNumber" | "totalAssets" | "totalSupply" | "sharePrice">) {
  return {
    timestamp: Number(s.timestamp),
    blockNumber: Number(s.blockNumber),
    totalAssets: str(s.totalAssets),
    totalSupply: str(s.totalSupply),
    sharePrice: str(s.sharePrice),
  };
}

/* --------------------------------- helpers --------------------------------- */

function badRequest(c: Context, error: string) {
  return c.json({ error }, 400);
}

function parseAddress(raw: string): Address | null {
  return isAddress(raw, { strict: false }) ? (raw.toLowerCase() as Address) : null;
}

function parseLimit(raw: string | undefined, fallback: number, max: number): number | null {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return null;
  return Math.min(n, max);
}

async function findVault(address: Address) {
  const rows = await db.select().from(schema.vault).where(eq(schema.vault.address, address)).limit(1);
  return rows[0];
}

/** Resolves :address to an indexed vault, or returns the error response. */
async function resolveVault(c: Context): Promise<VaultRow | Response> {
  const address = parseAddress(c.req.param("address") ?? "");
  if (!address) return badRequest(c, "invalid vault address");
  const vault = await findVault(address);
  if (!vault) return c.json({ error: "vault not found" }, 404);
  return vault;
}

/* --------------------------------- routes ---------------------------------- */

app.get("/vaults", async (c) => {
  const rows = await db.select().from(schema.vault).orderBy(asc(schema.vault.createdAtBlock));
  return c.json(rows.map(serializeVault));
});

app.get("/vaults/:address", async (c) => {
  const vault = await resolveVault(c);
  if (vault instanceof Response) return vault;
  return c.json(serializeVault(vault));
});

const BUCKET_SECONDS = { hour: 3600, day: 86400 } as const;

app.get("/vaults/:address/snapshots", async (c) => {
  const vault = await resolveVault(c);
  if (vault instanceof Response) return vault;

  const interval = (c.req.query("interval") ?? "day") as keyof typeof BUCKET_SECONDS;
  if (!(interval in BUCKET_SECONDS)) return badRequest(c, "interval must be hour or day");
  const limit = parseLimit(c.req.query("limit"), interval === "hour" ? 168 : 90, 2000);
  if (limit === null) return badRequest(c, "limit must be a positive integer");

  const t = schema.vaultSnapshot;
  // Inline the bucket width (a constant from BUCKET_SECONDS, never user input) so the
  // DISTINCT ON and ORDER BY expressions are textually identical, as Postgres requires.
  const bucket = sql`(${t.timestamp} / ${sql.raw(String(BUCKET_SECONDS[interval]))})`;

  // Last snapshot in each bucket, newest buckets first, then flipped to ascending.
  const rows = await db
    .selectDistinctOn([bucket], {
      timestamp: t.timestamp,
      blockNumber: t.blockNumber,
      totalAssets: t.totalAssets,
      totalSupply: t.totalSupply,
      sharePrice: t.sharePrice,
    })
    .from(t)
    .where(eq(t.vault, vault.address))
    .orderBy(desc(bucket), desc(t.timestamp), desc(t.blockNumber))
    .limit(limit);

  return c.json(rows.reverse().map(serializeSnapshot));
});

app.get("/vaults/:address/allocations", async (c) => {
  const vault = await resolveVault(c);
  if (vault instanceof Response) return vault;

  const rows = await db
    .select()
    .from(schema.strategy)
    .where(eq(schema.strategy.vault, vault.address))
    .orderBy(desc(schema.strategy.enabled), asc(schema.strategy.addedAt));

  return c.json(
    rows.map((s) => ({
      strategy: s.address,
      target: s.target,
      cap: str(s.cap),
      pendingCap: str(s.pendingCap),
      assets: str(s.assets),
      enabled: s.enabled,
      addedAt: s.addedAt === null ? null : Number(s.addedAt),
    })),
  );
});

app.get("/vaults/:address/events", async (c) => {
  const vault = await resolveVault(c);
  if (vault instanceof Response) return vault;

  const limit = parseLimit(c.req.query("limit"), 50, 500);
  if (limit === null) return badRequest(c, "limit must be a positive integer");

  const t = schema.vaultEvent;
  const filters = [eq(t.vault, vault.address)];

  const types = (c.req.query("type") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (types.length) filters.push(inArray(t.type, types));

  // cursor = "<blockNumber>:<logIndex>" of the last item of the previous page (exclusive).
  const cursor = c.req.query("cursor");
  if (cursor) {
    const m = /^(\d+):(\d+)$/.exec(cursor);
    if (!m) return badRequest(c, "cursor must be <blockNumber>:<logIndex>");
    const block = BigInt(m[1]!);
    const logIndex = Number(m[2]);
    filters.push(or(lt(t.blockNumber, block), and(eq(t.blockNumber, block), lt(t.logIndex, logIndex)))!);
  }

  const rows = await db
    .select()
    .from(t)
    .where(and(...filters))
    .orderBy(desc(t.blockNumber), desc(t.logIndex))
    .limit(limit);

  const last = rows.at(-1);
  if (last && rows.length === limit) c.header("X-Next-Cursor", `${last.blockNumber}:${last.logIndex}`);
  c.header("Access-Control-Expose-Headers", "X-Next-Cursor");

  return c.json(
    rows.map((e) => ({
      type: e.type,
      txHash: e.txHash,
      blockNumber: Number(e.blockNumber),
      logIndex: e.logIndex,
      timestamp: Number(e.timestamp),
      args: e.args,
      cursor: `${e.blockNumber}:${e.logIndex}`,
    })),
  );
});

app.get("/vaults/:address/apy", async (c) => {
  const vault = await resolveVault(c);
  if (vault instanceof Response) return vault;

  const t = schema.vaultSnapshot;
  const [latest] = await db
    .select()
    .from(t)
    .where(eq(t.vault, vault.address))
    .orderBy(desc(t.timestamp), desc(t.blockNumber))
    .limit(1);

  const apyOver = async (days: number) => {
    if (!latest) return null;
    const cutoff = latest.timestamp - BigInt(days * 86400);
    // Latest snapshot at least `days` old; null if history does not reach back that far.
    const [base] = await db
      .select()
      .from(t)
      .where(and(eq(t.vault, vault.address), lte(t.timestamp, cutoff)))
      .orderBy(desc(t.timestamp), desc(t.blockNumber))
      .limit(1);
    return base ? annualize(base, latest) : null;
  };

  const [apy7d, apy30d] = await Promise.all([apyOver(7), apyOver(30)]);
  return c.json({
    apy7d,
    apy30d,
    asOf: latest ? Number(latest.timestamp) : null,
  });
});


export default app;
