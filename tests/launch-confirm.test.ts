import { afterEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "../app/api/launch/confirm/route";

afterEach(() => vi.unstubAllEnvs());

it("keeps confirmed registration unavailable without PostgreSQL and avoids RPC", async () => {
  vi.stubEnv("DATABASE_URL", "");
  vi.stubEnv("NEXT_PUBLIC_ENABLE_MAINNET", "true");
  vi.stubEnv("ENABLE_MAINNET", "true");
  const fetcher = vi.spyOn(globalThis, "fetch");
  const response = await POST(
    new NextRequest("http://localhost/api/launch/confirm", {
      method: "POST",
      headers: { origin: "http://localhost", "content-type": "application/json" },
      body: JSON.stringify({}),
    }),
  );
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: "PostgreSQL is not configured" });
  expect(fetcher).not.toHaveBeenCalled();
});

it("rejects cross-origin launch registration before reading launch data", async () => {
  const fetcher = vi.spyOn(globalThis, "fetch");
  const response = await POST(
    new NextRequest("http://localhost/api/launch/confirm", {
      method: "POST",
      headers: { origin: "https://attacker.example", "content-type": "application/json" },
      body: JSON.stringify({}),
    }),
  );
  expect(response.status).toBe(403);
  expect(fetcher).not.toHaveBeenCalled();
});
