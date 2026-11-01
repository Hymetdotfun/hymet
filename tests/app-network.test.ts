import { afterEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "../app/api/rpc/route";
import { connection } from "../lib/transactions";
import { APP_NETWORK } from "../lib/app-network";
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
function request(query = "") {
  return new NextRequest(`http://localhost/api/rpc${query}`, {
    method: "POST",
    headers: { origin: "http://localhost", "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getGenesisHash" }),
  });
}
it("pins the browser connection to the Mainnet proxy and rejects a stale Devnet setting", () => {
  vi.stubGlobal("window", { location: { origin: "http://127.0.0.1:3000" } });
  expect(APP_NETWORK).toBe("mainnet-beta");
  expect(connection("mainnet-beta").rpcEndpoint).toBe(
    "http://127.0.0.1:3000/api/rpc?network=mainnet-beta",
  );
  expect(() => connection("devnet")).toThrow("Mainnet Beta only");
});
it("defaults omitted networks to Mainnet and never forwards stale Devnet or unknown network requests", async () => {
  vi.stubEnv("ENABLE_MAINNET", "true");
  vi.stubEnv("MAINNET_RPC_URL", "https://mainnet.example.test");
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () =>
      Response.json({ jsonrpc: "2.0", id: 1, result: "mainnet" }),
    );
  for (const q of ["?network=devnet", "?network=testnet", "?network=invalid"]) {
    expect((await POST(request(q))).status).toBe(400);
  }
  expect(fetcher).not.toHaveBeenCalled();
  expect((await POST(request())).status).toBe(200);
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(
    "https://mainnet.example.test",
    expect.any(Object),
  );
});
it("keeps Mainnet disabled if the existing owner activation flag is false", async () => {
  vi.stubEnv("ENABLE_MAINNET", "false");
  const fetcher = vi.spyOn(globalThis, "fetch");
  expect((await POST(request())).status).toBe(403);
  expect(fetcher).not.toHaveBeenCalled();
});
