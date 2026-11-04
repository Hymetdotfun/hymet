import { describe, expect, it } from "vitest";
import { ComputeBudgetProgram, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { HOLDER_PAYOUT_POLICY, INCINERATOR, chunkLeaf, decodeTokenAccount, eligibleHolders, payoutCost, planHolderEpoch, verifyChunkProof } from "../lib/holder-payouts.mjs";
import { closeHolderEpoch, decodeFeePool, distributeHolderChunk, fundDistributorEpoch } from "../lib/distributor-engine";
import { decodeRewardEpoch } from "../lib/holder-keeper";
import { decodeDistributorEvents } from "../lib/distributor-events.mjs";
import { HOLDER_REWARDS_CONFIGURED_NOTE, HOLDER_REWARDS_VERIFIED_NOTE, holderPayoutsLive } from "../lib/launch-mode";
import { createHash } from "node:crypto";

const MINT = "So11111111111111111111111111111111111111112";
const PROGRAM = new PublicKey("9X9fnj4Uh9WC9nmxCahTVsixHZ6VGxNpMesuGhK239Px");
const wallet = (seed: string) => Keypair.fromSeed(createHash("sha256").update(seed).digest()).publicKey.toBase58();
const holder = (seed: string, tokenBalance: bigint) => ({ wallet: wallet(seed), tokenBalance });
const all = () => true;
const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);

describe("holder eligibility snapshot", () => {
  it("aggregates per owner and excludes frozen, empty, PDA, incinerator and explicit accounts", () => {
    const a = wallet("a"), b = wallet("b"), platform = wallet("platform");
    const pda = PublicKey.findProgramAddressSync([Buffer.from("fee-pool")], PROGRAM)[0].toBase58();
    const rows = eligibleHolders([
      { owner: a, amount: 5n, state: 1 },
      { owner: a, amount: 7n, state: 1 },
      { owner: b, amount: 3n, state: 2 }, // frozen
      { owner: b, amount: 0n, state: 1 },
      { owner: pda, amount: 1_000n, state: 1 }, // pool vault / distributor custody
      { owner: INCINERATOR, amount: 9n, state: 1 },
      { owner: platform, amount: 4n, state: 1 },
    ], [platform]);
    expect(rows).toEqual([{ wallet: a, tokenBalance: 12n }]);
  });

  it("decodes SPL token accounts", () => {
    const data = Buffer.alloc(165);
    new PublicKey(MINT).toBuffer().copy(data, 0);
    new PublicKey(wallet("x")).toBuffer().copy(data, 32);
    data.writeBigUInt64LE(42n, 64);
    data[108] = 1;
    expect(decodeTokenAccount(data)).toEqual({ mint: MINT, owner: wallet("x"), amount: 42n, state: 1 });
    expect(decodeTokenAccount(Buffer.alloc(82))).toBeNull();
  });
});

describe("holder epoch planning", () => {
  const holders = eligibleHolders(Array.from({ length: 20 }, (_, i) => ({ owner: wallet(`h${i}`), amount: BigInt(i + 1) * 1_000_000_000n, state: 1 })));
  const base = { mint: MINT, epoch: 3n, snapshotSlot: 1_000, holders, hasHypeAccount: all };

  it("pays pro rata, commits every chunk to one root and conserves every base unit", () => {
    const plan = planHolderEpoch({ ...base, available: 21_000_000_001n });
    expect(plan.payouts).toHaveLength(20);
    expect(plan.chunks.map((c) => c.entries.length)).toEqual([6, 6, 6, 2]);
    expect(plan.fundedAmount).toBe(sum(plan.payouts.map((p) => p.reward)));
    expect(plan.fundedAmount + plan.dust).toBe(21_000_000_001n);
    // largest holder (20 of 210 parts) gets 20/210 of the budget
    expect(plan.payouts.find((p) => p.wallet === wallet("h19"))!.reward).toBe((21_000_000_001n * 20n) / 210n);
    for (const c of plan.chunks) {
      expect(verifyChunkProof(c.leaf, c.proof, plan.root!)).toBe(true);
      expect(c.leaf.equals(chunkLeaf(MINT, 3n, c.index, c.entries))).toBe(true);
      const tampered = c.entries.map((e, i) => (i === 0 ? { ...e, reward: e.reward + 1n } : e));
      expect(verifyChunkProof(chunkLeaf(MINT, 3n, c.index, tampered), c.proof, plan.root!)).toBe(false);
      expect(verifyChunkProof(chunkLeaf(MINT, 4n, c.index, c.entries), c.proof, plan.root!)).toBe(false);
    }
    const wallets = plan.payouts.map((p) => new PublicKey(p.wallet).toBuffer());
    for (let i = 1; i < wallets.length; i++) expect(Buffer.compare(wallets[i - 1], wallets[i])).toBe(-1);
  });

  it("carries amounts below the minimum and pays them once the total crosses it", () => {
    const tiny = planHolderEpoch({ ...base, available: 2_100_000n }); // shares far below 0.01 HYPE
    expect(tiny.payouts).toHaveLength(0);
    expect(tiny.root).toBeNull();
    expect(sum([...tiny.carryOut.values()]) + tiny.dust).toBe(2_100_000n);
    // Carry stays inside holder_unallocated; only new money is shared next time.
    const next = planHolderEpoch({ ...base, available: 2_100_000n + 210_000_000n, carry: tiny.carryOut });
    expect(next.budget).toBe(210_000_000n + tiny.dust);
    const top = next.payouts.find((p) => p.wallet === wallet("h19"))!;
    expect(top.reward).toBe(tiny.carryOut.get(wallet("h19"))! + (next.budget * 20n) / 210n);
    expect(next.fundedAmount + sum([...next.carryOut.values()]) + next.dust).toBe(next.available);
  });

  it("uses the higher minimum when the keeper must create the holder's HYPE account", () => {
    const one = [holder("solo", 1n)];
    const p = { mint: MINT, epoch: 0n, snapshotSlot: 9, holders: one };
    expect(planHolderEpoch({ ...p, available: 20_000_000n, hasHypeAccount: all }).payouts).toHaveLength(1);
    const noAccount = planHolderEpoch({ ...p, available: 20_000_000n, hasHypeAccount: () => false });
    expect(noAccount.payouts).toHaveLength(0);
    expect(noAccount.carryOut.get(wallet("solo"))).toBe(20_000_000n);
    expect(planHolderEpoch({ ...p, available: HOLDER_PAYOUT_POLICY.minPayoutNewAccount, hasHypeAccount: () => false }).payouts[0].newAccount).toBe(true);
  });

  it("caps one epoch at maxChunks * chunkSize, paying the largest first and carrying the rest", () => {
    const policy = { ...HOLDER_PAYOUT_POLICY, maxChunks: 2, minPayout: 1n };
    const plan = planHolderEpoch({ ...base, available: 210_000_000_000n, policy });
    expect(plan.payouts).toHaveLength(12);
    expect(plan.carryOut.size).toBe(8);
    expect(Math.min(...plan.payouts.map((p) => Number(p.tokenBalance)))).toBeGreaterThan(Math.max(...[...plan.carryOut.keys()].map((w) => Number(holders.find((h) => h.wallet === w)!.tokenBalance))));
  });

  it("refuses to plan when the carry ledger exceeds the on-chain holder pool", () => {
    expect(() => planHolderEpoch({ ...base, available: 5n, carry: new Map([[wallet("h1"), 6n]]) })).toThrow(/Carry ledger exceeds/);
  });
});

describe("payout instructions", () => {
  const mint = new PublicKey(MINT), keeper = Keypair.generate().publicKey;

  it("a 6-holder chunk with a depth-10 proof fits one transaction with compute budget", () => {
    const entries = Array.from({ length: 6 }, (_, i) => ({ wallet: wallet(`fit${i}`), tokenBalance: 2n ** 63n, reward: 2n ** 63n }));
    const proof = Array.from({ length: 10 }, (_, i) => Buffer.alloc(32, i));
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 }),
      distributeHolderChunk(PROGRAM, mint, keeper, { epoch: 1n, chunkIndex: 1023, entries, proof }),
    );
    tx.feePayer = keeper;
    tx.recentBlockhash = PublicKey.default.toBase58();
    expect(tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length).toBeLessThanOrEqual(1232);
  });

  it("encodes chunk data in the program's Borsh order and binds each wallet's canonical HYPE ATA", () => {
    const entries = [{ wallet: wallet("w0"), tokenBalance: 5n, reward: 7n }];
    const ix = distributeHolderChunk(PROGRAM, mint, keeper, { epoch: 2n, chunkIndex: 9, entries, proof: [Buffer.alloc(32, 1)] });
    expect(ix.data.subarray(0, 8)).toEqual(createHash("sha256").update("global:distribute_holder_chunk").digest().subarray(0, 8));
    expect(ix.data.readUInt32LE(8)).toBe(9);
    expect(ix.data.readUInt32LE(12)).toBe(1);
    expect(ix.data.readBigUInt64LE(16)).toBe(5n);
    expect(ix.data.readBigUInt64LE(24)).toBe(7n);
    expect(ix.data.readUInt32LE(32)).toBe(1);
    expect(ix.keys[5]).toMatchObject({ pubkey: keeper, isSigner: true });
    expect(ix.keys.filter((k) => k.isSigner)).toHaveLength(1); // holders never sign
    expect(ix.keys[7].isWritable).toBe(true);
    expect(() => distributeHolderChunk(PROGRAM, mint, keeper, { epoch: 0n, chunkIndex: 0, entries: Array(7).fill(entries[0]), proof: [] })).toThrow();
    const fund = fundDistributorEpoch(PROGRAM, mint, keeper, { epoch: 0n, snapshotSlot: 5n, snapshotHash: "ab".repeat(32), root: "cd".repeat(32), amount: 1n, chunkCount: 4 });
    expect(fund.data.readUInt32LE(8 + 8 + 8 + 32 + 32 + 8)).toBe(4);
    expect(() => fundDistributorEpoch(PROGRAM, mint, keeper, { epoch: 0n, snapshotSlot: 5n, snapshotHash: "ab".repeat(32), root: "cd".repeat(32), amount: 1n, chunkCount: 1025 })).toThrow();
    expect(closeHolderEpoch(PROGRAM, mint, keeper, 0n).keys[2]).toMatchObject({ pubkey: keeper, isSigner: true, isWritable: true });
  });

  it("decodes FeePool (with appended last_snapshot_slot) and RewardEpoch bitmaps", () => {
    const pool = Buffer.alloc(195);
    createHash("sha256").update("account:FeePool").digest().copy(pool, 0, 0, 8);
    pool.writeUInt16LE(2500, 136);
    pool.writeBigUInt64LE(77n, 146);
    pool.writeBigUInt64LE(3n, 162);
    pool.writeBigUInt64LE(999n, 187);
    expect(decodeFeePool(pool)).toMatchObject({ creatorBpsOfRemaining: 2500, holderUnallocated: 77n, nextEpoch: 3n, lastSnapshotSlot: 999n });
    const epoch = Buffer.alloc(149 + 2);
    epoch.writeBigUInt64LE(4n, 40);
    epoch.writeBigUInt64LE(100n, 120);
    epoch.writeUInt32LE(10, 136);
    epoch.writeUInt32LE(2, 140);
    epoch.writeUInt32LE(2, 145);
    epoch[149] = 0b0000_0101;
    epoch[150] = 0b0000_0010;
    const e = decodeRewardEpoch(epoch);
    expect([e.number, e.fundedAmount, e.chunkCount, e.paidChunks]).toEqual([4n, 100n, 10, 2]);
    expect([0, 1, 2, 9].map(e.isPaid)).toEqual([true, false, true, true]);
  });

  it("decodes HolderPaid and HolderEpochClosed events", () => {
    const disc = (n: string) => createHash("sha256").update(`event:${n}`).digest().subarray(0, 8);
    const paid = Buffer.alloc(100);
    disc("HolderPaid").copy(paid, 0);
    mint.toBuffer().copy(paid, 8);
    paid.writeBigUInt64LE(6n, 40);
    paid.writeUInt32LE(3, 48);
    new PublicKey(wallet("p")).toBuffer().copy(paid, 52);
    paid.writeBigUInt64LE(55n, 84);
    paid.writeBigUInt64LE(12n, 92);
    const closed = Buffer.alloc(72);
    disc("HolderEpochClosed").copy(closed, 0);
    mint.toBuffer().copy(closed, 8);
    closed.writeBigUInt64LE(6n, 40);
    closed.writeBigUInt64LE(50n, 48);
    closed.writeBigUInt64LE(5n, 56);
    const program = PROGRAM.toBase58();
    const logs = [`Program ${program} invoke [1]`, `Program data: ${paid.toString("base64")}`, `Program data: ${closed.toString("base64")}`, `Program ${program} success`];
    expect(decodeDistributorEvents(logs, program)).toEqual([
      { type: "HolderPaid", payload: { mint: MINT, epoch: "6", chunk: 3, wallet: wallet("p"), amount: "55", slot: "12" } },
      { type: "HolderEpochClosed", payload: { mint: MINT, epoch: "6", paidAmount: "50", returnedAmount: "5", slot: "0" } },
    ]);
  });
});

describe("payout costs and activation gate", () => {
  it("models SOL costs: fees per transaction plus HYPE account rent for new recipients", () => {
    const c = payoutCost({ payouts: 1_000, newAccounts: 200 });
    expect(c.transactions).toBe(167 + 25 + 3);
    expect(c.fees).toBe(195n * 5_000n);
    expect(c.accountRent).toBe(200n * 1_488_440n);
    expect(c.refundableEpochRent).toBe((128n + 149n + 21n) * 5_080n);
  });

  it("pays about every 15 minutes and keeps the 0.01 and 0.05 HYPE minimums", () => {
    expect(HOLDER_PAYOUT_POLICY).toMatchObject({ intervalMinutes: 15, minPayout: 10_000_000n, minPayoutNewAccount: 50_000_000n });
  });

  it("reports holder rewards as automatic only when every gate is verified", () => {
    const live = { HYMET_LAUNCH_MODE: "distributor", HYMET_DISTRIBUTOR_VERIFIED: "true", HYMET_DISTRIBUTOR_APP_VERIFIED: "true", HYMET_HOLDER_PAYOUTS_VERIFIED: "true" };
    expect(holderPayoutsLive(live)).toBe(true);
    for (const key of Object.keys(live)) expect(holderPayoutsLive({ ...live, [key]: "false" })).toBe(false);
    expect(holderPayoutsLive({})).toBe(false);
    expect(HOLDER_REWARDS_CONFIGURED_NOTE).toMatch(/No staking or claiming/);
    expect(HOLDER_REWARDS_CONFIGURED_NOTE).toMatch(/No Mainnet holder payout has been verified yet/);
    expect(HOLDER_REWARDS_VERIFIED_NOTE).not.toMatch(/not been verified/);
  });
});
