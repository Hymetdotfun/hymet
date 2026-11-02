// HYMET holder payout keeper. Run once per 24 h (systemd timer / cron) on the HYMET server:
//   node node_modules/jiti/lib/jiti-cli.mjs scripts/holder-rewards-keeper.ts          # dry run: plan + simulate only
//   node node_modules/jiti/lib/jiti-cli.mjs scripts/holder-rewards-keeper.ts --send   # broadcast (Mainnet needs every gate)
//   --min-payout=<HYPE base units>  lowers both payout minimums (small-amount verification runs only)
// Env: DATABASE_URL, HYMET_DISTRIBUTOR_PROGRAM_ID, HYMET_KEEPER_KEYPAIR (snapshot authority JSON),
//      MAINNET_RPC_URL (or HYMET_KEEPER_RPC_URL for a local validator / Devnet).
//      HYMET_KEEPER_MINTS (optional, comma-separated): only these mints, e.g. an instant-graduation run from
//      scripts/graduation-watcher.mjs. Unset = every distributor token (the periodic run).
// The keypair is read from disk and never printed.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import pg from "pg";
import { Connection, Keypair, PublicKey, type Transaction } from "@solana/web3.js";
import { MAINNET_GENESIS, assertMainnetTransactionsEnabled } from "../lib/app-network";
import { holderPayoutsLive } from "../lib/launch-mode";
import { awaitSignature, configuredPlatformFeeRecipient } from "../lib/transactions";
import { verifyDistributorDeployment } from "../lib/distributor-engine";
import { runHolderPayouts } from "../lib/holder-keeper";
import { migrateIfEligible } from "../lib/keeper-migration";
import { HOLDER_PAYOUT_POLICY } from "../lib/holder-payouts.mjs";

const RPC_TIMEOUT_MS = 30_000, REINDEX_TIMEOUT_MS = 180_000;

async function main() {
  const send = process.argv.includes("--send");
  const minArg = process.argv.find((a) => a.startsWith("--min-payout="))?.slice("--min-payout=".length);
  if (minArg !== undefined && !/^[1-9]\d{0,17}$/.test(minArg)) throw Error("--min-payout must be a positive integer of HYPE base units");
  const policy = minArg ? { ...HOLDER_PAYOUT_POLICY, minPayout: BigInt(minArg), minPayoutNewAccount: BigInt(minArg) } : HOLDER_PAYOUT_POLICY;
  const programText = process.env.HYMET_DISTRIBUTOR_PROGRAM_ID, keypairPath = process.env.HYMET_KEEPER_KEYPAIR;
  if (!process.env.DATABASE_URL || !programText || !keypairPath) throw Error("Set DATABASE_URL, HYMET_DISTRIBUTOR_PROGRAM_ID and HYMET_KEEPER_KEYPAIR");
  // Bounded RPC requests: a stalled request fails the token's run (every step is resumable from chain state) instead of
  // holding the keeper lock for minutes and delaying instant graduation.
  const connection = new Connection(process.env.HYMET_KEEPER_RPC_URL || process.env.MAINNET_RPC_URL || "https://api.mainnet-beta.solana.com", {
    commitment: "confirmed",
    fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(RPC_TIMEOUT_MS) }),
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
    const simulate = async (tx: Transaction, label: string, extraSigners: Keypair[] = []) => {
      tx.feePayer = authority.publicKey;
      tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
      const sim = await connection.simulateTransaction(tx, [authority, ...extraSigners]);
      log(`simulated ${label}`, { err: sim.value.err, units: sim.value.unitsConsumed });
      if (sim.value.err) throw Error(`${label} simulation failed: ${JSON.stringify(sim.value.err)}`);
    };
    const sendTx = async (tx: Transaction, label: string, extraSigners: Keypair[] = []) => {
      const block = await connection.getLatestBlockhash("confirmed");
      tx.feePayer = authority.publicKey;
      tx.recentBlockhash = block.blockhash;
      tx.sign(authority, ...extraSigners);
      const signature = await connection.sendRawTransaction(tx.serialize(), { preflightCommitment: "confirmed", maxRetries: 0 });
      const outcome = await awaitSignature(connection, signature, block.lastValidBlockHeight);
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
      const result = await runHolderPayouts({
        connection, program, platform, authority, db, log, dryRun: !send, policy,
        simulate,
        send: async (tx: Transaction, label: string) => sendTx(tx, label),
        reindex: async () => {
          // Bounded: the indexer is resumable (one signature per DB transaction), so a timeout only defers payouts to the next run.
          const start = Date.now();
          try {
            execFileSync(process.execPath, ["scripts/index-distributor.mjs"], { stdio: "inherit", env: process.env, timeout: REINDEX_TIMEOUT_MS });
          } finally {
            log("reindex", { mint: t.mint_address, ms: Date.now() - start });
          }
        },
      }, { mint: String(t.mint_address), dbcPool: String(t.pool_address) }).catch((e: unknown) => ({ mint: t.mint_address, error: e instanceof Error ? e.message : String(e) }));
      log("token result", result);
    }
  } finally {
    await db.end();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
