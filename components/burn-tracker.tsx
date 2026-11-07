"use client";

import { useEffect, useState } from "react";
import { formatTokens } from "../lib/burn-tracker";

type BurnReport = {
  status: "verified" | "stale" | "indexing" | "unavailable";
  mint: string;
  symbol: string;
  originalSupplyRaw: string;
  burnedRaw?: string;
  burnedPercent?: string;
  team?: { wallets: string[]; burnedRaw: string; count: number };
  other?: { burnedRaw: string; count: number };
  burnCount?: number;
  updatedAt?: string;
  verifiedSlot?: number;
  recent?: { signature: string; amountRaw: string; team: boolean; blockTime: string | null }[];
};

const REFRESH_MS = 60_000;

function utcTime(value?: string | null) {
  const date = value ? new Date(value) : undefined;
  if (!date || !Number.isFinite(date.getTime())) return "Time unavailable";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC", timeZoneName: "short" }).format(date);
}

function tokens(raw?: string) {
  return raw && /^\d+$/.test(raw) ? `${formatTokens(BigInt(raw))} HYMET` : "Unavailable";
}

function exact(raw?: string) {
  return raw && /^\d+$/.test(raw) ? `${formatTokens(BigInt(raw), 9)} HYMET (exact)` : undefined;
}

/** Live $HYMET burns: total on-chain burns, checked against supply, kept separate from team buyback burns. */
export function BurnTracker() {
  const [report, setReport] = useState<BurnReport>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    let controller: AbortController | undefined;
    const load = async () => {
      controller?.abort();
      controller = new AbortController();
      try {
        const response = await fetch("/api/burns", { cache: "no-store", signal: controller.signal });
        const body = (await response.json()) as BurnReport;
        if (!active) return;
        setReport(body);
        setFailed(!response.ok);
      } catch (error) {
        if (active && !(error instanceof DOMException && error.name === "AbortError")) setFailed(true);
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    return () => {
      active = false;
      controller?.abort();
      window.clearInterval(timer);
    };
  }, []);

  const shown = report && (report.status === "verified" || report.status === "stale") ? report : undefined;
  const label = !report && !failed
    ? "Loading"
    : shown?.status === "verified"
      ? "Verified against on-chain supply"
      : shown?.status === "stale"
        ? "Last verified data"
        : report?.status === "indexing"
          ? "Indexing burn history"
          : "Unavailable";
  const emptyValue = !report && !failed ? "Loading…" : report?.status === "indexing" ? "Verifying…" : "Unavailable";

  return (
    <section className="dashboard-section dashboard-burns" aria-labelledby="burn-tracker-title" aria-busy={!report && !failed}>
      <div className="dashboard-section-heading">
        <div>
          <h2 id="burn-tracker-title">$HYMET Burn Tracker</h2>
          <span>Confirmed SPL burns of the official token on Solana Mainnet, checked against its on-chain supply.</span>
        </div>
        <span>{label}</span>
      </div>
      <div className="burn-total" title={exact(shown?.burnedRaw)}>
        <span className="burn-total-label">Total Burned</span>
        {shown?.burnedRaw && /^\d+$/.test(shown.burnedRaw) ? (
          <strong className="burn-total-value">
            {formatTokens(BigInt(shown.burnedRaw))}
            <em>HYMET</em>
          </strong>
        ) : (
          <strong className="burn-total-value burn-total-empty">{emptyValue}</strong>
        )}
        <small className="burn-total-caption">
          {shown?.burnCount !== undefined
            ? `All confirmed on-chain burns · ${shown.burnCount} ${shown.burnCount === 1 ? "burn" : "burns"} · updated ${utcTime(shown.updatedAt)}`
            : "All confirmed on-chain burns"}
        </small>
      </div>
      {shown?.recent?.length ? (
        <div className="dashboard-history-list dashboard-burn-list">
          {shown.recent.map((burn) => (
            <article key={burn.signature + burn.amountRaw}>
              <span className="dashboard-history-type">{burn.team ? "Team buyback burn" : "On-chain burn"}</span>
              <span className="dashboard-history-token" title={exact(burn.amountRaw)}>{tokens(burn.amountRaw)}</span>
              <time dateTime={burn.blockTime ?? undefined}>{utcTime(burn.blockTime)}</time>
              <a href={`https://solscan.io/tx/${encodeURIComponent(burn.signature)}`} target="_blank" rel="noreferrer">Solscan ↗</a>
            </article>
          ))}
        </div>
      ) : null}
      <p className="dashboard-earnings-note">
        {shown
          ? `Last updated ${utcTime(shown.updatedAt)}${shown.status === "stale" ? " · newer data could not be verified yet" : ""}. `
          : report?.status === "indexing"
            ? "Burn history is being indexed and checked against the on-chain supply. "
            : !report && !failed
              ? ""
              : "Burn data could not be verified right now. Nothing is shown until it matches the on-chain supply. "}
        Team buyback burns are burns signed by the HYMET team wallet; every other burn counts as an on-chain burn. Transfers to dead wallets do not reduce supply and are not counted.
      </p>
    </section>
  );
}
