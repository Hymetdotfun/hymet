import { afterEach, describe, expect, it, vi } from "vitest";
import { Connection } from "@solana/web3.js";

const MINT = "So11111111111111111111111111111111111111112", POOL = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const HYPE = "98sMhvDwXj1RQi5c5Mndm3vPe9cBqPrbLaufMXFNMh5g";
vi.mock("../lib/db", () => ({ query: vi.fn(async () => ({ rows: [{ pool_address: POOL, protocol: "meteora_damm_v2", status: "migrated" }], rowCount: 1 })) }));

const geckoPool = {
  data: {
    attributes: { address: POOL, base_token_price_quote_token: "0.0000000325835865", base_token_price_usd: "0.0000029", quote_token_price_usd: "89.29", volume_usd: { h24: "171.83" }, price_change_percentage: { h24: "4.776" }, fdv_usd: "2891.7", reserve_in_usd: "2905.98", transactions: { h24: { buys: 19, sells: 1 } } },
    relationships: { base_token: { data: { id: `solana_${MINT}` } }, quote_token: { data: { id: `solana_${HYPE}` } } },
  },
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
// No RPC is used for DAMM v2 pools in marketSnapshot; a dummy connection proves none is needed.
const c = {} as Connection;
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("market data normalization", () => {
  it("uses the verified pool's GeckoTerminal data and converts USD volume to HYPE", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => (String(url).includes("geckoterminal") ? json(geckoPool) : json([])));
    const { marketSnapshot } = await import("../lib/market-data");
    const m = await marketSnapshot(MINT, c);
    expect(m.source).toBe("GeckoTerminal");
    expect(m.priceHype).toBeCloseTo(3.25835865e-8);
    expect(m.volume24hHype).toBeCloseTo(171.83 / 89.29, 6);
    expect(m.trades24h).toBe(20);
    expect(m.indexing).toBe(false);
    expect(String(fetcher.mock.calls[0][0])).toContain(`/pools/${POOL}`);
    expect(fetcher.mock.calls.some(([u]) => String(u).includes("dexscreener"))).toBe(false);
  });

  it("never fabricates values when every provider fails", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => json({ status: { error_code: 429 } }, 429));
    const { marketSnapshot } = await import("../lib/market-data");
    const m = await marketSnapshot(MINT, c);
    expect(m.indexing).toBe(true);
    for (const k of ["priceHype", "priceUsd", "volume24hHype", "liquidityUsd", "change24h"] as const) expect(m[k]).toBeUndefined();
  });

  it("ignores a provider pool whose base/quote does not match the launch", async () => {
    const wrong = { data: { ...geckoPool.data, relationships: { base_token: { data: { id: "solana_Other" } }, quote_token: { data: { id: `solana_${HYPE}` } } } } };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => (String(url).includes("geckoterminal") ? json(wrong) : json([])));
    const { marketSnapshot } = await import("../lib/market-data");
    expect((await marketSnapshot(MINT, c)).priceHype).toBeUndefined();
  });

  it("returns sorted, valid candles only and serves the cached series when rate-limited", async () => {
    const list = [[300, 1, 2, 0.5, 1.5, 10], [60, 1, 1.2, 0.9, 1.1, 5], [120, 1, 0.5, 2, 1, 1], [180, 1, "x", 1, 1, 1]];
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json({ data: { attributes: { ohlcv_list: list } } }));
    const { poolCandles } = await import("../lib/market-data");
    const first = await poolCandles(POOL, "1m");
    expect(first.candles.map((x) => x.time)).toEqual([60, 300]);
    expect(String(fetcher.mock.calls[0][0])).toContain("currency=token&token=base");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 120_000);
    fetcher.mockResolvedValueOnce(json({}, 429));
    const second = await poolCandles(POOL, "1m");
    vi.useRealTimers();
    expect(second.stale).toBe(true);
    expect(second.candles).toEqual(first.candles);
  });
});
