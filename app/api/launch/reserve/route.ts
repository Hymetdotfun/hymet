import { NextRequest, NextResponse } from "next/server";
import { createPublicKey, randomUUID, verify } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { databasePool } from "../../../../lib/db";
import { normalizeName, normalizeTicker } from "../../../../lib/hymet-policy";
import { authorizedName, authorizedTicker, launchAuthorizationFresh, launchAuthorizationMessage } from "../../../../lib/launch-authorization";
import { limitedBody, sameOrigin } from "../../../../lib/http";
import { mainnetTransactionsEnabled } from "../../../../lib/app-network";
export const runtime = "nodejs";
/** Open launch records one wallet may hold; each expires after 15 minutes. Names are not reserved. */
const MAX_OPEN_LAUNCHES_PER_WALLET = 3;
export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) return NextResponse.json({ error: "Origin denied" }, { status: 403 });
  // No launch record can lead to a launch while launches are disabled.
  if (!mainnetTransactionsEnabled()) return NextResponse.json({ error: "Launches are not open yet" }, { status: 403 });
  let client;
  try {
    if (req.headers.get("content-type")?.split(";")[0] !== "application/json") return NextResponse.json({error:"JSON request required"},{status:415});
    if(Number(req.headers.get("content-length"))>8192)throw new Error("Request exceeds size limit");
    const raw=await limitedBody(req,8192);const body = JSON.parse(new TextDecoder().decode(raw));
    if (typeof body.name !== "string" || typeof body.ticker !== "string" || typeof body.wallet !== "string" || typeof body.issuedAt !== "string" || typeof body.nonce !== "string" || typeof body.signature !== "string") throw new Error("Invalid reservation request");
    const name = authorizedName(body.name);
    const ticker = authorizedTicker(body.ticker);
    const nameKey = normalizeName(name), tickerKey = normalizeTicker(ticker);
    const wallet = new PublicKey(body.wallet);
    if (!launchAuthorizationFresh(body.issuedAt, body.nonce)) throw new Error("Launch authorization expired");
    const message = launchAuthorizationMessage({ origin: String(req.headers.get("origin")), wallet: wallet.toBase58(), name, ticker, nonce: body.nonce, issuedAt: body.issuedAt });
    const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), wallet.toBuffer()]), format: "der", type: "spki" });
    const signature = Buffer.from(body.signature, "base64");
    if (signature.length !== 64 || !verify(null, Buffer.from(message), key, signature)) return NextResponse.json({ error: "Invalid wallet signature" }, { status: 403 });
    const pool = await databasePool(); client = await pool.connect(); await client.query("BEGIN");
    await client.query(`UPDATE launch_reservations SET status='expired', updated_at=now() WHERE status='reserved' AND expires_at <= now()`);
    await client.query(`INSERT INTO creators(wallet_address) VALUES($1) ON CONFLICT(wallet_address) DO UPDATE SET last_seen_at=now()`, [wallet.toBase58()]);
    const open = await client.query(`SELECT count(*)::int AS active FROM launch_reservations WHERE creator_wallet=$1 AND status='reserved' AND expires_at>now()`, [wallet.toBase58()]);
    if (Number(open.rows[0]?.active ?? 0) >= MAX_OPEN_LAUNCHES_PER_WALLET) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "Too many open launch requests for this wallet. Finish one or wait up to 15 minutes" }, { status: 429, headers: { "Cache-Control": "no-store" } });
    }
    const id = randomUUID();
    await client.query(`INSERT INTO launch_reservations(id, creator_wallet, name, ticker, name_key, ticker_key, status, idempotency_key, expires_at, authorization_signature) VALUES($1,$2,$3,$4,$5,$6,'reserved',$7,now()+interval '15 minutes',$8)`, [id, wallet.toBase58(), name, ticker, nameKey, tickerKey, body.nonce, body.signature]);
    await client.query("COMMIT");
    return NextResponse.json({ reservationId: id, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(), name, ticker }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    const code = (e as { code?: string })?.code;
    if (code === "23505") return NextResponse.json({ error: "This launch request was already submitted" }, { status: 409 });
    const message = e instanceof Error ? e.message : "Reservation failed";
    const badInput = /Invalid|must|Ticker|Token name|expired/.test(message);
    return NextResponse.json({ error: message }, { status: badInput ? 400 : 503, headers: { "Cache-Control": "no-store" } });
  } finally { client?.release(); }
}
