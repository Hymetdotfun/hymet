import { it, expect, vi } from "vitest";
import {
  Connection,
  Keypair,
  SystemProgram,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  signReviewedTransaction,
  simulateReviewedTransaction,
} from "../lib/transactions";
function fixture() {
  const payer = Keypair.generate(),
    local = Keypair.generate();
  const tx = new Transaction({
    feePayer: payer.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
  }).add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: local.publicKey,
      space: 82,
      lamports: 1000000,
      programId: SystemProgram.programId,
    }),
  );
  return { payer, local, tx };
}
it.each(["preserve", "omit"] as const)(
  "validates local signatures after a synthetic wallet roundtrip (%s); not a live Phantom test",
  async (mode) => {
    const { payer, local, tx } = fixture();
    let original: Buffer | undefined;
    const signed = await signReviewedTransaction(
      tx,
      payer.publicKey,
      [local],
      async (partial) => {
        original = Buffer.from(
          partial.signatures.find((s) => s.publicKey.equals(local.publicKey))!
            .signature!,
        );
        const returned = Transaction.from(
          partial.serialize({ requireAllSignatures: false }),
        );
        if (mode === "omit")
          returned.signatures.forEach((s) => {
            s.signature = null;
          });
        returned.partialSign(payer);
        return returned;
      },
    );
    expect(signed.verifySignatures()).toBe(true);
    expect(
      signed.signatures.find((s) => s.publicKey.equals(local.publicKey))!
        .signature,
    ).toEqual(original);
  },
);
it("rejects a wallet-modified message", async () => {
  const { payer, local, tx } = fixture();
  await expect(
    signReviewedTransaction(tx, payer.publicKey, [local], async (returned) => {
      returned.recentBlockhash = Keypair.generate().publicKey.toBase58();
      returned.partialSign(payer);
      return returned;
    }),
  ).rejects.toThrow("changed the reviewed");
});
it("rejects a missing payer signature", async () => {
  const { payer, local, tx } = fixture();
  await expect(
    signReviewedTransaction(
      tx,
      payer.publicKey,
      [local],
      async (returned) => returned,
    ),
  ).rejects.toThrow("signature is missing or invalid");
});
it("rejects a corrupted nonempty local signature", async () => {
  const { payer, local, tx } = fixture();
  await expect(
    signReviewedTransaction(tx, payer.publicKey, [local], async (returned) => {
      returned.partialSign(payer);
      returned.signatures.find((s) =>
        s.publicKey.equals(local.publicKey),
      )!.signature = Buffer.alloc(64, 1);
      return returned;
    }),
  ).rejects.toThrow("signature is missing or invalid");
});
it("unsigned simulation skips crypto verification; signed simulation verifies the exact broadcast bytes", async () => {
  const { payer, local, tx } = fixture();
  const c = new Connection("http://localhost:8899");
  const simulated = vi
    .spyOn(c, "simulateTransaction")
    .mockResolvedValue({
      context: { slot: 1 },
      value: { err: null, logs: [] },
    });
  await simulateReviewedTransaction(c, tx, false);
  const [unsigned, config] = simulated.mock.calls[0] as unknown as [
    VersionedTransaction,
    { sigVerify: boolean },
  ];
  expect(config).toEqual({ sigVerify: false, commitment: "confirmed" });
  expect(unsigned.signatures.every((s) => s.every((v) => v === 0))).toBe(true);
  const signed = await signReviewedTransaction(
    tx,
    payer.publicKey,
    [local],
    async (returned) => {
      returned.partialSign(payer);
      return returned;
    },
  );
  await simulateReviewedTransaction(c, signed, true);
  const [complete, options] = simulated.mock.calls[1] as unknown as [
    VersionedTransaction,
    { sigVerify: boolean },
  ];
  expect(options).toEqual({ sigVerify: true, commitment: "confirmed" });
  expect(Buffer.from(complete.serialize())).toEqual(signed.serialize());
});
it("rejects failed signed simulation", async () => {
  const { payer, local, tx } = fixture();
  tx.partialSign(payer, local);
  const c = new Connection("http://localhost:8899");
  vi.spyOn(c, "simulateTransaction").mockResolvedValue({
    context: { slot: 1 },
    value: { err: "BlockhashNotFound", logs: [] },
  });
  await expect(simulateReviewedTransaction(c, tx, true)).rejects.toThrow(
    "Signed simulation failed",
  );
});
