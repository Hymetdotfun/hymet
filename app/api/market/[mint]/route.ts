import { NextResponse } from "next/server";
import { Connection, PublicKey } from "@solana/web3.js";
import { query } from "../../../../lib/db";
import { marketSnapshot, type Market } from "../../../../lib/market-data";
import { serverRpcUrl } from "../../../../lib/app-network";
import { syncGraduation } from "../../../../lib/graduation";
export const runtime = "nodejs";
const cache = new Map<string, { until: number; value: Market }>();
function response(value: unknown, status = 200) {
  return NextResponse.json(value, { status, headers: { "Cache-Control": status === 200 ? "public, max-age=15" : "no-store" } });
}
export async function GET(_req: Request, { params }: { params: Promise<{ mint: string }> }) {
  const { mint } = await params;
  try {
    new PublicKey(mint);
  } catch {
    return response({ error: "Invalid mint address" }, 400);
  }
  const cached = cache.get(mint);
  if (cached && cached.until > Date.now()) return response(cached.value);
  try {
    const c = new Connection(serverRpcUrl(), "confirmed");
    // Record a verified DBC -> DAMM v2 graduation before choosing the pool; a failed check keeps the indexed pool.
    await syncGraduation(c, mint).catch(() => undefined);
    const result = await marketSnapshot(mint, c);
    cache.set(mint, { until: Date.now() + 15_000, value: result });
    if (!result.indexing)
      void query(
        `INSERT INTO market_snapshots(mint_address,source,price_hype,volume_24h_hype,price_change_24h,liquidity_usd,observed_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,now(),now()+interval '20 seconds') ON CONFLICT(mint_address) DO UPDATE SET source=EXCLUDED.source,price_hype=EXCLUDED.price_hype,volume_24h_hype=EXCLUDED.volume_24h_hype,price_change_24h=EXCLUDED.price_change_24h,liquidity_usd=EXCLUDED.liquidity_usd,observed_at=now(),expires_at=now()+interval '20 seconds'`,
        [mint, result.source ?? "on-chain", result.priceHype ?? null, result.volume24hHype ?? null, result.change24h ?? null, result.liquidityUsd ?? null],
      ).catch(() => {});
    return response(result);
  } catch (e) {
    const status = (e as { status?: number }).status;
    return response({ error: status === 404 ? "Mint is not a verified HYMET launch" : "Market data is temporarily unavailable" }, status === 404 ? 404 : 503);
  }
}
