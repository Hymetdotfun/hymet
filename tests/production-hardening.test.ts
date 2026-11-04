import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import nextConfig from "../next.config";
import { publicError } from "../lib/http";
import { POST as rpc } from "../app/api/rpc/route";

describe("production hardening", () => {
  it("refuses framing and hides the framework on every path", async () => {
    const config = nextConfig("phase-production-build");
    expect(config.poweredByHeader).toBe(false);
    const rules = await config.headers!();
    expect(rules[0].source).toBe("/(.*)");
    const headers = Object.fromEntries(rules[0].headers.map((h) => [h.key, h.value]));
    expect(headers["X-Frame-Options"]).toBe("DENY");
    expect(headers["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
  });

  it("does not forward RPC requests without this site's Origin", async () => {
    vi.stubEnv("NEXT_PUBLIC_ENABLE_MAINNET", "true");
    vi.stubEnv("ENABLE_MAINNET", "true");
    vi.stubEnv("MAINNET_RPC_URL", "https://rpc.example/v2/KEY");
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    const post = (headers: Record<string, string>) => rpc(new NextRequest("http://localhost/api/rpc?network=mainnet-beta", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSlot", params: [] }) }));
    expect((await post({})).status).toBe(403);
    expect((await post({ origin: "https://other.example" })).status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
    fetcher.mockRestore();
    vi.unstubAllEnvs();
  });

  it("removes URLs, which can carry API keys, from error text", () => {
    expect(publicError("failed: https://rpc.example/v2/SECRETKEY timed out")).toBe("failed: <url> timed out");
    expect(publicError("Only the creator can claim creator fees")).toBe("Only the creator can claim creator fees");
  });
});
