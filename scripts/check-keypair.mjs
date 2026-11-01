// Verifies a keypair file (e.g. a deployer backup copy) and prints ONLY its public key.
// Usage: node scripts/check-keypair.mjs <keypair.json>   — never logs file contents.
import { readFile } from "node:fs/promises";
import { Keypair } from "@solana/web3.js";

const path = process.argv[2];
if (!path) {
  console.error("Usage: node scripts/check-keypair.mjs <keypair.json>");
  process.exit(1);
}
let key;
try {
  const bytes = JSON.parse(await readFile(path, "utf8"));
  if (!Array.isArray(bytes) || bytes.length !== 64) throw Error();
  key = Keypair.fromSecretKey(Uint8Array.from(bytes)).publicKey.toBase58();
} catch {
  console.error("Not a valid 64-byte Solana keypair file");
  process.exit(1);
}
const manifest = JSON.parse(await readFile(new URL("../config/production.json", import.meta.url), "utf8"));
console.log(key);
const roles = [["deployKey", "temporary deploy key"], ["deployer", "deployment payer"], ["upgradeAuthority", "owner upgrade authority"], ["platformFeeWallet", "platform fee recipient"], ["snapshotAuthority", "keeper snapshot authority"]]
  .filter(([field]) => manifest[field] === key).map(([, label]) => label);
console.log(roles.length ? `Matches config/production.json: ${roles.join(", ")}` : "Does NOT match any configured HYMET identity");
