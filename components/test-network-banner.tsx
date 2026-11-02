"use client";

import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { testNetworkProblem, testNetworkRequested } from "../lib/app-network";

// Shown only when the guarded local test network is requested (NEXT_PUBLIC_HYMET_TEST_NETWORK). Production
// builds never set it, so this renders nothing there. Inline styles keep it independent of the site CSS.
export function TestNetworkBanner() {
  const { publicKey } = useWallet();
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  if (!testNetworkRequested()) return null;
  const problem = testNetworkProblem();
  const devnet = process.env.NEXT_PUBLIC_HYMET_TEST_NETWORK === "devnet";
  const fund = async () => {
    if (!publicKey) return;
    setBusy(true);
    setStatus("Funding…");
    try {
      const r = await fetch("/api/test-network/fund", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wallet: publicKey.toBase58() }) });
      const j = await r.json();
      setStatus(r.ok ? (j.sol ? `Sent ${j.sol} test SOL and ${j.hype} test HYPE` : `Sent ${j.hype} Devnet test HYPE`) : j.error || "Funding failed");
    } catch {
      setStatus("Funding failed");
    } finally {
      setBusy(false);
    }
  };
  const style = { position: "sticky" as const, top: 0, zIndex: 1000, display: "flex", flexWrap: "wrap" as const, gap: "8px 16px", alignItems: "center", justifyContent: "center", padding: "8px 16px", font: "600 13px/1.4 system-ui, sans-serif", color: "#1a1200", background: problem ? "#ff6b6b" : "#ffcc33", borderBottom: "2px solid #1a1200" };
  if (problem)
    return <div role="alert" style={style}>TEST NETWORK MISCONFIGURED: {problem}. All transactions are disabled.</div>;
  return (
    <div role="status" style={style}>
      <span>{devnet ? "TEST NETWORK · Solana Devnet · Test HYPE, no real funds · Phantom: Testnet Mode → Solana Devnet" : "TEST NETWORK · Local validator (Mainnet fork) · No real funds · Phantom: Testnet Mode → Solana Localnet"}</span>
      {publicKey && (
        <button type="button" onClick={() => void fund()} disabled={busy} style={{ font: "inherit", padding: "2px 10px", border: "2px solid #1a1200", background: "#fff", cursor: "pointer" }}>
          {devnet ? "Fund this wallet with Devnet test HYPE" : "Fund this wallet with test SOL + HYPE"}
        </button>
      )}
      {status && <span>{status}</span>}
    </div>
  );
}
