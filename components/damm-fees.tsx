"use client";

import { developmentStorage } from "../lib/development-storage";
import { useEffect, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { NATIVE_MINT } from "@solana/spl-token";
import { connection, sol, type Network } from "../lib/transactions";
import { withLaunchLock } from "../lib/recovery";
import { tokenAmount, type FeeView } from "../lib/creator-fees";
import {
  readDammPositions,
  prepareDammClaim,
  executeDammClaim,
  refreshDammClaim,
  dammRecord,
  type DammView,
  type DammPlan,
  type DammRecord,
} from "../lib/damm-fees";
import { claimNetworkLabel, mainnetTransactionsEnabled, testNetworkRequested } from "../lib/app-network";
import { HYPE_MINT } from "../lib/quote-assets";
import { EarningsCard, ClaimConfirmation } from "./earnings-card";
import type { ReactNode } from "react";
import { QuoteIdentity } from "./quote-identity";

type Props = {
  dbc: FeeView;
  network: Network;
  tokenName?: string;
  tokenSymbol?: string;
  imageUrl?: string;
  onConfirmed?: () => void;
  /** DBC launch-pool tools, shown inside this card once the DBC card is hidden after graduation. */
  dbcAdvanced?: ReactNode;
};

const compactAmount = (amount: bigint, decimals: number) => {
  const exact = tokenAmount(amount, decimals);
  return decimals ? exact.replace(/(\.\d*?[1-9])0+$/, "$1").replace(/\.0+$/, "") : exact;
};

export default function DammFees({ dbc, network, tokenName, tokenSymbol, imageUrl, onConfirmed, dbcAdvanced }: Props) {
  const wallet = useWallet();
  const owner = wallet.publicKey?.toBase58();
  const [view, setView] = useState<DammView>();
  const [plan, setPlan] = useState<DammPlan>();
  const [record, setRecord] = useState<DammRecord>();
  const [busy, setBusy] = useState(false);
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState("");
  const lock = useRef(false);
  const alive = useRef(true);
  const enabled = network !== "mainnet-beta" || mainnetTransactionsEnabled();
  const networkLabel = claimNetworkLabel(network);
  const hasHypeQuote = dbc.quoteMint === HYPE_MINT.toBase58();

  useEffect(() => {
    alive.current = true;
    let stopped = false;
    const timer = setTimeout(async () => {
      if (!owner || !wallet.publicKey) return;
      try {
        setRecord(dammRecord(developmentStorage(), network, owner));
        const data = await readDammPositions(connection(network), network, dbc.pool, wallet.publicKey);
        if (!stopped) setView(data);
      } catch (e) {
        if (!stopped) setError(e instanceof Error ? e.message : String(e));
      }
    }, 0);
    return () => {
      stopped = true;
      alive.current = false;
      clearTimeout(timer);
    };
  }, [owner, network, dbc.pool, wallet.publicKey]);

  async function act(action: () => Promise<void>) {
    if (!owner || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await withLaunchLock(network, owner, action);
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      lock.current = false;
      if (alive.current) {
        setBusy(false);
        try { setRecord(dammRecord(developmentStorage(), network, owner)); }
        catch (e) { setError(String(e)); }
      }
    }
  }

  async function refreshPositions() {
    if (!wallet.publicKey) return;
    setPlan(undefined);
    setConsent(false);
    const data = await readDammPositions(connection(network), network, dbc.pool, wallet.publicKey);
    if (alive.current) setView(data);
  }

  const planHypeAmount = plan && plan.view.dbc.quoteMint === HYPE_MINT.toBase58()
    ? compactAmount(plan.position.b, plan.view.decimals[1])
    : undefined;
  const name = tokenName || "Creator position", stage = "Graduated · Creator fees";
  const confirm = () => act(async () => {
    if (!plan || !consent || !wallet.signTransaction) throw Error("Explicit consent and Phantom signing are required");
    const result = await executeDammClaim(connection(network), plan, wallet.publicKey!, wallet.signTransaction, developmentStorage());
    if (alive.current) { setRecord(result.record); setView(result.view); setPlan(undefined); setConsent(false); if (result.record.state === "confirmed") onConfirmed?.(); }
  });
  const history = (
    <>
      <p className="creator-claim-note">Only independently verified position-NFT ownership qualifies. No position NFTs or liquidity are moved. Delegated, escrow-owned, protocol-managed and unsupported Token-2022 positions cannot be claimed.</p>
      <QuoteIdentity mint={dbc.quoteMint} decimals={dbc.quoteDecimals} />
      <button type="button" className="creator-claim-secondary" disabled={busy || !owner} onClick={() => act(refreshPositions)}>Refresh eligible positions</button>
      {record && <div className="damm-technical-grid">
        <div><span>Claim network</span><code>{claimNetworkLabel(record.network)}</code></div>
        <div><span>Transaction signature</span><code>{record.signature}</code></div>
        <div><span>Reviewed transaction fee</span><code>{record.reviewedFee ? sol(BigInt(record.reviewedFee)) + " SOL" : "Unavailable"}</code></div>
        <div><span>Actual transaction fee</span><code>{record.actualFee ? sol(BigInt(record.actualFee)) + " SOL" : "Unavailable"}</code></div>
        <button type="button" className="creator-claim-secondary" disabled={busy || !owner} onClick={() => act(async () => {
          const saved = dammRecord(developmentStorage(), network, owner!);
          if (!saved) throw Error("No DAMM signature journal");
          const refreshed = await refreshDammClaim(connection(network), developmentStorage(), saved);
          if (alive.current) { setRecord(refreshed.record); if (saved.pool === dbc.pool) setView(refreshed.view); setPlan(undefined); setConsent(false); if (refreshed.record.state === "confirmed") onConfirmed?.(); }
        })}>Check claim signature &amp; refresh</button>
      </div>}
      {dbcAdvanced && <details className="damm-advanced"><summary>DBC launch pool</summary>{dbcAdvanced}</details>}
    </>
  );
  const footer = (
    <>
      {record && <div className="creator-claim-status" role="status"><span>DAMM claim {record.state}</span>{testNetworkRequested() ? <span>Localnet signature saved</span> : <a href={`https://solscan.io/tx/${record.signature}${network === "devnet" ? "?cluster=devnet" : ""}`} target="_blank" rel="noopener noreferrer">View transaction ↗</a>}</div>}
      {record?.signingIssue && <p role="alert" className="error">{record.signingIssue}. Check the saved signature before another claim.</p>}
      {error && <p role="alert" className="error">{error}</p>}
    </>
  );

  // No position to show yet: a single card explains why (loading, not connected, or none owned).
  if (!view || !view.positions.length)
    return (
      <section className="creator-claim damm-claim-section" aria-label="DAMM v2 position fees">
        <EarningsCard
          venue="DAMM v2" name={name} ticker={tokenSymbol} imageUrl={imageUrl} stage={stage}
          note={!owner ? "Connect Phantom from the navbar to check position fees." : !view ? (error ? "Position fees could not be verified." : "Checking your DAMM v2 position…") : "No DAMM v2 position owned by this wallet."}
          advanced={history}
        >{footer}</EarningsCard>
      </section>
    );

  return (
    <section className="creator-claim damm-claim-section" aria-label="DAMM v2 position fees">
      {view.positions.map((position) => {
        const hypeAmount = hasHypeQuote ? compactAmount(position.b, view.decimals[1]) : undefined;
        const hasFees = position.a > 0n || position.b > 0n;
        const reviewing = plan?.position.position === position.position;
        return (
          <EarningsCard
            key={position.position}
            venue="DAMM v2" name={name} ticker={tokenSymbol} imageUrl={imageUrl} stage={stage}
            amount={hypeAmount === undefined ? undefined : `${hypeAmount} HYPE`}
            note={!view.supported ? "Claims are unavailable for this pool’s token program or fee mode." : record?.state === "pending" ? "A claim is pending. Check its saved signature in Advanced details." : hasFees ? `Verified from your on-chain DAMM v2 position on ${networkLabel}.` : "No position fees yet."}
            action={reviewing ? undefined : {
              label: hasFees ? "Claim Creator Fees" : "No fees to claim",
              disabled: busy || !enabled || !view.supported || !hasFees || record?.state === "pending",
              onClick: () => act(async () => {
                const pending = dammRecord(developmentStorage(), network, owner!);
                if (pending?.state === "pending") throw Error("Check the pending DAMM signature first");
                const reviewed = await prepareDammClaim(connection(network), network, dbc.pool, position.position, wallet.publicKey!);
                if (alive.current) { setPlan(reviewed); setConsent(false); }
              }),
            }}
            advanced={
              <>
                <div className="damm-technical-grid">
                  <div><span>DAMM v2 pool</span><code>{dbc.migration.destination}</code></div>
                  <div><span>Position address</span><code>{position.position}</code></div>
                  <div><span>Position NFT</span><code>{position.nft}</code></div>
                  <div><span>NFT token account</span><code>{position.nftAccount}</code></div>
                  <div><span>Verified wallet owner</span><code>{owner}</code></div>
                  <div><span>Permanently locked liquidity</span><code>{position.locked}</code></div>
                  <div><span>Unlocked / vested liquidity</span><code>{position.unlocked} / {position.vested}</code></div>
                  <div><span>Claimable token A</span><code>{view.supported ? tokenAmount(position.a, view.decimals[0]) : "Unavailable for this claim mode"} ({view.pool.tokenAMint.toBase58()})</code></div>
                  <div><span>Claimable token B</span><code>{view.supported ? tokenAmount(position.b, view.decimals[1]) : "Unavailable for this claim mode"} ({view.pool.tokenBMint.equals(NATIVE_MINT) ? "SOL / WSOL" : view.pool.tokenBMint.toBase58()})</code></div>
                </div>
                {reviewing && plan && (
                  <div className="damm-technical-grid">
                    <div><span>Destination accounts</span><code>{plan.claim.destinations.join(" · ")}</code></div>
                    <div><span>Missing account rent estimate</span><code>{sol(plan.claim.rent)} SOL</code></div>
                    <div><span>Existing WSOL to unwrap</span><code>{sol(plan.existingWsol)} SOL</code></div>
                    <details className="damm-advanced-instructions">
                      <summary>Reviewed transaction instructions</summary>
                      {plan.instructions.map((instruction, index) => <code key={index}>{index + 1}. {instruction}</code>)}
                    </details>
                  </div>
                )}
                {history}
              </>
            }
          >
            {reviewing && plan && (
              <ClaimConfirmation
                amount={planHypeAmount === undefined ? "Non-HYPE fees" : `${planHypeAmount} HYPE`}
                network={networkLabel}
                recipient={plan.claim.wallet}
                fee={`${sol(plan.claim.fee)} SOL`}
                consent={consent}
                onConsent={setConsent}
                busy={busy}
                canConfirm={enabled && Boolean(wallet.signTransaction) && record?.state !== "pending"}
                onConfirm={confirm}
                onCancel={() => { setPlan(undefined); setConsent(false); }}
              />
            )}
            {footer}
          </EarningsCard>
        );
      })}
    </section>
  );
}
