import { beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair } from "@solana/web3.js";

const h = vi.hoisted(() => ({
  token: undefined as undefined | { status: string; damm_pool: string | null; request: string | null },
  writes: [] as { sql: string; values: unknown[] }[],
  sync: vi.fn(async () => ({ status: "unchanged" })),
}));
vi.mock("../lib/db", () => ({
  databaseConfigured: () => true,
  query: async (sql: string, values: unknown[] = []) => {
    if (sql.trimStart().startsWith("SELECT")) return { rows: h.token ? [h.token] : [] };
    h.writes.push({ sql, values });
    return { rows: [] };
  },
}));
vi.mock("../lib/graduation", () => ({ syncGraduation: h.sync }));
import { ensureGraduation, graduationState } from "../lib/graduation-request";
import { POST } from "../app/api/graduation/[mint]/route";

const mint = Keypair.generate().publicKey.toBase58();
const connection = {} as never;
beforeEach(() => {
  h.token = undefined;
  h.writes = [];
  h.sync.mockClear();
});

describe("instant graduation requests", () => {
  it("queues the keeper only when the chain shows a complete, unmigrated curve", async () => {
    h.token = { status: "graduating", damm_pool: null, request: null };
    expect((await ensureGraduation(connection, mint)).status).toBe("graduating");
    expect(h.sync).toHaveBeenCalledOnce();
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0].sql).toContain("INSERT INTO graduation_requests");
    // Idempotent: an existing request is only re-armed once finished or failed, after a delay and below the attempt cap.
    expect(h.writes[0].sql).toMatch(/status IN \('done','failed'\)[\s\S]*updated_at < now\(\)[\s\S]*attempts < \$3/);
    expect(h.writes[0].values).toEqual([mint, 45, 5]);
  });

  it.each([
    ["bonding", { status: "bonding", damm_pool: null, request: null }],
    ["graduated", { status: "graduated", damm_pool: Keypair.generate().publicKey.toBase58(), request: "done" }],
  ])("never queues a %s token", async (_name, token) => {
    h.token = token;
    await ensureGraduation(connection, mint);
    expect(h.writes).toHaveLength(0);
  });

  it("reports graduation from the verified DAMM v2 pool, not the token label", async () => {
    const damm = Keypair.generate().publicKey.toBase58();
    h.token = { status: "graduating", damm_pool: damm, request: "processing" };
    expect(await graduationState(mint)).toEqual({ status: "graduated", dammPool: damm, request: "processing" });
    h.token = undefined;
    expect(await graduationState(mint)).toEqual({ status: "unknown" });
  });

  it("rejects cross-origin and malformed requests before any chain read", async () => {
    const call = (origin: string, m: string) =>
      POST(new Request(`http://localhost/api/graduation/${m}`, { method: "POST", headers: { origin, host: "localhost" } }), { params: Promise.resolve({ mint: m }) });
    expect((await call("https://attacker.invalid", mint)).status).toBe(403);
    expect((await call("http://localhost", "not-a-mint")).status).toBe(400);
    expect(h.sync).not.toHaveBeenCalled();
  });
});
