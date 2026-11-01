import { describe, expect, it, vi } from "vitest";
import { Connection, Keypair } from "@solana/web3.js";
import { dedupedRead, isTransientRpcError, withRpcRetry } from "../lib/rpc-retry";
import { awaitSignature } from "../lib/transactions";
import { refreshClaim, type ClaimRecord } from "../lib/creator-fees";

const noSleep = { sleep: async () => {} };
const rateLimited = () => Error("429 Too Many Requests: rate limited");

describe("bounded RPC retry", () => {
  it("retries only transient errors, up to the attempt bound", async () => {
    const flaky = vi.fn().mockRejectedValueOnce(rateLimited()).mockResolvedValue("ok");
    expect(await withRpcRetry(flaky, noSleep)).toBe("ok");
    expect(flaky).toHaveBeenCalledTimes(2);
    const always = vi.fn().mockRejectedValue(rateLimited());
    await expect(withRpcRetry(always, noSleep)).rejects.toThrow("429");
    expect(always).toHaveBeenCalledTimes(3);
    const fatal = vi.fn().mockRejectedValue(Error("Pool is missing or is not DBC-owned"));
    await expect(withRpcRetry(fatal, noSleep)).rejects.toThrow("DBC-owned");
    expect(fatal).toHaveBeenCalledTimes(1);
    expect(isTransientRpcError(Error("Transaction failed on-chain"))).toBe(false);
  });

  it("deduplicates concurrent display reads and caches briefly", async () => {
    const read = vi.fn(async (k: string) => `${k}:${read.mock.calls.length}`);
    const cached = dedupedRead(5_000, (k: string) => k, read);
    const [a, b] = await Promise.all([cached("pool"), cached("pool")]);
    expect(a).toBe(b);
    expect(await cached("pool")).toBe(a);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("a transient 429 during confirmation polling does not decide the outcome", async () => {
    const c = {
      getSignatureStatuses: vi.fn().mockRejectedValueOnce(rateLimited()).mockResolvedValue({ value: [{ err: null, confirmationStatus: "confirmed" }] }),
      getBlockHeight: vi.fn(async () => 1),
    } as unknown as Connection;
    expect(await awaitSignature(c, Keypair.generate().publicKey.toBase58(), 100, { intervalMs: 1, maxWaitMs: 5, ...noSleep })).toEqual({ state: "confirmed" });
  });
});

describe("post-claim refresh", () => {
  it("keeps a confirmed claim confirmed and returns a warning when the balance refresh is rate-limited", async () => {
    const program = { executable: true, owner: Keypair.generate().publicKey, data: Buffer.alloc(0), lamports: 1 };
    const c = {
      getGenesisHash: vi.fn(async () => "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"),
      getAccountInfo: vi.fn().mockResolvedValueOnce(program).mockRejectedValue(rateLimited()),
      getSignatureStatuses: vi.fn(),
      getTransaction: vi.fn(),
    } as unknown as Connection;
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    const record: ClaimRecord = { network: "mainnet-beta", wallet: Keypair.generate().publicKey.toBase58(), pool: Keypair.generate().publicKey.toBase58(), signature: "sig", lastValidBlockHeight: 1, state: "confirmed", actualFee: "5000" };
    const result = await refreshClaim(c, storage, record);
    expect(result.record.state).toBe("confirmed");
    expect(result.view).toBeUndefined();
    expect(result.refreshWarning).toMatch(/Claim confirmed\. The claimable balance could not be refreshed/);
    expect(c.getSignatureStatuses).not.toHaveBeenCalled();
  }, 20_000);
});
