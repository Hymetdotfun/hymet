// Server side of the $HYMET burn tracker: Mainnet RPC reads, the Postgres burn index, and one shared sync at a time.
import { databasePool, query } from "./db";
import { serverRpcUrl } from "./app-network";
import { withRpcRetry } from "./rpc-retry";
import {
  BURN_TRACKED_DECIMALS,
  BURN_TRACKED_MINT,
  BURN_TRACKED_SYMBOL,
  ORIGINAL_SUPPLY_RAW,
  TEAM_BURN_WALLETS,
  percentOfOriginal,
  summarizeBurns,
  syncBurns,
  type BurnRow,
  type BurnRpc,
  type BurnStore,
  type ParsedTransaction,
} from "./burn-tracker";

const SYNC_INTERVAL_MS = 30_000;
const STALE_AFTER_MS = 10 * 60_000;
const LOCK_KEY = "hymet-token-burns";

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  return withRpcRetry(async () => {
    const response = await fetch(serverRpcUrl(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw Error(`RPC ${method} failed with HTTP ${response.status}`);
    const body = (await response.json()) as { result?: T; error?: { message?: string } };
    if (body.error) throw Error(`RPC ${method}: ${body.error.message ?? "error"}`);
    return body.result as T;
  });
}

export const mainnetBurnRpc: BurnRpc = {
  async supply() {
    const r = await rpc<{ context: { slot: number }; value: { amount: string; decimals: number } }>("getTokenSupply", [BURN_TRACKED_MINT, { commitment: "finalized" }]);
    if (!/^\d+$/.test(r.value.amount)) throw Error("Unreadable $HYMET supply");
    return { amountRaw: BigInt(r.value.amount), decimals: r.value.decimals, slot: r.context.slot };
  },
  signatures(before) {
    return rpc("getSignaturesForAddress", [BURN_TRACKED_MINT, { limit: 1000, commitment: "finalized", ...(before ? { before } : {}) }]);
  },
  transaction(signature) {
    return rpc<ParsedTransaction | null>("getTransaction", [signature, { encoding: "jsonParsed", commitment: "finalized", maxSupportedTransactionVersion: 1 }]);
  },
};

export const postgresBurnStore: BurnStore = {
  async checkpoint() {
    const r = await query<{ verified_slot: string }>("SELECT verified_slot::text FROM token_burn_checkpoints WHERE mint_address=$1", [BURN_TRACKED_MINT]);
    return r.rows[0] ? { verifiedSlot: Number(r.rows[0].verified_slot) } : null;
  },
  async indexedTotal() {
    const r = await query<{ total: string }>("SELECT COALESCE(SUM(amount_raw),0)::text AS total FROM token_burns WHERE mint_address=$1", [BURN_TRACKED_MINT]);
    return BigInt(r.rows[0].total);
  },
  async insert(rows) {
    for (const r of rows)
      await query(
        `INSERT INTO token_burns(mint_address, signature, instruction_path, slot, block_time, amount_raw, authority, token_account)
         VALUES($1,$2,$3,$4,CASE WHEN $5::bigint IS NULL THEN NULL ELSE to_timestamp($5::bigint) END,$6,$7,$8)
         ON CONFLICT (mint_address, signature, instruction_path) DO NOTHING`,
        [BURN_TRACKED_MINT, r.signature, r.instructionPath, r.slot, r.blockTime, r.amountRaw.toString(), r.authority, r.tokenAccount],
      );
  },
  async verified(c) {
    await query(
      `INSERT INTO token_burn_checkpoints(mint_address, verified_slot, supply_raw, burned_raw, verified_at, last_attempt_at, last_error)
       VALUES($1,$2,$3,$4,now(),now(),NULL)
       ON CONFLICT (mint_address) DO UPDATE SET verified_slot=EXCLUDED.verified_slot, supply_raw=EXCLUDED.supply_raw,
         burned_raw=EXCLUDED.burned_raw, verified_at=now(), last_attempt_at=now(), last_error=NULL
       WHERE token_burn_checkpoints.verified_slot <= EXCLUDED.verified_slot`,
      [BURN_TRACKED_MINT, c.verifiedSlot, c.supplyRaw.toString(), c.burnedRaw.toString()],
    );
  },
  async failed(message) {
    await query("UPDATE token_burn_checkpoints SET last_attempt_at=now(), last_error=$2 WHERE mint_address=$1", [BURN_TRACKED_MINT, message.slice(0, 500)]);
  },
};

let running: Promise<void> | undefined;
let lastStarted = 0;
/** At most one sync per process, at most every 30 seconds, and one across processes through a Postgres advisory lock. */
export function syncBurnsInBackground(): Promise<void> {
  if (running) return running;
  if (Date.now() - lastStarted < SYNC_INTERVAL_MS) return Promise.resolve();
  lastStarted = Date.now();
  running = (async () => {
    const pool = await databasePool();
    const client = await pool.connect();
    try {
      const lock = await client.query<{ ok: boolean }>("SELECT pg_try_advisory_lock(hashtext($1)) AS ok", [LOCK_KEY]);
      if (!lock.rows[0]?.ok) return;
      try {
        await syncBurns(mainnetBurnRpc, postgresBurnStore);
      } catch (error) {
        await postgresBurnStore.failed(error instanceof Error ? error.message : String(error)).catch(() => undefined);
      } finally {
        await client.query("SELECT pg_advisory_unlock(hashtext($1))", [LOCK_KEY]);
      }
    } finally {
      client.release();
      running = undefined;
    }
  })().catch(() => {
    running = undefined;
  });
  return running;
}

export type BurnReport = {
  status: "verified" | "stale" | "indexing" | "unavailable";
  mint: string;
  symbol: string;
  decimals: number;
  originalSupplyRaw: string;
  supplyRaw?: string;
  burnedRaw?: string;
  burnedPercent?: string;
  team?: { wallets: readonly string[]; burnedRaw: string; count: number };
  other?: { burnedRaw: string; count: number };
  burnCount?: number;
  lastBurnAt?: string | null;
  updatedAt?: string;
  verifiedSlot?: number;
  recent?: { signature: string; amountRaw: string; team: boolean; blockTime: string | null }[];
};

/** The last verified burn state. Nothing is reported as verified unless its burns add up exactly to the supply reduction. */
export async function burnReport(): Promise<BurnReport> {
  const base = { mint: BURN_TRACKED_MINT, symbol: BURN_TRACKED_SYMBOL, decimals: BURN_TRACKED_DECIMALS, originalSupplyRaw: ORIGINAL_SUPPLY_RAW.toString() };
  const cp = await query<{ verified_slot: string; supply_raw: string; burned_raw: string; verified_at: Date }>(
    "SELECT verified_slot::text, supply_raw::text, burned_raw::text, verified_at FROM token_burn_checkpoints WHERE mint_address=$1",
    [BURN_TRACKED_MINT],
  );
  const checkpoint = cp.rows[0];
  if (!checkpoint) return { status: "indexing", ...base };
  const verifiedSlot = Number(checkpoint.verified_slot);
  const rows = await query<{ signature: string; instruction_path: string; slot: string; block_time: Date | null; amount_raw: string; authority: string; token_account: string }>(
    "SELECT signature, instruction_path, slot::text, block_time, amount_raw::text, authority, token_account FROM token_burns WHERE mint_address=$1 AND slot <= $2",
    [BURN_TRACKED_MINT, verifiedSlot],
  );
  const burns: BurnRow[] = rows.rows.map((r) => ({
    signature: r.signature,
    instructionPath: r.instruction_path,
    slot: Number(r.slot),
    blockTime: r.block_time ? Math.floor(r.block_time.getTime() / 1000) : null,
    amountRaw: BigInt(r.amount_raw),
    authority: r.authority,
    tokenAccount: r.token_account,
  }));
  const summary = summarizeBurns(burns, verifiedSlot);
  const burnedRaw = BigInt(checkpoint.burned_raw);
  if (summary.burnedRaw !== burnedRaw || ORIGINAL_SUPPLY_RAW - BigInt(checkpoint.supply_raw) !== burnedRaw) return { status: "unavailable", ...base };
  return {
    ...base,
    status: Date.now() - checkpoint.verified_at.getTime() > STALE_AFTER_MS ? "stale" : "verified",
    supplyRaw: checkpoint.supply_raw,
    burnedRaw: burnedRaw.toString(),
    burnedPercent: percentOfOriginal(burnedRaw),
    team: { wallets: TEAM_BURN_WALLETS, burnedRaw: summary.teamBurnedRaw.toString(), count: summary.teamCount },
    other: { burnedRaw: summary.otherBurnedRaw.toString(), count: summary.otherCount },
    burnCount: summary.teamCount + summary.otherCount,
    lastBurnAt: summary.lastBurnAt === null ? null : new Date(summary.lastBurnAt * 1000).toISOString(),
    updatedAt: checkpoint.verified_at.toISOString(),
    verifiedSlot,
    recent: summary.recent.map((r) => ({ signature: r.signature, amountRaw: r.amountRaw.toString(), team: r.team, blockTime: r.blockTime === null ? null : new Date(r.blockTime * 1000).toISOString() })),
  };
}
