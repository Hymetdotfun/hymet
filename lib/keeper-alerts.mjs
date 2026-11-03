// Health rules for the holder payout keeper (runbook K5). Pure: scripts/keeper-alerts.mjs gathers the inputs.

export const KEEPER_ALERT_LIMITS = Object.freeze({
  /** Top up below 0.05 SOL. */
  minLamports: 50_000_000n,
  /** The periodic run is every few minutes; no successful full run for this long means it is down. */
  maxStatusAgeMs: 30 * 60_000,
  /** An epoch still open 48 h (nominal 400 ms slots) after its snapshot. */
  maxOpenEpochSlots: 432_000n,
  /** A just-funded epoch is indexed by the same keeper run; give it this long before calling it unexpected. */
  indexGraceSlots: 1_500n,
});

/**
 * @param {{ now: number, slot: bigint, keeperLamports: bigint, status: { at: string, ok: boolean, errors?: unknown[] } | null,
 *   pools: { mint: string, nextEpoch: bigint, openEpoch: { number: bigint, snapshotSlot: bigint } | null }[],
 *   indexedEpochs: Map<string, Set<string>> }} input
 * @returns {{ code: string, message: string, mint?: string }[]}
 */
export function keeperAlerts(input, limits = KEEPER_ALERT_LIMITS) {
  const alerts = [];
  if (input.keeperLamports < limits.minLamports)
    alerts.push({ code: "keeper-sol-low", message: `Keeper holds ${input.keeperLamports} lamports (alert below ${limits.minLamports}); top it up` });
  if (!input.status) alerts.push({ code: "keeper-no-status", message: "No keeper run status recorded yet" });
  else {
    const age = input.now - Date.parse(input.status.at);
    if (!(age <= limits.maxStatusAgeMs)) alerts.push({ code: "keeper-stale", message: `Last full keeper run finished ${Math.round(age / 60_000)} min ago` });
    if (!input.status.ok) alerts.push({ code: "keeper-failed", message: `Last keeper run had errors: ${JSON.stringify(input.status.errors ?? []).slice(0, 500)}` });
  }
  for (const pool of input.pools) {
    const open = pool.openEpoch;
    if (open && input.slot - open.snapshotSlot > limits.maxOpenEpochSlots)
      alerts.push({ code: "epoch-open-too-long", mint: pool.mint, message: `Epoch ${open.number} has been open since snapshot slot ${open.snapshotSlot}` });
    // Every funded epoch must match a root the keeper prepared (the indexer records only those). One that does not was
    // funded by someone else holding the keeper key: stop the keeper and rotate the key in the owner console.
    const indexed = input.indexedEpochs.get(pool.mint) ?? new Set();
    for (let e = 0n; e < pool.nextEpoch; e++) {
      if (indexed.has(e.toString())) continue;
      if (open && open.number === e && input.slot - open.snapshotSlot <= limits.indexGraceSlots) continue;
      alerts.push({ code: "unexpected-epoch", mint: pool.mint, message: `Epoch ${e} is funded on-chain but matches no keeper-prepared root; possible keeper key compromise` });
    }
  }
  return alerts;
}
