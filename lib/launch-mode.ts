/**
 * HYMET launch modes.
 * - "native-split" (Phase 1, default): Meteora DBC/DAMM v2 enforce 20% HYMET / 80% creator on-chain.
 *   No custom program; holder rewards are disabled and must never be presented as automatic.
 * - "distributor": the HYMET distributor program custodies fees and pays creator + holder shares.
 *   Usable only after its owner-verified deployment (HYMET_DISTRIBUTOR_VERIFIED / _APP_VERIFIED).
 * Server-only: an unset or unknown value fails closed to "native-split".
 */
export type LaunchMode = "native-split" | "distributor";

export function launchMode(env: Record<string, string | undefined> = process.env): LaunchMode {
  return env.HYMET_LAUNCH_MODE === "distributor" ? "distributor" : "native-split";
}

export function distributorAllowed(env: Record<string, string | undefined> = process.env) {
  return (
    launchMode(env) === "distributor" &&
    env.HYMET_DISTRIBUTOR_VERIFIED === "true" &&
    env.HYMET_DISTRIBUTOR_APP_VERIFIED === "true"
  );
}

/**
 * Holder rewards are "automatic" only when the distributor is live AND the payout keeper
 * (snapshot authority + scheduled settle/fund/distribute/close) has been owner-verified.
 */
export function holderPayoutsLive(env: Record<string, string | undefined> = process.env) {
  return distributorAllowed(env) && env.HYMET_HOLDER_PAYOUTS_VERIFIED === "true";
}

export const NATIVE_SPLIT = { platformPercent: 20, creatorPercent: 80, holderPercent: 0 } as const;

/** Wording the API returns in native-split mode; holder rewards are neither enforced nor automatic. */
export const HOLDER_REWARDS_DISABLED_NOTE =
  "Holder rewards are disabled in this launch mode. Meteora enforces the fee split on-chain: 20% HYMET, 80% creator. " +
  "Any payment to holders is at the creator's discretion and is not automatic or guaranteed.";

export const HOLDER_REWARDS_PENDING_NOTE =
  "Holder reward fees are held in the distributor's on-chain holder pool. Automatic payouts are not active yet; nothing is paid until the payout keeper is verified.";

const HOLDER_REWARDS_MECHANISM =
  "the payout keeper pays HYPE about every 24 hours from on-chain balance snapshots. No staking or claiming. Amounts below the payout minimum carry over to a later payout.";

/** Configured by the owner; says nothing about a payout having happened. */
export const HOLDER_REWARDS_CONFIGURED_NOTE =
  `Holder rewards are configured and enabled: ${HOLDER_REWARDS_MECHANISM} No Mainnet holder payout has been verified yet.`;

/** Only with a recorded, confirmed Mainnet payout (lib/holder-payout-status.ts). */
export const HOLDER_REWARDS_VERIFIED_NOTE =
  `Holder rewards are enabled and verified by confirmed Mainnet payouts: ${HOLDER_REWARDS_MECHANISM}`;
