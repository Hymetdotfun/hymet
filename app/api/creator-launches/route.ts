import { NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { databaseConfigured, query } from "../../../lib/db";
import { HYPE_MINT } from "../../../lib/quote-assets";
import { allocationFromBps } from "../../../lib/hymet-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Wallet-scoped launch lookup for creator fee claims: the DBC launch pool, plus the verified DAMM v2 pool once graduated. */
export async function GET(request: NextRequest) {
  if (!databaseConfigured()) {
    return NextResponse.json(
      { launches: [], error: "Launch index is not configured" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  let creator: string;
  try {
    const wallet = request.nextUrl.searchParams.get("wallet");
    if (!wallet) throw new Error("Missing wallet");
    creator = new PublicKey(wallet).toBase58();
  } catch {
    return NextResponse.json(
      { launches: [], error: "A valid creator wallet is required" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const result = await query<{
      mint: string;
      name: string;
      ticker: string;
      image_url: string | null;
      creator: string;
      pool: string;
      creator_bps: number;
      holder_bps: number;
      damm_pool: string | null;
      distributor: boolean;
    }>(
      `SELECT t.mint_address AS mint,t.name,t.ticker,t.artwork_uri AS image_url,t.creator_wallet AS creator,
              p.pool_address AS pool,t.creator_share_of_remaining_bps AS creator_bps,t.holder_share_of_remaining_bps AS holder_bps,
              (SELECT d.pool_address FROM pools d WHERE d.mint_address=t.mint_address AND d.protocol='meteora_damm_v2' AND d.status='active') AS damm_pool,
              t.distributor_program_id IS NOT NULL AS distributor
         FROM tokens t JOIN pools p USING(mint_address)
        WHERE t.creator_wallet=$1 AND t.quote_mint=$2
          AND t.status IN ('bonding','graduating','graduated')
          AND p.protocol='meteora_dbc' AND p.status IN ('active','migrated')
        ORDER BY t.created_at DESC LIMIT 50`,
      [creator, HYPE_MINT.toBase58()],
    );
    return NextResponse.json(
      // `pool` stays the DBC launch pool (the root of every creator claim); `protocol` is the current trading venue.
      { launches: result.rows.map(({ creator_bps, holder_bps, image_url, damm_pool, ...row }) => ({ ...row, imageUrl: image_url, protocol: damm_pool ? "meteora_damm_v2" : "meteora_dbc", dammPool: damm_pool ?? undefined, allocation: allocationFromBps(creator_bps, holder_bps) })) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json(
      { launches: [], error: "Launch index unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
