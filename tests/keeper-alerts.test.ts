import { describe, expect, it } from "vitest";
import { keeperAlerts } from "../lib/keeper-alerts.mjs";

type Input = {
  now: number;
  slot: bigint;
  keeperLamports: bigint;
  status: { at: string; ok: boolean; errors?: unknown[] } | null;
  pools: { mint: string; nextEpoch: bigint; openEpoch: { number: bigint; snapshotSlot: bigint } | null }[];
  indexedEpochs: Map<string, Set<string>>;
};
const now = Date.parse("2026-11-03T12:00:00Z");
const healthy: Input = {
  now,
  slot: 1_000_000n,
  keeperLamports: 200_000_000n,
  status: { at: "2026-11-03T11:55:00Z", ok: true, errors: [] },
  pools: [{ mint: "MINT", nextEpoch: 2n, openEpoch: null }],
  indexedEpochs: new Map([["MINT", new Set(["0", "1"])]]),
};
const codes = (input: Partial<Input>) => keeperAlerts({ ...healthy, ...input }).map((a) => a.code);

describe("keeper alerts", () => {
  it("stay quiet for a funded, recent, fully indexed keeper", () => {
    expect(codes({})).toEqual([]);
  });

  it("flag low SOL, a missing, stale or failed run", () => {
    expect(codes({ keeperLamports: 49_999_999n })).toEqual(["keeper-sol-low"]);
    expect(codes({ status: null })).toEqual(["keeper-no-status"]);
    expect(codes({ status: { at: "2026-11-03T11:00:00Z", ok: true, errors: [] } })).toEqual(["keeper-stale"]);
    expect(codes({ status: { at: "2026-11-03T11:59:00Z", ok: false, errors: [{ mint: "MINT", error: "429" }] } })).toEqual(["keeper-failed"]);
  });

  it("flag an epoch open for more than 48 hours", () => {
    const pools = [{ mint: "MINT", nextEpoch: 2n, openEpoch: { number: 1n, snapshotSlot: 1_000_000n - 432_001n } }];
    expect(codes({ pools })).toEqual(["epoch-open-too-long"]);
  });

  it("flag a funded epoch whose root the keeper never prepared, after a short indexing grace", () => {
    const rogue = { indexedEpochs: new Map([["MINT", new Set(["0"])]]) };
    expect(codes({ ...rogue, pools: [{ mint: "MINT", nextEpoch: 2n, openEpoch: null }] })).toEqual(["unexpected-epoch"]);
    expect(codes({ ...rogue, pools: [{ mint: "MINT", nextEpoch: 2n, openEpoch: { number: 1n, snapshotSlot: 999_000n } }] })).toEqual([]);
    expect(codes({ ...rogue, pools: [{ mint: "MINT", nextEpoch: 2n, openEpoch: { number: 1n, snapshotSlot: 990_000n } }] })).toEqual(["unexpected-epoch"]);
  });
});
