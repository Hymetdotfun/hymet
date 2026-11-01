import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { buildHolderSnapshot, splitDistributable, verifyHolderProof } from "../lib/fee-distribution";

describe("integer fee distribution", () => {
  it("routes exactly 20% to HYMET and allocates all remaining base units", () => {
    const result = splitDistributable(101n, 5_000);
    expect(result).toEqual({ distributable: 101n, hymet: 20n, creator: 40n, holders: 41n, remainder: 81n });
    expect(result.hymet + result.creator + result.holders).toBe(101n);
  });
  it("does not treat protocol costs as distributable", () => {
    const gross = 1000n, protocol = 275n;
    expect(splitDistributable(gross - protocol, 10_000).hymet).toBe(145n);
  });
  it("rejects negative amounts and invalid allocation", () => {
    expect(() => splitDistributable(-1n, 0)).toThrow();
    expect(() => splitDistributable(1n, 10_001)).toThrow();
  });
});

describe("funded holder snapshot", () => {
  const mint = Keypair.generate().publicKey.toBase58();
  it("creates deterministic proofs bound to mint, epoch, balance and reward", () => {
    const a = Keypair.generate().publicKey.toBase58(), b = Keypair.generate().publicKey.toBase58();
    const input = { mint, epoch: 4n, fundedAmount: 101n, holders: [{ wallet: a, tokenBalance: 2n }, { wallet: b, tokenBalance: 1n }] };
    const first = buildHolderSnapshot(input), second = buildHolderSnapshot({ ...input, holders: [...input.holders].reverse() });
    expect(first.root.equals(second.root)).toBe(true);
    expect(first.snapshotHash.equals(second.snapshotHash)).toBe(true);
    expect(first.allocatedAmount).toBeLessThanOrEqual(first.fundedAmount);
    for (const e of first.entitlements) expect(verifyHolderProof({ mint, epoch: 4n, ...e, root: first.root })).toBe(true);
    const e = first.entitlements[0];
    expect(verifyHolderProof({ mint, epoch: 5n, ...e, root: first.root })).toBe(false);
    expect(verifyHolderProof({ mint, epoch: 4n, ...e, reward: e.reward + 1n, root: first.root })).toBe(false);
  });
  it("rejects duplicate wallets and never allocates more than funded", () => {
    const wallet = Keypair.generate().publicKey.toBase58();
    expect(() => buildHolderSnapshot({ mint, epoch: 1n, fundedAmount: 5n, holders: [{ wallet, tokenBalance: 1n }, { wallet, tokenBalance: 1n }] })).toThrow("Duplicate");
    const snap = buildHolderSnapshot({ mint, epoch: 1n, fundedAmount: 2n, holders: [
      { wallet: Keypair.generate().publicKey.toBase58(), tokenBalance: 1n },
      { wallet: Keypair.generate().publicKey.toBase58(), tokenBalance: 1n },
      { wallet: Keypair.generate().publicKey.toBase58(), tokenBalance: 1n },
    ] });
    expect(snap.allocatedAmount).toBeLessThanOrEqual(2n);
    expect(snap.unallocatedRemainder).toBe(snap.fundedAmount - snap.allocatedAmount);
  });
});
