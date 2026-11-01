// Records the deployment payer and the owner's upgrade authority PUBLIC keys in config/production.json.
// Usage: node scripts/set-deployer.mjs <deployment-payer-public-key> --upgrade-authority <owner-public-key>
// They must be separate wallets: the payer funds the buffer/ProgramData; the owner signs the deploy as
// upgrade authority and signs + pays `initialize`, which the program restricts to the upgrade authority.
// Never pass a keypair file or secret; only a base58 public key is accepted.
import { readFile, writeFile } from "node:fs/promises";
import { PublicKey } from "@solana/web3.js";

const path = new URL("../config/production.json", import.meta.url);
const manifest = JSON.parse(await readFile(path, "utf8"));
const fail = (message) => {
  console.error(`Not updated: ${message}`);
  process.exit(1);
};
// The deployer signs, so it must be a wallet (on-curve); an upgrade authority may be a Squads vault PDA (off-curve).
const parse = (text, label, onCurve = true) => {
  if (!text || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(text)) fail(`${label} must be a base58 public key`);
  const key = new PublicKey(text);
  if (key.toBase58() !== text) fail(`${label} must be a canonical base58 address`);
  if (onCurve && !PublicKey.isOnCurve(key.toBytes())) fail(`${label} must be a wallet (on-curve) address`);
  return text;
};
if (manifest.state !== "prepared-not-deployed") fail(`manifest state is ${manifest.state}; the deployer cannot change after deployment`);
const deployer = parse(process.argv[2], "deployer");
const i = process.argv.indexOf("--upgrade-authority");
if (i < 0) fail("--upgrade-authority <owner public key> is required; the deployment payer is not the owner");
const upgradeAuthority = parse(process.argv[i + 1], "upgrade authority", false);
if (upgradeAuthority === deployer) fail("deployment payer and upgrade authority must be separate wallets");
const others = [manifest.platformFeeWallet, ...(manifest.legacyPlatformFeeWallets ?? []), manifest.snapshotAuthority, manifest.distributorProgramId, manifest.hypeMint];
if (others.includes(deployer) || others.includes(upgradeAuthority))
  fail("deployer/upgrade authority must differ from the fee wallet, snapshot authority, program and HYPE mint");

const previous = manifest.deployer;
Object.assign(manifest, { deployer, upgradeAuthority });
manifest.initialization = { ...manifest.initialization, signerAndPayer: upgradeAuthority };
await writeFile(path, JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify({ previousDeployer: previous, deployer, upgradeAuthority }, null, 2));
console.log(`Set HYMET_DEPLOYER=${deployer} and HYMET_UPGRADE_AUTHORITY=${upgradeAuthority} in the runtime environment.`);
