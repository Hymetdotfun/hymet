// Hand the freshly deployed distributor's upgrade authority from the CLI deploy key to the Phantom owner.
// Default is a dry run (simulation only).
// Usage: node scripts/handover-upgrade-authority.mjs --keypair <deploy-key.json> --proof <owner-proof.json> [--rpc <url>] [--send]
// The deploy key (config deployKey, the current on-chain upgrade authority) signs alone; the owner never exports a key. It refuses
// unless the bytes are the reviewed build, the config is not yet initialized, the new authority is
// config/production.json upgradeAuthority, and owner-proof.json (from the /owner page) is a fresh Phantom signature by it.
// --local-validator permits a non-Mainnet genesis for rehearsal (skips the manifest program and hash checks).
import { readFile } from "node:fs/promises";
import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram } from "@solana/web3.js";
import { decodeProgramData, distributorConfigAddress, programDataAddress, reviewedBytesError, setUpgradeAuthorityInstruction } from "../lib/distributor-init.mjs";
import { verifyOwnerProof } from "../lib/owner-proof-verify.mjs";

class Blocked extends Error {}
async function main() {
  const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
  const fail = (message) => { throw new Blocked(message); };
  const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
  const send = process.argv.includes("--send"), local = process.argv.includes("--local-validator");
  if (!arg("--keypair") || !arg("--proof")) fail("--keypair <deploy key> and --proof <owner-proof.json> are required");
  const manifest = JSON.parse(await readFile(new URL("../config/production.json", import.meta.url), "utf8"));
  const program = new PublicKey(arg("--program") ?? manifest.distributorProgramId);
  const owner = new PublicKey(arg("--owner") ?? manifest.upgradeAuthority);
  let signer, proof;
  try { signer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(arg("--keypair"), "utf8")))); }
  catch { fail("--keypair is not a readable 64-byte Solana keypair file"); } // never echo file contents
  try { proof = JSON.parse(await readFile(arg("--proof"), "utf8")); } catch { fail("--proof is not a readable JSON file"); }
  try { verifyOwnerProof(proof, owner, program); } catch (e) { fail(e.message); }

  const c = new Connection(arg("--rpc") ?? process.env.MAINNET_RPC_URL ?? "https://api.mainnet-beta.solana.com", "confirmed");
  const genesis = await c.getGenesisHash();
  if (genesis !== MAINNET_GENESIS && !local) fail("RPC is not Mainnet (use --local-validator only for rehearsal)");
  if (genesis === MAINNET_GENESIS && local) fail("--local-validator cannot be used against Mainnet");
  if (!local) {
    if (program.toBase58() !== manifest.distributorProgramId) fail("program differs from config/production.json");
    if (owner.toBase58() !== manifest.upgradeAuthority) fail("owner differs from config/production.json upgradeAuthority");
    if (signer.publicKey.toBase58() !== manifest.deployKey) fail("signer is not config/production.json deployKey");
  }
  if (owner.equals(signer.publicKey)) fail("the deploy key is already the owner; nothing to hand over");

  const [programAccount, programData, config] = await c.getMultipleAccountsInfo([program, programDataAddress(program), distributorConfigAddress(program)], "confirmed");
  if (!programAccount?.executable) fail("program is not deployed");
  const pd = decodeProgramData(programData?.data);
  if (!pd.upgradeAuthority?.equals(signer.publicKey)) fail(`signer is not the on-chain upgrade authority (${pd.upgradeAuthority?.toBase58() ?? "immutable"})`);
  if (!local) { const bytes = reviewedBytesError(manifest, pd.bytes); if (bytes) fail(bytes); }
  if (config) fail("config is already initialized; the owner must have initialized it, so nothing should be handed over");

  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 10_000 }), setUpgradeAuthorityInstruction(program, signer.publicKey, owner));
  tx.feePayer = signer.publicKey;
  const latest = await c.getLatestBlockhash("confirmed");
  tx.recentBlockhash = latest.blockhash;
  tx.sign(signer);
  const sim = await c.simulateTransaction(tx);
  console.log(JSON.stringify({ program: program.toBase58(), currentAuthority: signer.publicKey.toBase58(), newAuthority: owner.toBase58(), ownerProof: "valid", simulation: sim.value.err ?? "ok" }, null, 2));
  if (sim.value.err) fail(`simulation failed: ${(sim.value.logs ?? []).join(" | ")}`);
  if (!send) { console.log("Dry run only. Re-run with --send to submit."); return; }
  const signature = await c.sendRawTransaction(tx.serialize(), { preflightCommitment: "confirmed" });
  console.log(`Submitted ${signature}; do not resend. Confirming...`);
  const result = await c.confirmTransaction({ signature, ...latest }, "confirmed");
  if (result.value.err) fail(`transaction failed: ${JSON.stringify(result.value.err)}`);
  const after = decodeProgramData((await c.getAccountInfo(programDataAddress(program), "confirmed"))?.data);
  if (!after.upgradeAuthority?.equals(owner)) fail(`sent ${signature} but ProgramData does not show the owner`);
  console.log(JSON.stringify({ handedOver: true, signature, upgradeAuthority: owner.toBase58() }));
}
main().catch((e) => { console.error(e instanceof Blocked ? `BLOCKED: ${e.message}` : e); process.exitCode = 1; });
