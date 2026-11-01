import { it, expect, vi, afterEach, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "../app/api/rpc/route";
beforeEach(() => vi.stubEnv("ENABLE_MAINNET", "true"));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
const request = (method: string, params: unknown[] = []) =>
  new NextRequest("http://localhost/api/rpc?network=mainnet-beta", {
    method: "POST",
    headers: { origin: "http://localhost", "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
it("denies rebinding hostnames even without an Origin header", async () => {
  const fetcher = vi.spyOn(globalThis, "fetch");
  const response = await POST(
    new NextRequest("http://localhost/api/rpc", {
      method: "POST",
      headers: { host: "attacker.example" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getGenesisHash" }),
    }),
  );
  expect(response.status).toBe(403);
  expect(fetcher).not.toHaveBeenCalled();
});
it("does not expose unbounded program account scans through the credentialed RPC proxy", async () => {
  const fetcher = vi.spyOn(globalThis, "fetch");
  expect(
    (
      await POST(
        request("getProgramAccounts", ["11111111111111111111111111111111"]),
      )
    ).status,
  ).toBe(400);
  expect(fetcher).not.toHaveBeenCalled();
});
it("limits batched account reads to the launcher-sized request", async () => {
  const fetcher = vi.spyOn(globalThis, "fetch");
  expect(
    (
      await POST(
        request("getMultipleAccounts", [
          Array.from({ length: 101 }, () => "11111111111111111111111111111111"),
        ]),
      )
    ).status,
  ).toBe(400);
  expect(fetcher).not.toHaveBeenCalled();
});
it("bounds upstream response bodies and does not leak upstream credentials/errors", async () => {
  vi.stubEnv(
    "MAINNET_RPC_URL",
    "https://rpc.example.test/?api-key=server-only",
  );
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(new Uint8Array(4 * 1024 * 1024 + 1)),
  );
  const response = await POST(
    request("getAccountInfo", ["11111111111111111111111111111111"]),
  );
  expect(response.status).toBe(502);
  expect(await response.text()).not.toContain("server-only");
});
it("does not forward a provider authentication error body that could contain its server-only key", async () => {
  vi.stubEnv(
    "MAINNET_RPC_URL",
    "https://rpc.example.test/?api-key=server-only",
  );
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response("Invalid key server-only", { status: 401 }),
  );
  const response = await POST(request("getGenesisHash"));
  expect(response.status).toBe(502);
  expect(await response.text()).not.toContain("server-only");
});
it("allows the SDK Token-2022 NFT owner query but rejects broader or malformed filters", async () => {
  const programId = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
  const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({
      jsonrpc: "2.0",
      id: 1,
      result: { context: { slot: 1 }, value: [] },
    }),
  );
  expect(
    (
      await POST(
        request("getTokenAccountsByOwner", [
          "11111111111111111111111111111111",
          { programId },
          { encoding: "base64" },
        ]),
      )
    ).status,
  ).toBe(200);
  expect(fetcher).toHaveBeenCalledTimes(1);
  for (const params of [
    ["invalid", { programId }],
    [
      "11111111111111111111111111111111",
      { programId: "11111111111111111111111111111111" },
    ],
    [
      "11111111111111111111111111111111",
      { programId, mint: "11111111111111111111111111111111" },
    ],
  ]) {
    expect(
      (await POST(request("getTokenAccountsByOwner", params))).status,
    ).toBe(400);
  }
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("allows the official 100-account bound needed for an atomic DAMM pool and position snapshot", async () => {
  const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({
      jsonrpc: "2.0",
      id: 1,
      result: { context: { slot: 1 }, value: [] },
    }),
  );
  expect(
    (
      await POST(
        request("getMultipleAccounts", [
          Array.from({ length: 100 }, () => "11111111111111111111111111111111"),
        ]),
      )
    ).status,
  ).toBe(200);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
