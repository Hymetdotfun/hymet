// Server-only: instant graduation. The chain decides: syncGraduation reads the DBC pool, records a verified DAMM v2
// destination once migrated, and marks a complete curve "graduating". Only then is a graduation request queued for
// the keeper's watcher; the request carries no authority (the keeper re-checks every migration condition itself), so
// repeated or concurrent calls are harmless. Duplicate migrations are impossible on-chain and the watcher serializes
// runs with the periodic keeper.
import type { Connection } from "@solana/web3.js";
import { query } from "./db";
import { syncGraduation } from "./graduation";
import { HYPE_MINT } from "./quote-assets";

export type GraduationState = {
  status: "bonding" | "graduating" | "graduated" | "unknown";
  dammPool?: string;
  request?: "pending" | "processing" | "done" | "failed";
};

/** A finished or failed request is re-armed only after this long, so polling cannot spin the keeper. */
const REARM_SECONDS = 45;
/** After this many watcher attempts only the periodic keeper retries (it runs every few minutes regardless). */
const MAX_ATTEMPTS = 5;

export async function graduationState(mint: string): Promise<GraduationState> {
  const token = (
    await query<{ status: string; damm_pool: string | null; request: GraduationState["request"] | null }>(
      `SELECT t.status,
              (SELECT p.pool_address FROM pools p WHERE p.mint_address=t.mint_address AND p.protocol='meteora_damm_v2' AND p.status='active') AS damm_pool,
              (SELECT g.status FROM graduation_requests g WHERE g.mint_address=t.mint_address) AS request
         FROM tokens t WHERE t.mint_address=$1 AND t.quote_mint=$2`,
      [mint, HYPE_MINT.toBase58()],
    )
  ).rows[0];
  if (!token) return { status: "unknown" };
  const status = token.damm_pool ? "graduated" : token.status === "graduating" ? "graduating" : token.status === "bonding" ? "bonding" : "unknown";
  return { status, ...(token.damm_pool ? { dammPool: token.damm_pool } : {}), ...(token.request ? { request: token.request } : {}) };
}

/** Sync with the chain, and queue the keeper when the curve is complete but not yet migrated. */
export async function ensureGraduation(c: Connection, mint: string): Promise<GraduationState> {
  await syncGraduation(c, mint);
  const state = await graduationState(mint);
  if (state.status !== "graduating") return state;
  await query(
    `INSERT INTO graduation_requests(mint_address) VALUES($1)
       ON CONFLICT (mint_address) DO UPDATE SET status='pending', last_error=NULL, updated_at=now()
       WHERE graduation_requests.status IN ('done','failed') AND graduation_requests.updated_at < now() - make_interval(secs => $2)
         AND graduation_requests.attempts < $3`,
    [mint, REARM_SECONDS, MAX_ATTEMPTS],
  );
  return graduationState(mint);
}
