// HYMET platform (DBC partner) fee claims for native-split launches. The platform wallet is the DBC
// feeClaimer and signs in Phantom; this module only reads chain state and builds the unsigned transaction.
import { Buffer } from "buffer";
import { Connection, PublicKey, ComputeBudgetProgram, type Transaction } from "@solana/web3.js";
import {
  DynamicBondingCurveClient,
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
  deriveDbcPoolAddress,
  type VirtualPool,
  type PoolConfig,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, unpackAccount, ACCOUNT_SIZE } from "@solana/spl-token";
import BN from "bn.js";
import { HYPE_MINT } from "./quote-assets";
import { NATIVE_SPLIT } from "./launch-mode";
import { distributorAddresses } from "./distributor-engine";
import { WALLET_PRIORITY_MICROLAMPORTS, assertSigners, checkNetwork, estimateMessageFee, type Network } from "./transactions";

export type PlatformFeeView = {
  pool: string;
  mint: string;
  quoteMint: string;
  feeClaimer: string;
  creatorShare: number;
  base: bigint;
  quote: bigint;
};

export const FEE_CLAIMER_MISMATCH = "DBC fee claimer is not the HYMET platform wallet";

/**
 * Native-split invariants of a DBC config, as stored on-chain (percentages are of the LP fee after Meteora's protocol fee).
 * `platform` is the one wallet allowed as feeClaimer, or a list (current + legacy platform wallets) for existing pools.
 */
export function nativeSplitConfigError(cfg: PoolConfig, platform: PublicKey | readonly PublicKey[]): string | null {
  if (!(Array.isArray(platform) ? platform : [platform]).some((p: PublicKey) => cfg.feeClaimer.equals(p))) return FEE_CLAIMER_MISMATCH;
  if (cfg.creatorTradingFeePercentage !== NATIVE_SPLIT.creatorPercent) return "DBC creator trading fee share is not 80%";
  const lp = [
    cfg.partnerLiquidityPercentage,
    cfg.partnerPermanentLockedLiquidityPercentage,
    cfg.creatorLiquidityPercentage,
    cfg.creatorPermanentLockedLiquidityPercentage,
  ];
  if (lp.join() !== "0,20,0,80") return "Migrated liquidity is not 20% platform / 80% creator, permanently locked";
  if (!cfg.quoteMint.equals(HYPE_MINT)) return "Quote mint is not HYPE";
  return null;
}

/**
 * Distributor-launch invariants of a DBC config (lib/config.ts distributorCurve): the mint's distributor fee pool is the
 * feeClaimer, the DBC creator fee share is 0 (the distributor splits 20% HYMET / creator / holders), and all migrated
 * liquidity is permanently locked to the distributor.
 */
export function distributorConfigError(cfg: PoolConfig, mint: PublicKey, program: PublicKey): string | null {
  if (!cfg.feeClaimer.equals(distributorAddresses(program, mint).feePool)) return "DBC fee claimer is not this token's HYMET distributor fee pool";
  if (cfg.creatorTradingFeePercentage !== 0) return "DBC creator trading fee share is not routed to the distributor";
  const lp = [
    cfg.partnerLiquidityPercentage,
    cfg.partnerPermanentLockedLiquidityPercentage,
    cfg.creatorLiquidityPercentage,
    cfg.creatorPermanentLockedLiquidityPercentage,
  ];
  if (lp.join() !== "0,100,0,0") return "Migrated liquidity is not permanently locked to the distributor";
  if (!cfg.quoteMint.equals(HYPE_MINT)) return "Quote mint is not HYPE";
  return null;
}

export async function readPlatformFees(c: Connection, network: Network, address: string, platform: PublicKey): Promise<PlatformFeeView> {
  await checkNetwork(c, network);
  const pool = new PublicKey(address),
    sdk = new DynamicBondingCurveClient(c, "confirmed");
  const account = await c.getAccountInfo(pool, "confirmed");
  if (!account?.owner.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID)) throw Error("Pool is missing or is not DBC-owned on this network");
  const p = sdk.program.coder.accounts.decode<VirtualPool>("virtualPool", account.data).poolState;
  const cfgAccount = await c.getAccountInfo(p.config, "confirmed");
  if (!cfgAccount?.owner.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID)) throw Error("Config is missing or is not DBC-owned");
  const cfg = sdk.program.coder.accounts.decode<PoolConfig>("poolConfig", cfgAccount.data);
  if (!deriveDbcPoolAddress(cfg.quoteMint, p.baseMint, p.config).equals(pool)) throw Error("Pool address does not match its mint/config");
  const error = nativeSplitConfigError(cfg, platform);
  if (error) throw Error(error);
  return {
    pool: pool.toBase58(),
    mint: p.baseMint.toBase58(),
    quoteMint: cfg.quoteMint.toBase58(),
    feeClaimer: cfg.feeClaimer.toBase58(),
    creatorShare: cfg.creatorTradingFeePercentage,
    base: BigInt(p.partnerBaseFee.toString()),
    quote: BigInt(p.partnerQuoteFee.toString()),
  };
}

/** Unsigned partner-fee claim for the platform wallet to review and sign in Phantom. */
export async function preparePlatformClaim(c: Connection, network: Network, address: string, platform: PublicKey) {
  const view = await readPlatformFees(c, network, address, platform);
  if (view.base === 0n && view.quote === 0n) throw Error("No DBC platform trading fees to claim");
  const destinations = [view.mint, view.quoteMint].map((m) => getAssociatedTokenAddressSync(new PublicKey(m), platform));
  const infos = await c.getMultipleAccountsInfo(destinations, "confirmed");
  infos.forEach((info, i) => {
    if (!info) return;
    const a = unpackAccount(destinations[i], info, TOKEN_PROGRAM_ID);
    if (!a.owner.equals(platform) || a.isFrozen || !a.mint.equals(new PublicKey(i ? view.quoteMint : view.mint)))
      throw Error("Platform fee destination token account mismatch");
  });
  const rent = BigInt(infos.filter((a) => !a).length) * BigInt(await c.getMinimumBalanceForRentExemption(ACCOUNT_SIZE));
  const tx: Transaction = await new DynamicBondingCurveClient(c, "confirmed").partner.claimPartnerTradingFee({
    feeClaimer: platform,
    payer: platform,
    pool: new PublicKey(view.pool),
    maxBaseAmount: new BN(view.base.toString()),
    maxQuoteAmount: new BN(view.quote.toString()),
  });
  tx.instructions.unshift(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: WALLET_PRIORITY_MICROLAMPORTS }),
  );
  const block = await c.getLatestBlockhash("confirmed");
  tx.feePayer = platform;
  tx.recentBlockhash = block.blockhash;
  assertSigners(tx, platform, []);
  const fee = await estimateMessageFee(c, tx);
  if (fee === null) throw Error("RPC could not estimate claim fee");
  return {
    view,
    tx,
    message: Buffer.from(tx.serializeMessage()).toString("base64"),
    fee: BigInt(fee),
    rent,
    destinations: destinations.map((k) => k.toBase58()),
    lastValidBlockHeight: block.lastValidBlockHeight,
  };
}
