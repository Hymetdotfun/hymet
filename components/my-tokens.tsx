"use client";
import { developmentStorage } from "../lib/development-storage";
import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { MigrationStatus } from "./migration-status";
import { QuoteIdentity } from "./quote-identity";
import { connection, type Network } from "../lib/transactions";
import { tokenAmount } from "../lib/creator-fees";
import {
  refreshTokens,
  importToken,
  selectCreatorFees,
  tokenExplorer,
  type TokenView,
} from "../lib/my-tokens";
import { mainnetTransactionsEnabled, activeNetworkLabel } from "../lib/app-network";

export function TokenCard({
  token,
  onFees,
}: {
  token: TokenView;
  onFees: (pool: string) => void;
}) {
  const [logoFailed, setLogoFailed] = useState(false);
  return (
    <article className="token-card">
      <div className="token-card-heading">
        {token.logo && !logoFailed ? (
          <Image
            unoptimized
            src={token.logo}
            width={42}
            height={42}
            alt=""
            referrerPolicy="no-referrer"
            crossOrigin="anonymous"
            onError={() => setLogoFailed(true)}
          />
        ) : (
          <span className="token-monogram" aria-hidden="true">
            {(token.symbol || "?").slice(0, 2)}
          </span>
        )}
        <div>
          <h3>{token.name || "Unnamed token"}</h3>
          <span className="fine">
            {token.symbol ? `$${token.symbol}` : "Symbol unavailable"} ·{" "}
            {token.network === "mainnet-beta" ? activeNetworkLabel("Mainnet Beta") : token.network}
          </span>
        </div>
        <span
          className="badge"
          data-venue={token.migration.venue}
          data-status={token.migration.label}
        >
          {token.migration.label}
        </span>
      </div>
      <dl className="token-facts">
        <dt>Token mint</dt>
        <dd>
          <a
            href={tokenExplorer(token.network, "account", token.mint)}
            target="_blank"
            rel="noreferrer"
          >
            {token.mint} ↗
          </a>
        </dd>
        <dt>DBC pool</dt>
        <dd>{token.pool}</dd>
        <dt>Creator</dt>
        <dd>{token.creator}</dd>
      </dl>
      <QuoteIdentity mint={token.quoteMint} decimals={token.quoteDecimals} />
      <div className="token-metric">
        <span>Curve progress · quote reserve</span>
        <strong>
          {token.progress === undefined
            ? token.status === "migrated"
              ? "Not applicable"
              : "Unavailable"
            : `${(token.progress * 100).toFixed(2)}%`}
        </strong>
      </div>
      {token.progress !== undefined && (
        <progress
          max={1}
          value={token.progress}
          aria-label="Quote reserve migration progress"
        />
      )}
      <div className="token-metric">
        <span>DBC Claimable Fees · base</span>
        <strong>
          {tokenAmount(token.base, token.baseDecimals)}{" "}
          {token.symbol || "base tokens"}
        </strong>
      </div>
      <div className="token-metric">
        <span>DBC Claimable Fees · quote</span>
        <strong>
          {tokenAmount(token.quote, token.quoteDecimals)}{" "}
          {token.quoteMint === "So11111111111111111111111111111111111111112"
            ? "SOL"
            : "quote tokens"}
        </strong>
      </div>
      <div className="token-metric">
        <span>Last verified local claim</span>
        {token.lastClaim ? (
          <a
            href={tokenExplorer(token.network, "tx", token.lastClaim.signature)}
            target="_blank"
            rel="noreferrer"
          >
            {token.lastClaim.blockTime
              ? new Intl.DateTimeFormat("en-GB", {
                  timeZone: "Asia/Singapore",
                  year: "numeric",
                  month: "short",
                  day: "2-digit",
                  hour: "2-digit",
                  minute: "2-digit",
                  hour12: false,
                  timeZoneName: "short",
                }).format(new Date(token.lastClaim.blockTime * 1000))
              : `Slot ${token.lastClaim.slot}`}{" "}
            ↗
          </a>
        ) : (
          <span>Not available</span>
        )}
      </div>
      <MigrationStatus migration={token.migration} network={token.network} />
      {token.status === "migrated" && (
        <p className="fine">
          Fees above are residual DBC trading fees. DAMM V2 position fees are
          not included.
        </p>
      )}
      <div className="token-actions">
        <a
          href="#creator-fees"
          onClick={() => selectCreatorFees(token, token.network, onFees)}
        >
          View Creator Fees
        </a>
        <a
          href={tokenExplorer(token.network, "account", token.pool)}
          target="_blank"
          rel="noreferrer"
        >
          View on Solscan ↗
        </a>
      </div>
    </article>
  );
}
export default function MyTokens({
  network,
  owner,
  revision,
  verifiedPool,
  onFees,
}: {
  network: Network;
  owner?: string;
  revision: number;
  verifiedPool?: string;
  onFees: (pool: string) => void;
}) {
  const [tokens, setTokens] = useState<TokenView[]>([]),
    [errors, setErrors] = useState<{ pool: string; message: string }[]>([]),
    [busy, setBusy] = useState(false),
    [address, setAddress] = useState(""),
    [error, setError] = useState("");
  const generation = useRef(0),
    locked = useRef(false);
  const enabled =
    network !== "mainnet-beta" ||
    mainnetTransactionsEnabled();
  useEffect(() => {
    let stop = false;
    const id = ++generation.current;
    const timer = setTimeout(async () => {
      if (!owner || !enabled) return;
      locked.current = true;
      setBusy(true);
      setError("");
      setTokens([]);
      setErrors([]);
      try {
        const data = await refreshTokens(
          connection(network),
          network,
          owner,
          developmentStorage(),
          verifiedPool ? [verifiedPool] : [],
        );
        if (!stop && id === generation.current) {
          setTokens(data.tokens);
          setErrors(data.errors);
        }
      } catch (e) {
        if (!stop) setError(e instanceof Error ? e.message : "RPC unavailable");
      } finally {
        if (!stop) {
          locked.current = false;
          setBusy(false);
        }
      }
    }, 0);
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [network, owner, revision, enabled, verifiedPool]);
  async function load(importAddress?: string) {
    if (!owner || locked.current || !enabled) return;
    locked.current = true;
    setBusy(true);
    setError("");
    setTokens([]);
    setErrors([]);
    const id = ++generation.current;
    try {
      if (importAddress)
        await importToken(
          connection(network),
          network,
          importAddress,
          owner,
          developmentStorage(),
        );
      const data = await refreshTokens(
        connection(network),
        network,
        owner,
        developmentStorage(),
        verifiedPool ? [verifiedPool] : [],
      );
      if (id === generation.current) {
        setTokens(data.tokens);
        setErrors(data.errors);
        if (importAddress) setAddress("");
      }
    } catch (e) {
      if (id === generation.current)
        setError(e instanceof Error ? e.message : "RPC unavailable");
    } finally {
      if (id === generation.current) {
        locked.current = false;
        setBusy(false);
      }
    }
  }
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  return (
    <section
      id="my-tokens"
      className="results my-tokens"
      aria-label="My Tokens"
      aria-busy={busy}
    >
      <div className="token-section-heading">
        <div>
          <span className="eyebrow">YOUR ON-CHAIN PORTFOLIO</span>
          <h2>My Tokens</h2>
        </div>
        <button disabled={busy || !owner || !enabled} onClick={() => load()}>
          Refresh tokens
        </button>
      </div>
      <p className="fine">
        Verified pools for the connected creator wallet. Progress is quote
        reserve versus migration threshold, not a price or volume estimate.
        Claims are limited to verifiable locally retained signatures.
      </p>
      {!owner ? (
        <div className="empty-state">
          <span className="empty-state-icon" aria-hidden="true">
            ◇
          </span>
          <h3>Your portfolio starts here</h3>
          <p>Connect Phantom from the navigation to discover your tokens.</p>
          <small>
            Only verified launches and pools you explicitly import appear here.
          </small>
        </div>
      ) : !enabled ? (
        <p className="fine">
          Launching Soon. Token tools open when launches begin.
        </p>
      ) : (
        <>
          <div className="token-import">
            <label htmlFor="token-pool-import">Import DBC pool address</label>
            <input
              id="token-pool-import"
              value={address}
              disabled={busy}
              placeholder="DBC pool public key"
              onChange={(e) => setAddress(e.target.value)}
            />
            <button
              disabled={busy || !address.trim()}
              onClick={() => load(address.trim())}
            >
              Verify & import
            </button>
          </div>
          {busy && (
            <p role="status" className="fine">
              Reading token accounts and fees from {activeNetworkLabel(network)}…
            </p>
          )}
          {!busy && !error && !tokens.length && !errors.length && (
            <p className="fine">
              No verified tokens found for this wallet and network. Import a
              pool address or complete a verified launch.
            </p>
          )}
          {error && (
            <p role="alert" className="error">
              Token data unavailable: {error}. Check storage/network/RPC and
              refresh. No recovery records were changed.
            </p>
          )}
          {errors.map((e) => (
            <p role="alert" className="error" key={e.pool}>
              Pool unavailable or not owned by this wallet: {e.pool}
              <br />
              {e.message}. Verify the selected network and RPC, then refresh.
            </p>
          ))}
          <div className="token-grid">
            {tokens.map((token) => (
              <TokenCard key={token.pool} token={token} onFees={onFees} />
            ))}
          </div>
        </>
      )}
    </section>
  );
}
