import { describe, expect, it, vi } from "vitest";
import { ComputeBudgetProgram, Keypair, SystemProgram, Transaction } from "@solana/web3.js";
import { keeperFetch, withPriorityFee } from "../lib/keeper-rpc";

describe("keeper priority fee", () => {
  const transfer = () => SystemProgram.transfer({ fromPubkey: Keypair.generate().publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 });
  it("adds one compute-unit price ahead of the existing instructions", () => {
    const tx = withPriorityFee(new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), transfer()), 20_000);
    expect(tx.instructions).toHaveLength(3);
    expect(tx.instructions[0].programId.equals(ComputeBudgetProgram.programId) && tx.instructions[0].data[0]).toBe(3);
    withPriorityFee(tx, 20_000);
    expect(tx.instructions).toHaveLength(3); // idempotent: never two prices
  });
  it("keeps a price the transaction already sets, adds none at 0, and rejects invalid values", () => {
    const priced = new Transaction().add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5 }), transfer());
    expect(withPriorityFee(priced, 20_000).instructions).toHaveLength(2);
    expect(withPriorityFee(new Transaction().add(transfer()), 0).instructions).toHaveLength(1);
    expect(() => withPriorityFee(new Transaction(), -1)).toThrow();
  });
});

const body = (method: string) => JSON.stringify({ jsonrpc: "2.0", id: "1", method, params: [] });
const deadSocket = () => Promise.reject(new TypeError("fetch failed"));

describe("keeper RPC transport", () => {
  it("retries a read once after a transport failure such as a closed keep-alive socket", async () => {
    const fetcher = vi.fn().mockImplementationOnce(deadSocket).mockResolvedValueOnce(new Response("{}"));
    const response = await keeperFetch(30_000, fetcher)("https://rpc.invalid", { method: "POST", body: body("getAccountInfo") });
    expect(response.status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("never replays a broadcast", async () => {
    const fetcher = vi.fn().mockImplementation(deadSocket);
    await expect(keeperFetch(30_000, fetcher)("https://rpc.invalid", { method: "POST", body: body("sendTransaction") })).rejects.toThrow("fetch failed");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("does not retry a timed-out request and bounds every request with a signal", async () => {
    const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    const fetcher = vi.fn().mockRejectedValue(timeout);
    await expect(keeperFetch(30_000, fetcher)("https://rpc.invalid", { method: "POST", body: body("getSlot") })).rejects.toBe(timeout);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it("gives up after a single retry", async () => {
    const fetcher = vi.fn().mockImplementation(deadSocket);
    await expect(keeperFetch(30_000, fetcher)("https://rpc.invalid", { method: "POST", body: body("getProgramAccounts") })).rejects.toThrow("fetch failed");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
