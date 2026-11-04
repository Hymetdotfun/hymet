import { HYPE_MINT } from "./quote-assets";
import { Buffer } from "buffer";
import {
  Connection,
  PublicKey,
  Transaction,
  ComputeBudgetProgram,
  Message,
} from "@solana/web3.js";
import {
  DynamicBondingCurveClient,
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
  METAPLEX_PROGRAM_ID,
  deriveDbcPoolAddress,
  type VirtualPool,
  type PoolConfig,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import {
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  unpackMint,
  unpackAccount,
  ACCOUNT_SIZE,
} from "@solana/spl-token";
import BN from "bn.js";
import bs58 from "bs58";
import { readMigration } from "./migration";
import { dedupedRead, withRpcRetry } from "./rpc-retry";
import { assertMainnetTransactionsEnabled } from "./app-network";
import {
  checkNetwork,
  assertSigners,
  simulateReviewedTransaction,
  pollConfirmation,
  type Network,
  estimateMessageFee,
  WALLET_PRIORITY_MICROLAMPORTS,
} from "./transactions";
import { verifyWalletMessage } from "./wallet-guards";

export type FeeView = Awaited<ReturnType<typeof readCreatorFees>>;
export function tokenAmount(amount: bigint, decimals: number) {
  const scale = 10n ** BigInt(decimals);
  return decimals
    ? `${amount / scale}.${(amount % scale).toString().padStart(decimals, "0")}`
    : amount.toString();
}
export async function readCreatorFees(
  c: Connection,
  network: Network,
  address: string,
) {
  await checkNetwork(c, network);
  const pool = new PublicKey(address),
    sdk = new DynamicBondingCurveClient(c, "confirmed");
  const account = await c.getAccountInfo(pool, "confirmed");
  if (!account?.owner.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID))
    throw Error("Pool is missing or is not DBC-owned on this network");
  // Decode the exact owned account with the installed official IDL, not metrics/volume estimates.
  const p = sdk.program.coder.accounts.decode<VirtualPool>(
    "virtualPool",
    account.data,
  ).poolState;
  const cfgAccount = await c.getAccountInfo(p.config, "confirmed");
  if (!cfgAccount?.owner.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID))
    throw Error("Config is missing or is not DBC-owned");
  const cfg = sdk.program.coder.accounts.decode<PoolConfig>(
    "poolConfig",
    cfgAccount.data,
  );
  if (!deriveDbcPoolAddress(cfg.quoteMint, p.baseMint, p.config).equals(pool))
    throw Error("Pool address does not match its mint/config");
  const [baseInfo, quoteInfo] = await c.getMultipleAccountsInfo(
    [p.baseMint, cfg.quoteMint],
    "confirmed",
  );
  if (!baseInfo || !quoteInfo) throw Error("Pool token mint missing");
  const base = unpackMint(p.baseMint, baseInfo, baseInfo.owner),
    quote = unpackMint(cfg.quoteMint, quoteInfo, quoteInfo.owner);
  const supported =
    baseInfo.owner.equals(TOKEN_PROGRAM_ID) &&
    quoteInfo.owner.equals(TOKEN_PROGRAM_ID) &&
    (cfg.quoteMint.equals(NATIVE_MINT) ||
      (cfg.quoteMint.equals(HYPE_MINT) &&
        quote.decimals === 9 &&
        quote.freezeAuthority === null &&
        quoteInfo.data.length === 82 &&
        cfg.quoteTokenFlag === 0)) &&
    p.poolType === 0;
  let name = "",
    symbol = "";
  try {
    const [key] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("metadata"),
        METAPLEX_PROGRAM_ID.toBuffer(),
        p.baseMint.toBuffer(),
      ],
      METAPLEX_PROGRAM_ID,
    );
    const meta = await c.getAccountInfo(key, "confirmed");
    if (
      meta?.owner.equals(METAPLEX_PROGRAM_ID) &&
      meta.data[0] === 4 &&
      new PublicKey(meta.data.subarray(33, 65)).equals(p.baseMint)
    ) {
      let offset = 65;
      const string = (max: number) => {
        const n = meta.data.readUInt32LE(offset);
        offset += 4;
        if (n > max || offset + n > meta.data.length)
          throw Error("Invalid metadata");
        const s = meta.data
          .subarray(offset, offset + n)
          .toString("utf8")
          .replace(/\0+$/, "");
        offset += n;
        return s;
      };
      name = string(32);
      symbol = string(10);
    }
  } catch {
    /* Optional identity must never substitute for account/authority checks. */
  }
  const status =
    p.isMigrated === 1
      ? "migrated"
      : p.isMigrated === 0 && p.migrationProgress === 0
        ? "active"
        : "unknown";
  return {
    network,
    pool: pool.toBase58(),
    config: p.config.toBase58(),
    mint: p.baseMint.toBase58(),
    quoteMint: cfg.quoteMint.toBase58(),
    creator: p.creator.toBase58(),
    creatorShare: cfg.creatorTradingFeePercentage as number,
    collectMode: cfg.collectFeeMode as number,
    base: BigInt(p.creatorBaseFee.toString()),
    quote: BigInt(p.creatorQuoteFee.toString()),
    baseDecimals: base.decimals,
    quoteDecimals: quote.decimals,
    status,
    migrationOption: cfg.migrationOption as number,
    migration: await readMigration(c, p, cfg),
    supported,
    name,
    symbol,
  };
}
export function assertClaimAuthority(view: FeeView, wallet: PublicKey) {
  if (view.creator !== wallet.toBase58())
    throw Error("Connected wallet is not this pool's creator");
  if (!view.supported)
    throw Error(
      "Claims support standard SPL DBC pools with SOL or verified HYPE quote only; this token/config needs a separate verified integration",
    );
  if (view.base === 0n && view.quote === 0n)
    throw Error("No DBC creator trading fees to claim");
}
type Store = Pick<Storage, "getItem" | "setItem">;
export type ClaimRecord = {
  network: Network;
  wallet: string;
  pool: string;
  signature: string;
  lastValidBlockHeight: number;
  expiryKnown?: boolean;
  reviewedFee?: string;
  signedFee?: string;
  actualFee?: string;
  signingIssue?: string;
  state: "pending" | "confirmed" | "failed" | "expired";
};
const claimKey = (n: Network, w: string) => `dbc-creator-claim-v1:${n}:${w}`;
export function claimRecord(
  storage: Pick<Storage, "getItem">,
  network: Network,
  wallet: string,
): ClaimRecord | undefined {
  const raw = storage.getItem(claimKey(network, wallet));
  if (!raw) return;
  const r = JSON.parse(raw) as ClaimRecord;
  if (
    r.network !== network ||
    r.wallet !== wallet ||
    !["pending", "confirmed", "failed", "expired"].includes(r.state) ||
    !Number.isSafeInteger(r.lastValidBlockHeight) ||
    r.lastValidBlockHeight < 0 ||
    (r.expiryKnown !== undefined && typeof r.expiryKnown !== "boolean") ||
    [r.reviewedFee, r.signedFee, r.actualFee].some(
      (f) => f !== undefined && (typeof f !== "string" || !/^\d+$/.test(f)),
    ) ||
    bs58.decode(r.signature).length !== 64
  )
    throw Error("Invalid claim journal; inspect before claiming again");
  new PublicKey(r.pool);
  return r;
}
export function saveClaim(storage: Store, r: ClaimRecord) {
  storage.setItem(claimKey(r.network, r.wallet), JSON.stringify(r));
}
export function assertNoPendingClaim(
  storage: Store,
  network: Network,
  wallet: string,
) {
  if (claimRecord(storage, network, wallet)?.state === "pending")
    throw Error(
      "A claim is pending. Check its signature; no replacement is allowed.",
    );
}
export type ClaimPlan = {
  view: FeeView;
  wallet: string;
  tx: Transaction;
  message: string;
  fee: bigint;
  rent: bigint;
  destinations: string[];
  lastValidBlockHeight: number;
  existingWrappedSol: bigint;
};
function lamports(n: number) {
  if (!Number.isSafeInteger(n) || n < 0)
    throw Error("Invalid RPC lamport estimate");
  return BigInt(n);
}
export async function prepareCreatorClaim(
  c: Connection,
  network: Network,
  address: string,
  wallet: PublicKey,
): Promise<ClaimPlan> {
  const view = await readCreatorFees(c, network, address);
  assertClaimAuthority(view, wallet);
  const destinations = [
    getAssociatedTokenAddressSync(new PublicKey(view.mint), wallet),
    getAssociatedTokenAddressSync(new PublicKey(view.quoteMint), wallet),
  ];
  const infos = await c.getMultipleAccountsInfo(destinations, "confirmed");
  let existingWrappedSol = 0n;
  for (let i = 0; i < infos.length; i++)
    if (infos[i]) {
      const a = unpackAccount(destinations[i], infos[i], TOKEN_PROGRAM_ID);
      if (
        !a.owner.equals(wallet) ||
        a.isFrozen ||
        !a.mint.equals(new PublicKey(i === 0 ? view.mint : view.quoteMint))
      )
        throw Error("Fee destination token account mismatch");
      if (i === 1 && view.quoteMint === NATIVE_MINT.toBase58())
        existingWrappedSol = a.amount;
    }
  // SDK closes the creator's WSOL ATA to the same creator. Disclose its pre-existing funds too.
  const rent =
    BigInt(infos.filter((a) => !a).length) *
    lamports(await c.getMinimumBalanceForRentExemption(ACCOUNT_SIZE));
  const sdk = new DynamicBondingCurveClient(c, "confirmed");
  const tx = await sdk.creator.claimCreatorTradingFee({
    creator: wallet,
    payer: wallet,
    receiver: wallet,
    pool: new PublicKey(view.pool),
    maxBaseAmount: new BN(view.base.toString()),
    maxQuoteAmount: new BN(view.quote.toString()),
  });
  tx.instructions.unshift(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: WALLET_PRIORITY_MICROLAMPORTS }),
  );
  const block = await c.getLatestBlockhash("confirmed");
  tx.feePayer = wallet;
  tx.recentBlockhash = block.blockhash;
  assertSigners(tx, wallet, []);
  const estimate = await estimateMessageFee(c, tx);
  if (estimate === null) throw Error("RPC could not estimate claim fee");
  return {
    view,
    wallet: wallet.toBase58(),
    tx,
    message: Buffer.from(tx.serializeMessage()).toString("base64"),
    fee: lamports(estimate),
    rent,
    destinations: destinations.map((k) => k.toBase58()),
    lastValidBlockHeight: block.lastValidBlockHeight,
    existingWrappedSol,
  };
}
export async function refreshClaim(
  c: Connection,
  storage: Store,
  r: ClaimRecord,
) {
  await checkNetwork(c, r.network);
  if (r.state === "pending") {
    const statuses = await withRpcRetry(() =>
      c.getSignatureStatuses([r.signature], { searchTransactionHistory: true }),
    );
    if (statuses.value.length !== 1)
      throw Error("RPC returned an incomplete claim signature status");
    const status = statuses.value[0];
    if (
      status?.confirmationStatus === "confirmed" ||
      status?.confirmationStatus === "finalized"
    )
      r = { ...r, state: status.err ? "failed" : "confirmed" };
    else if (
      !status &&
      r.expiryKnown !== false &&
      (await c.getBlockHeight("finalized")) > r.lastValidBlockHeight
    )
      r = { ...r, state: "expired" };
    if (r.state !== "pending") saveClaim(storage, r);
  }
  if ((r.state === "confirmed" || r.state === "failed") && !r.actualFee) {
    // The actual fee is informational; a failed read leaves the confirmed record untouched.
    const tx = await withRpcRetry(() =>
      c.getTransaction(r.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }),
    ).catch(() => null);
    if (tx?.meta) {
      r = { ...r, actualFee: lamports(tx.meta.fee).toString() };
      saveClaim(storage, r);
    }
  }
  // Balance refresh is display-only: retried, deduplicated, and never turns a settled claim into an error.
  try {
    return { record: r, view: await withRpcRetry(() => readCreatorFeesForDisplay(c, r.network, r.pool)) };
  } catch (e) {
    return {
      record: r,
      view: undefined,
      refreshWarning: `Claim ${r.state}. The claimable balance could not be refreshed (${e instanceof Error ? e.message : "RPC unavailable"}); refresh again in a moment.`,
    };
  }
}
/** Shared, 5-second cached read for display refreshes only; claim checks always call readCreatorFees directly. */
const readCreatorFeesForDisplay = dedupedRead(
  5_000,
  (_c: Connection, network: Network, address: string) => `${network}:${address}`,
  (c: Connection, network: Network, address: string) => readCreatorFees(c, network, address),
);
export async function signCreatorClaim(
  c: Connection,
  plan: ClaimPlan,
  wallet: PublicKey,
  sign: (tx: Transaction) => Promise<Transaction>,
  storage: Store,
) {
  // Give the adapter a canonical legacy wire round trip; never compare full
  // unsigned/signed serialization (signature bytes necessarily differ).
  const input = Transaction.from(
    plan.tx.serialize({ requireAllSignatures: false, verifySignatures: false }),
  );
  assertSigners(input, wallet, []);
  if (Buffer.from(input.serializeMessage()).toString("base64") !== plan.message)
    throw Error(
      "Claim changed during serialization; review again before signing",
    );
  const partialSignatures = input.signatures.filter(
    (s) => s.signature !== null,
  ).length;
  console.info("[CreatorFees claim-signing-v3] before-wallet", {
    requiredSignatures: input.compileMessage().header.numRequiredSignatures,
    partialSignatures,
    computeBudgetInstructions: input.instructions.filter((ix) =>
      ix.programId.equals(ComputeBudgetProgram.programId),
    ).length,
    feePayerMatches: input.feePayer?.equals(wallet) === true,
  });
  if (partialSignatures !== 0)
    throw Error(
      "[CLAIM_PREEXISTING_SIGNATURE] Claim already contains a signature. Prepare a fresh review; stale signatures will not be reused.",
    );
  const response = await sign(input);
  if (!response || typeof response.serialize !== "function")
    throw Error(
      "[CLAIM_RESPONSE_TYPE] Wallet adapter did not return a signed transaction",
    );
  const signed = Transaction.from(
    response.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    }),
  );
  const message = Buffer.from(signed.serializeMessage()).toString("base64");
  const reviewed = Message.from(Buffer.from(plan.message, "base64"));
  // Same rule as executeWalletOperation: byte-identical, or only added Lighthouse assertions.
  const check = verifyWalletMessage(Buffer.from(plan.message, "base64"), Buffer.from(message, "base64"));
  const changed = !check.ok;
  const actual = signed.compileMessage();
  const missingSignatures = signed.signatures.filter(
    (s) => !s.signature,
  ).length;
  const signaturesValid = missingSignatures === 0 && signed.verifySignatures();
  console.info("[CreatorFees claim-signing-v3] after-wallet", {
    messageUnchanged: message === plan.message,
    walletGuards: check.ok ? check.guards : null,
    blockhashUnchanged: signed.recentBlockhash === reviewed.recentBlockhash,
    feePayerUnchanged: actual.accountKeys[0].equals(reviewed.accountKeys[0]),
    instructionCountUnchanged:
      actual.instructions.length === reviewed.instructions.length,
    missingSignatures,
    signaturesValid,
  });
  if (missingSignatures !== 0 || !signed.signature)
    throw Error(
      "[CLAIM_SIGNATURE_MISSING] Phantom returned a missing required signature. No transaction was sent by this launcher.",
    );
  if (!signaturesValid)
    throw Error(
      "[CLAIM_SIGNATURE_INVALID] Phantom returned a cryptographically invalid signature. No transaction was sent by this launcher.",
    );
  const budget = (m: Message) =>
    m.instructions
      .filter((ix) =>
        m.accountKeys[ix.programIdIndex].equals(ComputeBudgetProgram.programId),
      )
      .map((ix) => ix.data)
      .join(",");
  const differences =
    [
      signed.recentBlockhash !== reviewed.recentBlockhash ? "blockhash" : "",
      !actual.accountKeys[0].equals(reviewed.accountKeys[0]) ? "fee payer" : "",
      budget(reviewed) !== budget(actual)
        ? "compute budget / priority fee"
        : "",
    ]
      .filter(Boolean)
      .join(", ") || (check.ok ? "" : check.reason);
  const r: ClaimRecord = {
    network: plan.view.network,
    wallet: plan.wallet,
    pool: plan.view.pool,
    signature: bs58.encode(signed.signature),
    lastValidBlockHeight: plan.lastValidBlockHeight,
    expiryKnown: signed.recentBlockhash === reviewed.recentBlockhash,
    reviewedFee: plan.fee.toString(),
    state: "pending",
    ...(changed
      ? {
          signingIssue: `Wallet changed ${differences}; launcher did not broadcast it`,
        }
      : {}),
  };
  const previous = claimRecord(storage, r.network, r.wallet);
  if (previous?.signature === r.signature && previous.state !== "expired")
    throw Error(
      "This signed claim was already recorded or processed. Check its signature; it will not be sent again.",
    );
  saveClaim(storage, r); // Preserve a valid returned signature even if later validation/RPC fails.
  const estimate = await estimateMessageFee(c, signed);
  if (estimate !== null) {
    r.signedFee = lamports(estimate).toString();
    saveClaim(storage, r);
  }
  if (changed)
    throw Error(
      `[CLAIM_MESSAGE_CHANGED] Phantom changed the reviewed transaction message: ${differences}. Its valid signature was saved for read-only status checks. No transaction was sent by this launcher.`,
    );
  if (!signed.feePayer?.equals(wallet))
    throw Error("Claim fee payer differs from the reviewed creator");
  if (estimate === null)
    throw Error(
      "Signed claim fee could not be verified; signature saved, launcher did not send",
    );
  if (BigInt(r.signedFee!) !== plan.fee)
    throw Error(
      "Signed transaction fee differs from review; signature saved, launcher did not send. Check status before a new review.",
    );
  return { signed, record: r };
}
export async function executeCreatorClaim(
  c: Connection,
  plan: ClaimPlan,
  wallet: PublicKey,
  sign: (tx: Transaction) => Promise<Transaction>,
  storage: Store,
) {
  if (plan.view.network === "mainnet-beta") assertMainnetTransactionsEnabled();
  if (plan.wallet !== wallet.toBase58())
    throw Error("Wallet changed; review the claim again");
  assertNoPendingClaim(storage, plan.view.network, plan.wallet);
  if (
    Buffer.from(plan.tx.serializeMessage()).toString("base64") !== plan.message
  )
    throw Error("Claim changed after review");
  const latest = await readCreatorFees(c, plan.view.network, plan.view.pool);
  assertClaimAuthority(latest, wallet);
  if (
    latest.config !== plan.view.config ||
    latest.mint !== plan.view.mint ||
    latest.base < plan.view.base ||
    latest.quote < plan.view.quote
  )
    throw Error("Fee accounts or balances changed; refresh and review again");
  if ((await c.getBlockHeight("confirmed")) > plan.lastValidBlockHeight)
    throw Error("Blockhash expired; prepare a new review before signing");
  const wrappedAddress = new PublicKey(plan.destinations[1]);
  const wrappedInfo = await c.getAccountInfo(wrappedAddress, "confirmed");
  const wrappedAmount =
    plan.view.quoteMint === NATIVE_MINT.toBase58() && wrappedInfo
      ? unpackAccount(wrappedAddress, wrappedInfo, TOKEN_PROGRAM_ID).amount
      : 0n;
  if (wrappedAmount !== plan.existingWrappedSol)
    throw Error(
      "Existing WSOL changed; refresh and review its unwrapping again",
    );
  if (lamports(await c.getBalance(wallet)) < plan.fee + plan.rent)
    throw Error("Insufficient SOL for fees and account creation");
  await simulateReviewedTransaction(c, plan.tx, false);
  const { signed, record: r } = await signCreatorClaim(
    c,
    plan,
    wallet,
    sign,
    storage,
  );
  await simulateReviewedTransaction(c, signed, true);
  saveClaim(storage, r); // Fail closed before any send; public signature survives timeout/refresh.
  const sent = await c.sendRawTransaction(signed.serialize(), {
    skipPreflight: false,
    preflightCommitment: "confirmed",
    maxRetries: 0,
  });
  if (sent !== r.signature)
    throw Error("RPC signature differs; inspect the saved claim");
  await pollConfirmation(c, r.signature, r.lastValidBlockHeight);
  // Confirmed on-chain: persist that before any refresh, so a later read failure cannot mask the success.
  const confirmed: ClaimRecord = { ...r, state: "confirmed" };
  saveClaim(storage, confirmed);
  return refreshClaim(c, storage, confirmed);
}
const poolsKey = (n: Network, w: string) => `dbc-creator-pools-v1:${n}:${w}`;
export function rememberCreatorPool(
  storage: Store,
  network: Network,
  wallet: string,
  pool: string,
) {
  new PublicKey(pool);
  const list = knownCreatorPools(storage, network, wallet);
  storage.setItem(
    poolsKey(network, wallet),
    JSON.stringify([...new Set([...list, pool])].slice(-100)),
  );
}
export function knownCreatorPools(
  storage: Pick<Storage, "getItem">,
  network: Network,
  wallet: string,
) {
  const entries = JSON.parse(
    storage.getItem(poolsKey(network, wallet)) || "[]",
  );
  if (!Array.isArray(entries) || entries.length > 100)
    throw Error("Invalid saved pool list");
  const pools = entries.map((p: string) => new PublicKey(p).toBase58());
  // Backfill earlier verified launches from their public closed recovery record.
  const raw = storage.getItem(`dbc-recovery-v1:${network}:${wallet}`);
  if (raw) {
    const r = JSON.parse(raw);
    if (r.network === network && r.creator === wallet && r.state === "closed")
      pools.push(new PublicKey(r.pool).toBase58());
  }
  return [...new Set(pools)] as string[]; // All candidates must still pass on-chain verification.
}
