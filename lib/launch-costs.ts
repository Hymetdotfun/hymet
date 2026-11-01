import { quoteAsset } from "./quote-assets";
import {
  ACCOUNT_SIZE,
  NATIVE_MINT,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { Buffer } from "buffer";
import { type Connection } from "@solana/web3.js";
import { simulateReviewedTransaction, type Plan } from "./transactions";

export type LaunchCostPreview = {
  temporaryRent?: bigint;
  simulations: {
    label: string;
    status: "passed" | "deferred" | "unavailable";
    units?: number;
    payerDebit?: bigint;
    observedRent?: bigint;
  }[];
};
// Read-only supplement. Never edits a transaction, launch settings, or a recovery record.
export async function inspectLaunchCosts(
  c: Connection,
  p: Plan,
): Promise<LaunchCostPreview> {
  let temporaryRent = 0n;
  if (p.buy > 0n && quoteAsset(p.values).native) {
    const ata = getAssociatedTokenAddressSync(NATIVE_MINT, p.creator);
    if (!(await c.getAccountInfo(ata, "confirmed"))) {
      const rent = await c.getMinimumBalanceForRentExemption(ACCOUNT_SIZE);
      if (!Number.isSafeInteger(rent) || rent < 0)
        throw Error("Invalid temporary account rent quote");
      temporaryRent = BigInt(rent);
    }
  }
  const result: LaunchCostPreview = { temporaryRent, simulations: [] };
  const configExists = !!(await c.getAccountInfo(p.config, "confirmed"));
  for (const s of p.steps) {
    if (s.done) continue;
    if (
      !configExists &&
      s.signers.some((k) => k.publicKey.equals(p.mint.publicKey))
    ) {
      result.simulations.push({ label: s.label, status: "deferred" });
      continue;
    }
    try {
      const before = await c.getBalance(p.creator, "confirmed");
      const message = s.tx.compileMessage();
      const addresses = [
        p.creator,
        ...message.accountKeys.filter(
          (key, i) => message.isAccountWritable(i) && !key.equals(p.creator),
        ),
      ].slice(0, 20);
      const prior = [];
      for (let i = 0; i < addresses.length; i += 10)
        prior.push(
          ...(await c.getMultipleAccountsInfo(
            addresses.slice(i, i + 10),
            "confirmed",
          )),
        );
      const simulation = await simulateReviewedTransaction(
        c,
        s.tx,
        false,
        p.creator,
        addresses,
      );
      const after = simulation.accounts?.[0]?.lamports;
      let observedRent: bigint | undefined;
      if (simulation.accounts?.length === addresses.length) {
        observedRent = 0n;
        for (let i = 1; i < addresses.length; i++) {
          const post = simulation.accounts[i];
          if (!prior[i] && post) {
            const size = Buffer.from(post.data[0], "base64").length;
            const rent = await c.getMinimumBalanceForRentExemption(size);
            if (!Number.isSafeInteger(rent) || rent < 0)
              throw Error("Invalid simulation rent quote");
            observedRent += BigInt(rent);
          }
        }
      }
      result.simulations.push({
        label: s.label,
        status: "passed",
        units: simulation.unitsConsumed,
        observedRent,
        ...(Number.isSafeInteger(before) &&
        Number.isSafeInteger(after) &&
        before >= after!
          ? { payerDebit: BigInt(before) - BigInt(after!) }
          : {}),
      });
    } catch {
      result.simulations.push({ label: s.label, status: "unavailable" });
    }
  }
  return result;
}
