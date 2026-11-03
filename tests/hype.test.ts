import { afterEach, expect, it, vi } from "vitest";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SystemInstruction,
} from "@solana/web3.js";
import {
  AccountLayout,
  MintLayout,
  TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  DynamicBondingCurveClient,
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
  deriveDbcPoolAddress,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { BorshInstructionCoder } from "@coral-xyz/anchor";
import { NextRequest } from "next/server";
import { POST } from "../app/api/rpc/route";
import {
  HYPE_MINT,
  quoteAsset,
  verifyHypeMint,
  hypeBalance,
} from "../lib/quote-assets";
import { buildPlan, LAUNCH_PRIORITY_MICROLAMPORTS, remainingRequirement, signReviewedTransaction } from "../lib/transactions";
import { defaults, curve } from "../lib/config";
import {
  recoveryRecord,
  storeRecovery,
  loadRecovery,
  assertRecoveryAllows,
} from "../lib/recovery";
import { scopedStorage, DEV_STORAGE_PREFIX } from "../lib/development-storage";
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
function memory(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => {
      m.set(k, v);
    },
    removeItem: (k) => {
      m.delete(k);
    },
    clear: () => m.clear(),
  };
}
function setup() {
  const owner = Keypair.generate().publicKey;
  const platform = Keypair.generate().publicKey;
  vi.stubEnv("HYMET_PLATFORM_FEE_RECIPIENT", platform.toBase58());
  const c = new Connection("http://127.0.0.1:8899");
  const mint = Buffer.alloc(82);
  MintLayout.encode(
    {
      mintAuthorityOption: 1,
      mintAuthority: Keypair.generate().publicKey,
      supply: 1000000000000n,
      decimals: 9,
      isInitialized: true,
      freezeAuthorityOption: 0,
      freezeAuthority: PublicKey.default,
    },
    mint,
  );
  const funding = Buffer.alloc(165);
  AccountLayout.encode(
    {
      mint: HYPE_MINT,
      owner,
      amount: 5000000000n,
      delegateOption: 0,
      delegate: PublicKey.default,
      state: 1,
      isNativeOption: 0,
      isNative: 0n,
      delegatedAmount: 0n,
      closeAuthorityOption: 0,
      closeAuthority: PublicKey.default,
    },
    funding,
  );
  const info = (data: Buffer, executable = false) => ({
    data,
    executable,
    owner: TOKEN_PROGRAM_ID,
    lamports: 2039280,
    rentEpoch: 0,
  });
  const ata = getAssociatedTokenAddressSync(HYPE_MINT, owner);
  vi.spyOn(c, "getGenesisHash").mockResolvedValue(
    "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  );
  vi.spyOn(c, "getAccountInfo").mockImplementation(async (k) =>
    k.equals(HYPE_MINT)
      ? info(mint)
      : k.equals(ata)
        ? info(funding)
        : k.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID)
          ? info(Buffer.alloc(0), true)
          : null,
  );
  vi.spyOn(c, "getEpochInfo").mockResolvedValue({
    epoch: 1,
    slotIndex: 1,
    slotsInEpoch: 432000,
    absoluteSlot: 1,
    blockHeight: 1,
    transactionCount: 1,
  });
  vi.spyOn(c, "getLatestBlockhash").mockResolvedValue({
    blockhash: PublicKey.default.toBase58(),
    lastValidBlockHeight: 100,
  });
  vi.spyOn(c, "getFeeForMessage").mockResolvedValue({
    context: { slot: 1 },
    value: 10000,
  });
  vi.spyOn(c, "getMinimumBalanceForRentExemption").mockResolvedValue(2039280);
  vi.spyOn(c, "getBalance").mockResolvedValue(1000000000);
  const send = vi
    .spyOn(c, "sendRawTransaction")
    .mockRejectedValue(Error("Broadcast forbidden"));
  return { c, owner, platform, mint, funding, send };
}
it("verifies HYPE mint and owned associated balance without wrapping SOL", async () => {
  const { c, owner } = setup();
  expect((await verifyHypeMint(c)).decimals).toBe(9);
  expect(await hypeBalance(c, owner)).toBe(5000000000n);
  expect(quoteAsset({ quote: "hype" }).mint.equals(HYPE_MINT)).toBe(true);
  expect(quoteAsset({}).mint.equals(HYPE_MINT)).toBe(true);
});
it("rejects changed mint decimals and a frozen funding account", async () => {
  const { c, owner, mint, funding } = setup();
  mint[44] = 6;
  await expect(verifyHypeMint(c)).rejects.toThrow("unsupported");
  funding[108] = 2;
  await expect(hypeBalance(c, owner)).rejects.toThrow("state mismatch");
});
it("constructs HYPE config + pool + protected buy with separate SOL and HYPE requirements", async () => {
  const { c, owner, platform, send } = setup();
  const values = {
    ...defaults,
    name: "Hype development",
    symbol: "HDEV",
    quote: "hype" as const,
    buy: "0.7",
    creatorShare: "100",
  };
  const plan = await buildPlan(
    c,
    values,
    owner,
    "mainnet-beta",
    "https://example.com/development.json",
  );
  expect(plan.buy).toBe(700000000n);
  expect(plan.quoteBalance).toBe(5000000000n);
  expect(plan.total).toBe(plan.fee + plan.rent + plan.poolFee);
  expect(remainingRequirement(plan)).toBe(plan.total);
  expect(
    plan.pool.equals(
      deriveDbcPoolAddress(HYPE_MINT, plan.mint.publicKey, plan.config),
    ),
  ).toBe(true);
  expect(plan.configParams.creatorTradingFeePercentage).toBe(80);
  expect(plan.configParams.partnerPermanentLockedLiquidityPercentage).toBe(20);
  expect(plan.configParams.creatorPermanentLockedLiquidityPercentage).toBe(80);
  expect(plan.recipients.partner).toBe(platform.toBase58());
  expect(plan.recipients.partner).not.toBe(owner.toBase58());
  expect(plan.configParams.migrationOption).toBe(1);
  expect(
    plan.configParams.migrationQuoteThreshold.eq(
      curve(values, owner).migrationQuoteThreshold,
    ),
  ).toBe(true);
  const sdk = new DynamicBondingCurveClient(c);
  const coder = new BorshInstructionCoder(sdk.program.idl);
  const ix = plan.steps
    .flatMap((s) => s.tx.instructions)
    .filter((i) => i.programId.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID));
  expect(ix[0].keys.some((k) => k.pubkey.equals(platform))).toBe(true);
  expect(ix.map((i) => coder.decode(i.data)!.name)).toEqual([
    "createConfig2",
    "initializeVirtualPoolWithSplToken",
    "swap",
  ]);
  expect(ix[0].keys.some((k) => k.pubkey.equals(HYPE_MINT))).toBe(true);
  // Every launch step sets an explicit compute-unit price, so Phantom (which adds its own when none is set) signs the
  // reviewed message unchanged; a wallet that still alters it is refused before anything is sent.
  const priced = (t: (typeof plan.steps)[number]["tx"]) =>
    t.instructions.some((i) => i.programId.equals(ComputeBudgetProgram.programId) && i.data[0] === 3);
  for (const step of plan.steps) {
    const price = step.tx.instructions.find((i) => i.programId.equals(ComputeBudgetProgram.programId) && i.data[0] === 3);
    expect(price?.data.readBigUInt64LE(1)).toBe(BigInt(LAUNCH_PRIORITY_MICROLAMPORTS));
    const reviewed = Buffer.from(step.tx.serializeMessage());
    if (!priced(step.tx)) step.tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }));
    expect(Buffer.from(step.tx.serializeMessage()).equals(reviewed)).toBe(true);
  }
  const last = plan.steps[plan.steps.length - 1];
  await expect(
    signReviewedTransaction(last.tx, owner, last.signers, async (t) => {
      t.instructions.unshift(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }));
      return t;
    }),
  ).rejects.toThrow("Wallet changed the reviewed transaction message");
  expect(ix[1].keys.some((k) => k.pubkey.equals(HYPE_MINT))).toBe(true);
  expect(
    plan.steps
      .flatMap((s) => s.tx.instructions)
      .flatMap((i) => i.keys)
      .some((k) => k.pubkey.equals(NATIVE_MINT)),
  ).toBe(false);
  for (const i of plan.steps[1].tx.instructions.filter((i) =>
    i.programId.equals(SystemProgram.programId),
  ))
    if (SystemInstruction.decodeInstructionType(i) === "Transfer")
      expect(BigInt(SystemInstruction.decodeTransfer(i).lamports)).not.toBe(
        700000000n,
      );
  const swap = (
    coder.decode(ix[2].data)!.data as {
      params: {
        amountIn: { toString(): string };
        minimumAmountOut: { toString(): string };
      };
    }
  ).params;
  expect(swap.amountIn.toString()).toBe("700000000");
  expect(BigInt(swap.minimumAmountOut.toString())).toBeGreaterThan(0n);
  const raw = memory();
  const scoped = scopedStorage(raw);
  storeRecovery(scoped, recoveryRecord(plan));
  expect(
    loadRecovery(scoped, "mainnet-beta", owner.toBase58())!.values.quote,
  ).toBe("hype");
  expect(() =>
    assertRecoveryAllows(scoped, "mainnet-beta", owner.toBase58()),
  ).toThrow("unresolved launch");
  expect(raw.getItem(`dbc-recovery-v1:mainnet-beta:${owner}`)).toBeNull();
  expect(send).not.toHaveBeenCalled();
});
it("blocks holder shares until a funded on-chain distributor exists", async () => {
  const { c, owner } = setup();
  await expect(
    buildPlan(
      c,
      { ...defaults, name: "Holder gated", symbol: "HGATE", creatorShare: "50" },
      owner,
      "mainnet-beta",
      "https://example.com/metadata.json",
    ),
  ).rejects.toThrow("requires the HYMET on-chain reward distributor");
  expect(c.getGenesisHash).not.toHaveBeenCalled();
});
it.each(["99", "73", "1", "0"])("never falls back to 100%% creator: %s%% creator is refused without a distributor", async (creatorShare) => {
  const { c, owner } = setup();
  await expect(
    buildPlan(c, { ...defaults, name: "Holder gated", symbol: "HGATE", creatorShare }, owner, "mainnet-beta", "https://example.com/metadata.json"),
  ).rejects.toThrow("requires the HYMET on-chain reward distributor");
});
it("rejects insufficient HYPE even when SOL is plentiful", async () => {
  const { c, owner } = setup();
  await expect(
    buildPlan(
      c,
      { ...defaults, name: "Test", symbol: "TEST", quote: "hype", buy: "6" },
      owner,
      "mainnet-beta",
      "https://example.com/test",
    ),
  ).rejects.toThrow("Insufficient HYPE");
});
it("never discovers or deletes original browser records", () => {
  const raw = memory();
  raw.setItem("dbc-recovery-v1:mainnet-beta:owner", "original");
  const dev = scopedStorage(raw);
  expect(dev.length).toBe(0);
  expect(dev.getItem("dbc-recovery-v1:mainnet-beta:owner")).toBeNull();
  dev.setItem("dbc-recovery-v1:mainnet-beta:owner", "development");
  expect(
    raw.getItem(DEV_STORAGE_PREFIX + "dbc-recovery-v1:mainnet-beta:owner"),
  ).toBe("development");
  dev.clear();
  expect(raw.getItem("dbc-recovery-v1:mainnet-beta:owner")).toBe("original");
});
it("blocks every development broadcast before contacting RPC", async () => {
  vi.stubEnv("ENABLE_MAINNET", "true");
  vi.stubEnv("HYPE_DEV_READ_ONLY", "true");
  const upstream = vi.spyOn(globalThis, "fetch");
  const r = await POST(
    new NextRequest("http://localhost:3001/api/rpc?network=mainnet-beta", {
      method: "POST",
      headers: { origin: "http://localhost:3001" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "sendTransaction",
        params: ["never-send"],
      }),
    }),
  );
  expect(r.status).toBe(403);
  expect(upstream).not.toHaveBeenCalled();
});
it("constructs HYPE with no initial buy and no HYPE funding ATA", async () => {
  const { c, owner, send } = setup();
  const original = vi.mocked(c.getAccountInfo).getMockImplementation()!;
  const ata = getAssociatedTokenAddressSync(HYPE_MINT, owner);
  vi.mocked(c.getAccountInfo).mockImplementation(async (key) =>
    key.equals(ata) ? null : original(key),
  );
  const plan = await buildPlan(
    c,
    { ...defaults, name: "No buy", symbol: "NOBUY", quote: "hype" },
    owner,
    "mainnet-beta",
    "https://example.com/test",
  );
  expect(plan.buy).toBe(0n);
  expect(plan.quoteBalance).toBe(0n);
  expect(plan.steps[1].label).toBe("Create token + pool");
  expect(send).not.toHaveBeenCalled();
});
