// HYMET operator recovery: register a launch that is confirmed on-chain but missing from the registry (the creator's
// browser lost the confirmation, e.g. an RPC 429 during /api/launch/confirm). Holds no key and signs nothing.
//   node node_modules/jiti/lib/jiti-cli.mjs scripts/register-confirmed-launch.ts <reservation-id> <config-sig> <pool-sig> [--send]
// Env: DATABASE_URL, HYMET_DISTRIBUTOR_PROGRAM_ID, HYMET_KEEPER_RPC_URL (or MAINNET_RPC_URL), HYMET_APP_URL (the app's
// own origin, e.g. http://127.0.0.1:3918).
//
// The payload is rebuilt only from chain state and the token's own metadata JSON, then submitted to the unchanged
// /api/launch/confirm, which re-verifies the network, distributor, metadata, curve config, split, pool and signatures
// before writing anything. Without --send it prints the reconstructed payload and stops.
import pg from "pg";
import { Connection, PublicKey } from "@solana/web3.js";
import { defaults, type Inputs } from "../lib/config";

const METADATA_PROGRAM = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

// Metaplex Metadata: key, update authority, mint, then borsh strings name, symbol, uri.
function metadataUri(data: Buffer) {
  let offset = 1 + 32 + 32;
  const text = () => {
    const length = data.readUInt32LE(offset);
    const value = data.subarray(offset + 4, offset + 4 + length).toString("utf8").replace(/\0+$/, "");
    offset += 4 + length;
    return value;
  };
  text();
  text();
  return text();
}
const otherSigner = (keys: { pubkey: PublicKey; signer: boolean }[], creator: string) => {
  const signers = keys.filter((k) => k.signer && k.pubkey.toBase58() !== creator);
  if (signers.length !== 1) throw Error("Expected exactly one non-creator signer");
  return signers[0].pubkey;
};

async function main() {
  const [reservationId, configSignature, poolSignature] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const send = process.argv.includes("--send");
  const app = process.env.HYMET_APP_URL, programText = process.env.HYMET_DISTRIBUTOR_PROGRAM_ID;
  if (!reservationId || !configSignature || !poolSignature || !app || !programText || !process.env.DATABASE_URL)
    throw Error("Usage: register-confirmed-launch.ts <reservation-id> <config-sig> <pool-sig> [--send]; set DATABASE_URL, HYMET_DISTRIBUTOR_PROGRAM_ID, HYMET_APP_URL");
  const connection = new Connection(process.env.HYMET_KEEPER_RPC_URL || process.env.MAINNET_RPC_URL || "https://api.mainnet-beta.solana.com", "confirmed");
  const program = new PublicKey(programText);

  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const reservation = (await db.query("SELECT creator_wallet,status FROM launch_reservations WHERE id=$1", [reservationId])).rows[0];
  await db.end();
  if (!reservation) throw Error("Reservation not found");
  if (reservation.status === "confirmed") throw Error("Reservation is already confirmed");
  const creator: string = reservation.creator_wallet;

  const read = async (signature: string) => {
    const tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    if (!tx || tx.meta?.err) throw Error(`Launch transaction ${signature} is missing or failed`);
    if (!tx.transaction.message.accountKeys.some((k) => k.signer && k.pubkey.toBase58() === creator))
      throw Error(`Launch transaction ${signature} was not signed by the reserved creator`);
    return tx;
  };
  const config = otherSigner((await read(configSignature)).transaction.message.accountKeys, creator);
  const poolTx = await read(poolSignature);
  const mint = otherSigner(poolTx.transaction.message.accountKeys, creator);

  const feePool = PublicKey.findProgramAddressSync([Buffer.from("fee-pool"), mint.toBuffer()], program)[0];
  const feePoolAccount = await connection.getAccountInfo(feePool, "confirmed");
  if (!feePoolAccount?.owner.equals(program)) throw Error("Distributor fee pool not found for this mint");
  // FeePool: 8-byte discriminator, creator, token_mint, dbc_pool, damm_pool, creator_bps_of_remaining (u16).
  const pool = new PublicKey(feePoolAccount.data.subarray(72, 104));
  const creatorBps = feePoolAccount.data.readUInt16LE(136);
  if (creatorBps % 100) throw Error("Creator split is not a whole percentage");

  const metadataAccount = PublicKey.findProgramAddressSync([Buffer.from("metadata"), METADATA_PROGRAM.toBuffer(), mint.toBuffer()], METADATA_PROGRAM)[0];
  const metadataInfo = await connection.getAccountInfo(metadataAccount, "confirmed");
  if (!metadataInfo) throw Error("Token metadata account not found");
  const uri = metadataUri(metadataInfo.data);
  const response = await fetch(uri, { signal: AbortSignal.timeout(8000), redirect: "error" });
  if (!response.ok) throw Error("Token metadata JSON could not be fetched");
  const metadata = (await response.json()) as Record<string, unknown>;
  const extensions = (metadata.extensions || {}) as Record<string, string | undefined>;
  // Curve, fee and supply fields keep the launch defaults; the confirm route rejects any mismatch with the on-chain config.
  const values: Inputs = {
    ...defaults,
    name: String(metadata.name),
    symbol: String(metadata.symbol),
    description: String(metadata.description ?? ""),
    website: String(metadata.external_url ?? ""),
    twitter: extensions.twitter ?? "",
    telegram: extensions.telegram ?? "",
    social: extensions.social ?? "",
    creatorShare: String(creatorBps / 100),
  };
  const payload = {
    reservationId,
    distributorProgramId: program.toBase58(),
    network: "mainnet-beta",
    creator,
    mint: mint.toBase58(),
    config: config.toBase58(),
    pool: pool.toBase58(),
    values,
    uri,
    artworkUri: String(metadata.image),
    signatures: [configSignature, poolSignature],
  };
  console.log(JSON.stringify({ mint: payload.mint, config: payload.config, pool: payload.pool, name: values.name, symbol: values.symbol, creatorShare: values.creatorShare }));
  if (!send) return;
  const origin = new URL(app).origin;
  const result = await fetch(`${origin}/api/launch/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify(payload),
  });
  console.log(result.status, await result.text());
  if (!result.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
