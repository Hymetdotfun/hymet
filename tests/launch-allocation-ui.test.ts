import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { allocationFromShare } from "../lib/hymet-policy";
import { defaults } from "../lib/config";
import {
  assertPersistedAllocation,
  creatorShareAllowed,
  launchConfirmationPayload,
  parseLaunchAllocationPolicy,
} from "../lib/launch-allocation-ui";
import type { Plan } from "../lib/transactions";

const BASE_POLICY = {
  field: "values.creatorShare",
  format: 'integer string "0".."100" (no leading zeros, decimals or signs)',
  unit: "percent of the creator-controlled 80%; holders receive 100 - creatorShare",
  min: 0,
  max: 100,
  step: 1,
  default: 100,
  platformBps: 2000,
  launchMode: "distributor",
  holderAllocationsEnabled: true,
};

const shares = ["100", "73", "50", "1", "0"] as const;

function planFor(creatorShare: string): Plan {
  const key = new PublicKey("11111111111111111111111111111111");
  return {
    reservationId: "reservation-id",
    distributorProgramId: "program-id",
    network: "mainnet-beta",
    creator: key,
    mint: { publicKey: key },
    config: key,
    pool: key,
    values: { ...defaults, creatorShare },
    uri: "https://metadata.example/token.json",
    artworkUri: "https://metadata.example/token.png",
    steps: [{ signature: "confirmed-signature" }],
    allocation: allocationFromShare(creatorShare),
  } as unknown as Plan;
}

describe("launch allocation UI contract", () => {
  it("uses the server policy limits and keeps holder splits unavailable when the server says so", () => {
    const disabled = parseLaunchAllocationPolicy({
      ...BASE_POLICY,
      min: 100,
      max: 100,
      launchMode: "native-split",
      holderAllocationsEnabled: false,
    });
    expect(disabled).toMatchObject({ min: 100, max: 100, step: 1, default: 100, platformBps: 2000, holderAllocationsEnabled: false });
    expect(creatorShareAllowed("100", disabled)).toBe(true);
    for (const share of ["73", "50", "1", "0"]) expect(creatorShareAllowed(share, disabled)).toBe(false);

    const enabled = parseLaunchAllocationPolicy(BASE_POLICY);
    expect(enabled).toMatchObject({ min: 0, max: 100, step: 1, default: 100, platformBps: 2000, holderAllocationsEnabled: true });
    for (const share of shares) expect(creatorShareAllowed(share, enabled)).toBe(true);
  });

  it.each(shares)("submits the exact canonical values.creatorShare string %s and verifies persisted allocation", (creatorShare) => {
    const plan = planFor(creatorShare);
    const payload = launchConfirmationPayload(plan);
    expect(payload.values.creatorShare).toBe(creatorShare);
    expect(typeof payload.values.creatorShare).toBe("string");
    expect(payload.signatures).toEqual(["confirmed-signature"]);
    expect(() => assertPersistedAllocation(plan.allocation, plan.allocation)).not.toThrow();
    expect(() => assertPersistedAllocation(plan.allocation, allocationFromShare(String((Number(creatorShare) + 1) % 101)))).toThrow(/Persisted launch allocation/);
  });

  it("fails closed if the API changes the fixed platform share or violates the range contract", () => {
    expect(() => parseLaunchAllocationPolicy({ ...BASE_POLICY, platformBps: 1900 })).toThrow("Invalid launch allocation policy");
    expect(() => parseLaunchAllocationPolicy({ ...BASE_POLICY, step: 5 })).toThrow("Invalid launch allocation policy");
    expect(() => parseLaunchAllocationPolicy({ ...BASE_POLICY, min: 100, holderAllocationsEnabled: true })).toThrow("Invalid launch allocation policy");
  });
});
