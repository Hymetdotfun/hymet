import { BorshAccountsCoder, type Idl } from "@coral-xyz/anchor";
import { PublicKey, type Connection } from "@solana/web3.js";
import {
  DAMM_V2_PROGRAM_ID,
  DAMM_V2_MIGRATION_FEE_ADDRESS,
  deriveDammV2PoolAddress,
  type PoolConfig,
  type VirtualPool,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import idl from "./idl/damm-v2-pool.json";

// Account-only subset of the official DAMM V2 IDL; see lib/idl/README.md.
export const dammPoolCoder = new BorshAccountsCoder(idl as Idl);
export type MigrationView = {
  label:
    | "Bonding Curve Active"
    | "Migration Eligible"
    | "Migration Pending"
    | "Migrated to DAMM V2"
    | "Unknown";
  venue: "DBC" | "DAMM V2" | "Unknown";
  destination?: string;
  detail?: string;
  claiming: "verify-position";
};
export function migrationState(
  p: VirtualPool["poolState"],
  cfg: PoolConfig,
): MigrationView {
  const base = { claiming: "verify-position" as const };
  if (
    ![0, 1].includes(p.isMigrated) ||
    ![0, 1, 2, 3].includes(p.migrationProgress)
  )
    return {
      ...base,
      label: "Unknown",
      venue: "Unknown",
      detail: "Unrecognized migration flags",
    };
  if (p.isMigrated === 1)
    return {
      ...base,
      label: cfg.migrationOption === 1 ? "Migrated to DAMM V2" : "Unknown",
      venue: "Unknown",
    };
  if (p.migrationProgress > 0)
    return { ...base, label: "Migration Pending", venue: "Unknown" };
  if (cfg.migrationQuoteThreshold.isZero())
    return {
      ...base,
      label: "Unknown",
      venue: "Unknown",
      detail: "Invalid migration threshold",
    };
  return {
    ...base,
    label: p.quoteReserve.gte(cfg.migrationQuoteThreshold)
      ? "Migration Eligible"
      : "Bonding Curve Active",
    venue: "DBC",
  };
}
// Called only after the selected network and DBC pool/config accounts were verified.
export async function readMigration(
  c: Connection,
  p: VirtualPool["poolState"],
  cfg: PoolConfig,
): Promise<MigrationView> {
  const result = migrationState(p, cfg);
  if (
    cfg.migrationOption !== 1 ||
    p.isMigrated !== 1 ||
    result.label === "Unknown"
  )
    return result;
  try {
    const config = DAMM_V2_MIGRATION_FEE_ADDRESS[cfg.migrationFeeOption];
    if (!config) throw Error("Unsupported DAMM migration fee configuration");
    const destination = deriveDammV2PoolAddress(
      config,
      p.baseMint,
      cfg.quoteMint,
    );
    const [program, account] = await c.getMultipleAccountsInfo(
      [DAMM_V2_PROGRAM_ID, destination],
      "confirmed",
    );
    if (
      !program?.executable ||
      !account?.owner.equals(DAMM_V2_PROGRAM_ID) ||
      account.executable
    )
      throw Error("Destination is missing or not a verified DAMM V2 account");
    if (account.data.length !== dammPoolCoder.size("Pool"))
      throw Error("Unsupported DAMM V2 account layout");
    const pool = dammPoolCoder.decode<{
      token_a_mint: PublicKey;
      token_b_mint: PublicKey;
      layout_version: number;
      pool_status: number;
    }>("Pool", account.data);
    if (
      !pool.token_a_mint.equals(p.baseMint) ||
      !pool.token_b_mint.equals(cfg.quoteMint) ||
      ![0, 1].includes(pool.layout_version) ||
      ![0, 1].includes(pool.pool_status)
    )
      throw Error("Destination mint pair or account version does not match");
    return {
      ...result,
      venue: "DAMM V2",
      destination: destination.toBase58(),
      detail:
        pool.pool_status === 1
          ? "Destination pool is disabled"
          : "Destination owner, PDA, layout and mint pair verified",
    };
  } catch (e) {
    return {
      ...result,
      venue: "Unknown",
      detail: `Destination unverified: ${e instanceof Error ? e.message : "RPC unavailable"}`,
    };
  }
}
