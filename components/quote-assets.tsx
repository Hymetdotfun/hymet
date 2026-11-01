"use client";
import {
  HYPE_MINT,
  HYPE_SOURCE,
  hypeBalance,
  verifyHypeMint,
} from "../lib/quote-assets";
import { useEffect, useState } from "react";
import { XstockLogo } from "./xstock-logo";
import { XstockPicker } from "./xstock-picker";
import { PublicKey } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  unpackAccount,
} from "@solana/spl-token";
import { connection, checkNetwork } from "../lib/transactions";
import { tokenAmount } from "../lib/creator-fees";
import { limitedBody } from "../lib/http";
import { type QuoteCategory, type XstocksRegistry } from "../lib/xstocks";

export function QuoteAssets({
  category,
  onChange,
  disabled,
  wallet,
}: {
  category: QuoteCategory;
  onChange: (category: QuoteCategory) => void;
  disabled: boolean;
  wallet?: string;
}) {
  const [registry, setRegistry] = useState<XstocksRegistry>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [search, setSearch] = useState(""),
    [filter, setFilter] = useState("all"),
    [mint, setMint] = useState("");
  const [balance, setBalance] = useState<{ key: string; value: string }>();
  const [hype, setHype] = useState<{
    wallet?: string;
    amount?: string;
    error?: string;
  }>();
  useEffect(() => {
    if (category !== "hype") return;
    let stop = false;
    const c = connection("mainnet-beta");
    checkNetwork(c, "mainnet-beta")
      .then(() => verifyHypeMint(c))
      .then(() => (wallet ? hypeBalance(c, new PublicKey(wallet)) : undefined))
      .then((a) => {
        if (!stop)
          setHype({
            wallet,
            amount: a === undefined ? undefined : tokenAmount(a, 9),
          });
      })
      .catch((e) => {
        if (!stop)
          setHype({
            wallet,
            error:
              e instanceof Error ? e.message : "HYPE verification unavailable",
          });
      });
    return () => {
      stop = true;
    };
  }, [category, wallet]);
  const selected = registry?.assets.find((a) => a.mint === mint);
  async function refresh() {
    setBusy(true);
    setError("");
    setRegistry(undefined);
    setBalance(undefined);
    try {
      const r = await fetch("/api/xstocks", {
        cache: "no-store",
        signal: AbortSignal.timeout(90_000),
      });
      if (!r.ok)
        throw Error(
          "Official registry or on-chain verification unavailable. No stale list is used.",
        );
      setRegistry(
        JSON.parse(
          new TextDecoder().decode(await limitedBody(r, 2 * 1024 * 1024)),
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Verification unavailable");
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    let stop = false;
    if (
      !selected ||
      !wallet ||
      selected.decimals === undefined ||
      !selected.program
    )
      return;
    const c = connection("mainnet-beta"),
      owner = new PublicKey(wallet),
      program = new PublicKey(selected.program);
    const key = `${wallet}:${selected.mint}`;
    const ata = getAssociatedTokenAddressSync(
      new PublicKey(selected.mint),
      owner,
      false,
      program,
    );
    checkNetwork(c, "mainnet-beta")
      .then(() => c.getAccountInfo(ata, "confirmed"))
      .then((info) => {
        if (stop) return;
        if (!info) {
          setBalance({ key, value: "0" });
          return;
        }
        const account = unpackAccount(ata, info, program);
        if (
          !account.owner.equals(owner) ||
          account.mint.toBase58() !== selected.mint
        )
          throw Error("Balance account mismatch");
        setBalance({
          key,
          value: tokenAmount(account.amount, selected.decimals!),
        });
      })
      .catch(() => {
        if (!stop) setBalance({ key, value: "Unavailable" });
      });
    return () => {
      stop = true;
    };
  }, [selected, wallet]);
  const rows =
    registry?.assets.filter(
      (a) =>
        `${a.name} ${a.symbol} ${a.mint}`
          .toLowerCase()
          .includes(search.toLowerCase()) &&
        (filter === "all" || a.status === filter),
    ) || [];
  return (
    <section aria-label="Quote asset">
      <div className="section-title">
        <div>
          <h2>Quote asset</h2>
          <p>SOL launches remain available. xStocks assets can be inspected here.</p>
        </div>
      </div>
      <label className="field">
        <span>Quote asset category</span>
        <select
          value={category}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value as QuoteCategory)}
        >
          <option value="sol">SOL — existing default</option>
          <option value="hype">HYPE — Wormhole bridged Hyperliquid</option>
          <option value="xstocks">xStocks — official Solana registry</option>
        </select>
      </label>
      {category === "hype" && (
        <div className="fine">
          <p>
            HYPE mint: {HYPE_MINT.toBase58()} · standard SPL · 9 decimals.
            Market caps, initial buys and quote fees below are denominated in
            HYPE; SOL is still required for network fees and rent. No
            SOL-to-HYPE conversion is performed.
          </p>
          <a href={HYPE_SOURCE} target="_blank" rel="noreferrer">
            Official Pump pair-asset registry ↗
          </a>
          <p>
            {hype?.error ||
              (hype?.wallet === wallet
                ? `HYPE balance: ${hype?.amount ?? "connect wallet to read"}`
                : "Verifying HYPE mint…")}
          </p>
          <p>
            HYPE launches use the standard review, simulation, and Phantom
            signing flow.
          </p>
        </div>
      )}
      {category === "xstocks" && (
        <>
          <p className="fine">
            xStocks launches are unavailable until their quote, migration, and
            fee-claim path is verified. Values shown for SOL remain SOL prices
            and costs, not xStocks equivalents. SOL is still required for
            network fees and account rent. Switching categories never prepares
            or signs a transaction.
          </p>
          <button type="button" onClick={refresh} disabled={busy}>
            {busy ? "Verifying official registry…" : "Refresh official xStocks"}
          </button>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          {registry && (
            <>
              <p className="fine">
                {registry.assets.length} official Solana mints ·{" "}
                {registry.assets.filter((a) => a.decimals !== undefined).length}{" "}
                decoded on Mainnet · 0 enabled for launch. Snapshot{" "}
                {new Date(registry.verifiedAt).toLocaleString()}.
              </p>
              <div className="grid">
                <label className="field">
                  <span>Search xStocks</span>
                  <input
                    value={search}
                    placeholder="Name, ticker or exact mint"
                    onChange={(e) => {
                      setSearch(e.target.value);
                      setMint("");
                      setBalance(undefined);
                    }}
                  />
                </label>
                <label className="field">
                  <span>Compatibility filter</span>
                  <select
                    value={filter}
                    onChange={(e) => {
                      setFilter(e.target.value);
                      setMint("");
                      setBalance(undefined);
                    }}
                  >
                    {[
                      "all",
                      "Available for Launch",
                      "Unsupported by DBC",
                      "Unsupported by Migration",
                      "Verification Unavailable",
                    ].map((s) => (
                      <option key={s} value={s}>
                        {s === "all" ? "All statuses" : s}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <XstockPicker
                key={`${search}:${filter}`}
                rows={rows}
                selected={selected}
                searching={!!search}
                onSelect={(value) => {
                  setMint(value);
                  setBalance(undefined);
                }}
              />
              {selected && (
                <div className="quote-details">
                  <h3 className="xstock-heading">
                    <XstockLogo asset={selected} />
                    {selected.name} ({selected.symbol})
                  </h3>
                  <p className="fine">
                    Official mint:{" "}
                    <a
                      href={`https://solscan.io/account/${selected.mint}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {selected.mint}
                    </a>
                  </p>
                  <p className="fine">
                    {selected.status} · decimals{" "}
                    {selected.decimals ?? "unavailable"} · token program{" "}
                    {selected.program ?? "unavailable"}
                  </p>
                  <p className="fine">
                    Extensions:{" "}
                    {selected.extensions?.join(", ") || "None verified"}. DBC
                    token badge:{" "}
                    {selected.badge === undefined
                      ? "unavailable"
                      : selected.badge
                        ? "verified"
                        : "not verified"}
                    .
                  </p>
                  <p className="fine">
                    Wallet raw balance (before any issuer UI multiplier):{" "}
                    {!wallet
                      ? "Connect Phantom from the navigation"
                      : balance?.key === `${wallet}:${selected.mint}`
                        ? balance.value
                        : "Loading / unavailable"}
                    . Standard associated account only; other token accounts are
                    not totaled.
                  </p>
                  {selected.restrictions?.map((r) => (
                    <p className="fine" key={r}>
                      {r}
                    </p>
                  ))}
                  {selected.reasons.map((r) => (
                    <p className="fine" key={r}>
                      {r}
                    </p>
                  ))}
                </div>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
