import { PublicKey } from "@solana/web3.js";

/**
 * DBC feeClaimers of native-split launches made before the 2026-10-31 platform wallet change
 * (HYTEST, DOGE, HYPAD). A DBC config's feeClaimer is immutable, so these launches keep paying
 * the 20% platform share to this wallet; it stays accepted for their swaps and platform claims.
 * New launches always use HYMET_PLATFORM_FEE_RECIPIENT. Must equal
 * config/production.json legacyPlatformFeeWallets (enforced by tests and check-production).
 */
export const LEGACY_PLATFORM_FEE_RECIPIENTS: readonly string[] = Object.freeze([
  "719pLtfhA7BinfgqEgtpfzxL6FcMChQxHYLiwJ6BSvGK",
]);

export type PlatformFeeGeneration = "current" | "legacy";

/** Current recipient first, then the legacy feeClaimers that existing pools still pay. */
export function acceptedPlatformFeeRecipients(current: PublicKey): PublicKey[] {
  return [current, ...LEGACY_PLATFORM_FEE_RECIPIENTS.filter((k) => k !== current.toBase58()).map((k) => new PublicKey(k))];
}

/** Which platform wallet generation a DBC feeClaimer belongs to, or null if it is not a HYMET platform wallet. */
export function platformFeeGeneration(feeClaimer: PublicKey | string, current: PublicKey | string): PlatformFeeGeneration | null {
  const claimer = feeClaimer.toString();
  if (claimer === current.toString()) return "current";
  return LEGACY_PLATFORM_FEE_RECIPIENTS.includes(claimer) ? "legacy" : null;
}
