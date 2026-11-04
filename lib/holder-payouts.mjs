// Holder reward payout planning (shared by the app, tests and the keeper script).
// Pure functions: the caller supplies one confirmed token-account snapshot, the
// on-chain holder pool balance and the off-chain carry ledger; the result is a
// funded epoch whose Merkle root commits every payout before any HYPE moves.
import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

/** Mirrors the distributor program constants (MAX_CHUNK_ENTRIES, MAX_EPOCH_CHUNKS, EPOCH_EXPIRY_SLOTS). */
export const HOLDER_PAYOUT_POLICY = Object.freeze({
  intervalMinutes: 15,
  chunkSize: 6,
  maxChunks: 1024,
  expirySlots: 1_512_000n,
  // 0.01 HYPE to a holder that already has a HYPE account; 0.05 HYPE when the keeper
  // must create one (its ~0.0015 SOL rent is paid by HYMET's keeper).
  minPayout: 10_000_000n,
  minPayoutNewAccount: 50_000_000n,
});

const CHUNK_DOMAIN = Buffer.from("HYMET_HOLDER_PAYOUT_V2\0", "utf8");
const SNAPSHOT_DOMAIN = Buffer.from("HYMET_HOLDER_SNAPSHOT_V2\0", "utf8");
export const INCINERATOR = "1nc1nerator11111111111111111111111111111111";
const U64_MAX = 0xffff_ffff_ffff_ffffn;

const sha256 = (b) => createHash("sha256").update(b).digest();
const u64 = (n) => {
  if (n < 0n || n > U64_MAX) throw new Error("Value exceeds u64");
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
};
const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const keyBytes = (k) => {
  const b = Buffer.from(bs58.decode(k));
  if (b.length !== 32) throw new Error("Expected a 32-byte Solana address");
  return b;
};
const parent = (a, b) =>
  Buffer.compare(a, b) <= 0 ? sha256(Buffer.concat([a, b])) : sha256(Buffer.concat([b, a]));

/**
 * Eligible holders from raw SPL token accounts of one mint read at one slot.
 * Excluded: zero balances, frozen/uninitialized accounts, PDA (off-curve) owners such as
 * DBC/DAMM pool vaults and the distributor itself, the incinerator and any explicit exclusion.
 * Several token accounts of one owner are aggregated.
 */
export function eligibleHolders(accounts, exclude = []) {
  const excluded = new Set([INCINERATOR, ...exclude]);
  const balances = new Map();
  for (const a of accounts) {
    if (a.state !== 1 || a.amount <= 0n || excluded.has(a.owner)) continue;
    if (!PublicKey.isOnCurve(keyBytes(a.owner))) continue;
    balances.set(a.owner, (balances.get(a.owner) ?? 0n) + a.amount);
  }
  return [...balances]
    .map(([wallet, tokenBalance]) => ({ wallet, tokenBalance }))
    .sort((a, b) => Buffer.compare(keyBytes(a.wallet), keyBytes(b.wallet)));
}

/** Decode the fields the snapshot needs from a 165-byte SPL token account. */
export function decodeTokenAccount(data) {
  if (data.length < 165) return null;
  return {
    mint: bs58.encode(data.subarray(0, 32)),
    owner: bs58.encode(data.subarray(32, 64)),
    amount: data.readBigUInt64LE(64),
    state: data[108],
  };
}

export function chunkLeaf(mint, epoch, chunkIndex, entries) {
  return sha256(
    Buffer.concat([
      CHUNK_DOMAIN,
      keyBytes(mint),
      u64(epoch),
      u32(chunkIndex),
      Buffer.from([entries.length]),
      ...entries.flatMap((e) => [keyBytes(e.wallet), u64(e.tokenBalance), u64(e.reward)]),
    ]),
  );
}

export function verifyChunkProof(leaf, proof, root) {
  return proof.reduce((node, sibling) => parent(node, sibling), leaf).equals(root);
}

/**
 * Plan one epoch. `available` is FeePool.holder_unallocated read at the snapshot;
 * `carry` holds earlier accrued amounts that were below the payout threshold
 * (still inside holder_unallocated). New money is shared pro rata by balance;
 * accrued amounts at or above the threshold are paid, the rest carried forward.
 */
export function planHolderEpoch({
  mint,
  epoch,
  snapshotSlot,
  available,
  holders,
  carry = new Map(),
  hasHypeAccount,
  policy = HOLDER_PAYOUT_POLICY,
}) {
  const carriedIn = [...carry.values()].reduce((s, v) => s + v, 0n);
  if (carriedIn > available)
    throw new Error("Carry ledger exceeds the on-chain holder pool; refusing to plan");
  const budget = available - carriedIn;
  const totalBalance = holders.reduce((s, h) => s + h.tokenBalance, 0n);
  const snapshotHash = sha256(
    Buffer.concat([
      SNAPSHOT_DOMAIN,
      keyBytes(mint),
      u64(epoch),
      u64(BigInt(snapshotSlot)),
      ...holders.flatMap((h) => [keyBytes(h.wallet), u64(h.tokenBalance)]),
    ]),
  );
  const carryOut = new Map(carry);
  let shared = 0n;
  const candidates = [];
  for (const h of holders) {
    const share = totalBalance ? (budget * h.tokenBalance) / totalBalance : 0n;
    shared += share;
    const accrued = (carry.get(h.wallet) ?? 0n) + share;
    const newAccount = !hasHypeAccount(h.wallet);
    const threshold = newAccount ? policy.minPayoutNewAccount : policy.minPayout;
    if (accrued >= threshold) candidates.push({ ...h, reward: accrued, newAccount });
    else if (accrued > 0n) carryOut.set(h.wallet, accrued);
  }
  // A single epoch pays at most maxChunks * chunkSize holders; the largest are paid first
  // and the rest stay carried (still owed, still in the holder pool) for the next epoch.
  const capacity = policy.maxChunks * policy.chunkSize;
  candidates.sort((a, b) => (b.reward > a.reward ? 1 : b.reward < a.reward ? -1 : 0));
  const payouts = candidates.slice(0, capacity);
  for (const p of candidates.slice(capacity)) carryOut.set(p.wallet, p.reward);
  for (const p of payouts) carryOut.delete(p.wallet);
  payouts.sort((a, b) => Buffer.compare(keyBytes(a.wallet), keyBytes(b.wallet)));
  const fundedAmount = payouts.reduce((s, p) => s + p.reward, 0n);
  const carriedOut = [...carryOut.values()].reduce((s, v) => s + v, 0n);
  const dust = budget - shared; // rounding remainder stays unallocated for the next epoch
  if (fundedAmount + carriedOut + dust !== available)
    throw new Error("Holder payout accounting invariant failed");

  const chunks = [];
  for (let i = 0; i < payouts.length; i += policy.chunkSize) {
    const entries = payouts.slice(i, i + policy.chunkSize);
    chunks.push({ index: chunks.length, entries, leaf: chunkLeaf(mint, epoch, chunks.length, entries), proof: [] });
  }
  let level = chunks.map((c, i) => ({ hash: c.leaf, members: [i] }));
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const l = level[i], r = level[i + 1];
      if (!r) { next.push(l); continue; }
      for (const m of l.members) chunks[m].proof.push(r.hash);
      for (const m of r.members) chunks[m].proof.push(l.hash);
      next.push({ hash: parent(l.hash, r.hash), members: [...l.members, ...r.members] });
    }
    level = next;
  }
  return {
    mint,
    epoch,
    snapshotSlot: BigInt(snapshotSlot),
    snapshotHash,
    holderCount: holders.length,
    totalBalance,
    available,
    budget,
    fundedAmount,
    dust,
    payouts,
    carryOut,
    chunks,
    root: level[0]?.hash ?? null,
  };
}

/** SOL cost model for one epoch (lamports). Rent of the epoch account is refunded on close. */
export const LAMPORTS = Object.freeze({
  signature: 5_000n,
  // Read from Mainnet getMinimumBalanceForRentExemption on 2026-10-31: (128 + data bytes) * 5,080.
  hypeAccountRent: 1_488_440n,
  rentPerByte: 5_080n,
});
export function payoutCost({ payouts, newAccounts, chunkSize = HOLDER_PAYOUT_POLICY.chunkSize, accountsPerCreateTx = 8, priorityLamportsPerTx = 0n }) {
  const chunks = Math.ceil(payouts / chunkSize);
  const createTxs = Math.ceil(newAccounts / accountsPerCreateTx);
  const txs = BigInt(chunks + createTxs + 3); // + settle, fund, close
  const epochBytes = 8 + 32 + 8 + 8 + 32 + 32 + 8 + 8 + 4 + 4 + 1 + 4 + Math.ceil(chunks / 8);
  const epochRent = LAMPORTS.rentPerByte * BigInt(128 + epochBytes);
  const fees = txs * (LAMPORTS.signature + priorityLamportsPerTx);
  const accountRent = BigInt(newAccounts) * LAMPORTS.hypeAccountRent;
  return { transactions: Number(txs), fees, accountRent, total: fees + accountRent, refundableEpochRent: epochRent };
}
