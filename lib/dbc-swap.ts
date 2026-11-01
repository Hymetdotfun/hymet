// HYPE <-> token swaps on a verified HYMET Meteora DBC pool (before graduation). Builds an unsigned transaction
// for Phantom; executeWalletOperation performs the signed simulation, broadcast, HTTP confirmation and journaling.
import { Connection, PublicKey, ComputeBudgetProgram, SYSVAR_CLOCK_PUBKEY, type Transaction } from "@solana/web3.js";
import { DynamicBondingCurveClient, DYNAMIC_BONDING_CURVE_PROGRAM_ID, type VirtualPool, type PoolConfig } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { getAssociatedTokenAddressSync, unpackAccount, unpackMint, TOKEN_PROGRAM_ID, ACCOUNT_SIZE } from "@solana/spl-token";
import BN from "bn.js";
import { HYPE_MINT } from "./quote-assets";
import { distributorConfigError, nativeSplitConfigError } from "./platform-fees";
import { acceptedPlatformFeeRecipients } from "./platform-wallets";
import { assertSigners, checkNetwork, estimateMessageFee, simulateReviewedTransaction } from "./transactions";
import { units } from "./config";

export type SwapSide = "buy" | "sell";
export const SWAP_JOURNAL = "swap-operation";
export const MAX_SLIPPAGE_BPS = 5000;

export type SwapPlan = {
  tx: Transaction;
  lastValidBlockHeight: number;
  side: SwapSide;
  amountIn: bigint;
  expectedOut: bigint;
  minimumOut: bigint;
  tradingFee: bigint;
  protocolFee: bigint;
  inDecimals: number;
  outDecimals: number;
  networkFee: bigint;
  rent: bigint;
  slippageBps: number;
};

const HOLDER_REWARDS_PROGRAM =
  process.env.NEXT_PUBLIC_HYMET_HOLDER_REWARDS === "true" ? process.env.NEXT_PUBLIC_HYMET_DISTRIBUTOR_PROGRAM_ID || "" : "";

/** Reads and verifies the pool for a HYMET native-split HYPE launch (or, in holder-reward builds, a distributor launch); refuses anything else. Launches made before the
 * platform wallet change keep their legacy feeClaimer and stay tradable. */
export async function verifiedDbcPool(c: Connection, mint: PublicKey, pool: PublicKey, platform: PublicKey) {
  const { sdk, virtualPool, config } = await hymetDbcLaunch(c, mint, pool, platform);
  const state = virtualPool.poolState;
  if (state.isMigrated !== 0) throw Error("This token has graduated; DBC swaps are closed");
  if (BigInt(state.quoteReserve.toString()) >= BigInt(config.migrationQuoteThreshold.toString())) throw Error("Bonding curve is complete; awaiting migration");
  return { sdk, virtualPool, config, decimals: await splDecimals(c, mint) };
}

/** The DBC pool and config of a HYMET launch, in any migration state (also the root of trust for its DAMM v2 pool). */
export async function hymetDbcLaunch(c: Connection, mint: PublicKey, pool: PublicKey, platform: PublicKey) {
  const sdk = new DynamicBondingCurveClient(c, "confirmed");
  const account = await c.getAccountInfo(pool, "confirmed");
  if (!account?.owner.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID)) throw Error("Pool is missing or is not a Meteora DBC pool");
  const virtualPool = sdk.program.coder.accounts.decode<VirtualPool>("virtualPool", account.data);
  if (!virtualPool.poolState.baseMint.equals(mint)) throw Error("Pool base mint does not match this token");
  const cfgAccount = await c.getAccountInfo(virtualPool.poolState.config, "confirmed");
  if (!cfgAccount?.owner.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID)) throw Error("Pool config is not DBC-owned");
  const config = sdk.program.coder.accounts.decode<PoolConfig>("poolConfig", cfgAccount.data);
  const split = nativeSplitConfigError(config, acceptedPlatformFeeRecipients(platform));
  // Distributor (creator/holder split) launches are tradable only in builds that can launch them (same flags as the form).
  if (split && (!HOLDER_REWARDS_PROGRAM || distributorConfigError(config, mint, new PublicKey(HOLDER_REWARDS_PROGRAM))))
    throw Error(`Pool is not a verified HYMET native-split launch: ${split}`);
  return { sdk, virtualPool, config };
}

export async function splDecimals(c: Connection, mint: PublicKey) {
  const mintInfo = await c.getAccountInfo(mint, "confirmed");
  if (!mintInfo?.owner.equals(TOKEN_PROGRAM_ID)) throw Error("Token program is not supported");
  return unpackMint(mint, mintInfo, TOKEN_PROGRAM_ID).decimals;
}

/**
 * The on-chain Clock sysvar the DBC program reads (slot, unix_timestamp). Read with getAccountInfo, which the
 * app RPC proxy allows; getBlockTime is not proxied and a wall-clock fallback could misquote fee schedules.
 */
export async function chainClock(c: Connection) {
  const info = await c.getAccountInfo(SYSVAR_CLOCK_PUBKEY, "confirmed");
  if (!info || info.data.length < 40) throw Error("Clock sysvar unavailable");
  // Layout: slot u64, epoch_start_timestamp i64, epoch u64, leader_schedule_epoch u64, unix_timestamp i64.
  return { slot: info.data.readBigUInt64LE(0), unixTimestamp: info.data.readBigInt64LE(32) };
}

export async function tokenBalance(c: Connection, owner: PublicKey, mint: PublicKey) {
  const address = getAssociatedTokenAddressSync(mint, owner);
  const info = await c.getAccountInfo(address, "confirmed");
  if (!info) return { address, exists: false, amount: 0n };
  const a = unpackAccount(address, info, TOKEN_PROGRAM_ID);
  if (!a.owner.equals(owner) || !a.mint.equals(mint) || a.isFrozen) throw Error("Token account owner, mint or state mismatch");
  return { address, exists: true, amount: a.amount };
}

export async function prepareDbcSwap(
  c: Connection,
  p: { mint: string; pool: string; wallet: PublicKey; side: SwapSide; amount: string; slippageBps: number; platform: PublicKey },
): Promise<SwapPlan> {
  await checkNetwork(c, "mainnet-beta");
  if (!Number.isInteger(p.slippageBps) || p.slippageBps < 1 || p.slippageBps > MAX_SLIPPAGE_BPS) throw Error("Slippage must be 0.01–50%");
  const mint = new PublicKey(p.mint), pool = new PublicKey(p.pool);
  const { sdk, virtualPool, config, decimals } = await verifiedDbcPool(c, mint, pool, p.platform);
  const sell = p.side === "sell";
  const inMint = sell ? mint : HYPE_MINT, outMint = sell ? HYPE_MINT : mint;
  const inDecimals = sell ? decimals : 9, outDecimals = sell ? 9 : decimals;
  const amountIn = units(p.amount, inDecimals);
  if (amountIn <= 0n) throw Error("Enter an amount greater than zero");
  const [source, destination] = await Promise.all([tokenBalance(c, p.wallet, inMint), tokenBalance(c, p.wallet, outMint)]);
  if (source.amount < amountIn) throw Error(`Insufficient ${sell ? "token" : "HYPE"} balance`);
  // Activation type 1 = timestamp, otherwise slot; the quote must use the same clock as the program.
  const currentPoint = new BN((await chainClock(c))[config.activationType === 1 ? "unixTimestamp" : "slot"].toString());
  const quote = sdk.pool.swapQuote({ virtualPool, config, swapBaseForQuote: sell, amountIn: new BN(amountIn.toString()), slippageBps: p.slippageBps, hasReferral: false, eligibleForFirstSwapWithMinFee: false, currentPoint });
  const expectedOut = BigInt(quote.outputAmount.toString()), minimumOut = BigInt(quote.minimumAmountOut.toString());
  if (expectedOut <= 0n || minimumOut <= 0n) throw Error("Amount is too small to produce any output");
  const tx = await sdk.pool.swap({ owner: p.wallet, pool, amountIn: new BN(amountIn.toString()), minimumAmountOut: new BN(minimumOut.toString()), swapBaseForQuote: sell, referralTokenAccount: null });
  if (!tx.instructions.some((ix) => ix.programId.equals(ComputeBudgetProgram.programId)))
    tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 0 }));
  const block = await c.getLatestBlockhash("confirmed");
  tx.feePayer = p.wallet;
  tx.recentBlockhash = block.blockhash;
  assertSigners(tx, p.wallet, []);
  const fee = await estimateMessageFee(c, tx);
  if (fee === null) throw Error("RPC could not estimate the swap fee");
  const rent = destination.exists ? 0n : BigInt(await c.getMinimumBalanceForRentExemption(ACCOUNT_SIZE));
  if (BigInt(await c.getBalance(p.wallet, "confirmed")) < BigInt(fee) + rent) throw Error("Insufficient SOL for the network fee and token account rent");
  await simulateReviewedTransaction(c, tx, false);
  return {
    tx,
    lastValidBlockHeight: block.lastValidBlockHeight,
    side: p.side,
    amountIn,
    expectedOut,
    minimumOut,
    tradingFee: BigInt(quote.tradingFee.toString()),
    protocolFee: BigInt(quote.protocolFee.toString()),
    inDecimals,
    outDecimals,
    networkFee: BigInt(fee),
    rent,
    slippageBps: p.slippageBps,
  };
}

/** Exact decimal string for raw token units (no float rounding, trailing zeros trimmed). */
export function formatUnits(raw: bigint, decimals: number) {
  const scale = 10n ** BigInt(decimals), whole = raw / scale, frac = (raw % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

export const QUICK_PERCENTS = [25, 50, 75, 100] as const;
/**
 * Quick amount from a raw balance, rounded DOWN so it never exceeds what the wallet holds.
 * MAX (100) is the exact balance for both sides: on HYMET DBC pools the trading fee is taken out of the HYPE input
 * (collect mode = quote) and HYPE has no transfer fee, so no extra HYPE must be held back for a buy.
 */
export function quickAmount(balance: bigint, decimals: number, percent: (typeof QUICK_PERCENTS)[number]) {
  if (balance <= 0n) return "";
  return formatUnits(percent === 100 ? balance : (balance * BigInt(percent)) / 100n, decimals);
}

/** Read-only quote preview (no wallet, no transaction, no simulation) for the trade panel. */
export async function quoteDbcSwap(
  c: Connection,
  p: { mint: string; pool: string; side: SwapSide; amount: string; slippageBps: number; platform: PublicKey },
) {
  const mint = new PublicKey(p.mint), pool = new PublicKey(p.pool);
  const { sdk, virtualPool, config, decimals } = await verifiedDbcPool(c, mint, pool, p.platform);
  const sell = p.side === "sell";
  const amountIn = units(p.amount, sell ? decimals : 9);
  if (amountIn <= 0n) throw Error("Enter an amount greater than zero");
  const currentPoint = new BN((await chainClock(c))[config.activationType === 1 ? "unixTimestamp" : "slot"].toString());
  const q = sdk.pool.swapQuote({ virtualPool, config, swapBaseForQuote: sell, amountIn: new BN(amountIn.toString()), slippageBps: p.slippageBps, hasReferral: false, eligibleForFirstSwapWithMinFee: false, currentPoint });
  return { expectedOut: BigInt(q.outputAmount.toString()), minimumOut: BigInt(q.minimumAmountOut.toString()), fee: BigInt(q.tradingFee.toString()) + BigInt(q.protocolFee.toString()), outDecimals: sell ? 9 : decimals };
}
