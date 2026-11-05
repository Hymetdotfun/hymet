"use client";
import { developmentStorage } from "../lib/development-storage";
import { quoteAsset } from "../lib/quote-assets";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { APP_NETWORK, mainnetTransactionsEnabled, activeNetworkLabel } from "../lib/app-network";
import Image from "next/image";
import { useState, useRef, useEffect, type CSSProperties } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { Buffer } from "buffer";
import MainnetConfirmation from "./mainnet-confirmation";
import TokenManagement from "./token-management";
import {
  ApplicationTabs,
  ApplicationPanel,
  type AppTab,
} from "./application-tabs";
import {
  uploadAuthorizedMetadata,
  metadataPreparationError,
} from "../lib/metadata-preparation";
import { inspectLaunchCosts } from "../lib/launch-costs";
import { processArtwork } from "../lib/artwork-browser";
import {
  loadRecovery,
  storeRecovery,
  recoveryRecord,
  assertRecoveryAllows,
  withLaunchLock,
  checkRecovery,
  type RecoveryRecord,
  type RecoveryResult,
} from "../lib/recovery";
import { defaults, validate, friendly, type Inputs } from "../lib/config";
import { assertPersistedAllocation, creatorShareAllowed, holderSplitsAvailable, launchConfirmationPayload, parseLaunchAllocationPolicy, type LaunchAllocationPolicy } from "../lib/launch-allocation-ui";
import { launchAuthorizationMessage } from "../lib/launch-authorization";
import { confirmedLaunchDestination } from "../lib/confirmed-launch-route";
// Holder allocations need the verified distributor and payout keeper; both flags are inlined at build time.
const HOLDER_REWARDS_PROGRAM =
  process.env.NEXT_PUBLIC_HYMET_HOLDER_REWARDS === "true" ? process.env.NEXT_PUBLIC_HYMET_DISTRIBUTOR_PROGRAM_ID || "" : "";
const HOLDER_ALLOCATION_UNAVAILABLE = "This creator/holder split requires the HYMET on-chain reward distributor. Until that program is deployed and verified, only the 100% creator / 0% holder allocation can be constructed.";
import {
  connection,
  buildPlan,
  execute,
  verifyLaunch,
  inspectSignature,
  sol,
  remainingRequirement,
  type Plan,
} from "../lib/transactions";
async function registerConfirmedLaunch(p: Plan) {
  const response = await fetch("/api/launch/confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(launchConfirmationPayload(p)),
  });
  const body = await response.json();
  if (!response.ok)
    throw Error(body.error || "Confirmed launch registration failed");
  if (body.registered !== true)
    throw Error("HYMET registry did not confirm this launch");
  assertPersistedAllocation(p.allocation, body.allocation);
}
export default function Terminal() {
  return <Launcher />;
}
function Launcher() {
  const router = useRouter();
  const wallet = useWallet();
  const [activeTab, setActiveTab] = useState<AppTab>("launch");
  const network = APP_NETWORK;
  const [v, setV] = useState<Inputs>(defaults),
    [image, setImage] = useState<File>(),
    [imageIssue, setImageIssue] = useState(""),
    [imageProcessing, setImageProcessing] = useState(false),
    [preview, setPreview] = useState(""),
    [plan, setPlan] = useState<Plan>(),
    [state, setState] = useState("Idle"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [result, setResult] = useState<{ status: string; supply: string }>(),
    [balance, setBalance] = useState<bigint>(),
    [holderPayoutsReady, setHolderPayoutsReady] = useState(false),
    [mainnetPayoutVerified, setMainnetPayoutVerified] = useState(false),
    [allocationPolicyState, setAllocationPolicyState] = useState<{ status: "loading" | "ready" | "error"; policy?: LaunchAllocationPolicy; error?: string }>({ status: "loading" }),
    [mainnetReview, setMainnetReview] = useState<boolean>(),
    [pending, setPending] = useState<RecoveryRecord>(),
    [recoveryResult, setRecoveryResult] = useState<RecoveryResult>(),
    [saved, setSaved] = useState<string[]>([]);
  const lock = useRef(false);
  const redirectedMint = useRef<string | undefined>(undefined);
  const allocationTouched = useRef(false);
  const imageProcessId = useRef(0);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/launch/allocation", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const body: unknown = await response.json();
        if (!response.ok) throw new Error("Launch allocation settings could not be loaded");
        return parseLaunchAllocationPolicy(body);
      })
      .then((policy) => {
        if (controller.signal.aborted) return;
        setAllocationPolicyState({ status: "ready", policy });
        setV((current) => allocationTouched.current ? current : { ...current, creatorShare: String(policy.default) });
      })
      .catch(() => {
        if (!controller.signal.aborted) setAllocationPolicyState({ status: "error", error: "Launch allocation settings could not be verified. Refresh the page to try again." });
      });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    // A busy RPC can fail one check, so a failed check is retried before the slider stays locked.
    const check = (attempt: number): Promise<boolean> => fetch("/api/fees", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) return false;
        const readiness = (await response.json()) as {
          chainVerified?: boolean;
          launchMode?: string;
          distributorProgramId?: string | null;
          holderRewards?: { enabled?: boolean; automatic?: boolean; mainnetPayoutVerified?: boolean };
        };
        if (!controller.signal.aborted) setMainnetPayoutVerified(readiness.holderRewards?.mainnetPayoutVerified === true);
        return (
          readiness.chainVerified === true &&
          readiness.launchMode === "distributor" &&
          readiness.distributorProgramId === HOLDER_REWARDS_PROGRAM &&
          readiness.holderRewards?.enabled === true &&
          readiness.holderRewards?.automatic === true
        );
      })
      .catch(() => false)
      .then(async (ready) => {
        if (ready || attempt >= 3 || controller.signal.aborted) return ready;
        await new Promise((resolve) => setTimeout(resolve, 4_000));
        return check(attempt + 1);
      });
    check(1)
      .then((ready) => {
        if (!controller.signal.aborted) setHolderPayoutsReady(ready);
      })
      .catch(() => {
        if (!controller.signal.aborted) setHolderPayoutsReady(false);
      });
    return () => controller.abort();
  }, []);
  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview);
    },
    [preview],
  );
  useEffect(() => {
    if (!wallet.publicKey) return;
    let stop = false;
    connection(network)
      .getBalance(wallet.publicKey)
      .then((n) => {
        if (!stop) setBalance(BigInt(n));
      })
      .catch(() => {
        if (!stop) setBalance(undefined);
      });
    return () => {
      stop = true;
    };
  }, [wallet.publicKey, network]);
  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        setSaved(
          JSON.parse(
            developmentStorage().getItem(`dbc-configs-${network}`) || "[]",
          ),
        );
      } catch {
        setSaved([]);
      }
    }, 0);
    return () => clearTimeout(timer);
  }, [network]);
  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        setPending(
          wallet.publicKey
            ? loadRecovery(
                developmentStorage(),
                network,
                wallet.publicKey.toBase58(),
              )
            : undefined,
        );
        setRecoveryResult(undefined);
      } catch (e) {
        setError(friendly(e));
      }
    }, 0);
    return () => clearTimeout(timer);
  }, [network, wallet.publicKey]);
  async function prepare() {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    let metadataComplete = false, metadataStarted = false;
    let preparationStage = "validation";
    try {
      if (allocationPolicyState.status !== "ready" || !allocationPolicyState.policy)
        throw Error(allocationPolicyState.error || "Launch allocation settings could not be verified. Refresh the page to try again.");
      if (v.quote !== "hype") throw Error("HYMET supports HYPE only");
      if (!wallet.publicKey || !wallet.signMessage)
        throw Error("Connect Phantom with message signing support");
      assertRecoveryAllows(
        developmentStorage(),
        network,
        wallet.publicKey.toBase58(),
      );
      setState("Validating configuration");
      validate(v);
      const creatorShare = Number(v.creatorShare);
      if (!creatorShareAllowed(v.creatorShare, allocationPolicyState.policy))
        throw Error(HOLDER_ALLOCATION_UNAVAILABLE);
      if (!mainnetTransactionsEnabled()) throw Error("Launches are not open yet");
      if (creatorShare !== 100 && !holderSplitsAvailable(HOLDER_REWARDS_PROGRAM, holderPayoutsReady, allocationPolicyState.policy))
        throw Error(HOLDER_ALLOCATION_UNAVAILABLE);
      if (!image) throw Error(imageIssue || "Choose a token logo");
      if (
        image.size > 1024 * 1024 ||
        !["image/png", "image/jpeg", "image/gif"].includes(image.type)
      )
        throw Error("Choose PNG, JPEG or GIF up to 1 MB");
      preparationStage = "Phantom launch approval";
      setState("Waiting for launch approval in Phantom");
      const issuedAt = new Date().toISOString();
      const nonce = crypto.randomUUID();
      const authorization = launchAuthorizationMessage({ origin: location.origin, wallet: wallet.publicKey.toBase58(), name: v.name, ticker: v.symbol, nonce, issuedAt });
      const authorizationSignature = Buffer.from(await wallet.signMessage(new TextEncoder().encode(authorization))).toString("base64");
      preparationStage = "HYMET launch record";
      setState("Recording launch request");
      const reservationResponse = await fetch("/api/launch/reserve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: v.name, ticker: v.symbol, wallet: wallet.publicKey.toBase58(), issuedAt, nonce, signature: authorizationSignature }) });
      const reservationBody = await reservationResponse.json();
      if (!reservationResponse.ok) throw Error(reservationBody.error || "HYMET launch request failed");
      setState("Uploading metadata");
      const form = new FormData();
      form.set("image", image);
      form.set("details", JSON.stringify(v));
      form.set("wallet", wallet.publicKey.toBase58());
      form.set("issuedAt", issuedAt);
      form.set("nonce", nonce);
      form.set("signature", authorizationSignature);
      preparationStage =
        "metadata service upload / public gateway verification";
      metadataStarted = true;
      const data = await uploadAuthorizedMetadata(form);
      metadataComplete = true;
      preparationStage = "transaction construction / RPC estimates";
      setState("Building transactions");
      const p = await buildPlan(
        connection(network),
        v,
        wallet.publicKey,
        network,
        data.uri,
        v.creatorShare !== "100" ? HOLDER_REWARDS_PROGRAM || undefined : undefined,
      );
      p.reservationId = reservationBody.reservationId;
      p.artworkUri = data.imageUrl;
      setPlan(p);
      try {
        p.costPreview = await inspectLaunchCosts(connection(network), p);
      } catch {
        p.costPreview = {
          simulations: [{ label: "Cost preview", status: "unavailable" }],
        };
      }
      setBalance(p.balance);
      setState("Ready for review");
      if (mainnetTransactionsEnabled()) setMainnetReview(false);
    } catch (e) {
      setState("Preparation failed before transaction signing");
      setError(
        `${preparationStage === "transaction construction / RPC estimates" ? friendly(e) : metadataPreparationError(e, preparationStage === "Phantom launch approval")} Stage: ${preparationStage}. ${metadataComplete ? "Metadata upload completed." : metadataStarted ? "Public metadata verification is incomplete." : "Nothing was uploaded."} No transaction was signed or sent.`,
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function launch(recover = false, mainnetAuthorized = false) {
    if (lock.current || !plan) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      if (plan.values.quote !== "hype") throw Error("HYMET supports HYPE only");
      await withLaunchLock(network, plan.creator.toBase58(), async () => {
        if (!wallet.publicKey?.equals(plan.creator) || !wallet.signTransaction)
          throw Error("Reconnect the creator wallet");
        if (network !== plan.network)
          throw Error("Network changed; prepare again");
        if (
          network === "mainnet-beta" &&
          (!mainnetAuthorized ||
            !mainnetTransactionsEnabled())
        )
          throw Error("Explicit Mainnet confirmation required");
        assertRecoveryAllows(
          developmentStorage(),
          network,
          plan.creator.toBase58(),
          plan.mint.publicKey.toBase58(),
        );
        const c = connection(network);
        if (recover) {
          for (const s of plan.steps)
            if (s.signature) await inspectSignature(c, s);
          if (plan.steps.every((s) => s.done)) {
            setState("Verifying token and pool");
            const verified = await verifyLaunch(c, plan);
            await finishVerifiedLaunch(plan, verified);
            return;
          }
        }
        const r = await execute(
          c,
          plan,
          (tx) => wallet.signTransaction!(tx),
          setState,
          (p) => {
            const record = recoveryRecord(p);
            storeRecovery(developmentStorage(), record);
            setPending(record);
          },
        );
        await finishVerifiedLaunch(plan, r);
      });
    } catch (e) {
      setState(
        plan.steps.some((s) => s.signature || s.phase === "awaiting-signature")
          ? "Recovery required"
          : "Launch failed",
      );
      setError(friendly(e));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function finishVerifiedLaunch(
    verifiedPlan: Plan,
    verifiedResult: { status: string; supply: string },
  ) {
    const mint = verifiedPlan.mint.publicKey.toBase58();
    setResult(verifiedResult);
    setState("Launch successful");

    // Keep the confirmed signatures and result available to the existing recovery UI/storage
    // before leaving this page. A registry failure must remain visible here without redirecting.
    const closed = recoveryRecord(verifiedPlan, "closed");
    storeRecovery(developmentStorage(), closed);
    setPending(closed);
    try {
      await registerConfirmedLaunch(verifiedPlan);
    } catch (registrationError) {
      setError(
        `On-chain launch verified, but HYMET registry registration failed: ${friendly(registrationError)}`,
      );
      return;
    }

    const keys = Array.from(new Set([...saved, verifiedPlan.config.toBase58()]));
    setSaved(keys);
    developmentStorage().setItem(`dbc-configs-${network}`, JSON.stringify(keys));

    const destination = confirmedLaunchDestination(mint, true, true);
    if (destination && redirectedMint.current !== mint) {
      redirectedMint.current = mint;
      router.push(destination);
    }
  }
  async function inspectPending() {
    if (!pending || busy) return;
    setBusy(true);
    setError("");
    try {
      await withLaunchLock(pending.network, pending.creator, async () => {
        setRecoveryResult(
          await checkRecovery(connection(pending.network), pending),
        );
      });
    } catch (e) {
      setError(friendly(e));
    } finally {
      setBusy(false);
    }
  }
  async function closePending() {
    if (!pending || !recoveryResult || busy) return;
    setBusy(true);
    setError("");
    try {
      await withLaunchLock(pending.network, pending.creator, async () => {
        const checked = await checkRecovery(
          connection(pending.network),
          pending,
        );
        const closed = { ...pending, state: "closed" as const };
        storeRecovery(developmentStorage(), closed);
        setPending(closed);
        setRecoveryResult(undefined);
        setPlan(undefined);
        setResult(undefined);
        setState("Idle");
        if (checked.kind === "config-only") {
          allocationTouched.current = true;
          setV({ ...pending.values, reuse: pending.config });
        }
      });
    } catch (e) {
      setError(friendly(e));
    } finally {
      setBusy(false);
    }
  }
  const frozen = busy || !!plan;
  const allocationPolicy = allocationPolicyState.policy;
  const creatorShareNumber = /^(0|[1-9]\d?|100)$/.test(v.creatorShare)
    ? Number(v.creatorShare)
    : undefined;
  const holderShareNumber = creatorShareNumber === undefined
    ? undefined
    : 100 - creatorShareNumber;
  const summaryCreatorPercent = plan?.allocation.creatorPercent ?? creatorShareNumber;
  const summaryHolderPercent = plan?.allocation.holderPercent ?? holderShareNumber;
  const allocationSelectionAllowed = Boolean(
    allocationPolicy && creatorShareAllowed(v.creatorShare, allocationPolicy),
  );
  // The slider follows the verified distributor; whether launches are open is checked when the launch is submitted.
  const holderSplitsEnabled = holderSplitsAvailable(HOLDER_REWARDS_PROGRAM, holderPayoutsReady, allocationPolicy);
  const field = (
    key: keyof Inputs,
    label: string,
    hint?: string,
    placeholder?: string,
  ) => (
    <label className="field" key={key}>
      <span>{label}</span>
      <input
        value={v[key]}
        disabled={frozen}
        onChange={(e) => setV({ ...v, [key]: e.target.value })}
        placeholder={placeholder || label}
        type={["website", "twitter", "telegram"].includes(key) ? "url" : "text"}
        inputMode={
          [
            "name",
            "symbol",
            "website",
            "twitter",
            "telegram",
            "reuse",
          ].includes(key)
            ? "text"
            : "decimal"
        }
      />
      {hint && <small>{hint}</small>}
    </label>
  );
  const row = (label: string, value: string) => (
    <div className="review-row" key={label}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
  const explorer = (type: string, address: string) =>
    `https://solscan.io/${type}/${address}`;
  return (
    <>
      <header className="app-header">
        <Link className="brand" href="/" aria-label="HYMET home">
          <span className="brand-mark" aria-hidden="true">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
              <path
                d="M6 5h5a7 7 0 0 1 0 14H6V5Z"
                stroke="currentColor"
                strokeWidth="2"
              />
              <path d="M10 9h2a3 3 0 1 1 0 6h-2V9Z" fill="currentColor" />
            </svg>
          </span>
          <span className="brand-text">
            <b>
              HYMET
            </b>
            <small>Where HYPE launches.</small>
          </span>
        </Link>
        <ApplicationTabs active={activeTab} onChange={setActiveTab} />
        <div className="wallet">
          <span className="badge">
            <span className="network-dot" /> {activeNetworkLabel("Mainnet Beta")}
          </span>
          <span className="fine">{wallet.publicKey ? `${wallet.publicKey.toBase58().slice(0, 4)}…${wallet.publicKey.toBase58().slice(-4)}` : "Connect wallet from the navigation to continue."}</span>
        </div>
      </header>
      <main>
        <ApplicationPanel id="launch" active={activeTab}>
          <div className="intro">
            <h1>
              Bring Your Idea.
              <br />
              <span className="launch-hero-teal">Launch With HYPE.</span>
            </h1>
            <p>
              Create your token, customize its launch, and bring it to market on Solana.
            </p>
          </div>
          <div className="workspace">
            <div className="forms">
              <section><div id="launch-identity" className="launch-step-panel">
                <div className="section-title">
                  <div>
                    <h2>Create your token</h2>
                    <p>Add a name, symbol, artwork, and social links.</p>
                  </div>
                </div>
                <div className="grid">
                  {field("name", "Token name")}
                  {field("symbol", "Symbol")}
                </div>
                <label className="field">
                  <span>Description</span>
                  <textarea
                    disabled={frozen}
                    maxLength={2000}
                    value={v.description}
                    onChange={(e) =>
                      setV({ ...v, description: e.target.value })
                    }
                    placeholder="What are you launching?"
                  />
                </label>
                <label className="upload">
                  <span className="logo-preview">
                    {preview ? (
                      <Image
                        unoptimized
                        width={65}
                        height={65}
                        src={preview}
                        alt="Final processed 500 by 500 token artwork preview"
                      />
                    ) : (
                      "↥"
                    )}
                  </span>
                  <div>
                    <b>{image?.name || "Upload token logo"}</b>
                    <small>PNG, JPEG or GIF · any common dimensions · centered 500 × 500 crop · final image under 1 MB</small>
                    {imageProcessing && <small role="status">Center-cropping and compressing image…</small>}
                    {imageIssue && (
                      <small role="alert" className="error">
                        {imageIssue}
                      </small>
                    )}
                    <input
                      disabled={frozen}
                      type="file"
                      accept="image/png,image/jpeg,image/gif"
                      onChange={(e) => {
                        const input = e.currentTarget;
                        const file = input.files?.[0];
                        const processId = ++imageProcessId.current;
                        const reject = (reason: string) => {
                          setImage(undefined);
                          setPreview("");
                          setImageIssue(reason);
                          setError(reason);
                          input.value = "";
                        };
                        setImage(undefined);
                        setImageIssue("");
                        setError("");
                        setPreview("");
                        if (!file) { setImageProcessing(false); return; }
                        setImageProcessing(true);
                        void processArtwork(file)
                          .then((processed) => {
                            if (processId !== imageProcessId.current) return;
                            setImage(processed);
                            setPreview(URL.createObjectURL(processed));
                            setImageIssue("");
                          })
                          .catch((cause: unknown) => {
                            if (processId === imageProcessId.current)
                              reject(cause instanceof Error ? cause.message : "Artwork could not be processed.");
                          })
                          .finally(() => {
                            if (processId === imageProcessId.current) setImageProcessing(false);
                          });
                      }}
                    />
                  </div>
                </label>
                <div className="grid launch-social-grid" style={{ marginTop: 20 }}>
                  {field(
                    "website",
                    "Website URL",
                    "Optional · HTTPS",
                    "https://yourproject.com",
                  )}
                  {field(
                    "twitter",
                    "X (Twitter) URL",
                    "Optional · x.com or twitter.com",
                    "https://x.com/yourproject",
                  )}
                  {field(
                    "telegram",
                    "Telegram URL",
                    "Optional · t.me",
                    "https://t.me/yourproject",
                  )}
                </div>
                <div className="launch-social-extra">
                  {field(
                    "social",
                    "Additional social URL",
                    "Optional · HTTPS",
                    "https://",
                  )}
                </div>
                <p className="fine launch-social-note">
                  Social links are included with your token details.
                </p>
              </div></section>
              <section>
                <div className="section-title">
                  <div>
                    <h2>Fee Distribution</h2>
                    <p>Set your trading fee, creator split, and optional first buy.</p>
                  </div>
                </div>
                <div className="launch-fee-layout">
                  <div className="launch-fee-primary">
                    <label className="field">
                      <span>Trading fee · maximum 3%</span>
                      <input
                        type="number"
                        min="0.25"
                        max="3"
                        step="0.05"
                        value={v.fee}
                        disabled={frozen}
                        onChange={(e) => setV({ ...v, fee: e.target.value, postFee: e.target.value })}
                      />
                      <small>Choose a Meteora-supported trading fee from 0.25% to 3%.</small>
                    </label>
                    {field(
                      "buy",
                      `Initial buy (${quoteAsset(v).symbol})`,
                      "0 means no purchase",
                    )}
                    <p className="fine launch-fee-details">
                      <Link href="/docs/trading-protocol-fees">Fee and migration details ↗</Link>
                    </p>
                  </div>
                  <div className="field fee-distribution">
                    <div className="fee-distribution-heading">
                      <span>Creator and holder allocation</span>
                      <small>Of the creator-controlled 80%</small>
                    </div>
                    <div className="allocation-values" aria-live="polite">
                      <div><span>Creator</span><strong>{creatorShareNumber === undefined ? "—" : `${creatorShareNumber}%`}</strong></div>
                      <div><span>Holders</span><strong>{holderShareNumber === undefined ? "—" : `${holderShareNumber}%`}</strong></div>
                    </div>
                    {allocationPolicy ? allocationSelectionAllowed && creatorShareNumber !== undefined ? (
                      <input
                        className="allocation-slider"
                        type="range"
                        min={allocationPolicy.min}
                        max={allocationPolicy.max}
                        step={allocationPolicy.step}
                        value={creatorShareNumber}
                        style={{ "--allocation-progress": `${creatorShareNumber}%` } as CSSProperties}
                        disabled={frozen || !holderSplitsEnabled}
                        aria-label="Creator allocation of the creator-controlled 80%"
                        aria-valuetext={`${creatorShareNumber}% creator, ${holderShareNumber}% holders`}
                        onChange={(e) => {
                          allocationTouched.current = true;
                          const creatorShare = String(e.currentTarget.valueAsNumber);
                          setV((current) => ({ ...current, creatorShare }));
                        }}
                      />
                    ) : (
                      <div className="allocation-blocked" role="status">
                        <span>Selected allocation {creatorShareNumber === undefined ? "is invalid" : `${creatorShareNumber}% creator / ${holderShareNumber}% holders`} and has been kept unchanged.</span>
                        <button
                          type="button"
                          disabled={frozen}
                          onClick={() => {
                            allocationTouched.current = true;
                            setV((current) => ({ ...current, creatorShare: String(allocationPolicy.default) }));
                          }}
                        >
                          Use allowed default ({allocationPolicy.default}% creator)
                        </button>
                      </div>
                    ) : (
                      <div className="allocation-blocked" role="status">
                        {allocationPolicyState.error || "Loading server allocation settings…"}
                      </div>
                    )}
                    <small className="allocation-note">
                      {holderSplitsEnabled
                        ? `HYMET's fixed 20% platform share stays unchanged. This slider splits the remaining 80%.${mainnetPayoutVerified ? "" : " Holder payouts are configured; no Mainnet payout has been verified yet."}`
                        : `HYMET's fixed 20% platform share stays unchanged. Holder splits are unavailable because the distributor check couldn't finish. Refresh to try again. Current allocation: ${creatorShareNumber ?? "—"}% creator / ${holderShareNumber ?? "—"}% holders.`}
                    </small>
                  </div>
                </div>
              </section>
            </div>
            <aside className="launch-summary-column">
              {pending?.state === "pending" && !plan && (
                <section className="recovery-panel">
                  <h2>Unresolved launch record</h2>
                  <p className="fine">
                    A new launch is paused until this record is checked.
                  </p>
                  {[
                    ["Network", activeNetworkLabel()],
                    ["Mint", pending.mint],
                    ["Pool", pending.pool],
                    ["Config", pending.config],
                    ...pending.steps.map((s) => [
                      s.label,
                      s.signature || "Not submitted",
                    ]),
                  ].map(([label, value]) => row(label, value))}
                  <button disabled={busy} onClick={inspectPending}>
                    Check existing accounts and signatures
                  </button>
                  {recoveryResult && (
                    <>
                      <p className="fine">{recoveryResult.message}</p>
                      <button disabled={busy} onClick={closePending}>
                        {recoveryResult.kind === "config-only"
                          ? "Close record and reuse confirmed config"
                          : "Close checked record"}
                      </button>
                    </>
                  )}
                  {error && <p className="error">{error}</p>}
                </section>
              )}
              {mainnetReview !== undefined && plan ? (
                <MainnetConfirmation
                  key={plan.mint.publicKey.toBase58()}
                  plan={plan}
                  onCancel={() => setMainnetReview(undefined)}
                  onConfirm={() => {
                    const recover = mainnetReview;
                    setMainnetReview(undefined);
                    void launch(recover, true);
                  }}
                />
              ) : (
                <section className="launch-summary" id="launch-review">
                  <span className="launch-summary-label">
                    <svg aria-hidden="true" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 15l-3.5-3.5C10 6 14.5 3 20 3c0 5.5-3 10-8.5 11.5L8 11" />
                      <path d="M8.5 15.5 6 18l-1-4 3.5-1.5M12.5 8.5h.01M15.5 11.5h.01M8 20c1.5-.5 2-1.5 2-3" />
                    </svg>
                    LAUNCH SUMMARY
                  </span>
                  <h2>Ready to Launch?</h2>
                  <p className="launch-summary-copy">Review your token before launching.</p>
                  <div className="summary-token">
                    <span>Token</span>
                    <strong>{v.name.trim() || "Your token"}</strong>
                    <small>{v.symbol.trim() ? `$${v.symbol.trim().toUpperCase()}` : "Ticker not set"}</small>
                  </div>
                  <div className="summary-metrics">
                    <div><span>Trading fee</span><strong>{v.fee}%</strong></div>
                    <div><span>Creator / Holders</span><strong>{summaryCreatorPercent === undefined || summaryHolderPercent === undefined ? "—" : `${summaryCreatorPercent}% / ${summaryHolderPercent}%`}</strong><small>of the creator-controlled 80%</small></div>
                    <div><span>Initial buy</span><strong>{v.buy || "0"} HYPE</strong></div>
                    <div><span>Estimated cost</span><strong>{plan ? `${sol(plan.total)} SOL` : "Calculated on review"}</strong><small>{plan ? "Current RPC estimate" : "Updated after transaction simulation"}</small></div>
                  </div>
                  <div className="summary-wallet" aria-live="polite">
                    <span className={wallet.publicKey ? "wallet-status-dot connected" : "wallet-status-dot"} />
                    {wallet.publicKey
                      ? `Phantom connected · ${wallet.publicKey.toBase58().slice(0, 4)}…${wallet.publicKey.toBase58().slice(-4)}`
                      : mainnetTransactionsEnabled() ? "Connect Phantom from the navbar to continue." : "Token creation is not open yet."}
                  </div>
                  {!plan && !mainnetTransactionsEnabled() ? (
                    <button className="primary summary-cta" disabled>
                      Launching Soon
                    </button>
                  ) : !plan ? (
                    <button
                      className="primary summary-cta"
                      disabled={busy || imageProcessing || !wallet.connected || allocationPolicyState.status !== "ready" || pending?.state === "pending"}
                      onClick={prepare}
                    >
                      {busy ? "Preparing launch…" : "Review Launch →"}
                    </button>
                  ) : !result ? (
                    <>
                      {mainnetTransactionsEnabled() ? (
                        <button
                          className="primary summary-cta"
                          disabled={busy || !wallet.connected || state === "Recovery required" || plan.steps.some((step) => step.signature || step.phase === "awaiting-signature")}
                          onClick={() => setMainnetReview(false)}
                        >
                          Review Launch →
                        </button>
                      ) : (
                        <button className="primary summary-cta" disabled>
                          Launching Soon
                        </button>
                      )}
                      {state === "Recovery required" && (
                        <button type="button" onClick={() => setMainnetReview(true)} disabled={busy}>
                          Check signatures &amp; resume safely
                        </button>
                      )}
                      {!plan.steps.some((step) => step.signature || step.phase === "awaiting-signature") && (
                        <button type="button" onClick={() => { setPlan(undefined); setMainnetReview(undefined); setState("Idle"); setError(""); }} disabled={busy}>
                          Edit launch
                        </button>
                      )}
                    </>
                  ) : (
                    <strong className="success">✓ Launch verified on-chain</strong>
                  )}
                  {state !== "Idle" && <div role="status" aria-live="polite" className="status">{state}</div>}
                  {error && <p role="alert" className="error">{error}</p>}
                  {plan && balance !== undefined && balance < remainingRequirement(plan) && (
                    <p className="error">Insufficient SOL for the estimated total requirement.</p>
                  )}
                  <small className="launch-summary-footer">Final transaction approval happens in Phantom.</small>
                </section>
              )}
            </aside>
          </div>
          {plan?.steps.some((s) => s.signature) && (
            <section className="results">
              <span className="eyebrow">
                {result
                  ? "VERIFIED LAUNCH"
                  : "LAUNCH RECORD · RECOVERY MAY BE REQUIRED"}
              </span>
              <h2>
                {v.name} <span>${v.symbol}</span>
              </h2>
              {row("Network", activeNetworkLabel(plan.network))}
              {row("Current pool status", result?.status || "Not verified")}
              {[
                ["Token mint", plan.mint.publicKey.toBase58()],
                ["DBC pool", plan.pool.toBase58()],
                ["DBC config", plan.config.toBase58()],
                ["Creator wallet", plan.creator.toBase58()],
              ].map(([label, address]) => (
                <div className="address" key={label}>
                  <span>{label}</span>
                  <code>{address}</code>
                  <button
                    onClick={() => navigator.clipboard.writeText(address)}
                  >
                    Copy
                  </button>
                  <a
                    target="_blank"
                    rel="noreferrer"
                    href={explorer("account", address)}
                  >
                    Solscan ↗
                  </a>
                </div>
              ))}
              {plan.steps.map(
                (s, i) =>
                  s.signature && (
                    <div className="address" key={i}>
                      <span>{s.label}</span>
                      <a
                        target="_blank"
                        rel="noreferrer"
                        href={explorer("tx", s.signature)}
                      >
                        {s.signature}
                      </a>
                      <b>{s.done ? "Confirmed" : "Check status"}</b>
                    </div>
                  ),
              )}
              <p className="fine">
                Save these public addresses and signatures for recovery. No
                secret keys are exported.
              </p>
            </section>
          )}
        </ApplicationPanel>
        <TokenManagement
          activeTab={activeTab}
          onTabChange={setActiveTab}
          network={network}
          verifiedPool={
            result && plan && wallet.publicKey?.equals(plan.creator)
              ? plan.pool.toBase58()
              : undefined
          }
        />
      </main>
    </>
  );
}
