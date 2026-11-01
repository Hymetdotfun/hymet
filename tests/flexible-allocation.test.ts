import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { allocationFromBps, allocationFromShare, parseCreatorShare } from "../lib/hymet-policy";
import { allocationPolicy } from "../lib/allocation-policy";
import { splitDistributable } from "../lib/fee-distribution";
import { createDistributorPool } from "../lib/distributor-engine";
import { assertSplit } from "../lib/distributor-index.mjs";
import { defaults, validate } from "../lib/config";

// Creator / holder shares of the creator-controlled 80%, as the launch form sends them.
const SPLITS = [
  { share: "100", creator: 100, holders: 0, effective: { hymet: 2000, creator: 8000, holders: 0 } },
  { share: "73", creator: 73, holders: 27, effective: { hymet: 2000, creator: 5840, holders: 2160 } },
  { share: "50", creator: 50, holders: 50, effective: { hymet: 2000, creator: 4000, holders: 4000 } },
  { share: "1", creator: 1, holders: 99, effective: { hymet: 2000, creator: 80, holders: 7920 } },
  { share: "0", creator: 0, holders: 100, effective: { hymet: 2000, creator: 0, holders: 8000 } },
];
// Base-unit amounts that exercise rounding: dust, primes, 9-decimal HYPE amounts and the u64 range.
const AMOUNTS = [0n, 1n, 4n, 5n, 99n, 101n, 9_973n, 1_000_000_007n, 123_456_789_012n, 2n ** 63n, 2n ** 64n - 1n];

describe("flexible creator/holder allocation", () => {
  it("accepts every whole percentage 0..100 and nothing else", () => {
    for (let p = 0; p <= 100; p++) expect(parseCreatorShare(String(p))).toBe(p);
    for (const bad of ["-1", "101", "50.5", "05", "1e1", " 5", "5 ", "", "0x10", 50, null, undefined])
      expect(() => parseCreatorShare(bad)).toThrow(/whole percentage from 0 to 100/);
  });

  it.each(SPLITS)("$creator/$holders maps to exact basis points of the 80% and of all fees", ({ share, creator, holders, effective }) => {
    const a = allocationFromShare(share);
    expect(a).toEqual({ creatorPercent: creator, holderPercent: holders, creatorBpsOfRemaining: creator * 100, holderBpsOfRemaining: holders * 100, effectiveBps: effective });
    expect(a.effectiveBps.hymet + a.effectiveBps.creator + a.effectiveBps.holders).toBe(10_000);
    expect(() => validate({ ...defaults, name: "Split", symbol: "SPL", creatorShare: share })).not.toThrow();
  });

  it("matches the spec example: 70/30 is 56% creator, 24% holders, 20% HYMET", () => {
    expect(allocationFromShare("70").effectiveBps).toEqual({ hymet: 2000, creator: 5600, holders: 2400 });
  });

  it.each(SPLITS)("$creator/$holders splits fees with no rounding overdistribution", ({ creator }) => {
    const bps = creator * 100;
    for (const amount of AMOUNTS) {
      const d = splitDistributable(amount, bps);
      // Platform first and exact; creator rounded down; holders take the rest; every base unit accounted for.
      expect(d.hymet).toBe((amount * 2000n) / 10000n);
      expect(d.creator).toBe((d.remainder * BigInt(bps)) / 10000n);
      expect(d.hymet + d.creator + d.holders).toBe(amount);
      expect(d.creator * 10000n).toBeLessThanOrEqual(d.remainder * BigInt(bps));
      expect(d.holders * 10000n - d.remainder * BigInt(10000 - bps)).toBeLessThan(10000n); // holders' rounding gain < 1 unit
      if (bps === 0) expect(d.creator).toBe(0n);
      if (bps === 10000) expect(d.holders).toBe(0n);
      // The indexer accepts exactly this split for the stored allocation, from DBC (0) or DAMM v2 (1) settlement.
      for (const source of [0, 1]) expect(() => assertSplit({ source, distributable: amount, hymet: d.hymet, creator: d.creator, holders: d.holders }, bps)).not.toThrow();
    }
  });

  it("rejects indexed fee events that do not follow the stored allocation", () => {
    const d = splitDistributable(1_000_000_000n, 5000);
    expect(() => assertSplit({ source: 0, distributable: d.distributable, hymet: d.hymet, creator: d.creator, holders: d.holders }, 7300)).toThrow(/invariants/);
    const shifted = { source: 1, distributable: d.distributable, hymet: d.hymet, creator: d.creator + 1n, holders: d.holders - 1n };
    expect(() => assertSplit(shifted, 5000)).toThrow(/invariants/);
  });

  it.each(SPLITS)("binds $creator/$holders into the fee pool created atomically with the launch", ({ creator }) => {
    const ix = createDistributorPool(Keypair.generate().publicKey, Keypair.generate().publicKey, Keypair.generate().publicKey, Keypair.generate().publicKey, creator * 100);
    expect(ix.data.readUInt16LE(8)).toBe(creator * 100);
    expect(ix.data.length).toBe(10);
  });

  it("round-trips persisted records, including legacy 100/0 native-split launches", () => {
    for (const { creator } of SPLITS) expect(allocationFromBps(creator * 100, 10000 - creator * 100).creatorPercent).toBe(creator);
    expect(allocationFromBps(10000, 0)).toMatchObject({ creatorPercent: 100, holderPercent: 0, effectiveBps: { creator: 8000, holders: 0 } });
    for (const [c, h] of [[7300, 2600], [-1, 10001], [10001, -1], [50.5, 9949.5]]) expect(() => allocationFromBps(c, h)).toThrow();
  });

  it("offers holder splits only when the distributor and payout keeper are verified", () => {
    expect(allocationPolicy({})).toMatchObject({ min: 100, max: 100, step: 1, default: 100, holderAllocationsEnabled: false, launchMode: "native-split", platformBps: 2000 });
    expect(allocationPolicy({ HYMET_LAUNCH_MODE: "distributor", HYMET_DISTRIBUTOR_VERIFIED: "true", HYMET_DISTRIBUTOR_APP_VERIFIED: "true" })).toMatchObject({ min: 100, holderAllocationsEnabled: false });
    expect(allocationPolicy({ HYMET_LAUNCH_MODE: "distributor", HYMET_DISTRIBUTOR_VERIFIED: "true", HYMET_DISTRIBUTOR_APP_VERIFIED: "true", HYMET_HOLDER_PAYOUTS_VERIFIED: "true" })).toMatchObject({ min: 0, max: 100, step: 1, holderAllocationsEnabled: true });
  });

  it("keeps the u16 range of the on-chain field", () => {
    expect(() => createDistributorPool(PublicKey.default, PublicKey.default, PublicKey.default, PublicKey.default, 10001)).toThrow();
  });
});
