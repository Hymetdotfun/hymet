export const HYMET_SUPPLY = "1000000000";
export const HYMET_DECIMALS = 9;
export const HYMET_PLATFORM_SHARE_BPS = 2000;
export const HYMET_MAX_TRADING_FEE_BPS = 300;
export const HYMET_MIN_DBC_FEE_BPS = 25;

export function normalizeName(value: string) {
  const normalized = value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
  if (!normalized || new TextEncoder().encode(normalized).length > 32) throw new Error("Token name is required and must be at most 32 UTF-8 bytes");
  return normalized;
}
export function normalizeTicker(value: string) {
  const ticker = value.normalize("NFKC").trim().toLocaleUpperCase("en-US");
  if (!/^[A-Z0-9]{1,10}$/.test(ticker)) throw new Error("Ticker must contain 1–10 letters or digits");
  return ticker;
}
/** The creator's split of their 80% between creator and holders; percentages always refer to that 80%. */
export const CREATOR_ALLOCATION_STEP = 1;
export const CREATOR_ALLOCATION_DEFAULT = 100;
export const CREATOR_ALLOCATION_OPTIONS: readonly number[] = Array.from({ length: 101 }, (_, i) => 100 - i * CREATOR_ALLOCATION_STEP);
const ALLOCATION_ERROR = "Creator allocation must be a whole percentage from 0 to 100 of the 80% creator share";
export function rewardSplit(creatorPercent: number) {
  if (!CREATOR_ALLOCATION_OPTIONS.includes(creatorPercent)) throw new Error(ALLOCATION_ERROR);
  return { hymet: 20, creatorPercent, holderPercent: 100 - creatorPercent, creatorBpsOfRemaining: creatorPercent * 100 };
}
/** Canonical wire form of `creatorShare`: "0".."100", no sign, leading zero, decimals or whitespace. */
export function parseCreatorShare(value: unknown) {
  if (typeof value !== "string" || !/^(0|[1-9]\d?|100)$/.test(value)) throw new Error(ALLOCATION_ERROR);
  return rewardSplit(Number(value)).creatorPercent;
}

export type Allocation = {
  creatorPercent: number;
  holderPercent: number;
  /** Of the creator-controlled 80%; the two always sum to 10,000. Stored on-chain as `creator_bps_of_remaining`. */
  creatorBpsOfRemaining: number;
  holderBpsOfRemaining: number;
  /** Of all distributable fees; HYMET + creator + holders = 10,000 exactly (a 1% step of the 80% is 80 bps). */
  effectiveBps: { hymet: number; creator: number; holders: number };
};
export function allocationFromBps(creatorBpsOfRemaining: number, holderBpsOfRemaining = 10_000 - creatorBpsOfRemaining): Allocation {
  if (!Number.isInteger(creatorBpsOfRemaining) || creatorBpsOfRemaining < 0 || creatorBpsOfRemaining > 10_000 || creatorBpsOfRemaining + holderBpsOfRemaining !== 10_000)
    throw new Error("Stored allocation is not a valid basis-point split");
  const remaining = 10_000 - HYMET_PLATFORM_SHARE_BPS;
  // Rounds down like the program; holders take the rest, so the three parts always sum to 10,000.
  const creator = Math.floor((remaining * creatorBpsOfRemaining) / 10_000);
  return {
    // Records from before 1% steps are whole percentages too; any other bps value stays exact in the bps fields.
    creatorPercent: creatorBpsOfRemaining / 100,
    holderPercent: holderBpsOfRemaining / 100,
    creatorBpsOfRemaining,
    holderBpsOfRemaining,
    effectiveBps: { hymet: HYMET_PLATFORM_SHARE_BPS, creator, holders: remaining - creator },
  };
}
export function allocationFromShare(creatorShare: unknown): Allocation {
  return allocationFromBps(parseCreatorShare(creatorShare) * 100);
}
