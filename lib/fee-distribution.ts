import { sha256 } from "@noble/hashes/sha256";
import { Buffer } from "buffer";
import bs58 from "bs58";

export const PLATFORM_SHARE_BPS = 2_000n;
export const BPS_DENOMINATOR = 10_000n;
const LEAF_DOMAIN = Buffer.from("HYMET_HOLDER_REWARD_V1\0", "utf8");

export type Distribution = {
  distributable: bigint;
  hymet: bigint;
  creator: bigint;
  holders: bigint;
  remainder: bigint;
};

/** Uses integer base units only. The platform share is always separated first. */
export function splitDistributable(
  distributable: bigint,
  creatorShareOfRemainingBps: number,
): Distribution {
  if (distributable < 0n)
    throw new Error("Distributable fees cannot be negative");
  if (
    !Number.isInteger(creatorShareOfRemainingBps) ||
    creatorShareOfRemainingBps < 0 ||
    creatorShareOfRemainingBps > 10_000
  )
    throw new Error("Creator share must be between 0 and 10,000 basis points");
  const hymet = (distributable * PLATFORM_SHARE_BPS) / BPS_DENOMINATOR;
  const remainder = distributable - hymet;
  const creator =
    (remainder * BigInt(creatorShareOfRemainingBps)) / BPS_DENOMINATOR;
  const holders = remainder - creator;
  if (hymet + creator + holders !== distributable)
    throw new Error("Fee accounting invariant failed");
  return { distributable, hymet, creator, holders, remainder };
}

export type Holder = { wallet: string; tokenBalance: bigint };
export type HolderEntitlement = Holder & {
  reward: bigint;
  leaf: Buffer;
  proof: Buffer[];
};
export type HolderSnapshot = {
  totalBalance: bigint;
  snapshotHash: Buffer;
  fundedAmount: bigint;
  allocatedAmount: bigint;
  unallocatedRemainder: bigint;
  root: Buffer;
  entitlements: HolderEntitlement[];
};

function hash(data: Buffer) {
  return Buffer.from(sha256(data));
}
function u64(value: bigint) {
  if (value < 0n || value > 0xffff_ffff_ffff_ffffn)
    throw new Error("Value exceeds u64");
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(value);
  return out;
}
function keyBytes(value: string) {
  const bytes = Buffer.from(bs58.decode(value));
  if (bytes.length !== 32) throw new Error("Expected a 32-byte Solana address");
  return bytes;
}
function parent(a: Buffer, b: Buffer) {
  return Buffer.compare(a, b) <= 0
    ? hash(Buffer.concat([a, b]))
    : hash(Buffer.concat([b, a]));
}

/**
 * Build a reproducible funded snapshot. Caller must pass balances fetched at one
 * confirmed RPC context slot and persist that slot alongside the returned root.
 * Every leaf binds mint, epoch, wallet, token units and HYPE reward units.
 */
export function buildHolderSnapshot(input: {
  mint: string;
  epoch: bigint;
  fundedAmount: bigint;
  holders: Holder[];
}): HolderSnapshot {
  if (input.epoch < 0n || input.fundedAmount < 0n)
    throw new Error("Epoch and funding must be non-negative");
  const mint = keyBytes(input.mint);
  const unique = new Set<string>();
  const holders = input.holders
    .map((h) => ({ ...h, walletBytes: keyBytes(h.wallet) }))
    .filter((h) => h.tokenBalance > 0n)
    .sort((a, b) => Buffer.compare(a.walletBytes, b.walletBytes));
  if (!holders.length) throw new Error("A holder snapshot cannot be empty");
  for (const h of holders) {
    const wallet = h.walletBytes.toString("hex");
    if (unique.has(wallet))
      throw new Error("Duplicate wallet in holder snapshot");
    unique.add(wallet);
    if (h.tokenBalance > 0xffff_ffff_ffff_ffffn)
      throw new Error("Token balance exceeds SPL u64");
  }
  const totalBalance = holders.reduce((sum, h) => sum + h.tokenBalance, 0n);
  const snapshotHash = hash(
    Buffer.concat([
      Buffer.from("HYMET_HOLDER_SNAPSHOT_V1\0", "utf8"),
      mint,
      u64(input.epoch),
      ...holders.flatMap((h) => [h.walletBytes, u64(h.tokenBalance)]),
    ]),
  );
  const rows = holders.map((h) => {
    const reward = (input.fundedAmount * h.tokenBalance) / totalBalance;
    const leaf = hash(
      Buffer.concat([
        LEAF_DOMAIN,
        mint,
        u64(input.epoch),
        h.walletBytes,
        u64(h.tokenBalance),
        u64(reward),
      ]),
    );
    return {
      wallet: h.wallet,
      walletBytes: h.walletBytes,
      tokenBalance: h.tokenBalance,
      reward,
      leaf,
      proof: [] as Buffer[],
    };
  });
  let level = rows.map((r, index) => ({ hash: r.leaf, indices: [index] }));
  while (level.length > 1) {
    const next: typeof level = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i],
        right = level[i + 1];
      if (!right) {
        next.push(left);
        continue;
      }
      for (const index of left.indices) rows[index].proof.push(right.hash);
      for (const index of right.indices) rows[index].proof.push(left.hash);
      next.push({
        hash: parent(left.hash, right.hash),
        indices: [...left.indices, ...right.indices],
      });
    }
    level = next;
  }
  const allocatedAmount = rows.reduce((sum, r) => sum + r.reward, 0n);
  if (allocatedAmount > input.fundedAmount)
    throw new Error("Entitlements exceed funded HYPE");
  return {
    totalBalance,
    snapshotHash,
    fundedAmount: input.fundedAmount,
    allocatedAmount,
    unallocatedRemainder: input.fundedAmount - allocatedAmount,
    root: level[0].hash,
    entitlements: rows.map(({ wallet, tokenBalance, reward, leaf, proof }) => ({
      wallet,
      tokenBalance,
      reward,
      leaf,
      proof,
    })),
  };
}

export function verifyHolderProof(input: {
  mint: string;
  epoch: bigint;
  wallet: string;
  tokenBalance: bigint;
  reward: bigint;
  proof: Buffer[];
  root: Buffer;
}) {
  let current = hash(
    Buffer.concat([
      LEAF_DOMAIN,
      keyBytes(input.mint),
      u64(input.epoch),
      keyBytes(input.wallet),
      u64(input.tokenBalance),
      u64(input.reward),
    ]),
  );
  for (const sibling of input.proof) current = parent(current, sibling);
  return current.equals(input.root);
}
