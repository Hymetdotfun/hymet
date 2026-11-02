import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { Connection, Keypair, PublicKey, type Transaction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";

const h = vi.hoisted(() => ({ sources: [] as { source: "dbc" | "damm"; dammDue?: boolean }[] }));
vi.mock("../lib/distributor-settlement", () => ({
  settlementInstructions: async () => {
    const next = h.sources.shift();
    if (!next) throw Error("no settlement expected");
    return { ...next, instructions: [] };
  },
}));
import { distributorAddresses } from "../lib/distributor-engine";
import { runHolderPayouts, type KeeperContext } from "../lib/holder-keeper";

const program = new PublicKey("9X9fnj4Uh9WC9nmxCahTVsixHZ6VGxNpMesuGhK239Px");
const mint = Keypair.generate().publicKey;

function harness(dryRun = false) {
  const pool = Buffer.alloc(195);
  createHash("sha256").update("account:FeePool").digest().copy(pool, 0, 0, 8);
  mint.toBuffer().copy(pool, 40);
  pool.writeUInt16LE(5_000, 136);
  const feePool = distributorAddresses(program, mint).feePool.toBase58();
  const sent: string[] = [];
  const connection = {
    getAccountInfo: async (k: PublicKey) => (k.toBase58() === feePool ? { data: pool, owner: program, lamports: 1, executable: false } : null),
    getProgramAccounts: async () => ({ context: { slot: 1 }, value: [] }),
    getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map(() => ({ owner: TOKEN_PROGRAM_ID, data: Buffer.alloc(165) })),
  } as unknown as Connection;
  const k: KeeperContext = {
    connection, program, platform: Keypair.generate().publicKey, authority: Keypair.generate(), dryRun,
    db: { query: async () => ({ rows: [] }) },
    send: async (_tx: Transaction, label: string) => { sent.push(label); return "sig"; },
    simulate: async (_tx: Transaction, label: string) => { sent.push(`simulated ${label}`); },
    reindex: async () => { sent.push("reindex"); },
    log: () => {},
  };
  return { k, sent };
}
const token = { mint: mint.toBase58(), dbcPool: Keypair.generate().publicKey.toBase58() };
beforeEach(() => { h.sources = []; });

describe("keeper settlement right after graduation", () => {
  it("drains the last DBC fees, then registers and settles the DAMM v2 pool in the same run", async () => {
    h.sources = [{ source: "dbc", dammDue: true }, { source: "damm" }];
    const { k, sent } = harness();
    await runHolderPayouts(k, token);
    expect(sent).toEqual(["settle dbc", "settle damm"]);
    expect(h.sources).toEqual([]);
  });

  it("settles once while the curve is still bonding", async () => {
    h.sources = [{ source: "dbc", dammDue: false }, { source: "damm" }];
    const { k, sent } = harness();
    await runHolderPayouts(k, token);
    expect(sent).toEqual(["settle dbc"]);
  });

  it("simulates a single settlement in dry runs", async () => {
    h.sources = [{ source: "dbc", dammDue: true }, { source: "damm" }];
    const { k, sent } = harness(true);
    await runHolderPayouts(k, token);
    expect(sent).toEqual(["simulated settle dbc"]);
  });
});
