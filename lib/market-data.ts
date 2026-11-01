// Server-side market data for verified HYMET HYPE-quoted pools. Sources, in order of trust:
// on-chain pool reserves (Mainnet RPC) > GeckoTerminal (pool-specific, HYPE-denominated candles) > DEX Screener
// (price only; it has no USD price for HYPE, so its volume/liquidity are not used). Nothing is ever synthesized:
// a missing value stays undefined and a missing candle series stays empty.
import { Connection, PublicKey } from "@solana/web3.js";
import { DynamicBondingCurveClient, DYNAMIC_BONDING_CURVE_PROGRAM_ID, type VirtualPool, type PoolConfig } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { CpAmm, getPriceFromSqrtPrice } from "@meteora-ag/cp-amm-sdk";
import { query } from "./db";
import { HYPE_MINT } from "./quote-assets";

export const TIMEFRAMES = {
  "1m": { path: "minute", aggregate: 1, ttl: 60_000 },
  "5m": { path: "minute", aggregate: 5, ttl: 60_000 },
  "15m": { path: "minute", aggregate: 15, ttl: 90_000 },
  "1h": { path: "hour", aggregate: 1, ttl: 120_000 },
  "4h": { path: "hour", aggregate: 4, ttl: 300_000 },
  "1d": { path: "day", aggregate: 1, ttl: 600_000 },
} as const;
export type Timeframe = keyof typeof TIMEFRAMES;
export const isTimeframe = (v: unknown): v is Timeframe => typeof v === "string" && v in TIMEFRAMES;

export type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number };
export type Market = {
  source?: string;
  pool?: string;
  protocol?: string;
  priceHype?: number;
  priceUsd?: number;
  hypeUsd?: number;
  volume24hHype?: number;
  volume24hUsd?: number;
  change24h?: number;
  trades24h?: number;
  liquidityHype?: number;
  liquidityUsd?: number;
  liquiditySource?: string;
  marketCapHype?: number;
  fdvUsd?: number;
  graduationPercent?: number;
  updatedAt: string;
  stale?: boolean;
  pairUrl?: string;
  indexing?: boolean;
};

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : undefined);

// GeckoTerminal's free API is rate-limited (observed well under 30 calls/minute). All calls go through one queue with a minimum gap,
// and every result is cached; on a rate limit or outage the last good value is served and marked stale.
const GECKO = "https://api.geckoterminal.com/api/v2/networks/solana";
const GAP_MS = 3_000;
const STALE_MS = 15 * 60_000;
let queue: Promise<unknown> = Promise.resolve();
let lastCall = 0;
const cache = new Map<string, { at: number; value: unknown }>();
async function gecko<T>(path: string, ttl: number): Promise<{ value: T; stale: boolean }> {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < ttl) return { value: hit.value as T, stale: false };
  const run = queue.then(async () => {
    const again = cache.get(path);
    if (again && Date.now() - again.at < ttl) return again.value as T;
    const wait = lastCall + GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCall = Date.now();
    const r = await fetch(`${GECKO}${path}`, { headers: { accept: "application/json;version=20230203" }, signal: AbortSignal.timeout(8000), cache: "no-store" });
    if (!r.ok) throw Error(r.status === 429 ? "GeckoTerminal rate limit" : `GeckoTerminal HTTP ${r.status}`);
    const value = (await r.json()) as T;
    cache.set(path, { at: Date.now(), value });
    return value;
  });
  queue = run.catch(() => undefined);
  try {
    return { value: await run, stale: false };
  } catch (error) {
    if (hit && Date.now() - hit.at < STALE_MS) return { value: hit.value as T, stale: true };
    throw error;
  }
}

type GeckoPool = {
  attributes?: {
    address?: string;
    base_token_price_quote_token?: string;
    base_token_price_usd?: string;
    quote_token_price_usd?: string;
    fdv_usd?: string;
    reserve_in_usd?: string;
    price_change_percentage?: { h24?: string };
    volume_usd?: { h24?: string };
    transactions?: { h24?: { buys?: number; sells?: number } };
  };
  relationships?: { base_token?: { data?: { id?: string } }; quote_token?: { data?: { id?: string } } };
};

/** The pool recorded for a confirmed HYMET launch (DAMM v2 after migration, otherwise DBC). */
export async function verifiedPool(mint: string) {
  const r = await query<{ pool_address: string; protocol: string; status: string }>(
    `SELECT p.pool_address,p.protocol,p.status FROM pools p JOIN tokens t USING(mint_address)
      WHERE t.mint_address=$1 AND t.quote_mint=$2 AND t.status IN ('bonding','graduating','graduated') AND p.status IN ('active','migrated')
      ORDER BY CASE WHEN p.protocol='meteora_damm_v2' THEN 0 ELSE 1 END LIMIT 1`,
    [mint, HYPE_MINT.toBase58()],
  );
  return r.rows[0];
}

function poolMatches(p: GeckoPool | undefined, mint: string) {
  return (
    p?.relationships?.base_token?.data?.id?.toLowerCase() === `solana_${mint}`.toLowerCase() &&
    p.relationships?.quote_token?.data?.id?.toLowerCase() === `solana_${HYPE_MINT.toBase58()}`.toLowerCase()
  );
}

/** On-chain HYPE held by a DBC pool, its graduation progress, and the decoded state. */
export async function dbcReserves(c: Connection, pool: string) {
  const sdk = new DynamicBondingCurveClient(c, "confirmed");
  const account = await c.getAccountInfo(new PublicKey(pool), "confirmed");
  if (!account?.owner.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID)) throw Error("Pool is not DBC-owned");
  const state = sdk.program.coder.accounts.decode<VirtualPool>("virtualPool", account.data).poolState;
  const cfgAccount = await c.getAccountInfo(state.config, "confirmed");
  if (!cfgAccount?.owner.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID)) throw Error("Pool config is not DBC-owned");
  const config = sdk.program.coder.accounts.decode<PoolConfig>("poolConfig", cfgAccount.data);
  if (!config.quoteMint.equals(HYPE_MINT)) throw Error("Pool quote is not HYPE");
  const quote = BigInt(state.quoteReserve.toString()),
    threshold = BigInt(config.migrationQuoteThreshold.toString());
  return {
    quoteReserveHype: Number(quote) / 1e9,
    graduationPercent: threshold > 0n ? Math.min(100, Number((quote * 10000n) / threshold) / 100) : undefined,
    migrated: state.isMigrated === 1,
  };
}

/** On-chain HYPE in a graduated launch's DAMM v2 pool and its spot price (HYPE per token) from sqrt price. */
export async function dammReserves(c: Connection, pool: string, mint: string) {
  const state = await new CpAmm(c).fetchPoolState(new PublicKey(pool));
  if (state.tokenAMint.toBase58() !== mint || !state.tokenBMint.equals(HYPE_MINT)) throw Error("DAMM v2 pool mint pair does not match");
  const [vault, mintInfo] = await Promise.all([c.getTokenAccountBalance(state.tokenBVault, "confirmed"), c.getParsedAccountInfo(state.tokenAMint, "confirmed")]);
  const decimals = (mintInfo.value?.data as { parsed?: { info?: { decimals?: number } } })?.parsed?.info?.decimals;
  if (decimals === undefined) throw Error("Token decimals unavailable");
  return { quoteReserveHype: Number(vault.value.amount) / 1e9, priceHype: Number(getPriceFromSqrtPrice(state.sqrtPrice, decimals, 9).toString()) };
}

export async function marketSnapshot(mint: string, c: Connection): Promise<Market> {
  const verified = await verifiedPool(mint);
  if (!verified) throw Object.assign(Error("Mint is not a verified HYMET launch"), { status: 404 });
  const result: Market = { pool: verified.pool_address, protocol: verified.protocol, updatedAt: new Date().toISOString() };
  try {
    const { value, stale } = await gecko<{ data?: GeckoPool }>(`/pools/${encodeURIComponent(verified.pool_address)}`, 60_000);
    const pool = value.data;
    if (poolMatches(pool, mint)) {
      const a = pool!.attributes || {};
      const hypeUsd = num(a.quote_token_price_usd),
        volumeUsd = num(a.volume_usd?.h24),
        fdvUsd = num(a.fdv_usd);
      const tx = a.transactions?.h24;
      Object.assign(result, {
        source: "GeckoTerminal",
        stale,
        priceHype: num(a.base_token_price_quote_token),
        priceUsd: num(a.base_token_price_usd),
        hypeUsd,
        volume24hUsd: volumeUsd,
        volume24hHype: hypeUsd && volumeUsd !== undefined ? volumeUsd / hypeUsd : undefined,
        change24h: num(a.price_change_percentage?.h24),
        trades24h: tx && Number.isFinite(tx.buys) && Number.isFinite(tx.sells) ? tx.buys! + tx.sells! : undefined,
        fdvUsd,
        marketCapHype: hypeUsd && fdvUsd !== undefined ? fdvUsd / hypeUsd : undefined,
        liquidityUsd: num(a.reserve_in_usd),
        liquiditySource: "GeckoTerminal reserve",
        pairUrl: `https://www.geckoterminal.com/solana/pools/${encodeURIComponent(verified.pool_address)}`,
      });
    }
  } catch {
    /* Provider unavailable; fall back below. */
  }
  if (result.priceHype === undefined) {
    try {
      const r = await fetch(`https://api.dexscreener.com/token-pairs/v1/solana/${encodeURIComponent(mint)}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000), cache: "no-store" });
      const pairs = r.ok ? ((await r.json()) as { pairAddress?: string; priceNative?: string; url?: string }[]) : [];
      const pair = Array.isArray(pairs) ? pairs.find((p) => p.pairAddress === verified.pool_address) : undefined;
      if (pair && num(pair.priceNative) !== undefined) Object.assign(result, { source: "DEX Screener", priceHype: num(pair.priceNative), pairUrl: pair.url });
    } catch {
      /* Price stays unknown. */
    }
  }
  if (verified.protocol === "meteora_dbc") {
    try {
      const reserves = await dbcReserves(c, verified.pool_address);
      result.liquidityHype = reserves.quoteReserveHype;
      result.graduationPercent = reserves.graduationPercent;
      // On-chain HYPE in the bonding curve is the real, withdrawable-by-trade liquidity.
      if (result.hypeUsd !== undefined) {
        result.liquidityUsd = reserves.quoteReserveHype * result.hypeUsd;
        result.liquiditySource = "On-chain HYPE reserve";
      }
    } catch {
      /* Keep provider liquidity if the RPC read fails. */
    }
  }
  if (verified.protocol === "meteora_damm_v2") {
    try {
      const reserves = await dammReserves(c, verified.pool_address, mint);
      result.liquidityHype = reserves.quoteReserveHype;
      result.graduationPercent = 100;
      // Providers stay preferred; the pool's own sqrt price fills in until they index it.
      if (result.priceHype === undefined) Object.assign(result, { priceHype: reserves.priceHype, source: "On-chain DAMM v2 pool" });
      if (result.hypeUsd !== undefined) {
        result.liquidityUsd = reserves.quoteReserveHype * result.hypeUsd;
        result.liquiditySource = "On-chain HYPE in DAMM v2 vault";
      }
    } catch {
      /* Keep provider values if the RPC read fails. */
    }
  }
  result.indexing = result.priceHype === undefined;
  return result;
}

export async function poolCandles(pool: string, tf: Timeframe): Promise<{ candles: Candle[]; stale: boolean }> {
  const t = TIMEFRAMES[tf];
  const { value, stale } = await gecko<{ data?: { attributes?: { ohlcv_list?: unknown[][] } } }>(
    `/pools/${encodeURIComponent(pool)}/ohlcv/${t.path}?aggregate=${t.aggregate}&limit=300&currency=token&token=base`,
    t.ttl,
  );
  // currency=token: prices are HYPE per base token and volume is in HYPE.
  const candles = (value.data?.attributes?.ohlcv_list || [])
    .filter((v) => v.length >= 6 && v.slice(0, 6).every((n) => typeof n === "number" && Number.isFinite(n)) && (v[2] as number) >= (v[3] as number))
    .map((v) => ({ time: v[0] as number, open: v[1] as number, high: v[2] as number, low: v[3] as number, close: v[4] as number, volume: v[5] as number }))
    .sort((a, b) => a.time - b.time);
  return { candles, stale };
}

/** Explore directory metrics: one batched GeckoTerminal call and one batched RPC read for up to 30 pools. */
export async function directoryMetrics(rows: { mint: string; pool: string; protocol: string }[], c: Connection) {
  const out = new Map<string, { volume24hHype?: number; liquidityHype?: number; liquidityUsd?: number; priceHype?: number; marketCapUsd?: number; dbcMigrated?: boolean }>();
  const list = rows.slice(0, 30);
  if (!list.length) return out;
  let hypeUsd: number | undefined;
  try {
    const { value } = await gecko<{ data?: GeckoPool[] }>(`/pools/multi/${list.map((r) => encodeURIComponent(r.pool)).join(",")}`, 120_000);
    for (const p of value.data || []) {
      const row = list.find((r) => r.pool === p.attributes?.address);
      if (!row || !poolMatches(p, row.mint)) continue;
      const a = p.attributes || {},
        usd = num(a.quote_token_price_usd),
        vol = num(a.volume_usd?.h24),
        marketCapUsd = num(a.fdv_usd);
      hypeUsd ??= usd;
      out.set(row.mint, { priceHype: num(a.base_token_price_quote_token), volume24hHype: usd && vol !== undefined ? vol / usd : undefined, liquidityUsd: num(a.reserve_in_usd), marketCapUsd });
    }
  } catch {
    /* Directory shows "—" for provider metrics. */
  }
  try {
    const dbc = list.filter((r) => r.protocol === "meteora_dbc");
    const sdk = new DynamicBondingCurveClient(c, "confirmed");
    const accounts = await c.getMultipleAccountsInfo(dbc.map((r) => new PublicKey(r.pool)), "confirmed");
    accounts.forEach((account, i) => {
      if (!account?.owner.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID)) return;
      const state = sdk.program.coder.accounts.decode<VirtualPool>("virtualPool", account.data).poolState;
      if (state.baseMint.toBase58() !== dbc[i].mint) return;
      const liquidityHype = Number(BigInt(state.quoteReserve.toString())) / 1e9;
      const prev = out.get(dbc[i].mint) || {};
      out.set(dbc[i].mint, { ...prev, liquidityHype, liquidityUsd: hypeUsd !== undefined ? liquidityHype * hypeUsd : prev.liquidityUsd, dbcMigrated: state.isMigrated === 1 });
    });
  } catch {
    /* On-chain liquidity unavailable. */
  }
  for (const r of list.filter((r) => r.protocol === "meteora_damm_v2")) {
    try {
      const { quoteReserveHype, priceHype } = await dammReserves(c, r.pool, r.mint);
      const prev = out.get(r.mint) || {};
      out.set(r.mint, { ...prev, priceHype: prev.priceHype ?? priceHype, liquidityHype: quoteReserveHype, liquidityUsd: hypeUsd !== undefined ? quoteReserveHype * hypeUsd : prev.liquidityUsd });
    } catch {
      /* On-chain DAMM v2 liquidity unavailable for this pool. */
    }
  }
  return out;
}
