import type { Plan } from "./transactions";
import { parseCreatorShare, type Allocation } from "./hymet-policy";

export type LaunchAllocationPolicy = {
  field: "values.creatorShare";
  format: string;
  unit: string;
  min: number;
  max: number;
  step: number;
  default: number;
  platformBps: number;
  launchMode: string;
  holderAllocationsEnabled: boolean;
};

const FORMAT = 'integer string "0".."100" (no leading zeros, decimals or signs)';
const UNIT = "percent of the creator-controlled 80%; holders receive 100 - creatorShare";

export function parseLaunchAllocationPolicy(input: unknown): LaunchAllocationPolicy {
  if (!input || typeof input !== "object") throw new Error("Invalid launch allocation policy");
  const value = input as Partial<LaunchAllocationPolicy>;
  const wholePercent = (n: unknown): n is number => Number.isInteger(n) && typeof n === "number";
  if (
    value.field !== "values.creatorShare" ||
    value.format !== FORMAT ||
    value.unit !== UNIT ||
    !wholePercent(value.min) ||
    !wholePercent(value.max) ||
    !wholePercent(value.step) ||
    !wholePercent(value.default) ||
    value.min < 0 ||
    value.max > 100 ||
    value.min > value.max ||
    value.step !== 1 ||
    value.default < value.min ||
    value.default > value.max ||
    value.platformBps !== 2000 ||
    typeof value.launchMode !== "string" ||
    typeof value.holderAllocationsEnabled !== "boolean" ||
    (value.holderAllocationsEnabled && value.min !== 0) ||
    (!value.holderAllocationsEnabled && (value.min !== 100 || value.max !== 100 || value.default !== 100))
  ) {
    throw new Error("Invalid launch allocation policy");
  }
  return value as LaunchAllocationPolicy;
}

/** Whether holders can be given a share: the program is built in, the distributor checked out, and the server allows splits. */
export function holderSplitsAvailable(program: string, distributorVerified: boolean, policy: LaunchAllocationPolicy | undefined) {
  return Boolean(program) && distributorVerified && policy?.holderAllocationsEnabled === true;
}

export function creatorShareAllowed(value: string, policy: LaunchAllocationPolicy): boolean {
  try {
    const creator = parseCreatorShare(value);
    return creator >= policy.min && creator <= policy.max && (creator - policy.min) % policy.step === 0;
  } catch {
    return false;
  }
}

export function launchConfirmationPayload(plan: Plan) {
  return {
    reservationId: plan.reservationId,
    distributorProgramId: plan.distributorProgramId,
    network: plan.network,
    creator: plan.creator.toBase58(),
    mint: plan.mint.publicKey.toBase58(),
    config: plan.config.toBase58(),
    pool: plan.pool.toBase58(),
    values: plan.values,
    uri: plan.uri,
    artworkUri: plan.artworkUri,
    signatures: plan.steps.map((step) => step.signature),
  };
}

export function assertPersistedAllocation(expected: Allocation, value: unknown): void {
  if (!value || typeof value !== "object") throw new Error("Launch registration did not return its persisted allocation");
  const actual = value as Partial<Allocation>;
  if (
    actual.creatorPercent !== expected.creatorPercent ||
    actual.holderPercent !== expected.holderPercent ||
    actual.creatorBpsOfRemaining !== expected.creatorBpsOfRemaining ||
    actual.holderBpsOfRemaining !== expected.holderBpsOfRemaining ||
    actual.effectiveBps?.hymet !== expected.effectiveBps.hymet ||
    actual.effectiveBps?.creator !== expected.effectiveBps.creator ||
    actual.effectiveBps?.holders !== expected.effectiveBps.holders
  ) {
    throw new Error("Persisted launch allocation does not match the confirmed transaction");
  }
}
