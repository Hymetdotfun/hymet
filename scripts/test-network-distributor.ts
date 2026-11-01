// Local test network only: initializes the deployed distributor on the loopback validator with seed-derived LOCAL
// keys (upgrade authority = the validator trader set by validator-fixture-start.cjs) and writes the local keeper key
// file for the test keeper. Idempotent; refuses any non-loopback RPC or the Mainnet genesis. Never prints a secret key.
//   HYMET_TEST_RPC_URL=http://127.0.0.1:19995 node node_modules/jiti/lib/jiti-cli.mjs scripts/test-network-distributor.ts <keeper.json>
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { MAINNET_GENESIS } from "../lib/app-network";
import { verifyDistributorAuthorities, verifyDistributorDeployment } from "../lib/distributor-engine";
import { distributorConfigAddress, initializeDistributorInstruction } from "../lib/distributor-init.mjs";

const PROGRAM = new PublicKey("9X9fnj4Uh9WC9nmxCahTVsixHZ6VGxNpMesuGhK239Px");
const local = (label: string) => Keypair.fromSeed(createHash("sha256").update(`HYMET LOCAL VALIDATOR ONLY ${label}`).digest());

async function main() {
  const rpc = process.env.HYMET_TEST_RPC_URL || "", keeperPath = process.argv[2];
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(rpc)) throw Error("HYMET_TEST_RPC_URL must be the loopback validator");
  if (!keeperPath) throw Error("Usage: test-network-distributor.ts <keeper.json>");
  const c = new Connection(rpc, "confirmed");
  if ((await c.getGenesisHash()) === MAINNET_GENESIS) throw Error("REFUSING: Mainnet genesis");
  const trader = local("TRADER"), platform = local("PLATFORM"), keeper = local("KEEPER");
  for (const k of [trader, platform, keeper])
    if ((await c.getBalance(k.publicKey)) < 1e9) await c.confirmTransaction(await c.requestAirdrop(k.publicKey, 2e9), "confirmed");
  const config = distributorConfigAddress(PROGRAM);
  if (!(await c.getAccountInfo(config, "confirmed"))) {
    const signature = await sendAndConfirmTransaction(c, new Transaction().add(initializeDistributorInstruction(PROGRAM, trader.publicKey, platform.publicKey, keeper.publicKey)), [trader], { commitment: "confirmed" });
    console.log(`initialized distributor config ${config.toBase58()}: ${signature}`);
  }
  await verifyDistributorDeployment(c, PROGRAM, platform.publicKey);
  await verifyDistributorAuthorities(c, PROGRAM, keeper.publicKey, trader.publicKey);
  writeFileSync(keeperPath, JSON.stringify(Array.from(keeper.secretKey)), { mode: 0o600 });
  console.log(JSON.stringify({ program: PROGRAM.toBase58(), config: config.toBase58(), platform: platform.publicKey.toBase58(), snapshotAuthority: keeper.publicKey.toBase58(), upgradeAuthority: trader.publicKey.toBase58(), verified: true }));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
