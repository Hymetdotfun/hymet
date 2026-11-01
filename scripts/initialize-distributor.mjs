// One-time distributor initialization for the owner. Default is a dry run (simulation only).
// Usage: node scripts/initialize-distributor.mjs --keypair <owner-upgrade-authority.json> [--rpc <url>] [--send]
// Run immediately after deployment. The program accepts only its upgrade authority (the owner wallet,
// config/production.json upgradeAuthority), which signs and pays the config rent; the deployment payer cannot.
// --local-validator permits a non-Mainnet genesis for rehearsal; it then uses the on-chain
// upgrade authority instead of config/production.json.
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  decodeProgramData,
  distributorConfigAddress,
  initializeDistributorInstruction,
  programDataAddress,
} from "../lib/distributor-init.mjs";

// Exit via exitCode: process.exit() with open RPC sockets aborts Node on Windows (libuv assertion).
class Blocked extends Error {}
async function main() {
  const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
  const fail = (message) => {
    throw new Blocked(message);
  };
  const arg = (name) => {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const send = process.argv.includes("--send"),
    local = process.argv.includes("--local-validator");
  const keypairPath = arg("--keypair");
  if (!keypairPath) {
    fail("--keypair <owner upgrade-authority keypair file> is required");
  }

  const manifest = JSON.parse(
    await readFile(
      new URL("../config/production.json", import.meta.url),
      "utf8",
    ),
  );
  const program = new PublicKey(
    arg("--program") ?? manifest.distributorProgramId,
  );
  const platform = new PublicKey(
    arg("--platform") ?? manifest.platformFeeWallet,
  );
  const snapshot = new PublicKey(
    arg("--snapshot") ?? manifest.snapshotAuthority,
  );
  let signer;
  try {
    signer = Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(await readFile(keypairPath, "utf8"))),
    );
  } catch {
    fail("--keypair is not a readable 64-byte Solana keypair file"); // never echo file contents
  }
  const c = new Connection(
    arg("--rpc") ??
      process.env.MAINNET_RPC_URL ??
      "https://api.mainnet-beta.solana.com",
    "confirmed",
  );

  const genesis = await c.getGenesisHash();
  if (genesis !== MAINNET_GENESIS && !local)
    fail("RPC is not Mainnet (use --local-validator only for rehearsal)");
  if (genesis === MAINNET_GENESIS && local)
    fail("--local-validator cannot be used against Mainnet");
  if (!local) {
    if (program.toBase58() !== manifest.distributorProgramId)
      fail("program differs from config/production.json");
    if (
      platform.toBase58() !== manifest.platformFeeWallet ||
      snapshot.toBase58() !== manifest.snapshotAuthority
    )
      fail(
        "platform wallet or snapshot authority differs from config/production.json",
      );
    if (
      !signer.publicKey.equals(new PublicKey(manifest.upgradeAuthority)) ||
      manifest.initialization?.signerAndPayer !== manifest.upgradeAuthority
    )
      fail("signer is not the owner upgrade authority in config/production.json");
  }

  const [programAccount, programData, config] = await c.getMultipleAccountsInfo(
    [program, programDataAddress(program), distributorConfigAddress(program)],
    "confirmed",
  );
  if (!programAccount?.executable) fail("program is not deployed");
  const pd = decodeProgramData(programData?.data);
  if (!pd.upgradeAuthority?.equals(signer.publicKey))
    fail("signer is not the program upgrade authority");
  if (!local && manifest.programSha256) {
    const deployed = pd.bytes.subarray(0, manifest.programBytes);
    if (
      createHash("sha256").update(deployed).digest("hex") !==
        manifest.programSha256 ||
      pd.bytes.subarray(manifest.programBytes).some((b) => b !== 0)
    )
      fail("on-chain program bytes differ from the reviewed build");
  }
  if (config)
    fail(
      `config ${distributorConfigAddress(program).toBase58()} already exists; initialization is one-time`,
    );

  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }),
    initializeDistributorInstruction(
      program,
      signer.publicKey,
      platform,
      snapshot,
    ),
  );
  tx.feePayer = signer.publicKey;
  const latest = await c.getLatestBlockhash("confirmed");
  tx.recentBlockhash = latest.blockhash;
  tx.sign(signer);
  const sim = await c.simulateTransaction(tx);
  const plan = {
    program: program.toBase58(),
    config: distributorConfigAddress(program).toBase58(),
    authority: signer.publicKey.toBase58(),
    platformWallet: platform.toBase58(),
    snapshotAuthority: snapshot.toBase58(),
    simulation: sim.value.err ? sim.value.err : "ok",
  };
  console.log(JSON.stringify(plan, null, 2));
  if (sim.value.err)
    fail(`simulation failed: ${(sim.value.logs ?? []).join(" | ")}`);
  if (!send) {
    console.log("Dry run only. Re-run with --send to submit.");
    return;
  }
  const signature = await c.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
  });
  console.log(`Submitted ${signature}; do not resend. Confirming...`);
  const result = await c.confirmTransaction(
    { signature, ...latest },
    "confirmed",
  );
  if (result.value.err)
    fail(`transaction failed: ${JSON.stringify(result.value.err)}`);
  const state = (
    await c.getAccountInfo(distributorConfigAddress(program), "confirmed")
  )?.data;
  if (
    !state?.subarray(8, 40).equals(signer.publicKey.toBuffer()) ||
    !state.subarray(40, 72).equals(platform.toBuffer()) ||
    !state.subarray(72, 104).equals(snapshot.toBuffer())
  )
    fail("confirmed config does not match the requested parameters");
  console.log(`Initialized and verified config: ${signature}`);
}
main().catch((e) => {
  console.error(
    e instanceof Blocked ? `Initialization blocked: ${e.message}` : e,
  );
  process.exitCode = 1;
});
