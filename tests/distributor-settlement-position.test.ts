import { describe, expect, it } from "vitest";
import BN from "bn.js";
import { pickSettlementPosition } from "../lib/distributor-settlement";

const position = (id: string, feeB: number, locked: number, feeA = 0) => ({ id, pending: { feeTokenA: new BN(feeA), feeTokenB: new BN(feeB) }, locked: new BN(locked) });

describe("DAMM v2 settlement position choice", () => {
  it("settles the migration position even when a stranger adds empty fee-pool-owned positions", () => {
    const migration = position("migration", 25_600_000, 1_000_000_000);
    expect(pickSettlementPosition([position("decoy", 0, 0), migration, position("decoy2", 0, 0)]).id).toBe("migration");
  });

  it("prefers the most pending HYPE, then the most permanently locked liquidity", () => {
    expect(pickSettlementPosition([position("locked", 5, 1_000), position("richer", 9, 1)]).id).toBe("richer");
    expect(pickSettlementPosition([position("decoy", 0, 0), position("migration", 0, 1_000)]).id).toBe("migration");
  });

  it("refuses when the fee pool owns no position", () => {
    expect(() => pickSettlementPosition([])).toThrow(/missing/);
  });
});
