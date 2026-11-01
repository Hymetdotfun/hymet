import { afterEach, describe, expect, it, vi } from "vitest";
import { assertMainnetTransactionsEnabled, mainnetTransactionsEnabled } from "../lib/app-network";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Mainnet transaction switches", () => {
  it("are off by default and in the committed env template", async () => {
    expect(mainnetTransactionsEnabled()).toBe(false);
    const template = (await import("node:fs")).readFileSync(".env.example", "utf8");
    expect(template).toMatch(/^NEXT_PUBLIC_ENABLE_MAINNET=false$/m);
    expect(template).toMatch(/^ENABLE_MAINNET=false$/m);
  });

  it("server-side callers require both switches", () => {
    vi.stubEnv("NEXT_PUBLIC_ENABLE_MAINNET", "true");
    vi.stubEnv("ENABLE_MAINNET", "false");
    expect(() => assertMainnetTransactionsEnabled()).toThrow("must both be true");
    vi.stubEnv("NEXT_PUBLIC_ENABLE_MAINNET", "false");
    vi.stubEnv("ENABLE_MAINNET", "true");
    expect(mainnetTransactionsEnabled()).toBe(false);
    vi.stubEnv("NEXT_PUBLIC_ENABLE_MAINNET", "true");
    expect(mainnetTransactionsEnabled()).toBe(true);
  });

  it("the browser gate needs NEXT_PUBLIC_ENABLE_MAINNET (ENABLE_MAINNET is enforced by /api/rpc)", () => {
    vi.stubGlobal("window", {});
    expect(mainnetTransactionsEnabled()).toBe(false);
    vi.stubEnv("NEXT_PUBLIC_ENABLE_MAINNET", "true");
    expect(mainnetTransactionsEnabled()).toBe(true);
  });
});

describe("server switch at the RPC proxy", () => {
  it("refuses every call, including pre-signing reads and simulation, unless ENABLE_MAINNET=true", async () => {
    const { NextRequest } = await import("next/server");
    const { POST } = await import("../app/api/rpc/route");
    const fetcher = vi.spyOn(globalThis, "fetch");
    vi.stubEnv("NEXT_PUBLIC_ENABLE_MAINNET", "true");
    vi.stubEnv("ENABLE_MAINNET", "false");
    for (const method of ["getGenesisHash", "simulateTransaction", "sendTransaction"]) {
      const response = await POST(
        new NextRequest("http://localhost/api/rpc?network=mainnet-beta", {
          method: "POST",
          headers: { origin: "http://localhost", "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }),
        }),
      );
      expect(response.status).toBe(403);
      expect(await response.text()).toBe("Mainnet disabled");
    }
    expect(fetcher).not.toHaveBeenCalled();
    fetcher.mockRestore();
  });
});
