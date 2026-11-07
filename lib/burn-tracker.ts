// $HYMET burn tracking. Total burned is the original supply minus the mint's current supply: the mint authority is revoked,
// so supply can only fall, and only through SPL burns. Each burn instruction is also indexed once, by transaction and
// instruction, and a checkpoint is saved only when the indexed burns add up exactly to that supply reduction.
import { OFFICIAL_TOKEN_MINT } from "./token-directory";

export const BURN_TRACKED_MINT = OFFICIAL_TOKEN_MINT;
export const BURN_TRACKED_SYMBOL = "HYMET";
export const BURN_TRACKED_DECIMALS = 9;
/** 1,000,000,000 $HYMET, minted once at launch by its only mintTo; nothing can mint more. */
export const ORIGINAL_SUPPLY_RAW = 1_000_000_000_000_000_000n;
/** Burns signed by these wallets are team buyback burns: $HYMET's on-chain creator, the HYMET team wallet. Every other burn is
 *  shown as an other on-chain burn. */
export const TEAM_BURN_WALLETS: readonly string[] = ["HYKNLVDr4kUQ5hMCEnPKJP3YqLzT2L2Ma6c4NB1gEsun"];
const TOKEN_PROGRAMS = new Set(["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"]);
const SIGNATURE_PAGE = 1000;

export type BurnRow = {
  signature: string;
  instructionPath: string;
  slot: number;
  blockTime: number | null;
  amountRaw: bigint;
  authority: string;
  tokenAccount: string;
};
type ParsedInstruction = { programId?: string; parsed?: unknown };
export type ParsedTransaction = {
  slot: number;
  blockTime?: number | null;
  meta: { err: unknown; innerInstructions?: { index: number; instructions: ParsedInstruction[] }[] | null } | null;
  transaction: { signatures: string[]; message: { instructions: ParsedInstruction[] } };
};

/** Confirmed SPL burns of `mint` in one jsonParsed transaction, top-level and inner (CPI). Failed transactions burn nothing,
 *  and transfers, including transfers to dead wallets, are not burns. */
export function burnsInTransaction(tx: ParsedTransaction, mint = BURN_TRACKED_MINT): BurnRow[] {
  if (!tx.meta || tx.meta.err !== null) return [];
  const signature = tx.transaction.signatures[0];
  const entries: [string, ParsedInstruction][] = tx.transaction.message.instructions.map((ix, i) => [String(i), ix]);
  for (const group of tx.meta.innerInstructions ?? [])
    group.instructions.forEach((ix, j) => entries.push([`${group.index}.${j}`, ix]));
  const rows: BurnRow[] = [];
  for (const [instructionPath, ix] of entries) {
    if (!ix.programId || !TOKEN_PROGRAMS.has(ix.programId)) continue;
    const parsed = ix.parsed as { type?: unknown; info?: Record<string, unknown> } | undefined;
    if (!parsed || typeof parsed !== "object" || (parsed.type !== "burn" && parsed.type !== "burnChecked")) continue;
    const info = parsed.info ?? {};
    if (info.mint !== mint) continue;
    const raw = typeof info.amount === "string" ? info.amount : (info.tokenAmount as { amount?: unknown } | undefined)?.amount;
    if (typeof raw !== "string" || !/^\d+$/.test(raw)) throw Error(`Unreadable burn amount in ${signature}`);
    const authority = info.authority ?? info.multisigAuthority;
    if (typeof authority !== "string" || typeof info.account !== "string") throw Error(`Unreadable burn accounts in ${signature}`);
    const amountRaw = BigInt(raw);
    if (amountRaw > 0n)
      rows.push({ signature, instructionPath, slot: tx.slot, blockTime: tx.blockTime ?? null, amountRaw, authority, tokenAccount: info.account });
  }
  return rows;
}

export type BurnRpc = {
  /** Finalized supply and the slot it was read at. */
  supply(): Promise<{ amountRaw: bigint; decimals: number; slot: number }>;
  /** Finalized signatures that reference the mint, newest first, up to 1,000 per page. */
  signatures(before?: string): Promise<{ signature: string; slot: number; err: unknown }[]>;
  transaction(signature: string): Promise<ParsedTransaction | null>;
};
export type BurnStore = {
  checkpoint(): Promise<{ verifiedSlot: number } | null>;
  indexedTotal(): Promise<bigint>;
  /** Idempotent: a burn already indexed (same signature and instruction) is skipped. */
  insert(rows: BurnRow[]): Promise<void>;
  verified(checkpoint: { verifiedSlot: number; supplyRaw: bigint; burnedRaw: bigint }): Promise<void>;
  failed(message: string): Promise<void>;
};
export type SyncResult = { status: "verified" | "unverified"; burnedRaw: bigint; slot: number; scanned: number };

/** Brings the burn index up to the mint's finalized supply. Reads transactions only when supply fell below what is indexed. */
export async function syncBurns(rpc: BurnRpc, store: BurnStore, { maxPages = 50, concurrency = 6 } = {}): Promise<SyncResult> {
  const supply = await rpc.supply();
  if (supply.decimals !== BURN_TRACKED_DECIMALS) throw Error("Unexpected $HYMET decimals");
  if (supply.amountRaw > ORIGINAL_SUPPLY_RAW) throw Error("Supply is above the original supply");
  const expected = ORIGINAL_SUPPLY_RAW - supply.amountRaw;
  const checkpoint = await store.checkpoint();
  let indexed = await store.indexedTotal();
  let scanned = 0;
  if (indexed < expected) {
    // Every burn names the mint, so the unindexed burns are among the mint's signatures after the last verified slot.
    const after = checkpoint?.verifiedSlot ?? -1;
    const pending: string[] = [];
    let before: string | undefined;
    let complete = false;
    for (let page = 0; page < maxPages && !complete; page++) {
      const list = await rpc.signatures(before);
      for (const s of list) {
        if (s.slot <= after) { complete = true; break; }
        if (s.slot <= supply.slot && s.err === null) pending.push(s.signature);
      }
      if (list.length < SIGNATURE_PAGE) complete = true;
      else before = list[list.length - 1].signature;
    }
    for (let i = 0; i < pending.length; i += concurrency) {
      const batch = await Promise.all(pending.slice(i, i + concurrency).map((signature) => rpc.transaction(signature)));
      scanned += batch.length;
      const rows = batch.flatMap((tx, j) => {
        if (!tx) throw Error(`Transaction ${pending[i + j]} is not available yet`);
        return burnsInTransaction(tx);
      });
      if (rows.length) await store.insert(rows);
    }
    indexed = await store.indexedTotal();
  }
  if (indexed !== expected) {
    await store.failed(`Indexed burns (${indexed}) do not match the supply reduction (${expected}) at slot ${supply.slot}`);
    return { status: "unverified", burnedRaw: expected, slot: supply.slot, scanned };
  }
  await store.verified({ verifiedSlot: supply.slot, supplyRaw: supply.amountRaw, burnedRaw: expected });
  return { status: "verified", burnedRaw: expected, slot: supply.slot, scanned };
}

export type BurnSummary = {
  burnedRaw: bigint;
  teamBurnedRaw: bigint;
  otherBurnedRaw: bigint;
  teamCount: number;
  otherCount: number;
  lastBurnAt: number | null;
  recent: (BurnRow & { team: boolean })[];
};
/** Splits the verified burns (those at or before the checkpoint slot) into team buyback burns and other on-chain burns. */
export function summarizeBurns(rows: readonly BurnRow[], verifiedSlot: number, recentLimit = 5): BurnSummary {
  const verified = rows.filter((r) => r.slot <= verifiedSlot).sort((a, b) => b.slot - a.slot || a.instructionPath.localeCompare(b.instructionPath));
  const team = verified.filter((r) => TEAM_BURN_WALLETS.includes(r.authority));
  const other = verified.filter((r) => !TEAM_BURN_WALLETS.includes(r.authority));
  const sum = (list: BurnRow[]) => list.reduce((total, r) => total + r.amountRaw, 0n);
  return {
    burnedRaw: sum(verified),
    teamBurnedRaw: sum(team),
    otherBurnedRaw: sum(other),
    teamCount: team.length,
    otherCount: other.length,
    lastBurnAt: verified.find((r) => r.blockTime !== null)?.blockTime ?? null,
    recent: verified.slice(0, recentLimit).map((r) => ({ ...r, team: TEAM_BURN_WALLETS.includes(r.authority) })),
  };
}

/** Exact percentage of the original supply, rounded down to `places` decimals. */
export function percentOfOriginal(raw: bigint, places = 4) {
  const scale = 10n ** BigInt(places);
  const value = (raw * 100n * scale) / ORIGINAL_SUPPLY_RAW;
  return `${value / scale}.${(value % scale).toString().padStart(places, "0")}`;
}

/** A raw amount as whole tokens with thousands separators, rounded down to `places` decimals (exact when places = 9). */
export function formatTokens(raw: bigint, places = 2, decimals = BURN_TRACKED_DECIMALS) {
  const unit = 10n ** BigInt(decimals);
  const whole = (raw / unit).toLocaleString("en-US");
  const fraction = (raw % unit).toString().padStart(decimals, "0").slice(0, places).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}
