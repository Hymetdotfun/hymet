import { NextRequest, NextResponse } from "next/server";
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import { getMint, TOKEN_PROGRAM_ID, unpackMint } from "@solana/spl-token";
import { databaseConfigured, query } from "../../../lib/db";
import { HYPE_MINT } from "../../../lib/quote-assets";
import { configuredPlatformFeeRecipient } from "../../../lib/transactions";
import { expectedGenesis, serverRpcUrl } from "../../../lib/app-network";
import { FEE_CLAIMER_MISMATCH, readPlatformFees, preparePlatformClaim } from "../../../lib/platform-fees";
import { acceptedPlatformFeeRecipients, platformFeeGeneration } from "../../../lib/platform-wallets";
import { verifyPlatformFeeAuthorization } from "../../../lib/platform-fee-auth-server";
import type { PlatformFeeAuthorization } from "../../../lib/platform-fee-auth";
import { readCreatorFees } from "../../../lib/creator-fees";
import { prepareDammClaim, readDammPositions } from "../../../lib/damm-fees";
import { limitedBody, publicError, sameOrigin } from "../../../lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RequestBody = PlatformFeeAuthorization & { signature: string };
type LaunchPool = {
  pool_address: string;
  mint_address: string;
  ticker: string;
  name: string;
  decimals: number;
};

// Same-origin check is the shared loopback-only helper used by every financial route: Origin must equal the
// request's Host header (not request.url, which Next.js rewrites 127.0.0.1 -> localhost) and the request must be
// local HTTP. The signed authorization message additionally binds this exact Origin.
function parseBody(body: unknown): RequestBody {
  if (!body || typeof body !== "object") throw Error("Invalid fee request");
  const value = body as Record<string, unknown>;
  if (
    typeof value.wallet !== "string" ||
    typeof value.action !== "string" ||
    typeof value.issuedAt !== "string" ||
    typeof value.nonce !== "string" ||
    typeof value.signature !== "string" ||
    (value.pool !== undefined && typeof value.pool !== "string") ||
    (value.position !== undefined && typeof value.position !== "string")
  )
    throw Error("Invalid platform fee request");
  return value as RequestBody;
}

function units(value: bigint, decimals: number) {
  const base = 10n ** BigInt(decimals);
  return `${value / base}.${(value % base).toString().padStart(decimals, "0")}`;
}

function mainnetConnection() {
  return new Connection(
    serverRpcUrl(),
    "confirmed",
  );
}

async function launchPools(): Promise<LaunchPool[]> {
  const result = await query<LaunchPool>(
    `SELECT p.pool_address,t.mint_address,t.ticker,t.name,t.decimals
       FROM pools p JOIN tokens t USING(mint_address)
      WHERE p.protocol='meteora_dbc' AND t.quote_mint=$1
        AND t.distributor_program_id IS NULL
      ORDER BY t.created_at DESC LIMIT 20`,
    [HYPE_MINT.toBase58()],
  );
  return result.rows;
}

// The route works per launch, not from the global launch mode: only launches with no distributor are listed or prepared
// here, and readPlatformFees checks each one's on-chain native-split config. Distributor launches pay HYMET on settlement.
// Each platform wallet sees only the launches whose immutable DBC feeClaimer it is: the legacy wallet keeps
// the launches made before the change, the current wallet every launch made after it.
async function inspect(connection: Connection, wallet: PublicKey, platform: PublicKey) {
  const pools = await launchPools();
  const generation = platformFeeGeneration(wallet, platform);
  const rows = await Promise.all(
    pools.map(async (entry) => {
      try {
        const dbc = await readPlatformFees(
          connection,
          "mainnet-beta",
          entry.pool_address,
          wallet,
        );
        if (dbc.mint !== entry.mint_address || dbc.quoteMint !== HYPE_MINT.toBase58())
          throw Error("Launch index mint or HYPE quote does not match verified DBC state");
        const mintInfo = await connection.getAccountInfo(
          new PublicKey(dbc.mint),
          "confirmed",
        );
        if (!mintInfo) throw Error("Token mint account is missing");
        if (!mintInfo.owner.equals(TOKEN_PROGRAM_ID))
          throw Error("This token program is not supported by the existing platform claim builder");
        const baseDecimals = unpackMint(
          new PublicKey(dbc.mint),
          mintInfo,
          mintInfo.owner,
        ).decimals;
        const migration = await readCreatorFees(
          connection,
          "mainnet-beta",
          entry.pool_address,
        );
        const records: Array<Record<string, unknown>> = [
          {
            key: `dbc:${entry.pool_address}`,
            kind: "dbc",
            protocol: "Meteora DBC",
            pool: entry.pool_address,
            mint: dbc.mint,
            ticker: entry.ticker,
            name: entry.name,
            verified: true,
            generation,
            feeClaimer: dbc.feeClaimer,
            base: units(dbc.base, baseDecimals),
            baseMint: dbc.mint,
            baseDecimals,
            hype: units(dbc.quote, 9),
            claimable: dbc.base > 0n || dbc.quote > 0n,
            migrated: migration.migration.venue === "DAMM V2",
            position: null,
          },
        ];
        if (migration.migration.venue === "DAMM V2") {
          const damm = await readDammPositions(
            connection,
            "mainnet-beta",
            entry.pool_address,
            wallet,
          );
          if (!damm.supported)
            throw Error("DAMM v2 pool uses an unsupported fee or token program");
          for (const position of damm.positions) {
            if (position.locked === "0") continue;
            records.push({
              key: `damm:${position.position}`,
              kind: "damm",
              protocol: "Meteora DAMM v2 · locked platform position",
              pool: entry.pool_address,
              mint: dbc.mint,
              ticker: entry.ticker,
              name: entry.name,
              verified: true,
              generation,
              feeClaimer: dbc.feeClaimer,
              base: units(position.a, damm.decimals[0]),
              baseMint: dbc.mint,
              baseDecimals: damm.decimals[0],
              hype: units(position.b, damm.decimals[1]),
              claimable: position.a > 0n || position.b > 0n,
              migrated: true,
              position: position.position,
              lockedLiquidity: position.locked,
            });
          }
        }
        return records;
      } catch (error) {
        // Launch belongs to the other platform wallet generation; not this wallet's to show or claim.
        if (error instanceof Error && error.message === FEE_CLAIMER_MISMATCH) return [];
        return [
          {
            key: `unverified:${entry.pool_address}`,
            kind: "dbc",
            protocol: "Meteora DBC / DAMM v2",
            pool: entry.pool_address,
            mint: entry.mint_address,
            ticker: entry.ticker,
            name: entry.name,
            verified: false,
            error:
              error instanceof Error
                ? error.message
                : "On-chain fee verification failed",
            base: null,
            hype: null,
            claimable: false,
            migrated: null,
            position: null,
          },
        ];
      }
    }),
  );
  return rows.flat();
}

export async function POST(request: NextRequest) {
  if (!sameOrigin(request))
    return NextResponse.json({ error: "Same-origin request required" }, { status: 403 });
  if (request.headers.get("content-type")?.split(";")[0] !== "application/json")
    return NextResponse.json({ error: "JSON request required" }, { status: 415 });
  try {
    const raw = await limitedBody(request, 8192);
    const body = parseBody(JSON.parse(new TextDecoder().decode(raw)));
    const origin = request.headers.get("origin")!;
    const platform = configuredPlatformFeeRecipient();
    const wallet = verifyPlatformFeeAuthorization(body, origin, acceptedPlatformFeeRecipients(platform));
    if (!databaseConfigured())
      return NextResponse.json(
        { error: "PostgreSQL is not configured; confirmed HYMET launches cannot be enumerated" },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    const connection = mainnetConnection();
    if ((await connection.getGenesisHash()) !== expectedGenesis())
      throw Error("Configured fee RPC is not Solana Mainnet Beta");
    if (body.action === "inspect") {
      const rows = await inspect(connection, wallet, platform);
      return NextResponse.json(
        { rows, generation: platformFeeGeneration(wallet, platform), source: "confirmed HYMET launches + verified Mainnet accounts" },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    if (!body.pool) throw Error("DBC pool is required");
    const known = await query<{ pool_address: string }>(
      `SELECT p.pool_address FROM pools p JOIN tokens t USING(mint_address)
        WHERE p.pool_address=$1 AND p.protocol='meteora_dbc'
          AND t.quote_mint=$2 AND t.distributor_program_id IS NULL LIMIT 1`,
      [new PublicKey(body.pool).toBase58(), HYPE_MINT.toBase58()],
    );
    if (!known.rows.length) throw Error("Pool is not a confirmed HYMET native-split HYPE launch");
    let tx: Transaction;
    let lastValidBlockHeight: number;
    let summary: Record<string, unknown>;
    if (body.action === "prepare-dbc") {
      const plan = await preparePlatformClaim(connection, "mainnet-beta", body.pool, wallet);
      tx = plan.tx;
      lastValidBlockHeight = plan.lastValidBlockHeight;
      summary = {
        protocol: "Meteora DBC",
        base: units(plan.view.base, (await getMint(connection, new PublicKey(plan.view.mint), "confirmed")).decimals),
        hype: units(plan.view.quote, 9),
        feeLamports: plan.fee.toString(),
        rentLamports: plan.rent.toString(),
      };
    } else if (body.action === "prepare-damm") {
      if (!body.position) throw Error("DAMM v2 position is required");
      const verified = await readPlatformFees(connection, "mainnet-beta", body.pool, wallet);
      const plan = await prepareDammClaim(
        connection,
        "mainnet-beta",
        body.pool,
        new PublicKey(body.position).toBase58(),
        wallet,
      );
      if (BigInt(plan.position.locked) === 0n)
        throw Error("Only the migrated permanently locked platform position is claimable here");
      if (!plan.view.pool.tokenBMint.equals(HYPE_MINT) || verified.quoteMint !== HYPE_MINT.toBase58())
        throw Error("DAMM quote mint is not the verified HYPE mint");
      tx = plan.claim.tx;
      lastValidBlockHeight = plan.claim.lastValidBlockHeight;
      summary = {
        protocol: "Meteora DAMM v2",
        base: units(plan.position.a, plan.view.decimals[0]),
        hype: units(plan.position.b, plan.view.decimals[1]),
        feeLamports: plan.claim.fee.toString(),
        rentLamports: plan.claim.rent.toString(),
      };
    } else {
      throw Error("Unsupported platform fee action");
    }
    const serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
    return NextResponse.json(
      {
        transaction: serialized.toString("base64"),
        lastValidBlockHeight,
        summary,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error ? publicError(error.message) : "Platform fee request failed";
    const status = /Unauthorized|signature|authorization|Same-origin/.test(message)
      ? 403
      : /PostgreSQL|RPC|network|unavailable/i.test(message)
        ? 503
        : 400;
    return NextResponse.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
  }
}
