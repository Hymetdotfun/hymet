// Phantom-signed owner steps for the distributor. The owner (config/production.json upgradeAuthority) holds its key
// only in Phantom: the server reads chain state and builds an unsigned transaction; Phantom signs; the browser sends.
import { ComputeBudgetProgram, Connection, PublicKey, Transaction } from "@solana/web3.js";
import production from "../config/production.json";
import { expectedGenesis } from "./app-network";
import { simulateReviewedTransaction } from "./transactions";
import { decodeProgramData, distributorConfigAddress, initializeDistributorInstruction, programDataAddress, reviewedBytesError, setSnapshotAuthorityInstruction } from "./distributor-init.mjs";

/** Phantom inserts its own priority-fee instruction into a transaction that sets no compute-unit price, which changes the
 *  reviewed message (and the console then refuses to send it). An explicit price keeps the message exactly as reviewed;
 *  20,000 micro-lamports × 50,000 units adds at most 1,000 lamports. */
export const OWNER_COMPUTE_UNITS = 50_000;
export const OWNER_PRIORITY_MICROLAMPORTS = 20_000;
const ownerBudget = () => [
  ComputeBudgetProgram.setComputeUnitLimit({ units: OWNER_COMPUTE_UNITS }),
  ComputeBudgetProgram.setComputeUnitPrice({ microLamports: OWNER_PRIORITY_MICROLAMPORTS }),
];

export type OwnerManifest = Pick<typeof production, "distributorProgramId" | "upgradeAuthority" | "platformFeeWallet" | "snapshotAuthority" | "programSha256" | "programBytes">;

export type OwnerStatus = {
  program: string;
  owner: string;
  deployed: boolean;
  upgradeAuthority: string | null;
  reviewedBytes: string | null;
  initialized: boolean;
  config: { admin: string; platformWallet: string; snapshotAuthority: string } | null;
  /** The next owner step, or the reason none is possible yet. */
  next: string;
};

export async function ownerStatus(c: Connection, manifest: OwnerManifest = production): Promise<OwnerStatus> {
  if ((await c.getGenesisHash()) !== expectedGenesis()) throw Error("Owner RPC is not Solana Mainnet Beta");
  const program = new PublicKey(manifest.distributorProgramId), owner = new PublicKey(manifest.upgradeAuthority);
  const [binary, programData, config] = await c.getMultipleAccountsInfo([program, programDataAddress(program), distributorConfigAddress(program)], "confirmed");
  const deployed = Boolean(binary?.executable && programData);
  const pd = deployed ? decodeProgramData(programData!.data) : null;
  const reviewedBytes = pd ? reviewedBytesError(manifest, pd.bytes) : null;
  const state = config?.owner.equals(program) && config.data.length >= 104
    ? {
        admin: new PublicKey(config.data.subarray(8, 40)).toBase58(),
        platformWallet: new PublicKey(config.data.subarray(40, 72)).toBase58(),
        snapshotAuthority: new PublicKey(config.data.subarray(72, 104)).toBase58(),
      }
    : null;
  const authority = pd?.upgradeAuthority ?? null;
  const next = !deployed
    ? "Not deployed yet: the deploy key runs `solana program deploy` (CLI step)."
    : reviewedBytes
      ? `Stop: ${reviewedBytes}.`
      : state
        ? "Initialized. No owner step remains."
        : !authority
          ? "Stop: the program is immutable and was never initialized."
          : !authority.equals(owner)
            ? "Sign the owner proof, then the deploy key hands the upgrade authority to the owner (CLI step)."
            : "Initialize the distributor in Phantom.";
  return { program: program.toBase58(), owner: owner.toBase58(), deployed, upgradeAuthority: authority?.toBase58() ?? null, reviewedBytes, initialized: Boolean(config), config: state, next };
}

/** Unsigned one-time `initialize`, signed and paid by the owner in Phantom (the program accepts only its upgrade authority). */
export async function prepareOwnerInitialize(c: Connection, wallet: PublicKey, manifest: OwnerManifest = production) {
  const owner = new PublicKey(manifest.upgradeAuthority);
  if (!wallet.equals(owner)) throw Error("Connected wallet is not the HYMET owner (upgrade authority)");
  const status = await ownerStatus(c, manifest);
  if (!status.deployed) throw Error("Distributor program is not deployed");
  if (status.reviewedBytes) throw Error(status.reviewedBytes);
  if (status.initialized) throw Error("Distributor config already exists; initialization is one-time");
  if (status.upgradeAuthority !== owner.toBase58()) throw Error(`On-chain upgrade authority is ${status.upgradeAuthority ?? "none"}, not the owner; hand it over first`);
  const program = new PublicKey(manifest.distributorProgramId);
  const platform = new PublicKey(manifest.platformFeeWallet), snapshot = new PublicKey(manifest.snapshotAuthority);
  const tx = new Transaction().add(...ownerBudget(), initializeDistributorInstruction(program, owner, platform, snapshot));
  tx.feePayer = owner;
  const latest = await c.getLatestBlockhash("confirmed");
  tx.recentBlockhash = latest.blockhash;
  const [rent, balance, fee] = await Promise.all([
    c.getMinimumBalanceForRentExemption(105, "confirmed"),
    c.getBalance(owner, "confirmed"),
    c.getFeeForMessage(tx.compileMessage(), "confirmed").then((r) => r.value ?? 5_000),
  ]);
  if (balance < rent + fee) throw Error(`Owner needs ${rent + fee} lamports for config rent and fee; it holds ${balance}`);
  await simulateReviewedTransaction(c, tx, false);
  return {
    tx,
    lastValidBlockHeight: latest.lastValidBlockHeight,
    summary: { program: program.toBase58(), config: distributorConfigAddress(program).toBase58(), admin: owner.toBase58(), platformWallet: platform.toBase58(), snapshotAuthority: snapshot.toBase58(), rentLamports: rent, feeLamports: fee },
  };
}

/** Unsigned `set_snapshot_authority` (keeper key rotation), signed in Phantom by the owner as upgrade authority. Mirrors the
 *  program's rules so a doomed rotation is refused before Phantom opens: on-curve, and not the current keeper, the fee
 *  wallet or the owner. Afterwards config/production.json and HYMET_SNAPSHOT_AUTHORITY must be updated; until then the
 *  app and keeper fail closed. */
export async function prepareOwnerRotation(c: Connection, wallet: PublicKey, next: PublicKey, manifest: OwnerManifest = production) {
  const owner = new PublicKey(manifest.upgradeAuthority);
  if (!wallet.equals(owner)) throw Error("Connected wallet is not the HYMET owner (upgrade authority)");
  if (!PublicKey.isOnCurve(next.toBytes())) throw Error("The new keeper key must be an on-curve wallet address");
  const status = await ownerStatus(c, manifest);
  if (!status.deployed) throw Error("Distributor program is not deployed");
  if (status.reviewedBytes) throw Error(status.reviewedBytes);
  if (!status.config) throw Error("Distributor is not initialized yet");
  if (status.upgradeAuthority !== owner.toBase58()) throw Error(`On-chain upgrade authority is ${status.upgradeAuthority ?? "none"}, not the owner`);
  const current = status.config.snapshotAuthority;
  if (next.toBase58() === current) throw Error("The new keeper key is already the snapshot authority");
  if (next.toBase58() === status.config.platformWallet || next.equals(owner)) throw Error("The keeper key must differ from the fee wallet and the owner");
  const program = new PublicKey(manifest.distributorProgramId);
  const tx = new Transaction().add(...ownerBudget(), setSnapshotAuthorityInstruction(program, owner, next));
  tx.feePayer = owner;
  const latest = await c.getLatestBlockhash("confirmed");
  tx.recentBlockhash = latest.blockhash;
  const [balance, fee] = await Promise.all([
    c.getBalance(owner, "confirmed"),
    c.getFeeForMessage(tx.compileMessage(), "confirmed").then((r) => r.value ?? 5_000),
  ]);
  if (balance < fee) throw Error(`Owner needs ${fee} lamports for the fee; it holds ${balance}`);
  await simulateReviewedTransaction(c, tx, false);
  return { tx, lastValidBlockHeight: latest.lastValidBlockHeight, summary: { program: program.toBase58(), config: distributorConfigAddress(program).toBase58(), current, next: next.toBase58(), feeLamports: fee } };
}
