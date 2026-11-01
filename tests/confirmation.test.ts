import { afterEach, describe, expect, it, vi } from "vitest";
import bs58 from "bs58";
import { Connection, Keypair, SystemProgram, Transaction } from "@solana/web3.js";
import { awaitSignature, pollConfirmation } from "../lib/transactions";
import { executeWalletOperation } from "../lib/wallet-operation";

afterEach(() => vi.unstubAllEnvs());
const sig = Keypair.generate().publicKey.toBase58();
const noSleep = { intervalMs: 1, maxWaitMs: 5, sleep: async () => {} };
type Status = { err: unknown; confirmationStatus?: string } | null;
function rpc(statuses: Status[], heights: number[]) {
  const s = [...statuses],
    h = [...heights];
  const getBlockHeight = vi.fn(async (...args: [commitment?: string]) => (void args, h.length > 1 ? h.shift()! : h[0]));
  return {
    getSignatureStatuses: vi.fn(async () => ({ value: [s.length > 1 ? s.shift()! : s[0]] })),
    getBlockHeight,
    sendRawTransaction: vi.fn(),
  };
}
const as = (r: object) => r as unknown as Connection;

describe("HTTP-only signature confirmation", () => {
  it("confirms after processed without any WebSocket call", async () => {
    const r = rpc([null, { err: null, confirmationStatus: "processed" }, { err: null, confirmationStatus: "confirmed" }], [1]);
    expect(await awaitSignature(as(r), sig, 100, noSleep)).toEqual({ state: "confirmed" });
    expect(r.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("reports on-chain failure", async () => {
    const r = rpc([{ err: { InstructionError: [0, "Custom"] }, confirmationStatus: "confirmed" }], [1]);
    expect((await awaitSignature(as(r), sig, 100, noSleep)).state).toBe("failed");
  });

  it("declares expiry only from the finalized height and after a final status check", async () => {
    const r = rpc([null], [101]);
    expect(await awaitSignature(as(r), sig, 100, noSleep)).toEqual({ state: "expired" });
    expect(r.getBlockHeight).toHaveBeenCalledWith("finalized");
    expect(r.getSignatureStatuses).toHaveBeenCalledTimes(2);
  });

  it("does not misreport a transaction that landed in the last valid blocks", async () => {
    const r = rpc([null, { err: null, confirmationStatus: "confirmed" }], [101]);
    expect(await awaitSignature(as(r), sig, 100, noSleep)).toEqual({ state: "confirmed" });
  });

  it("returns unresolved, not expired, while the blockhash is still valid", async () => {
    const r = rpc([null], [50]);
    expect(await awaitSignature(as(r), sig, 100, noSleep)).toEqual({ state: "unresolved" });
  });

  it("pollConfirmation keeps throwing distinct, non-resending errors", async () => {
    await expect(pollConfirmation(as(rpc([null], [101])), sig, 100)).rejects.toThrow("expired");
    await expect(pollConfirmation(as(rpc([{ err: "x", confirmationStatus: "confirmed" }], [1])), sig, 100)).rejects.toThrow("On-chain failure");
  });
});

describe("wallet operation confirmation states", () => {
  function fixture(statuses: Status[], heights: number[]) {
    const payer = Keypair.generate();
    const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58() }).add(
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 }),
    );
    const values = new Map<string, string>();
    const storage = { getItem: (k: string) => values.get(k) || null, setItem: (k: string, v: string) => void values.set(k, v) };
    const base = rpc(statuses, heights);
    const c = {
      ...base,
      getGenesisHash: vi.fn(async () => "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"),
      simulateTransaction: vi.fn(async () => ({ value: { err: null } })),
      sendRawTransaction: vi.fn(async (raw: Buffer) => bs58.encode(Transaction.from(raw).signature!)),
      confirmTransaction: vi.fn(),
    };
    const sign = vi.fn(async (t: Transaction) => {
      t.partialSign(payer);
      return t;
    });
    const record = () => JSON.parse([...values.values()][0]);
    return { payer, tx, storage, c, sign, record };
  }

  it("confirms by polling and never uses confirmTransaction", async () => {
    vi.stubEnv("NEXT_PUBLIC_ENABLE_MAINNET", "true");
    vi.stubEnv("ENABLE_MAINNET", "true");
    const f = fixture([null, { err: null, confirmationStatus: "confirmed" }], [1]);
    const signature = await executeWalletOperation(as(f.c), f.tx, f.payer.publicKey, f.sign, f.storage, 100, noSleep);
    expect(f.record()).toMatchObject({ phase: "confirmed", signature });
    expect(f.c.confirmTransaction).not.toHaveBeenCalled();
    expect(f.c.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it("marks an expired transaction distinctly and then allows a fresh operation", async () => {
    vi.stubEnv("NEXT_PUBLIC_ENABLE_MAINNET", "true");
    vi.stubEnv("ENABLE_MAINNET", "true");
    const f = fixture([null], [101]);
    await expect(executeWalletOperation(as(f.c), f.tx, f.payer.publicKey, f.sign, f.storage, 100, noSleep)).rejects.toThrow("expired without landing");
    expect(f.record()).toMatchObject({ phase: "failed", outcome: "expired" });
  });

  it("keeps an unresolved signature and blocks a duplicate submission", async () => {
    vi.stubEnv("NEXT_PUBLIC_ENABLE_MAINNET", "true");
    vi.stubEnv("ENABLE_MAINNET", "true");
    const f = fixture([null], [50]);
    const op = executeWalletOperation(as(f.c), f.tx, f.payer.publicKey, f.sign, f.storage, 100, noSleep);
    await expect(op).rejects.toThrow("unresolved");
    expect(f.record()).toMatchObject({ phase: "signed" });
    await expect(executeWalletOperation(as(f.c), f.tx, f.payer.publicKey, f.sign, f.storage, 100, noSleep)).rejects.toThrow("unresolved");
    expect(f.sign).toHaveBeenCalledTimes(1);
    expect(f.c.sendRawTransaction).toHaveBeenCalledTimes(1);
  });
});
