import { NextResponse } from "next/server";
import { databaseConfigured, query } from "../../../lib/db";
export const runtime = "nodejs";
export async function GET() {
  let database: "not-configured" | "ok" | "unavailable" = "not-configured";
  if (databaseConfigured()) { try { await query("SELECT 1"); database = "ok"; } catch { database = "unavailable"; } }
  return NextResponse.json({ status: database === "unavailable" ? "degraded" : "ok", mode: "hymet", database, launchesEnabled: false, mainnetBroadcasts: false }, { status: database === "unavailable" ? 503 : 200, headers: { "Cache-Control": "no-store" } });
}
