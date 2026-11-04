import { NextResponse } from "next/server";
import { databaseConfigured, query } from "../../../lib/db";
import { mainnetTransactionsEnabled, rpcProxyEnabled, testNetworkRequested } from "../../../lib/app-network";
import { holderRewardsStatus } from "../../../lib/holder-payout-status";
import { holderPayoutsLive, launchMode } from "../../../lib/launch-mode";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  let database: "not-configured" | "ok" | "unavailable" = "not-configured";
  if (databaseConfigured()) { try { await query("SELECT 1"); database = "ok"; } catch { database = "unavailable"; } }
  // Unknown is not verified: without the database the settings are reported and no payout is claimed.
  let holderRewards: Awaited<ReturnType<typeof holderRewardsStatus>> = { configured: holderPayoutsLive(), mainnetPayoutVerified: false, mainnetPayoutsIndexed: 0, lastMainnetPayoutAt: null };
  if (database === "ok") { try { holderRewards = await holderRewardsStatus(); } catch { /* reported as unverified */ } }
  const launchesEnabled = mainnetTransactionsEnabled();
  const mainnetBroadcasts = !testNetworkRequested() && launchesEnabled && rpcProxyEnabled() && process.env.HYPE_DEV_READ_ONLY !== "true";
  return NextResponse.json({ status: database === "unavailable" ? "degraded" : "ok", mode: "hymet", database, launchesEnabled, mainnetBroadcasts, launchMode: launchMode(), holderRewards }, { status: database === "unavailable" ? 503 : 200, headers: { "Cache-Control": "no-store" } });
}
