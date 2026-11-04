import { testNetworkRequested } from "./app-network";
import { query } from "./db";
import { holderPayoutsLive } from "./launch-mode";
import { HYPE_MINT } from "./quote-assets";

/**
 * "Configured" is an owner setting; "verified" is evidence. A Mainnet payout counts as verified only when the indexer has
 * recorded a confirmed HolderPaid event for a token of the configured distributor. A test network never counts.
 */
export async function holderRewardsStatus(env: Record<string, string | undefined> = process.env) {
  const configured = holderPayoutsLive(env);
  const program = env.HYMET_DISTRIBUTOR_PROGRAM_ID;
  if (testNetworkRequested() || !program) return { configured, mainnetPayoutVerified: false, mainnetPayoutsIndexed: 0, lastMainnetPayoutAt: null };
  const row = (await query<{ count: number; last_at: Date | null }>(
    `SELECT count(*)::int AS count, max(c.claimed_at) AS last_at
       FROM claims c JOIN tokens t USING (mint_address)
      WHERE c.claim_type='holder' AND t.distributor_program_id=$1 AND t.quote_mint=$2`,
    [program, HYPE_MINT.toBase58()],
  )).rows[0];
  const count = Number(row?.count ?? 0);
  return { configured, mainnetPayoutVerified: count > 0, mainnetPayoutsIndexed: count, lastMainnetPayoutAt: row?.last_at ?? null };
}
