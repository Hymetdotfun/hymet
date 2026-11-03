import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const db = vi.hoisted(() => ({ databasePool: vi.fn() }));
vi.mock("../lib/db", () => db);
import { POST } from "../app/api/launch/reserve/route";

const reserve = () =>
  POST(new NextRequest("http://localhost/api/launch/reserve", { method: "POST", headers: { origin: "http://localhost", "content-type": "application/json" }, body: "{}" }));

afterEach(() => {
  vi.unstubAllEnvs();
  db.databasePool.mockReset();
});

describe("launch reservations", () => {
  it("are refused while Mainnet launches are disabled, before any database access", async () => {
    vi.stubEnv("NEXT_PUBLIC_ENABLE_MAINNET", "false");
    vi.stubEnv("ENABLE_MAINNET", "false");
    const r = await reserve();
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: "Launches are not open yet" });
    expect(db.databasePool).not.toHaveBeenCalled();
  });

  it("stay closed when only the browser switch is on", async () => {
    vi.stubEnv("NEXT_PUBLIC_ENABLE_MAINNET", "true");
    vi.stubEnv("ENABLE_MAINNET", "false");
    expect((await reserve()).status).toBe(403);
    expect(db.databasePool).not.toHaveBeenCalled();
  });

  it("reach request validation once launches are open", async () => {
    vi.stubEnv("NEXT_PUBLIC_ENABLE_MAINNET", "true");
    vi.stubEnv("ENABLE_MAINNET", "true");
    const r = await reserve();
    expect(r.status).not.toBe(403);
    expect(db.databasePool).not.toHaveBeenCalled(); // "{}" fails validation before the database
  });
});
