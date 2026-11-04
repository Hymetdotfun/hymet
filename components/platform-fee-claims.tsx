"use client";

import { useCallback, useEffect, useState } from "react";
import {
  useConnection,
  useWallet,
} from "@solana/wallet-adapter-react";
import { Transaction } from "@solana/web3.js";
import { Buffer } from "buffer";
import {
  platformFeeAuthorizationMessage,
  type PlatformFeeAction,
} from "../lib/platform-fee-auth";
import { executeWalletOperation } from "../lib/wallet-operation";
import { platformFeeGeneration, type PlatformFeeGeneration } from "../lib/platform-wallets";
import { activeNetworkLabel, mainnetTransactionsEnabled, testNetworkRequested } from "../lib/app-network";

type ClaimRow = {
  key: string;
  kind: "dbc" | "damm";
  protocol: string;
  pool: string;
  mint: string;
  ticker: string;
  name: string;
  verified: boolean;
  generation?: PlatformFeeGeneration | null;
  feeClaimer?: string;
  base: string | null;
  baseMint?: string;
  baseDecimals?: number;
  hype: string | null;
  claimable: boolean;
  migrated: boolean | null;
  position: string | null;
  lockedLiquidity?: string;
  error?: string;
};

type ApiResponse = {
  rows?: ClaimRow[];
  source?: string;
  error?: string;
  transaction?: string;
  lastValidBlockHeight?: number;
  summary?: {
    protocol: string;
    base: string;
    hype: string;
    feeLamports: string;
    rentLamports: string;
  };
};

function PlatformFeeClaims() {
  return <PlatformFeeClaimsWallet />;
}

function lamports(value: string) {
  const amount = BigInt(value);
  return `${amount / 1_000_000_000n}.${(amount % 1_000_000_000n)
    .toString()
    .padStart(9, "0")} SOL`;
}

function PlatformFeeClaimsWallet() {
  const {
    publicKey,
    signMessage,
    signTransaction,
  } = useWallet();
  const { connection } = useConnection();
  const [rows, setRows] = useState<ClaimRow[] | null>(null);
  const [source, setSource] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [busyRow, setBusyRow] = useState("");
  const [status, setStatus] = useState("");
  const [signature, setSignature] = useState("");
  const configured = process.env.NEXT_PUBLIC_HYMET_PLATFORM_FEE_RECIPIENT || "";
  // The legacy wallet stays the immutable feeClaimer of launches made before the platform wallet change.
  const generation = publicKey && configured ? platformFeeGeneration(publicKey, configured) : null;
  const isPlatform = generation !== null;
  const isMainnetEnabled = mainnetTransactionsEnabled();

  useEffect(() => {
    if (!publicKey || !configured || !platformFeeGeneration(publicKey, configured)) return;
    const key = `hymet:fee-operation:v1:${publicKey.toBase58()}`;
    let active = true;
    const timer = window.setTimeout(() => {
      let record: { phase?: string; signature?: string };
      try {
        record = JSON.parse(window.localStorage.getItem(key) || "null");
        if (
          !record ||
          !["awaiting-signature", "signed", "confirmed", "failed"].includes(record.phase || "")
        )
          return;
      } catch {
        return;
      }
      if (record.signature && /^[1-9A-HJ-NP-Za-km-z]{80,100}$/.test(record.signature))
        setSignature(record.signature);
      const initialPhase = record.phase;
      setStatus(
        initialPhase === "confirmed"
          ? "The latest platform claim is confirmed."
          : initialPhase === "failed"
            ? "The latest platform claim failed; inspect its Solscan record before retrying."
            : initialPhase === "signed"
              ? "The latest platform claim has a saved signature; checking confirmation."
              : "A platform claim signature prompt was opened previously.",
      );
      if (initialPhase !== "signed" || !record.signature) return;
      void (async () => {
      try {
        const result = await connection.getSignatureStatuses([record.signature!], {
          searchTransactionHistory: true,
        });
        const chain = result.value[0];
        if (!active || !chain) return;
        if (chain.confirmationStatus === "confirmed" || chain.confirmationStatus === "finalized") {
          const phase = chain.err ? "failed" : "confirmed";
          const latest = JSON.parse(window.localStorage.getItem(key) || "null");
          if (latest?.signature === record.signature)
            window.localStorage.setItem(key, JSON.stringify({ ...latest, phase }));
          setStatus(chain.err ? "The latest platform claim failed on-chain." : "The latest platform claim is confirmed.");
        }
      } catch {
        // Keep the saved signature visible; a later refresh can retry this read-only check.
      }
      })();
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [configured, connection, publicKey]);

  const authorize = useCallback(
    async (
      action: PlatformFeeAction,
      pool?: string,
      position?: string,
    ): Promise<{ authorization: Record<string, string>; origin: string }> => {
      if (!publicKey || !signMessage)
        throw Error("Phantom message signing is required to access platform claims");
      if (!isPlatform) throw Error("Connected wallet is not the designated HYMET platform wallet");
      const origin = window.location.origin;
      const authorization = {
        wallet: publicKey.toBase58(),
        action,
        ...(pool ? { pool } : {}),
        ...(position ? { position } : {}),
        issuedAt: new Date().toISOString(),
        nonce: crypto.randomUUID(),
      };
      const signed = await signMessage(
        new TextEncoder().encode(
          platformFeeAuthorizationMessage(authorization, origin),
        ),
      );
      return {
        authorization: {
          ...authorization,
          signature: Buffer.from(signed).toString("base64"),
        },
        origin,
      };
    },
    [isPlatform, publicKey, signMessage],
  );

  const api = useCallback(
    async (action: PlatformFeeAction, pool?: string, position?: string) => {
      const { authorization } = await authorize(action, pool, position);
      const response = await fetch("/api/platform-fees", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify(authorization),
      });
      const data = (await response.json()) as ApiResponse;
      if (!response.ok) throw Error(data.error || "Platform fee API request failed");
      return data;
    },
    [authorize],
  );

  const refresh = useCallback(async () => {
    if (!isPlatform) return;
    setBusy(true);
    setError("");
    setStatus("Sign the wallet verification message in Phantom. No transaction is submitted.");
    try {
      const data = await api("inspect");
      setRows(data.rows ?? []);
      setSource(data.source ?? "Verified on-chain claim balances");
      setStatus(`Claim balances were verified against confirmed ${activeNetworkLabel("Mainnet")} accounts.`);
    } catch (cause) {
      setRows(null);
      setError(cause instanceof Error ? cause.message : "Could not verify platform fees");
      setStatus("");
    } finally {
      setBusy(false);
    }
  }, [api, isPlatform]);

  const claim = async (row: ClaimRow) => {
    if (!publicKey || !signTransaction || !isPlatform) return;
    setBusy(true);
    setBusyRow(row.key);
    setError("");
    setSignature("");
    setStatus("Rechecking current on-chain fees and preparing the claim.");
    try {
      const action = row.kind === "dbc" ? "prepare-dbc" : "prepare-damm";
      const data = await api(action, row.pool, row.position ?? undefined);
      if (!data.transaction || data.lastValidBlockHeight === undefined || !data.summary)
        throw Error("The verified fee API returned an incomplete transaction review");
      setStatus(
        `${data.summary.protocol} · ${data.summary.hype} HYPE and ${data.summary.base} ${row.ticker} · network fee ${lamports(data.summary.feeLamports)} · possible account rent ${lamports(data.summary.rentLamports)}. Review and approve in Phantom.`,
      );
      const tx = Transaction.from(Buffer.from(data.transaction, "base64"));
      if (!tx.feePayer?.equals(publicKey)) throw Error("Prepared transaction fee payer does not match the platform wallet");
      const result = await executeWalletOperation(
        connection,
        tx,
        publicKey,
        signTransaction,
        window.localStorage,
        data.lastValidBlockHeight,
        undefined,
        undefined,
        { allowWalletGuards: true },
      );
      setSignature(result);
      setStatus("Claim transaction confirmed.");
      setRows(null);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Platform claim failed";
      let txSignature = message.match(/[1-9A-HJ-NP-Za-km-z]{80,100}/)?.[0];
      try {
        const saved = JSON.parse(
          window.localStorage.getItem(`hymet:fee-operation:v1:${publicKey.toBase58()}`) || "null",
        );
        if (saved?.signature && /^[1-9A-HJ-NP-Za-km-z]{80,100}$/.test(saved.signature))
          txSignature = saved.signature;
        if (saved?.phase === "signed")
          setStatus("Claim signature was saved; confirmation is unresolved. Check Solscan before retrying.");
      } catch {
        // Surface the original transaction error if local recovery state is unreadable.
      }
      if (txSignature) setSignature(txSignature);
      setError(message);
      if (!txSignature) setStatus("");
    } finally {
      setBusy(false);
      setBusyRow("");
    }
  };

  if (!publicKey) return null;

  if (!isPlatform) return null;

  return (
    <section className="platform-claims panel-card" aria-labelledby="platform-claims-title">
      <div className="platform-claims-heading">
        <div>
          <span className="eyebrow">{generation === "legacy" ? "LEGACY PLATFORM WALLET" : "AUTHORIZED PLATFORM WALLET"}</span>
          <h2 id="platform-claims-title">HYMET fee claims</h2>
          <p className="platform-wallet-address">{publicKey.toBase58()}</p>
          <p className="platform-claims-generation">
            {generation === "legacy"
              ? "Fee claimer of launches made before the platform wallet change (HYTEST, DOGE, HYPAD). New launches pay the current platform wallet."
              : "Current platform wallet: fee claimer of every launch since the platform wallet change. Earlier launches are claimed from the legacy wallet."}
          </p>
        </div>
      </div>
      <p className="platform-claims-copy">View fee amounts verified from confirmed {activeNetworkLabel("Mainnet")} pool and position accounts. Each claim is rebuilt server-side, simulated, and requires a Phantom transaction signature.</p>
      <div className="platform-claims-actions">
        <button className="button-primary" type="button" onClick={() => void refresh()} disabled={busy || !signMessage}>
          {busy && !busyRow ? "Verifying…" : "Verify claimable fees"}
        </button>
        {!isMainnetEnabled && <span className="platform-claims-gate">{testNetworkRequested() ? "Localnet claims are blocked: the test network is misconfigured." : "Mainnet financial operations are disabled in the current production configuration."}</span>}
      </div>
      {error && <p className="platform-claims-error" role="alert">{error}</p>}
      {status && <p className="platform-claims-status" role="status">{status}</p>}
      {signature && (
        <p className="platform-claims-signature">
          Transaction: <a href={`https://solscan.io/tx/${signature}`} target="_blank" rel="noreferrer">View on Solscan ↗</a>
        </p>
      )}
      {rows && rows.length === 0 && (
        <div className="platform-claims-empty">No confirmed HYMET HYPE launches name this wallet as their platform fee claimer.</div>
      )}
      {rows && rows.length > 0 && (
        <>
          <p className="platform-claims-source">{source} · HYPE-denominated values shown in HYPE.</p>
          <div className="platform-claim-list">
            {rows.map((row) => (
              <article className="platform-claim-row" key={row.key}>
                <div className="platform-claim-main">
                  <div className="platform-claim-token">
                    <strong>{row.name} <span>${row.ticker}</span></strong>
                    <small>{row.protocol}{row.generation ? ` · ${row.generation === "legacy" ? "legacy launch" : "current platform wallet"}` : ""}</small>
                    <small className="platform-claim-pool">Pool {row.pool}</small>
                  </div>
                  {row.verified ? (
                    <div className="platform-claim-amounts">
                      <div><small>Claimable HYPE</small><strong>{row.hype} HYPE</strong></div>
                      <div><small>Claimable token fees</small><strong>{row.base} {row.ticker}</strong></div>
                    </div>
                  ) : (
                    <p className="platform-claims-error" role="status">On-chain verification unavailable: {row.error}</p>
                  )}
                </div>
                {row.verified && row.kind === "dbc" && (
                  <p className="platform-claim-migration">{row.migrated ? "DBC fees remain separately claimable · DAMM v2 positions listed below" : "DBC trading fees · migration not yet verified"}</p>
                )}
                {row.verified && row.kind === "damm" && (
                  <p className="platform-claim-migration">Permanently locked platform position · liquidity {row.lockedLiquidity}</p>
                )}
                {row.verified && row.claimable && (
                  <button className="platform-claim-button" type="button" onClick={() => void claim(row)} disabled={busy || !isMainnetEnabled || !signTransaction || !signMessage}>
                    {busyRow === row.key ? "Preparing claim…" : `Claim ${row.kind === "dbc" ? "DBC" : "DAMM v2"} fees`}
                  </button>
                )}
                {row.verified && !row.claimable && <span className="platform-claim-zero">No claimable fees</span>}
              </article>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

export { PlatformFeeClaims };
