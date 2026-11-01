"use client";
import { developmentStorage } from "../lib/development-storage";
import { QuoteIdentity } from "./quote-identity";
import { MigrationStatus } from "./migration-status";
import DammFees from "./damm-fees";
import { useEffect, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { connection, sol, type Network } from "../lib/transactions";
import { withLaunchLock } from "../lib/recovery";
import {
  claimRecord,
  assertNoPendingClaim,
  knownCreatorPools,
  rememberCreatorPool,
  readCreatorFees,
  prepareCreatorClaim,
  executeCreatorClaim,
  refreshClaim,
  tokenAmount,
  type FeeView,
  type ClaimPlan,
  type ClaimRecord,
} from "../lib/creator-fees";
import { claimNetworkLabel, mainnetTransactionsEnabled, testNetworkRequested } from "../lib/app-network";
import { EarningsCard, ClaimConfirmation } from "./earnings-card";
import { HYPE_MINT } from "../lib/quote-assets";

type CreatorLaunchIdentity = { mint: string; name: string; ticker: string; imageUrl?: string };

export default function CreatorFees({
  network,
  verifiedPool,
  requestedPool,
  selectedLaunch,
  onClaimConfirmed,
}: {
  network: Network;
  verifiedPool?: string;
  requestedPool?: { pool: string; requestId: number };
  selectedLaunch?: CreatorLaunchIdentity;
  onClaimConfirmed?: () => void;
}) {
  const wallet = useWallet();
  return (
    <FeePanel
      key={network + ":" + (wallet.publicKey?.toBase58() || "")}
      network={network}
      verifiedPool={verifiedPool}
      requestedPool={requestedPool}
      selectedLaunch={selectedLaunch}
      onClaimConfirmed={onClaimConfirmed}
    />
  );
}

function FeePanel({
  network,
  verifiedPool,
  requestedPool,
  selectedLaunch,
  onClaimConfirmed,
}: {
  network: Network;
  verifiedPool?: string;
  requestedPool?: { pool: string; requestId: number };
  selectedLaunch?: CreatorLaunchIdentity;
  onClaimConfirmed?: () => void;
}) {
  const wallet = useWallet();
  const owner = wallet.publicKey?.toBase58();
  const [address, setAddress] = useState("");
  const [pools, setPools] = useState<string[]>([]);
  const [view, setView] = useState<FeeView>();
  const [review, setReview] = useState<ClaimPlan>();
  const [record, setRecord] = useState<ClaimRecord>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [consent, setConsent] = useState(false);
  const [notice, setNotice] = useState("");
  const lock = useRef(false);
  const alive = useRef(true);
  const enabled = network !== "mainnet-beta" || mainnetTransactionsEnabled();
  const networkLabel = claimNetworkLabel(network);
  const explorer = (signature: string) =>
    "https://solscan.io/tx/" + encodeURIComponent(signature) +
    (network === "devnet" ? "?cluster=devnet" : "");

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    let stop = false;
    const timer = setTimeout(async () => {
      if (!owner || lock.current) return;
      try {
        if (verifiedPool) rememberCreatorPool(developmentStorage(), network, owner, verifiedPool);
        const list = knownCreatorPools(developmentStorage(), network, owner);
        if (stop) return;
        setPools(list);
        const pending = claimRecord(developmentStorage(), network, owner);
        setRecord(pending);
        const first = requestedPool?.pool || pending?.pool || list[0];
        if (first && enabled) {
          if (requestedPool) {
            setReview(undefined);
            setConsent(false);
          }
          setAddress(first);
          const nextView = await readCreatorFees(connection(network), network, first);
          if (!stop) setView(nextView);
        }
      } catch (e) {
        if (!stop) setError(e instanceof Error ? e.message : String(e));
      }
    }, 0);
    return () => { stop = true; clearTimeout(timer); };
  }, [owner, network, verifiedPool, enabled, requestedPool]);

  async function act(action: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current) {
        setBusy(false);
        if (owner) {
          try { setRecord(claimRecord(developmentStorage(), network, owner)); }
          catch (e) { setError(String(e)); }
        }
      }
      lock.current = false;
    }
  }

  const row = (label: string, value: string) => (
    <div className="review-row" key={label}>
      <span>{label}</span>
      <strong style={{ overflowWrap: "anywhere" }}>{value}</strong>
    </div>
  );
  const compactAmount = (amount: bigint, decimals: number) => {
    const exact = tokenAmount(amount, decimals);
    return decimals
      ? exact.replace(/(\.\d*?[1-9])0+$/, "$1").replace(/\.0+$/, "")
      : exact;
  };
  const identityMatches = Boolean(selectedLaunch && (!view || selectedLaunch.mint === view.mint));
  const tokenName = view?.name || (identityMatches ? selectedLaunch?.name : "") || "Select a token";
  const tokenSymbol = view?.symbol || (identityMatches ? selectedLaunch?.ticker : "") || "";
  const imageUrl = identityMatches ? selectedLaunch?.imageUrl : undefined;
  const hypeQuote = view?.quoteMint === HYPE_MINT.toBase58();
  const hypeAvailable = view && hypeQuote ? compactAmount(view.quote, view.quoteDecimals) : undefined;
  const canClaim = Boolean(
    view && enabled && wallet.signTransaction && owner === view.creator &&
    view.supported && (view.base > 0n || view.quote > 0n) && record?.state !== "pending",
  );

  async function prepareClaim() {
    if (!wallet.publicKey || !view) return;
    setReview(undefined);
    setConsent(false);
    assertNoPendingClaim(developmentStorage(), network, owner!);
    const prepared = await prepareCreatorClaim(connection(network), network, view.pool, wallet.publicKey);
    if (alive.current) {
      setView(prepared.view);
      setReview(prepared);
    }
  }

  const graduated = view?.status === "migrated";
  const hasDbcFees = Boolean(view && (view.base > 0n || view.quote > 0n));
  // After graduation the creator earns on the DAMM v2 position; the DBC card stays only while leftover curve fees exist.
  const showDbcCard = !view || !graduated || hasDbcFees;
  // Distributor launches route the whole creator-controlled share through the HYMET distributor (DBC creator fee 0%).
  const distributorLaunch = Boolean(view && view.creatorShare === 0 && !hasDbcFees);
  const note = !owner
    ? "Connect Phantom from the navbar to view and claim fees."
    : !view
      ? "Loading verified fees…"
      : distributorLaunch
        ? "This launch pays creator and holder shares through the HYMET distributor. Claim your creator share under Your Launch Pools → Claim creator fees."
      : owner !== view.creator
        ? "The connected wallet is not this token’s on-chain creator."
        : !view.supported
          ? "Claims are unavailable for this token configuration."
          : record?.state === "pending"
            ? "A claim is pending. Check its saved signature in Advanced details."
            : !hasDbcFees
              ? "No bonding-curve creator fees yet."
              : view.base > 0n
                ? "Also collects accrued token fees listed in Advanced details."
                : `Verified from the DBC pool on ${networkLabel}.`;
  const confirm = () => act(async () => {
    if (!review || !wallet.publicKey || !wallet.signTransaction || !consent)
      throw Error("Explicit review and Phantom signing are required");
    await withLaunchLock(network, owner!, async () => {
      const result = await executeCreatorClaim(
        connection(network),
        review,
        wallet.publicKey!,
        async (tx) => {
          if (!alive.current) throw Error("Wallet/network changed; review again");
          return wallet.signTransaction!(tx);
        },
        developmentStorage(),
      );
      if (alive.current) {
        setRecord(result.record);
        if (result.view) setView(result.view);
        setNotice(result.refreshWarning || "");
        setReview(undefined);
        setConsent(false);
        if (result.record.state === "confirmed") onClaimConfirmed?.();
      }
    });
  });

  const advanced = (
    <>
      {pools.length > 0 && (
        <label>Saved launch pools
          <select value={pools.includes(address) ? address : ""} onChange={(e) => { setAddress(e.target.value); setView(undefined); setReview(undefined); }}>
            <option value="">Select a pool</option>
            {pools.map((pool) => <option key={pool} value={pool}>{pool}</option>)}
          </select>
        </label>
      )}
      <label>DBC pool address
        <input value={address} placeholder="Enter a DBC pool public key" onChange={(e) => { setAddress(e.target.value); setView(undefined); setReview(undefined); }} />
      </label>
      <button className="creator-claim-secondary" disabled={busy || !enabled || !address} onClick={() => act(async () => {
        setReview(undefined);
        const nextView = await readCreatorFees(connection(network), network, address);
        if (!alive.current) return;
        setView(nextView);
        if (owner && nextView.creator === owner) {
          rememberCreatorPool(developmentStorage(), network, owner, nextView.pool);
          setPools(knownCreatorPools(developmentStorage(), network, owner));
        }
      })}>Load / refresh fees</button>
      {!enabled && <p className="creator-claim-note">{networkLabel}. No claim transaction can be submitted.</p>}
      {view && <div className="creator-claim-technical">
        {row("Token mint", view.mint)}
        {row("DBC pool", view.pool)}
        {row("DBC config", view.config)}
        {row("Creator wallet", view.creator)}
        {row("Creator trading fee percentage", view.creatorShare + "% of non-protocol trading fees")}
        {row("Fee collection mode", view.collectMode === 0 ? "Quote token" : view.collectMode === 1 ? "Output token" : "Unknown")}
        {row("Pool status", view.status)}
        <MigrationStatus migration={view.migration} network={network} />
        <QuoteIdentity mint={view.quoteMint} decimals={view.quoteDecimals} />
        {row("Claimable DBC base-token fees", tokenAmount(view.base, view.baseDecimals) + " (" + view.mint + ")")}
        {row("Claimable DBC quote-token fees", tokenAmount(view.quote, view.quoteDecimals) + " (" + view.quoteMint + ")")}
        {view.status !== "active" && <p className="fine">{view.status === "migrated" ? view.migrationOption === 1 ? "DBC reports migration to DAMM V2." : "DBC reports migration to another destination." : "Migration completion is unknown."} Remaining DBC fees are separate from DAMM V2 position fees.</p>}
        {!view.supported && <p className="fine">This flow supports standard SPL tokens with SOL or verified HYPE quotes. Token-2022, transfer-hook, and other quote types need separate verified support.</p>}
      </div>}
      {review && <div className="creator-claim-technical">
        {row("Claim pool", review.view.pool)}
        {row("Destination / signer / fee payer", review.wallet)}
        {row("Maximum base tokens", tokenAmount(review.view.base, review.view.baseDecimals))}
        {row(review.view.quoteMint === HYPE_MINT.toBase58() ? "Maximum HYPE fees" : "Maximum quote fees", tokenAmount(review.view.quote, review.view.quoteDecimals))}
        {review.destinations.map((destination, i) => row(i === 0 ? "Base destination ATA" : "Creator quote destination ATA", destination))}
        {row("Reviewed priority fee", "0 SOL")}
        {row("Upfront account rent", sol(review.rent) + " SOL")}
        {row("Existing wrapped SOL returned", sol(review.existingWrappedSol) + " SOL")}
        <p className="fine">Amounts are on-chain maximums from the reviewed snapshot. The claim uses Phantom signing and simulation; later accrued fees remain unclaimed.</p>
      </div>}
      {record && <div className="creator-claim-technical">
        {row("Claim network", claimNetworkLabel(record.network))}
        {row("Transaction signature", record.signature)}
        {row("Reviewed transaction fee", record.reviewedFee ? sol(BigInt(record.reviewedFee)) + " SOL" : "Unavailable")}
        {row("Signed-message fee estimate", record.signedFee ? sol(BigInt(record.signedFee)) + " SOL" : "Unavailable")}
        {row("Actual on-chain transaction fee", record.actualFee ? sol(BigInt(record.actualFee)) + " SOL" : "Unavailable")}
        <button className="creator-claim-secondary" type="button" disabled={busy || !enabled || !owner} onClick={() => act(async () => {
          await withLaunchLock(network, owner!, async () => {
            const latest = claimRecord(developmentStorage(), network, owner!);
            if (!latest) return;
            const refreshed = await refreshClaim(connection(network), developmentStorage(), latest);
            if (alive.current) {
              setRecord(refreshed.record);
              if (refreshed.view) { setView(refreshed.view); setAddress(refreshed.view.pool); }
              setNotice(refreshed.refreshWarning || "");
              setReview(undefined);
              if (refreshed.record.state === "confirmed") onClaimConfirmed?.();
            }
          });
        })}>Check claim signature &amp; refresh</button>
      </div>}
    </>
  );

  return (
    <section className="results creator-claim" aria-label="Creator Fees">
      {showDbcCard && (
        <EarningsCard
          venue="DBC"
          name={tokenName}
          ticker={tokenSymbol}
          imageUrl={imageUrl}
          stage={graduated ? "Graduated · Remaining bonding-curve fees" : "Bonding curve · Creator fees"}
          amount={distributorLaunch ? "Paid via distributor" : hypeAvailable === undefined ? undefined : hypeAvailable + " HYPE"}
          note={note}
          action={view && !review && !distributorLaunch ? { label: hasDbcFees ? "Claim Creator Fees" : "No fees to claim", disabled: busy || !canClaim, onClick: () => act(prepareClaim) } : undefined}
          advanced={advanced}
        >
          {review && (
            <ClaimConfirmation
              amount={hypeAvailable === undefined ? compactAmount(review.view.quote, review.view.quoteDecimals) + " quote tokens" : hypeAvailable + " HYPE"}
              network={claimNetworkLabel(review.view.network)}
              recipient={review.wallet}
              fee={sol(review.fee) + " SOL"}
              consent={consent}
              onConsent={setConsent}
              busy={busy}
              canConfirm={enabled && record?.state !== "pending"}
              onConfirm={confirm}
              onCancel={() => { setReview(undefined); setConsent(false); }}
            />
          )}
          {record && (
            <div className="creator-claim-status" role="status">
              <span>Last claim: {record.state}</span>
              {testNetworkRequested() ? <span>Localnet signature saved</span> : <a target="_blank" rel="noreferrer" href={explorer(record.signature)}>View transaction ↗</a>}
            </div>
          )}
          {notice && <p className="creator-claim-note" role="status">{notice}</p>}
          {record?.signingIssue && <p role="alert" className="error">{record.signingIssue}. Check the saved signature before another review.</p>}
          {error && <p role="alert" className="error">{error}</p>}
        </EarningsCard>
      )}
      {!showDbcCard && error && <p role="alert" className="error">{error}</p>}
      {view?.migration.destination && <DammFees key={network + ":" + owner + ":" + view.pool} dbc={view} network={network} tokenName={tokenName} tokenSymbol={tokenSymbol} imageUrl={imageUrl} onConfirmed={onClaimConfirmed} dbcAdvanced={showDbcCard ? undefined : advanced} />}
    </section>
  );
}
