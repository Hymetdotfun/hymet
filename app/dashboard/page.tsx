"use client";

import Link from "next/link";
import Image from "next/image";
import { useCallback, useEffect, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";

type CreatorData = {
  indexed: boolean;
  tokens: Array<{ mint: string; name: string; ticker: string; imageUrl?: string; status: string; launch_signature: string; created_at: string }>;
  fees: { creator_hype: string; claimed_hype: string; holder_hype: string; hymet_hype: string };
  feesIndexed: boolean;
  claimsIndexed: boolean;
  history: Array<{ signature: string; type: string; mint: string; name: string; confirmed_at: string }>;
};
type Market = { volume24hHype?: number; marketCapHype?: number; fdvUsd?: number; hypeUsd?: number };

function hype(raw?: string) {
  if (!raw) return "—";
  try {
    const value = BigInt(raw);
    const whole = value / 1_000_000_000n;
    const part = (value % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/g, "");
    return part ? `${whole}.${part}` : whole.toString();
  } catch {
    return "—";
  }
}

function formatVolume(value?: number) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "Unavailable";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 }).format(value);
}

function shortWallet(value: string) {
  return `${value.slice(0, 6)}…${value.slice(-5)}`;
}

function confirmedTime(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Date unavailable";
  return new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC", timeZoneName: "short" }).format(date);
}

function DashboardArtwork({ src, name }: { src?: string; name: string }) {
  const [failed, setFailed] = useState(false);
  return <div className="dashboard-token-art">
    {src && !failed ? <Image src={src} alt={`${name} token artwork`} fill sizes="(max-width: 620px) 100vw, (max-width: 1000px) 50vw, 25vw" unoptimized loading="lazy" onError={() => setFailed(true)} /> : <span>Artwork unavailable</span>}
  </div>;
}

export default function Dashboard() {
  const { publicKey } = useWallet();
  const wallet = publicKey?.toBase58() || "";
  const [snapshot, setSnapshot] = useState<{ wallet: string; data?: CreatorData; message?: string }>();
  const [loadingWallet, setLoadingWallet] = useState("");
  const [marketSnapshot, setMarketSnapshot] = useState<{ key: string; values: Record<string, Market | null> }>({ key: "", values: {} });
  const [copied, setCopied] = useState(false);
  const request = useRef(0);
  const refresh = useCallback(async (address: string) => {
    const id = ++request.current;
    setLoadingWallet(address);
    try {
      const response = await fetch(`/api/dashboard/${encodeURIComponent(address)}`, { cache: "no-store" });
      const data = await response.json();
      if (id !== request.current) return;
      if (!response.ok) throw Error(data.error || "Creator data unavailable");
      setSnapshot({ wallet: address, data });
    } catch (error) {
      if (id === request.current)
        setSnapshot({ wallet: address, message: error instanceof Error ? error.message : "Creator data unavailable" });
    } finally {
      if (id === request.current) setLoadingWallet("");
    }
  }, []);

  useEffect(() => {
    if (wallet) queueMicrotask(() => void refresh(wallet));
  }, [wallet, refresh]);

  const data = snapshot?.wallet === wallet ? snapshot.data : undefined;
  const message = snapshot?.wallet === wallet ? snapshot.message : "";
  const loading = Boolean(wallet && loadingWallet === wallet);
  const tokens = data?.tokens || [];
  const fees = data?.fees;
  const tokenKey = tokens.map((token) => token.mint).join("|");

  useEffect(() => {
    if (!data || !tokenKey) return;
    const controller = new AbortController();
    void Promise.all(data.tokens.map(async (token) => {
      try {
        const response = await fetch(`/api/market/${encodeURIComponent(token.mint)}`, { cache: "no-store", signal: controller.signal });
        if (!response.ok) return [token.mint, null] as const;
        return [token.mint, await response.json() as Market] as const;
      } catch { return [token.mint, null] as const; }
    })).then((entries) => { if (!controller.signal.aborted) setMarketSnapshot({ key: tokenKey, values: Object.fromEntries(entries) }); });
    return () => controller.abort();
  }, [data, tokenKey]);

  const marketLoading = Boolean(data && tokens.length && marketSnapshot.key !== tokenKey);
  const markets = marketSnapshot.key === tokenKey ? marketSnapshot.values : {};
  const marketEntries = tokens.map((token) => markets[token.mint]);
  const availableVolumes = marketEntries.filter((market): market is Market => typeof market?.volume24hHype === "number" && Number.isFinite(market.volume24hHype) && market.volume24hHype >= 0);
  const volumeIsComplete = tokens.length > 0 && availableVolumes.length === tokens.length;
  const totalVolume = volumeIsComplete ? availableVolumes.reduce((sum, market) => sum + (market.volume24hHype || 0), 0) : undefined;
  const copyWallet = async () => {
    try { await navigator.clipboard.writeText(wallet); setCopied(true); window.setTimeout(() => setCopied(false), 1400); }
    catch { setCopied(false); }
  };

  return (
    <main className="page-shell dashboard-page" aria-busy={loading}>
      <header className="dashboard-hero">
        <h1><span>Your Tokens.</span><em>Your Dashboard.</em></h1>
        <p>Manage your launches, track performance, and monitor your earnings.</p>
      </header>
      <div className="dashboard-wallet-bar">
        <div className="dashboard-wallet-copy">{wallet ? <><span>Connected wallet</span><code>{shortWallet(wallet)}</code><button type="button" className="dashboard-copy" onClick={() => void copyWallet()} aria-label="Copy wallet address">{copied ? "Copied" : "Copy"}</button></> : <span>Connect your wallet from the navbar to view your creator dashboard.</span>}</div>
        {wallet && <button className="dashboard-refresh" onClick={() => void refresh(wallet)} disabled={loading}>{loading ? "Refreshing…" : "Refresh"}</button>}
      </div>
      {message && <p className="dashboard-notice" role="status">{message}</p>}
      <section className="dashboard-overview" aria-labelledby="dashboard-overview-title">
        <div className="dashboard-section-heading"><h2 id="dashboard-overview-title">Overview</h2><span>{data?.indexed ? "Verified records" : loading ? "Loading" : "Awaiting wallet data"}</span></div>
        <div className="dashboard-metrics">
          <article><span>Tokens Created</span><strong>{data?.indexed ? tokens.length : "—"}</strong><small>Confirmed launches</small></article>
          <article><span>24h Volume (HYPE)</span><strong>{totalVolume === undefined ? "— HYPE" : `${formatVolume(totalVolume)} HYPE`}</strong><small>{tokens.length === 0 ? "No indexed launches" : marketLoading ? "Loading verified market data" : volumeIsComplete ? "Verified market data" : `Volume unavailable for ${tokens.length - availableVolumes.length} of ${tokens.length} tokens`}</small></article>
          <article><span>Creator Earnings (HYPE)</span><strong>{data?.feesIndexed ? `${hype(fees?.creator_hype)} HYPE` : "— HYPE"}</strong><small>{data?.feesIndexed ? "Creator allocation indexed" : "No confirmed settlement indexed"}</small></article>
          <article><span>Graduated Tokens</span><strong>{data?.indexed ? tokens.filter((token) => token.status.toLowerCase() === "graduated").length : "—"}</strong><small>Confirmed graduated launches</small></article>
        </div>
      </section>
      <section className="dashboard-section dashboard-tokens">
        <div className="dashboard-section-heading"><div><h2>My Tokens</h2><span>Confirmed launches for this wallet</span></div></div>
        {tokens.length ? <div className="dashboard-token-grid">{tokens.map((token) => {
          const market = markets[token.mint];
          const status = token.status.toLowerCase() === "graduated" ? "Graduated" : ["bonding", "graduating", "active"].includes(token.status.toLowerCase()) ? "Bonding" : token.status;
          return <Link className="dashboard-token-card" href={`/token/${encodeURIComponent(token.mint)}`} key={token.mint}>
            <DashboardArtwork key={`${token.mint}:${token.imageUrl || "no-art"}`} src={token.imageUrl} name={token.name}/>
            <div className="dashboard-token-heading"><strong>{token.name}</strong><span>${token.ticker} / HYPE</span></div>
            <div className="dashboard-token-status"><i className={status === "Graduated" ? "graduated" : ""}/>{status}</div>
            <div className="dashboard-token-facts"><span>24h Volume</span><b>{typeof market?.volume24hHype === "number" ? `${formatVolume(market.volume24hHype)} HYPE` : marketLoading ? "Loading…" : "Unavailable"}</b></div>
            <span className="dashboard-token-link">View token ↗</span>
          </Link>;
        })}</div> : <div className="dashboard-empty"><b>{message ? "Creator records unavailable" : loading ? "Loading your launches…" : wallet ? "No confirmed launches yet" : "Your launches will appear here"}</b><p>{message || (loading ? "Retrieving confirmed records for the connected wallet." : wallet ? "Confirmed token launches created by this wallet will show here." : "Connect your Phantom wallet from the navbar to load your launches.")}</p></div>}
      </section>
      <section className="dashboard-section dashboard-earnings">
        <div className="dashboard-section-heading"><div><h2>Creator Earnings</h2><span>Confirmed creator allocation and claims from the fee index.</span></div><Link href="/fees">Fees &amp; Rewards ↗</Link></div>
        <div className="dashboard-earnings-grid">
          <article><span>Creator allocation indexed</span><strong>{data?.feesIndexed ? `${hype(fees?.creator_hype)} HYPE` : "Unavailable"}</strong><small>Allocated from confirmed fee settlements</small></article>
          <article><span>Creator claimed</span><strong>{data?.claimsIndexed ? `${hype(fees?.claimed_hype)} HYPE` : "Unavailable"}</strong><small>Confirmed claims recorded for this wallet</small></article>
        </div>
        <p className="dashboard-earnings-note">Pool-specific claimable balances are verified in <Link href="/fees">Fees &amp; Rewards</Link>. HYMET platform fees are not included in creator earnings.</p>
      </section>
      <section className="dashboard-section dashboard-history">
        <div className="dashboard-section-heading"><div><h2>Transaction History</h2><span>Confirmed launches and creator claims recorded for this wallet.</span></div></div>
        {data?.history.length ? <div className="dashboard-history-list">{data.history.map((item) => <article key={item.signature}><span className="dashboard-history-type">{item.type.replace(":", " · ")}</span><Link className="dashboard-history-token" href={`/token/${encodeURIComponent(item.mint)}`}>{item.name}</Link><time dateTime={item.confirmed_at}>{confirmedTime(item.confirmed_at)}</time><a href={`https://solscan.io/tx/${encodeURIComponent(item.signature)}`} target="_blank" rel="noreferrer">Solscan ↗</a></article>)}</div> : <div className="dashboard-empty"><b>{loading ? "Loading transaction history…" : wallet && !message ? "No confirmed transactions indexed" : "Transaction history unavailable"}</b><p>{message || (loading ? "Retrieving confirmed wallet activity." : "Launch and claim transactions appear after their records are verified.")}</p></div>}
      </section>
    </main>
  );
}
