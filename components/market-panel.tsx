"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
type Market = { source?: string; pool?: string; protocol?: string; priceHype?: number; priceUsd?: number; hypeUsd?: number; volume24hHype?: number; volume24hUsd?: number; change24h?: number; trades24h?: number; liquidityHype?: number; liquidityUsd?: number; liquiditySource?: string; marketCapHype?: number; fdvUsd?: number; graduationPercent?: number; updatedAt?: string; stale?: boolean; pairUrl?: string; indexing?: boolean };
type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number };
const TIMEFRAMES = ["1m", "5m", "15m", "1h", "4h", "1d"] as const;
type Timeframe = (typeof TIMEFRAMES)[number];
const REFRESH_MS: Record<Timeframe, number> = { "1m": 60_000, "5m": 60_000, "15m": 90_000, "1h": 120_000, "4h": 300_000, "1d": 600_000 };
const fmt = (n?: number, digits = 6) => (n !== undefined && Number.isFinite(n) ? new Intl.NumberFormat("en-US", { maximumSignificantDigits: digits }).format(n) : "—");
const usd = (n?: number) => (n !== undefined && Number.isFinite(n) ? `$${fmt(n, 6)}` : "—");

function CandleChart({ candles, tf }: { candles: Candle[]; tf: Timeframe }) {
  if (!candles.length)
    return (
      <div className="chart-placeholder large-chart">
        <span className="empty-icon">⌁</span>
        <b>No {tf} candles indexed yet</b>
        <p>GeckoTerminal indexes new pools with a short delay. Candles appear here once real trades are indexed; none are generated.</p>
      </div>
    );
  const width = 720, height = 260, pad = 18, volH = 46, priceH = height - pad * 2 - volH - 8;
  const lows = candles.map((c) => c.low), highs = candles.map((c) => c.high);
  const min = Math.min(...lows), max = Math.max(...highs), span = max - min || max || 1;
  const maxVol = Math.max(...candles.map((c) => c.volume)) || 1;
  const step = (width - pad * 2) / candles.length, body = Math.max(1.5, Math.min(12, step * 0.62));
  const y = (p: number) => pad + (max - p) / span * priceH;
  const time = (t: number) => new Date(t * 1000).toLocaleString("en-US", tf === "1d" ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  return (
    <div className="real-chart">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${tf} candlesticks, HYPE per token, from GeckoTerminal`}>
        {candles.map((c) => {
          const i = candles.indexOf(c), x = pad + step * i + step / 2, up = c.close >= c.open;
          const color = up ? "var(--teal, #28edcf)" : "#f0616d";
          const top = y(Math.max(c.open, c.close)), bottom = y(Math.min(c.open, c.close));
          const vh = (c.volume / maxVol) * volH;
          return (
            <g key={c.time}>
              <title>{`${time(c.time)} · O ${fmt(c.open)} H ${fmt(c.high)} L ${fmt(c.low)} C ${fmt(c.close)} HYPE · Vol ${fmt(c.volume, 4)} HYPE`}</title>
              <line x1={x} x2={x} y1={y(c.high)} y2={y(c.low)} stroke={color} strokeWidth="1" vectorEffect="non-scaling-stroke" />
              <rect x={x - body / 2} y={top} width={body} height={Math.max(1, bottom - top)} fill={color} />
              <rect x={x - body / 2} y={height - pad - vh} width={body} height={vh} fill={color} opacity=".35" />
            </g>
          );
        })}
        <line x1={pad} x2={width - pad} y1={height - pad} y2={height - pad} stroke="currentColor" opacity=".2" />
        <text x={width - pad} y={pad + 10} textAnchor="end" fontSize="10" fill="currentColor" opacity=".55">{fmt(max)} HYPE</text>
        <text x={width - pad} y={pad + priceH} textAnchor="end" fontSize="10" fill="currentColor" opacity=".55">{fmt(min)} HYPE</text>
      </svg>
      <div><span>{time(candles[0].time)}</span><span>{time(candles.at(-1)!.time)}</span></div>
    </div>
  );
}

export function MarketPanel({ mint }: { mint: string }) {
  const [data, setData] = useState<Market | null>(null), [candles, setCandles] = useState<Candle[]>([]), [message, setMessage] = useState(""), [chartNote, setChartNote] = useState("");
  const [tf, setTf] = useState<Timeframe>("5m"), [loaded, setLoaded] = useState(""), [tick, setTick] = useState(0);
  const key = `${mint}:${tf}`, loading = loaded !== key, market = data;
  // Auto-refresh while the tab is visible; providers are cached server-side, so this never exceeds their limits.
  useEffect(() => {
    const id = window.setInterval(() => { if (document.visibilityState === "visible") setTick((n) => n + 1); }, REFRESH_MS[tf]);
    return () => window.clearInterval(id);
  }, [tf]);
  useEffect(() => {
    let alive = true;
    Promise.all([
      fetch(`/api/market/${encodeURIComponent(mint)}`, { cache: "no-store" }).then(async (r) => { const j = await r.json(); if (!r.ok) throw Error(j.error || "Market data unavailable"); return j as Market; }),
      fetch(`/api/market/${encodeURIComponent(mint)}/ohlcv?tf=${tf}`, { cache: "no-store" }).then(async (r) => { const j = await r.json(); return (r.ok ? { candles: j.candles as Candle[], stale: Boolean(j.stale), error: "" } : { candles: [] as Candle[], stale: false, error: String(j.error || "Chart unavailable") }); }).catch(() => ({ candles: [] as Candle[], stale: false, error: "Chart unavailable" })),
    ]).then(([m, chart]) => {
      if (!alive) return;
      setData(m); setCandles(chart.candles || []); setMessage("");
      setChartNote(chart.error || (chart.stale ? "showing last cached candles (provider rate-limited)" : ""));
      setLoaded(key);
    }).catch((e) => { if (alive) { setMessage(e instanceof Error ? e.message : "Market data unavailable"); setLoaded(key); } });
    return () => { alive = false; };
  }, [mint, tf, key, tick]);
  const change = market?.change24h;
  return (
    <>
      <div className="market-kpis" aria-busy={loading}>
        <div><small>PRICE</small><b>{market?.priceHype !== undefined ? `${fmt(market.priceHype)} HYPE` : "—"}</b>{market?.priceUsd !== undefined && <small>{usd(market.priceUsd)}</small>}</div>
        <div><small>24H VOLUME</small><b>{market?.volume24hHype !== undefined ? `${fmt(market.volume24hHype, 4)} HYPE` : "—"}</b>{market?.volume24hUsd !== undefined && <small>{usd(market.volume24hUsd)}{market.trades24h !== undefined ? ` · ${market.trades24h} trades` : ""}</small>}</div>
        <div><small>24H CHANGE</small><b className={change !== undefined ? (change >= 0 ? "positive" : "negative") : ""}>{change !== undefined ? `${fmt(change, 4)}%` : "—"}</b></div>
        <div><small>LIQUIDITY</small><b>{market?.liquidityHype !== undefined ? `${fmt(market.liquidityHype, 5)} HYPE` : usd(market?.liquidityUsd)}</b>{market?.liquidityHype !== undefined && market.liquidityUsd !== undefined && <small>{usd(market.liquidityUsd)}</small>}</div>
      </div>
      <div className="panel-card chart-card" aria-busy={loading}>
        <div className="market-links" role="group" aria-label="Chart timeframe">
          {TIMEFRAMES.map((t) => (
            <button key={t} type="button" className={t === tf ? "chart-retry" : "text-link"} aria-pressed={t === tf} onClick={() => setTf(t)}>{t}</button>
          ))}
        </div>
        {loading && !candles.length ? <div className="market-loading" role="status">Loading verified market data…</div> : <CandleChart candles={candles} tf={tf} />}
        <div className="chart-status">
          <p className="chart-caption" role="status">
            {message || [
              "GeckoTerminal candles · HYPE per token",
              chartNote,
              market?.source ? `price ${market.source}${market.stale ? " (cached)" : ""}` : market?.indexing ? "price not indexed yet" : "",
              market?.liquiditySource ? `liquidity ${market.liquiditySource}` : "",
              market?.hypeUsd !== undefined ? `HYPE ${usd(market.hypeUsd)}` : "",
              market?.updatedAt ? `updated ${new Date(market.updatedAt).toLocaleTimeString("en-US")}` : "",
            ].filter(Boolean).join(" · ")}
          </p>
          {!loading && message && <button className="chart-retry" onClick={() => setTick((n) => n + 1)}>Try again</button>}
        </div>
        <div className="market-links">
          {market?.pairUrl && <Link href={market.pairUrl} target="_blank" rel="noreferrer">Open verified pool data ↗</Link>}
          {market?.marketCapHype !== undefined && <span>FDV {fmt(market.marketCapHype, 5)} HYPE ({usd(market.fdvUsd)})</span>}
          {market?.protocol === "meteora_damm_v2" ? <span>Graduated · trading on Meteora DAMM v2</span> : market?.graduationPercent !== undefined && <span>Bonding curve {fmt(market.graduationPercent, 3)}% to graduation</span>}
        </div>
      </div>
    </>
  );
}
