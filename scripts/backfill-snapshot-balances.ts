// Records the holder balances of a funded snapshot taken before balances were stored, and the origin of carry allocated by
// it. Database only; signs and sends nothing. Refuses unless the balances reproduce the snapshot hash emitted on-chain.
// Without --write it only reports.
//   node node_modules/jiti/lib/jiti-cli.mjs scripts/backfill-snapshot-balances.ts <mint> <epoch> <balances.json> [--write]
// balances.json: { "<wallet>": "<token balance in base units>" } for every holder in that snapshot. Keep it out of the repository.
import { readFileSync } from "node:fs";
import { Connection, PublicKey } from "@solana/web3.js";
import pg from "pg";
import { decodeDistributorEvents } from "../lib/distributor-events.mjs";
import { snapshotCommitment } from "../lib/holder-payouts.mjs";

const redact = (text: unknown) => String(text).replace(/\b(?:https?|postgres(?:ql)?):\/\/\S+/g, "<url>");

async function main() {
  const [mint, epochText, file] = process.argv.slice(2);
  const write = process.argv.includes("--write");
  const epoch = BigInt(epochText);
  const balances = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    const row = (await db.query(
      "SELECT e.snapshot_hash,e.snapshot_slot::text,e.funding_signature,t.distributor_program_id,c.carry_after FROM holder_reward_epochs e JOIN tokens t USING(mint_address) JOIN holder_snapshot_candidates c USING(mint_address,epoch) WHERE e.mint_address=$1 AND e.epoch=$2",
      [mint, epoch.toString()],
    )).rows[0];
    if (!row) throw Error("Funded epoch not found");
    const connection = new Connection(process.env.MAINNET_RPC_URL || "https://api.mainnet-beta.solana.com", "confirmed");
    const funding = await connection.getTransaction(row.funding_signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    const event = (decodeDistributorEvents(funding?.meta?.logMessages ?? [], row.distributor_program_id) as unknown as { type: string; payload: Record<string, unknown> }[]).find((x) => x.type === "HolderEpochFunded" && x.payload.mint === mint && String(x.payload.epoch) === epoch.toString());
    if (!event) throw Error("Funding event not found on-chain");
    const holders = Object.entries(balances)
      .map(([wallet, b]) => ({ wallet, tokenBalance: BigInt(b) }))
      .sort((a, b) => Buffer.compare(new PublicKey(a.wallet).toBuffer(), new PublicKey(b.wallet).toBuffer()));
    const settlements = (await db.query(
      "SELECT token_balance::text,wallet_address,reward_amount::text,origin_epoch::text,origin_snapshot_slot::text FROM holder_snapshot_candidate_rows WHERE mint_address=$1 AND epoch=$2 AND origin_epoch IS NOT NULL",
      [mint, epoch.toString()],
    )).rows.map((r) => ({ wallet: r.wallet_address, tokenBalance: BigInt(r.token_balance), reward: BigInt(r.reward_amount), originEpoch: BigInt(r.origin_epoch), originSnapshotSlot: BigInt(r.origin_snapshot_slot) }));
    const computed = snapshotCommitment({ mint, epoch, snapshotSlot: BigInt(String(event.payload.snapshotSlot)), holders, settlements }).toString("hex");
    if (computed !== event.payload.snapshotHash) throw Error("Balances do not reproduce the on-chain snapshot hash; nothing written");
    console.log(`proven: ${holders.length} balances reproduce the on-chain hash ${computed}`);
    if (!write) return console.log("report only; pass --write to record");
    const origins = Object.fromEntries(Object.keys(row.carry_after ?? {}).filter((w) => balances[w]).map((w) => [w, { epoch: epoch.toString(), snapshotSlot: row.snapshot_slot, tokenBalance: balances[w] }]));
    await db.query("BEGIN");
    try {
      await db.query("UPDATE holder_snapshot_candidates SET snapshot_balances=$3::jsonb,carry_origins=$4::jsonb WHERE mint_address=$1 AND epoch=$2", [mint, epoch.toString(), JSON.stringify(balances), JSON.stringify(origins)]);
      let updated = 0;
      for (const [wallet, o] of Object.entries(origins))
        updated += (await db.query("UPDATE holder_reward_carry SET origin_epoch=$3,origin_snapshot_slot=$4,origin_token_balance=$5 WHERE mint_address=$1 AND wallet_address=$2 AND origin_epoch IS NULL", [mint, wallet, o.epoch, o.snapshotSlot, o.tokenBalance])).rowCount ?? 0;
      await db.query("COMMIT");
      console.log(`recorded; ${updated} carried wallet(s) now have an origin`);
    } catch (e) {
      await db.query("ROLLBACK");
      throw e;
    }
  } finally {
    await db.end();
  }
}

main().catch((e) => {
  console.error(redact(e instanceof Error ? e.message : e));
  process.exitCode = 1;
});
