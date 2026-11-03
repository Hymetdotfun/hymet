// Keeper health check (runbook K5); run every few minutes from a systemd timer, after or alongside the keeper.
//   node scripts/keeper-alerts.mjs
// Env: DATABASE_URL, HYMET_DISTRIBUTOR_PROGRAM_ID, HYMET_SNAPSHOT_AUTHORITY (the keeper's public key; no key file needed),
//      HYMET_KEEPER_STATUS_FILE (written by the keeper), MAINNET_RPC_URL (or HYMET_KEEPER_RPC_URL),
//      HYMET_ALERT_WEBHOOK_URL (optional): alerts are POSTed there as JSON.
// Prints one JSON line; exits 1 when any alert fires (so systemd OnFailure= can notify too). Read-only on chain.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import pg from "pg";
import { Connection, PublicKey } from "@solana/web3.js";
import { keeperAlerts } from "../lib/keeper-alerts.mjs";

const FEE_POOL = createHash("sha256").update("account:FeePool").digest().subarray(0, 8);

async function main() {
  const { DATABASE_URL, HYMET_DISTRIBUTOR_PROGRAM_ID, HYMET_SNAPSHOT_AUTHORITY, HYMET_KEEPER_STATUS_FILE } = process.env;
  if (!DATABASE_URL || !HYMET_DISTRIBUTOR_PROGRAM_ID || !HYMET_SNAPSHOT_AUTHORITY || !HYMET_KEEPER_STATUS_FILE)
    throw Error("Set DATABASE_URL, HYMET_DISTRIBUTOR_PROGRAM_ID, HYMET_SNAPSHOT_AUTHORITY and HYMET_KEEPER_STATUS_FILE");
  const program = new PublicKey(HYMET_DISTRIBUTOR_PROGRAM_ID), keeper = new PublicKey(HYMET_SNAPSHOT_AUTHORITY);
  const c = new Connection(process.env.HYMET_KEEPER_RPC_URL || process.env.MAINNET_RPC_URL || "https://api.mainnet-beta.solana.com", "confirmed");
  let status = null;
  try { status = JSON.parse(readFileSync(HYMET_KEEPER_STATUS_FILE, "utf8")); } catch { /* reported as keeper-no-status */ }

  const db = new pg.Client({ connectionString: DATABASE_URL });
  await db.connect();
  try {
    const mints = (await db.query("SELECT mint_address FROM tokens WHERE distributor_program_id=$1 AND holder_share_of_remaining_bps>0", [program.toBase58()])).rows.map((r) => String(r.mint_address));
    const indexedEpochs = new Map();
    for (const r of (await db.query("SELECT mint_address, epoch::text FROM holder_reward_epochs WHERE mint_address=ANY($1)", [mints])).rows) {
      if (!indexedEpochs.has(r.mint_address)) indexedEpochs.set(r.mint_address, new Set());
      indexedEpochs.get(r.mint_address).add(r.epoch);
    }
    const feePools = mints.map((m) => PublicKey.findProgramAddressSync([Buffer.from("fee-pool"), new PublicKey(m).toBuffer()], program)[0]);
    const infos = [];
    for (let i = 0; i < feePools.length; i += 100) infos.push(...(await c.getMultipleAccountsInfo(feePools.slice(i, i + 100), "confirmed")));
    const pools = mints.map((mint, i) => {
      const d = infos[i]?.owner.equals(program) && infos[i].data.subarray(0, 8).equals(FEE_POOL) ? infos[i].data : null;
      return { mint, feePool: feePools[i], nextEpoch: d ? d.readBigUInt64LE(162) : 0n, openEpoch: null };
    });
    // The latest epoch account exists only while it is open (closing deletes it).
    const latest = pools.filter((p) => p.nextEpoch > 0n);
    const epochKeys = latest.map((p) => {
      const n = Buffer.alloc(8); n.writeBigUInt64LE(p.nextEpoch - 1n);
      return PublicKey.findProgramAddressSync([Buffer.from("epoch"), p.feePool.toBuffer(), n], program)[0];
    });
    for (let i = 0; i < epochKeys.length; i += 100) {
      const accounts = await c.getMultipleAccountsInfo(epochKeys.slice(i, i + 100), "confirmed");
      accounts.forEach((a, j) => {
        if (a?.owner.equals(program) && a.data.length >= 56) latest[i + j].openEpoch = { number: a.data.readBigUInt64LE(40), snapshotSlot: a.data.readBigUInt64LE(48) };
      });
    }
    const [slot, lamports] = await Promise.all([c.getSlot("confirmed"), c.getBalance(keeper, "confirmed")]);
    const alerts = keeperAlerts({ now: Date.now(), slot: BigInt(slot), keeperLamports: BigInt(lamports), status, pools, indexedEpochs });
    const report = { at: new Date().toISOString(), keeper: keeper.toBase58(), keeperLamports: lamports, tokens: mints.length, alerts };
    console.log(JSON.stringify(report));
    if (alerts.length && process.env.HYMET_ALERT_WEBHOOK_URL) {
      const r = await fetch(process.env.HYMET_ALERT_WEBHOOK_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(report), signal: AbortSignal.timeout(10_000) });
      if (!r.ok) console.error(`Alert webhook answered HTTP ${r.status}`);
    }
    if (alerts.length) process.exitCode = 1;
  } finally {
    await db.end();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 2;
});
