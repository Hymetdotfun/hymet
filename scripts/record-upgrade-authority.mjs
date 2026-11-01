// Records a post-deployment upgrade-authority change (e.g. to a Squads vault) in config/production.json.
// Usage: node scripts/record-upgrade-authority.mjs <new-upgrade-authority> [--rpc <url>]
// Read-only on-chain: run it AFTER `solana program set-upgrade-authority` confirms. It writes the manifest
// only when Mainnet ProgramData already names that authority, so the record can never run ahead of the chain.
import { readFile, writeFile } from "node:fs/promises";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  decodeProgramData,
  programDataAddress,
  upgradeAuthorityRecordError,
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

  const path = new URL("../config/production.json", import.meta.url);
  const manifest = JSON.parse(await readFile(path, "utf8"));
  const text = process.argv[2];
  if (
    !text ||
    !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(text) ||
    new PublicKey(text).toBase58() !== text
  )
    fail("new upgrade authority must be a base58 public key");
  const candidate = new PublicKey(text);

  const c = new Connection(
    arg("--rpc") ??
      process.env.MAINNET_RPC_URL ??
      "https://api.mainnet-beta.solana.com",
    "confirmed",
  );
  if ((await c.getGenesisHash()) !== MAINNET_GENESIS)
    fail("RPC is not Mainnet");
  const program = new PublicKey(manifest.distributorProgramId);
  let onChain;
  try {
    onChain = decodeProgramData(
      (await c.getAccountInfo(programDataAddress(program), "confirmed"))?.data,
    ).upgradeAuthority;
  } catch {
    fail("distributor is not deployed");
  }
  const error = upgradeAuthorityRecordError(manifest, onChain, candidate);
  if (error) fail(error);

  const previous = manifest.upgradeAuthority;
  manifest.upgradeAuthority = candidate.toBase58();
  await writeFile(path, JSON.stringify(manifest, null, 2) + "\n");
  console.log(
    JSON.stringify(
      {
        previousUpgradeAuthority: previous,
        upgradeAuthority: manifest.upgradeAuthority,
      },
      null,
      2,
    ),
  );
  console.log(
    `Set HYMET_UPGRADE_AUTHORITY=${manifest.upgradeAuthority} in the runtime environment (HYMET_DEPLOYER stays ${manifest.deployer}).`,
  );
}
main().catch((e) => {
  console.error(e instanceof Blocked ? `Not recorded: ${e.message}` : e);
  process.exitCode = 1;
});
