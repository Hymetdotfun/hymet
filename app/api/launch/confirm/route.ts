import { NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { databaseConfigured, databasePool } from "../../../../lib/db";
import { limitedBody, publicError, sameOrigin } from "../../../../lib/http";
import { allocationFromBps, allocationFromShare, normalizeName, normalizeTicker } from "../../../../lib/hymet-policy";
import { HYPE_MINT } from "../../../../lib/quote-assets";
import { bps, curve, distributorCurve, units, type Inputs, validate } from "../../../../lib/config";
import { distributorAddresses, verifyDistributorDeployment } from "../../../../lib/distributor-engine";
import { checkNetwork, configuredPlatformFeeRecipient, verifyLaunch } from "../../../../lib/transactions";
import { distributorAllowed } from "../../../../lib/launch-mode";
import { testNetworkRequested } from "../../../../lib/app-network";
import { serverConnection } from "../../../../lib/server-rpc";
import { isTestFileUrl } from "../../../../lib/test-network-files";
export const runtime = "nodejs";

const json = (error: string, status: number) =>
  NextResponse.json({ error }, { status, headers: { "Cache-Control": "no-store" } });

async function readVerifiedMetadata(uri: string, artworkUri: string, values: Inputs) {
  const metadataUrl = new URL(uri);
  const imageUrl = new URL(artworkUri);
  const gatewayHost = new URL(process.env.IPFS_GATEWAY || "https://gateway.pinata.cloud").host;
  if (testNetworkRequested()) {
    // Test network: metadata lives in the local test file store (lib/test-network-files.ts), not on IPFS.
    if (!isTestFileUrl(uri) || !isTestFileUrl(artworkUri))
      throw Error("Test-network metadata must come from the local test file store");
  } else if (
    metadataUrl.protocol !== "https:" ||
    imageUrl.protocol !== "https:" ||
    metadataUrl.host !== gatewayHost ||
    imageUrl.host !== gatewayHost
  )
    throw Error("Metadata and image must use the configured HTTPS IPFS gateway");
  const response = await fetch(metadataUrl, {
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(8000),
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw Error("Uploaded metadata could not be fetched");
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > 48 * 1024)
    throw Error("Metadata JSON exceeds 48 KB");
  const raw = await response.arrayBuffer();
  if (raw.byteLength > 48 * 1024) throw Error("Metadata JSON exceeds 48 KB");
  const metadata = JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>;
  if (
    metadata.name !== values.name ||
    metadata.symbol !== values.symbol ||
    metadata.description !== values.description ||
    metadata.image !== artworkUri ||
    (metadata.external_url || "") !== values.website
  )
    throw Error("Uploaded metadata does not match the reserved launch details");
  const extensions = (metadata.extensions || {}) as Record<string, unknown>;
  for (const [key, value] of Object.entries({
    website: values.website,
    twitter: values.twitter,
    telegram: values.telegram,
    social: values.social,
  }))
    if ((extensions[key] || "") !== value)
      throw Error(`Uploaded ${key} metadata does not match the reviewed launch`);
  return metadata;
}

export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) return json("Origin denied", 403);
  if (req.headers.get("content-type")?.split(";")[0] !== "application/json")
    return json("JSON request required", 415);
  if (Number(req.headers.get("content-length")) > 32_768)
    return json("Request exceeds size limit", 413);
  if (!databaseConfigured()) return json("PostgreSQL is not configured", 503);

  let client;
  try {
    const raw = await limitedBody(req, 32_768);
    const body = JSON.parse(new TextDecoder().decode(raw));
    if (
      typeof body.reservationId !== "string" ||
      !/^[0-9a-f-]{36}$/i.test(body.reservationId) ||
      body.network !== "mainnet-beta" ||
      typeof body.creator !== "string" ||
      typeof body.mint !== "string" ||
      typeof body.config !== "string" ||
      typeof body.pool !== "string" ||
      typeof body.uri !== "string" ||
      typeof body.artworkUri !== "string" ||
      !Array.isArray(body.signatures) ||
      body.signatures.length < 1 ||
      body.signatures.length > 2 ||
      body.signatures.some((s: unknown) => typeof s !== "string" || s.length < 80 || s.length > 100)
    )
      throw Error("Invalid launch confirmation request");

    const values = body.values as Inputs;
    validate(values);
    const distributorProgramId = typeof body.distributorProgramId === 'string' ? body.distributorProgramId : undefined;
    // Persist exactly what was signed; never coerce a holder split to 100% creator.
    const allocation = allocationFromShare(values.creatorShare);
    if (values.quote !== "hype" || (allocation.holderBpsOfRemaining !== 0 && !distributorProgramId))
      throw Error("HYMET holder allocations require the verified distributor route");
    if (distributorProgramId && (!distributorAllowed() || process.env.HYMET_DISTRIBUTOR_VERIFIED !== 'true' || process.env.HYMET_DISTRIBUTOR_APP_VERIFIED !== 'true' || distributorProgramId !== process.env.HYMET_DISTRIBUTOR_PROGRAM_ID)) throw Error('Distributor deployment and application flow are not owner-verified');
    const creator = new PublicKey(body.creator);
    const mint = new PublicKey(body.mint);
    const config = new PublicKey(body.config);
    const pool = new PublicKey(body.pool);
    const platform = configuredPlatformFeeRecipient();
    if (creator.equals(platform)) throw Error("Creator and HYMET fee recipient must be distinct");
    const name = values.name.trim().normalize("NFKC").replace(/\s+/gu, " ");
    const ticker = values.symbol.normalize("NFKC").trim().toUpperCase();
    const nameKey = normalizeName(name);
    const tickerKey = normalizeTicker(ticker);
    const sql = await databasePool();
    const existing = await sql.query(
      "SELECT launch_signature,creator_share_of_remaining_bps,holder_share_of_remaining_bps FROM tokens WHERE reservation_id=$1",
      [body.reservationId],
    );
    if (existing.rowCount) {
      if (existing.rows[0].launch_signature === body.signatures.at(-1))
        return NextResponse.json(
          { registered: true, idempotent: true, allocation: allocationFromBps(existing.rows[0].creator_share_of_remaining_bps, existing.rows[0].holder_share_of_remaining_bps) },
          { headers: { "Cache-Control": "no-store" } },
        );
      return json("Reservation is already bound to another confirmed token", 409);
    }
    const reservation = await sql.query(
      "SELECT creator_wallet,name_key,ticker_key,status FROM launch_reservations WHERE id=$1",
      [body.reservationId],
    );
    if (
      reservation.rowCount !== 1 ||
      reservation.rows[0].creator_wallet !== creator.toBase58() ||
      reservation.rows[0].name_key !== nameKey ||
      reservation.rows[0].ticker_key !== tickerKey ||
      !["reserved", "submitted", "expired"].includes(reservation.rows[0].status)
    )
      return json("No matching active HYMET reservation exists", 409);

    const connection = serverConnection();
    await checkNetwork(connection, "mainnet-beta");
    if (distributorProgramId) await verifyDistributorDeployment(connection, new PublicKey(distributorProgramId), platform);
    await readVerifiedMetadata(body.uri, body.artworkUri, values);
    const verified = await verifyLaunch(connection, {
        values,
        distributorProgramId,
        network: "mainnet-beta",
        creator,
        mint: { publicKey: mint },
        config,
        pool,
        buy: units(values.buy, 9),
        configParams: distributorProgramId ? distributorCurve(values, creator) : curve(values, creator),
        recipients: { partner: distributorProgramId ? distributorAddresses(new PublicKey(distributorProgramId), mint).feePool.toBase58() : platform.toBase58(), leftover: creator.toBase58() },
        uri: body.uri,
        steps: body.signatures.map((signature: string) => ({ signature })),
      });
    const signatures = await connection.getSignatureStatuses([body.signatures.at(-1)], { searchTransactionHistory: true });
    const status = signatures.value[0];
    if (!status || status.err || !["confirmed", "finalized"].includes(status.confirmationStatus || ""))
      throw Error("Final launch signature is not confirmed");
    const signature = body.signatures.at(-1) as string;
    const socialLinks = {
      website: values.website,
      twitter: values.twitter,
      telegram: values.telegram,
      additional: values.social,
    };
    client = await sql.connect();
    await client.query("BEGIN");
    const locked = await client.query(
      "SELECT creator_wallet,name_key,ticker_key,status FROM launch_reservations WHERE id=$1 FOR UPDATE",
      [body.reservationId],
    );
    if (
      locked.rowCount !== 1 ||
      locked.rows[0].creator_wallet !== creator.toBase58() ||
      locked.rows[0].name_key !== nameKey ||
      locked.rows[0].ticker_key !== tickerKey
    )
      throw Error("HYMET reservation changed during verification");
    await client.query(
      `INSERT INTO tokens(mint_address,reservation_id,creator_wallet,name,ticker,name_key,ticker_key,description,metadata_uri,artwork_uri,quote_mint,decimals,supply,trading_fee_bps,creator_share_of_remaining_bps,holder_share_of_remaining_bps,status,launch_signature,confirmed_slot,social_links,additional_social_url,website_url,x_url,telegram_url)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,9,1000000000000000000,$12,$21,$22,$13,$14,$15,$16::jsonb,$17,$18,$19,$20)`,
      [mint.toBase58(), body.reservationId, creator.toBase58(), values.name, values.symbol, nameKey, tickerKey, values.description, body.uri, body.artworkUri, HYPE_MINT.toBase58(), bps(values.fee), verified.status === "Migrated" ? "graduated" : "bonding", signature, status.slot, JSON.stringify(socialLinks), values.social || null, values.website || null, values.twitter || null, values.telegram || null, allocation.creatorBpsOfRemaining, allocation.holderBpsOfRemaining],
    );
    if (distributorProgramId) await client.query('UPDATE tokens SET distributor_program_id=$2, distributor_fee_pool=$3 WHERE mint_address=$1', [mint.toBase58(), distributorProgramId, distributorAddresses(new PublicKey(distributorProgramId), mint).feePool.toBase58()]);
    await client.query(
      "INSERT INTO pools(pool_address,mint_address,protocol,quote_mint,status) VALUES($1,$2,'meteora_dbc',$3,$4)",
      [pool.toBase58(), mint.toBase58(), HYPE_MINT.toBase58(), verified.status === "Migrated" ? "migrated" : "active"],
    );
    await client.query(
      "UPDATE launch_reservations SET status='confirmed',transaction_signature=$2,updated_at=now(),failure_reason=NULL WHERE id=$1",
      [body.reservationId, signature],
    );
    await client.query("COMMIT");
    return NextResponse.json({ registered: true, status: verified.status, allocation }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    const code = (error as { code?: string })?.code;
    if (code === "23505") return json("This mint or launch signature is already registered", 409);
    return json(error instanceof Error ? publicError(error.message) : "Confirmed launch registration failed", 503);
  } finally {
    client?.release();
  }
}
