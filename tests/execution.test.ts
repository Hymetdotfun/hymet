import { it, expect, vi, afterEach } from "vitest";
import {
  Connection,
  Keypair,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
  StateService,
  type PoolConfig,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { defaults, curve } from "../lib/config";
import { execute, type Plan } from "../lib/transactions";
import { allocationFromShare } from "../lib/hymet-policy";
afterEach(() => vi.restoreAllMocks());
function fixture() {
  const payer = Keypair.generate(),
    configKey = Keypair.generate(),
    mint = Keypair.generate();
  const values = { ...defaults, name: "Test", symbol: "TEST" };
  const configParams = curve(values, payer.publicKey);
  const configTx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: configKey.publicKey,
      lamports: 1000,
      space: 82,
      programId: SystemProgram.programId,
    }),
  );
  const p: Plan = {
    values,
    allocation: allocationFromShare(values.creatorShare),
    network: "devnet",
    creator: payer.publicKey,
    mint,
    config: configKey.publicKey,
    pool: Keypair.generate().publicKey,
    steps: [{ label: "Config", tx: configTx, signers: [configKey] }],
    fee: 5000n,
    rent: 10000n,
    configRent: 1000n,
    poolFee: 0n,
    buy: 0n,
    total: 15000n,
    balance: 1000000000n,
    threshold: configParams.migrationQuoteThreshold.toString(),
    recipients: {
      partner: payer.publicKey.toBase58(),
      leftover: payer.publicKey.toBase58(),
    },
    uri: "https://example.com/meta",
    configParams,
  };
  const c = new Connection("http://localhost:8899");
  vi.spyOn(c, "getGenesisHash").mockResolvedValue(
    "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  );
  vi.spyOn(c, "getAccountInfo").mockResolvedValue({
    executable: true,
    owner: DYNAMIC_BONDING_CURVE_PROGRAM_ID,
    lamports: 1,
    data: Buffer.alloc(0),
    rentEpoch: 0,
  });
  vi.spyOn(c, "getBalance").mockResolvedValue(1000000000);
  vi.spyOn(c, "getLatestBlockhash").mockResolvedValue({
    blockhash: Keypair.generate().publicKey.toBase58(),
    lastValidBlockHeight: 100,
  });
  const simulation = vi.spyOn(c, "simulateTransaction").mockResolvedValue({
    context: { slot: 1 },
    value: { err: null, logs: [] },
  });
  const send = vi
    .spyOn(c, "sendRawTransaction")
    .mockRejectedValue(
      Error("Synthetic transport timeout; no real RPC broadcast"),
    );
  const sign = vi.fn(async (tx: Transaction) => {
    tx.partialSign(payer);
    return tx;
  });
  return { p, c, send, sign, simulation };
}
it("blocks Mainnet launch execution before RPC, Phantom signing, or submission", async () => {
  const {p,c,send,sign,simulation}=fixture();p.network="mainnet-beta";
  const network=vi.spyOn(c,"getGenesisHash");
  await expect(execute(c,p,sign,()=>{})).rejects.toThrow("Mainnet transactions are disabled");
  expect(network).not.toHaveBeenCalled();expect(simulation).not.toHaveBeenCalled();expect(sign).not.toHaveBeenCalled();expect(send).not.toHaveBeenCalled();
});
it("records the payer signature before an ambiguous send and never broadcasts a replacement", async () => {
  const { p, c, send, sign } = fixture();
  await expect(execute(c, p, sign, () => {})).rejects.toThrow(
    "transport timeout",
  );
  expect(p.steps[0].signature).toBeTruthy();
  expect(send).toHaveBeenCalledTimes(1);
  const raw = send.mock.calls[0][0];
  expect(Transaction.from(raw).verifySignatures()).toBe(true);
  expect(send.mock.calls[0][1]).toEqual({
    skipPreflight: false,
    preflightCommitment: "confirmed",
    maxRetries: 0,
  });
  vi.spyOn(c, "getSignatureStatuses").mockResolvedValue({
    context: { slot: 1 },
    value: [null],
  });
  await expect(execute(c, p, sign, () => {})).rejects.toThrow("uncertain");
  expect(send).toHaveBeenCalledTimes(1);
  expect(sign).toHaveBeenCalledTimes(1);
});
it("saves the signed signature before failed simulation and never broadcasts", async () => {
  const { p, c, send, sign, simulation } = fixture();
  simulation
    .mockResolvedValueOnce({
      context: { slot: 1 },
      value: { err: null, logs: [] },
    })
    .mockResolvedValueOnce({
      context: { slot: 1 },
      value: { err: "BlockhashNotFound", logs: [] },
    });
  await expect(execute(c, p, sign, () => {})).rejects.toThrow(
    "Signed simulation failed",
  );
  expect(sign).toHaveBeenCalledTimes(1);
  expect(send).not.toHaveBeenCalled();
  expect(p.steps[0].signature).toBeTruthy();
  expect(p.steps[0].phase).toBe("signed");
  vi.spyOn(c, "getSignatureStatuses").mockResolvedValue({
    context: { slot: 1 },
    value: [null],
  });
  await expect(execute(c, p, sign, () => {})).rejects.toThrow("uncertain");
  expect(send).not.toHaveBeenCalled();
  expect(sign).toHaveBeenCalledTimes(1);
});
it("does not broadcast after wallet rejection", async () => {
  const { p, c, send } = fixture();
  await expect(
    execute(
      c,
      p,
      async () => {
        throw Error("Wallet rejected");
      },
      () => {},
    ),
  ).rejects.toThrow("Wallet rejected");
  expect(send).not.toHaveBeenCalled();
  expect(p.steps[0].signature).toBeUndefined();
});
it("fails closed before sending if the public recovery checkpoint cannot be persisted", async () => {
  const { p, c, send, sign } = fixture();
  await expect(
    execute(
      c,
      p,
      sign,
      () => {},
      () => {
        throw Error("Storage quota exceeded");
      },
    ),
  ).rejects.toThrow("Storage quota");
  expect(send).not.toHaveBeenCalled();
});
it.each(["missing", "wrong-owner", "incompatible"] as const)(
  "rechecks a recovered config before requesting the pool signature (%s)",
  async (mode) => {
    const { p, c, send, sign } = fixture();
    p.steps[0].signature = "already-confirmed-config";
    p.steps[0].done = true;
    p.steps.push({ label: "Pool", tx: new Transaction(), signers: [p.mint] });
    vi.spyOn(c, "getSignatureStatuses").mockResolvedValue({
      context: { slot: 1 },
      value: [
        {
          slot: 1,
          confirmations: 1,
          err: null,
          confirmationStatus: "confirmed",
        },
      ],
    });
    const accounts = vi.mocked(c.getAccountInfo);
    if (mode === "missing")
      accounts
        .mockResolvedValueOnce({
          executable: true,
          owner: DYNAMIC_BONDING_CURVE_PROGRAM_ID,
          lamports: 1,
          data: Buffer.alloc(0),
          rentEpoch: 0,
        })
        .mockResolvedValueOnce(null);
    if (mode === "wrong-owner")
      accounts
        .mockResolvedValueOnce({
          executable: true,
          owner: DYNAMIC_BONDING_CURVE_PROGRAM_ID,
          lamports: 1,
          data: Buffer.alloc(0),
          rentEpoch: 0,
        })
        .mockResolvedValueOnce({
          executable: false,
          owner: SystemProgram.programId,
          lamports: 1,
          data: Buffer.alloc(0),
          rentEpoch: 0,
        });
    if (mode === "incompatible")
      vi.spyOn(StateService.prototype, "getPoolConfig").mockResolvedValue({
        quoteMint: SystemProgram.programId,
      } as PoolConfig);
    await expect(execute(c, p, sign, () => {})).rejects.toThrow(
      mode === "incompatible" ? "incompatible" : "owned by the DBC",
    );
    expect(send).not.toHaveBeenCalled();
    expect(sign).not.toHaveBeenCalled();
  },
);
it("retains the signature in memory and never sends when signed checkpoint storage fails", async () => {
  const { p, c, send, sign } = fixture();
  await expect(
    execute(
      c,
      p,
      sign,
      () => {},
      (plan) => {
        if (plan.steps[0].phase === "signed")
          throw Error("Signed checkpoint unavailable");
      },
    ),
  ).rejects.toThrow("Signed checkpoint unavailable");
  expect(p.steps[0].signature).toBeTruthy();
  expect(send).not.toHaveBeenCalled();
});
it("never requests a second approval while an earlier wallet response is unresolved", async () => {
  const { p, c, send, sign } = fixture();
  p.steps[0].phase = "awaiting-signature";
  await expect(execute(c, p, sign, () => {})).rejects.toThrow(
    "approval completion is unknown",
  );
  expect(sign).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});
