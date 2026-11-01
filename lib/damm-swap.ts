// HYPE <-> token swaps on a graduated HYMET launch's Meteora DAMM v2 pool. The pool is trusted only as the verified
// migration destination of the token's own verified DBC launch pool, with the launch's migrated 1%-style flat fee
// collected in HYPE. Builds an unsigned transaction for Phantom; same review/simulation flow as DBC swaps.
import { Connection, PublicKey, ComputeBudgetProgram } from "@solana/web3.js";
import { CpAmm, isSwapEnabled, swapQuoteExactInput, type PoolState } from "@meteora-ag/cp-amm-sdk";
import { ACCOUNT_SIZE, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import BN from "bn.js";
import { HYPE_MINT } from "./quote-assets";
import { readMigration } from "./migration";
import { MAX_SLIPPAGE_BPS, chainClock, hymetDbcLaunch, splDecimals, tokenBalance, type SwapPlan, type SwapSide } from "./dbc-swap";
import { assertSigners, checkNetwork, estimateMessageFee, simulateReviewedTransaction } from "./transactions";
import { units } from "./config";

const COLLECT_FEE_ONLY_B = 1;

/** Why a DAMM v2 pool state is not the flat, HYPE-collected fee HYMET configured at launch, or null. */
export function dammFeeError(pool: PoolState, migratedPoolFeeBps: number): string | null {
  const data = Buffer.from(pool.poolFees.baseFee.baseFeeInfo.data);
  // Pod-aligned time scheduler: cliff numerator u64, mode u8, then padding/periods/reduction, all zero for a flat fee.
  if (data.length < 9 || data[8] !== 0 || !data.subarray(9).every((b) => b === 0)) return "DAMM v2 base fee is not a flat fee";
  if (data.readBigUInt64LE(0) !== BigInt(migratedPoolFeeBps) * 100_000n) return `DAMM v2 fee differs from the launch's ${migratedPoolFeeBps / 100}%`;
  if (pool.poolFees.dynamicFee.initialized !== 0) return "DAMM v2 dynamic fee is enabled";
  if (pool.collectFeeMode !== COLLECT_FEE_ONLY_B) return "DAMM v2 fees are not collected in HYPE";
  if (pool.poolFees.compoundingFeeBps !== 0) return "DAMM v2 pool compounds fees into liquidity";
  return null;
}

/** The DAMM v2 pool of a graduated HYMET launch, verified from its DBC launch pool. */
export async function verifiedDammPool(c: Connection, mint: PublicKey, dbcPool: PublicKey, dammPool: PublicKey, platform: PublicKey) {
  const { virtualPool, config } = await hymetDbcLaunch(c, mint, dbcPool, platform);
  const migration = await readMigration(c, virtualPool.poolState, config);
  if (migration.label !== "Migrated to DAMM V2" || migration.venue !== "DAMM V2") throw Error("This token has not completed migration to DAMM v2");
  if (migration.destination !== dammPool.toBase58()) throw Error("DAMM v2 pool is not this launch's verified migration destination");
  const amm = new CpAmm(c);
  const pool = await amm.fetchPoolState(dammPool);
  if (!pool.tokenAMint.equals(mint) || !pool.tokenBMint.equals(HYPE_MINT)) throw Error("DAMM v2 pool mint pair does not match");
  // Flag 0 = SPL Token (both HYMET launch tokens and HYPE); Token-2022 pools are not supported.
  if (pool.tokenAFlag !== 0 || pool.tokenBFlag !== 0) throw Error("Token program is not supported");
  const fee = dammFeeError(pool, config.migratedPoolFeeBps);
  if (fee) throw Error(fee);
  const clock = await chainClock(c);
  const currentPoint = new BN((pool.activationType === 1 ? clock.unixTimestamp : clock.slot).toString());
  if (!isSwapEnabled(pool, currentPoint)) throw Error("DAMM v2 pool is not open for swaps");
  return { amm, pool, currentPoint, decimals: await splDecimals(c, mint) };
}

function quote(pool: PoolState, currentPoint: BN, sell: boolean, amountIn: bigint, slippageBps: number, decimals: number) {
  // Token A is the launch token and token B is HYPE: a sell swaps A -> B.
  const q = swapQuoteExactInput(pool, currentPoint, new BN(amountIn.toString()), slippageBps, sell, false, decimals, 9);
  const big = (v: BN | undefined) => BigInt((v ?? new BN(0)).toString());
  return {
    expectedOut: big(q.outputAmount),
    minimumOut: big(q.minimumAmountOut),
    tradingFee: big(q.claimingFee) + big(q.compoundingFee),
    protocolFee: big(q.protocolFee) + big(q.referralFee),
  };
}

export async function prepareDammSwap(
  c: Connection,
  p: { mint: string; dbcPool: string; pool: string; wallet: PublicKey; side: SwapSide; amount: string; slippageBps: number; platform: PublicKey },
): Promise<SwapPlan> {
  await checkNetwork(c, "mainnet-beta");
  if (!Number.isInteger(p.slippageBps) || p.slippageBps < 1 || p.slippageBps > MAX_SLIPPAGE_BPS) throw Error("Slippage must be 0.01–50%");
  const mint = new PublicKey(p.mint), dammPool = new PublicKey(p.pool);
  const { amm, pool, currentPoint, decimals } = await verifiedDammPool(c, mint, new PublicKey(p.dbcPool), dammPool, p.platform);
  const sell = p.side === "sell";
  const inMint = sell ? mint : HYPE_MINT, outMint = sell ? HYPE_MINT : mint;
  const inDecimals = sell ? decimals : 9, outDecimals = sell ? 9 : decimals;
  const amountIn = units(p.amount, inDecimals);
  if (amountIn <= 0n) throw Error("Enter an amount greater than zero");
  const [source, destination] = await Promise.all([tokenBalance(c, p.wallet, inMint), tokenBalance(c, p.wallet, outMint)]);
  if (source.amount < amountIn) throw Error(`Insufficient ${sell ? "token" : "HYPE"} balance`);
  const q = quote(pool, currentPoint, sell, amountIn, p.slippageBps, decimals);
  if (q.expectedOut <= 0n || q.minimumOut <= 0n) throw Error("Amount is too small to produce any output");
  const tx = await amm.swap({
    payer: p.wallet, pool: dammPool, inputTokenMint: inMint, outputTokenMint: outMint,
    amountIn: new BN(amountIn.toString()), minimumAmountOut: new BN(q.minimumOut.toString()),
    tokenAMint: pool.tokenAMint, tokenBMint: pool.tokenBMint, tokenAVault: pool.tokenAVault, tokenBVault: pool.tokenBVault,
    tokenAProgram: TOKEN_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID, referralTokenAccount: null, poolState: pool,
  });
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
  return { tx, lastValidBlockHeight: block.lastValidBlockHeight, side: p.side, amountIn, ...q, inDecimals, outDecimals, networkFee: BigInt(fee), rent, slippageBps: p.slippageBps };
}

/** Read-only quote preview (no wallet, no transaction, no simulation) for the trade panel. */
export async function quoteDammSwap(
  c: Connection,
  p: { mint: string; dbcPool: string; pool: string; side: SwapSide; amount: string; slippageBps: number; platform: PublicKey },
) {
  const mint = new PublicKey(p.mint);
  const { pool, currentPoint, decimals } = await verifiedDammPool(c, mint, new PublicKey(p.dbcPool), new PublicKey(p.pool), p.platform);
  const sell = p.side === "sell";
  const amountIn = units(p.amount, sell ? decimals : 9);
  if (amountIn <= 0n) throw Error("Enter an amount greater than zero");
  const q = quote(pool, currentPoint, sell, amountIn, p.slippageBps, decimals);
  return { expectedOut: q.expectedOut, minimumOut: q.minimumOut, fee: q.tradingFee + q.protocolFee, outDecimals: sell ? 9 : decimals };
}
