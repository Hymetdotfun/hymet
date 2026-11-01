import type { ReactNode } from "react";
import { TokenAvatar } from "./token-avatar";

// Compact creator-earnings card shared by the DBC and DAMM v2 claim flows. Purely presentational: the amount is
// whatever the caller read from the verified pool or position, and the action runs the caller's existing review flow.
export function EarningsCard({
  venue,
  name,
  ticker,
  imageUrl,
  stage,
  amount,
  note,
  action,
  children,
  advanced,
}: {
  venue: "DBC" | "DAMM v2";
  name: string;
  ticker?: string;
  imageUrl?: string;
  stage: string;
  amount?: string;
  note?: string;
  action?: { label: string; disabled: boolean; onClick: () => void };
  children?: ReactNode;
  advanced?: ReactNode;
}) {
  return (
    <article className="earn-card" data-venue={venue}>
      <div className="earn-head">
        <h3>Creator Earnings</h3>
        <span className="earn-venue">{venue}</span>
      </div>
      <div className="earn-token">
        <TokenAvatar src={imageUrl} symbol={ticker || "?"} name={name} />
        <div>
          <strong>{name}{ticker ? ` ($${ticker.toUpperCase()})` : ""}</strong>
          <small>{stage}</small>
        </div>
      </div>
      <div className="earn-amount" aria-live="polite">
        <span>Available to claim</span>
        <strong>{amount ?? "—"}</strong>
        {note && <small>{note}</small>}
      </div>
      {action && (
        <button type="button" className="earn-claim" disabled={action.disabled} onClick={action.onClick}>
          {action.label}
        </button>
      )}
      {children}
      {advanced && (
        <details className="earn-advanced">
          <summary>Advanced details</summary>
          <div className="earn-advanced-body">{advanced}</div>
        </details>
      )}
    </article>
  );
}

/** Amount / network / recipient / estimated fee, shown before Phantom signing. */
export function ClaimConfirmation({
  amount,
  network,
  recipient,
  fee,
  consent,
  onConsent,
  busy,
  canConfirm,
  onConfirm,
  onCancel,
}: {
  amount: string;
  network: string;
  recipient: string;
  fee: string;
  consent: boolean;
  onConsent: (value: boolean) => void;
  busy: boolean;
  canConfirm: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="earn-confirm" aria-label="Claim confirmation">
      <dl>
        <div><dt>Amount</dt><dd>{amount}</dd></div>
        <div><dt>Network</dt><dd>{network}</dd></div>
        <div><dt>Recipient</dt><dd title={recipient}>{recipient.slice(0, 4)}…{recipient.slice(-4)}</dd></div>
        <div><dt>Estimated fee</dt><dd>{fee}</dd></div>
      </dl>
      <label className="earn-consent">
        <input type="checkbox" checked={consent} onChange={(e) => onConsent(e.target.checked)} disabled={busy} />
        I reviewed this claim and approve signing in Phantom.
      </label>
      <div className="earn-confirm-actions">
        <button type="button" className="earn-claim" disabled={busy || !consent || !canConfirm} onClick={onConfirm}>
          {busy ? "Waiting for Phantom…" : "Confirm in Phantom"}
        </button>
        <button type="button" className="earn-cancel" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
