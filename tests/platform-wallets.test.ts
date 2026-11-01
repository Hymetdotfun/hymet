import { createPrivateKey, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import type { PoolConfig } from "@meteora-ag/dynamic-bonding-curve-sdk";
import production from "../config/production.json";
import { curve, defaults } from "../lib/config";
import { HYPE_MINT } from "../lib/quote-assets";
import { FEE_CLAIMER_MISMATCH, nativeSplitConfigError } from "../lib/platform-fees";
import { LEGACY_PLATFORM_FEE_RECIPIENTS, acceptedPlatformFeeRecipients, platformFeeGeneration } from "../lib/platform-wallets";
import { platformFeeAuthorizationMessage } from "../lib/platform-fee-auth";
import { verifyPlatformFeeAuthorization } from "../lib/platform-fee-auth-server";
import { assertFeeRecipients } from "../lib/transactions";

// Owner-assigned identities (2026-10-31). Public addresses only.
const PLATFORM = "7sAoyG3ZdewKrZKLzU8VTpfzNh6YuJKQAgnWjgjSqPEs";
const PAYER = "GHydbkZNJk6STZuA9WWL5Xy5ohHbMmnraxTwQNt4RL9K";
const OWNER = "9G9v3Ax4K2prmVQfDzp2HY6YYZ5UFmCo24761pgEmMo7";
const LEGACY = "719pLtfhA7BinfgqEgtpfzxL6FcMChQxHYLiwJ6BSvGK";
const KEEPER = "GHZHuBqZvmixBDHsApwEJeW3dCgR1p39UPNszHeuoL8S";
const DEPLOY_KEY = "2LWe6h2qEqj2BKD3T8hNdqPmsPaZcBvFgArfzGW4Ethe";

const current = new PublicKey(PLATFORM), legacy = new PublicKey(LEGACY);
const creator = Keypair.generate().publicKey;
const onChain = (feeClaimer: PublicKey) =>
  ({ ...curve({ ...defaults, name: "Native", symbol: "NAT" }, creator), feeClaimer, quoteMint: HYPE_MINT }) as unknown as PoolConfig;

describe("production wallet identities", () => {
  it("records the owner-assigned roles and preserves the program and keeper", () => {
    expect(production).toMatchObject({
      platformFeeWallet: PLATFORM,
      deployer: PAYER,
      deployKey: DEPLOY_KEY,
      upgradeAuthority: OWNER,
      snapshotAuthority: KEEPER,
      distributorProgramId: "9X9fnj4Uh9WC9nmxCahTVsixHZ6VGxNpMesuGhK239Px",
      initialization: { signerAndPayer: OWNER, platformWallet: PLATFORM, snapshotAuthority: KEEPER },
    });
    expect(production.nativeSplit).toMatchObject({ platformPercent: 20, creatorPercent: 80, holderPercent: 0 });
  });

  it("keeps every role a separate, canonical wallet address", () => {
    const roles = [PLATFORM, LEGACY, PAYER, OWNER, KEEPER, DEPLOY_KEY];
    expect(new Set(roles).size).toBe(roles.length);
    for (const key of roles) {
      expect(new PublicKey(key).toBase58()).toBe(key);
      expect(PublicKey.isOnCurve(new PublicKey(key).toBytes())).toBe(true);
    }
  });

  it("lists the same legacy feeClaimers in the manifest and the app", () => {
    expect(production.legacyPlatformFeeWallets).toEqual([...LEGACY_PLATFORM_FEE_RECIPIENTS]);
    expect(LEGACY_PLATFORM_FEE_RECIPIENTS).toEqual([LEGACY]);
  });
});

describe("legacy and current platform fee wallets", () => {
  it("classifies feeClaimers by generation", () => {
    expect(platformFeeGeneration(current, current)).toBe("current");
    expect(platformFeeGeneration(LEGACY, PLATFORM)).toBe("legacy");
    expect(platformFeeGeneration(PAYER, PLATFORM)).toBeNull();
    expect(acceptedPlatformFeeRecipients(current).map(String)).toEqual([PLATFORM, LEGACY]);
  });

  it("keeps legacy pools tradable but rejects other feeClaimers", () => {
    const accepted = acceptedPlatformFeeRecipients(current);
    expect(nativeSplitConfigError(onChain(legacy), accepted)).toBeNull();
    expect(nativeSplitConfigError(onChain(current), accepted)).toBeNull();
    expect(nativeSplitConfigError(onChain(new PublicKey(PAYER)), accepted)).toBe(FEE_CLAIMER_MISMATCH);
    // A single wallet stays strict: a platform claim only reads pools whose feeClaimer is the signer.
    expect(nativeSplitConfigError(onChain(legacy), current)).toBe(FEE_CLAIMER_MISMATCH);
  });

  it("routes new launches to the current wallet and leftovers to the launching creator", () => {
    expect(() => assertFeeRecipients(current, creator, current, creator)).not.toThrow();
    // Reusing a legacy config for a new launch would pay the old wallet.
    expect(() => assertFeeRecipients(current, creator, legacy, creator)).toThrow("HYMET_PLATFORM_FEE_RECIPIENT");
    // The dev payer never replaces an independent creator as leftover receiver.
    expect(() => assertFeeRecipients(current, creator, current, new PublicKey(PAYER))).toThrow("creator wallet");
  });

  it("authorizes platform claims from the current or legacy wallet only", () => {
    const now = 1_800_000_000_000, origin = "https://hymet.example";
    const signed = (wallet: Keypair) => {
      const request = { wallet: wallet.publicKey.toBase58(), action: "inspect" as const, issuedAt: new Date(now).toISOString(), nonce: "fdb52d99-8b80-44cc-844c-76b27dc2ef2d" };
      const key = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(wallet.secretKey.subarray(0, 32))]), format: "der", type: "pkcs8" });
      return { ...request, signature: sign(null, Buffer.from(platformFeeAuthorizationMessage(request, origin)), key).toString("base64") };
    };
    const now_ = Keypair.generate(), old = Keypair.generate(), other = Keypair.generate();
    const accepted = [now_.publicKey, old.publicKey];
    expect(verifyPlatformFeeAuthorization(signed(now_), origin, accepted, now).equals(now_.publicKey)).toBe(true);
    expect(verifyPlatformFeeAuthorization(signed(old), origin, accepted, now).equals(old.publicKey)).toBe(true);
    expect(() => verifyPlatformFeeAuthorization(signed(other), origin, accepted, now)).toThrow("Unauthorized platform wallet");
  });
});
