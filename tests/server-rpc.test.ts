import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ url: "https://api.devnet.solana.com" }));
vi.mock("../lib/app-network", () => ({ DEVNET_RPC_URL: "https://api.devnet.solana.com", serverRpcUrl: () => h.url }));
import { serverConnection } from "../lib/server-rpc";

afterEach(() => vi.unstubAllGlobals());

describe("server RPC connection", () => {
  it("retries a Devnet 429 with the bounded proxy budget instead of failing the call", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response("rate limited", { status: 429, headers: { "retry-after": "1" } }))
      .mockImplementationOnce(async (_url: string, init: RequestInit) =>
        Response.json({ jsonrpc: "2.0", id: JSON.parse(String(init.body)).id, result: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG" }),
      );
    vi.stubGlobal("fetch", fetcher);
    expect(await serverConnection().getGenesisHash()).toBe("EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("keeps the plain connection for every other endpoint", () => {
    h.url = "https://api.mainnet-beta.solana.com";
    expect((serverConnection() as unknown as { _rpcEndpoint: string })._rpcEndpoint).toBe(h.url);
    h.url = "https://api.devnet.solana.com";
  });
});
