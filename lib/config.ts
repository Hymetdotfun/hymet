import { quoteAsset } from "./quote-assets";
import { parseCreatorShare } from "./hymet-policy";
import BN from "bn.js";
import { socialLinks } from "./socials";
import {
  buildCurveWithMarketCap,
  validateConfigParameters,
  ActivationType,
  BaseFeeMode,
  CollectFeeMode,
  MigrationOption,
  MigrationFeeOption,
  TokenType,
  TokenAuthorityOption,
  type ConfigParameters,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { PublicKey } from "@solana/web3.js";
export type Inputs = {
  quote?: "sol" | "hype";
  name: string;
  symbol: string;
  description: string;
  website: string;
  twitter: string;
  telegram: string;
  social: string;
  supply: string;
  decimals: string;
  initialCap: string;
  migrationCap: string;
  fee: string;
  creatorShare: string;
  collect: string;
  migrationFee: string;
  migrationCreatorShare: string;
  postFee: string;
  buy: string;
  slippage: string;
  reuse: string;
};
/**
 * Default Meteora DBC curve for NEW launches (existing pools keep their on-chain config).
 * Priced 2026-10-31 from GeckoTerminal: HYPE $89.47, SOL $96.16.
 *   start ≈ $3,000  → 33.5 HYPE market cap
 *   graduation ≈ $40,000 → 447 HYPE market cap
 * Caps are fixed in HYPE so launch verification and recovery rebuild the identical config;
 * their USD value moves with HYPE. Single-segment curve: virtual HYPE depth at start is
 * MC0 / (1 − MC0/MC1) ≈ 36.2 HYPE (≈ 33.7 SOL), and 96.1 HYPE is raised at graduation.
 */
export const CURVE_DEFAULTS = { initialCap: "33.5", migrationCap: "447" } as const;
export const defaults: Inputs = {
  quote: "hype",
  name: "",
  symbol: "",
  description: "",
  website: "",
  twitter: "",
  telegram: "",
  social: "",
  supply: "1000000000",
  decimals: "9",
  initialCap: CURVE_DEFAULTS.initialCap,
  migrationCap: CURVE_DEFAULTS.migrationCap,
  fee: "1",
  // Creator percentage of the 80% creator allocation; the rest goes to holders.
  creatorShare: "100",
  collect: "0",
  migrationFee: "0",
  migrationCreatorShare: "0",
  postFee: "1",
  buy: "0",
  slippage: "1",
  reuse: "",
};
export function units(value: string, decimals: number): bigint {
  if (!/^\d+(\.\d+)?$/.test(value))
    throw Error("Enter a non-negative decimal amount");
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals)
    throw Error(`At most ${decimals} decimal places`);
  const n =
    BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt(fraction.padEnd(decimals, "0"));
  if (n > 18446744073709551615n) throw Error("Amount exceeds u64");
  return n;
}
export function bps(s: string) {
  const n = units(s, 2);
  if (n > 10000n) throw Error("Percentage exceeds 100");
  return Number(n);
}
export function validate(v: Inputs) {
  quoteAsset(v);
  if (!v.name.trim() || new TextEncoder().encode(v.name).length > 32)
    throw Error("Token name is required, maximum 32 bytes");
  if (!/^[A-Za-z0-9]{1,10}$/.test(v.symbol))
    throw Error("Symbol must contain 1–10 letters or digits");
  if (v.description.length > 2000) throw Error("Description is too long");
  socialLinks(v);
  if (v.decimals !== "9") throw Error("HYMET tokens use exactly 9 decimals");
  if (v.supply !== "1000000000")
    throw Error("HYMET token supply is fixed at 1,000,000,000");
  units(v.supply, Number(v.decimals));
  // The source SDK's DBC fee scheduler rejects zero and has a 25 bps floor.
  // Keep the public range within the verified config builder's supported range.
  const f = bps(v.fee);
  if (f < 25 || f > 300)
    throw Error("Meteora DBC trading fees must be 0.25%–3% in HYMET");
  parseCreatorShare(v.creatorShare);
  if (v.collect !== "0") throw Error("HYMET collects trading fees in HYPE");
  // buildCurve fixes these on-chain; reject differing inputs so a reviewed plan
  // can never display values that the DBC config does not apply.
  if (v.initialCap !== CURVE_DEFAULTS.initialCap || v.migrationCap !== CURVE_DEFAULTS.migrationCap)
    throw Error(`HYMET market caps are fixed at ${CURVE_DEFAULTS.initialCap} / ${CURVE_DEFAULTS.migrationCap} HYPE`);
  if (v.migrationFee !== "0" || v.migrationCreatorShare !== "0")
    throw Error("HYMET adds no migration fee");
  if (bps(v.postFee) !== f)
    throw Error("After-migration trading fee must equal the bonding curve fee");
  units(v.buy, 9);
  if (bps(v.slippage) < 1 || bps(v.slippage) > 5000)
    throw Error("Slippage must be 0.01–50%");
  if (v.reuse) new PublicKey(v.reuse);
}
export function curve(v: Inputs, receiver: PublicKey): ConfigParameters {
  return buildCurve(v, receiver, false);
}

/**
 * Distributor-only DBC route: send all pre-migration trading fees to the
 * distributor PDA and assign the post-migration partner position to that PDA.
 * Do not use until the deployed distributor and its on-chain config are verified.
 */
export function distributorCurve(v: Inputs, receiver: PublicKey): ConfigParameters {
  return buildCurve(v, receiver, true);
}

function buildCurve(v: Inputs, receiver: PublicKey, distributor: boolean): ConfigParameters {
  validate(v);
  const initialCap = Number(CURVE_DEFAULTS.initialCap);
  const migrationCap = Number(CURVE_DEFAULTS.migrationCap);
  const c = buildCurveWithMarketCap({
    token: {
      tokenType: TokenType.SPLToken,
      tokenBaseDecimal: Number(v.decimals),
      tokenQuoteDecimal: 9,
      tokenAuthorityOption: TokenAuthorityOption.Immutable,
      totalTokenSupply: Number(v.supply),
      leftover: 0,
    },
    fee: {
      baseFeeParams: {
        baseFeeMode: BaseFeeMode.FeeSchedulerLinear,
        feeSchedulerParam: {
          startingFeeBps: bps(v.fee),
          endingFeeBps: bps(v.fee),
          numberOfPeriod: 0,
          totalDuration: 0,
        },
      },
      dynamicFeeEnabled: false,
      collectFeeMode: Number(v.collect) as CollectFeeMode,
      // DBC routes the partner remainder to feeClaimer. HYMET's platform
      // share is fixed at 20% of DBC's distributable LP fees, leaving 80%
      // for the creator/distributor path.
      creatorTradingFeePercentage: distributor ? 0 : 80,
      poolCreationFee: 0,
      enableFirstSwapWithMinFee: false,
    },
    migration: {
      migrationOption: MigrationOption.MET_DAMM_V2,
      migrationFeeOption: MigrationFeeOption.Customizable,
      migrationFee: {
        feePercentage: 0,
        creatorFeePercentage: 0,
      },
      migratedPoolFee: {
        collectFeeMode: 0,
        dynamicFee: 0,
        poolFeeBps: bps(v.fee),
      },
    },
    liquidityDistribution: {
      // Distributor route: one permanently locked position owned by the distributor PDA,
      // whose fees it splits 20% HYMET / creator / holders. Native route: 20/80 locked.
      partnerLiquidityPercentage: 0,
      partnerPermanentLockedLiquidityPercentage: distributor ? 100 : 20,
      creatorLiquidityPercentage: 0,
      creatorPermanentLockedLiquidityPercentage: distributor ? 0 : 80,
    },
    lockedVesting: {
      totalLockedVestingAmount: 0,
      numberOfVestingPeriod: 0,
      cliffUnlockAmount: 0,
      totalVestingDuration: 0,
      cliffDurationFromMigrationTime: 0,
    },
    activationType: ActivationType.Timestamp,
    initialMarketCap: initialCap,
    migrationMarketCap: migrationCap,
  });
  validateConfigParameters({ ...c, leftoverReceiver: receiver });
  if (
    c.tokenSupply &&
    !c.tokenSupply.preMigrationTokenSupply.eq(
      new BN(units(v.supply, Number(v.decimals)).toString()),
    )
  )
    throw Error("SDK supply differs from exact requested supply");
  return c;
}
export function friendly(e: unknown) {
  if (e instanceof Error && e.name === "WalletNotReadyError")
    return "Phantom is not available in this browser. Open the localhost launcher in a browser with Phantom installed and unlocked.";
  const s = e instanceof Error ? e.message || e.name : String(e);
  const rpc = s.match(
    /RPC operation [A-Za-z]+: (?:HTTP \d+|timeout|transport or bounded-response failure); endpoint=(?:public|configured)-mainnet; attempts=\d+; request=\d+\.(?: Broadcast status UNKNOWN; check the saved signature\. Do not resend\.)?/,
  );
  if (rpc) return rpc[0];
  if (/reject|4001/i.test(s))
    return "Wallet approval rejected. No automatic retry was attempted.";
  if (/blockhash|expired/i.test(s))
    return "Blockhash expired. Check transaction status before preparing a new launch.";
  if (/429|timeout|fetch/i.test(s))
    return "RPC unavailable or rate limited. Use recovery to check signatures before retrying.";
  return s;
}
