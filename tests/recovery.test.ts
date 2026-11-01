import { it, expect, vi } from "vitest";
import { Connection, Keypair, Transaction } from "@solana/web3.js";
import {
  inspectSignature,
  pollConfirmation,
  type Step,
} from "../lib/transactions";
it("never considers an absent signature successful", async () => {
  const c = new Connection("http://localhost:8899");
  const spy = vi
    .spyOn(c, "getSignatureStatuses")
    .mockResolvedValue({ context: { slot: 1 }, value: [null] });
  const step: Step = {
    label: "pool",
    tx: new Transaction(),
    signers: [],
    signature: "uncertain",
  };
  expect(await inspectSignature(c, step)).toBe("uncertain");
  expect(step.done).toBe(false);
  spy.mockRestore();
});
it("marks confirmed transactions for recovery without rebuilding", async () => {
  const c = new Connection("http://localhost:8899");
  vi.spyOn(c, "getSignatureStatuses").mockResolvedValue({
    context: { slot: 1 },
    value: [
      { slot: 1, confirmations: 1, err: null, confirmationStatus: "confirmed" },
    ],
  });
  const step: Step = {
    label: "config",
    tx: new Transaction(),
    signers: [],
    signature: "confirmed",
  };
  expect(await inspectSignature(c, step)).toBe("confirmed");
  expect(step.done).toBe(true);
});
it("rejects confirmed on-chain failure", async () => {
  const c = new Connection("http://localhost:8899");
  vi.spyOn(c, "getSignatureStatuses").mockResolvedValue({
    context: { slot: 1 },
    value: [
      {
        slot: 1,
        confirmations: 1,
        err: { InstructionError: [0, "InvalidArgument"] },
        confirmationStatus: "confirmed",
      },
    ],
  });
  await expect(
    inspectSignature(c, {
      label: "config",
      tx: new Transaction(),
      signers: [],
      signature: "failed",
    }),
  ).rejects.toThrow("failed on-chain");
});
it("reports expiry without resending", async () => {
  const c = new Connection("http://localhost:8899");
  vi.spyOn(c, "getSignatureStatuses").mockResolvedValue({
    context: { slot: 1 },
    value: [null],
  });
  vi.spyOn(c, "getBlockHeight").mockResolvedValue(11);
  const send = vi.spyOn(c, "sendRawTransaction");
  await expect(
    pollConfirmation(c, Keypair.generate().publicKey.toBase58(), 10),
  ).rejects.toThrow("expired");
  expect(send).not.toHaveBeenCalled();
});
