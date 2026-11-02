// Server-only: concise automation status of a creator's distributor launches for the Fees page. Creator claimable
// amounts and curve state are read on-chain; settlement and payout history come from the confirmed-event index.
import { PublicKey, type Connection } from "@solana/web3.js";
import { DYNAMIC_BONDING_CURVE_PROGRAM_ID, DynamicBondingCurveClient, type PoolConfig, type VirtualPool } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { query } from "./db";
import { decodeFeePool, distributorAddresses } from "./distributor-engine";
import { syncGraduation } from "./graduation";

export type LaunchStatus = {
  mint: string;
  ticker: string;
  name: string;
  imageUrl: string | null;
  creatorBps: number;
  creatorClaimable: string | null;
  venue: "DBC" | "DAMM v2";
  migration: { state: "bonding" | "graduating" | "graduated" | "unknown"; percent?: number };
  lastSettlementAt: string | null;
  holdersPaid: string;
  holdersPaidCount: number;
  lastPayoutAt: string | null;
};

const hype = (n: bigint) => `${n / 1_000_000_000n}.${(n % 1_000_000_000n).toString().padStart(9, "0")}`;

export async function creatorLaunchStatuses(c: Connection, program: PublicKey, wallet: string): Promise<LaunchStatus[]> {
  const sql = `SELECT t.mint_address,t.ticker,t.name,t.artwork_uri,t.creator_share_of_remaining_bps,
      (SELECT p.pool_address FROM pools p WHERE p.mint_address=t.mint_address AND p.protocol='meteora_dbc') AS dbc_pool,
      (SELECT p.pool_address FROM pools p WHERE p.mint_address=t.mint_address AND p.protocol='meteora_damm_v2' AND p.status='active') AS damm_pool,
      (SELECT max(s.settled_at) FROM fee_settlements s WHERE s.mint_address=t.mint_address) AS last_settled,
      (SELECT COALESCE(sum(e.claimed_amount),0)::text FROM holder_reward_entitlements e WHERE e.mint_address=t.mint_address) AS holders_paid,
      (SELECT count(DISTINCT e.wallet_address) FROM holder_reward_entitlements e WHERE e.mint_address=t.mint_address AND e.claimed_amount>0)::int AS holders_paid_count,
      (SELECT max(x.claimed_at) FROM claims x WHERE x.mint_address=t.mint_address AND x.entitlement_id IS NOT NULL) AS last_payout
    FROM tokens t WHERE t.creator_wallet=$1 AND t.distributor_program_id=$2 ORDER BY t.created_at DESC LIMIT 50`;
  type Row = { mint_address: string; ticker: string; name: string; artwork_uri: string | null; creator_share_of_remaining_bps: number; dbc_pool: string | null; damm_pool: string | null; last_settled: Date | null; holders_paid: string; holders_paid_count: number; last_payout: Date | null };
  let rows = (await query<Row>(sql, [wallet, program.toBase58()])).rows;
  // Record verified graduations first so the venue is current; a failed check keeps the indexed state.
  const synced = await Promise.all(rows.filter((r) => r.dbc_pool && !r.damm_pool).map((r) => syncGraduation(c, r.mint_address).catch(() => undefined)));
  if (synced.some((s) => s?.status === "graduated")) rows = (await query<Row>(sql, [wallet, program.toBase58()])).rows;

  const feePools = rows.map((r) => distributorAddresses(program, new PublicKey(r.mint_address)).feePool);
  const pending = rows.filter((r) => r.dbc_pool && !r.damm_pool);
  const [poolInfos, dbcInfos] = await Promise.all([
    c.getMultipleAccountsInfo(feePools, "confirmed"),
    c.getMultipleAccountsInfo(pending.map((r) => new PublicKey(r.dbc_pool!)), "confirmed"),
  ]);
  const sdk = new DynamicBondingCurveClient(c, "confirmed");
  const curve = new Map<string, LaunchStatus["migration"]>();
  const states = dbcInfos.map((info) => (info?.owner.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID) ? sdk.program.coder.accounts.decode<VirtualPool>("virtualPool", info.data).poolState : undefined));
  const configs = await c.getMultipleAccountsInfo(states.map((s) => s?.config ?? PublicKey.default), "confirmed");
  pending.forEach((r, i) => {
    const s = states[i], info = configs[i];
    if (!s || !info?.owner.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID) || !s.baseMint.equals(new PublicKey(r.mint_address))) return curve.set(r.mint_address, { state: "unknown" });
    const cfg = sdk.program.coder.accounts.decode<PoolConfig>("poolConfig", info.data);
    const reserve = BigInt(s.quoteReserve.toString()), threshold = BigInt(cfg.migrationQuoteThreshold.toString());
    if (s.isMigrated === 1) return curve.set(r.mint_address, { state: "graduated" });
    const percent = threshold > 0n ? Math.min(100, Number((reserve * 10_000n) / threshold) / 100) : undefined;
    curve.set(r.mint_address, { state: reserve >= threshold ? "graduating" : "bonding", percent });
  });

  return rows.map((r, i) => {
    const info = poolInfos[i];
    let creatorClaimable: string | null = null;
    try { if (info?.owner.equals(program)) creatorClaimable = hype(decodeFeePool(info.data).creatorClaimable); } catch { /* unreadable fee pool stays unknown */ }
    return {
      mint: r.mint_address,
      ticker: r.ticker,
      name: r.name,
      imageUrl: r.artwork_uri,
      creatorBps: Number(r.creator_share_of_remaining_bps),
      creatorClaimable,
      venue: r.damm_pool ? "DAMM v2" : "DBC",
      migration: r.damm_pool ? { state: "graduated" } : curve.get(r.mint_address) ?? { state: "unknown" },
      lastSettlementAt: r.last_settled ? new Date(r.last_settled).toISOString() : null,
      holdersPaid: hype(BigInt(r.holders_paid)),
      holdersPaidCount: r.holders_paid_count,
      lastPayoutAt: r.last_payout ? new Date(r.last_payout).toISOString() : null,
    };
  });
}
