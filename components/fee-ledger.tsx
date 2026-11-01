"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useConnection } from "@solana/wallet-adapter-react";
import { Transaction } from "@solana/web3.js";
import { Buffer } from "buffer";
import { executeWalletOperation } from '../lib/wallet-operation';

type Ledger = {
  indexed: boolean;
  source?: string;
  chainVerified?: boolean;
  distributorEnabled?: boolean;
  holderRewards?: { enabled: boolean; automatic: boolean; intervalHours: number };
  holderPayouts?: { mint: string; epoch: string; reward: string; paid: boolean; signature: string | null }[];
  distributorProgramId?: string | null;
  creatorTokens?: {mint:string;ticker:string}[];
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
  const feeAction=async(mint:string,action:'collect'|'migrate'|'creator')=>{
    if(!publicKey || !signTransaction || !ledger?.chainVerified) return;
    setBusy(true);setClaimMessage('');
    try {
      const response=await fetch('/api/fees/transaction',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mint,action,wallet:publicKey.toBase58()})});
      const data=await response.json();
      if(!response.ok) throw Error(data.error || 'Fee transaction unavailable');
      const transaction=Transaction.from(Buffer.from(data.transaction,'base64'));
      if(!transaction.feePayer?.equals(publicKey)) throw Error('Transaction wallet mismatch');
      const signature=await executeWalletOperation(connection,transaction,publicKey,signTransaction,localStorage,data.lastValidBlockHeight);
      setClaimMessage(`Confirmed ${action} · ${signature}. Indexed totals update after confirmed-chain indexing.`);
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
          <div><h2 id="holder-rewards-title">Holder Rewards</h2><p>Passive rewards are shown only when verified payouts are active.</p></div>
        </div>
        {!automaticHolderPayouts ? (
          <p className="fees-inactive-state">Not active yet</p>
        ) : ledger?.holderPayouts?.length ? (
          <div className="fees-payout-list" aria-label="Verified holder payout history">
            {ledger.holderPayouts.map(p => <article key={`${p.mint}:${p.epoch}`}><span>Epoch {p.epoch}</span><strong>{formatHype(p.reward, true)}</strong><small>{p.paid ? `Paid${p.signature ? ` · ${p.signature.slice(0, 8)}…` : ""}` : "Scheduled"}</small></article>)}
          </div>
        ) : (
          <p className="fees-inactive-state">Automatic payouts are active; no confirmed payouts are indexed yet.</p>
        )}
      </section>

      {ledger?.chainVerified && !!ledger.creatorTokens?.length && (
        <section className="fees-pool-operations" aria-labelledby="pool-operations-title">
          <div className="fees-section-heading"><div><h2 id="pool-operations-title">Your Launch Pools</h2><p>Fee actions are built from verified pool state and require Phantom approval.</p></div></div>
          {ledger.creatorTokens.map(token=>(
            <article className="fees-pool-row" key={token.mint}>
              <div><strong>${token.ticker}</strong><span>{token.mint}</span></div>
              <div className="trade-actions">
                <button disabled={busy} onClick={()=>void feeAction(token.mint,'collect')}>Collect &amp; settle</button>
                <button disabled={busy} onClick={()=>void feeAction(token.mint,'creator')}>Claim creator fees</button>
                <button disabled={busy} onClick={()=>void feeAction(token.mint,'migrate')}>Migrate eligible pool</button>
              </div>
            </article>
          ))}
          {claimMessage && <p className="fees-transaction-message" role="status">{claimMessage}</p>}
        </section>
      )}
    </>
  );
}
