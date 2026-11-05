import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST as confirm } from "../app/api/launch/confirm/route";
import { POST as claim } from "../app/api/fees/transaction/route";
import { POST as reserve } from "../app/api/launch/reserve/route";
import { POST as metadata } from "../app/api/metadata/route";
import { POST as rpc } from "../app/api/rpc/route";

const request = (path: string, body: unknown) =>
  new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { origin: "http://localhost", "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const endpoints: [string, () => Promise<Response>][] = [
  ["launch confirmation", () => confirm(request("/api/launch/confirm", {}))],
  ["creator claim", () => claim(request("/api/fees/transaction", { action: "creator", mint: "x", wallet: "x" }))],
  ["launch reservation", () => reserve(request("/api/launch/reserve", {}))],
  ["metadata upload", () => metadata(request("/api/metadata", {}))],
  ["transaction broadcast", () => rpc(request("/api/rpc", { method: "sendTransaction", params: [] }))],
];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("transaction endpoints while launches are closed", () => {
  it.each(endpoints)("%s is refused with both switches off, before any network call", async (_name, call) => {
    vi.stubEnv("NEXT_PUBLIC_ENABLE_MAINNET", "false");
    vi.stubEnv("ENABLE_MAINNET", "false");
    const fetcher = vi.spyOn(globalThis, "fetch");
    expect((await call()).status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(endpoints)("%s stays refused when only the browser switch is on", async (_name, call) => {
    vi.stubEnv("NEXT_PUBLIC_ENABLE_MAINNET", "true");
    vi.stubEnv("ENABLE_MAINNET", "false");
    const fetcher = vi.spyOn(globalThis, "fetch");
    expect((await call()).status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("Launching Soon states", () => {
  it.each(["terminal", "trade-panel", "my-tokens", "creator-fees", "damm-fees", "fee-ledger", "docs-hub"])("%s tells visitors the feature is coming", (name) => {
    expect(readFileSync(`components/${name}.tsx`, "utf8")).toContain("Launching Soon");
  });
});
