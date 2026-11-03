"use client";

import { useCallback, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Transaction } from "@solana/web3.js";
import { Buffer } from "buffer";
import production from "../config/production.json";
import { ownerProofMessage } from "../lib/owner-proof.mjs";
import { executeWalletOperation } from "../lib/wallet-operation";
import { mainnetTransactionsEnabled } from "../lib/app-network";
import type { OwnerStatus } from "../lib/distributor-owner";

type Prepared = {
  transaction?: string;
  lastValidBlockHeight?: number;
  summary?: { config: string; platformWallet: string; snapshotAuthority: string; rentLamports: number; feeLamports: number };
  rotation?: { current: string; next: string; feeLamports: number };
  error?: string;
};

async function ownerApi<T>(body: Record<string, string>): Promise<T> {
  const response = await fetch("/api/owner", { method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store", body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw Error(data.error || "Owner API request failed");
  return data as T;
}

/** Phantom-only owner steps: sign the ownership proof (a message, no funds), sign the one-time initialize, and rotate the
 *  keeper key if it is lost or compromised. */
export function OwnerConsole() {
  const { publicKey, signMessage, signTransaction } = useWallet();
  const { connection } = useConnection();
  const [status, setStatus] = useState<OwnerStatus | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [signature, setSignature] = useState("");
  const [busy, setBusy] = useState(false);
  const [newKeeper, setNewKeeper] = useState("");
  const owner = production.upgradeAuthority;
  const isOwner = publicKey?.toBase58() === owner;

  const run = useCallback(async (task: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try { await task(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Owner step failed"); } finally { setBusy(false); }
  }, []);

  const refresh = () => run(async () => setStatus(await ownerApi<OwnerStatus>({ action: "status" })));

  const signProof = () => run(async () => {
    if (!publicKey || !signMessage) throw Error("Phantom message signing is required");
    const proof = { owner: publicKey.toBase58(), program: production.distributorProgramId, issuedAt: new Date().toISOString(), nonce: crypto.randomUUID() };
    const signed = await signMessage(new TextEncoder().encode(ownerProofMessage(proof)));
    const file = new Blob([JSON.stringify({ ...proof, signature: Buffer.from(signed).toString("base64") }, null, 2)], { type: "application/json" });
    const link = Object.assign(document.createElement("a"), { href: URL.createObjectURL(file), download: "owner-proof.json" });
    link.click();
    URL.revokeObjectURL(link.href);
    setNotice("owner-proof.json saved. It contains only the public address and a signature; pass it to the handover script within 24 hours.");
  });

  const initialize = () => run(async () => {
    if (!publicKey || !signTransaction) throw Error("Phantom transaction signing is required");
    const plan = await ownerApi<Prepared>({ action: "prepare-initialize", wallet: publicKey.toBase58() });
    if (!plan.transaction || plan.lastValidBlockHeight === undefined || !plan.summary) throw Error("Incomplete initialize review");
    const tx = Transaction.from(Buffer.from(plan.transaction, "base64"));
    if (!tx.feePayer?.equals(publicKey)) throw Error("Prepared transaction fee payer is not the owner");
    setNotice(`Initialize config ${plan.summary.config}: platform ${plan.summary.platformWallet}, keeper ${plan.summary.snapshotAuthority}, rent ${plan.summary.rentLamports} lamports. Review and approve in Phantom.`);
    setSignature(await executeWalletOperation(connection, tx, publicKey, signTransaction, window.localStorage, plan.lastValidBlockHeight, undefined, "owner-operation"));
    const after = await ownerApi<OwnerStatus>({ action: "status" });
    setStatus(after);
    if (after.config?.admin !== owner || after.config.platformWallet !== production.platformFeeWallet || after.config.snapshotAuthority !== production.snapshotAuthority)
      throw Error("Confirmed, but the on-chain config does not match config/production.json; stop and review");
    setNotice("Initialized and verified against config/production.json.");
  });

  // Keeper key rotation (lost or compromised keeper): the owner signs set_snapshot_authority in Phantom.
  const rotate = () => run(async () => {
    if (!publicKey || !signTransaction) throw Error("Phantom transaction signing is required");
    const next = newKeeper.trim();
    const plan = await ownerApi<Prepared>({ action: "prepare-rotate", wallet: publicKey.toBase58(), newAuthority: next });
    if (!plan.transaction || plan.lastValidBlockHeight === undefined || !plan.rotation || plan.rotation.next !== next) throw Error("Incomplete rotation review");
    const tx = Transaction.from(Buffer.from(plan.transaction, "base64"));
    if (!tx.feePayer?.equals(publicKey)) throw Error("Prepared transaction fee payer is not the owner");
    setNotice(`Rotate the keeper key ${plan.rotation.current} → ${plan.rotation.next}. Review and approve in Phantom.`);
    setSignature(await executeWalletOperation(connection, tx, publicKey, signTransaction, window.localStorage, plan.lastValidBlockHeight, undefined, "owner-operation"));
    const after = await ownerApi<OwnerStatus>({ action: "status" });
    setStatus(after);
    if (after.config?.snapshotAuthority !== next) throw Error("Confirmed, but the on-chain keeper key did not change; stop and review");
    setNotice(`Keeper key is now ${next}. Update config/production.json snapshotAuthority and HYMET_SNAPSHOT_AUTHORITY and install the new key; the app and keeper stay stopped until then.`);
  });

  return (
    <section className="platform-claims panel-card" aria-labelledby="owner-title">
      <div className="platform-claims-heading">
        <div>
          <span className="eyebrow">HYMET OWNER · UPGRADE AUTHORITY</span>
          <h2 id="owner-title">Distributor owner steps</h2>
          <p className="platform-wallet-address">{owner}</p>
        </div>
      </div>
      <p className="platform-claims-copy">Program {production.distributorProgramId}. Deployment itself runs from the CLI with the deploy key; this page covers only the owner&apos;s Phantom signatures. Nothing is signed until you approve it in Phantom.</p>
      {!publicKey && <p className="platform-claims-status">Connect the owner wallet in Phantom.</p>}
      {publicKey && !isOwner && <p className="platform-claims-error" role="alert">Connected wallet {publicKey.toBase58()} is not the HYMET owner.</p>}
      <div className="platform-claims-actions">
        <button className="button-primary" type="button" onClick={() => void refresh()} disabled={busy}>Check status</button>
        {isOwner && <button className="platform-claim-button" type="button" onClick={() => void signProof()} disabled={busy || !signMessage}>1 · Sign owner proof</button>}
        {isOwner && <button className="platform-claim-button" type="button" onClick={() => void initialize()} disabled={busy || !signTransaction || !mainnetTransactionsEnabled() || status?.upgradeAuthority !== owner || status.initialized}>2 · Initialize in Phantom</button>}
        {!mainnetTransactionsEnabled() && <span className="platform-claims-gate">Mainnet transactions are disabled in this build; initialize stays off.</span>}
      </div>
      {isOwner && status?.initialized && (
        <div className="platform-claims-actions">
          <input className="owner-rotate-input" type="text" aria-label="New keeper key address" placeholder="New keeper key address" value={newKeeper} onChange={(e) => setNewKeeper(e.target.value)} spellCheck={false} autoComplete="off" />
          <button className="platform-claim-button" type="button" onClick={() => void rotate()} disabled={busy || !signTransaction || !mainnetTransactionsEnabled() || status.upgradeAuthority !== owner || !newKeeper.trim()}>Rotate keeper key in Phantom</button>
        </div>
      )}
      {status && (
        <p className="platform-claims-source">
          Deployed: {status.deployed ? "yes" : "no"} · Upgrade authority: {status.upgradeAuthority ?? "—"} · Reviewed bytes: {status.deployed ? (status.reviewedBytes ?? "match") : "—"} · Initialized: {status.initialized ? "yes" : "no"}. Next: {status.next}
        </p>
      )}
      {notice && <p className="platform-claims-status" role="status">{notice}</p>}
      {error && <p className="platform-claims-error" role="alert">{error}</p>}
      {signature && <p className="platform-claims-signature">Transaction: <a href={`https://solscan.io/tx/${signature}`} target="_blank" rel="noreferrer">View on Solscan ↗</a></p>}
    </section>
  );
}
