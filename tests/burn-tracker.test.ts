import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  BURN_TRACKED_MINT,
  ORIGINAL_SUPPLY_RAW,
  TEAM_BURN_WALLETS,
  burnsInTransaction,
  formatTokens,
  percentOfOriginal,
  summarizeBurns,
  syncBurns,
  type BurnRow,
  type BurnRpc,
  type BurnStore,
  type ParsedTransaction,
} from "../lib/burn-tracker";

const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const TEAM = TEAM_BURN_WALLETS[0];
const OTHER = "So11111111111111111111111111111111111111112";
const DEAD = "1nc1nerator11111111111111111111111111111111";

type Ix = { programId: string; parsed: unknown };
const burn = (amount: string, authority = TEAM, type: "burn" | "burnChecked" = "burn", mint = BURN_TRACKED_MINT, programId = TOKEN): Ix => ({
  programId,
  parsed: { type, info: type === "burn" ? { account: "TokenAccount", mint, authority, amount } : { account: "TokenAccount", mint, authority, tokenAmount: { amount, decimals: 9 } } },
});
const transferToDead = (amount: string): Ix => ({
  programId: TOKEN,
  parsed: { type: "transferChecked", info: { source: "TokenAccount", destination: DEAD, mint: BURN_TRACKED_MINT, authority: TEAM, tokenAmount: { amount, decimals: 9 } } },
});
const swap: Ix = { programId: "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN", parsed: undefined };
function tx(signature: string, slot: number, instructions: Ix[], inner: { index: number; instructions: Ix[] }[] = [], err: unknown = null): ParsedTransaction {
  return { slot, blockTime: 1_800_000_000 + slot, meta: { err, innerInstructions: inner }, transaction: { signatures: [signature], message: { instructions } } };
}

describe("burn parsing", () => {
  it("reads top-level and inner (CPI) burns of $HYMET with exact raw amounts", () => {
    const rows = burnsInTransaction(tx("sigA", 10, [swap, burn("14358941233901201")], [{ index: 0, instructions: [burn("5", OTHER, "burnChecked")] }]));
    expect(rows.map((r) => [r.instructionPath, r.amountRaw, r.authority])).toEqual([
      ["1", 14358941233901201n, TEAM],
      ["0.0", 5n, OTHER],
    ]);
  });

  it("counts Token-2022 burns of the mint but nothing else", () => {
    expect(burnsInTransaction(tx("s", 1, [burn("7", TEAM, "burn", BURN_TRACKED_MINT, TOKEN_2022)]))).toHaveLength(1);
    expect(burnsInTransaction(tx("s", 1, [burn("7", TEAM, "burn", OTHER)]))).toEqual([]); // another mint
    expect(burnsInTransaction(tx("s", 1, [{ ...burn("7"), programId: "SomeOtherProgram1111111111111111111111111111" }]))).toEqual([]);
    expect(burnsInTransaction(tx("s", 1, [transferToDead("9000")]))).toEqual([]); // a transfer to a dead wallet is not a burn
    expect(burnsInTransaction(tx("s", 1, [burn("7")], [], { InstructionError: [0, "Custom"] }))).toEqual([]); // failed: nothing burned
  });

  it("refuses an unreadable burn rather than guessing an amount", () => {
    expect(() => burnsInTransaction(tx("s", 1, [burn("1.5")]))).toThrow("Unreadable burn amount");
  });
});

describe("amounts", () => {
  it("formats exact percentages and token amounts with integer math", () => {
    expect(percentOfOriginal(16616479118529117n)).toBe("1.6616");
    expect(percentOfOriginal(0n)).toBe("0.0000");
    expect(percentOfOriginal(ORIGINAL_SUPPLY_RAW)).toBe("100.0000");
    expect(formatTokens(16616479118529117n)).toBe("16,616,479.11");
    expect(formatTokens(16616479118529117n, 9)).toBe("16,616,479.118529117");
    expect(formatTokens(1_000_000_000n)).toBe("1");
  });
});

/** A small fake Mainnet: transactions by slot, supply derived from their burns, and a store with the database's keys. */
function chain(initial: ParsedTransaction[]) {
  const txs = [...initial];
  let tip = Math.max(...txs.map((t) => t.slot));
  let calls = { transaction: 0, signatures: 0 };
  const burnsUpTo = (slot: number) => txs.filter((t) => t.slot <= slot).flatMap((t) => burnsInTransaction(t)).reduce((s, r) => s + r.amountRaw, 0n);
  const rpc: BurnRpc = {
    async supply() { return { amountRaw: ORIGINAL_SUPPLY_RAW - burnsUpTo(tip), decimals: 9, slot: tip }; },
    async signatures(before) {
      calls.signatures++;
      const list = txs.filter((t) => t.slot <= tip).sort((a, b) => b.slot - a.slot).map((t) => ({ signature: t.transaction.signatures[0], slot: t.slot, err: t.meta?.err ?? null }));
      const start = before ? list.findIndex((s) => s.signature === before) + 1 : 0;
      return list.slice(start, start + 1000);
    },
    async transaction(signature) { calls.transaction++; return txs.find((t) => t.transaction.signatures[0] === signature) ?? null; },
  };
  const rows = new Map<string, BurnRow>();
  let checkpoint: { verifiedSlot: number; supplyRaw: bigint; burnedRaw: bigint } | null = null;
  let error = "";
  const store: BurnStore = {
    async checkpoint() { return checkpoint; },
    async indexedTotal() { return [...rows.values()].reduce((s, r) => s + r.amountRaw, 0n); },
    async insert(list) { for (const r of list) if (!rows.has(`${r.signature}|${r.instructionPath}`)) rows.set(`${r.signature}|${r.instructionPath}`, r); },
    async verified(c) { checkpoint = c; error = ""; },
    async failed(message) { error = message; },
  };
  return {
    rpc, store, rows,
    add(t: ParsedTransaction) { txs.push(t); tip = Math.max(tip, t.slot); },
    hide(signature: string) { const i = txs.findIndex((t) => t.transaction.signatures[0] === signature); const [t] = txs.splice(i, 1); return t; },
    setTip(slot: number) { tip = slot; },
    get checkpoint() { return checkpoint; },
    get error() { return error; },
    get calls() { return calls; },
    resetCalls() { calls = { transaction: 0, signatures: 0 }; },
  };
}

describe("burn indexing", () => {
  const history = () => [
    tx("launch", 100, [swap]),
    tx("teamBurn1", 110, [swap], [{ index: 0, instructions: [burn("14358941233901201")] }]),
    tx("swap1", 120, [swap]),
    tx("dead", 125, [transferToDead("500000000000")]),
    tx("otherBurn", 130, [burn("2000", OTHER, "burnChecked")]),
    tx("failedBurn", 135, [burn("999")], [], { InstructionError: [0, "Custom"] }),
    tx("teamBurn2", 140, [burn("1883800091229990")]),
  ];

  it("backfills history and verifies the index against the supply reduction", async () => {
    const x = chain(history());
    const result = await syncBurns(x.rpc, x.store);
    expect(result.status).toBe("verified");
    expect(result.burnedRaw).toBe(14358941233901201n + 2000n + 1883800091229990n);
    expect(x.checkpoint).toEqual({ verifiedSlot: 140, supplyRaw: ORIGINAL_SUPPLY_RAW - result.burnedRaw, burnedRaw: result.burnedRaw });
    expect([...x.rows.keys()].sort()).toEqual(["otherBurn|0", "teamBurn1|0.0", "teamBurn2|0"]);
  });

  it("does not read any transaction when supply has not fallen, and never counts a burn twice", async () => {
    const x = chain(history());
    await syncBurns(x.rpc, x.store);
    x.resetCalls();
    x.add(tx("swap2", 150, [swap]));
    x.add(tx("dead2", 151, [transferToDead("7")])); // a transfer to a dead wallet leaves supply unchanged
    const again = await syncBurns(x.rpc, x.store);
    expect(again.status).toBe("verified");
    expect(x.calls).toEqual({ transaction: 0, signatures: 0 });
    expect(x.checkpoint!.verifiedSlot).toBe(151);
    expect(x.rows.size).toBe(3);
  });

  it("indexes only the transactions after the checkpoint when a new burn lands", async () => {
    const x = chain(history());
    await syncBurns(x.rpc, x.store);
    x.resetCalls();
    x.add(tx("swap3", 160, [swap]));
    x.add(tx("teamBurn3", 170, [burn("373737793397926")]));
    const result = await syncBurns(x.rpc, x.store);
    expect(result.status).toBe("verified");
    expect(x.calls.transaction).toBe(2); // swap3 and teamBurn3 only
    expect(x.rows.size).toBe(4);
    expect(x.checkpoint!.burnedRaw).toBe(14358941233901201n + 2000n + 1883800091229990n + 373737793397926n);
  });

  it("re-indexing after an interrupted run keeps one row per burn", async () => {
    const x = chain(history());
    await x.store.insert(burnsInTransaction(history()[1])); // indexed before a crash, no checkpoint saved
    const result = await syncBurns(x.rpc, x.store);
    expect(result.status).toBe("verified");
    expect(x.rows.size).toBe(3);
  });

  it("stays unverified, without moving the checkpoint, when burns cannot be matched to the supply", async () => {
    const x = chain(history());
    await syncBurns(x.rpc, x.store);
    const before = x.checkpoint;
    x.add(tx("teamBurn3", 170, [burn("10")]));
    const hidden = x.hide("teamBurn3"); // the supply already fell, but the RPC does not list the burn yet
    x.setTip(170);
    const supplyDrop = { ...x.rpc, supply: async () => ({ amountRaw: (before!.supplyRaw) - 10n, decimals: 9, slot: 170 }) };
    const result = await syncBurns(supplyDrop, x.store);
    expect(result.status).toBe("unverified");
    expect(x.checkpoint).toBe(before);
    expect(x.error).toMatch(/do not match the supply reduction/);
    x.add(hidden);
    expect((await syncBurns(x.rpc, x.store)).status).toBe("verified");
    expect(x.checkpoint!.verifiedSlot).toBe(170);
  });
});

describe("team buyback burns", () => {
  it("counts only burns signed by the team wallet as team buyback burns, and only up to the verified slot", () => {
    const rows = [...burnsInTransaction(tx("t1", 10, [burn("100")])), ...burnsInTransaction(tx("o1", 20, [burn("40", OTHER)])), ...burnsInTransaction(tx("t2", 30, [burn("5")]))];
    const summary = summarizeBurns(rows, 20);
    expect(summary).toMatchObject({ burnedRaw: 140n, teamBurnedRaw: 100n, otherBurnedRaw: 40n, teamCount: 1, otherCount: 1 });
    expect(summary.recent.map((r) => [r.signature, r.team])).toEqual([["o1", false], ["t1", true]]);
  });
});

describe("database migration", () => {
  it("adds the burn tables additively with a key that prevents duplicates, and can be rolled back", () => {
    const up = readFileSync("migrations/012_token_burns.sql", "utf8");
    const down = readFileSync("migrations/rollback/012_token_burns_down.sql", "utf8");
    expect(up).toContain("PRIMARY KEY (mint_address, signature, instruction_path)");
    expect(up).toContain("amount_raw numeric(20,0) NOT NULL CHECK (amount_raw > 0)");
    expect(up).not.toMatch(/\b(DROP|ALTER|DELETE|UPDATE)\b/i);
    expect(down).toContain("DELETE FROM hymet_schema_migrations WHERE name = '012_token_burns.sql'");
  });
});
