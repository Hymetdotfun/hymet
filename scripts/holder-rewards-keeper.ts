// HYMET holder payout keeper. Run every few minutes (systemd timer) on the HYMET server: migration, canonical DAMM
// registration and settlement run every tick; holder snapshots and payouts at most once per payout interval.
//   node node_modules/jiti/lib/jiti-cli.mjs scripts/holder-rewards-keeper.ts          # dry run: plan + simulate only
//   node node_modules/jiti/lib/jiti-cli.mjs scripts/holder-rewards-keeper.ts --send   # broadcast (Mainnet needs every gate)
//   --min-payout=<HYPE base units>  lowers both payout minimums (small-amount verification runs only)
//   --payout-interval-minutes=<n>   minimum real time between holder payouts per token, from block timestamps (default 15; 0 = every run)
//   --payout-interval-hours=<n>     the same in hours, for existing test tooling
// Env: DATABASE_URL, HYMET_DISTRIBUTOR_PROGRAM_ID, HYMET_KEEPER_KEYPAIR (snapshot authority JSON),
//      MAINNET_RPC_URL (or HYMET_KEEPER_RPC_URL for a local validator / Devnet).
//      HYMET_KEEPER_MINTS (optional, comma-separated): only these mints, e.g. an instant-graduation run from
//      scripts/graduation-watcher.mjs. Unset = every distributor token (the periodic run).
//      HYMET_KEEPER_PRIORITY_MICROLAMPORTS (optional): compute-unit price for keeper transactions (default 20000; 0 = none).
//      HYMET_KEEPER_STATUS_FILE (optional): written after each run ({at, ok, tokens, errors, settlementErrors, migrationErrors, carrying}) for scripts/keeper-alerts.mjs.
// The keypair is read from disk and never printed.
import { spawn } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import pg from "pg";
import { Connection, Keypair, PublicKey, type Transaction } from "@solana/web3.js";
import { MAINNET_GENESIS, assertMainnetTransactionsEnabled } from "../lib/app-network";
import { holderPayoutsLive } from "../lib/launch-mode";
import { awaitSignature, configuredPlatformFeeRecipient } from "../lib/transactions";
import { verifyDistributorDeployment } from "../lib/distributor-engine";
import { runHolderPayouts, type EmptySnapshot, type EmptySnapshotStore } from "../lib/holder-keeper";
import { migrateIfEligible } from "../lib/keeper-migration";
import { HOLDER_PAYOUT_POLICY } from "../lib/holder-payouts.mjs";
import { KEEPER_PRIORITY_MICROLAMPORTS, describeSendFailure, keeperFetch, withPriorityFee } from "../lib/keeper-rpc";

const RPC_TIMEOUT_MS = 30_000, REINDEX_TIMEOUT_MS = 180_000;

type MintError = { mint: string; error: string };
/** Empty-snapshot memory beside the status file. Unreadable or unwritable only costs an extra snapshot. */
function emptySnapshotFile(): EmptySnapshotStore | undefined {
  const status = process.env.HYMET_KEEPER_STATUS_FILE;
  if (!status) return undefined;
  const file = join(dirname(status), "empty-snapshots.json");
  let saved: Record<string, EmptySnapshot> = {};
  try { saved = JSON.parse(readFileSync(file, "utf8")); } catch { /* first run */ }
  return {
    get: (mint) => saved[mint],
    set: (mint, value) => {
      if (value) saved[mint] = value; else delete saved[mint];
      try { writeFileSync(`${file}.tmp`, JSON.stringify(saved)); renameSync(`${file}.tmp`, file); } catch { /* only costs a snapshot */ }
    },
  };
}
function writeStatus(status: { ok: boolean; tokens: number; errors: unknown[]; settlementErrors?: MintError[]; migrationErrors?: MintError[]; carrying?: string[] }) {
  const file = process.env.HYMET_KEEPER_STATUS_FILE;
  if (!file) return;
  writeFileSync(`${file}.tmp`, JSON.stringify({ at: new Date().toISOString(), ...status }));
  renameSync(`${file}.tmp`, file);
}

// The indexer runs as a child process without blocking this one, so the RPC connection pool keeps servicing its
// sockets meanwhile. Resumable (one signature per DB transaction): a timeout only defers payouts to the next run.
function reindexDistributor() {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/index-distributor.mjs"], { stdio: "inherit", env: process.env });
    const timer = setTimeout(() => child.kill("SIGTERM"), REINDEX_TIMEOUT_MS);
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(Error(`Distributor indexer ${signal ? `stopped (${signal})` : `exited ${code}`}`));
    });
  });
}

async function main() {
  const send = process.argv.includes("--send");
  const minArg = process.argv.find((a) => a.startsWith("--min-payout="))?.slice("--min-payout=".length);
  if (minArg !== undefined && !/^[1-9]\d{0,17}$/.test(minArg)) throw Error("--min-payout must be a positive integer of HYPE base units");
  const policy = minArg ? { ...HOLDER_PAYOUT_POLICY, minPayout: BigInt(minArg), minPayoutNewAccount: BigInt(minArg) } : HOLDER_PAYOUT_POLICY;
  const intervalArg = process.argv.find((a) => a.startsWith("--payout-interval-hours="))?.slice("--payout-interval-hours=".length);
  if (intervalArg !== undefined && !/^\d{1,3}$/.test(intervalArg)) throw Error("--payout-interval-hours must be a whole number of hours");
  const minutesArg = process.argv.find((a) => a.startsWith("--payout-interval-minutes="))?.slice("--payout-interval-minutes=".length);
  if (minutesArg !== undefined && !/^\d{1,5}$/.test(minutesArg)) throw Error("--payout-interval-minutes must be a whole number of minutes");
  const payoutIntervalSeconds = minutesArg !== undefined ? Number(minutesArg) * 60 : intervalArg !== undefined ? Number(intervalArg) * 3600 : HOLDER_PAYOUT_POLICY.intervalMinutes * 60;
  const feeText = process.env.HYMET_KEEPER_PRIORITY_MICROLAMPORTS;
  if (feeText !== undefined && !/^\d{1,9}$/.test(feeText)) throw Error("HYMET_KEEPER_PRIORITY_MICROLAMPORTS must be a non-negative integer");
  const priorityFee = feeText === undefined ? KEEPER_PRIORITY_MICROLAMPORTS : Number(feeText);
  const programText = process.env.HYMET_DISTRIBUTOR_PROGRAM_ID, keypairPath = process.env.HYMET_KEEPER_KEYPAIR;
  if (!process.env.DATABASE_URL || !programText || !keypairPath) throw Error("Set DATABASE_URL, HYMET_DISTRIBUTOR_PROGRAM_ID and HYMET_KEEPER_KEYPAIR");
  // Bounded RPC requests: a stalled request fails the token's run (every step is resumable from chain state) instead of
  // holding the keeper lock for minutes and delaying instant graduation. Reads that hit a dead socket are retried once.
  const connection = new Connection(process.env.HYMET_KEEPER_RPC_URL || process.env.MAINNET_RPC_URL || "https://api.mainnet-beta.solana.com", {
    commitment: "confirmed",
    fetch: keeperFetch(RPC_TIMEOUT_MS),
  });
  const mainnet = (await connection.getGenesisHash()) === MAINNET_GENESIS;
  if (send && mainnet) {
    assertMainnetTransactionsEnabled();
    if (!holderPayoutsLive()) throw Error("Holder payouts are not owner-verified (HYMET_LAUNCH_MODE=distributor, HYMET_DISTRIBUTOR_*_VERIFIED, HYMET_HOLDER_PAYOUTS_VERIFIED)");
  }
  const program = new PublicKey(programText), platform = configuredPlatformFeeRecipient();
  const onlyMints = process.env.HYMET_KEEPER_MINTS ? process.env.HYMET_KEEPER_MINTS.split(",").map((m) => new PublicKey(m.trim()).toBase58()) : null;
  const authority = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keypairPath, "utf8"))));
  const config = await verifyDistributorDeployment(connection, program, platform);
  const configState = await connection.getAccountInfo(config, "confirmed");
  if (!configState || !new PublicKey(configState.data.subarray(72, 104)).equals(authority.publicKey)) throw Error("Keeper key is not the distributor snapshot authority");

  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const log = (message: string, data?: unknown) => console.log(JSON.stringify({ at: new Date().toISOString(), message, ...(data === undefined ? {} : { data }) }));
  try {
    const tokens = (await db.query(
      "SELECT t.mint_address,p.pool_address FROM tokens t JOIN pools p USING(mint_address) WHERE t.distributor_program_id=$1 AND t.holder_share_of_remaining_bps>0 AND p.protocol='meteora_dbc' AND ($2::text[] IS NULL OR t.mint_address=ANY($2)) ORDER BY t.created_at",
      [program.toBase58(), onlyMints],
    )).rows;
    const emptySnapshots = emptySnapshotFile();
    const errors: unknown[] = [], settlementErrors: MintError[] = [], migrationErrors: MintError[] = [], carrying: string[] = [];
    const simulate = async (tx: Transaction, label: string, extraSigners: Keypair[] = []) => {
      tx.feePayer = authority.publicKey;
      tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
      const sim = await connection.simulateTransaction(tx, [authority, ...extraSigners]);
      log(`simulated ${label}`, { err: sim.value.err, units: sim.value.unitsConsumed });
      if (sim.value.err) throw Error(`${label} simulation failed: ${JSON.stringify(sim.value.err)}`);
    };
    // Priority fee plus rebroadcast of the same signed bytes until confirmed or the blockhash expires, so a dropped
    // transaction does not defer settlement or payouts to the next run. Same signature: it can land at most once.
    const sendTx = async (tx: Transaction, label: string, extraSigners: Keypair[] = []) => {
      withPriorityFee(tx, priorityFee);
      const block = await connection.getLatestBlockhash("confirmed");
      tx.feePayer = authority.publicKey;
      tx.recentBlockhash = block.blockhash;
      tx.sign(authority, ...extraSigners);
      const raw = tx.serialize();
      let signature: string;
      try {
        signature = await connection.sendRawTransaction(raw, { preflightCommitment: "confirmed", maxRetries: 0 });
      } catch (error) {
        throw Error(await describeSendFailure(error, connection, label));
      }
      const outcome = await awaitSignature(connection, signature, block.lastValidBlockHeight, {
        rebroadcast: () => connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }),
      });
      log(label, { signature, state: outcome.state });
      if (outcome.state !== "confirmed") throw Error(`${label} ${outcome.state}: ${signature}`);
      return signature;
    };
    // HYMET_AUTO_MIGRATE: "all" (default), "off", or a comma-separated mint allowlist (staged rollouts and tests).
    const autoMigrate = (process.env.HYMET_AUTO_MIGRATE || "all").trim();
    const migrates = (mint: string) => autoMigrate === "all" || (autoMigrate !== "off" && autoMigrate.split(",").map((m) => m.trim()).includes(mint));
    for (const t of tokens) {
      // Graduation first: a complete curve is migrated to DAMM v2 so this run's settlement can use the new position.
      const migration = !migrates(String(t.mint_address)) ? { mint: t.mint_address, migrate: false, status: "auto-migration not enabled for this mint" } : await migrateIfEligible({ connection, program, authority, dryRun: !send, simulate, send: async (tx, label, extra) => sendTx(tx, label, extra) }, { mint: String(t.mint_address), dbcPool: String(t.pool_address) })
        .catch((e: unknown) => ({ mint: t.mint_address, error: e instanceof Error ? e.message : String(e) }));
      log("migration check", migration);
      if ("error" in migration) migrationErrors.push({ mint: String(t.mint_address), error: String(migration.error).slice(0, 300) });
      const result = await runHolderPayouts({
        connection, program, platform, authority, db, log, dryRun: !send, policy, payoutIntervalSeconds, emptySnapshots,
        onSettlementError: (mint: string, error: string) => settlementErrors.push({ mint, error: error.slice(0, 300) }),
        simulate,
        send: async (tx: Transaction, label: string) => sendTx(tx, label),
        reindex: async () => {
          const start = Date.now();
          try {
            await reindexDistributor();
          } finally {
            log("reindex", { mint: t.mint_address, ms: Date.now() - start });
          }
        },
      }, { mint: String(t.mint_address), dbcPool: String(t.pool_address) }).catch((e: unknown) => ({ mint: t.mint_address, error: e instanceof Error ? e.message : String(e) }));
      log("token result", result);
      if ("error" in result) errors.push(result);
      else if ("payouts" in result && result.payouts === 0) carrying.push(String(t.mint_address));
    }
    // Only the periodic (all-token) run reports health; an instant-graduation run covers one mint.
    if (!onlyMints) writeStatus({ ok: errors.length === 0, tokens: tokens.length, errors, settlementErrors, migrationErrors, carrying });
  } finally {
    await db.end();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  if (!process.env.HYMET_KEEPER_MINTS) writeStatus({ ok: false, tokens: 0, errors: [e instanceof Error ? e.message : String(e)] });
  process.exitCode = 1;
});
