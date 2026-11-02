// HYMET instant-graduation watcher. Runs next to the periodic keeper on the keeper host:
//   node scripts/graduation-watcher.mjs -- <keeper command...>
// e.g. `-- node node_modules/jiti/lib/jiti-cli.mjs scripts/holder-rewards-keeper.ts --send`, or a wrapper script that
// adds the network's env and serializes with the periodic run (flock). Env: DATABASE_URL, HYMET_DISTRIBUTOR_PROGRAM_ID,
// HYMET_KEEPER_RPC_URL or MAINNET_RPC_URL.
//
// The app queues a graduation_requests row once the chain shows a complete DBC curve (lib/graduation-request.ts); the
// row's NOTIFY wakes this process, which runs the unchanged keeper for that mint only (HYMET_KEEPER_MINTS). One keeper
// run migrates (every on-chain and policy check stays in lib/keeper-migration.ts) and drains the last DBC fees; the
// next registers the canonical DAMM v2 pool and settles it. Runs repeat until the distributor shows the registered
// pool. The watcher holds no key and signs nothing; requests are processed one at a time.
import { spawn } from "node:child_process";
import { Connection, PublicKey } from "@solana/web3.js";
import pg from "pg";

const separator = process.argv.indexOf("--");
const command = separator > 0 ? process.argv.slice(separator + 1) : [];
if (!command.length) throw new Error("Usage: graduation-watcher.mjs -- <keeper command...>");
if (!process.env.DATABASE_URL || !process.env.HYMET_DISTRIBUTOR_PROGRAM_ID) throw new Error("Set DATABASE_URL and HYMET_DISTRIBUTOR_PROGRAM_ID");
const program = new PublicKey(process.env.HYMET_DISTRIBUTOR_PROGRAM_ID);
const rpc = new Connection(process.env.HYMET_KEEPER_RPC_URL || process.env.MAINNET_RPC_URL || "https://api.mainnet-beta.solana.com", { commitment: "confirmed", disableRetryOnRateLimit: true });
const MAX_RUNS = 4, POLL_MS = 30_000, RUN_GAP_MS = 3_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (message, data) => console.log(JSON.stringify({ at: new Date().toISOString(), message, ...(data === undefined ? {} : { data }) }));

// Bounded backoff for rate-limited reads (public RPCs answer HTTP 429).
async function read(call) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      if (!/\b429\b|Too Many Requests/.test(String(error?.message)) || attempt >= 6) throw error;
      await sleep(Math.min(20_000, 2_000 * 2 ** attempt));
    }
  }
}
// FeePool: 8-byte discriminator, creator, token_mint, dbc_pool, then damm_pool (set by register_damm_pool).
async function registered(mint) {
  const feePool = PublicKey.findProgramAddressSync([Buffer.from("fee-pool"), new PublicKey(mint).toBuffer()], program)[0];
  const account = await read(() => rpc.getAccountInfo(feePool, "confirmed"));
  return Boolean(account?.owner.equals(program) && !new PublicKey(account.data.subarray(104, 136)).equals(PublicKey.default));
}
const runKeeper = (mint) =>
  new Promise((resolve) => {
    const child = spawn(command[0], command.slice(1), { stdio: "inherit", env: { ...process.env, HYMET_KEEPER_MINTS: mint } });
    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
let wake = () => {};
db.on("notification", () => wake());
await db.query("LISTEN hymet_graduation");
// A request left 'processing' by a stopped watcher is retried.
await db.query("UPDATE graduation_requests SET status='pending', updated_at=now() WHERE status='processing'");
log("graduation watcher ready", { program: program.toBase58() });

for (;;) {
  const next = (
    await db.query(
      `UPDATE graduation_requests SET status='processing', attempts=attempts+1, updated_at=now()
        WHERE mint_address=(SELECT mint_address FROM graduation_requests WHERE status='pending' ORDER BY updated_at LIMIT 1 FOR UPDATE SKIP LOCKED)
        RETURNING mint_address`,
    )
  ).rows[0];
  if (!next) {
    await new Promise((resolve) => { wake = resolve; setTimeout(resolve, POLL_MS); });
    continue;
  }
  const mint = next.mint_address;
  let done = false, error = null;
  try {
    for (let run = 1; run <= MAX_RUNS && !done; run++) {
      log("instant graduation run", { mint, run });
      const code = await runKeeper(mint);
      done = await registered(mint);
      if (!done && code !== 0) error = `keeper exited ${code}`;
      if (!done && run < MAX_RUNS) await sleep(RUN_GAP_MS);
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  // Not done: the periodic keeper finishes it, and the next app request re-arms this one after a short delay.
  await db.query("UPDATE graduation_requests SET status=$2, last_error=$3, updated_at=now() WHERE mint_address=$1", [mint, done ? "done" : "failed", done ? null : (error ?? "DAMM v2 pool not registered yet").slice(0, 500)]);
  log("instant graduation result", { mint, registered: done, error });
}
