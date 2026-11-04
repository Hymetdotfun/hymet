import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Connection, Keypair, PublicKey, type Transaction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { HOLDER_PAYOUT_POLICY, planHolderEpoch, snapshotCommitment, verifySnapshotBalance, type CarryOrigin } from "../lib/holder-payouts.mjs";
import { distributorAddresses, holderEpochAddress } from "../lib/distributor-engine";
import { reconcileHolderRewards } from "../lib/holder-reconciliation.mjs";
import { runHolderPayouts, verifyCarryOrigin, type KeeperContext } from "../lib/holder-keeper";

const MINT = "So11111111111111111111111111111111111111112";
const program = new PublicKey("9X9fnj4Uh9WC9nmxCahTVsixHZ6VGxNpMesuGhK239Px");
const pub = (seed: string) => Keypair.fromSeed(createHash("sha256").update(seed).digest()).publicKey;
const wallet = (seed: string) => pub(seed).toBase58();
const byKey = (a: { wallet: string }, b: { wallet: string }) => Buffer.compare(new PublicKey(a.wallet).toBuffer(), new PublicKey(b.wallet).toBuffer());
const sum = (xs: Iterable<bigint>) => [...xs].reduce((a, b) => a + b, 0n);
const all = () => true;
const SELLER = wallet("seller"), STAY = wallet("stays"), OTHER = wallet("other");
const origin: CarryOrigin = { epoch: 3n, snapshotSlot: 900n, tokenBalance: 77_000n };
const base = { mint: MINT, epoch: 5n, snapshotSlot: 1_000, hasHypeAccount: all as (w: string) => boolean };
const holders = [{ wallet: STAY, tokenBalance: 3_000n }, { wallet: OTHER, tokenBalance: 1_000n }].sort(byKey);

describe("a wallet that sold keeps what it was allocated", () => {
  it("is not given to anyone else while below its minimum, and holders' shares are unchanged", () => {
    const owed = 4_000_000n, fresh = 400_000_000n;
    const withCarry = planHolderEpoch({ ...base, holders, available: owed + fresh, carry: new Map([[SELLER, owed]]), carryOrigins: new Map([[SELLER, origin]]), sellerVerified: all });
    const without = planHolderEpoch({ ...base, holders, available: fresh });
    expect(withCarry.budget).toBe(fresh);
    expect(withCarry.payouts.map((p) => [p.wallet, p.reward])).toEqual(without.payouts.map((p) => [p.wallet, p.reward]));
    expect(withCarry.carryOut.get(SELLER)).toBe(owed);
    expect(withCarry.carryOrigins.get(SELLER)).toEqual(origin);
    expect(withCarry.fundedAmount + sum(withCarry.carryOut.values()) + withCarry.dust).toBe(withCarry.available);
  });

  it("is paid in full under the existing minimum, with its true balance at the allocating snapshot", () => {
    const owed = HOLDER_PAYOUT_POLICY.minPayout, fresh = 400_000_000n;
    const plan = planHolderEpoch({ ...base, holders, available: owed + fresh, carry: new Map([[SELLER, owed]]), carryOrigins: new Map([[SELLER, origin]]), sellerVerified: all });
    const paid = plan.payouts.find((p) => p.wallet === SELLER)!;
    expect(paid).toMatchObject({ reward: owed, tokenBalance: origin.tokenBalance, originEpoch: origin.epoch, originSnapshotSlot: origin.snapshotSlot });
    expect(plan.carryOut.has(SELLER)).toBe(false);
    expect(plan.carryOrigins.has(SELLER)).toBe(false);
    expect(plan.budget).toBe(fresh); // its reward came from its own carry, not the new money
    expect(plan.payouts.find((p) => p.wallet === STAY)!.reward).toBe((fresh * 3_000n) / 4_000n);
    expect(plan.fundedAmount + sum(plan.carryOut.values()) + plan.dust).toBe(plan.available);
    expect(plan.chunks.flatMap((c) => c.entries).every((e) => e.tokenBalance > 0n && e.reward > 0n)).toBe(true);
  });

  it("stays carried one base unit below the minimum", () => {
    const owed = HOLDER_PAYOUT_POLICY.minPayout - 1n;
    const plan = planHolderEpoch({ ...base, holders: [], available: owed, carry: new Map([[SELLER, owed]]), carryOrigins: new Map([[SELLER, origin]]), sellerVerified: all });
    expect(plan.payouts).toEqual([]);
    expect(plan.carryOut.get(SELLER)).toBe(owed);
  });

  it("keeps the higher minimum when the wallet has no HYPE account, and pays once it has one", () => {
    const owed = 13_000_000n, input = { ...base, holders: [], available: owed, carry: new Map([[SELLER, owed]]), carryOrigins: new Map([[SELLER, origin]]), sellerVerified: all };
    expect(planHolderEpoch({ ...input, hasHypeAccount: () => false }).payouts).toEqual([]);
    const opened = planHolderEpoch(input);
    expect(opened.payouts).toHaveLength(1);
    expect(opened.root).not.toBeNull(); // a round with only sellers still commits a root
    const big = planHolderEpoch({ ...input, available: 50_000_000n, carry: new Map([[SELLER, 50_000_000n]]), hasHypeAccount: () => false });
    expect(big.payouts[0]).toMatchObject({ newAccount: true, reward: 50_000_000n });
  });

  it("is never paid without a proven origin, and the amount stays attributed", () => {
    const owed = 20_000_000n, carry = new Map([[SELLER, owed]]);
    const unproven = planHolderEpoch({ ...base, holders: [], available: owed, carry, carryOrigins: new Map([[SELLER, origin]]), sellerVerified: () => false });
    const noOrigin = planHolderEpoch({ ...base, holders: [], available: owed, carry, sellerVerified: all });
    const byDefault = planHolderEpoch({ ...base, holders: [], available: owed, carry, carryOrigins: new Map([[SELLER, origin]]) });
    for (const plan of [unproven, noOrigin, byDefault]) {
      expect(plan.payouts).toEqual([]);
      expect(plan.carryOut.get(SELLER)).toBe(owed);
    }
    expect(unproven.carryOrigins.get(SELLER)).toEqual(origin);
  });

  it("stays carried with its origin when an epoch is full", () => {
    const policy = { ...HOLDER_PAYOUT_POLICY, maxChunks: 1, chunkSize: 1 };
    const plan = planHolderEpoch({ ...base, policy, holders: [{ wallet: STAY, tokenBalance: 5n }], available: 100_000_000n + 20_000_000n, carry: new Map([[SELLER, 20_000_000n]]), carryOrigins: new Map([[SELLER, origin]]), sellerVerified: all });
    expect(plan.payouts.map((p) => p.wallet)).toEqual([STAY]);
    expect(plan.carryOut.get(SELLER)).toBe(20_000_000n);
    expect(plan.carryOrigins.get(SELLER)).toEqual(origin);
  });
});

describe("a holder that returns", () => {
  it("is paid its carry plus its new share using its current balance", () => {
    const owed = 6_000_000n, list = [{ wallet: SELLER, tokenBalance: 2_000n }, { wallet: STAY, tokenBalance: 2_000n }].sort(byKey);
    const plan = planHolderEpoch({ ...base, holders: list, available: owed + 10_000_000n, carry: new Map([[SELLER, owed]]), carryOrigins: new Map([[SELLER, origin]]) });
    const paid = plan.payouts.find((p) => p.wallet === SELLER)!;
    expect(paid.reward).toBe(owed + 5_000_000n);
    expect(paid.tokenBalance).toBe(2_000n);
    expect(paid.originEpoch).toBeUndefined();
    expect(plan.carryOut.has(SELLER)).toBe(false);
  });
  it("still carries below the minimum, now from this snapshot", () => {
    const owed = 1_000_000n, list = [{ wallet: SELLER, tokenBalance: 10n }, { wallet: STAY, tokenBalance: 90n }].sort(byKey);
    const plan = planHolderEpoch({ ...base, holders: list, available: owed + 50_000_000n, carry: new Map([[SELLER, owed]]), carryOrigins: new Map([[SELLER, origin]]) });
    expect(plan.carryOut.get(SELLER)).toBe(owed + 5_000_000n);
    expect(plan.carryOrigins.get(SELLER)).toEqual({ epoch: 5n, snapshotSlot: 1_000n, tokenBalance: 10n });
  });
});

describe("unpaid carry", () => {
  it("accumulates exactly for current holders and conserves every base unit over rounds", () => {
    const first = planHolderEpoch({ ...base, holders: [{ wallet: STAY, tokenBalance: 1n }, { wallet: OTHER, tokenBalance: 99n }].sort(byKey), available: 100_000_001n });
    expect(first.payouts.map((p) => p.wallet)).toEqual([OTHER]);
    const owedStay = first.carryOut.get(STAY)!;
    expect(owedStay).toBe(1_000_000n);
    const second = planHolderEpoch({ ...base, epoch: 6n, snapshotSlot: 2_000, holders: [{ wallet: STAY, tokenBalance: 1n }].sort(byKey), available: first.available - first.fundedAmount + 9_000_000n, carry: first.carryOut, carryOrigins: first.carryOrigins });
    expect(second.payouts[0]).toMatchObject({ wallet: STAY, reward: owedStay + first.dust + 9_000_000n });
    expect(second.fundedAmount + sum(second.carryOut.values()) + second.dust).toBe(second.available);
  });
});

describe("historical snapshot verification", () => {
  const balances = { [SELLER]: "77000", [STAY]: "3000", [OTHER]: "1000" };
  const snapshot = Object.entries(balances).map(([w, b]) => ({ wallet: w, tokenBalance: BigInt(b) })).sort(byKey);
  const args = { mint: MINT, epoch: 3n, snapshotSlot: 900n };
  const committedHash = snapshotCommitment({ ...args, holders: snapshot }).toString("hex");
  const verify = (over: object = {}) => verifySnapshotBalance({ ...args, committedHash, balances, wallet: SELLER, tokenBalance: 77_000n, ...over });

  it("accepts only the exact balance that reproduces the committed hash", () => {
    expect(verify()).toBe(true);
    expect(verify({ tokenBalance: 76_999n })).toBe(false);
    expect(verify({ tokenBalance: 0n })).toBe(false);
    expect(verify({ wallet: wallet("never held") })).toBe(false);
    expect(verify({ balances: { ...balances, [OTHER]: "1001" } })).toBe(false); // one edited row breaks the proof
    expect(verify({ balances: null })).toBe(false);
    expect(verify({ committedHash: "00".repeat(32) })).toBe(false);
    expect(verify({ snapshotSlot: 901n })).toBe(false);
    expect(verify({ epoch: 4n })).toBe(false);
  });

  it("leaves the hash of a holders-only round unchanged and commits each seller's origin otherwise", () => {
    const plain = planHolderEpoch({ ...base, holders, available: 400_000_000n });
    expect(plain.snapshotHash.equals(snapshotCommitment({ ...base, holders }))).toBe(true);
    const carry = new Map([[SELLER, 20_000_000n]]);
    const paid = planHolderEpoch({ ...base, holders, available: 420_000_000n, carry, carryOrigins: new Map([[SELLER, origin]]), sellerVerified: all });
    expect(paid.snapshotHash.equals(plain.snapshotHash)).toBe(false);
    const settlement = { wallet: SELLER, originEpoch: 3n, originSnapshotSlot: 900n, tokenBalance: 77_000n, reward: 20_000_000n };
    expect(paid.snapshotHash.equals(snapshotCommitment({ ...base, holders, settlements: [settlement] }))).toBe(true);
    expect(paid.snapshotHash.equals(snapshotCommitment({ ...base, holders, settlements: [{ ...settlement, originSnapshotSlot: 901n }] }))).toBe(false);
  });
});

describe("keeper", () => {
  const mint = pub("keeper mint"), mintText = mint.toBase58();
  const hashOf = (b: Record<string, string>) => snapshotCommitment({ mint: mintText, epoch: 3n, snapshotSlot: 900n, holders: Object.entries(b).map(([w, v]) => ({ wallet: w, tokenBalance: BigInt(v) })).sort(byKey) }).toString("hex");
  const balances = { [SELLER]: "77000", [OTHER]: "1000" };
  const fundedLogs = (hash: string, slot = 900n) => {
    const b = Buffer.alloc(172);
    createHash("sha256").update("event:HolderEpochFunded").digest().copy(b, 0, 0, 8);
    mint.toBuffer().copy(b, 8);
    b.writeBigUInt64LE(3n, 40);
    b.writeBigUInt64LE(slot, 80);
    Buffer.from(hash, "hex").copy(b, 88);
    return [`Program ${program.toBase58()} invoke [1]`, `Program data: ${b.toString("base64")}`, `Program ${program.toBase58()} success`];
  };
  function pool(unallocated: bigint) {
    const d = Buffer.alloc(195);
    createHash("sha256").update("account:FeePool").digest().copy(d, 0, 0, 8);
    mint.toBuffer().copy(d, 40);
    d.writeUInt16LE(5_000, 136);
    d.writeBigUInt64LE(unallocated, 146);
    d.writeBigUInt64LE(4n, 162);
    d.writeBigUInt64LE(900n, 187);
    return d;
  }
  type Setup = { owed?: bigint; stored?: Record<string, string> | null; chainHash?: string; dbHash?: string; hasOrigin?: boolean; settlementRows?: Record<string, unknown>[] };
  function harness(s: Setup = {}) {
    const owed = s.owed ?? 20_000_000n, a = distributorAddresses(program, mint);
    const dbHash = s.dbHash ?? hashOf(balances), sent: string[] = [], logs: unknown[][] = [], sql: { text: string; values: unknown[] }[] = [];
    const data = new Map([[a.feePool.toBase58(), pool(owed)]]);
    const connection = {
      getAccountInfo: async (k: PublicKey) => (k.equals(holderEpochAddress(program, mint, 3n)) ? null : data.get(k.toBase58()) ? { data: data.get(k.toBase58()), owner: program, lamports: 1, executable: false } : null),
      getProgramAccounts: async () => ({ context: { slot: 4242 }, value: [] }),
      getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map(() => ({ owner: TOKEN_PROGRAM_ID, data: Buffer.alloc(165) })),
      getSlot: async () => 4243,
      getBalance: async () => 1_000_000_000,
      getTransaction: async () => ({ meta: { logMessages: fundedLogs(s.chainHash ?? hashOf(balances)) } }),
    } as unknown as Connection;
    const k: KeeperContext = {
      connection, program, platform: pub("platform"), authority: Keypair.generate(), dryRun: false, log: (...x) => logs.push(x),
      send: async (_t: Transaction, label: string) => { sent.push(label); return "sig"; }, simulate: async () => {}, reindex: async () => {},
      db: {
        query: async (text: string, values: unknown[] = []) => {
          sql.push({ text, values });
          if (text.startsWith("SELECT wallet_address,amount::text")) return { rows: [{ wallet_address: SELLER, amount: owed.toString(), ...(s.hasOrigin === false ? { origin_epoch: null } : { origin_epoch: "3", origin_snapshot_slot: "900", origin_token_balance: "77000" }) }] };
          if (text.startsWith("SELECT e.snapshot_hash")) return { rows: [{ snapshot_hash: dbHash, snapshot_slot: "900", funding_signature: "fund-sig", snapshot_balances: s.stored === undefined ? balances : s.stored }] };
          if (text.startsWith("SELECT token_balance")) return { rows: s.settlementRows ?? [] };
          return { rows: [] };
        },
      },
    };
    return { k, sent, logs, sql };
  }
  const run = (k: KeeperContext) => runHolderPayouts(k, { mint: mintText, dbcPool: pub("dbc").toBase58() });

  it("pays a seller only after proving its balance against the on-chain hash, recording the origin", async () => {
    const { k, sent, sql } = harness();
    expect(await run(k)).toMatchObject({ payouts: 1, sellerPayouts: 1, unverifiedSellers: 0, holders: 0, closed: true });
    expect(sent.filter((x) => /fund epoch|pay chunk|close epoch/.test(x))).toEqual(["fund epoch 4", "pay chunk 0", "close epoch 4"]);
    const row = sql.find((x) => x.text.startsWith("INSERT INTO holder_snapshot_candidate_rows"))!;
    expect(row.values[3]).toBe("77000");
    expect(row.values.slice(9)).toEqual(["3", "900"]);
  });

  for (const [name, setup, reason] of [
    ["a stored balance was edited", { stored: { ...balances, [OTHER]: "1001" } }, /does not reproduce/],
    ["the wallet is not in that snapshot", { stored: { [OTHER]: "1000" }, chainHash: undefined }, /does not reproduce/],
    ["the database hash differs from the chain", { dbHash: "ab".repeat(32) }, /differs from the on-chain/],
    ["balances were pruned", { stored: null }, /not stored/],
    ["no origin was recorded", { hasOrigin: false }, /no recorded origin/],
  ] as [string, Setup, RegExp][]) {
    it(`sends nothing and keeps the carry when ${name}`, async () => {
      const { k, sent, logs } = harness(setup);
      const reported: { kind: string }[][] = [];
      k.onSellerProofResult = (_m, failures) => reported.push(failures);
      expect(await run(k)).toMatchObject({ payouts: 0, unverifiedSellers: 1 });
      expect(reported).toEqual([[expect.objectContaining({ wallet: SELLER, kind: /reproduce|differs/.test(reason.source) ? "mismatch" : "unavailable" })]]);
      expect(sent.filter((x) => /fund|pay|close/.test(x))).toEqual([]);
      expect(logs.some(([m, d]) => m === "seller carry not paid" && reason.test(String((d as { reason: string }).reason)))).toBe(true);
    });
  }

  it("clears earlier failures once proven, and a dry run reports nothing", async () => {
    const live = harness();
    const reported: unknown[][] = [];
    live.k.onSellerProofResult = (_m, failures) => reported.push(failures);
    await run(live.k);
    expect(reported).toEqual([[]]);
    const dry = harness({ stored: null });
    dry.k.dryRun = true;
    dry.k.onSellerProofResult = () => { throw Error("dry run must not report"); };
    await run(dry.k);
  });

  it("does not try to prove a seller below its minimum", async () => {
    const { k, sql } = harness({ owed: 10_000_000n - 1n });
    await run(k);
    expect(sql.some((x) => x.text.startsWith("SELECT e.snapshot_hash"))).toBe(false);
  });

  it("verifies an origin epoch that itself paid a seller", async () => {
    const settlement = { wallet: OTHER, tokenBalance: 5n, reward: 9n, originEpoch: 1n, originSnapshotSlot: 500n };
    const list = Object.entries(balances).map(([w, v]) => ({ wallet: w, tokenBalance: BigInt(v) })).sort(byKey);
    const hash = snapshotCommitment({ mint: mintText, epoch: 3n, snapshotSlot: 900n, holders: list, settlements: [settlement] }).toString("hex");
    const { k } = harness({ dbHash: hash, chainHash: hash, settlementRows: [{ wallet_address: OTHER, token_balance: "5", reward_amount: "9", origin_epoch: "1", origin_snapshot_slot: "500" }] });
    expect(await verifyCarryOrigin(k, mintText, SELLER, origin)).toBeNull();
  });
});

describe("exact reconciliation", () => {
  const chain = { totalSettled: 1_000n, totalPlatform: 200n, creatorClaimable: 300n, holderUnallocated: 150n, holderReserved: 0n, nextEpoch: 1n };
  const input = {
    chain, vault: 450n,
    settlements: [{ distributable_amount: "1000", hymet_amount: "200", creator_amount: "400", holder_amount: "400" }],
    claims: [{ claim_type: "creator", amount: "100" }, { claim_type: "holder", amount: "250" }],
    epochs: [{ funded_amount: "250", status: "closed", returned_amount: "0" }],
    entitlements: [{ reward_amount: "250", claimed_amount: "250" }],
    carry: [{ amount: "120" }],
  };
  it("matches to the base unit and separates attributed carry from unassigned rewards", () => {
    expect(reconcileHolderRewards(input)).toMatchObject({ ok: true, attributedCarry: 120n, unassigned: 30n });
  });
  it.each([
    ["vault", { vault: 451n }, "vault vs recorded liabilities"],
    ["settled total", { chain: { ...chain, totalSettled: 999n } }, "settled total, chain vs database"],
    ["holder pool", { chain: { ...chain, holderUnallocated: 149n } }, "holder unallocated, chain vs settled - funded"],
    ["carry above the pool", { carry: [{ amount: "151" }] }, "attributed carry within the holder pool"],
    ["unpaid entitlement", { entitlements: [{ reward_amount: "250", claimed_amount: "249" }] }, "entitlements paid vs holder claims"],
  ])("flags a one-unit difference in %s", (_n, change, name) => {
    const report = reconcileHolderRewards({ ...input, ...change } as typeof input);
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.name === name)?.ok).toBe(false);
  });
  it("accounts for an expired round's returned reserve", () => {
    const expired = { ...input, epochs: [{ funded_amount: "300", status: "closed", returned_amount: "50" }], entitlements: [{ reward_amount: "300", claimed_amount: "250" }], chain: { ...chain, holderUnallocated: 100n }, vault: 400n };
    const holderPool = reconcileHolderRewards(expired).checks.find((c) => c.name === "holder reserved, chain vs funded - paid");
    expect(holderPool?.ok).toBe(true);
  });
});

describe("what stays out of this change", () => {
  const diffFree = (path: string, needle: RegExp) => expect(readFileSync(path, "utf8")).toMatch(needle);
  it("keeps the program's balance check, the minimums and the 15-minute interval", () => {
    diffFree("programs/hymet-rewards-distributor/src/lib.rs", /entry\.token_balance > 0 && entry\.reward > 0/);
    expect(HOLDER_PAYOUT_POLICY).toMatchObject({ intervalMinutes: 15, minPayout: 10_000_000n, minPayoutNewAccount: 50_000_000n });
  });
  it("adds only additive columns in the migration, with no token details", () => {
    const sql = readFileSync("migrations/011_carry_origins.sql", "utf8");
    expect(sql).not.toMatch(/\b(DROP|DELETE|UPDATE|TRUNCATE)\b/i);
    expect(sql).not.toMatch(/[1-9A-HJ-NP-Za-km-z]{32,44}/);
  });
});
