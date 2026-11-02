// Keeper step: permissionless DBC -> DAMM v2 migration for HYMET distributor launches whose bonding curve is
// complete. Same SDK instruction the app's "Migrate eligible pool" recovery action builds; the keeper only pays the
// transaction and rent. Liquidity goes to the launch's locked DAMM v2 positions exactly as configured at launch.
import { ComputeBudgetProgram, PublicKey, type Connection, type Keypair, type Transaction } from "@solana/web3.js";
import { DAMM_V2_MIGRATION_FEE_ADDRESS, DYNAMIC_BONDING_CURVE_PROGRAM_ID, DynamicBondingCurveClient, type PoolConfig, type VirtualPool } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { distributorAddresses } from "./distributor-engine";
import { HYPE_MINT } from "./quote-assets";

const DAMM_V2_OPTION = 1;

export type MigrationDecision = { migrate: boolean; status: string };

/** Pure decision: migrate only a complete, not-yet-migrated HYPE curve bound to this mint's distributor fee pool. */
export function migrationDecision(
  state: { isMigrated: number; migrationProgress: number; quoteReserve: bigint },
  config: { migrationQuoteThreshold: bigint; migrationOption: number; feeClaimer: PublicKey; quoteMint: PublicKey },
  feePool: PublicKey,
): MigrationDecision {
  if (state.isMigrated === 1) return { migrate: false, status: "graduated" };
  // DBC migration progress: 0 pre-bonding curve, 1 post-bonding curve (curves with locked vesting: a locker must be
  // created first), 2 locked vesting done (HYMET curves have no vesting, so the completing swap lands here directly;
  // this is the state migrate_damm_v2 accepts), 3 destination created (verified on Localnet pools before/after).
  if (state.migrationProgress === 3) return { migrate: false, status: "destination already created" };
  if (state.migrationProgress === 1) return { migrate: false, status: "locked vesting requires a locker first" };
  if (state.migrationProgress !== 0 && state.migrationProgress !== 2) return { migrate: false, status: "unknown migration progress" };
  if (!config.feeClaimer.equals(feePool)) return { migrate: false, status: "not this mint's HYMET distributor launch" };
  if (!config.quoteMint.equals(HYPE_MINT)) return { migrate: false, status: "quote is not HYPE" };
  if (config.migrationOption !== DAMM_V2_OPTION) return { migrate: false, status: "migration destination is not DAMM v2" };
  if (config.migrationQuoteThreshold <= 0n) return { migrate: false, status: "invalid migration threshold" };
  if (state.quoteReserve < config.migrationQuoteThreshold)
    return { migrate: false, status: `bonding ${Number((state.quoteReserve * 10_000n) / config.migrationQuoteThreshold) / 100}%` };
  if (state.migrationProgress !== 2) return { migrate: false, status: "curve complete; waiting for the DBC program to mark it ready" };
  return { migrate: true, status: "eligible" };
}

export type MigrationKeeper = {
  connection: Connection;
  program: PublicKey;
  authority: Keypair;
  dryRun: boolean;
  send: (tx: Transaction, label: string, extraSigners?: Keypair[]) => Promise<string>;
  simulate: (tx: Transaction, label: string, extraSigners?: Keypair[]) => Promise<void>;
};

export async function migrateIfEligible(k: MigrationKeeper, token: { mint: string; dbcPool: string }) {
  const mint = new PublicKey(token.mint), pool = new PublicKey(token.dbcPool);
  const sdk = new DynamicBondingCurveClient(k.connection, "confirmed");
  const account = await k.connection.getAccountInfo(pool, "confirmed");
  if (!account?.owner.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID)) throw Error("DBC pool missing");
  const state = sdk.program.coder.accounts.decode<VirtualPool>("virtualPool", account.data).poolState;
  if (!state.baseMint.equals(mint)) throw Error("DBC pool mint differs");
  const cfgAccount = await k.connection.getAccountInfo(state.config, "confirmed");
  if (!cfgAccount?.owner.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID)) throw Error("DBC config missing");
  const config = sdk.program.coder.accounts.decode<PoolConfig>("poolConfig", cfgAccount.data);
  const decision = migrationDecision(
    { isMigrated: state.isMigrated, migrationProgress: state.migrationProgress, quoteReserve: BigInt(state.quoteReserve.toString()) },
    { migrationQuoteThreshold: BigInt(config.migrationQuoteThreshold.toString()), migrationOption: config.migrationOption, feeClaimer: config.feeClaimer, quoteMint: config.quoteMint },
    distributorAddresses(k.program, mint).feePool,
  );
  if (!decision.migrate) return { mint: token.mint, ...decision };
  const dammConfig = DAMM_V2_MIGRATION_FEE_ADDRESS[config.migrationFeeOption];
  if (!dammConfig || !(await k.connection.getAccountInfo(dammConfig, "confirmed"))) throw Error("DAMM v2 migration config unavailable");
  const m = await sdk.migration.migrateToDammV2({ payer: k.authority.publicKey, pool, dammConfig });
  const tx = m.transaction;
  tx.instructions = [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }), ...tx.instructions.filter((ix) => !ix.programId.equals(ComputeBudgetProgram.programId))];
  const signers = [m.firstPositionNftKeypair, m.secondPositionNftKeypair];
  if (k.dryRun) {
    await k.simulate(tx, "migrate damm v2", signers);
    return { mint: token.mint, migrate: true, status: "eligible (dry run)" };
  }
  const signature = await k.send(tx, "migrate damm v2", signers);
  return { mint: token.mint, migrate: true, status: "migrated", signature };
}
