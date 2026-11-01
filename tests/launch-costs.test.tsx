import { afterEach, it, expect, vi } from "vitest";
import {
  Connection,
  Keypair,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { renderToStaticMarkup } from "react-dom/server";
import { inspectLaunchCosts } from "../lib/launch-costs";
import LaunchCostBreakdown from "../components/launch-cost-breakdown";
import type { Plan } from "../lib/transactions";
afterEach(() => vi.restoreAllMocks());
function fixture(reuse = false) {
  const creator = Keypair.generate().publicKey,
    config = Keypair.generate(),
    mint = Keypair.generate();
  const tx = (key: typeof config) =>
    new Transaction({
      feePayer: creator,
      recentBlockhash: SystemProgram.programId.toBase58(),
    }).add(
      SystemProgram.createAccount({
        fromPubkey: creator,
        newAccountPubkey: key.publicKey,
        lamports: 1000,
        space: 82,
        programId: SystemProgram.programId,
      }),
    );
  const p = {
    creator,
    config: config.publicKey,
    mint,
    buy: 10000000n,
    fee: 10000n,
    rent: 20000n,
    configRent: reuse ? 0n : 5000n,
    poolFee: 0n,
    total: 10030000n,
    values: { reuse: reuse ? config.publicKey.toBase58() : "" },
    steps: reuse
      ? [{ label: "Pool", tx: tx(mint), signers: [mint] }]
      : [
          { label: "Config", tx: tx(config), signers: [config] },
          { label: "Pool", tx: tx(mint), signers: [mint] },
        ],
  } as Plan;
  const c = new Connection("http://localhost:8899");
  vi.spyOn(c, "getAccountInfo").mockImplementation(async (key) =>
    reuse && key.equals(config.publicKey)
      ? {
          lamports: 1000,
          data: Buffer.alloc(0),
          owner: SystemProgram.programId,
          executable: false,
          rentEpoch: 0,
        }
      : null,
  );
  vi.spyOn(c, "getMultipleAccountsInfo").mockImplementation(async (keys) =>
    keys.map(() => null),
  );
  vi.spyOn(c, "getBalance").mockResolvedValue(100000);
  const rent = vi
    .spyOn(c, "getMinimumBalanceForRentExemption")
    .mockImplementation(async (size) => size * 10);
  const sim = vi.spyOn(c, "simulateTransaction").mockResolvedValue({
    context: { slot: 1 },
    value: {
      err: null,
      logs: [],
      unitsConsumed: 1234,
      accounts: [
        {
          lamports: 89000,
          data: ["", "base64"],
          owner: SystemProgram.programId.toBase58(),
          executable: false,
          rentEpoch: 0,
        },
        {
          lamports: 10480,
          data: [Buffer.alloc(1048).toString("base64"), "base64"],
          owner: SystemProgram.programId.toBase58(),
          executable: false,
          rentEpoch: 0,
        },
      ],
    },
  });
  const send = vi
    .spyOn(c, "sendRawTransaction")
    .mockRejectedValue(Error("No send"));
  return { c, p, sim, send, rent };
}
it("uses actual simulation-returned account lengths and RPC rent rates without editing transactions", async () => {
  const { c, p, sim, send, rent } = fixture(),
    before = p.steps.map((s) => s.tx.serializeMessage().toString("base64"));
  const result = await inspectLaunchCosts(c, p);
  expect(result.temporaryRent).toBe(0n);
  expect(result.simulations).toEqual([
    {
      label: "Config",
      status: "passed",
      units: 1234,
      payerDebit: 11000n,
      observedRent: 10480n,
    },
    { label: "Pool", status: "deferred" },
  ]);
  expect(rent).toHaveBeenCalledWith(1048);
  expect(sim).toHaveBeenCalledTimes(1);
  expect(send).not.toHaveBeenCalled();
  expect(
    p.steps.map((s) => s.tx.serializeMessage().toString("base64")),
  ).toEqual(before);
});
it("simulates the pool preview when its reused config already exists", async () => {
  const { c, p, sim, send } = fixture(true);
  expect((await inspectLaunchCosts(c, p)).simulations[0].status).toBe("passed");
  expect(sim).toHaveBeenCalledTimes(1);
  expect(send).not.toHaveBeenCalled();
});
it("labels simulation failures unavailable without signing, sending, or bypassing mandatory execution checks", async () => {
  const { c, p, sim, send } = fixture();
  sim.mockResolvedValue({
    context: { slot: 1 },
    value: { err: "AccountNotFound", logs: [] },
  });
  expect((await inspectLaunchCosts(c, p)).simulations[0].status).toBe(
    "unavailable",
  );
  expect(send).not.toHaveBeenCalled();
});
it("renders a read-only breakdown with separate expenses, deposits, purchase and total without promising persistent rent recovery", async () => {
  const { c, p } = fixture();
  p.costPreview = await inspectLaunchCosts(c, p);
  const html = renderToStaticMarkup(<LaunchCostBreakdown plan={p} />);
  for (const value of [
    "Launch Cost Breakdown",
    "Transaction fees",
    "Rent deposits",
    "Temporary WSOL rent",
    "Other rent allowance",
    "Initial token purchase",
    "Estimated total SOL requirement",
    "no refund assumed",
    "simulation waits",
    "0.010000000",
    "0.010030000",
  ])
    expect(html).toContain(value);
  expect(html).not.toMatch(/<(button|input|select)/);
  expect(html).toContain("no supported owner refund path");
});
