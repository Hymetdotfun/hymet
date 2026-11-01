import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { isTimeframe, poolCandles, verifiedPool } from "../../../../../lib/market-data";
export const runtime = "nodejs";
const noStore = { "Cache-Control": "no-store" };
export async function GET(req: Request, { params }: { params: Promise<{ mint: string }> }) {
  const { mint } = await params;
  try {
    new PublicKey(mint);
  } catch {
    return NextResponse.json({ error: "Invalid mint address" }, { status: 400 });
  }
  const tf = new URL(req.url).searchParams.get("tf") || "5m";
  if (!isTimeframe(tf)) return NextResponse.json({ error: "Unsupported timeframe" }, { status: 400 });
  try {
    const verified = await verifiedPool(mint);
    if (!verified) return NextResponse.json({ candles: [], source: null, error: "No indexed pool for this token" }, { status: 404, headers: noStore });
    const { candles, stale } = await poolCandles(verified.pool_address, tf);
    // Prices are HYPE per token and volume is HYPE, as reported by GeckoTerminal; an empty list means not indexed yet.
    return NextResponse.json({ candles, timeframe: tf, unit: "HYPE", source: "GeckoTerminal", pool: verified.pool_address, stale }, { headers: { "Cache-Control": "public, max-age=15" } });
  } catch {
    return NextResponse.json({ candles: [], source: null, error: "Chart data is temporarily unavailable" }, { status: 503, headers: noStore });
  }
}
