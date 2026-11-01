import type { PublicKey, TransactionInstruction } from "@solana/web3.js";
export const UPGRADEABLE_LOADER: PublicKey;
export function programDataAddress(program: PublicKey): PublicKey;
export function distributorConfigAddress(program: PublicKey): PublicKey;
export function initializeDistributorInstruction(
  program: PublicKey,
  authority: PublicKey,
  platformWallet: PublicKey,
  snapshotAuthority: PublicKey,
): TransactionInstruction;
export function setSnapshotAuthorityInstruction(
  program: PublicKey,
  upgradeAuthority: PublicKey,
  newAuthority: PublicKey,
): TransactionInstruction;
export function decodeProgramData(data: Buffer | null | undefined): {
  upgradeAuthority: PublicKey | null;
  bytes: Buffer;
};
export function upgradeAuthorityRecordError(
  manifest: { platformFeeWallet: string; snapshotAuthority: string; distributorProgramId: string; hypeMint: string },
  onChainAuthority: PublicKey | null,
  candidate: PublicKey,
): string | null;
export function setUpgradeAuthorityInstruction(
  program: PublicKey,
  currentAuthority: PublicKey,
  newAuthority: PublicKey,
): TransactionInstruction;
export function reviewedBytesError(manifest: { programSha256?: string; programBytes: number }, bytes: Buffer): string | null;
