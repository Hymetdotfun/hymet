// Health rules and notification planning for the holder payout keeper. Pure: scripts/keeper-alerts.mjs gathers the
// inputs, keeps the state file and sends.

const MINUTE = 60_000, HOUR = 60 * MINUTE;

export const KEEPER_ALERT_LIMITS = Object.freeze({
  /** Top up below 0.05 SOL. */
  minLamports: 50_000_000n,
  /** The periodic run is every few minutes; no successful full run for this long means it is down. */
  maxStatusAgeMs: 30 * MINUTE,
  /** Slot windows below assume nominal 400 ms slots; limitsForSlotTime rescales them to the measured slot time. */
  /** The keeper retries an open epoch every run, so one still open 1 h after its snapshot is stuck. */
  maxOpenEpochSlots: 9_000n,
  /** A just-funded epoch is indexed by the same keeper run; give it this long before calling it unexpected. */
  indexGraceSlots: 1_500n,
  /** The 15 minute payout interval plus 45 minutes. Amounts carrying below the minimum are exempt. */
  payoutOverdueSlots: 9_000n,
  /** Below the smallest payout minimum (0.01 HYPE) no holder can be paid, so nothing is overdue. */
  minHolderPool: 10_000_000n,
});

/** The same real durations at the measured slot time. Anything implausible or unknown keeps the nominal windows. */
export function limitsForSlotTime(slotMs, limits = KEEPER_ALERT_LIMITS) {
  if (!Number.isFinite(slotMs) || slotMs < 100 || slotMs > 1_000) return limits;
  const scale = (slots) => (slots * 400n) / BigInt(Math.round(slotMs));
  return /** @type {typeof limits} */ ({ ...limits, maxOpenEpochSlots: scale(limits.maxOpenEpochSlots), indexGraceSlots: scale(limits.indexGraceSlots), payoutOverdueSlots: scale(limits.payoutOverdueSlots) });
}

/** Conditions that clear by themselves stay quiet for this long before the first notification. */
export const ALERT_POLICY = Object.freeze({
  holdoffMs: Object.freeze({
    "keeper-sol-low": 0,
    "keeper-no-status": 15 * MINUTE,
    "keeper-stale": 0,
    "keeper-failed": 10 * MINUTE,
    "keeper-unit-down": 10 * MINUTE,
    "migration-stalled": 15 * MINUTE,
    "settlement-stalled": 30 * MINUTE,
    "payout-overdue": HOUR,
    "epoch-open-too-long": 0,
    "unexpected-epoch": 0,
    "alert-check-failed": 15 * MINUTE,
  }),
  renotifyMs: 6 * HOUR,
  criticalRenotifyMs: HOUR,
  critical: Object.freeze(["unexpected-epoch"]),
});

const TITLES = Object.freeze({
  "keeper-sol-low": "Keeper SOL is low",
  "keeper-no-status": "Keeper has not reported",
  "keeper-stale": "Keeper has stopped running",
  "keeper-failed": "Keeper run failed",
  "keeper-unit-down": "Keeper service is down",
  "migration-stalled": "Graduation is stalled",
  "settlement-stalled": "Fee settlement is stalled",
  "payout-overdue": "Holder payout is overdue",
  "epoch-open-too-long": "Holder payout round is stuck",
  "unexpected-epoch": "POSSIBLE KEEPER KEY COMPROMISE",
  "alert-check-failed": "Keeper health check cannot run",
});

/**
 * @param {{ now: number, slot: bigint, keeperLamports: bigint,
 *   status: { at: string, ok: boolean, errors?: unknown[], settlementErrors?: { mint: string, error: string }[], migrationErrors?: { mint: string, error: string }[], carrying?: string[] } | null,
 *   pools: { mint: string, nextEpoch: bigint, openEpoch: { number: bigint, snapshotSlot: bigint } | null, holderUnallocated?: bigint, lastSnapshotSlot?: bigint }[],
 *   indexedEpochs: Map<string, Set<string>>,
 *   units?: { name: string, state: string }[],
 *   graduations?: { mint: string, ageMs: number, lastError: string | null, dammRegistered: boolean }[] }} input
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
  for (const unit of input.units ?? [])
    if (unit.state !== "active") alerts.push({ code: "keeper-unit-down", mint: unit.name, message: `${unit.name} is ${unit.state}` });
  for (const e of input.status?.settlementErrors ?? [])
    alerts.push({ code: "settlement-stalled", mint: e.mint, message: `Settlement keeps failing: ${e.error}` });
  const migrating = new Set();
  for (const e of input.status?.migrationErrors ?? []) {
    migrating.add(e.mint);
    alerts.push({ code: "migration-stalled", mint: e.mint, message: `Migration keeps failing: ${e.error}` });
  }
  for (const g of input.graduations ?? [])
    if (!g.dammRegistered && !migrating.has(g.mint))
      alerts.push({ code: "migration-stalled", mint: g.mint, message: `Curve completed ${Math.round(g.ageMs / 60_000)} min ago and the DAMM v2 pool is not registered${g.lastError ? `: ${g.lastError}` : ""}` });
  for (const pool of input.pools) {
    const open = pool.openEpoch;
    if (open && input.slot - open.snapshotSlot > limits.maxOpenEpochSlots)
      alerts.push({ code: "epoch-open-too-long", mint: pool.mint, message: `Epoch ${open.number} has been open since snapshot slot ${open.snapshotSlot}` });
    // Holder HYPE that should have been paid: enough to pay someone, no round in progress, and the last snapshot is past
    // due. Amounts the keeper carries because each holder's share is below the minimum are expected, not overdue.
    const undistributed = pool.holderUnallocated ?? 0n, last = pool.lastSnapshotSlot ?? 0n;
    if (!open && undistributed >= limits.minHolderPool && !input.status?.carrying?.includes(pool.mint) && (last === 0n || input.slot - last > limits.payoutOverdueSlots))
      alerts.push({ code: "payout-overdue", mint: pool.mint, message: `${undistributed} HYPE base units are waiting for holders; last snapshot slot ${last}` });
    // Every funded epoch must match a root the keeper prepared (the indexer records only those). One that does not was
    // funded by someone else holding the keeper key: stop the keeper and rotate the key in the owner console.
    const indexed = input.indexedEpochs.get(pool.mint) ?? new Set();
    for (let e = 0n; e < pool.nextEpoch; e++) {
      if (indexed.has(e.toString())) continue;
      if (open && open.number === e && input.slot - open.snapshotSlot <= limits.indexGraceSlots) continue;
      alerts.push({ code: "unexpected-epoch", mint: pool.mint, message: `Epoch ${e} is funded on-chain but matches no keeper-prepared root; possible keeper key compromise. Stop the keeper and rotate the key in the owner console` });
    }
  }
  return alerts;
}

/** Messages leave the server: keeper errors can quote RPC URLs, which can carry API keys. */
export function redactSecrets(text) {
  return String(text)
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, "<url>")
    .replace(/\b\d{5,}:[A-Za-z0-9_-]{30,}/g, "<token>")
    .replace(/((?:api[-_]?key|token|secret|password)["']?\s*[=:]\s*["']?)[^\s"'&,}]+/gi, "$1<hidden>");
}

const alertKey = (a) => `${a.code}|${a.mint ?? ""}`;

/**
 * Merge this run's alerts into the saved state and decide what is due. `partial` means the check could not see the
 * whole picture (it crashed), so an alert missing from this run is not treated as resolved.
 * @param {{ active?: Record<string, any> }} state
 * @param {{ code: string, message: string, mint?: string }[]} alerts
 * @param {number} now
 * @param {{ partial?: boolean }} [options]
 */
export function planNotifications(state, alerts, now, { partial = false } = {}, policy = ALERT_POLICY) {
  /** @type {Record<string, any>} */
  const active = Object.fromEntries(Object.entries(state.active ?? {}).map(([k, e]) => [k, { ...e }]));
  const current = new Set();
  for (const a of alerts) {
    const key = alertKey(a), previous = active[key];
    current.add(key);
    active[key] = { code: a.code, mint: a.mint ?? null, message: a.message, firstSeen: previous?.firstSeen ?? now, lastSent: previous?.lastSent ?? null, resolved: false };
  }
  if (!partial)
    for (const [key, entry] of Object.entries(active))
      if (!current.has(key)) {
        if (entry.lastSent === null) delete active[key]; // cleared within its holdoff: nobody was told, nothing to retract
        else entry.resolved = true;
      }
  const due = [];
  for (const [key, entry] of Object.entries(active)) {
    if (entry.resolved) due.push({ key, kind: "resolved", entry });
    else if (entry.lastSent === null) {
      if (now - entry.firstSeen >= (policy.holdoffMs[entry.code] ?? 0)) due.push({ key, kind: "firing", entry });
    } else if (now - entry.lastSent >= (policy.critical.includes(entry.code) ? policy.criticalRenotifyMs : policy.renotifyMs)) due.push({ key, kind: "reminder", entry });
  }
  const rank = (d) => (policy.critical.includes(d.entry.code) ? 0 : { firing: 1, reminder: 2, resolved: 3 }[d.kind]);
  due.sort((a, b) => rank(a) - rank(b));
  return { active, due };
}

const MESSAGE_LIMIT = 3_800, EVENT_LIMIT = 900;
const utc = (ms) => `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;

/** One plain-text message. Events that do not fit stay due and go out on the next run. */
export function formatNotification(due) {
  const prefix = { firing: "🔴", reminder: "🟠 Still active:", resolved: "✅ Resolved:" };
  const included = [];
  let text = "";
  for (const d of due) {
    const lines = [`${prefix[d.kind]} ${TITLES[d.entry.code] ?? d.entry.code}`];
    if (d.entry.mint) lines.push(d.entry.mint);
    if (d.kind !== "resolved") lines.push(redactSecrets(d.entry.message), `Since ${utc(d.entry.firstSeen)}`);
    const block = lines.join("\n").slice(0, EVENT_LIMIT);
    if (text.length + block.length + 2 > MESSAGE_LIMIT) break;
    text += `${text ? "\n\n" : ""}${block}`;
    included.push(d);
  }
  return { text: text ? `HYMET keeper\n\n${text}` : "", included };
}

/** Apply a successful send to the state. */
export function markSent(active, included, now) {
  for (const d of included) {
    if (d.kind === "resolved") delete active[d.key];
    else active[d.key].lastSent = now;
  }
  return active;
}
