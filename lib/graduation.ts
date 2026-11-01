// Server-only: records a verified DBC -> DAMM v2 graduation in the launch index. The chain is the source of truth;
// the database is only updated after the DBC pool reports isMigrated and the derived DAMM v2 destination is verified
// (owner, PDA, layout, mint pair). Idempotent and safe to call concurrently.
import { PublicKey, type Connection } from "@solana/web3.js";
import { DYNAMIC_BONDING_CURVE_PROGRAM_ID, DynamicBondingCurveClient, type PoolConfig, type VirtualPool } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { databasePool, query } from "./db";
import { HYPE_MINT } from "./quote-assets";
import { readMigration } from "./migration";

export type GraduationSync = { status: "bonding" | "graduating" | "graduated" | "unchanged"; dammPool?: string; signature?: string };

/**
 * Newest-first scan of the DBC pool's recent history for the successful migrate_damm_v2 transaction. Undefined when
 * the RPC no longer serves it (e.g. a pruned local validator); the verified pool state is still recorded.
 */
async function migrationSignature(c: Connection, dbcPool: PublicKey, destination: PublicKey) {
  const sigs = await c.getSignaturesForAddress(dbcPool, { limit: 100 }, "confirmed");
  for (const s of sigs) {
    if (s.err) continue;
    const tx = await c.getTransaction(s.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (!tx || tx.meta?.err) continue;
    const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta?.loadedAddresses }).keySegments().flat();
    if (
      keys.some((k) => k.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID)) &&
      keys.some((k) => k.equals(destination)) &&
      tx.meta?.logMessages?.some((l) => /Instruction: Migrat\w*DammV2/i.test(l))
    )
      return { signature: s.signature, slot: s.slot };
  }
  return undefined;
}

export async function syncGraduation(c: Connection, mint: string): Promise<GraduationSync> {
  const rows = (
    await query<{ status: string; pool_address: string; protocol: string; pool_status: string }>(
      `SELECT t.status,p.pool_address,p.protocol,p.status AS pool_status FROM tokens t JOIN pools p USING(mint_address)
        WHERE t.mint_address=$1 AND t.quote_mint=$2`,
      [mint, HYPE_MINT.toBase58()],
    )
  ).rows;
  const dbc = rows.find((r) => r.protocol === "meteora_dbc");
  if (!dbc || rows.some((r) => r.protocol === "meteora_damm_v2")) return { status: "unchanged" };
  const sdk = new DynamicBondingCurveClient(c, "confirmed");
  const dbcPool = new PublicKey(dbc.pool_address);
  const account = await c.getAccountInfo(dbcPool, "confirmed");
  if (!account?.owner.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID)) return { status: "unchanged" };
  const state = sdk.program.coder.accounts.decode<VirtualPool>("virtualPool", account.data).poolState;
  const cfgAccount = await c.getAccountInfo(state.config, "confirmed");
  if (!cfgAccount?.owner.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID) || state.baseMint.toBase58() !== mint) return { status: "unchanged" };
  const config = sdk.program.coder.accounts.decode<PoolConfig>("poolConfig", cfgAccount.data);
  if (!config.quoteMint.equals(HYPE_MINT)) return { status: "unchanged" };
  const view = await readMigration(c, state, config);
  if (view.label === "Migration Eligible" || view.label === "Migration Pending") {
    if (rows[0].status !== "bonding") return { status: "unchanged" };
    await query("UPDATE tokens SET status='graduating' WHERE mint_address=$1 AND status='bonding'", [mint]);
    return { status: "graduating" };
  }
  // Only a verified, enabled destination is recorded; anything else leaves the index untouched.
  if (view.label !== "Migrated to DAMM V2" || view.venue !== "DAMM V2" || !view.destination || view.detail === "Destination pool is disabled")
    return { status: "unchanged" };
  const destination = new PublicKey(view.destination);
  const event = await migrationSignature(c, dbcPool, destination);
  const client = await (await databasePool()).connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "INSERT INTO pools(pool_address,mint_address,protocol,quote_mint,status) VALUES($1,$2,'meteora_damm_v2',$3,'active') ON CONFLICT DO NOTHING",
      [destination.toBase58(), mint, HYPE_MINT.toBase58()],
    );
    await client.query("UPDATE pools SET status='migrated' WHERE pool_address=$1 AND protocol='meteora_dbc'", [dbcPool.toBase58()]);
    await client.query("UPDATE tokens SET status='graduated' WHERE mint_address=$1 AND status IN ('bonding','graduating')", [mint]);
    if (event)
      await client.query(
        "INSERT INTO migration_events(mint_address,from_pool,to_pool,signature,slot) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
        [mint, dbcPool.toBase58(), destination.toBase58(), event.signature, event.slot],
      );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  return { status: "graduated", dammPool: destination.toBase58(), signature: event?.signature };
}
