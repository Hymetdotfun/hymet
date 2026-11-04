import { NextResponse } from "next/server";
import { Connection } from "@solana/web3.js";
import { query, databaseConfigured } from "../../../lib/db";
import { HYPE_MINT } from "../../../lib/quote-assets";
import { directoryMetrics } from "../../../lib/market-data";
import { publicTokenExcludedMints } from "../../../lib/public-token-exclusions";
import { serverRpcUrl } from "../../../lib/app-network";
import { allocationFromBps } from "../../../lib/hymet-policy";
import { syncGraduation } from "../../../lib/graduation";
export const runtime = "nodejs";
const fmt = (n?: number) => (n === undefined || !Number.isFinite(n) ? undefined : new Intl.NumberFormat("en-US", { maximumSignificantDigits: 4 }).format(n));
// The feed reads the chain on every build, and any visitor can request it: share one result across visitors for a few seconds.
const DIRECTORY_TTL_MS = 10_000;
let shared: { until: number; body: unknown; pending?: undefined } | { until: 0; body?: undefined; pending: Promise<NextResponse> } | undefined;
export async function GET() {
  if (process.env.NODE_ENV === "test") return directory();
  if (shared?.pending) return (await shared.pending).clone() as NextResponse;
  if (shared && shared.until > Date.now()) return NextResponse.json(shared.body, { headers: { "Cache-Control": "no-store" } });
  const pending = directory();
  shared = { until: 0, pending };
  try {
    const response = await pending;
    shared = response.ok ? { until: Date.now() + DIRECTORY_TTL_MS, body: await response.clone().json() } : undefined;
    return response;
  } catch (error) {
    shared = undefined;
    throw error;
  }
}
async function directory() {
  if (!databaseConfigured()) return NextResponse.json({ tokens: [], indexed: false, error: "Launch index is not configured" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  try {
    const result = await query<{ mint: string; name: string; ticker: string; image_url: string | null; status: string; created_at: Date; pool: string | null; protocol: string | null; creator: string; creator_bps: number; holder_bps: number }>(
      `SELECT t.mint_address AS mint, t.name, t.ticker, t.artwork_uri AS image_url, t.status, t.created_at, t.creator_wallet AS creator,
              t.creator_share_of_remaining_bps AS creator_bps, t.holder_share_of_remaining_bps AS holder_bps,
              (SELECT p.pool_address FROM pools p WHERE p.mint_address=t.mint_address AND p.status IN ('active','migrated') ORDER BY CASE WHEN p.protocol='meteora_damm_v2' THEN 0 ELSE 1 END LIMIT 1) AS pool,
              (SELECT p.protocol FROM pools p WHERE p.mint_address=t.mint_address AND p.status IN ('active','migrated') ORDER BY CASE WHEN p.protocol='meteora_damm_v2' THEN 0 ELSE 1 END LIMIT 1) AS protocol
         FROM tokens t WHERE t.quote_mint = $1 AND t.status IN ('bonding','graduating','graduated')
          AND NOT (t.mint_address = ANY($2::text[]))
        ORDER BY t.created_at DESC LIMIT 100`,
      [HYPE_MINT.toBase58(), publicTokenExcludedMints()],
    );
    const pools = result.rows.filter((r) => r.pool && r.protocol).map((r) => ({ mint: r.mint, pool: r.pool!, protocol: r.protocol! }));
    let metrics = new Map<string, { volume24hHype?: number; liquidityHype?: number; liquidityUsd?: number; priceHype?: number; marketCapUsd?: number; dbcMigrated?: boolean }>();
    try {
      const c = new Connection(serverRpcUrl(), "confirmed");
      metrics = await directoryMetrics(pools, c);
      // DBC pools the batched read shows as migrated: record the verified DAMM v2 pool and list the graduated market.
      for (const row of result.rows.filter((r) => r.protocol === "meteora_dbc" && metrics.get(r.mint)?.dbcMigrated)) {
        const synced = await syncGraduation(c, row.mint).catch(() => undefined);
        if (synced?.status === "graduated" && synced.dammPool) {
          Object.assign(row, { status: "graduated", pool: synced.dammPool, protocol: "meteora_damm_v2" });
          metrics.delete(row.mint); // DBC figures are stale after migration; DAMM v2 metrics load on the next refresh.
        }
      }
    } catch {
      /* Metrics are optional; the directory still lists confirmed launches. */
    }
    return NextResponse.json(
      {
        tokens: result.rows.map(({ created_at, image_url, pool, creator_bps, holder_bps, ...r }) => {
          const m = metrics.get(r.mint);
          return { ...r, pool, imageUrl: image_url, createdAt: created_at, allocation: allocationFromBps(creator_bps, holder_bps), volume24hHype: fmt(m?.volume24hHype), liquidityHype: fmt(m?.liquidityHype), liquidityUsd: fmt(m?.liquidityUsd), marketCapUsd: m?.marketCapUsd, priceHype: m?.priceHype };
        }),
        indexed: true,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json({ tokens: [], indexed: false, error: "Launch database unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
