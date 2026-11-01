import { NextResponse } from "next/server";
import { servedAllocationPolicy } from "../../../../lib/allocation-policy";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Read-only creator/holder allocation contract for the launch form. Server env (and, on the local test network, the on-chain distributor) decides whether holder splits are offered. */
export async function GET() {
  return NextResponse.json(await servedAllocationPolicy(), { headers: { "Cache-Control": "no-store" } });
}
