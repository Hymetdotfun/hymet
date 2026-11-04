// Holder payout keeper: at most one payout round per token per interval (HOLDER_PAYOUT_POLICY.intervalMinutes, in real time).
//   finish/close any open epoch → settle Meteora fees into the distributor →
//   snapshot holders at one slot → plan (threshold + carry) → fund the committed root →
//   create missing HYPE accounts → push every chunk → close the epoch.
// The keeper key is the distributor's snapshot authority; it can only commit roots for HYPE
// already in the holder pool and pay the committed wallets. Holders never sign anything.
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction, type TransactionInstruction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { HYPE_MINT } from "./quote-assets";
import { closeHolderEpoch, decodeFeePool, distributeHolderChunk, distributorAddresses, fundDistributorEpoch, holderEpochAddress } from "./distributor-engine";
import { settlementInstructions } from "./distributor-settlement";
import { HOLDER_PAYOUT_POLICY, decodeTokenAccount, eligibleHolders, payoutCost, planHolderEpoch, verifySnapshotBalance, type CarryOrigin, type HolderEpochPlan } from "./holder-payouts.mjs";

import { decodeDistributorEvents } from "./distributor-events.mjs";

type Row = Record<string, unknown>;
export type KeeperContext = {
  connection: Connection;
  program: PublicKey;
  platform: PublicKey;
  authority: Keypair;
  db: { query: (sql: string, values?: unknown[]) => Promise<{ rows: Row[] }> };
  /** Signs with the authority, sends once and waits for confirmation; returns the signature. */
  send: (tx: Transaction, label: string) => Promise<string>;
  /** Simulates only (dry runs). */
  simulate: (tx: Transaction, label: string) => Promise<void>;
  /** Index confirmed distributor events into PostgreSQL (funded epochs, payouts, carry). */
  reindex: () => Promise<void>;
  log: (message: string, data?: unknown) => void;
  dryRun: boolean;
  policy?: typeof HOLDER_PAYOUT_POLICY;
  /** Minimum real seconds between holder snapshots (the advertised payout interval), measured from the last snapshot
   *  slot's block time because slot length varies. Migration, registration and settlement still run on every tick, so a
   *  short timer serves instant graduation without paying holders every few minutes. */
  payoutIntervalSeconds?: number;
  /** Wall clock in seconds; injectable for tests. */
  now?: () => number;
  /** Last snapshot per mint that found no holder to pay. Losing it only costs one extra snapshot. */
  emptySnapshots?: EmptySnapshotStore;
  /** Settlement failures do not stop payouts of HYPE already settled, so they are reported here rather than thrown. */
  onSettlementError?: (mint: string, error: string) => void;
};

export type EmptySnapshot = { at: number; unallocated: string };
export type EmptySnapshotStore = { get: (mint: string) => EmptySnapshot | undefined; set: (mint: string, value: EmptySnapshot | null) => void };
/** With no new HYPE in the pool only balance changes could make a holder payable, so an unchanged pool rechecks this rarely. */
export const EMPTY_SNAPSHOT_RECHECK_SECONDS = 6 * 3600;

/** Whether a snapshot would only repeat one that found no holder to pay. */
export function emptySnapshotStillCurrent(previous: EmptySnapshot | undefined, unallocated: bigint, now: number, intervalSeconds: number) {
  if (!previous) return false;
  const age = now - previous.at;
  if (age < 0) return false;
  if (age < intervalSeconds) return true;
  return previous.unallocated === unallocated.toString() && age < EMPTY_SNAPSHOT_RECHECK_SECONDS;
}

/** Never fund an epoch the keeper cannot finish: planned fees and new accounts plus the epoch rent, with headroom. */
export const KEEPER_SOL_HEADROOM_LAMPORTS = 5_000_000n;

/** RewardEpoch account: 8-byte discriminator, then the program's Borsh layout. */
export function decodeRewardEpoch(data: Buffer) {
  const chunkCount = data.readUInt32LE(136), paidChunks = data.readUInt32LE(140);
  const bitmapLength = data.readUInt32LE(145);
  const bitmap = data.subarray(149, 149 + bitmapLength);
  return {
    number: data.readBigUInt64LE(40),
    snapshotSlot: data.readBigUInt64LE(48),
    fundedAmount: data.readBigUInt64LE(120),
    claimedAmount: data.readBigUInt64LE(128),
    chunkCount,
    paidChunks,
    isPaid: (chunk: number) => (bitmap[chunk >> 3] & (1 << (chunk & 7))) !== 0,
  };
}

const ATA_BATCH = 8;
/** One DBC drain plus up to five DAMM v2 positions per run; anyone can add fee-pool-owned positions, so this is bounded. */
export const MAX_SETTLEMENTS_PER_RUN = 6;
const tx = (...ixs: TransactionInstruction[]) => new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }), ...ixs);

type EpochProof = { hash: string; slot: bigint; balances: Record<string, string> | null; settlements: { wallet: string; tokenBalance: bigint; reward: bigint; originEpoch: bigint; originSnapshotSlot: bigint }[] } | string;

/** One funded epoch's stored balances and the snapshot hash read back from its confirmed funding transaction. */
async function epochProof(k: Pick<KeeperContext, "connection" | "program" | "db">, mint: string, epoch: bigint): Promise<EpochProof> {
  const row = (await k.db.query(
    "SELECT e.snapshot_hash,e.snapshot_slot::text,e.funding_signature,c.snapshot_balances FROM holder_reward_epochs e JOIN holder_snapshot_candidates c USING(mint_address,epoch) WHERE e.mint_address=$1 AND e.epoch=$2",
    [mint, epoch.toString()],
  )).rows[0];
  if (!row) return "origin epoch is not indexed";
  if (!row.snapshot_balances) return "origin snapshot balances are not stored";
  const funding = await k.connection.getTransaction(String(row.funding_signature), { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  const event = (decodeDistributorEvents(funding?.meta?.logMessages ?? [], k.program.toBase58()) as unknown as { type: string; payload: Record<string, unknown> }[]).find((x) => x.type === "HolderEpochFunded" && x.payload.mint === mint && String(x.payload.epoch) === epoch.toString());
  if (!event) return "funding event not found on-chain";
  if (event.payload.snapshotHash !== row.snapshot_hash || String(event.payload.snapshotSlot) !== String(row.snapshot_slot)) return "stored epoch differs from the on-chain funding event";
  const settlements = (await k.db.query(
    "SELECT token_balance::text,wallet_address,reward_amount::text,origin_epoch::text,origin_snapshot_slot::text FROM holder_snapshot_candidate_rows WHERE mint_address=$1 AND epoch=$2 AND origin_epoch IS NOT NULL",
    [mint, epoch.toString()],
  )).rows.map((r) => ({ wallet: String(r.wallet_address), tokenBalance: BigInt(String(r.token_balance)), reward: BigInt(String(r.reward_amount)), originEpoch: BigInt(String(r.origin_epoch)), originSnapshotSlot: BigInt(String(r.origin_snapshot_slot)) }));
  return { hash: String(event.payload.snapshotHash), slot: BigInt(String(event.payload.snapshotSlot)), balances: row.snapshot_balances as Record<string, string>, settlements };
}

/** Proves a carried wallet's balance against the snapshot hash committed on-chain. Returns why not, or null when proven. */
export async function verifyCarryOrigin(k: Pick<KeeperContext, "connection" | "program" | "db">, mint: string, wallet: string, origin: CarryOrigin, cache: Map<string, EpochProof> = new Map()): Promise<string | null> {
  const key = origin.epoch.toString();
  if (!cache.has(key)) cache.set(key, await epochProof(k, mint, origin.epoch));
  const proof = cache.get(key)!;
  if (typeof proof === "string") return proof;
  if (proof.slot !== origin.snapshotSlot) return "origin slot differs from the funded snapshot";
  return verifySnapshotBalance({ mint, epoch: origin.epoch, snapshotSlot: origin.snapshotSlot, committedHash: proof.hash, balances: proof.balances, settlements: proof.settlements, wallet, tokenBalance: origin.tokenBalance }) ? null : "balance does not reproduce the committed snapshot hash";
}

async function existingAccounts(c: Connection, wallets: string[]) {
  const atas = wallets.map((w) => getAssociatedTokenAddressSync(HYPE_MINT, new PublicKey(w), true));
  const found = new Set<string>();
  for (let i = 0; i < atas.length; i += 100) {
    const infos = await c.getMultipleAccountsInfo(atas.slice(i, i + 100), "confirmed");
    infos.forEach((info, j) => { if (info?.owner.equals(TOKEN_PROGRAM_ID)) found.add(wallets[i + j]); });
  }
  return found;
}

async function payChunks(k: KeeperContext, mint: PublicKey, epoch: bigint, chunks: { index: number; entries: { wallet: string; tokenBalance: bigint; reward: bigint }[]; proof: Buffer[] }[], isPaid: (i: number) => boolean) {
  const pending = chunks.filter((c) => !isPaid(c.index));
  const wallets = pending.flatMap((c) => c.entries.map((e) => e.wallet));
  const have = await existingAccounts(k.connection, wallets);
  const missing = wallets.filter((w) => !have.has(w));
  for (let i = 0; i < missing.length; i += ATA_BATCH)
    await k.send(tx(...missing.slice(i, i + ATA_BATCH).map((w) => createAssociatedTokenAccountIdempotentInstruction(k.authority.publicKey, getAssociatedTokenAddressSync(HYPE_MINT, new PublicKey(w), true), new PublicKey(w), HYPE_MINT))), `create ${Math.min(ATA_BATCH, missing.length - i)} HYPE accounts`);
  for (const c of pending)
    await k.send(tx(distributeHolderChunk(k.program, mint, k.authority.publicKey, { epoch, chunkIndex: c.index, entries: c.entries, proof: c.proof })), `pay chunk ${c.index}`);
  return { paidChunks: pending.length, createdAccounts: missing.length };
}

/** Rebuild an open epoch's chunks from the funded candidate rows stored before funding. */
async function storedChunks(k: KeeperContext, mint: PublicKey, epoch: bigint) {
  const rows = (await k.db.query(
    "SELECT wallet_address,token_balance::text,reward_amount::text,chunk_index,merkle_proof FROM holder_snapshot_candidate_rows WHERE mint_address=$1 AND epoch=$2 ORDER BY chunk_index",
    [mint.toBase58(), epoch.toString()],
  )).rows;
  const chunks = new Map<number, { index: number; entries: { wallet: string; tokenBalance: bigint; reward: bigint }[]; proof: Buffer[] }>();
  for (const r of rows) {
    const index = Number(r.chunk_index);
    const chunk = chunks.get(index) ?? { index, entries: [], proof: (r.merkle_proof as string[]).map((h) => Buffer.from(h, "hex")) };
    chunk.entries.push({ wallet: String(r.wallet_address), tokenBalance: BigInt(String(r.token_balance)), reward: BigInt(String(r.reward_amount)) });
    chunks.set(index, chunk);
  }
  for (const c of chunks.values()) c.entries.sort((a, b) => Buffer.compare(new PublicKey(a.wallet).toBuffer(), new PublicKey(b.wallet).toBuffer()));
  return [...chunks.values()];
}

async function finishOpenEpoch(k: KeeperContext, mint: PublicKey, epoch: bigint) {
  const address = holderEpochAddress(k.program, mint, epoch);
  const info = await k.connection.getAccountInfo(address, "confirmed");
  if (!info) return "none";
  const state = decodeRewardEpoch(info.data);
  if (state.paidChunks < state.chunkCount) {
    const chunks = await storedChunks(k, mint, epoch);
    if (chunks.length !== state.chunkCount) throw Error(`Epoch ${epoch} has ${state.chunkCount} chunks on-chain but ${chunks.length} stored`);
    if (!k.dryRun) await payChunks(k, mint, epoch, chunks, state.isPaid);
  }
  if (k.dryRun) return "open";
  await k.send(tx(closeHolderEpoch(k.program, mint, k.authority.publicKey, epoch)), `close epoch ${epoch}`);
  await k.reindex();
  return "closed";
}

async function persistPlan(k: KeeperContext, plan: HolderEpochPlan) {
  const carryAfter = Object.fromEntries([...plan.carryOut].map(([w, v]) => [w, v.toString()]));
  const carryOrigins = Object.fromEntries([...plan.carryOrigins].map(([w, o]) => [w, { epoch: o.epoch.toString(), snapshotSlot: o.snapshotSlot.toString(), tokenBalance: o.tokenBalance.toString() }]));
  const snapshotBalances = Object.fromEntries(plan.snapshotBalances.map((h) => [h.wallet, h.tokenBalance.toString()]));
  await k.db.query("BEGIN");
  try {
    await k.db.query("DELETE FROM holder_snapshot_candidates WHERE mint_address=$1 AND epoch=$2 AND status='prepared'", [plan.mint, plan.epoch.toString()]);
    await k.db.query(
      "INSERT INTO holder_snapshot_candidates(mint_address,epoch,snapshot_slot,snapshot_hash,merkle_root,funded_amount,allocated_amount,chunk_count,carry_after,carry_origins,snapshot_balances) VALUES($1,$2,$3,$4,$5,$6,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb)",
      [plan.mint, plan.epoch.toString(), plan.snapshotSlot.toString(), plan.snapshotHash.toString("hex"), plan.root!.toString("hex"), plan.fundedAmount.toString(), plan.chunks.length, JSON.stringify(carryAfter), JSON.stringify(carryOrigins), JSON.stringify(snapshotBalances)],
    );
    for (const c of plan.chunks)
      for (const e of c.entries)
        await k.db.query(
          "INSERT INTO holder_snapshot_candidate_rows(mint_address,epoch,wallet_address,token_balance,reward_amount,leaf_hash,merkle_proof,chunk_index,new_account,origin_epoch,origin_snapshot_slot) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11)",
          [plan.mint, plan.epoch.toString(), e.wallet, e.tokenBalance.toString(), e.reward.toString(), c.leaf.toString("hex"), JSON.stringify(c.proof.map((p) => p.toString("hex"))), c.index, e.newAccount, e.originEpoch?.toString() ?? null, e.originSnapshotSlot?.toString() ?? null],
        );
    await k.db.query("COMMIT");
  } catch (e) {
    await k.db.query("ROLLBACK");
    throw e;
  }
}

export async function runHolderPayouts(k: KeeperContext, token: { mint: string; dbcPool: string }) {
  const mint = new PublicKey(token.mint), a = distributorAddresses(k.program, mint);
  const readPool = async () => {
    const info = await k.connection.getAccountInfo(a.feePool, "confirmed");
    if (!info?.owner.equals(k.program)) throw Error("Distributor fee pool missing");
    return decodeFeePool(info.data);
  };
  let pool = await readPool();
  if (pool.creatorBpsOfRemaining === 10_000) return { mint: token.mint, skipped: "creator keeps 100% of the 80% allocation" };

  // 1. Never open a new epoch while an earlier one is still paying out.
  if (pool.nextEpoch > 0n && (await finishOpenEpoch(k, mint, pool.nextEpoch - 1n)) === "open")
    return { mint: token.mint, skipped: "previous epoch still open (dry run)" };

  // 2. Move accrued Meteora fees into the distributor (20% HYMET / creator / holders on-chain). Right after graduation
  //    the last DBC fees are drained first and the canonical DAMM v2 pool is registered and settled in the same run,
  //    before the snapshot and payouts, so a slow payout step cannot delay registration.
  //    Every fee-pool-owned DAMM v2 position with pending fees is then settled, largest first, one per transaction,
  //    until none is left (bounded per run; the rest wait for the next run).
  try {
    for (let pass = 0; pass < MAX_SETTLEMENTS_PER_RUN; pass++) {
      const settle = await settlementInstructions(k.connection, k.program, mint, new PublicKey(token.dbcPool), k.platform, k.authority.publicKey, k.authority.publicKey);
      if (settle.nothingToCollect) {
        k.log("settlement skipped", { mint: token.mint, source: settle.source, reason: "no collectible fees" });
        break;
      }
      const settleTx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ...settle.instructions);
      if (k.dryRun) await k.simulate(settleTx, `settle ${settle.source}`);
      else await k.send(settleTx, `settle ${settle.source}`);
      if (k.dryRun || (settle.source === "dbc" && !settle.dammDue)) break;
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    k.log("settlement skipped", message);
    k.onSettlementError?.(token.mint, message);
  }
  pool = await readPool();
  // No holder can reach a payout threshold when the whole undistributed pool (which bounds carry) is below the
  // smallest one: skip the snapshot, the heaviest RPC read.
  const policy = k.policy ?? HOLDER_PAYOUT_POLICY;
  const smallest = policy.minPayout < policy.minPayoutNewAccount ? policy.minPayout : policy.minPayoutNewAccount;
  if (pool.holderUnallocated < smallest) return { mint: token.mint, epoch: pool.nextEpoch.toString(), skipped: "undistributed holder rewards below the payout minimum" };
  if (k.payoutIntervalSeconds && pool.lastSnapshotSlot > 0n) {
    // Unknown time never pays early: this run skips, the next one retries, and a lasting failure raises payout-overdue.
    const last = await k.connection.getBlockTime(Number(pool.lastSnapshotSlot)).catch(() => null);
    if (last === null) return { mint: token.mint, epoch: pool.nextEpoch.toString(), skipped: "last snapshot time unavailable; retrying next run" };
    const due = last + k.payoutIntervalSeconds;
    if ((k.now?.() ?? Date.now() / 1000) < due) return { mint: token.mint, epoch: pool.nextEpoch.toString(), skipped: `next holder payout due after ${new Date(due * 1000).toISOString()}` };
  }

  const now = k.now?.() ?? Date.now() / 1000;
  if (k.payoutIntervalSeconds && emptySnapshotStillCurrent(k.emptySnapshots?.get(token.mint), pool.holderUnallocated, now, k.payoutIntervalSeconds))
    return { mint: token.mint, epoch: pool.nextEpoch.toString(), payouts: 0, skipped: "no holder reached the payout minimum at the last snapshot; amounts carry over" };

  // 3. One consistent snapshot: every token account of the mint read at one RPC context slot.
  const snapshot = await k.connection.getProgramAccounts(TOKEN_PROGRAM_ID, {
    commitment: "confirmed",
    withContext: true,
    filters: [{ dataSize: 165 }, { memcmp: { offset: 0, bytes: mint.toBase58() } }],
  });
  const accounts = snapshot.value.map((x) => decodeTokenAccount(x.account.data as Buffer)).filter((x) => x !== null);
  const holders = eligibleHolders(accounts, [k.platform.toBase58(), a.feePool.toBase58()]);
  const carryRows = (await k.db.query("SELECT wallet_address,amount::text,origin_epoch::text,origin_snapshot_slot::text,origin_token_balance::text FROM holder_reward_carry WHERE mint_address=$1", [token.mint])).rows;
  const carry = new Map(carryRows.map((r) => [String(r.wallet_address), BigInt(String(r.amount))]));
  const carryOrigins = new Map<string, CarryOrigin>(carryRows.filter((r) => r.origin_epoch !== null && r.origin_epoch !== undefined).map((r) => [String(r.wallet_address), { epoch: BigInt(String(r.origin_epoch)), snapshotSlot: BigInt(String(r.origin_snapshot_slot)), tokenBalance: BigInt(String(r.origin_token_balance)) }]));
  const holding = new Set(holders.map((h) => h.wallet));
  const have = await existingAccounts(k.connection, [...new Set([...holding, ...carry.keys()])]);
  // A wallet that no longer holds is paid only when its balance at the allocating snapshot is proven against the hash
  // committed on-chain. Anything unproven stays in the ledger, attributed to that wallet.
  const proven = new Set<string>(), proofs = new Map();
  let unverifiedSellers = 0;
  for (const [wallet, owed] of carry) {
    if (holding.has(wallet) || owed < (have.has(wallet) ? policy.minPayout : policy.minPayoutNewAccount)) continue;
    const origin = carryOrigins.get(wallet);
    const problem = origin ? await verifyCarryOrigin(k, token.mint, wallet, origin, proofs).catch((e) => `verification failed: ${e instanceof Error ? e.message : String(e)}`) : "no recorded origin snapshot";
    if (problem) { unverifiedSellers++; k.log("seller carry not paid", { mint: token.mint, wallet, reason: problem }); }
    else proven.add(wallet);
  }
  const plan = planHolderEpoch({ mint: token.mint, epoch: pool.nextEpoch, snapshotSlot: snapshot.context.slot, available: pool.holderUnallocated, holders, carry, carryOrigins, sellerVerified: (w) => proven.has(w), hasHypeAccount: (w) => have.has(w), policy: k.policy });
  const cost = payoutCost({ payouts: plan.payouts.length, newAccounts: plan.payouts.filter((p) => p.newAccount).length });
  const summary = { mint: token.mint, epoch: plan.epoch.toString(), snapshotSlot: snapshot.context.slot, holders: holders.length, payouts: plan.payouts.length, sellerPayouts: plan.payouts.filter((p) => p.originEpoch !== undefined).length, unverifiedSellers, chunks: plan.chunks.length, fundedHype: plan.fundedAmount.toString(), carriedHype: [...plan.carryOut.values()].reduce((s, v) => s + v, 0n).toString(), costLamports: cost.total.toString() };
  if (!plan.payouts.length) {
    if (!k.dryRun) k.emptySnapshots?.set(token.mint, { at: now, unallocated: pool.holderUnallocated.toString() });
    return { ...summary, skipped: "no holder reached the payout minimum; amounts carry over" };
  }
  const needed = cost.total + cost.refundableEpochRent + KEEPER_SOL_HEADROOM_LAMPORTS;
  const balance = BigInt(await k.connection.getBalance(k.authority.publicKey, "confirmed"));
  if (balance < needed) throw Error(`Keeper holds ${balance} lamports; funding epoch ${plan.epoch} needs ${needed}. Top up the keeper key`);

  // 4. Commit the root, then push. The funded epoch is indexed before any payout so every
  //    HolderPaid event matches a stored entitlement. The program requires snapshot_slot < the
  //    executing slot, and preflight runs at the confirmed slot, so wait until it has moved past.
  for (let i = 0; BigInt(await k.connection.getSlot("confirmed")) <= plan.snapshotSlot; i++) {
    if (i >= 60) throw Error(`Confirmed slot has not passed snapshot slot ${plan.snapshotSlot}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const fund = tx(fundDistributorEpoch(k.program, mint, k.authority.publicKey, { epoch: plan.epoch, snapshotSlot: plan.snapshotSlot, snapshotHash: plan.snapshotHash.toString("hex"), root: plan.root!.toString("hex"), amount: plan.fundedAmount, chunkCount: plan.chunks.length }));
  if (k.dryRun) {
    await k.simulate(fund, `fund epoch ${plan.epoch}`);
    return { ...summary, dryRun: true };
  }
  k.emptySnapshots?.set(token.mint, null);
  await persistPlan(k, plan);
  await k.send(fund, `fund epoch ${plan.epoch}`);
  await k.reindex();
  const paid = await payChunks(k, mint, plan.epoch, plan.chunks, () => false);
  await k.send(tx(closeHolderEpoch(k.program, mint, k.authority.publicKey, plan.epoch)), `close epoch ${plan.epoch}`);
  await k.reindex();
  return { ...summary, ...paid, closed: true };
}
