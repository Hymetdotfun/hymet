import { ComputeBudgetProgram, type Transaction } from "@solana/web3.js";

/** A failed send's message with its logs and RPC error. The default "Simulation failed" text alone hides the cause. */
export async function describeSendFailure(error: unknown, connection: unknown, label: string) {
  const e = error as { message?: unknown; transactionError?: { message?: unknown }; getLogs?: (c: unknown) => Promise<string[] | null> };
  const logs = await Promise.resolve(e.getLogs?.(connection)).catch(() => null);
  const detail = [
    e.transactionError?.message ? `rpc: ${String(e.transactionError.message)}` : "",
    logs?.length ? `logs: ${logs.slice(-4).join(" | ")}` : "",
  ].filter(Boolean).join("; ");
  return `${label} send failed: ${String(e.message ?? error).split("\n")[0]}${detail ? `; ${detail}` : ""}`.slice(0, 600);
}

/** Default keeper priority fee: 400k CU (a settlement) costs 8,000 lamports on top of the base fee. */
export const KEEPER_PRIORITY_MICROLAMPORTS = 20_000;

/** Adds a compute-unit price unless the transaction already sets one, so keeper transactions land under load. */
export function withPriorityFee(tx: Transaction, microLamports: number) {
  if (!Number.isSafeInteger(microLamports) || microLamports < 0) throw Error("Keeper priority fee must be a non-negative integer");
  // ComputeBudget instruction 3 is SetComputeUnitPrice.
  if (microLamports > 0 && !tx.instructions.some((ix) => ix.programId.equals(ComputeBudgetProgram.programId) && ix.data[0] === 3))
    tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitPrice({ microLamports }));
  return tx;
}

// Keeper RPC transport. Every request is bounded by a timeout, and a read that fails at the transport layer (e.g. a
// keep-alive socket the RPC closed while the keeper waited) is retried once on a fresh request. A broadcast is never
// replayed: a failed sendTransaction surfaces as an error and the keeper resumes from chain state on its next run.
export function keeperFetch(timeoutMs: number, fetcher: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const call = () => fetcher(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    try {
      return await call();
    } catch (error) {
      const transport = error instanceof TypeError; // undici "fetch failed"; timeouts are DOMExceptions
      if (!transport || /"sendTransaction"/.test(String(init?.body ?? ""))) throw error;
      return call();
    }
  };
}
