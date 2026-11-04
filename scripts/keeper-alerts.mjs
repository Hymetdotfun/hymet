// Keeper health check (runbook K5); run every few minutes from a systemd timer, after or alongside the keeper.
//   node scripts/keeper-alerts.mjs
//   node scripts/keeper-alerts.mjs --test-telegram    # sends one test message; touches neither the database nor the chain
// Env: DATABASE_URL, HYMET_DISTRIBUTOR_PROGRAM_ID, HYMET_SNAPSHOT_AUTHORITY (the keeper's public key; no key file needed),
//      HYMET_KEEPER_STATUS_FILE (written by the keeper), MAINNET_RPC_URL (or HYMET_KEEPER_RPC_URL),
//      HYMET_ALERT_WEBHOOK_URL (optional): alerts are POSTed there as JSON.
//      HYMET_TELEGRAM_BOT_TOKEN + HYMET_TELEGRAM_CHAT_ID (optional): notify on change, remind while active, report recovery.
//      HYMET_ALERT_STATE_FILE (optional): notification state; default alert-state.json beside the status file.
//      HYMET_ALERT_HEARTBEAT_HOURS (optional): silent "still alive" Telegram message after this long without one
//      (default 24; 0 = off). Going quiet for longer means this server cannot alert at all.
//      HYMET_ALERT_UNITS (optional, comma-separated): systemd units that must be active.
// Prints one JSON line; exits 1 when any alert fires (so systemd OnFailure= can notify too). Read-only on chain.
import { execFile } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import pg from "pg";
import { Connection, PublicKey } from "@solana/web3.js";
import { formatNotification, keeperAlerts, markSent, planNotifications, redactSecrets } from "../lib/keeper-alerts.mjs";
import { sendTelegram, telegramConfig } from "../lib/telegram.mjs";

const FEE_POOL = createHash("sha256").update("account:FeePool").digest().subarray(0, 8);

function unitState(name) {
  return new Promise((resolve) => {
    // is-active exits non-zero for anything but active; its stdout is still the state.
    execFile("systemctl", ["is-active", name], { timeout: 10_000 }, (_error, stdout) => resolve({ name, state: String(stdout).trim() || "unknown" }));
  });
}

function stateFile() {
  if (process.env.HYMET_ALERT_STATE_FILE) return process.env.HYMET_ALERT_STATE_FILE;
  if (!process.env.HYMET_KEEPER_STATUS_FILE) throw Error("Set HYMET_ALERT_STATE_FILE or HYMET_KEEPER_STATUS_FILE");
  return join(dirname(process.env.HYMET_KEEPER_STATUS_FILE), "alert-state.json");
}

/** Sends whatever is due and saves the state; what could not be sent stays due for the next run. */
async function notifyTelegram(alerts, { partial = false, summary = null } = {}) {
  const config = telegramConfig(process.env);
  if (!config) return;
  const file = stateFile(), now = Date.now();
  let state = {};
  try { state = JSON.parse(readFileSync(file, "utf8")); } catch { /* first run, or unreadable: start clean */ }
  const { active, due } = planNotifications(state, alerts, now, { partial });
  let lastMessageAt = state.lastMessageAt ?? 0;
  let failure = null;
  try {
    const { text, included } = formatNotification(due);
    if (text) {
      await sendTelegram(config, text);
      markSent(active, included, now);
      lastMessageAt = now;
    }
    const hours = Number(process.env.HYMET_ALERT_HEARTBEAT_HOURS ?? 24);
    if (summary && hours > 0 && now - lastMessageAt >= hours * 3_600_000) {
      await sendTelegram(config, `💚 HYMET keeper alerts are running. Keeper SOL ${summary.sol}, distributor tokens ${summary.tokens}, active alerts ${alerts.length}.`, { silent: true });
      lastMessageAt = now;
    }
  } catch (e) {
    failure = e;
  }
  writeFileSync(`${file}.tmp`, JSON.stringify({ active, lastMessageAt }), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
  if (failure) throw failure;
}

async function main() {
  if (process.argv.includes("--test-telegram")) {
    const config = telegramConfig(process.env);
    if (!config) throw Error("Telegram is not configured");
    await sendTelegram(config, "✅ HYMET keeper alerts are connected. This is a test; no action needed.");
    console.log("Telegram test message sent");
    return;
  }
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
      return { mint, feePool: feePools[i], nextEpoch: d ? d.readBigUInt64LE(162) : 0n, openEpoch: null, holderUnallocated: d ? d.readBigUInt64LE(146) : 0n, lastSnapshotSlot: d ? d.readBigUInt64LE(187) : 0n, dammRegistered: d ? d.subarray(104, 136).some((b) => b !== 0) : false };
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
    const units = await Promise.all((process.env.HYMET_ALERT_UNITS ?? "").split(",").map((u) => u.trim()).filter(Boolean).map(unitState));
    const dammRegistered = new Map(pools.map((p) => [p.mint, p.dammRegistered]));
    const graduations = (await db.query(
      "SELECT mint_address, last_error, EXTRACT(EPOCH FROM now()-requested_at)*1000 AS age_ms FROM graduation_requests WHERE status<>'done' AND mint_address=ANY($1) AND requested_at < now()-interval '30 minutes'",
      [mints],
    )).rows.map((r) => ({ mint: String(r.mint_address), ageMs: Number(r.age_ms), lastError: r.last_error, dammRegistered: dammRegistered.get(String(r.mint_address)) ?? false }));
    const alerts = keeperAlerts({ now: Date.now(), slot: BigInt(slot), keeperLamports: BigInt(lamports), status, pools, indexedEpochs, units, graduations });
    const report = { at: new Date().toISOString(), keeper: keeper.toBase58(), keeperLamports: lamports, tokens: mints.length, alerts };
    console.log(JSON.stringify(report));
    if (alerts.length && process.env.HYMET_ALERT_WEBHOOK_URL) {
      const r = await fetch(process.env.HYMET_ALERT_WEBHOOK_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(report), signal: AbortSignal.timeout(10_000) });
      if (!r.ok) console.error(`Alert webhook answered HTTP ${r.status}`);
    }
    if (alerts.length) process.exitCode = 1;
    await notifyTelegram(alerts, { summary: { sol: lamports / 1e9, tokens: mints.length } }).catch((e) => {
      console.error(`Telegram alert not sent: ${redactSecrets(e instanceof Error ? e.message : e)}`);
      process.exitCode = 1;
    });
  } finally {
    await db.end();
  }
}

main().catch(async (e) => {
  const message = redactSecrets(e instanceof Error ? e.message : e);
  console.error(message);
  process.exitCode = 2;
  if (process.argv.includes("--test-telegram")) return;
  // The check itself is down (database or RPC): say so, without treating anything already active as resolved.
  await notifyTelegram([{ code: "alert-check-failed", message }], { partial: true }).catch((sendError) => {
    console.error(`Telegram alert not sent: ${redactSecrets(sendError instanceof Error ? sendError.message : sendError)}`);
  });
});
