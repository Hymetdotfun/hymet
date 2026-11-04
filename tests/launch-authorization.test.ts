import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createPrivateKey, randomUUID, sign } from "node:crypto";
import { Keypair } from "@solana/web3.js";
import { launchAuthorizationFresh, launchAuthorizationMessage } from "../lib/launch-authorization";
import { holderSplitsAvailable, parseLaunchAllocationPolicy } from "../lib/launch-allocation-ui";

const h = vi.hoisted(() => ({ active: 0, inserts: [] as unknown[][], fail: null as null | { code: string } }));
vi.mock("../lib/db", () => ({
  databasePool: async () => ({
    connect: async () => ({
      query: async (sql: string, values: unknown[]) => {
        if (sql.includes("count(*)")) return { rows: [{ active: h.active }] };
        if (sql.includes("INSERT INTO launch_reservations")) {
          if (h.fail) throw h.fail;
          h.inserts.push(values);
        }
        return { rows: [] };
      },
      release: () => {},
    }),
  }),
}));
import { POST } from "../app/api/launch/reserve/route";

const privateKey = (k: Keypair) => createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(k.secretKey.subarray(0, 32))]), format: "der", type: "pkcs8" });
function request(k: Keypair, name: string, ticker: string, over: Record<string, string> = {}) {
  const issuedAt = new Date().toISOString(), nonce = randomUUID();
  const body = { name, ticker, wallet: k.publicKey.toBase58(), issuedAt, nonce, ...over };
  const signature = sign(null, Buffer.from(launchAuthorizationMessage({ origin: "http://localhost", wallet: body.wallet, name, ticker, nonce: body.nonce, issuedAt: body.issuedAt })), privateKey(k)).toString("base64");
  return new NextRequest("http://localhost/api/launch/reserve", { method: "POST", headers: { origin: "http://localhost", "content-type": "application/json" }, body: JSON.stringify({ ...body, signature, ...(over.name ? { name: over.name } : {}) }) });
}

describe("launches identified by mint, not name", () => {
  beforeEach(() => {
    h.active = 0; h.inserts.length = 0; h.fail = null;
    vi.stubEnv("NEXT_PUBLIC_ENABLE_MAINNET", "true");
    vi.stubEnv("ENABLE_MAINNET", "true");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("lets any wallet use any name, including HYMET, and more than one wallet the same one", async () => {
    for (const k of [Keypair.generate(), Keypair.generate()]) {
      const response = await POST(request(k, "HYMET", "HYMET"));
      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({ name: "HYMET", ticker: "HYMET", reservationId: expect.any(String) });
    }
    expect(h.inserts).toHaveLength(2);
  });

  it("removes every name and ticker uniqueness rule in the migration", () => {
    const sql = readFileSync("migrations/010_mint_identity.sql", "utf8");
    for (const rule of ["launch_reservations_active_name_key", "launch_reservations_active_ticker_key", "tokens_name_key_key", "tokens_ticker_key_key"]) expect(sql).toContain(rule);
    expect(sql).not.toMatch(/CREATE UNIQUE/i);
  });

  it("still limits open launch requests per wallet", async () => {
    h.active = 3;
    const response = await POST(request(Keypair.generate(), "Spam", "SPAM"));
    expect(response.status).toBe(429);
    expect(h.inserts).toEqual([]);
  });

  it("still refuses a repeated submission", async () => {
    h.fail = { code: "23505" };
    const response = await POST(request(Keypair.generate(), "Again", "AGAIN"));
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/already submitted/);
  });

  it("refuses a signature for another name, and a bad or stale authorization", async () => {
    const k = Keypair.generate();
    expect((await POST(request(k, "Signed", "SIGN", { name: "Swapped" }))).status).toBe(403);
    expect((await POST(request(k, "Old", "OLD", { issuedAt: new Date(Date.now() - 400_000).toISOString() }))).status).toBe(400);
    expect(launchAuthorizationFresh(new Date().toISOString(), "not-a-nonce")).toBe(false);
  });

  it("signs one message that covers the launch and the upload", () => {
    const terminal = readFileSync("components/terminal.tsx", "utf8");
    expect(terminal.match(/wallet\.signMessage\(/g)).toHaveLength(1);
    expect(terminal).toContain("launchAuthorizationMessage(");
    const metadata = readFileSync("app/api/metadata/route.ts", "utf8");
    expect(metadata).toContain("launchAuthorizationMessage(");
    expect(metadata).toContain("verify(");
  });
});

describe("holder allocation slider", () => {
  const policy = parseLaunchAllocationPolicy({
    field: "values.creatorShare", format: 'integer string "0".."100" (no leading zeros, decimals or signs)', unit: "percent of the creator-controlled 80%; holders receive 100 - creatorShare",
    min: 0, max: 100, step: 1, default: 100, platformBps: 2000, launchMode: "distributor", holderAllocationsEnabled: true,
  });
  it("opens 0 to 100% once the deployed distributor is verified, whether or not launches are open", () => {
    expect(holderSplitsAvailable("PROGRAM", true, policy)).toBe(true);
    expect(policy).toMatchObject({ min: 0, max: 100, platformBps: 2000 });
  });
  it("stays locked without the program, the verified distributor or the server policy", () => {
    expect(holderSplitsAvailable("", true, policy)).toBe(false);
    expect(holderSplitsAvailable("PROGRAM", false, policy)).toBe(false);
    expect(holderSplitsAvailable("PROGRAM", true, undefined)).toBe(false);
    expect(holderSplitsAvailable("PROGRAM", true, { ...policy, holderAllocationsEnabled: false, min: 100 })).toBe(false);
  });
  it("still blocks submitting while launches are closed, and binds the split on-chain", () => {
    const terminal = readFileSync("components/terminal.tsx", "utf8");
    expect(terminal).toMatch(/if \(!mainnetTransactionsEnabled\(\)\) throw Error\("Launches are not open yet"\)/);
    expect(readFileSync("lib/transactions.ts", "utf8")).toMatch(/createDistributorPool\(distributorProgram, mint\.publicKey, creator, [^)]*\), bps\(v\.creatorShare\)\)/);
  });
});
