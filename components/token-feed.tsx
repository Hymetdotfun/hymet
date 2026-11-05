"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";

type Token = {
  mint: string;
  name: string;
  ticker: string;
  imageUrl?: string;
  status: string;
  createdAt: string;
  volume24hHype?: string;
  marketCapUsd?: number;
};

function TokenArtwork({ src, name }: { src?: string; name: string }) {
  const [failedSrc, setFailedSrc] = useState<string>();

  if (!src || src === failedSrc) {
    return <div className="token-artwork-unavailable">Artwork unavailable</div>;
  }

  return (
    <Image
      className="token-artwork-image"
      src={src}
      alt={`${name} token artwork`}
      fill
      sizes="(max-width: 480px) 100vw, (max-width: 760px) 50vw, (max-width: 1100px) 33vw, 20vw"
      unoptimized
      loading="lazy"
      onError={() => setFailedSrc(src)}
    />
  );
}

function marketCap(value?: number) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return "Unavailable";
  }
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(value);
}

export function TokenFeed({ compact = false, emptyVariant = "default" }: { compact?: boolean; emptyVariant?: "default" | "explore" }) {
  const [tokens, setTokens] = useState<Token[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "unavailable">("loading");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [sort, setSort] = useState("recent");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/tokens", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw Error("Index unavailable");
        return response.json();
      })
      .then((data) => {
        if (!controller.signal.aborted) {
          setTokens(Array.isArray(data.tokens) ? data.tokens : []);
          setState("ready");
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setState("unavailable");
      });
    return () => controller.abort();
  }, [attempt]);

  const filtered = tokens
    .filter(
      (token) =>
        (status === "all" || token.status === status) &&
        `${token.name} ${token.ticker} ${token.mint}`
          .toLowerCase()
          .includes(search.trim().toLowerCase()),
    )
    .sort((a, b) =>
      sort === "name"
        ? a.name.localeCompare(b.name)
        : new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  const shown = compact ? filtered.slice(0, 5) : filtered;

  return (
    <div className="token-directory" aria-busy={state === "loading"}>
      {!compact && (
        <div className="explore-tools">
          <div className="search-control">
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.35-4.35" />
            </svg>
            <input
              type="search"
              placeholder="Search name, ticker, or mint address"
              aria-label="Search launches"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <select
            aria-label="Launch status"
            value={status}
            onChange={(event) => setStatus(event.target.value)}
          >
            <option value="all">All launches</option>
            <option value="bonding">On the curve</option>
            <option value="graduated">Graduated</option>
          </select>
          <select
            aria-label="Sort launches"
            value={sort}
            onChange={(event) => setSort(event.target.value)}
          >
            <option value="recent">Newest first</option>
            <option value="name">Name A–Z</option>
          </select>
        </div>
      )}

      {state === "loading" ? (
        <div className="token-grid" role="status">
          <span className="sr-only">Loading verified launches</span>
          {Array.from({ length: compact ? 5 : 10 }, (_, index) => (
            <div className="token-skeleton-card" key={index} aria-hidden="true">
              <span className="token-skeleton-art" />
              <span className="token-skeleton-line" />
              <span className="token-skeleton-line short" />
              <span className="token-skeleton-line metric" />
            </div>
          ))}
        </div>
      ) : state === "unavailable" ? (
        <div className="empty-panel" role="status">
          <span className="empty-icon">↻</span>
          <b>Launches are temporarily unavailable</b>
          <p>We couldn’t load the verified launch index. Your wallet and funds are unaffected.</p>
          <button
            onClick={() => {
              setState("loading");
              setAttempt((count) => count + 1);
            }}
          >
            Try again
          </button>
        </div>
      ) : !tokens.length ? (
        emptyVariant === "explore" ? (
          <div className="empty-panel explore-empty">
            <svg className="explore-empty-orbit" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <ellipse cx="12" cy="12" rx="9" ry="4.5" transform="rotate(-45 12 12)" />
              <ellipse cx="12" cy="12" rx="9" ry="4.5" transform="rotate(45 12 12)" />
              <circle cx="12" cy="12" r="1.25" />
              <circle className="orbit-point" cx="5.65" cy="5.65" r="1" />
            </svg>
            <b>The Next Launch Starts Here.</b>
            <p>Be among the first to launch a token with HYPE.</p>
            <Link className="button-primary" href="/launch">Launch a Token</Link>
          </div>
        ) : (
          <div className="empty-panel">
            <span className="empty-icon">◇</span>
            <b>The next wave starts with you</b>
            <p>No confirmed HYMET launches are indexed yet. New tokens appear here after verification.</p>
            <Link className="button-outline" href="/launch">Explore the launch studio →</Link>
          </div>
        )
      ) : shown.length ? (
        <>
          {!compact && (
            <div className="directory-count" aria-live="polite">
              {filtered.length} {filtered.length === 1 ? "launch" : "launches"}
              <span>Confirmed records only</span>
            </div>
          )}
          <div className="token-grid">
            {shown.map((token) => (
              <Link
                className="token-card"
                key={token.mint}
                href={`/token/${encodeURIComponent(token.mint)}`}
                aria-label={`View ${token.name} token`}
              >
                <div className="token-card-artwork">
                  <TokenArtwork src={token.imageUrl} name={token.name} />
                  <span className="launch-status" data-status={token.status}>
                    {token.status === "bonding"
                      ? "On the curve"
                      : token.status === "graduated"
                        ? "Graduated"
                        : token.status}
                  </span>
                </div>
                <div className="token-card-content">
                  <div className="token-card-title">
                    <strong>{token.name}</strong>
                    <span>{token.ticker} / HYPE · {token.mint.slice(0, 4)}…{token.mint.slice(-4)}</span>
                  </div>
                  <div className="token-card-metrics">
                    <div>
                      <span>Market cap · USD</span>
                      <strong className={typeof token.marketCapUsd === "number" && Number.isFinite(token.marketCapUsd) && token.marketCapUsd >= 0 ? undefined : "unavailable"}>
                        {marketCap(token.marketCapUsd)}
                      </strong>
                    </div>
                    <div>
                      <span>24h volume · HYPE</span>
                      <strong className={token.volume24hHype ? undefined : "unavailable"}>
                        {token.volume24hHype || "Unavailable"}
                      </strong>
                    </div>
                  </div>
                </div>
                <span className="card-arrow" aria-hidden="true">↗</span>
              </Link>
            ))}
          </div>
        </>
      ) : (
        <div className="empty-panel">
          <span className="empty-icon">⌕</span>
          <b>No matching launches</b>
          <p>Try another token name, ticker, or mint address.</p>
          <button onClick={() => { setSearch(""); setStatus("all"); }}>Clear filters</button>
        </div>
      )}
    </div>
  );
}
