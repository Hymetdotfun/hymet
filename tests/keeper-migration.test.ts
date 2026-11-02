import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { migrationDecision } from "../lib/keeper-migration";

const HYPE = new PublicKey("98sMhvDwXj1RQi5c5Mndm3vPe9cBqPrbLaufMXFNMh5g");
const feePool = Keypair.generate().publicKey;
const state = (over: Partial<{ isMigrated: number; migrationProgress: number; quoteReserve: bigint }> = {}) => ({ isMigrated: 0, migrationProgress: 2, quoteReserve: 96_070_234_041n, ...over });
const config = (over: Partial<{ migrationQuoteThreshold: bigint; migrationOption: number; feeClaimer: PublicKey; quoteMint: PublicKey }> = {}) => ({ migrationQuoteThreshold: 96_070_234_041n, migrationOption: 1, feeClaimer: feePool, quoteMint: HYPE, ...over });

describe("keeper auto-migration decision", () => {
  it("migrates a complete HYPE curve bound to this mint's distributor fee pool", () => {
    expect(migrationDecision(state(), config(), feePool)).toEqual({ migrate: true, status: "eligible" });
    expect(migrationDecision(state({ quoteReserve: 96_070_234_043n }), config(), feePool).migrate).toBe(true);
    // Without locked vesting the curve-completing swap moves progress straight to 2, the state migrate_damm_v2 accepts.
    expect(migrationDecision(state({ migrationProgress: 0 }), config(), feePool).migrate).toBe(false);
  });

  it("waits while the curve is still bonding", () => {
    expect(migrationDecision(state({ migrationProgress: 0, quoteReserve: 48_035_117_020n }), config(), feePool)).toEqual({ migrate: false, status: "bonding 49.99%" });
    expect(migrationDecision(state({ quoteReserve: 96_070_234_040n }), config(), feePool).migrate).toBe(false);
  });

  it.each([
    ["already migrated", state({ isMigrated: 1 }), config(), "graduated"],
    ["locked vesting without a locker", state({ migrationProgress: 1 }), config(), "locked vesting requires a locker first"],
    ["an already created destination", state({ migrationProgress: 3 }), config(), "destination already created"],
    ["an unknown progress value", state({ migrationProgress: 7 }), config(), "unknown migration progress"],
    ["a foreign fee claimer (native-split or other launch)", state(), config({ feeClaimer: Keypair.generate().publicKey }), "not this mint's HYMET distributor launch"],
    ["a non-HYPE quote", state(), config({ quoteMint: Keypair.generate().publicKey }), "quote is not HYPE"],
    ["a DAMM v1 destination", state(), config({ migrationOption: 0 }), "migration destination is not DAMM v2"],
    ["a zero threshold", state(), config({ migrationQuoteThreshold: 0n }), "invalid migration threshold"],
  ])("never migrates %s", (_name, s, c, status) => {
    expect(migrationDecision(s, c, feePool)).toEqual({ migrate: false, status });
  });
});
