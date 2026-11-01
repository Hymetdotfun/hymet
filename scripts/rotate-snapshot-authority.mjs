// Rotate the distributor snapshot authority (the holder payout keeper key). Default is a dry run.
// Usage: node scripts/rotate-snapshot-authority.mjs --keypair <upgrade-authority.json> --new <PUBKEY> [--rpc <url>] [--send]
// Only the on-chain upgrade authority can sign. With a Squads upgrade authority, propose the same
// instruction (lib/distributor-init.mjs setSnapshotAuthorityInstruction) through Squads instead.
// Afterwards update config/production.json snapshotAuthority and HYMET_SNAPSHOT_AUTHORITY, and
// install the new key as HYMET_KEEPER_KEYPAIR; until then the app and keeper fail closed.
import { readFile } from "node:fs/promises";
import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram } from "@solana/web3.js";
import { decodeProgramData, distributorConfigAddress, programDataAddress, setSnapshotAuthorityInstruction } from "../lib/distributor-init.mjs";

class Blocked extends Error {}
async function main() {
  const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
  const fail = (message) => { throw new Blocked(message); };
  const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
  const send = process.argv.includes("--send"), local = process.argv.includes("--local-validator");
  if (!arg("--keypair") || !arg("--new")) fail("--keypair <upgrade authority keypair> and --new <pubkey> are required");
  const manifest = JSON.parse(await readFile(new URL("../config/production.json", import.meta.url), "utf8"));
  const program = new PublicKey(arg("--program") ?? manifest.distributorProgramId);
  let next, signer;
  try { next = new PublicKey(arg("--new")); } catch { fail("--new is not a Solana address"); }
  if (!PublicKey.isOnCurve(next.toBytes())) fail("the new keeper key must be an on-curve keypair address");
  try { signer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(arg("--keypair"), "utf8")))); }
  catch { fail("--keypair is not a readable 64-byte Solana keypair file"); } // never echo file contents
  const c = new Connection(arg("--rpc") ?? process.env.MAINNET_RPC_URL ?? "https://api.mainnet-beta.solana.com", "confirmed");
  const genesis = await c.getGenesisHash();
  if (genesis !== MAINNET_GENESIS && !local) fail("RPC is not Mainnet (use --local-validator only for rehearsal)");
  if (genesis === MAINNET_GENESIS && local) fail("--local-validator cannot be used against Mainnet");
  if (!local && program.toBase58() !== manifest.distributorProgramId) fail("program differs from config/production.json");

  const config = distributorConfigAddress(program);
  const [programData, state] = await c.getMultipleAccountsInfo([programDataAddress(program), config], "confirmed");
  if (!decodeProgramData(programData?.data).upgradeAuthority?.equals(signer.publicKey)) fail("signer is not the program upgrade authority");
  if (!state?.owner.equals(program) || state.data.length !== 105) fail("distributor config is missing");
  const current = new PublicKey(state.data.subarray(72, 104)), platform = new PublicKey(state.data.subarray(40, 72));
  if ([current, platform, signer.publicKey].some((k) => k.equals(next))) fail("the new keeper key must differ from the current keeper, fee wallet and upgrade authority");

  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 30_000 }), setSnapshotAuthorityInstruction(program, signer.publicKey, next));
  tx.feePayer = signer.publicKey;
  const latest = await c.getLatestBlockhash("confirmed");
  tx.recentBlockhash = latest.blockhash;
  tx.sign(signer);
  const sim = await c.simulateTransaction(tx);
  console.log(JSON.stringify({ program: program.toBase58(), config: config.toBase58(), current: current.toBase58(), next: next.toBase58(), simulation: sim.value.err ?? "ok" }, null, 2));
  if (sim.value.err) fail(`simulation failed: ${(sim.value.logs ?? []).join(" | ")}`);
  if (!send) { console.log("Dry run only. Re-run with --send to submit."); return; }
  const signature = await c.sendRawTransaction(tx.serialize(), { preflightCommitment: "confirmed" });
  await c.confirmTransaction({ signature, ...latest }, "confirmed");
  const after = await c.getAccountInfo(config, "confirmed");
  if (!after || !new PublicKey(after.data.subarray(72, 104)).equals(next)) fail(`sent ${signature} but the config does not show the new keeper`);
  console.log(JSON.stringify({ rotated: true, signature, snapshotAuthority: next.toBase58() }));
}
main().catch((e) => { console.error(e instanceof Blocked ? `BLOCKED: ${e.message}` : e); process.exitCode = 1; });
