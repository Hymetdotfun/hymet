import { expect, it, vi } from "vitest";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../lib/db", () => ({
  databaseConfigured: () => true,
  query: queryMock,
}));
vi.mock("../lib/market-data", () => ({
  directoryMetrics: vi.fn(async () => new Map()),
}));

it("excludes exact server-configured mints in the public listing query", async () => {
  vi.stubEnv("HYMET_PUBLIC_TOKEN_EXCLUDED_MINTS", "So11111111111111111111111111111111111111112,TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
  queryMock.mockResolvedValue({ rows: [] });
  const { GET } = await import("../app/api/tokens/route");
  const response = await GET();
  const body = await response.json();
  const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];

  expect(response.status).toBe(200);
  expect(body.tokens).toEqual([]);
  expect(sql).toContain("t.mint_address = ANY($2::text[])");
  expect(params[1]).toEqual(["So11111111111111111111111111111111111111112", "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"]);
  vi.unstubAllEnvs();
  expect(sql).not.toContain("ticker NOT IN");
  expect(sql).not.toContain("name NOT IN");
});

it("keeps exact creator DBC lookup available for excluded launches", async () => {
  queryMock.mockResolvedValue({
    rows: [{
      mint: "So11111111111111111111111111111111111111112",
      name: "Fixture Token",
      ticker: "FIXT",
      creator: "11111111111111111111111111111111",
      pool: "11111111111111111111111111111111",
      creator_bps: 10000,
      holder_bps: 0,
    }],
  });
  const { GET } = await import("../app/api/creator-launches/route");
  const { NextRequest } = await import("next/server");
  const response = await GET(
    new NextRequest("http://localhost/api/creator-launches?wallet=11111111111111111111111111111111"),
  );
  const body = await response.json();

  expect(response.status).toBe(200);
  expect(body.launches[0]).toMatchObject({
    mint: "So11111111111111111111111111111111111111112",
    ticker: "FIXT",
    protocol: "meteora_dbc",
    // Legacy native-split launch: its original 100% creator allocation is reported unchanged.
    allocation: { creatorPercent: 100, holderPercent: 0, creatorBpsOfRemaining: 10000, holderBpsOfRemaining: 0 },
  });
  expect(body.launches[0]).not.toHaveProperty("creator_bps");
});
