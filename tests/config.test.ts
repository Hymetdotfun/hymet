import { describe, it, expect } from "vitest";
import { Keypair, Transaction, SystemProgram } from "@solana/web3.js";
import { defaults, units, bps, validate, curve, distributorCurve, friendly } from "../lib/config";
import { assertSigners, sol } from "../lib/transactions";
describe("exact user amounts", () => {
  it("converts token supply above JS integer precision exactly", () =>
    expect(units("1000000000", 9)).toBe(1000000000000000000n));
  it("converts SOL fractional lamports without float math", () =>
    expect(units("0.000000001", 9)).toBe(1n));
  it("rejects precision loss, negative, exponent, and u64 overflow", () => {
    for (const s of ["1.0000000001", "-1", "1e9", "18446744074"])
      expect(() => units(s, 9)).toThrow();
  });
  it("converts percentages to basis points", () => {
    expect(bps("0.25")).toBe(25);
    expect(bps("99.99")).toBe(9999);
    expect(() => bps("0.001")).toThrow();
    expect(() => bps("101")).toThrow();
  });
});
const valid = { ...defaults, name: "Trajectory", symbol: "TRJ" };
describe("form and curve validation", () => {
  it("accepts a valid form", () => expect(() => validate(valid)).not.toThrow());
  it("rejects invalid fields and threshold ordering", () => {
    for (const patch of [
      { name: "" },
      { symbol: "bad symbol" },
      { decimals: "5" },
      { creatorShare: "1.5" },
      { quote: "sol" as const },
      { supply: "100000000" },
      { website: "http://example.com" },
      { fee: "0.24" },
      { slippage: "0" },
    ])
      expect(() => validate({ ...valid, ...patch })).toThrow();
  });
  it("builds actual SDK 2.0 curve with immutable SPL and exact supply", () => {
    const c = curve(valid, Keypair.generate().publicKey);
    expect(c.tokenType).toBe(0);
    expect(c.tokenUpdateAuthority).toBe(1);
    expect(c.migrationOption).toBe(1);
    expect(c.tokenSupply?.preMigrationTokenSupply.toString()).toBe(
      "1000000000000000000",
    );
    expect(c.migrationQuoteThreshold.gtn(0)).toBe(true);
    expect(c.migrationQuoteThreshold.toString()).not.toBe(
      units(valid.migrationCap, 9).toString(),
    );
    expect(c.creatorPermanentLockedLiquidityPercentage).toBe(80);
    expect(c.partnerPermanentLockedLiquidityPercentage).toBe(20);
  });
  it("builds the DBC/DAMM fee-recipient config required by the distributor", () => {
    const c = distributorCurve(valid, Keypair.generate().publicKey);
    expect(c.collectFeeMode).toBe(0);
    expect(c.creatorTradingFeePercentage).toBe(0);
    expect(c.partnerLiquidityPercentage).toBe(0);
    expect(c.partnerPermanentLockedLiquidityPercentage).toBe(100);
    expect(c.creatorLiquidityPercentage).toBe(0);
    expect(c.creatorPermanentLockedLiquidityPercentage).toBe(0);
  });
  it("maps actionable failures", () => {
    expect(friendly(Error("User rejected"))).toContain("rejected");
    expect(friendly(Error("blockhash expired"))).toContain("Check transaction");
    expect(friendly(Error("429 timeout"))).toContain("recovery");
  });
  it("formats SOL exactly", () => expect(sol(1000000001n)).toBe("1.000000001"));
});
describe("signer validation", () => {
  it("requires all local account signers", () => {
    const payer = Keypair.generate(),
      mint = Keypair.generate();
    const tx = new Transaction({
      feePayer: payer.publicKey,
      recentBlockhash: Keypair.generate().publicKey.toBase58(),
    }).add(
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: mint.publicKey,
        lamports: 1,
        space: 82,
        programId: SystemProgram.programId,
      }),
    );
    expect(() => assertSigners(tx, payer.publicKey, [])).toThrow(
      "Missing local signer",
    );
    expect(() => assertSigners(tx, payer.publicKey, [mint])).not.toThrow();
    tx.partialSign(mint);
    const signature = Buffer.from(
      tx.signatures.find((s) => s.publicKey.equals(mint.publicKey))!.signature!,
    );
    tx.partialSign(payer);
    expect(tx.verifySignatures()).toBe(true);
    expect(
      Buffer.from(
        tx.signatures.find((s) => s.publicKey.equals(mint.publicKey))!
          .signature!,
      ).equals(signature),
    ).toBe(true);
  });
});

it("rejects inputs the DBC config would silently ignore", () => {
  const base = { ...defaults, name: "Fixed", symbol: "FIX" };
  expect(() => validate(base)).not.toThrow();
  for (const change of [
    { initialCap: "60" },
    { migrationCap: "900" },
    { migrationFee: "1" },
    { migrationCreatorShare: "60" },
    { postFee: "2" },
  ])
    expect(() => validate({ ...base, ...change })).toThrow();
  expect(() => validate({ ...base, fee: "2", postFee: "2" })).not.toThrow();
});
