import { PublicKey, type Connection } from "@solana/web3.js";
import { curve, distributorCurve, units, validate, type Inputs } from "./config";
import {
  checkNetwork,
  verifyConfig,
  verifyLaunch,
  type Plan,
  type Step,
  type Network,
  type VerificationPlan,
} from "./transactions";
export type RecoveryRecord = {
  distributorProgramId?: string;
  version: 1;
  state: "pending" | "closed";
  network: Network;
  creator: string;
  mint: string;
  config: string;
  pool: string;
  values: Inputs;
  uri: string;
  artworkUri?: string;
  reservationId?: string;
  recipients: Plan["recipients"];
  steps: {
    label: string;
    signature?: string;
    lastValidBlockHeight?: number;
    phase?: Step["phase"];
  }[];
};
const key = (network: Network, creator: string) =>
  `dbc-recovery-v1:${network}:${creator}`;
export function recoveryRecord(
  p: Plan,
  state: RecoveryRecord["state"] = "pending",
): RecoveryRecord {
  return {
    version: 1,
    distributorProgramId: p.distributorProgramId,
    state,
    network: p.network,
    creator: p.creator.toBase58(),
    mint: p.mint.publicKey.toBase58(),
    config: p.config.toBase58(),
    pool: p.pool.toBase58(),
    values: { ...p.values },
    uri: p.uri,
    artworkUri: p.artworkUri,
    reservationId: p.reservationId,
    recipients: { ...p.recipients },
    steps: p.steps.map((s) => ({
      label: s.label,
      signature: s.signature,
      phase: s.phase,
      lastValidBlockHeight: s.lastValidBlockHeight,
    })),
  };
}
export function loadRecovery(
  storage: Pick<Storage, "getItem">,
  network: Network,
  creator: string,
): RecoveryRecord | undefined {
  const raw = storage.getItem(key(network, creator));
  if (!raw) return;
  const r = JSON.parse(raw) as RecoveryRecord;
  if (
    r.version !== 1 ||
    r.network !== network ||
    r.creator !== creator ||
    !["pending", "closed"].includes(r.state) ||
    !Array.isArray(r.steps) ||
    r.steps.length < 1 ||
    r.steps.length > 2
  )
    throw Error(
      "Invalid recovery record. Inspect the saved public record before launching again.",
    );
  if (
    r.steps.some(
      (s) =>
        s.phase !== undefined &&
        ![
          "unsigned",
          "awaiting-signature",
          "signed",
          "broadcasting",
          "submitted",
          "confirmed",
        ].includes(s.phase),
    )
  )
    throw Error(
      "Invalid recovery phase. Preserve the public record and inspect before proceeding.",
    );
  for (const a of [
    r.creator,
    r.mint,
    r.config,
    r.pool,
    r.recipients.partner,
    r.recipients.leftover,
  ])
    new PublicKey(a);
  validate(r.values);
  return r;
}
export function storeRecovery(
  storage: Pick<Storage, "setItem">,
  r: RecoveryRecord,
) {
  storage.setItem(key(r.network, r.creator), JSON.stringify(r));
}
export function assertRecoveryAllows(
  storage: Pick<Storage, "getItem">,
  network: Network,
  creator: string,
  mint?: string,
) {
  const r = loadRecovery(storage, network, creator);
  if (r?.state === "pending" && r.mint !== mint)
    throw Error(
      "An unresolved launch exists for this wallet and network. Check its recovery record before preparing another token.",
    );
  if (r?.state === "closed" && r.mint === mint)
    throw Error(
      "This launch record was closed. Its old unsigned transactions must not be resumed.",
    );
}
export async function withLaunchLock<T>(
  network: Network,
  creator: string,
  action: () => Promise<T>,
): Promise<T> {
  if (!navigator.locks)
    throw Error(
      "This browser must support Web Locks for safe launch recovery.",
    );
  return navigator.locks.request(
    `hymet:dbc-launch:${network}:${creator}`,
    { ifAvailable: true },
    async (lock) => {
      if (!lock)
        throw Error(
          "Another tab is using this wallet launch. Wait for it to finish.",
        );
      return action();
    },
  );
}
function verificationPlan(r: RecoveryRecord): VerificationPlan {
  const creator = new PublicKey(r.creator);
  return {
    distributorProgramId: r.distributorProgramId,
    values: r.values,
    network: r.network,
    creator,
    mint: { publicKey: new PublicKey(r.mint) },
    config: new PublicKey(r.config),
    pool: new PublicKey(r.pool),
    buy: units(r.values.buy, 9),
    configParams: r.distributorProgramId ? distributorCurve(r.values, creator) : curve(r.values, creator),
    recipients: r.recipients,
    uri: r.uri,
    steps: r.steps.map((s) => ({ signature: s.signature })),
  };
}
export type RecoveryResult = {
  kind: "verified" | "config-only" | "failed";
  message: string;
};
export async function checkRecovery(
  c: Connection,
  r: RecoveryRecord,
): Promise<RecoveryResult> {
  await checkNetwork(c, r.network);
  const unsignedApproval = r.steps.filter(
    (s) => !s.signature && s.phase === "awaiting-signature",
  );
  if (unsignedApproval.length) {
    const height = await c.getBlockHeight("finalized");
    if (
      unsignedApproval.some(
        (s) =>
          !Number.isSafeInteger(s.lastValidBlockHeight) ||
          height <= s.lastValidBlockHeight!,
      )
    )
      throw Error(
        "Wallet approval completion is unknown. Wait for finalized blockhash expiry and check recovery; do not retry.",
      );
  }
  const submitted = r.steps.filter((s) => s.signature);
  const statuses = await c.getSignatureStatuses(
    submitted.map((s) => s.signature!),
    { searchTransactionHistory: true },
  );
  if (statuses.value.length !== submitted.length)
    throw Error("RPC returned an incomplete signature status list");
  let finalizedHeight: number | undefined;
  if (
    statuses.value.some(
      (s, i) => !s && Number.isSafeInteger(submitted[i].lastValidBlockHeight),
    )
  )
    finalizedHeight = await c.getBlockHeight("finalized");
  const expired = statuses.value.map(
    (s, i) =>
      !s &&
      Number.isSafeInteger(submitted[i].lastValidBlockHeight) &&
      finalizedHeight !== undefined &&
      finalizedHeight > submitted[i].lastValidBlockHeight!,
  );
  if (
    statuses.value.some((s, i) =>
      s ? s.confirmationStatus !== "finalized" : !expired[i],
    )
  )
    throw Error(
      "A recorded transaction is still uncertain or not finalized. No replacement launch is allowed.",
    );
  const snapshot =
    expired.some(Boolean) || unsignedApproval.length > 0
      ? {
          commitment: "finalized" as const,
          minContextSlot: await c.getSlot("finalized"),
        }
      : "finalized";
  const [mint, pool, config] = await c.getMultipleAccountsInfo(
    [r.mint, r.pool, r.config].map((a) => new PublicKey(a)),
    snapshot,
  );
  const p = verificationPlan(r);
  if (mint || pool) {
    await verifyLaunch(c, p);
    return {
      kind: "verified",
      message:
        "Existing token and pool verified. Do not create a replacement token.",
    };
  }
  if (config) {
    await verifyConfig(c, p);
    const poolStep =
      r.steps.length === 2
        ? r.steps[1]
        : r.values.reuse
          ? r.steps[0]
          : undefined;
    const poolIndex = submitted.findIndex(
      (s) => s.signature === poolStep?.signature,
    );
    if (
      poolStep?.signature &&
      !statuses.value[poolIndex]?.err &&
      !expired[poolIndex]
    )
      throw Error(
        "Pool transaction is confirmed but accounts are absent. Inspect the transaction before proceeding.",
      );
    return {
      kind: "config-only",
      message:
        "Only the existing config is present; no mint or pool exists at finalized commitment. Close this record explicitly to reuse the config with a fresh mint.",
    };
  }
  if (
    !submitted.length &&
    r.steps.every((s) => s.phase === "unsigned" || unsignedApproval.includes(s))
  )
    return {
      kind: "failed",
      message:
        "Preparation/execution stopped before broadcast or its unsigned approval expired; finalized launch accounts are absent. You may explicitly close this record.",
    };
  if (
    !submitted.length ||
    statuses.value.some((s, i) => !s?.err && !expired[i])
  )
    throw Error(
      "Confirmed transaction accounts could not be verified. Inspect the record before proceeding.",
    );
  return {
    kind: "failed",
    message:
      "Recorded transactions failed or expired at finalized commitment and no launch accounts exist. This record can be closed explicitly.",
  };
}
