import { quoteAsset, verifyHypeMint, requireHypeFunding } from "./quote-assets";
import { totalCost } from "./costs";
import { assertAppNetwork, assertMainnetTransactionsEnabled, APP_RPC_PATH, expectedGenesis } from "./app-network";
import { withRpcRetry } from "./rpc-retry";
import { verifyMetadataBytes } from "./metadata";
import { Buffer } from "buffer";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  ComputeBudgetProgram,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  NATIVE_MINT,
  getMint,
  getAssociatedTokenAddress,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  DynamicBondingCurveClient,
  deriveDbcPoolAddress,
  deriveDbcPoolAuthority,
  getQuoteFromInputAmount,
  type ConfigParameters,
  type PoolConfig,
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
  METAPLEX_PROGRAM_ID,
  PROTOCOL_FEE_PERCENT,
  PROTOCOL_LIQUIDITY_MIGRATION_FEE_BPS,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import BN from "bn.js";
import { curve, distributorCurve, units, bps, type Inputs } from "./config";
import { allocationFromShare, type Allocation } from "./hymet-policy";
import { createDistributorPool, distributorAddresses, verifyDistributorDeployment, verifyDistributorPool } from "./distributor-engine";
export type Network = "devnet" | "mainnet-beta";
export const protocolDisclosure = {
  tradingFeePercent: PROTOCOL_FEE_PERCENT,
  migrationFeeBps: PROTOCOL_LIQUIDITY_MIGRATION_FEE_BPS,
  program: DYNAMIC_BONDING_CURVE_PROGRAM_ID.toBase58(),
  poolAuthority: deriveDbcPoolAuthority().toBase58(),
};
export type Step = {
  label: string;
  tx: Transaction;
  signers: Keypair[];
  signature?: string;
  phase?:
    | "unsigned"
    | "awaiting-signature"
    | "signed"
    | "broadcasting"
    | "submitted"
    | "confirmed";
  done?: boolean;
  estimatedFee?: bigint;
  lastValidBlockHeight?: number;
  simulationUnits?: number | null;
};
export type Plan = {
  distributorProgramId?: string;
  costPreview?: import("./launch-costs").LaunchCostPreview;
  values: Inputs;
  /** Exact split derived from values.creatorShare; also bound on-chain in the distributor fee pool. */
  allocation: Allocation;
  network: Network;
  creator: PublicKey;
  mint: Keypair;
  config: PublicKey;
  pool: PublicKey;
  steps: Step[];
  fee: bigint;
  rent: bigint;
  configRent: bigint;
  poolFee: bigint;
  buy: bigint;
  total: bigint;
  balance: bigint;
  quoteBalance?: bigint;
  threshold: string;
  recipients: { partner: string; leftover: string };
  uri: string;
  artworkUri?: string;
  reservationId?: string;
  configParams: ConfigParameters;
};
export type VerificationPlan = Pick<
  Plan,
  | "values"
  | "network"
  | "creator"
  | "config"
  | "pool"
  | "buy"
  | "configParams"
  | "recipients"
  | "uri"
> & {
  distributorProgramId?: string;
  mint: Pick<Keypair, "publicKey">;
  steps: Pick<Step, "signature" | "done">[];
};
export function assertCreatorRecipients(
  creator: PublicKey,
  partner: PublicKey,
  leftover: PublicKey,
) {
  if (!partner.equals(creator) || !leftover.equals(creator))
    throw Error(
      "This config sends partner fees or leftovers to another wallet. Create or reuse a config that uses your creator wallet for both recipients.",
    );
}
export function configuredPlatformFeeRecipient() {
  const raw =
    process.env.HYMET_PLATFORM_FEE_RECIPIENT ??
    process.env.NEXT_PUBLIC_HYMET_PLATFORM_FEE_RECIPIENT;
  if (!raw)
    throw Error(
      "HYMET_PLATFORM_FEE_RECIPIENT is not configured; launch transaction construction is disabled until the platform fee recipient is set.",
    );
  try {
    return new PublicKey(raw);
  } catch {
    throw Error("HYMET_PLATFORM_FEE_RECIPIENT is not a valid Solana address");
  }
}
export function assertFeeRecipients(
  platform: PublicKey,
  creator: PublicKey,
  partner: PublicKey,
  leftover: PublicKey,
) {
  if (platform.equals(creator))
    throw Error(
      "HYMET platform fee recipient must be a different wallet from the token creator.",
    );
  if (!partner.equals(platform))
    throw Error(
      "DBC partner fees must route to HYMET_PLATFORM_FEE_RECIPIENT; creator routing is not accepted.",
    );
  if (!leftover.equals(creator))
    throw Error(
      "DBC leftover tokens must route to the creator wallet.",
    );
}
export function connection(network: Network) {
  assertAppNetwork(network);
  return new Connection(`${window.location.origin}${APP_RPC_PATH}`, {
    commitment: "confirmed",
    disableRetryOnRateLimit: true,
    confirmTransactionInitialTimeout: 45000,
  });
}
export async function checkNetwork(c: Connection, network: Network) {
  const hash = await c.getGenesisHash();
  const expected =
    network === "devnet"
      ? "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"
      : expectedGenesis();
  if (hash !== expected)
    throw Error("RPC genesis does not match the selected network");
  const p = await c.getAccountInfo(DYNAMIC_BONDING_CURVE_PROGRAM_ID);
  if (!p?.executable)
    throw Error("Meteora DBC program is unavailable on this RPC");
}
// Load-balanced RPCs can route the fee read to a node that has not yet confirmed the
// blockhash and return null. "processed" sees every blockhash a confirmed read can return,
// so query there; still fail closed on null.
export async function estimateMessageFee(
  c: Connection,
  tx: Transaction,
): Promise<number | null> {
  return (await c.getFeeForMessage(tx.compileMessage(), "processed")).value;
}
export function assertSigners(
  tx: Transaction,
  payer: PublicKey,
  keys: Keypair[],
) {
  const msg = tx.compileMessage();
  const required = msg.accountKeys.slice(0, msg.header.numRequiredSignatures);
  for (const k of required)
    if (!k.equals(payer) && !keys.some((s) => s.publicKey.equals(k)))
      throw Error(`Missing local signer: ${k.toBase58()}`);
  for (const k of keys)
    if (!required.some((s) => s.equals(k.publicKey)))
      throw Error("Unexpected local signer");
}
export function compatible(
  actual: PoolConfig,
  expected: ConfigParameters,
  quoteMint = NATIVE_MINT,
) {
  if (
    !actual.quoteMint.equals(quoteMint) ||
    actual.tokenType !== 0 ||
    actual.tokenDecimal !== expected.tokenDecimal ||
    actual.tokenUpdateAuthority !== 1 ||
    actual.migrationOption !== 1 ||
    actual.transferFeeFlag !== 0
  )
    throw Error(
      "Reusable config is incompatible with SOL / SPL / immutable / DAMM V2",
    );
  const pairs: [unknown, unknown, string][] = [
    [actual.collectFeeMode, expected.collectFeeMode, "fee collection"],
    [actual.activationType, expected.activationType, "activation"],
    [
      actual.creatorTradingFeePercentage,
      expected.creatorTradingFeePercentage,
      "creator share",
    ],
    [
      actual.migrationFeeOption,
      expected.migrationFeeOption,
      "migration fee option",
    ],
    [
      actual.migrationQuoteThreshold,
      expected.migrationQuoteThreshold,
      "migration reserve",
    ],
    [actual.sqrtStartPrice, expected.sqrtStartPrice, "start price"],
    [actual.poolCreationFee, expected.poolCreationFee, "pool creation fee"],
    [
      actual.preMigrationTokenSupply,
      expected.tokenSupply?.preMigrationTokenSupply,
      "pre-migration supply",
    ],
    [
      actual.postMigrationTokenSupply,
      expected.tokenSupply?.postMigrationTokenSupply,
      "post-migration supply",
    ],
    [
      actual.migrationFeePercentage,
      expected.migrationFee.feePercentage,
      "migration fee",
    ],
    [
      actual.creatorMigrationFeePercentage,
      expected.migrationFee.creatorFeePercentage,
      "migration creator share",
    ],
    [
      actual.migratedCollectFeeMode,
      expected.migratedPoolFee.collectFeeMode,
      "migrated fee collection",
    ],
    [
      actual.migratedDynamicFee,
      expected.migratedPoolFee.dynamicFee,
      "migrated dynamic fee",
    ],
    [
      actual.migratedPoolFeeBps,
      expected.migratedPoolFee.poolFeeBps,
      "migrated pool fee",
    ],
    [
      actual.creatorPermanentLockedLiquidityPercentage,
      expected.creatorPermanentLockedLiquidityPercentage,
      "creator locked LP",
    ],
    [actual.creatorLiquidityPercentage, expected.creatorLiquidityPercentage, "creator LP"],
    [actual.partnerLiquidityPercentage, expected.partnerLiquidityPercentage, "partner LP"],
    [actual.partnerPermanentLockedLiquidityPercentage, expected.partnerPermanentLockedLiquidityPercentage, "partner locked LP"],
    [actual.enableFirstSwapWithMinFee, 0, "first swap fee"],
    [actual.migratedPoolBaseFeeMode, 0, "migrated fee mode"],
    [actual.migratedCompoundingFeeBps, 0, "compounding fee"],
    [actual.fixedTokenSupplyFlag, 1, "fixed supply"],
    [actual.lockedVestingConfig.amountPerPeriod, 0, "vesting amount"],
    [actual.lockedVestingConfig.cliffUnlockAmount, 0, "vesting cliff amount"],
    [
      actual.partnerLiquidityVestingInfo.vestingPercentage,
      0,
      "partner vesting",
    ],
    [
      actual.creatorLiquidityVestingInfo.vestingPercentage,
      0,
      "creator vesting",
    ],
  ];
  for (const [a, b, name] of pairs)
    if (String(a) !== String(b))
      throw Error(
        `Reusable config differs in ${name}. Match its settings or create a new config.`,
      );
  const active = actual.curve.filter((c) => !c.liquidity.isZero());
  if (
    active.length !== expected.curve.length ||
    active.some(
      (c, i) =>
        !c.sqrtPrice.eq(expected.curve[i].sqrtPrice) ||
        !c.liquidity.eq(expected.curve[i].liquidity),
    )
  )
    throw Error("Reusable curve differs from requested curve");
  if (
    !actual.poolFees.baseFee.cliffFeeNumerator.eq(
      expected.poolFees.baseFee.cliffFeeNumerator,
    ) ||
    actual.poolFees.baseFee.firstFactor !== 0 ||
    !actual.poolFees.baseFee.secondFactor.isZero() ||
    !actual.poolFees.baseFee.thirdFactor.isZero() ||
    actual.poolFees.dynamicFee.initialized !== 0
  )
    throw Error(
      "Reusable config fee schedule differs from requested constant fee",
    );
}
export async function buildPlan(
  c: Connection,
  v: Inputs,
  creator: PublicKey,
  network: Network,
  uri: string,
  distributorProgramId?: string,
): Promise<Plan> {
  const allocation = allocationFromShare(v.creatorShare);
  if (allocation.holderBpsOfRemaining !== 0 && !distributorProgramId)
    throw Error(
      "This creator/holder split requires the HYMET on-chain reward distributor. Until that program is deployed and verified, only the 100% creator / 0% holder allocation can be constructed.",
    );
  const platformRecipient = configuredPlatformFeeRecipient();
  await checkNetwork(c, network);
  const distributorProgram = distributorProgramId ? new PublicKey(distributorProgramId) : undefined;
  if (distributorProgram) {
    if (v.reuse) throw Error("Distributor launches require a dedicated DBC configuration");
    await verifyDistributorDeployment(c, distributorProgram, platformRecipient);
  }
  const sdk = new DynamicBondingCurveClient(c, "confirmed"),
    params = distributorProgram ? distributorCurve(v, creator) : curve(v, creator);
  const quote = quoteAsset(v);
  if (!quote.native) await verifyHypeMint(c);
  const buy = units(v.buy, quote.decimals);
  const quoteBalance = quote.native
    ? undefined
    : buy > 0n
      ? await requireHypeFunding(c, creator, buy)
      : 0n;
  const mint = Keypair.generate(),
    newConfig = Keypair.generate(),
    config = v.reuse ? new PublicKey(v.reuse) : newConfig.publicKey;
  const feeClaimer = distributorProgram ? distributorAddresses(distributorProgram, mint.publicKey).feePool : platformRecipient;
  let recipients = {
    partner: feeClaimer.toBase58(),
    leftover: creator.toBase58(),
  };
  let poolFee = 0n;
  if (v.reuse) {
    const actual = await sdk.state.getPoolConfig(config);
    if (!actual) throw Error("Reusable config does not exist");
    compatible(actual, params, quote.mint);
    assertFeeRecipients(
      platformRecipient,
      creator,
      actual.feeClaimer,
      actual.leftoverReceiver,
    );
    recipients = {
      partner: actual.feeClaimer.toBase58(),
      leftover: actual.leftoverReceiver.toBase58(),
    };
    poolFee = BigInt(actual.poolCreationFee.toString());
  }
  const firstBuyParam =
    buy > 0n
      ? {
          buyer: creator,
          buyAmount: new BN(buy.toString()),
          minimumAmountOut:
            getQuoteFromInputAmount({
              config: params,
              swapBaseForQuote: false,
              amountIn: new BN(buy.toString()),
              slippageBps: bps(v.slippage),
              hasReferral: false,
              eligibleForFirstSwapWithMinFee: false,
            }).minimumAmountOut ??
            (() => {
              throw Error("SDK did not provide protected minimum output");
            })(),
          referralTokenAccount: null,
        }
      : undefined;
  if (firstBuyParam?.minimumAmountOut.isZero())
    throw Error("Initial buy is too small to protect with minimum output");
  if (buy >= BigInt(params.migrationQuoteThreshold.toString()))
    throw Error(
      "Initial buy must remain below the migration quote reserve threshold",
    );
  const pre = {
    baseMint: mint.publicKey,
    name: v.name,
    symbol: v.symbol,
    uri,
    poolCreator: creator,
  };
  let steps: Step[];
  if (v.reuse) {
    const tx = firstBuyParam
      ? await sdk.creator.createPoolWithFirstBuy({
          createPoolParam: { ...pre, config, payer: creator },
          firstBuyParam,
        })
      : await sdk.creator.createPool({ ...pre, config, payer: creator });
    steps = [
      {
        label: firstBuyParam
          ? "Create pool + initial buy"
          : "Create token + pool",
        tx,
        signers: [mint],
      },
    ];
  } else {
    const txs = await sdk.partner.createConfigAndPoolWithFirstBuy({
      ...params,
      config,
      feeClaimer,
      leftoverReceiver: creator,
      quoteMint: quote.mint,
      payer: creator,
      preCreatePoolParam: pre,
      firstBuyParam,
    });
    steps = [
      {
        label: "Create custom DBC config",
        tx: txs.createConfigTx,
        signers: [newConfig],
      },
      {
        label: firstBuyParam
          ? "Create token + pool + initial buy"
          : "Create token + pool",
        tx: txs.createPoolWithFirstBuyTx,
        signers: [mint],
      },
    ];
  }
  if (distributorProgram) steps[steps.length - 1].tx.add(createDistributorPool(distributorProgram, mint.publicKey, creator, deriveDbcPoolAddress(quote.mint, mint.publicKey, config), bps(v.creatorShare)));
  const latest = await c.getLatestBlockhash();
  let fee = 0n;
  for (const s of steps) {
    s.tx.instructions.unshift(
      ComputeBudgetProgram.setComputeUnitLimit({ units: LAUNCH_COMPUTE_UNITS }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: LAUNCH_PRIORITY_MICROLAMPORTS }),
    );
    s.tx.feePayer = creator;
    s.tx.recentBlockhash = latest.blockhash;
    assertSigners(s.tx, creator, s.signers);
    if (
      s.tx.serialize({ requireAllSignatures: false, verifySignatures: false })
        .length > 1232
    )
      throw Error(
        `${s.label} exceeds 1232 bytes; reduce metadata lengths. Launch blocked.`,
      );
    const f = await estimateMessageFee(c, s.tx);
    if (f === null) throw Error("RPC could not estimate network fees");
    if (!Number.isSafeInteger(f) || f < 0)
      throw Error("Invalid RPC fee estimate");
    s.estimatedFee = BigInt(f);
    fee += BigInt(f);
  }
  // SDK IDL sizes for program accounts; metadata/temporary accounts retain headroom.
  const rentCache = new Map<number, bigint>();
  const rentFor = async (size: number) => {
    if (rentCache.has(size)) return rentCache.get(size)!;
    const amount = await c.getMinimumBalanceForRentExemption(size);
    if (!Number.isSafeInteger(amount) || amount < 0)
      throw Error("Invalid RPC rent estimate");
    rentCache.set(size, BigInt(amount));
    return BigInt(amount);
  };
  const configRent = v.reuse
    ? 0n
    : await rentFor(sdk.program.account.poolConfig.size);
  let rent =
    configRent +
    (await rentFor(sdk.program.account.virtualPool.size)) +
    (await rentFor(82)) +
    (await rentFor(1024)) +
    2n * (await rentFor(165));
  if (buy > 0n) rent += (quote.native ? 2n : 1n) * (await rentFor(165));
  if (distributorProgram) rent += (await rentFor(195)) + 2n * (await rentFor(165));
  const rawBalance = await c.getBalance(creator);
  if (!Number.isSafeInteger(rawBalance) || rawBalance < 0)
    throw Error("RPC balance cannot be represented safely");
  const balance = BigInt(rawBalance);
  const total = totalCost({
    network: fee,
    rent,
    poolCreation: poolFee,
    initialBuy: quote.native ? buy : 0n,
  });
  return {
    distributorProgramId,
    values: { ...v },
    allocation,
    network,
    creator,
    mint,
    config,
    pool: deriveDbcPoolAddress(quote.mint, mint.publicKey, config),
    steps,
    fee,
    rent,
    configRent,
    poolFee,
    buy,
    total,
    balance,
    quoteBalance,
    threshold: params.migrationQuoteThreshold.toString(),
    recipients,
    uri,
    configParams: params,
  };
}
export type SignTransaction = (tx: Transaction) => Promise<Transaction>;
export function remainingRequirement(p: Plan) {
  if (p.steps.every((s) => s.done)) return 0n;
  const configDone = !p.values.reuse && p.steps.length === 2 && p.steps[0].done;
  const network = p.steps
    .filter((s) => !s.done)
    .reduce((n, s) => n + (s.estimatedFee ?? p.fee), 0n);
  return (
    network +
    p.rent -
    (configDone ? p.configRent : 0n) +
    p.poolFee +
    (quoteAsset(p.values).native ? p.buy : 0n)
  );
}
/** Phantom inserts its own priority-fee instruction into a transaction that sets no compute-unit price, which changes
 *  the reviewed message, and signReviewedTransaction then (correctly) refuses it. An explicit price keeps the message
 *  exactly as reviewed. 20,000 micro-lamports x 1,000,000 units adds at most 20,000 lamports per launch step; the fee
 *  estimate shown before signing includes it. */
export const LAUNCH_COMPUTE_UNITS = 1_000_000;
export const LAUNCH_PRIORITY_MICROLAMPORTS = 20_000;
/** The same explicit price for swaps and fee claims: a price of 0 is not treated as set. At 300,000-400,000 units it adds
 *  at most 6,000-8,000 lamports, included in the fee shown before signing. */
export const WALLET_PRIORITY_MICROLAMPORTS = 20_000;
export async function signReviewedTransaction(
  tx: Transaction,
  payer: PublicKey,
  keys: Keypair[],
  sign: SignTransaction,
) {
  assertSigners(tx, payer, keys);
  tx.partialSign(...keys);
  const before = Buffer.from(tx.serializeMessage());
  const signed = await sign(tx);
  if (!before.equals(signed.serializeMessage()))
    throw Error("Wallet changed the reviewed transaction message");
  for (const key of keys) {
    const sig = signed.signatures.find((s) =>
      s.publicKey.equals(key.publicKey),
    );
    if (!sig?.signature) signed.partialSign(key);
  }
  if (!signed.verifySignatures())
    throw Error("Wallet or temporary account signature is missing or invalid");
  return signed;
}
export async function simulateReviewedTransaction(
  c: Connection,
  tx: Transaction,
  signed: boolean,
  payer?: PublicKey,
  inspectedAccounts?: PublicKey[],
) {
  // Deserialize exactly the bytes we will broadcast for the signature-verifying pass.
  const transaction = signed
    ? VersionedTransaction.deserialize(tx.serialize())
    : new VersionedTransaction(tx.compileMessage());
  const simulation = await c.simulateTransaction(transaction, {
    sigVerify: signed,
    commitment: "confirmed",
    ...(payer
      ? {
          accounts: {
            encoding: "base64" as const,
            addresses: (inspectedAccounts || [payer]).map((k) => k.toBase58()),
          },
        }
      : {}),
  });
  if (simulation.value.err)
    throw Error(
      `${signed ? "Signed" : "Unsigned"} simulation failed: ${JSON.stringify(simulation.value.err)}. ${simulation.value.logs?.slice(-4).join(" ")}`,
    );
  return simulation.value;
}
export async function verifyConfig(c: Connection, p: VerificationPlan) {
  const account = await c.getAccountInfo(p.config, "confirmed");
  if (!account || !account.owner.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID))
    throw Error("Config account is not owned by the DBC program");
  const cfg = await new DynamicBondingCurveClient(
    c,
    "confirmed",
  ).state.getPoolConfig(p.config);
  if (!cfg) throw Error("Config creation could not be verified");
  compatible(cfg, p.configParams, quoteAsset(p.values).mint);
  if (p.distributorProgramId) {
    const program = new PublicKey(p.distributorProgramId);
    await verifyDistributorDeployment(c, program, configuredPlatformFeeRecipient());
    const a = distributorAddresses(program, p.mint.publicKey);
    if (!cfg.feeClaimer.equals(a.feePool) || !cfg.leftoverReceiver.equals(p.creator)) throw Error("Distributor fee recipient differs from reviewed pool");
  } else assertFeeRecipients(
    configuredPlatformFeeRecipient(),
    p.creator,
    cfg.feeClaimer,
    cfg.leftoverReceiver,
  );
  if (
    cfg.feeClaimer.toBase58() !== p.recipients.partner ||
    cfg.leftoverReceiver.toBase58() !== p.recipients.leftover
  )
    throw Error("Config recipients differ from reviewed addresses");
}
export async function inspectSignature(c: Connection, s: Partial<Step>) {
  s.done = false;
  if (!s.signature) return "unsigned";
  const r = (
    await c.getSignatureStatuses([s.signature], {
      searchTransactionHistory: true,
    })
  ).value[0];
  if (r?.err)
    throw Error(`Transaction failed on-chain: ${JSON.stringify(r.err)}`);
  if (
    r?.confirmationStatus === "confirmed" ||
    r?.confirmationStatus === "finalized"
  ) {
    s.done = true;
    return "confirmed";
  }
  return "uncertain";
}
export async function execute(
  c: Connection,
  p: Plan,
  sign: SignTransaction,
  status: (s: string) => void,
  checkpoint?: (p: Plan) => void,
) {
  if (p.network === "mainnet-beta") assertMainnetTransactionsEnabled();
  for (const s of p.steps) if (!s.phase && !s.signature) s.phase = "unsigned";
  checkpoint?.(p);
  await checkNetwork(c, p.network);
  for (const s of p.steps) {
    if (s.signature) {
      if ((await inspectSignature(c, s)) === "confirmed") continue;
      throw Error(
        "Recovery required: a broadcast transaction has uncertain status. No replacement was sent.",
      );
    }
    if (s.phase === "awaiting-signature")
      throw Error(
        "Recovery required: wallet approval completion is unknown. Check recovery before retrying.",
      );
    // This must also run after recovery skips an already-confirmed config step.
    if (s.signers.some((key) => key.publicKey.equals(p.mint.publicKey)))
      await verifyConfig(c, p);
    status(`Building transactions · ${s.label}`);
    if (!quoteAsset(p.values).native && p.buy > 0n)
      await requireHypeFunding(c, p.creator, p.buy);
    const currentBalance = await c.getBalance(p.creator);
    if (!Number.isSafeInteger(currentBalance) || currentBalance < 0)
      throw Error("RPC balance cannot be represented safely");
    if (BigInt(currentBalance) < remainingRequirement(p))
      throw Error("Insufficient SOL for the conservative launch estimate");
    const block = await c.getLatestBlockhash();
    s.tx.feePayer = p.creator;
    s.tx.recentBlockhash = block.blockhash;
    s.lastValidBlockHeight = block.lastValidBlockHeight;
    assertSigners(s.tx, p.creator, s.signers);
    const simulated = await simulateReviewedTransaction(c, s.tx, false);
    s.simulationUnits = simulated.unitsConsumed ?? null;
    s.phase = "awaiting-signature";
    checkpoint?.(p);
    status(`Awaiting wallet approval · ${s.label}`);
    const signed = await signReviewedTransaction(
      s.tx,
      p.creator,
      s.signers,
      sign,
    );
    const raw = signed.serialize();
    const signature = signed.signature;
    if (!signature) throw Error("Missing payer signature"); // Save signature BEFORE broadcast, including ambiguous transport failures.
    const bs58 = (await import("bs58")).default;
    s.signature = bs58.encode(signature);
    s.phase = "signed";
    checkpoint?.(p);
    status(`Signed, not broadcast · ${s.label}`);
    await simulateReviewedTransaction(c, signed, true);
    s.phase = "broadcasting";
    checkpoint?.(p); // Persist public recovery data BEFORE any potentially ambiguous send.
    status(`Broadcasting transaction · ${s.label}`);
    const sent = await c.sendRawTransaction(raw, {
      skipPreflight: false,
      preflightCommitment: "confirmed",
      maxRetries: 0,
    });
    if (sent !== s.signature)
      throw Error("RPC returned a different transaction signature");
    s.phase = "submitted";
    checkpoint?.(p);
    status(`Confirming transaction · ${s.label}`);
    await pollConfirmation(c, s.signature, block.lastValidBlockHeight);
    s.done = true;
    s.phase = "confirmed";
    checkpoint?.(p);
  }
  status("Verifying token and pool");
  return verifyLaunch(c, p);
}
export type ConfirmationState = "confirmed" | "failed" | "expired" | "unresolved";
/**
 * HTTP-only confirmation (no WebSocket; the app RPC proxy is HTTP). Never resends.
 * - confirmed/failed: from getSignatureStatuses (with history).
 * - expired: the FINALIZED block height passed lastValidBlockHeight and a final status check finds
 *   nothing, so the transaction can never land and a new one is safe.
 * - unresolved: still valid when maxWaitMs elapsed; the caller must keep the signature and not resubmit.
 */
export async function awaitSignature(
  c: Connection,
  signature: string,
  lastValidBlockHeight: number,
  {
    intervalMs = 1500,
    maxWaitMs = 150_000,
    sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    rebroadcast,
  }: {
    intervalMs?: number;
    maxWaitMs?: number;
    sleep?: (ms: number) => Promise<void>;
    /** Re-sends the same signed bytes while the signature is unseen (same signature: it can land at most once). */
    rebroadcast?: () => Promise<unknown>;
  } = {},
): Promise<{ state: ConfirmationState; error?: unknown }> {
  // Transient RPC failures (e.g. public-endpoint 429) are retried with backoff; they never decide the outcome.
  const retry = { sleep };
  const status = async () =>
    (await withRpcRetry(() => c.getSignatureStatuses([signature], { searchTransactionHistory: true }), retry)).value[0];
  const settled = (st: Awaited<ReturnType<typeof status>>) =>
    st?.err
      ? ({ state: "failed", error: st.err } as const)
      : st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized"
        ? ({ state: "confirmed" } as const)
        : null;
  for (let waited = 0; ; waited += intervalMs) {
    const st = await status();
    const done = settled(st);
    if (done) return done;
    if (!st && (await withRpcRetry(() => c.getBlockHeight("finalized"), retry)) > lastValidBlockHeight) {
      // It may have landed in the last valid blocks after the previous read.
      const last = await status();
      const late = settled(last);
      if (late) return late;
      if (!last) return { state: "expired" };
    }
    if (waited >= maxWaitMs) return { state: "unresolved" };
    if (!st && rebroadcast) await rebroadcast().catch(() => undefined);
    await sleep(intervalMs);
  }
}
export async function pollConfirmation(
  c: Connection,
  signature: string,
  lastValidBlockHeight: number,
) {
  const result = await awaitSignature(c, signature, lastValidBlockHeight);
  if (result.state === "failed")
    throw Error(`On-chain failure: ${JSON.stringify(result.error)}`);
  if (result.state === "expired")
    throw Error("Blockhash expired; the transaction did not land and can be prepared again");
  if (result.state === "unresolved")
    throw Error(`Confirmation unresolved; recovery required. Do not resubmit until ${signature} is confirmed or its blockhash expires`);
}
export async function verifyLaunch(c: Connection, p: VerificationPlan) {
  for (const s of p.steps)
    if ((await inspectSignature(c, s)) !== "confirmed")
      throw Error("Transaction confirmation remains uncertain");
  const owners = await c.getMultipleAccountsInfo([p.pool, p.config]);
  if (
    owners.some((a) => !a || !a.owner.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID))
  )
    throw Error("Pool or config owner is not the DBC program");
  const sdk = new DynamicBondingCurveClient(c, "confirmed");
  const [pool, config, mint] = await Promise.all([
    sdk.state.getPool(p.pool),
    sdk.state.getPoolConfig(p.config),
    getMint(c, p.mint.publicKey, "confirmed", TOKEN_PROGRAM_ID),
  ]);
  if (!pool || !config) throw Error("Token or DBC pool could not be verified");
  if (
    !pool.poolState.baseMint.equals(p.mint.publicKey) ||
    !pool.poolState.config.equals(p.config) ||
    !pool.poolState.creator.equals(p.creator)
  )
    throw Error("Pool account does not match launch");
  if (
    mint.decimals !== Number(p.values.decimals) ||
    mint.supply !== units(p.values.supply, Number(p.values.decimals)) ||
    mint.mintAuthority !== null ||
    mint.freezeAuthority !== null
  )
    throw Error("Mint decimals or revoked authorities could not be verified");
  compatible(config, p.configParams, quoteAsset(p.values).mint);
  if (p.distributorProgramId) {
    const program = new PublicKey(p.distributorProgramId);
    await verifyDistributorDeployment(c, program, configuredPlatformFeeRecipient());
    const a = await verifyDistributorPool(c, program, p.mint.publicKey, p.creator, p.pool, bps(p.values.creatorShare));
    if (!config.feeClaimer.equals(a.feePool) || !config.leftoverReceiver.equals(p.creator)) throw Error("Distributor fee recipient differs from reviewed pool");
  } else assertFeeRecipients(
    configuredPlatformFeeRecipient(),
    p.creator,
    config.feeClaimer,
    config.leftoverReceiver,
  );
  if (
    config.feeClaimer.toBase58() !== p.recipients.partner ||
    config.leftoverReceiver.toBase58() !== p.recipients.leftover
  )
    throw Error("Config recipients differ from reviewed addresses");
  const [metadataAddress] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("metadata"),
      METAPLEX_PROGRAM_ID.toBuffer(),
      p.mint.publicKey.toBuffer(),
    ],
    METAPLEX_PROGRAM_ID,
  );
  const metadata = await c.getAccountInfo(metadataAddress, "confirmed");
  if (!metadata || !metadata.owner.equals(METAPLEX_PROGRAM_ID))
    throw Error("Metaplex metadata account not found");
  verifyMetadataBytes(
    metadata.data,
    p.mint.publicKey,
    p.values.name,
    p.values.symbol,
    p.uri,
  );
  if (p.buy > 0n) {
    const account = await getAccount(
      c,
      await getAssociatedTokenAddress(p.mint.publicKey, p.creator),
    );
    if (account.amount === 0n || !pool.poolState.hasSwap)
      throw Error("Initial buy output could not be verified");
  }
  return {
    status: pool.poolState.isMigrated ? "Migrated" : "Bonding curve active",
    supply: mint.supply.toString(),
  };
}
export function sol(n: bigint) {
  return `${n / 1000000000n}.${(n % 1000000000n).toString().padStart(9, "0")}`;
}
