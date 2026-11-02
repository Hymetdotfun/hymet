import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { Connection, Keypair, PublicKey, type Transaction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { distributorAddresses, holderEpochAddress } from "../lib/distributor-engine";
import { runHolderPayouts, type KeeperContext } from "../lib/holder-keeper";

const program = new PublicKey("9X9fnj4Uh9WC9nmxCahTVsixHZ6VGxNpMesuGhK239Px");
const mint = Keypair.generate().publicKey;
const owner = (i: number) => Keypair.fromSeed(createHash("sha256").update(`keeper holder ${i}`).digest()).publicKey;

function feePool(opts: { creatorBps: number; unallocated: bigint; nextEpoch: bigint }) {
  const d = Buffer.alloc(195);
  createHash("sha256").update("account:FeePool").digest().copy(d, 0, 0, 8);
  mint.toBuffer().copy(d, 40);
  d.writeUInt16LE(opts.creatorBps, 136);
  d.writeBigUInt64LE(opts.unallocated, 146);
  d.writeBigUInt64LE(opts.nextEpoch, 162);
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

function harness(pool: Buffer, extra: Map<string, Buffer> = new Map(), storedRows: Record<string, unknown>[] = []) {
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
});
