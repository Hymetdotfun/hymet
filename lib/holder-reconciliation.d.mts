type Row = Record<string, unknown>;
export function reconcileHolderRewards(input: {
  chain: { totalSettled: bigint; totalPlatform: bigint; creatorClaimable: bigint; holderUnallocated: bigint; holderReserved: bigint; nextEpoch: bigint };
  vault: bigint;
  settlements: Row[];
  claims: Row[];
  epochs: Row[];
  entitlements: Row[];
  carry: Row[];
}): { ok: boolean; checks: { name: string; ok: boolean; left: bigint; right: bigint }[]; attributedCarry: bigint; unassigned: bigint };
