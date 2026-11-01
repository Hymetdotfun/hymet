// Builds the "collect & settle" instructions for one distributor-bound token: DBC partner
// fees before graduation (and any residue after), then the DAMM v2 partner position.
// Shared by the fee route (wallet-signed) and the holder payout keeper.
import { Connection, PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { DynamicBondingCurveClient, DAMM_V2_MIGRATION_FEE_ADDRESS, deriveDammV2PoolAddress } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { CpAmm } from "@meteora-ag/cp-amm-sdk";
import BN from "bn.js";
import { HYPE_MINT } from "./quote-assets";
import { distributorAddresses, distributorSettlement, registerDistributorMigration } from "./distributor-engine";

const U64_MAX = new BN("18446744073709551615");

export async function settlementInstructions(
  connection: Connection,
  program: PublicKey,
  mint: PublicKey,
  dbcPool: PublicKey,
  platform: PublicKey,
  caller: PublicKey,
  /** Signer allowed to register the migrated pool: the creator or the snapshot authority. */
  registrar?: PublicKey,
): Promise<{ source: "dbc" | "damm"; instructions: TransactionInstruction[] }> {
  const a = distributorAddresses(program, mint);
  const sdk = new DynamicBondingCurveClient(connection, "confirmed");
  const pool = await sdk.state.getPool(dbcPool);
  if (!pool || !pool.poolState.baseMint.equals(mint)) throw Error("DBC mint or pool missing");
  const config = await sdk.state.getPoolConfig(pool.poolState.config);
  if (!config || !config.quoteMint.equals(HYPE_MINT) || !config.feeClaimer.equals(a.feePool)) throw Error("DBC distributor binding differs from launch");
  const instructions: TransactionInstruction[] = [
    createAssociatedTokenAccountIdempotentInstruction(caller, getAssociatedTokenAddressSync(HYPE_MINT, platform), platform, HYPE_MINT),
  ];
  // Fees accrued by the final graduation swap remain claimable in DBC.
  // Drain that liability first; the next collection then handles the DAMM position.
  if (!pool.poolState.isMigrated || pool.poolState.partnerQuoteFee.gtn(0)) {
    const claim = await sdk.partner.claimPartnerTradingFee({ feeClaimer: a.feePool, payer: caller, pool: dbcPool, maxBaseAmount: U64_MAX, maxQuoteAmount: U64_MAX });
    const ix = claim.instructions.find((i) => i.programId.equals(sdk.program.programId));
    if (!ix) throw Error("DBC claim instruction missing");
    instructions.push(distributorSettlement(program, mint, platform, caller, ix));
    return { source: "dbc", instructions };
  }
  const destination = deriveDammV2PoolAddress(DAMM_V2_MIGRATION_FEE_ADDRESS[config.migrationFeeOption], mint, HYPE_MINT);
  const cp = new CpAmm(connection);
  const damm = await cp.fetchPoolState(destination);
  if (!damm.tokenAMint.equals(mint) || !damm.tokenBMint.equals(HYPE_MINT)) throw Error("Migrated pool pair differs from DBC");
  const state = await connection.getAccountInfo(a.feePool, "confirmed");
  if (!state) throw Error("Distributor pool missing");
  const assigned = new PublicKey(state.data.subarray(104, 136));
  if (assigned.equals(PublicKey.default)) {
    if (!registrar) throw Error("Creator must register the migrated position before collection");
    instructions.push(registerDistributorMigration(program, mint, registrar, destination));
  } else if (!assigned.equals(destination)) throw Error("Registered migration destination mismatch");
  const positions = await cp.getUserPositionByPool(destination, a.feePool);
  if (positions.length !== 1) throw Error("Expected exactly one distributor-owned migration position");
  const p = positions[0];
  const claim = await cp.claimPositionFee({ owner: a.feePool, feePayer: caller, pool: destination, position: p.position, positionNftAccount: p.positionNftAccount, tokenAMint: mint, tokenBMint: HYPE_MINT, tokenAVault: damm.tokenAVault, tokenBVault: damm.tokenBVault, tokenAProgram: TOKEN_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID });
  const ix = claim.instructions.find((i) => i.programId.equals(cp._program.programId));
  if (!ix) throw Error("DAMM claim instruction missing");
  instructions.push(distributorSettlement(program, mint, platform, caller, ix, p.positionNftAccount));
  return { source: "damm", instructions };
}
