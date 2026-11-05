"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useConnection } from "@solana/wallet-adapter-react";
import { Transaction } from "@solana/web3.js";
import { Buffer } from "buffer";
import { executeWalletOperation } from '../lib/wallet-operation';
import { EarningsCard } from './earnings-card';
import { claimNetworkLabel, mainnetTransactionsEnabled } from '../lib/app-network';
import type { LaunchStatus } from '../lib/launch-status';

type Ledger = {
  indexed: boolean;
  source?: string;
  chainVerified?: boolean;
  distributorEnabled?: boolean;
  holderRewards?: { enabled: boolean; automatic: boolean; intervalMinutes: number; mainnetPayoutVerified?: boolean };
  holderPayouts?: { mint: string; epoch: string; reward: string; paid: boolean; signature: string | null }[];
  holderCarry?: { mint: string; amount: string }[];
  distributorProgramId?: string | null;
  creatorTokens?: LaunchStatus[];
  totals?: {
    accrued: string;
    hymet: string;
    creator: string;
    holders: string;
    lastSettlementAt: string | null;
  };
  note?: string;
};
const empty = {
  accrued: "—",
  hymet: "—",
  creator: "—",
  holders: "—",
  lastSettlementAt: null,
};

function formatHype(value: string | undefined, available: boolean) {
  if (!available || !value || !/^\d+(?:\.\d+)?$/.test(value)) return "Unavailable";
  const [whole, fraction = ""] = value.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const decimals = fraction.slice(0, 6).replace(/0+$/, "");
  return `${grouped}${decimals ? `.${decimals}` : ""} HYPE`;
}

export function FeeLedger() {
  return <FeeLedgerWallet />;
}

function FeeLedgerWallet() {
  const { publicKey, signTransaction } = useWallet();
  const { connection } = useConnection();
  const [ledgerState, setLedger] = useState<Ledger | null>(null);
  const [loadedWallet, setLoadedWallet] = useState<string | null>(null);
  const walletAddress=publicKey?.toBase58()||"";
  const ledger=loadedWallet===walletAddress?ledgerState:null;
  const latestRequest=useRef(0);
  const [busy, setBusy] = useState(false);
  const [claimMessage, setClaimMessage] = useState("");
  const load = useCallback(() => {
    const request=++latestRequest.current;
    const wallet = publicKey?.toBase58();
    const params = wallet ? `?wallet=${encodeURIComponent(wallet)}` : "";
    return fetch(`/api/fees${params}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((data) => {
        if(request!==latestRequest.current)return;
        setLedger(data);
        setLoadedWallet(wallet||"");
      })
      .catch(() => {
        if(request!==latestRequest.current)return;
        setLedger({ indexed: false });
        setLoadedWallet(wallet||"");
      });
  }, [publicKey]);
  useEffect(() => {
    void load();
  }, [load]);
  // The only wallet action here is the creator's own claim; collection, settlement, migration and holder payouts are keeper-only.
  const claimCreatorFees=async(mint:string)=>{
    if(!publicKey || !signTransaction || !ledger?.chainVerified) return;
    setBusy(true);setClaimMessage('');
    try {
      const response=await fetch('/api/fees/transaction',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mint,action:'creator',wallet:publicKey.toBase58()})});
      const data=await response.json();
      if(!response.ok) throw Error(data.error || 'Fee transaction unavailable');
      const transaction=Transaction.from(Buffer.from(data.transaction,'base64'));
      if(!transaction.feePayer?.equals(publicKey)) throw Error('Transaction wallet mismatch');
      const signature=await executeWalletOperation(connection,transaction,publicKey,signTransaction,localStorage,data.lastValidBlockHeight,undefined,undefined,{allowWalletGuards:true});
      setClaimMessage(`Confirmed creator claim · ${signature}. Indexed totals update after confirmed-chain indexing.`);
      await load();
    } catch(error) {setClaimMessage(error instanceof Error?error.message:'Transaction failed');}
    finally {setBusy(false);}
  };
  const totals = ledger?.indexed && ledger.totals ? ledger.totals : empty;
  const indexed = Boolean(ledger?.indexed && ledger.totals);
  const fmtTime = totals.lastSettlementAt
    ? new Date(totals.lastSettlementAt).toLocaleString()
    : "No confirmed settlement indexed";
  const automaticHolderPayouts = ledger?.holderRewards?.automatic === true;
  const mainnetPayoutVerified = ledger?.holderRewards?.mainnetPayoutVerified === true;
  return (
    <>
      <section className="fees-overview" aria-labelledby="fees-overview-title">
        <div className="fees-section-heading">
          <div><h2 id="fees-overview-title">Fee Overview</h2><p>Confirmed fee accounting from the HYMET index.</p></div>
          <span className={`fees-index-state ${indexed ? "is-indexed" : ""}`} role="status">{indexed ? "Indexed activity" : "Data unavailable"}</span>
        </div>
        <div className="fees-metrics">
          <article><span>Total Fees</span><strong>{formatHype(totals.accrued, indexed)}</strong><small>Distributable fees indexed</small></article>
          <article><span>Creator Fees</span><strong>{formatHype(totals.creator, indexed)}</strong><small>Creator allocation indexed</small></article>
          <article><span>Holder Rewards</span><strong>{formatHype(totals.holders, indexed)}</strong><small>Holder allocation indexed</small></article>
          <article><span>Platform Fees</span><strong>{formatHype(totals.hymet, indexed)}</strong><small>HYMET allocation indexed</small></article>
        </div>
        <p className="fees-index-note">{indexed ? `Last confirmed settlement: ${fmtTime}` : "No confirmed fee totals are available from the index right now."}</p>
      </section>

      <section className="fees-holder-section" aria-labelledby="holder-rewards-title">
        <div className="fees-section-heading">
          <div><h2 id="holder-rewards-title">Holder Rewards</h2><p>{!automaticHolderPayouts ? "Passive rewards are shown only when holder payouts are enabled." : mainnetPayoutVerified ? "Enabled and verified by confirmed Mainnet payouts." : "Configured and enabled. No Mainnet payout has been verified yet."}</p></div>
        </div>
        {!automaticHolderPayouts ? (
          <p className="fees-inactive-state">Not active yet</p>
        ) : ledger?.holderPayouts?.length || ledger?.holderCarry?.length ? (
          <div className="fees-payout-list" aria-label="Verified holder payout history">
            {ledger.holderCarry?.map(c => <article key={`carry:${c.mint}`}><span>Carried · {c.mint.slice(0, 6)}…</span><strong>{formatHype(c.amount, true)}</strong><small>Yours until paid. Paid once it reaches the payout minimum.</small></article>)}
            {ledger.holderPayouts?.map(p => <article key={`${p.mint}:${p.epoch}`}><span>Epoch {p.epoch}</span><strong>{formatHype(p.reward, true)}</strong><small>{p.paid ? `Paid${p.signature ? ` · ${p.signature.slice(0, 8)}…` : ""}` : "Scheduled"}</small></article>)}
          </div>
        ) : (
          <p className="fees-inactive-state">No confirmed payouts are indexed for this wallet yet.</p>
        )}
      </section>

      {ledger?.chainVerified && !!ledger.creatorTokens?.length && (
        <section className="fees-pool-operations earn-section" aria-labelledby="pool-operations-title">
          <div className="fees-section-heading"><div><h2 id="pool-operations-title">Your Launches</h2><p>The keeper is set up to collect, settle, migrate and pay holders without any action from you.</p></div></div>
          {ledger.creatorTokens.map((token) => {
            const creatorPct = token.creatorBps / 100, holderPct = 100 - creatorPct;
            const claimable = token.creatorClaimable ?? undefined;
            const hasClaim = token.creatorBps > 0 && claimable !== undefined && /[1-9]/.test(claimable);
            const stage = token.migration.state === "graduated" ? "Graduated · DAMM v2"
              : token.migration.state === "graduating" ? "Curve complete · migrating to DAMM v2 automatically"
              : token.migration.state === "bonding" ? `Bonding curve ${token.migration.percent ?? 0}%` : "Curve status unavailable";
            const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" }) : "—");
            return (
              <EarningsCard
                key={token.mint}
                title={`$${token.ticker.toUpperCase()}`}
                venue={token.venue}
                name={token.name}
                ticker={token.ticker}
                imageUrl={token.imageUrl ?? undefined}
                stage={`${stage} · ${creatorPct}% creator / ${holderPct}% holders`}
                amount={token.creatorBps > 0 ? (claimable === undefined ? undefined : `${formatHype(claimable, true).replace(" HYPE", "")} HYPE`) : "Automatic"}
                note={token.creatorBps > 0 ? `Your creator share, settled on-chain on ${claimNetworkLabel("mainnet-beta")}. Holders are paid by the keeper and never claim.` : "The full creator share goes to holders through keeper payouts. There is nothing to claim."}
                action={token.creatorBps > 0 ? { label: !mainnetTransactionsEnabled() ? "Launching Soon" : hasClaim ? "Claim Creator Fees" : "No creator fees yet", disabled: busy || !hasClaim || !mainnetTransactionsEnabled(), onClick: () => void claimCreatorFees(token.mint) } : undefined}
                advanced={
                  <div className="damm-technical-grid">
                    <div><span>Token mint</span><code>{token.mint}</code></div>
                    <div><span>Allocation (immutable)</span><code>{creatorPct}% creator / {holderPct}% holders of the 80%; HYMET 20%</code></div>
                  </div>
                }
              >
                <dl className="earn-status">
                  <div><dt>Settlement</dt><dd>{token.lastSettlementAt ? `Last ${when(token.lastSettlementAt)}` : "Waiting for first fees"}</dd></div>
                  <div><dt>Holder payouts</dt><dd>{token.holdersPaidCount ? `${formatHype(token.holdersPaid, true)} to ${token.holdersPaidCount} ${token.holdersPaidCount === 1 ? "holder" : "holders"} · last ${when(token.lastPayoutAt)}` : "None yet · automatic"}</dd></div>
                  <div><dt>Migration</dt><dd>{token.migration.state === "graduated" ? "Done · DAMM v2" : token.migration.state === "graduating" ? "Automatic, next keeper run" : "Automatic at 100%"}</dd></div>
                </dl>
              </EarningsCard>
            );
          })}
          {claimMessage && <p className="fees-transaction-message" role="status">{claimMessage}</p>}
        </section>
      )}
    </>
  );
}
