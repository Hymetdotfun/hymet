import { it, expect, vi, afterEach } from "vitest";
import { Connection, SystemProgram, PublicKey } from "@solana/web3.js";
import { MintLayout, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { HYPE_MINT } from "../lib/quote-assets";
import { BorshInstructionCoder } from "@coral-xyz/anchor";
import {
  DynamicBondingCurveClient,
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
  StateService,
  type PoolConfig,
  type ConfigParameters,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import bs58 from "bs58";
import fixture from "./fixtures/incomplete-devnet-config.json";
import { defaults } from "../lib/config";
import {
  compatible,
  buildPlan,
  remainingRequirement,
  type Plan,
} from "../lib/transactions";
import {
  loadRecovery,
  storeRecovery,
  assertRecoveryAllows,
  checkRecovery,
  withLaunchLock,
  type RecoveryRecord,
} from "../lib/recovery";
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const storage = () => {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      data.set(k, v);
    },
    data,
  };
};
function record(): RecoveryRecord {
  return {
    version: 1,
    state: "pending",
    network: "devnet",
    creator: fixture.creator,
    mint: fixture.addresses.mint,
    pool: fixture.addresses.pool,
    config: fixture.addresses.config,
    values: { ...defaults, name: "owa", symbol: "owa" },
    uri: "https://example.com/meta",
    recipients: { partner: fixture.creator, leftover: fixture.creator },
    steps: [
      { label: "Config", signature: fixture.signature },
      { label: "Pool" },
    ],
  };
}
function connection() {
  const c = new Connection("http://localhost:8899");
  const sdk = new DynamicBondingCurveClient(c);
  const account = {
    data: Buffer.from(fixture.configAccountBase64, "base64"),
    owner: DYNAMIC_BONDING_CURVE_PROGRAM_ID,
    executable: false,
    lamports: 5974080,
    rentEpoch: 0,
  };
  const actual = sdk.program.coder.accounts.decode<PoolConfig>(
    "poolConfig",
    account.data,
  );
  vi.spyOn(c, "getGenesisHash").mockResolvedValue(
    "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  );
  vi.spyOn(c, "getAccountInfo").mockImplementation(async (address) =>
    address.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID)
      ? { ...account, executable: true }
      : account,
  );
  vi.spyOn(c, "getMultipleAccountsInfo").mockResolvedValue([
    null,
    null,
    account,
  ]);
  vi.spyOn(c, "getSignatureStatuses").mockResolvedValue({
    context: { slot: 1 },
    value: [
      {
        slot: 1,
        err: null,
        confirmations: null,
        confirmationStatus: "finalized",
      },
    ],
  });
  vi.spyOn(StateService.prototype, "getPoolConfig").mockResolvedValue(actual);
  return { c, sdk, actual };
}
// This archived fixture uses a different quote mint, so it must not be reused by HYPE-only launches.
it.skip("accepts the exact finalized owa config against its original on-chain createConfig2 instruction", () => {
  const { sdk, actual } = connection();
  const decoded = new BorshInstructionCoder(sdk.program.idl).decode(
    Buffer.from(bs58.decode(fixture.configInstructionBase58)),
  )!;
  expect(decoded.name).toBe("createConfig2");
  expect(() =>
    compatible(
      actual,
      (decoded.data as { configParameters: ConfigParameters }).configParameters,
    ),
  ).not.toThrow();
});
it("persists only public recovery values, blocks duplicate preparation after refresh, and blocks resuming a closed record", () => {
  const s = storage(),
    r = record();
  storeRecovery(s, r);
  expect(loadRecovery(s, r.network, r.creator)).toEqual(r);
  expect(() => assertRecoveryAllows(s, r.network, r.creator)).toThrow(
    "unresolved launch",
  );
  expect(() =>
    assertRecoveryAllows(s, r.network, r.creator, r.mint),
  ).not.toThrow();
  const serialized = [...s.data.values()][0];
  for (const forbidden of ["secretKey", "signers", "privateKey", '"tx"'])
    expect(serialized).not.toContain(forbidden);
  storeRecovery(s, { ...r, state: "closed" });
  expect(() => assertRecoveryAllows(s, r.network, r.creator, r.mint)).toThrow(
    "closed",
  );
  expect(() => assertRecoveryAllows(s, r.network, r.creator)).not.toThrow();
});
it.skip("recognizes the exact config-only incomplete launch without resubmitting or declaring a token successful (archived quote-mint fixture)", async () => {
  const { c } = connection();
  const send = vi
    .spyOn(c, "sendRawTransaction")
    .mockRejectedValue(Error("No broadcast"));
  const result = await checkRecovery(c, record());
  expect(result.kind).toBe("config-only");
  expect(result.message).toContain("no mint or pool exists");
  expect(send).not.toHaveBeenCalled();
});
it.skip.each(["0", "0.01"])(
  "reuses the confirmed config with buy %s without creating another config or broadcasting",
  async (buy) => {
    const { c, sdk, actual } = connection();
    const send = vi
      .spyOn(c, "sendRawTransaction")
      .mockRejectedValue(Error("No broadcast"));
    expect((await checkRecovery(c, record())).kind).toBe("config-only");
    vi.spyOn(StateService.prototype, "getPoolConfigWithKind").mockResolvedValue(
      { poolConfig: actual, transferHookConfig: null },
    );
    vi.spyOn(c, "getEpochInfo").mockResolvedValue({
      epoch: 1,
      slotIndex: 1,
      slotsInEpoch: 100,
      absoluteSlot: 101,
    });
    const mintData = Buffer.alloc(82);
    MintLayout.encode(
      {
        mintAuthorityOption: 0,
        mintAuthority: SystemProgram.programId,
        supply: 0n,
        decimals: 9,
        isInitialized: true,
        freezeAuthorityOption: 0,
        freezeAuthority: SystemProgram.programId,
      },
      mintData,
    );
    const read = vi.mocked(c.getAccountInfo).getMockImplementation()!;
    vi.mocked(c.getAccountInfo).mockImplementation(async (address, options) =>
      address.equals(HYPE_MINT)
        ? {
            data: mintData,
            owner: TOKEN_PROGRAM_ID,
            executable: false,
            lamports: 1,
            rentEpoch: 0,
          }
        : read(address, options),
    );
    vi.spyOn(c, "getLatestBlockhash").mockResolvedValue({
      blockhash: SystemProgram.programId.toBase58(),
      lastValidBlockHeight: 100,
    });
    vi.spyOn(c, "getFeeForMessage").mockResolvedValue({
      context: { slot: 1 },
      value: 10000,
    });
    vi.spyOn(c, "getMinimumBalanceForRentExemption").mockResolvedValue(1000);
    vi.spyOn(c, "getBalance").mockResolvedValue(1000000000);
    const r = record();
    const plan = await buildPlan(
      c,
      { ...r.values, reuse: r.config, buy },
      new PublicKey(r.creator),
      "devnet",
      r.uri,
    );
    expect(plan.config.toBase58()).toBe(r.config);
    expect(plan.configRent).toBe(0n);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].signers.map((s) => s.publicKey.toBase58())).toEqual([
      plan.mint.publicKey.toBase58(),
    ]);
    const coder = new BorshInstructionCoder(sdk.program.idl);
    const names = plan.steps[0].tx.instructions
      .filter((ix) => ix.programId.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID))
      .map((ix) => coder.decode(ix.data)!.name);
    expect(names).toEqual(
      buy === "0"
        ? ["initializeVirtualPoolWithSplToken"]
        : ["initializeVirtualPoolWithSplToken", "swap"],
    );
    expect(plan.steps[0].signature).toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  },
);
it("does not release a record when a signature is unknown or only confirmed", async () => {
  const { c } = connection();
  vi.mocked(c.getSignatureStatuses)
    .mockResolvedValueOnce({ context: { slot: 1 }, value: [null] })
    .mockResolvedValueOnce({
      context: { slot: 1 },
      value: [
        {
          slot: 1,
          err: null,
          confirmations: 1,
          confirmationStatus: "confirmed",
        },
      ],
    });
  await expect(checkRecovery(c, record())).rejects.toThrow("uncertain");
  await expect(checkRecovery(c, record())).rejects.toThrow("not finalized");
  expect(c.getMultipleAccountsInfo).not.toHaveBeenCalled();
});
it.skip("requires manual inspection when a successful pool signature exists but its accounts are absent (archived quote-mint fixture)", async () => {
  const { c } = connection(),
    r = record();
  r.steps[1].signature = "pool-recorded";
  vi.mocked(c.getSignatureStatuses).mockResolvedValue({
    context: { slot: 1 },
    value: [
      {
        slot: 1,
        err: null,
        confirmations: null,
        confirmationStatus: "finalized",
      },
      {
        slot: 2,
        err: null,
        confirmations: null,
        confirmationStatus: "finalized",
      },
    ],
  });
  await expect(checkRecovery(c, r)).rejects.toThrow("accounts are absent");
});
it("blocks a second prepared mint while a first record is pending", () => {
  const s = storage(),
    r = record();
  storeRecovery(s, r);
  expect(() =>
    assertRecoveryAllows(
      s,
      r.network,
      r.creator,
      SystemProgram.programId.toBase58(),
    ),
  ).toThrow("unresolved launch");
});
it.skip.each([99, 100, 101])(
  "permits inspection-based config reuse only after the recorded blockhash expires at finalized height %s",
  async (height) => {
    const { c } = connection(),
      r = record();
    r.steps[1] = {
      label: "Pool",
      signature: "unlanded-pool",
      lastValidBlockHeight: 100,
    };
    vi.mocked(c.getSignatureStatuses).mockResolvedValue({
      context: { slot: 1 },
      value: [
        {
          slot: 1,
          err: null,
          confirmations: null,
          confirmationStatus: "finalized",
        },
        null,
      ],
    });
    vi.spyOn(c, "getBlockHeight").mockResolvedValue(height);
    vi.spyOn(c, "getSlot").mockResolvedValue(999);
    if (height <= 100)
      await expect(checkRecovery(c, r)).rejects.toThrow("uncertain");
    else {
      expect((await checkRecovery(c, r)).kind).toBe("config-only");
      expect(c.getMultipleAccountsInfo).toHaveBeenCalledWith(
        expect.any(Array),
        { commitment: "finalized", minContextSlot: 999 },
      );
    }
  },
);
it("fails closed on malformed stored public records", () => {
  const s = storage(),
    r = record();
  storeRecovery(s, r);
  const k = [...s.data.keys()][0];
  s.data.set(k, "not json");
  expect(() => loadRecovery(s, r.network, r.creator)).toThrow();
});
it("serializes signing/recovery across tabs and fails when the browser lock is unavailable", async () => {
  const action = vi.fn(async () => 42);
  vi.stubGlobal("navigator", {
    locks: {
      request: async (
        _name: string,
        _options: object,
        callback: (lock: object | null) => Promise<number>,
      ) => callback(null),
    },
  });
  await expect(
    withLaunchLock("devnet", fixture.creator, action),
  ).rejects.toThrow("Another tab");
  expect(action).not.toHaveBeenCalled();
  vi.stubGlobal("navigator", {
    locks: {
      request: async (
        _name: string,
        _options: object,
        callback: (lock: object | null) => Promise<number>,
      ) => callback({}),
    },
  });
  expect(await withLaunchLock("devnet", fixture.creator, action)).toBe(42);
});
it("does not charge the confirmed config rent or transaction fee a second time", () => {
  const p = {
    values: { reuse: "" },
    steps: [{ done: true, estimatedFee: 10000n }, { estimatedFee: 10000n }],
    fee: 20000n,
    rent: 100000n,
    configRent: 40000n,
    poolFee: 0n,
    buy: 10000000n,
  } as Plan;
  expect(remainingRequirement(p)).toBe(70000n);
  p.steps[1].done = true;
  expect(remainingRequirement(p)).toBe(0n);
});
it("closes only explicitly unsigned absent launches; legacy unknown records stay blocked", async () => {
  const { c } = connection();
  const r = record();
  r.steps = [{ label: "Config", phase: "unsigned" }];
  vi.mocked(c.getSignatureStatuses).mockResolvedValue({
    context: { slot: 1 },
    value: [],
  });
  vi.mocked(c.getMultipleAccountsInfo).mockResolvedValue([null, null, null]);
  expect((await checkRecovery(c, r)).kind).toBe("failed");
  delete r.steps[0].phase;
  await expect(checkRecovery(c, r)).rejects.toThrow("could not be verified");
});
it("blocks unresolved wallet approvals until finalized expiry and absent accounts", async () => {
  const { c } = connection();
  const r = record();
  r.steps = [
    { label: "Config", phase: "awaiting-signature", lastValidBlockHeight: 100 },
  ];
  const height = vi.spyOn(c, "getBlockHeight").mockResolvedValue(100);
  await expect(checkRecovery(c, r)).rejects.toThrow(
    "approval completion is unknown",
  );
  height.mockResolvedValue(101);
  vi.spyOn(c, "getSlot").mockResolvedValue(123);
  vi.mocked(c.getSignatureStatuses).mockResolvedValue({
    context: { slot: 1 },
    value: [],
  });
  vi.mocked(c.getMultipleAccountsInfo).mockResolvedValue([null, null, null]);
  expect((await checkRecovery(c, r)).kind).toBe("failed");
});
