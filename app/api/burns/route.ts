import { NextResponse } from "next/server";
import { databaseConfigured } from "../../../lib/db";
import { burnReport, syncBurnsInBackground } from "../../../lib/burn-server";
import { BURN_TRACKED_DECIMALS, BURN_TRACKED_MINT, BURN_TRACKED_SYMBOL, ORIGINAL_SUPPLY_RAW } from "../../../lib/burn-tracker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const unavailable = { status: "unavailable", mint: BURN_TRACKED_MINT, symbol: BURN_TRACKED_SYMBOL, decimals: BURN_TRACKED_DECIMALS, originalSupplyRaw: ORIGINAL_SUPPLY_RAW.toString() };

/** The verified $HYMET burn state. Each request may start a background sync; it waits a few seconds for it at most. */
export async function GET() {
  if (!databaseConfigured()) return NextResponse.json(unavailable, { status: 503, headers: { "Cache-Control": "no-store" } });
  try {
    await Promise.race([syncBurnsInBackground(), new Promise((resolve) => setTimeout(resolve, 6_000))]);
    return NextResponse.json(await burnReport(), { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json(unavailable, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
