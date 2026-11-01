"use client";
import { useCallback, useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { mainnetTransactionsEnabled, activeNetworkLabel } from "../lib/app-network";
import { HYPE_MINT } from "../lib/quote-assets";
import { formatUnits, prepareDbcSwap, QUICK_PERCENTS, quickAmount, quoteDbcSwap, SWAP_JOURNAL, type SwapPlan, type SwapSide } from "../lib/dbc-swap";
import { prepareDammSwap, quoteDammSwap } from "../lib/damm-swap";
import { executeWalletOperation } from "../lib/wallet-operation";

type Props = { mint: string; pool?: string; poolStatus?: string; protocol?: string; dbcPool?: string; ticker: string };
const amount = (n: bigint, d: number) => {
  const s = (Number(n) / 10 ** d).toLocaleString("en-US", { maximumSignificantDigits: 8 });
  return s;
};
const sol = (n: bigint) => `${(Number(n) / 1e9).toFixed(6)} SOL`;

export function TradePanel(props: Props) {
  return <TradeForm {...props} />;
}

function TradeForm({ mint, pool, poolStatus, protocol, dbcPool, ticker }: Props) {
  const { publicKey, signTransaction } = useWallet();
  const { connection } = useConnection();
  const [side, setSide] = useState<SwapSide>("buy"), [value, setValue] = useState(""), [slippage, setSlippage] = useState("1");
  const [plan, setPlan] = useState<SwapPlan | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(""), [status, setStatus] = useState(""), [signature, setSignature] = useState("");
  type Balance = { raw: bigint; decimals: number };
  const [balances, setBalances] = useState<{ owner?: string; hype?: Balance; token?: Balance }>({});
  const [preview, setPreview] = useState<{ key: string; text: string; error?: boolean }>();
  const platform = process.env.NEXT_PUBLIC_HYMET_PLATFORM_FEE_RECIPIENT || "";
  const enabled = mainnetTransactionsEnabled();
  // After graduation the DAMM v2 pool is traded, verified against the launch's own DBC pool on every quote and review.
  const damm = protocol === "meteora_damm_v2";
  const tradable = Boolean(pool) && poolStatus === "active" && (!damm || Boolean(dbcPool));
  const blocked = !enabled ? "Mainnet transactions are disabled in this build." : !tradable ? (poolStatus === "migrated" ? "This token has graduated; its DAMM v2 pool is being verified. Refresh in a moment." : damm ? "The DAMM v2 pool cannot be verified without its launch pool." : "No active DBC pool is verified for this token.") : !platform ? "Platform fee wallet is not configured." : "";

  const [balanceTick, setBalanceTick] = useState(0);
  const refreshBalances = useCallback(() => setBalanceTick((n) => n + 1), []);
  useEffect(() => {
    let alive = true;
    const owner = publicKey;
    // Raw integer units + decimals: quick amounts are computed exactly, never from rounded display strings.
    // A missing token account means a zero balance; a failed read leaves the balance unknown.
    const read = async (m: PublicKey, fallbackDecimals: number): Promise<Balance | undefined> => {
      if (!owner) return undefined;
      const address = getAssociatedTokenAddressSync(m, owner);
      const info = await connection.getAccountInfo(address).catch(() => undefined);
      if (info === undefined) return undefined;
      if (info === null) return { raw: 0n, decimals: fallbackDecimals };
      const v = (await connection.getTokenAccountBalance(address).catch(() => null))?.value;
      return v ? { raw: BigInt(v.amount), decimals: v.decimals } : undefined;
    };
    void Promise.all([read(HYPE_MINT, 9), read(new PublicKey(mint), 9)]).then(([hype, token]) => { if (alive) setBalances({ owner: owner?.toBase58(), hype, token }); });
    return () => { alive = false; };
  }, [publicKey, connection, mint, balanceTick]);

  const reset = () => { setPlan(null); setSignature(""); };
  const owner = publicKey?.toBase58();
  const source = balances.owner === owner ? (side === "buy" ? balances.hype : balances.token) : undefined;
  const pickQuick = (percent: (typeof QUICK_PERCENTS)[number]) => {
    if (!source) return;
    setValue(quickAmount(source.raw, source.decimals, percent));
    reset();
    setError("");
  };
  // Debounced, read-only quote preview; a newer amount/side/slippage always supersedes an older response.
  const previewKey = `${side}:${value.trim()}:${slippage}`;
  useEffect(() => {
    if (blocked || !pool || !value.trim() || !(Number(value) > 0)) return;
    let alive = true;
    const timer = window.setTimeout(() => {
      const q = { mint, pool, side, amount: value.trim(), slippageBps: Math.round(Number(slippage) * 100), platform: new PublicKey(platform) };
      (damm ? quoteDammSwap(connection, { ...q, dbcPool: dbcPool! }) : quoteDbcSwap(connection, q))
        .then((q) => { if (alive) setPreview({ key: previewKey, text: `≈ ${formatUnits(q.expectedOut, q.outDecimals)} ${side === "buy" ? ticker.toUpperCase() : "HYPE"} · minimum ${formatUnits(q.minimumOut, q.outDecimals)}` }); })
        .catch((e) => { if (alive) setPreview({ key: previewKey, text: e instanceof Error ? e.message : "Quote unavailable", error: true }); });
    }, 600);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [previewKey, blocked, pool, value, side, slippage, connection, mint, platform, ticker, damm, dbcPool]);
  const livePreview = preview?.key === previewKey && value.trim() ? preview : undefined;
  const review = async () => {
    if (!publicKey || !pool) return;
    setBusy(true); setError(""); setStatus("Verifying the pool on-chain and simulating the swap…"); reset();
    try {
      const bps = Math.round(Number(slippage) * 100);
      const params = { mint, pool, wallet: publicKey, side, amount: value.trim(), slippageBps: bps, platform: new PublicKey(platform) };
      const p = damm ? await prepareDammSwap(connection, { ...params, dbcPool: dbcPool! }) : await prepareDbcSwap(connection, params);
      setPlan(p);
      setStatus("Review the quote, then confirm to sign in Phantom.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Swap preparation failed"); setStatus("");
    } finally { setBusy(false); }
  };
  const execute = async () => {
    if (!plan || !publicKey || !signTransaction) return;
    setBusy(true); setError(""); setStatus("Approve the transaction in Phantom…");
    try {
      const sig = await executeWalletOperation(connection, plan.tx, publicKey, signTransaction, window.localStorage, plan.lastValidBlockHeight, undefined, SWAP_JOURNAL);
      setSignature(sig); setPlan(null); setStatus(`Swap confirmed on ${activeNetworkLabel("Mainnet")}.`); void refreshBalances();
    } catch (e) {
      const message = e instanceof Error ? e.message : "Swap failed";
      const sig = message.match(/[1-9A-HJ-NP-Za-km-z]{80,90}/)?.[0];
      if (sig) setSignature(sig);
      setError(message); setStatus(""); setPlan(null);
    } finally { setBusy(false); }
  };
  const inLabel = side === "buy" ? "HYPE" : ticker.toUpperCase(), outLabel = side === "buy" ? ticker.toUpperCase() : "HYPE";
  return (
    <>
      <div className="trade-actions" role="group" aria-label="Trade side">
        <button type="button" aria-pressed={side === "buy"} className={side === "buy" ? "primary" : ""} disabled={busy} onClick={() => { if (side !== "buy") setValue(""); setSide("buy"); reset(); }}>Buy</button>
        <button type="button" aria-pressed={side === "sell"} className={side === "sell" ? "primary" : ""} disabled={busy} onClick={() => { if (side !== "sell") setValue(""); setSide("sell"); reset(); }}>Sell</button>
      </div>
      {!blocked && <small>Venue: {damm ? "Meteora DAMM v2 (graduated)" : "Meteora DBC bonding curve"}</small>}
      <label>Amount · {inLabel}<input type="number" min="0" step="any" placeholder="0.00" value={value} disabled={busy || !!blocked} onChange={(e) => { setValue(e.target.value); reset(); }} /></label>
      <div className="quick-amounts" role="group" aria-label={`Quick ${side} amount`}>
        {QUICK_PERCENTS.map((p) => (
          <button key={p} type="button" disabled={busy || !!blocked || !source || source.raw === 0n} onClick={() => pickQuick(p)} title={source ? `${p === 100 ? "All" : `${p}% of`} ${formatUnits(source.raw, source.decimals)} ${inLabel}` : "Connect a wallet with a balance"}>
            {p === 100 ? "MAX" : `${p}%`}
          </button>
        ))}
      </div>
      {publicKey && source?.raw === 0n && <small>No {inLabel} balance to {side}.</small>}
      {livePreview && <small role="status" className={livePreview.error ? "error" : ""}>{livePreview.text}</small>}
      <label>Max slippage · %<input type="number" min="0.01" max="50" step="0.1" value={slippage} disabled={busy || !!blocked} onChange={(e) => { setSlippage(e.target.value); reset(); }} /></label>
      {publicKey && <small>Balance: {balances.owner === owner && balances.hype ? formatUnits(balances.hype.raw, balances.hype.decimals) : "…"} HYPE · {balances.owner === owner && balances.token ? formatUnits(balances.token.raw, balances.token.decimals) : "…"} {ticker.toUpperCase()}</small>}
      {blocked ? <small>{blocked}</small> : !publicKey ? (
        <small>Connect Phantom from the navigation to buy or sell.</small>
      ) : !plan ? (
        <button type="button" className="primary" disabled={busy || !value || Number(value) <= 0} onClick={() => void review()}>{busy ? "Preparing…" : `Review ${side}`}</button>
      ) : (
        <div className="trade-review" role="region" aria-label="Swap review">
          <small>You pay <b>{amount(plan.amountIn, plan.inDecimals)} {inLabel}</b></small>
          {plan.requestedIn !== undefined && <small>This buy completes the bonding curve; the unused {amount(plan.requestedIn - plan.amountIn, plan.inDecimals)} {inLabel} stays in your wallet.</small>}
          <small>Expected <b>{amount(plan.expectedOut, plan.outDecimals)} {outLabel}</b> · minimum <b>{amount(plan.minimumOut, plan.outDecimals)} {outLabel}</b> ({plan.slippageBps / 100}% slippage)</small>
          <small>Trading fee {amount(plan.tradingFee + plan.protocolFee, 9)} HYPE, including {amount(plan.protocolFee, 9)} HYPE in Meteora protocol fees</small>
          <small>Network fee {sol(plan.networkFee)}{plan.rent > 0n ? ` · new token account rent ${sol(plan.rent)}` : ""}</small>
          <small>Simulation passed. Phantom will show the exact transaction.</small>
          <div className="trade-actions">
            <button type="button" className="primary" disabled={busy || !signTransaction} onClick={() => void execute()}>{busy ? "Waiting for Phantom…" : "Confirm & sign in Phantom"}</button>
            <button type="button" disabled={busy} onClick={reset}>Cancel</button>
          </div>
        </div>
      )}
      {status && <small role="status">{status}</small>}
      {error && <small role="alert" className="error">{error}</small>}
      {signature && <a href={`https://solscan.io/tx/${encodeURIComponent(signature)}`} target="_blank" rel="noreferrer">View transaction ↗</a>}
    </>
  );
}
