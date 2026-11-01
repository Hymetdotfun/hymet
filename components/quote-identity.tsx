"use client";
import { HYPE_MINT } from "../lib/quote-assets";
import { useState } from "react";
import { NATIVE_MINT } from "@solana/spl-token";
import { limitedBody } from "../lib/http";
import type { XstocksRegistry } from "../lib/xstocks";

// Labels only: identity lookup never changes accounting, ownership or claim eligibility.
export function QuoteIdentity({
  mint,
  decimals,
}: {
  mint: string;
  decimals: number;
}) {
  const [result, setResult] = useState<{ mint: string; label: string }>();
  const [busy, setBusy] = useState(false);
  if (mint === NATIVE_MINT.toBase58()) return null;
  if (mint === HYPE_MINT.toBase58() && decimals === 9)
    return (
      <p className="fine">
        Quote: HYPE · verified registry mint {mint}. Standard SPL accounting;
        HYPE stays in the owner’s HYPE ATA and is not unwrapped as SOL.
      </p>
    );
  async function verify() {
    setBusy(true);
    setResult(undefined);
    try {
      const r = await fetch("/api/xstocks", {
        cache: "no-store",
        signal: AbortSignal.timeout(90_000),
      });
      if (!r.ok) throw Error();
      const data: XstocksRegistry = JSON.parse(
        new TextDecoder().decode(await limitedBody(r, 2 * 1024 * 1024)),
      );
      const asset = data.assets.find(
        (a) => a.mint === mint && a.decimals === decimals,
      );
      setResult({
        mint,
        label: asset
          ? `${asset.name} (${asset.symbol}) — ${asset.status}`
          : "Quote identity is not verified in the current official Solana registry",
      });
    } catch {
      setResult({ mint, label: "Official identity verification unavailable" });
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="fine quote-details">
      <p>
        On-chain quote mint: {mint} · decimals {decimals}. Fees and progress use
        raw token accounting, before any issuer UI multiplier. SOL labels apply
        only to wrapped SOL.
      </p>
      <button type="button" disabled={busy} onClick={verify}>
        {busy ? "Verifying…" : "Verify official xStocks quote identity"}
      </button>
      {result?.mint === mint && <p>{result.label}</p>}
      <p>
        Identity is not claim authorization. Unsupported Token-2022 claims
        remain disabled.
      </p>
    </div>
  );
}
