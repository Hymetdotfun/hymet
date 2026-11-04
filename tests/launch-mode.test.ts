import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import type { PoolConfig } from "@meteora-ag/dynamic-bonding-curve-sdk";
import production from "../config/production.json";
import { curve, defaults, distributorCurve } from "../lib/config";
import { HYPE_MINT } from "../lib/quote-assets";
import { HOLDER_REWARDS_DISABLED_NOTE, distributorAllowed, launchMode } from "../lib/launch-mode";
import { distributorConfigError, nativeSplitConfigError } from "../lib/platform-fees";
import { distributorAddresses } from "../lib/distributor-engine";

const platform = new PublicKey(production.platformFeeWallet);
const creator = Keypair.generate().publicKey;
const onChain = (overrides: Partial<Record<string, unknown>> = {}) =>
  ({ ...curve({ ...defaults, name: "Native", symbol: "NAT" }, creator), feeClaimer: platform, quoteMint: HYPE_MINT, ...overrides }) as unknown as PoolConfig;

describe("Phase 1 native-split launch mode", () => {
  it("keeps the 20/80 split, leaves financial operations off in the manifest and fails closed to native-split", () => {
    expect(production.launchMode).toBe("distributor");
    expect(production.nativeSplit).toMatchObject({ platformPercent: 20, creatorPercent: 80, holderPercent: 0 });
    expect(production.holderSplits).toBe(true);
    expect(production.mainnetFinancialOperations).toBe(false);
    expect(launchMode({})).toBe("native-split");
    expect(launchMode({ HYMET_LAUNCH_MODE: "anything" })).toBe("native-split");
  });

  it("never enables the distributor in native-split mode, even with verified flags", () => {
    const verified = { HYMET_DISTRIBUTOR_VERIFIED: "true", HYMET_DISTRIBUTOR_APP_VERIFIED: "true" };
    expect(distributorAllowed(verified)).toBe(false);
    expect(distributorAllowed({ ...verified, HYMET_LAUNCH_MODE: "native-split" })).toBe(false);
    expect(distributorAllowed({ HYMET_LAUNCH_MODE: "distributor", HYMET_DISTRIBUTOR_VERIFIED: "true" })).toBe(false);
    expect(distributorAllowed({ ...verified, HYMET_LAUNCH_MODE: "distributor" })).toBe(true);
  });

  it("does not describe holder rewards as automatic", () => {
    expect(HOLDER_REWARDS_DISABLED_NOTE).toMatch(/disabled/);
    expect(HOLDER_REWARDS_DISABLED_NOTE).toMatch(/not automatic/);
  });

  it("the native curve encodes 20% platform / 80% creator for DBC fees and locked DAMM v2 liquidity", () => {
    expect(nativeSplitConfigError(onChain(), platform)).toBeNull();
  });

  it("rejects configs that would break the on-chain split", () => {
    expect(nativeSplitConfigError(onChain({ feeClaimer: creator }), platform)).toMatch("fee claimer");
    expect(nativeSplitConfigError(onChain({ creatorTradingFeePercentage: 100 }), platform)).toMatch("80%");
    expect(nativeSplitConfigError(onChain({ creatorPermanentLockedLiquidityPercentage: 0, creatorLiquidityPercentage: 80 }), platform)).toMatch("permanently locked");
    expect(nativeSplitConfigError(onChain({ quoteMint: Keypair.generate().publicKey }), platform)).toMatch("HYPE");
  });

  it("recognizes only distributor launches bound to the mint's own fee pool", () => {
    const program = new PublicKey(production.distributorProgramId), mint = Keypair.generate().publicKey;
    const cfg = (overrides: Partial<Record<string, unknown>> = {}) =>
      ({ ...distributorCurve({ ...defaults, name: "Split", symbol: "SPL" }, creator), feeClaimer: distributorAddresses(program, mint).feePool, quoteMint: HYPE_MINT, ...overrides }) as unknown as PoolConfig;
    expect(distributorConfigError(cfg(), mint, program)).toBeNull();
    expect(nativeSplitConfigError(cfg(), platform)).toMatch("fee claimer");
    expect(distributorConfigError(cfg(), Keypair.generate().publicKey, program)).toMatch("fee pool");
    expect(distributorConfigError(cfg({ feeClaimer: platform }), mint, program)).toMatch("fee pool");
    expect(distributorConfigError(cfg({ creatorTradingFeePercentage: 80 }), mint, program)).toMatch("creator trading fee");
    expect(distributorConfigError(cfg({ partnerPermanentLockedLiquidityPercentage: 20, creatorPermanentLockedLiquidityPercentage: 80 }), mint, program)).toMatch("locked");
    expect(distributorConfigError(cfg({ quoteMint: Keypair.generate().publicKey }), mint, program)).toMatch("HYPE");
    expect(distributorConfigError(onChain(), mint, program)).not.toBeNull();
  });
});
