// One-time distributor initialization. Shared by scripts/initialize-distributor.mjs and tests.
import { createHash } from "node:crypto";
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";

export const UPGRADEABLE_LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

export function programDataAddress(program) {
  return PublicKey.findProgramAddressSync([program.toBuffer()], UPGRADEABLE_LOADER)[0];
}

export function distributorConfigAddress(program) {
  return PublicKey.findProgramAddressSync([Buffer.from("config")], program)[0];
}

/** Account order matches the Anchor IDL: authority, platform_wallet, config, program, program_data, system_program. */
export function initializeDistributorInstruction(program, authority, platformWallet, snapshotAuthority) {
  const unique = new Set([authority, platformWallet, snapshotAuthority].map((k) => k.toBase58()));
  if (unique.size !== 3) throw Error("Deployer, platform wallet and snapshot authority must be distinct");
  return new TransactionInstruction({
    programId: program,
    keys: [
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: platformWallet, isSigner: false, isWritable: false },
      { pubkey: distributorConfigAddress(program), isSigner: false, isWritable: true },
      { pubkey: program, isSigner: false, isWritable: false },
      { pubkey: programDataAddress(program), isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([
      createHash("sha256").update("global:initialize").digest().subarray(0, 8),
      snapshotAuthority.toBuffer(),
    ]),
  });
}

/** Account order matches the Anchor IDL: authority, config, program, program_data. Upgrade authority signs. */
export function setSnapshotAuthorityInstruction(program, upgradeAuthority, newAuthority) {
  return new TransactionInstruction({
    programId: program,
    keys: [
      { pubkey: upgradeAuthority, isSigner: true, isWritable: false },
      { pubkey: distributorConfigAddress(program), isSigner: false, isWritable: true },
      { pubkey: program, isSigner: false, isWritable: false },
      { pubkey: programDataAddress(program), isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([
      createHash("sha256").update("global:set_snapshot_authority").digest().subarray(0, 8),
      newAuthority.toBuffer(),
    ]),
  });
}

/** ProgramData: u32 tag 3, u64 slot, Option<Pubkey> upgrade authority, then program bytes. */
export function decodeProgramData(data) {
  if (!data || data.length < 45 || data.readUInt32LE(0) !== 3) throw Error("Distributor ProgramData account is missing");
  return { upgradeAuthority: data[12] === 1 ? new PublicKey(data.subarray(13, 45)) : null, bytes: data.subarray(45) };
}

/** Why a post-deploy upgrade-authority change (e.g. to a Squads vault, which is off-curve) may not be recorded, or null. */
export function upgradeAuthorityRecordError(manifest, onChainAuthority, candidate) {
  if (!onChainAuthority) return "program is immutable on-chain; there is no upgrade authority to record";
  if (!onChainAuthority.equals(candidate)) return `on-chain upgrade authority is ${onChainAuthority.toBase58()}, not ${candidate.toBase58()}`;
  const reserved = [manifest.platformFeeWallet, ...(manifest.legacyPlatformFeeWallets ?? []), manifest.deployer, manifest.deployKey, manifest.snapshotAuthority, manifest.distributorProgramId, manifest.hypeMint].filter(Boolean);
  if (reserved.includes(candidate.toBase58())) return "upgrade authority must differ from the fee wallets, deployment payer, snapshot authority, program and HYPE mint";
  return null;
}

/**
 * Upgradeable-loader SetAuthority (tag 4) on ProgramData: only the current authority signs, so a CLI deploy key can
 * hand the program to a Phantom-held owner without the owner co-signing. Callers must first prove the owner can sign
 * (lib/owner-proof.mjs); a wrong address here would leave the program uninitializable.
 */
export function setUpgradeAuthorityInstruction(program, currentAuthority, newAuthority) {
  const data = Buffer.alloc(4);
  data.writeUInt32LE(4);
  return new TransactionInstruction({
    programId: UPGRADEABLE_LOADER,
    keys: [
      { pubkey: programDataAddress(program), isSigner: false, isWritable: true },
      { pubkey: currentAuthority, isSigner: true, isWritable: false },
      { pubkey: newAuthority, isSigner: false, isWritable: false },
    ],
    data,
  });
}

/** Why the deployed program bytes are not the reviewed build in config/production.json, or null. */
export function reviewedBytesError(manifest, bytes) {
  if (!manifest.programSha256) return "config/production.json has no reviewed programSha256";
  const deployed = bytes.subarray(0, manifest.programBytes);
  if (deployed.length !== manifest.programBytes || createHash("sha256").update(deployed).digest("hex") !== manifest.programSha256 || bytes.subarray(manifest.programBytes).some((b) => b !== 0))
    return "on-chain program bytes differ from the reviewed build";
  return null;
}
