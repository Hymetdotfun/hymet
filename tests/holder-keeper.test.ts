import { HOLDER_PAYOUT_POLICY } from "../lib/holder-payouts.mjs";
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { Connection, Keypair, PublicKey, type Transaction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { distributorAddresses, holderEpochAddress } from "../lib/distributor-engine";
import { emptySnapshotStillCurrent, runHolderPayouts, type KeeperContext } from "../lib/holder-keeper";

const program = new PublicKey("9X9fnj4Uh9WC9nmxCahTVsixHZ6VGxNpMesuGhK239Px");
const mint = Keypair.generate().publicKey;
const owner = (i: number) => Keypair.fromSeed(createHash("sha256").update(`keeper holder ${i}`).digest()).publicKey;

function feePool(opts: { creatorBps: number; unallocated: bigint; nextEpoch: bigint; lastSnapshotSlot?: bigint }) {
  const d = Buffer.alloc(195);
  createHash("sha256").update("account:FeePool").digest().copy(d, 0, 0, 8);
  mint.toBuffer().copy(d, 40);
  d.writeUInt16LE(opts.creatorBps, 136);
  d.writeBigUInt64LE(opts.unallocated, 146);
  d.writeBigUInt64LE(opts.nextEpoch, 162);
  d.writeBigUInt64LE(opts.lastSnapshotSlot ?? 0n, 187);
  return d;
}
function tokenAccount(holder: PublicKey, amount: bigint) {
  const d = Buffer.alloc(165);
  mint.toBuffer().copy(d, 0);
  holder.toBuffer().copy(d, 32);
  d.writeBigUInt64LE(amount, 64);
  d[108] = 1;
  return d;
}

function harness(pool: Buffer, extra: Map<string, Buffer> = new Map(), storedRows: Record<string, unknown>[] = [], keeperLamports = 1_000_000_000) {
  const a = distributorAddresses(program, mint);
  const accounts = new Map<string, Buffer>([[a.feePool.toBase58(), pool], ...extra]);
  const sent: string[] = [], simulated: string[] = [], sql: string[] = [];
  let slotReads = 0;
  const connection = {
    getAccountInfo: async (k: PublicKey) => {
      const data = accounts.get(k.toBase58());
      return data ? { data, owner: program, lamports: 1, executable: false } : null;
    },
    getProgramAccounts: async () => ({
      context: { slot: 4242 },
      value: Array.from({ length: 8 }, (_, i) => ({ pubkey: Keypair.generate().publicKey, account: { data: tokenAccount(owner(i), BigInt(i + 1) * 10n ** 9n), owner: TOKEN_PROGRAM_ID } })),
    }),
    getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map(() => ({ owner: TOKEN_PROGRAM_ID, data: Buffer.alloc(165) })),
    // The first read is still the snapshot slot, so the keeper must wait before committing the root.
    getSlot: async () => (slotReads++ ? 4243 : 4242),
    getBalance: async () => keeperLamports,
  } as unknown as Connection;
  const k: KeeperContext = {
    connection, program, platform: Keypair.generate().publicKey, authority: Keypair.generate(), dryRun: false,
    db: { query: async (text: string) => { sql.push(text.split(" ").slice(0, 3).join(" ")); return { rows: text.startsWith("SELECT wallet_address,token_balance") ? storedRows : [] }; } },
    send: async (_tx: Transaction, label: string) => { sent.push(label); return `sig-${sent.length}`; },
    simulate: async (_tx: Transaction, label: string) => { simulated.push(label); },
    reindex: async () => { sent.push("reindex"); },
    log: () => {},
  };
  return { k, sent, simulated, sql };
}

describe("holder payout keeper", () => {
  it("skips tokens whose creator keeps the whole 80% allocation", async () => {
    const { k, sent } = harness(feePool({ creatorBps: 10_000, unallocated: 0n, nextEpoch: 0n }));
    expect(await runHolderPayouts(k, { mint: mint.toBase58(), dbcPool: Keypair.generate().publicKey.toBase58() })).toMatchObject({ skipped: expect.stringMatching(/100%/) });
    expect(sent).toEqual([]);
  });

  it("commits the root before paying, indexes it, pushes every chunk, then closes", async () => {
    const { k, sent, sql } = harness(feePool({ creatorBps: 5_000, unallocated: 36_000_000_000n, nextEpoch: 0n }));
    const result = await runHolderPayouts(k, { mint: mint.toBase58(), dbcPool: Keypair.generate().publicKey.toBase58() });
    expect(result).toMatchObject({ payouts: 8, chunks: 2, closed: true, fundedHype: "36000000000", snapshotSlot: 4242 });
    expect(sent).toEqual(["fund epoch 0", "reindex", "pay chunk 0", "pay chunk 1", "close epoch 0", "reindex"]);
    expect(sql.filter((s) => s.startsWith("INSERT INTO holder_snapshot_candidate_rows"))).toHaveLength(8);
    expect(sql.indexOf("COMMIT")).toBeGreaterThan(sql.indexOf("BEGIN"));
  });

  it.each([7_300, 100])("pays holders for any creator share below 100%% (creator bps %i)", async (creatorBps) => {
    const { k, sent } = harness(feePool({ creatorBps, unallocated: 36_000_000_000n, nextEpoch: 0n }));
    expect(await runHolderPayouts(k, { mint: mint.toBase58(), dbcPool: Keypair.generate().publicKey.toBase58() })).toMatchObject({ payouts: 8, closed: true, fundedHype: "36000000000" });
    expect(sent[0]).toBe("fund epoch 0");
  });

  it("dry runs simulate settlement-free funding only and write nothing", async () => {
    const { k, sent, simulated, sql } = harness(feePool({ creatorBps: 0, unallocated: 36_000_000_000n, nextEpoch: 0n }));
    k.dryRun = true;
    expect(await runHolderPayouts(k, { mint: mint.toBase58(), dbcPool: Keypair.generate().publicKey.toBase58() })).toMatchObject({ dryRun: true, payouts: 8 });
    expect(sent).toEqual([]);
    expect(simulated).toEqual(["fund epoch 0"]);
    expect(sql.filter((s) => !s.startsWith("SELECT"))).toEqual([]);
  });

  it("finishes and closes an open epoch from stored rows before planning the next one", async () => {
    const epoch = Buffer.alloc(150);
    epoch.writeUInt32LE(1, 136); // one chunk
    epoch.writeUInt32LE(0, 140); // none paid
    epoch.writeUInt32LE(1, 145);
    const open = new Map([[holderEpochAddress(program, mint, 0n).toBase58(), epoch]]);
    const rows = [{ wallet_address: owner(1).toBase58(), token_balance: "5", reward_amount: "60000000", chunk_index: 0, merkle_proof: [] }];
    const { k, sent } = harness(feePool({ creatorBps: 5_000, unallocated: 0n, nextEpoch: 1n }), open, rows);
    const result = await runHolderPayouts(k, { mint: mint.toBase58(), dbcPool: Keypair.generate().publicKey.toBase58() });
    expect(sent.slice(0, 3)).toEqual(["pay chunk 0", "close epoch 0", "reindex"]);
    expect(result).toMatchObject({ epoch: "1", skipped: expect.stringMatching(/below the payout minimum/) });
  });

  it("pays at most once per payout interval while settlement keeps running every tick", async () => {
    const pool = feePool({ creatorBps: 5_000, unallocated: 36_000_000_000n, nextEpoch: 1n, lastSnapshotSlot: 4_000n });
    const early = harness(pool);
    const snapshotAt = 1_000_000;
    const clock = (k: typeof early.k, seconds: number, blockTime: number | null = snapshotAt) => {
      k.payoutIntervalSeconds = HOLDER_PAYOUT_POLICY.intervalMinutes * 60;
      k.now = () => seconds;
      (k.connection as unknown as { getBlockTime: () => Promise<number | null> }).getBlockTime = async () => blockTime;
    };
    clock(early.k, snapshotAt + 899); // one second short of 15 real minutes, however many slots have passed
    expect(await runHolderPayouts(early.k, { mint: mint.toBase58(), dbcPool: Keypair.generate().publicKey.toBase58() })).toMatchObject({ skipped: expect.stringMatching(/next holder payout due after 1970-01-/) });
    expect(early.sent).toEqual([]);
    const due = harness(pool);
    clock(due.k, snapshotAt + 900);
    expect(await runHolderPayouts(due.k, { mint: mint.toBase58(), dbcPool: Keypair.generate().publicKey.toBase58() })).toMatchObject({ payouts: 8, closed: true });
  });

  describe("redundant snapshots", () => {
    const interval = 900, t0 = 2_000_000;
    it("decide from the pool and the last empty snapshot", () => {
      const e = { at: t0, unallocated: "100" };
      expect(emptySnapshotStillCurrent(undefined, 100n, t0, interval)).toBe(false);
      expect(emptySnapshotStillCurrent(e, 100n, t0 + 899, interval)).toBe(true);
      expect(emptySnapshotStillCurrent(e, 150n, t0 + 899, interval)).toBe(true); // new HYPE still waits for the interval
      expect(emptySnapshotStillCurrent(e, 150n, t0 + 900, interval)).toBe(false); // new HYPE after the interval
      expect(emptySnapshotStillCurrent(e, 100n, t0 + 900, interval)).toBe(true); // nothing new
      expect(emptySnapshotStillCurrent(e, 100n, t0 + 21_599, interval)).toBe(true);
      expect(emptySnapshotStillCurrent(e, 100n, t0 + 21_600, interval)).toBe(false); // balances may have moved
      expect(emptySnapshotStillCurrent(e, 100n, t0 - 1, interval)).toBe(false); // clock went backwards
    });
    const empty = () => feePool({ creatorBps: 5_000, unallocated: 20_000_000n, nextEpoch: 1n, lastSnapshotSlot: 4_000n });
    const store = (initial?: { at: number; unallocated: string }) => {
      let value = initial;
      return { get: () => value, set: (_m: string, v: { at: number; unallocated: string } | null) => { value = v ?? undefined; }, read: () => value };
    };
    const run = (k: Parameters<typeof runHolderPayouts>[0]) => runHolderPayouts(k, { mint: mint.toBase58(), dbcPool: Keypair.generate().publicKey.toBase58() });
    const counted = (k: Parameters<typeof runHolderPayouts>[0], seconds: number) => {
      const c = k.connection as unknown as { getBlockTime: () => Promise<number>; getProgramAccounts: (...a: unknown[]) => Promise<unknown> };
      const original = c.getProgramAccounts.bind(c);
      const counter = { snapshots: 0 };
      c.getProgramAccounts = (...a: unknown[]) => { counter.snapshots++; return original(...a); };
      c.getBlockTime = async () => t0 - 10_000;
      k.payoutIntervalSeconds = interval; k.now = () => seconds;
      return counter;
    };
    it("skip the holder read and report carrying when nothing has changed", async () => {
      const { k, sent } = harness(empty());
      const c = counted(k, t0 + 60);
      k.emptySnapshots = store({ at: t0, unallocated: "20000000" });
      expect(await run(k)).toMatchObject({ payouts: 0, skipped: expect.stringMatching(/carry over/) });
      expect(c.snapshots).toBe(0);
      expect(sent).toEqual([]);
    });
    it("snapshot again once new HYPE arrives and the interval has passed", async () => {
      const { k } = harness(empty());
      const c = counted(k, t0 + 900);
      k.emptySnapshots = store({ at: t0, unallocated: "19000000" });
      await run(k).catch(() => undefined);
      expect(c.snapshots).toBe(1);
    });
    it("never records anything on a dry run, and forgets on a funded round", async () => {
      const dry = harness(empty());
      counted(dry.k, t0);
      dry.k.dryRun = true;
      const s1 = store();
      dry.k.emptySnapshots = s1;
      await run(dry.k).catch(() => undefined);
      expect(s1.read()).toBeUndefined();
      const paid = harness(feePool({ creatorBps: 5_000, unallocated: 36_000_000_000n, nextEpoch: 1n, lastSnapshotSlot: 4_000n }));
      counted(paid.k, t0 + 900);
      const s2 = store({ at: t0, unallocated: "1" });
      paid.k.emptySnapshots = s2;
      await run(paid.k);
      expect(s2.read()).toBeUndefined();
    });
  });

  it("never pays early when the last snapshot's time cannot be read", async () => {
    const pool = feePool({ creatorBps: 5_000, unallocated: 36_000_000_000n, nextEpoch: 1n, lastSnapshotSlot: 4_000n });
    for (const read of [async () => null, async () => { throw Error("rpc down"); }]) {
      const { k, sent } = harness(pool);
      k.payoutIntervalSeconds = 900;
      (k.connection as unknown as { getBlockTime: () => Promise<number | null> }).getBlockTime = read;
      expect(await runHolderPayouts(k, { mint: mint.toBase58(), dbcPool: Keypair.generate().publicKey.toBase58() })).toMatchObject({ skipped: expect.stringMatching(/time unavailable/) });
      expect(sent).toEqual([]);
    }
  });

  it("never funds an epoch the keeper cannot afford to pay out and close", async () => {
    const { k, sent, sql } = harness(feePool({ creatorBps: 5_000, unallocated: 36_000_000_000n, nextEpoch: 0n }), new Map(), [], 1_000_000);
    await expect(runHolderPayouts(k, { mint: mint.toBase58(), dbcPool: Keypair.generate().publicKey.toBase58() })).rejects.toThrow(/Top up the keeper key/);
    expect(sent).toEqual([]);
    expect(sql.filter((q) => q.startsWith("INSERT"))).toEqual([]);
  });
});
