// Exact holder-reward reconciliation. Pure: the caller supplies chain state and database rows, all amounts in base units.
const sum = (rows, key) => rows.reduce((total, row) => total + BigInt(row[key] ?? 0), 0n);

export function reconcileHolderRewards({ chain, vault, settlements, claims, epochs, entitlements, carry }) {
  const creatorClaims = claims.filter((c) => c.claim_type === "creator");
  const holderClaims = claims.filter((c) => c.claim_type === "holder");
  const funded = sum(epochs, "funded_amount");
  const checks = [];
  const equal = (name, left, right) => checks.push({ name, ok: left === right, left, right });
  equal("settled total, chain vs database", chain.totalSettled, sum(settlements, "distributable_amount"));
  equal("platform total, chain vs database", chain.totalPlatform, sum(settlements, "hymet_amount"));
  equal("settled = platform + creator + holders", sum(settlements, "distributable_amount"), sum(settlements, "hymet_amount") + sum(settlements, "creator_amount") + sum(settlements, "holder_amount"));
  equal("creator claimable, chain vs settled - claimed", chain.creatorClaimable, sum(settlements, "creator_amount") - sum(creatorClaims, "amount"));
  equal("holder unallocated, chain vs settled - funded", chain.holderUnallocated, sum(settlements, "holder_amount") - funded);
  equal("holder reserved, chain vs funded - paid", chain.holderReserved, funded - sum(holderClaims, "amount") - sum(epochs.filter((e) => e.status === "closed"), "returned_amount"));
  equal("vault vs recorded liabilities", vault, chain.creatorClaimable + chain.holderUnallocated + chain.holderReserved);
  equal("entitlements vs funded", sum(entitlements, "reward_amount"), funded);
  equal("entitlements paid vs holder claims", sum(entitlements, "claimed_amount"), sum(holderClaims, "amount"));
  equal("next epoch vs epochs recorded", chain.nextEpoch, BigInt(epochs.length));
  const carried = sum(carry, "amount");
  checks.push({ name: "attributed carry within the holder pool", ok: carried <= chain.holderUnallocated, left: carried, right: chain.holderUnallocated });
  return { ok: checks.every((c) => c.ok), checks, attributedCarry: carried, unassigned: chain.holderUnallocated - carried };
}
