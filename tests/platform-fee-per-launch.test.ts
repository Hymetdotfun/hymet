import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";

const WALLET = new PublicKey("7sAoyG3ZdewKrZKLzU8VTpfzNh6YuJKQAgnWjgjSqPEs");
const native = Keypair.generate().publicKey.toBase58(), distributor = Keypair.generate().publicKey.toBase58(), mint = Keypair.generate().publicKey.toBase58();
const h = vi.hoisted(() => ({ rows: [] as unknown[], queries: [] as string[], prepared: [] as string[], read: vi.fn() }));

vi.mock("../lib/db", () => ({
  databaseConfigured: () => true,
  query: async (sql: string, values: unknown[]) => {
    h.queries.push(sql);
    if (sql.includes("p.pool_address=$1")) return { rows: values[0] === native ? [{ pool_address: native }] : [] };
    return { rows: h.rows };
  },
}));
vi.mock("../lib/platform-fee-auth-server", () => ({ verifyPlatformFeeAuthorization: () => WALLET }));
vi.mock("../lib/transactions", () => ({ configuredPlatformFeeRecipient: () => WALLET }));
vi.mock("../lib/app-network", () => ({ serverRpcUrl: () => "https://rpc.example", expectedGenesis: () => "GENESIS" }));
vi.mock("../lib/creator-fees", () => ({ readCreatorFees: async () => ({ migration: { venue: "DBC" } }) }));
vi.mock("../lib/damm-fees", () => ({ prepareDammClaim: vi.fn(), readDammPositions: vi.fn() }));
vi.mock("@solana/spl-token", async (original) => ({
  ...(await original<typeof import("@solana/spl-token")>()),
  unpackMint: () => ({ decimals: 9 }),
  getMint: async () => ({ decimals: 9 }),
}));
vi.mock("../lib/platform-fees", () => ({
  FEE_CLAIMER_MISMATCH: "fee claimer mismatch",
  readPlatformFees: h.read,
  preparePlatformClaim: async (_c: unknown, _n: unknown, pool: string) => {
    h.prepared.push(pool);
    const tx = new Transaction({ feePayer: new PublicKey("7sAoyG3ZdewKrZKLzU8VTpfzNh6YuJKQAgnWjgjSqPEs"), recentBlockhash: new PublicKey("9X9fnj4Uh9WC9nmxCahTVsixHZ6VGxNpMesuGhK239Px").toBase58() })
      .add(SystemProgram.transfer({ fromPubkey: new PublicKey("7sAoyG3ZdewKrZKLzU8VTpfzNh6YuJKQAgnWjgjSqPEs"), toPubkey: new PublicKey("9X9fnj4Uh9WC9nmxCahTVsixHZ6VGxNpMesuGhK239Px"), lamports: 1 }));
    return { tx, lastValidBlockHeight: 1, fee: 1n, rent: 0n, view: { base: 0n, quote: 318400n, mint } };
  },
}));
vi.mock("@solana/web3.js", async (original) => {
  const actual = await original<typeof import("@solana/web3.js")>();
  class Connection {
    getGenesisHash = async () => "GENESIS";
    getAccountInfo = async () => ({ owner: new actual.PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") });
  }
  return { ...actual, Connection };
});

const call = async (action: string, pool?: string) => {
  const { POST } = await import("../app/api/platform-fees/route");
  return POST(new NextRequest("http://localhost:4180/api/platform-fees", {
    method: "POST",
    headers: { origin: "http://127.0.0.1:4180", host: "127.0.0.1:4180", "content-type": "application/json" },
    body: JSON.stringify({ wallet: WALLET.toBase58(), action, issuedAt: "x", nonce: "x", signature: "x", ...(pool ? { pool } : {}) }),
  }));
};

describe("platform fee claims route per launch", () => {
  beforeEach(() => {
    h.queries.length = 0; h.prepared.length = 0; h.read.mockReset();
    h.rows = [{ pool_address: native, mint_address: mint, ticker: "NAT", name: "Native", decimals: 9 }];
    h.read.mockResolvedValue({ mint, quoteMint: "98sMhvDwXj1RQi5c5Mndm3vPe9cBqPrbLaufMXFNMh5g", feeClaimer: WALLET.toBase58(), base: 0n, quote: 318400n });
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each(["distributor", "native-split"])("lists native-split launches while the global mode is %s", async (mode) => {
    vi.stubEnv("HYMET_LAUNCH_MODE", mode);
    const response = await call("inspect");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]).toMatchObject({ pool: native, verified: true, claimable: true, hype: "0.000318400" });
    expect(h.queries[0]).toContain("distributor_program_id IS NULL");
  });

  it("prepares a native-split claim in distributor mode", async () => {
    vi.stubEnv("HYMET_LAUNCH_MODE", "distributor");
    const response = await call("prepare-dbc", native);
    expect(response.status).toBe(200);
    expect((await response.json()).transaction).toBeTruthy();
    expect(h.prepared).toEqual([native]);
  });

  it("refuses a distributor launch and never prepares it", async () => {
    vi.stubEnv("HYMET_LAUNCH_MODE", "distributor");
    const response = await call("prepare-dbc", distributor);
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/not a confirmed HYMET native-split/);
    expect(h.prepared).toEqual([]);
    expect(h.queries.at(-1)).toContain("distributor_program_id IS NULL");
  });

  it("hides a launch the on-chain check says is not this wallet's, and flags any other mismatch without a claim", async () => {
    vi.stubEnv("HYMET_LAUNCH_MODE", "distributor");
    h.read.mockRejectedValueOnce(Error("fee claimer mismatch"));
    expect((await (await call("inspect")).json()).rows).toEqual([]);
    h.read.mockRejectedValueOnce(Error("DBC creator trading fee share is not 80%"));
    expect((await (await call("inspect")).json()).rows[0]).toMatchObject({ verified: false, claimable: false });
  });

  it("does not depend on the global launch mode or change the signing path", () => {
    const route = readFileSync("app/api/platform-fees/route.ts", "utf8");
    expect(route).not.toContain("launchMode");
    expect(readFileSync("components/platform-fee-claims.tsx", "utf8")).toMatch(/allowWalletGuards:\s*true/);
    expect(readFileSync("lib/wallet-guards.ts", "utf8")).toContain("L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95");
  });
});
