import { NextRequest, NextResponse } from "next/server";
import { databaseConfigured, query } from "../../../lib/db";
import { HYPE_MINT } from "../../../lib/quote-assets";
import { PublicKey } from "@solana/web3.js";
import { verifiedDistributor } from "../../../lib/distributor-readiness";
import { creatorLaunchStatuses } from "../../../lib/launch-status";
import { HOLDER_REWARDS_CONFIGURED_NOTE, HOLDER_REWARDS_DISABLED_NOTE, HOLDER_REWARDS_PENDING_NOTE, HOLDER_REWARDS_VERIFIED_NOTE, NATIVE_SPLIT, holderPayoutsLive, launchMode } from "../../../lib/launch-mode";
import { HOLDER_PAYOUT_POLICY } from "../../../lib/holder-payouts.mjs";
import { holderRewardsStatus } from "../../../lib/holder-payout-status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function amount(value: string | null | undefined) {
  if (!value) return "0.000000000";
  const n = BigInt(value);
  return `${n / 1_000_000_000n}.${(n % 1_000_000_000n).toString().padStart(9, "0")}`;
}

/** Database-indexed data is labeled as such; this route never invents on-chain balances. */
export async function GET(request: NextRequest) {
  if (!databaseConfigured())
    return NextResponse.json(
      {
        indexed: false,
        chainVerified: false,
        error: "PostgreSQL is not configured",
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  const mint = request.nextUrl.searchParams.get("mint");
  const wallet = request.nextUrl.searchParams.get("wallet");
  try {
    const distributor = await verifiedDistributor();
    const totals = await query<{
      accrued: string;
      hymet: string;
      creator: string;
      holders: string;
      settled_at: Date | null;
    }>(
      `SELECT COALESCE((SELECT sum(distributable_amount) FROM fee_accruals WHERE quote_mint=$1 AND ($2::text IS NULL OR mint_address=$2)),0)::text AS accrued,
              COALESCE((SELECT sum(hymet_amount) FROM fee_settlements WHERE quote_mint=$1 AND ($2::text IS NULL OR mint_address=$2)),0)::text AS hymet,
              COALESCE((SELECT sum(creator_amount) FROM fee_settlements WHERE quote_mint=$1 AND ($2::text IS NULL OR mint_address=$2)),0)::text AS creator,
              COALESCE((SELECT sum(holder_amount) FROM fee_settlements WHERE quote_mint=$1 AND ($2::text IS NULL OR mint_address=$2)),0)::text AS holders,
              (SELECT max(settled_at) FROM fee_settlements WHERE quote_mint=$1 AND ($2::text IS NULL OR mint_address=$2)) AS settled_at`,
      [HYPE_MINT.toBase58(), mint],
    );
    const claimable = wallet
      ? await query<{ amount: string }>(
          `SELECT COALESCE(sum(e.reward_amount-e.claimed_amount),0)::text AS amount FROM holder_reward_entitlements e
       JOIN tokens t USING (mint_address)
       JOIN holder_reward_epochs h USING (mint_address,epoch)
       WHERE e.wallet_address=$1 AND e.quote_mint=$2 AND t.quote_mint=$2 AND h.quote_mint=$2 AND h.status IN ('funded','finalized')`,
          [wallet, HYPE_MINT.toBase58()],
        )
      : null;
    // Holder rewards are pushed by the keeper; wallets never claim. Report pending and paid amounts.
    const holderPayouts = wallet && distributor
      ? (await query<{ mint_address: string; epoch: string; reward_amount: string; claimed_amount: string; signature: string | null }>(
          `SELECT e.mint_address,e.epoch::text,e.reward_amount::text,e.claimed_amount::text,
                  (SELECT c.transaction_signature FROM claims c WHERE c.entitlement_id=e.id LIMIT 1) AS signature
             FROM holder_reward_entitlements e JOIN holder_reward_epochs h USING(mint_address,epoch)
            WHERE e.wallet_address=$1 AND e.quote_mint=$2 AND h.quote_mint=$2 ORDER BY h.epoch DESC LIMIT 50`,
          [new PublicKey(wallet).toBase58(), HYPE_MINT.toBase58()],
        )).rows.map((r) => ({ mint: r.mint_address, epoch: r.epoch, reward: amount(r.reward_amount), paid: r.claimed_amount === r.reward_amount, signature: r.signature }))
      : [];
    const row = totals.rows[0];
    const payoutStatus = await holderRewardsStatus();
    // Creator view of distributor launches: claimable share, automatic settlement/payout/migration status.
    const creatorTokens = wallet && distributor ? await creatorLaunchStatuses(distributor.connection, distributor.program, new PublicKey(wallet).toBase58()) : [];
    let preparedEpochs:{mint:string;epoch:string;fundedHype:string}[]=[];
    if(wallet && distributor) {
      const state=await distributor.connection.getAccountInfo(distributor.config,'confirmed');
      if(state && new PublicKey(state.data.subarray(72,104)).toBase58()===wallet) {
        const prepared=await query<{mint_address:string;epoch:string;funded_amount:string}>("SELECT c.mint_address,c.epoch::text,c.funded_amount::text FROM holder_snapshot_candidates c JOIN tokens t USING(mint_address) WHERE c.status='prepared' AND t.distributor_program_id=$1 ORDER BY c.created_at LIMIT 50",[distributor.program.toBase58()]);
        preparedEpochs=prepared.rows.map(e=>({mint:e.mint_address,epoch:e.epoch,fundedHype:amount(e.funded_amount)}));
      }
    }
    return NextResponse.json(
      {
        indexed: true,
        source: "postgres-index",
        chainVerified: Boolean(distributor),
        distributorEnabled: Boolean(distributor),
        launchMode: launchMode(),
        feeSplit: distributor ? null : NATIVE_SPLIT,
        // "automatic" means the payout keeper is owner-configured, never inferred from the program alone, and is not
        // evidence of a payout. Only mainnetPayoutVerified reports that one actually happened.
        holderRewards: { enabled: Boolean(distributor), automatic: Boolean(distributor) && holderPayoutsLive(), intervalHours: HOLDER_PAYOUT_POLICY.intervalHours, mainnetPayoutVerified: payoutStatus.mainnetPayoutVerified, mainnetPayoutsIndexed: payoutStatus.mainnetPayoutsIndexed, lastMainnetPayoutAt: payoutStatus.lastMainnetPayoutAt },
        quote: "HYPE",
        totals: {
          accrued: amount(row?.accrued),
          hymet: amount(row?.hymet),
          creator: amount(row?.creator),
          holders: amount(row?.holders),
          lastSettlementAt: row?.settled_at ?? null,
        },
        claimable: claimable ? amount(claimable.rows[0]?.amount) : null,
        holderPayouts,
        creatorTokens,
        preparedEpochs,
        distributorProgramId: distributor?.program.toBase58() ?? null,
        note: !distributor
          ? HOLDER_REWARDS_DISABLED_NOTE
          : holderPayoutsLive()
            ? (payoutStatus.mainnetPayoutVerified ? HOLDER_REWARDS_VERIFIED_NOTE : HOLDER_REWARDS_CONFIGURED_NOTE)
            : HOLDER_REWARDS_PENDING_NOTE,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json(
      { indexed: false, chainVerified: false, error: "Fee index unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
