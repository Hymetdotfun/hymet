import { CREATOR_ALLOCATION_DEFAULT, CREATOR_ALLOCATION_STEP, HYMET_PLATFORM_SHARE_BPS } from "./hymet-policy";
import { holderPayoutsLive, launchMode } from "./launch-mode";
import { testNetworkRequested } from "./app-network";
import { verifiedDistributor } from "./distributor-readiness";

/**
 * What the launch form may offer. Holder splits are offered only when the distributor and the payout keeper are
 * owner-verified (holderPayoutsLive); otherwise only 100% creator is accepted, as buildPlan and /api/launch/confirm enforce.
 */
export function allocationPolicy(env: Record<string, string | undefined> = process.env, distributorOnChain = true) {
  const holderAllocationsEnabled = holderPayoutsLive(env) && distributorOnChain;
  return {
    field: "values.creatorShare",
    format: "integer string \"0\"..\"100\" (no leading zeros, decimals or signs)",
    unit: "percent of the creator-controlled 80%; holders receive 100 - creatorShare",
    min: holderAllocationsEnabled ? 0 : CREATOR_ALLOCATION_DEFAULT,
    max: 100,
    step: CREATOR_ALLOCATION_STEP,
    default: CREATOR_ALLOCATION_DEFAULT,
    platformBps: HYMET_PLATFORM_SHARE_BPS,
    launchMode: launchMode(env),
    holderAllocationsEnabled,
  };
}

/**
 * Policy served by /api/launch/allocation. On the local test network the owner flags are not enough: holder splits are
 * offered only while the loopback validator shows the distributor initialized with the configured recipient and
 * authorities (verifiedDistributor). Mainnet keeps the flag-only policy above unchanged.
 */
export async function servedAllocationPolicy() {
  if (!testNetworkRequested()) return allocationPolicy();
  return allocationPolicy(process.env, holderPayoutsLive() && (await verifiedDistributor()) !== null);
}
