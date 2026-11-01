import { describe, expect, it } from "vitest";
import BN from "bn.js";
import { Connection, Keypair } from "@solana/web3.js";
import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { CpAmm } from "@meteora-ag/cp-amm-sdk";
import { dammPositionFeeClaimData, dbcPartnerClaimData } from "../lib/distributor-cpi";

const connection = new Connection("http://127.0.0.1:8899", "confirmed");
function accounts(names: string[]) { return Object.fromEntries(names.map((name) => [name, Keypair.generate().publicKey])); }

describe("distributor Meteora CPI construction", () => {
  it("matches the pinned DBC partner-fee claim discriminator, args, account order and signer flags", async () => {
    const program = new DynamicBondingCurveClient(connection).program;
    const instruction = program.idl.instructions.find((item) => item.name === "claimTradingFee")!;
    const supplied = accounts(instruction.accounts.map((item) => item.name));
    const ix = await program.methods.claimTradingFee(new BN("18446744073709551615"), new BN("18446744073709551615")).accountsPartial(supplied).instruction();
    expect(ix.data.equals(dbcPartnerClaimData())).toBe(true);
    expect(ix.keys.map((key) => key.pubkey.toBase58())).toEqual(instruction.accounts.map((item) => supplied[item.name].toBase58()));
    expect(ix.keys.find((key) => key.pubkey.equals(supplied.feeClaimer))?.isSigner).toBe(true);
    expect(ix.programId.equals(new DynamicBondingCurveClient(connection).program.programId)).toBe(true);
  });

  it("matches the pinned DAMM v2 position fee claim account order, signer flags and discriminator", async () => {
    const program = new CpAmm(connection)._program;
    const instruction = program.idl.instructions.find((item) => item.name === "claimPositionFee")!;
    const supplied = accounts(instruction.accounts.map((item) => item.name));
    const ix = await program.methods.claimPositionFee().accountsPartial(supplied).instruction();
    expect(ix.data.equals(dammPositionFeeClaimData())).toBe(true);
    expect(ix.keys.map((key) => key.pubkey.toBase58())).toEqual(instruction.accounts.map((item) => supplied[item.name].toBase58()));
    expect(ix.keys.find((key) => key.pubkey.equals(supplied.signer))?.isSigner).toBe(true);
    expect(ix.programId.equals(new CpAmm(connection)._program.programId)).toBe(true);
  });
});
