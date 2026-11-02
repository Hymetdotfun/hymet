import { NextResponse } from "next/server";
import { Connection, PublicKey } from "@solana/web3.js";
import { serverRpcUrl } from "../../../../lib/app-network";
import { databaseConfigured } from "../../../../lib/db";
import { ensureGraduation } from "../../../../lib/graduation-request";
import { sameOrigin } from "../../../../lib/http";
export const runtime = "nodejs";

const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
// Per-mint coalescing: concurrent or rapid polls share one chain read (public RPCs rate-limit per method).
const inflight = new Map<string, { until: number; result: Promise<unknown> }>();

// Called by the token page after a confirmed buy and while it shows "Migrating to DAMM v2". Reads the chain, records a
// verified graduation, and queues the keeper when the curve is complete. Signs nothing and moves no funds.
export async function POST(request: Request, { params }: { params: Promise<{ mint: string }> }) {
  if (!sameOrigin(request)) return json({ error: "Origin denied" }, 403);
  const { mint } = await params;
  try {
    new PublicKey(mint);
  } catch {
    return json({ error: "Invalid mint address" }, 400);
  }
  if (!databaseConfigured()) return json({ error: "Launch index unavailable" }, 503);
  const cached = inflight.get(mint);
  if (cached && cached.until > Date.now()) return json(await cached.result.catch(() => ({ status: "unknown" })));
  const result = ensureGraduation(new Connection(serverRpcUrl(), "confirmed"), mint);
  inflight.set(mint, { until: Date.now() + 3_000, result });
  try {
    return json(await result);
  } catch (e) {
    const limited = e instanceof Error && /\b429\b|Too Many Requests/.test(e.message);
    return json({ status: "unknown", error: limited ? "RPC rate limited; retrying" : "Graduation status unavailable" }, limited ? 429 : 503);
  }
}
