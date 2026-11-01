"use client";
// Creator fee claims on the Fees & Rewards page. Reuses the launch studio's CreatorFees panel unchanged
// (on-chain creator authorization, review + consent, simulation, Phantom signing, HTTP confirmation, journal);
// it reuses the app-wide Phantom wallet session and the connected creator's verified HYMET pools.
import { useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { APP_NETWORK } from "../lib/app-network";
import CreatorFees from "./creator-fees";
import { TokenAvatar } from "./token-avatar";

// `pool` is the DBC launch pool (claims start there); `protocol` is the current venue (DAMM v2 after graduation).
type Launch = { mint: string; name: string; ticker: string; imageUrl?: string; pool?: string; protocol?: string; creator?: string };
const venue = (l: Launch) => (l.protocol === "meteora_damm_v2" ? "DAMM v2" : "DBC");

export function CreatorFeeClaims() {
  return <CreatorClaims />;
}

function CreatorClaims() {
  const { publicKey } = useWallet();
  const [launches, setLaunches] = useState<Launch[] | null>(null), [error, setError] = useState("");
  const [selected, setSelected] = useState<{ pool: string; requestId: number; launch: Launch }>();
  const owner = publicKey?.toBase58();

  useEffect(() => {
    if (!owner) return;
    let alive = true;
    fetch(`/api/creator-launches?wallet=${encodeURIComponent(owner)}`, { cache: "no-store" })
      .then(async (r) => { if (!r.ok) throw Error("Launch index unavailable"); return r.json() as Promise<{ launches?: Launch[] }>; })
      .then((d) => {
        if (!alive) return;
        const mine = (d.launches || []).filter((t) => t.creator === owner && t.pool && (t.protocol === "meteora_dbc" || t.protocol === "meteora_damm_v2"));
        setLaunches(mine);
        setError("");
        if (mine.length === 1) setSelected({ pool: mine[0].pool!, requestId: Date.now(), launch: mine[0] });
      })
      .catch((e) => { if (alive) { setLaunches([]); setError(e instanceof Error ? e.message : "Launch index unavailable"); } });
    return () => { alive = false; };
  }, [owner]);

  const multiple = (launches?.length || 0) > 1;
  return (
    <section className="panel-card earn-section" id="creator-fee-claims">
      {!owner ? (
        <><h2 className="earn-section-title">Creator Earnings</h2><p className="fees-inactive-state">Connect your wallet from the navbar to view your fees.</p></>
      ) : (
        <>
          {launches === null ? <p role="status">Loading your verified launches…</p> : launches.length === 0 ? (
            <><h2 className="earn-section-title">Creator Earnings</h2><p className="fine">No launch is linked to this wallet yet.</p></>
          ) : multiple && (
            <div className="creator-token-picker" role="group" aria-label="Your launches">
              {launches.map((l) => (
                <button key={l.pool} type="button" className={`creator-token-choice${selected?.pool === l.pool ? " active" : ""}`} aria-pressed={selected?.pool === l.pool} onClick={() => setSelected({ pool: l.pool!, requestId: Date.now(), launch: l })}>
                  <TokenAvatar src={l.imageUrl} symbol={l.ticker} name={l.name} />
                  <span className="creator-token-choice-copy"><strong>{l.name}</strong><small>${l.ticker.toUpperCase()} / HYPE</small></span>
                  <span className="creator-token-choice-venue" data-venue={venue(l)}>{venue(l)}</span>
                </button>
              ))}
            </div>
          )}
          {(launches?.length || selected) ? <CreatorFees network={APP_NETWORK} requestedPool={selected} selectedLaunch={selected?.launch} /> : null}
        </>
      )}
      {error && <p role="alert" className="error">{error}</p>}
    </section>
  );
}
