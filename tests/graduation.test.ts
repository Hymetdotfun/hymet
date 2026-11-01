import { beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import BN from "bn.js";

const h = vi.hoisted(() => ({
  rows: [] as { status: string; pool_address: string; protocol: string; pool_status: string }[],
  updates: [] as string[],
  tx: [] as string[],
  view: { label: "Bonding Curve Active", venue: "DBC" } as { label: string; venue: string; destination?: string; detail?: string },
  mint: undefined as unknown,
  hype: undefined as unknown,
}));
vi.mock("../lib/db", () => ({
  query: async (sql: string) => (sql.startsWith("SELECT") ? { rows: h.rows } : (h.updates.push(sql), { rows: [] })),
  databasePool: async () => ({ connect: async () => ({ query: async (sql: string) => (h.tx.push(sql), { rows: [] }), release: () => {} }) }),
}));
vi.mock("../lib/migration", () => ({ readMigration: async () => h.view }));
const DBC_ID = new PublicKey("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");
const HYPE = new PublicKey("98sMhvDwXj1RQi5c5Mndm3vPe9cBqPrbLaufMXFNMh5g");
const mint = Keypair.generate().publicKey, dbcPool = Keypair.generate().publicKey, damm = Keypair.generate().publicKey;
h.mint = mint; h.hype = HYPE;
vi.mock("@meteora-ag/dynamic-bonding-curve-sdk", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  // Only account decoding is stubbed; the DBC pool/config bytes are not under test here.
  DynamicBondingCurveClient: class {
    program = { coder: { accounts: { decode: (name: string) => (name === "virtualPool" ? { poolState: { baseMint: h.mint, config: h.mint } } : { quoteMint: h.hype }) } } };
  },
}));
import { syncGraduation } from "../lib/graduation";
import { dammFeeError } from "../lib/damm-swap";

const migrationTx = { transaction: { message: { getAccountKeys: () => ({ keySegments: () => [[DBC_ID, damm, dbcPool]] }) } }, meta: { err: null, logMessages: ["Program log: Instruction: MigrationDammV2"], loadedAddresses: undefined } };
const connection = (history = true) => ({
  getAccountInfo: async () => ({ owner: DBC_ID, data: Buffer.alloc(8) }),
  getSignaturesForAddress: async () => (history ? [{ signature: "MIGRATIONSIG", slot: 77, err: null }] : []),
  getTransaction: async () => migrationTx,
}) as never;

beforeEach(() => {
  h.rows = [{ status: "bonding", pool_address: dbcPool.toBase58(), protocol: "meteora_dbc", pool_status: "active" }];
  h.updates = []; h.tx = [];
  h.view = { label: "Bonding Curve Active", venue: "DBC" };
});

describe("verified DBC -> DAMM v2 graduation sync", () => {
  it("leaves an active bonding curve untouched", async () => {
    expect(await syncGraduation(connection(), mint.toBase58())).toEqual({ status: "unchanged" });
    expect([...h.updates, ...h.tx]).toEqual([]);
  });

  it("marks a curve that reached its threshold as graduating, without inventing a pool", async () => {
    h.view = { label: "Migration Eligible", venue: "DBC" };
    expect((await syncGraduation(connection(), mint.toBase58())).status).toBe("graduating");
    expect(h.updates).toEqual(["UPDATE tokens SET status='graduating' WHERE mint_address=$1 AND status='bonding'"]);
    expect(h.tx).toEqual([]);
  });

  it("records the verified DAMM v2 pool, migrated DBC pool, graduated token and the migration event atomically", async () => {
    h.view = { label: "Migrated to DAMM V2", venue: "DAMM V2", destination: damm.toBase58(), detail: "verified" };
    expect(await syncGraduation(connection(), mint.toBase58())).toEqual({ status: "graduated", dammPool: damm.toBase58(), signature: "MIGRATIONSIG" });
    expect(h.tx[0]).toBe("BEGIN");
    expect(h.tx.at(-1)).toBe("COMMIT");
    expect(h.tx.some((s) => s.startsWith("INSERT INTO pools") && s.includes("meteora_damm_v2"))).toBe(true);
    expect(h.tx.some((s) => s.startsWith("UPDATE pools SET status='migrated'"))).toBe(true);
    expect(h.tx.some((s) => s.startsWith("INSERT INTO migration_events"))).toBe(true);
  });

  it("still records the verified pool when the RPC no longer serves the migration transaction", async () => {
    h.view = { label: "Migrated to DAMM V2", venue: "DAMM V2", destination: damm.toBase58(), detail: "verified" };
    expect((await syncGraduation(connection(false), mint.toBase58())).signature).toBeUndefined();
    expect(h.tx.some((s) => s.startsWith("INSERT INTO pools"))).toBe(true);
    expect(h.tx.some((s) => s.startsWith("INSERT INTO migration_events"))).toBe(false);
  });

  it.each([
    ["unverified destination", { label: "Migrated to DAMM V2", venue: "Unknown", detail: "Destination unverified: RPC unavailable" }],
    ["disabled destination", { label: "Migrated to DAMM V2", venue: "DAMM V2", destination: "x", detail: "Destination pool is disabled" }],
    ["unknown flags", { label: "Unknown", venue: "Unknown" }],
  ])("never writes on %s", async (_n, view) => {
    h.view = view;
    expect((await syncGraduation(connection(), mint.toBase58())).status).toBe("unchanged");
    expect([...h.updates, ...h.tx]).toEqual([]);
  });

  it("is a no-op once the DAMM v2 pool is indexed", async () => {
    h.rows.push({ status: "graduated", pool_address: damm.toBase58(), protocol: "meteora_damm_v2", pool_status: "active" });
    h.view = { label: "Migrated to DAMM V2", venue: "DAMM V2", destination: damm.toBase58() };
    expect((await syncGraduation(connection(), mint.toBase58())).status).toBe("unchanged");
    expect(h.tx).toEqual([]);
  });
});

describe("DAMM v2 fee guard", () => {
  const fee = (cliff: bigint, extra: Partial<{ mode: number; tail: number; dynamic: number; collect: number; compounding: number }> = {}) => {
    const data = Buffer.alloc(32); data.writeBigUInt64LE(cliff); data[8] = extra.mode ?? 0; if (extra.tail) data[20] = extra.tail;
    return { poolFees: { baseFee: { baseFeeInfo: { data: [...data] } }, dynamicFee: { initialized: extra.dynamic ?? 0 }, compoundingFeeBps: extra.compounding ?? 0 }, collectFeeMode: extra.collect ?? 1, sqrtPrice: new BN(0) } as never;
  };
  it("accepts the launch's flat 1% fee collected in HYPE", () => expect(dammFeeError(fee(10_000_000n), 100)).toBeNull());
  it.each([
    ["a different fee", fee(25_000_000n), /1%/],
    ["a fee scheduler", fee(10_000_000n, { tail: 1 }), /flat/],
    ["a non-time base fee mode", fee(10_000_000n, { mode: 2 }), /flat/],
    ["a dynamic fee", fee(10_000_000n, { dynamic: 1 }), /dynamic/],
    ["fees in both tokens", fee(10_000_000n, { collect: 0 }), /HYPE/],
    ["compounding fees", fee(10_000_000n, { compounding: 5000 }), /compounds/],
  ])("rejects %s", (_n, pool, reason) => expect(dammFeeError(pool, 100)).toMatch(reason));
});
