import { afterEach, it, expect, vi } from "vitest";
import { Connection, Keypair } from "@solana/web3.js";
import {
  DynamicBondingCurveClient,
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
  DAMM_V2_PROGRAM_ID,
  METAPLEX_PROGRAM_ID,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { BorshInstructionCoder } from "@coral-xyz/anchor";
import { renderToStaticMarkup } from "react-dom/server";
import { createRequire } from "node:module";
import { defaults } from "../lib/config";
import {
  buildPlan,
  assertCreatorRecipients,
  assertFeeRecipients,
  remainingRequirement,
  assertSigners,
} from "../lib/transactions";
import MainnetConfirmation from "../components/mainnet-confirmation";
import { POST } from "../app/api/rpc/route";
import { NextRequest } from "next/server";
afterEach(() => vi.unstubAllEnvs());
it("uses patched UUID generation through Jaysons existing v4-only client API", () => {
  const require = createRequire(import.meta.url);
  const generate = require("jayson/lib/generateRequest") as (
    method: string,
    params: unknown[],
    id: undefined,
    options: object,
  ) => { id: string };
  expect(generate("method", [], undefined, {}).id).toMatch(
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i,
  );
});
it("rejects a reusable config that would redirect partner fees or leftovers", () => {
  const wallet = Keypair.generate().publicKey,
    other = Keypair.generate().publicKey;
  expect(() => assertCreatorRecipients(wallet, wallet, wallet)).not.toThrow();
  expect(() => assertCreatorRecipients(wallet, other, wallet)).toThrow(
    "another wallet",
  );
  expect(() => assertCreatorRecipients(wallet, wallet, other)).toThrow(
    "another wallet",
  );
});
it("requires a distinct HYMET partner recipient and rejects creator rerouting", () => {
  const creator = Keypair.generate().publicKey,
    platform = Keypair.generate().publicKey,
    other = Keypair.generate().publicKey;
  expect(() => assertFeeRecipients(platform, creator, platform, creator)).not.toThrow();
  expect(() => assertFeeRecipients(platform, creator, creator, creator)).toThrow("creator routing");
  expect(() => assertFeeRecipients(platform, creator, platform, other)).toThrow("leftover tokens");
  expect(() => assertFeeRecipients(creator, creator, creator, creator)).toThrow("different wallet");
});
it("server keeps Mainnet disabled and makes no upstream request", async () => {
  vi.stubEnv("ENABLE_MAINNET", "false");
  const fetcher = vi.spyOn(globalThis, "fetch");
  const response = await POST(
    new NextRequest("http://localhost/api/rpc?network=mainnet-beta", {
      method: "POST",
      headers: { origin: "http://localhost" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "sendTransaction",
        params: ["not-sent"],
      }),
    }),
  );
  expect(response.status).toBe(403);
  expect(fetcher).not.toHaveBeenCalled();
  fetcher.mockRestore();
  vi.unstubAllEnvs();
});
it.skipIf(!process.env.TEST_MAINNET_RPC_URL)("constructs and decodes Mainnet plans with and without initial buy using only read-only RPC when a test RPC is configured", async () => {
  const c = new Connection(
    process.env.TEST_MAINNET_RPC_URL || "https://api.mainnet-beta.solana.com",
    {
      commitment: "confirmed",
      disableRetryOnRateLimit: true,
    },
  );
  const noSend = vi
    .spyOn(c, "sendRawTransaction")
    .mockRejectedValue(Error("Broadcast forbidden"));
  const ids = [
    DYNAMIC_BONDING_CURVE_PROGRAM_ID,
    DAMM_V2_PROGRAM_ID,
    METAPLEX_PROGRAM_ID,
  ];
  const programs = await c.getMultipleAccountsInfo(ids, "finalized");
  expect(programs.every((p) => p?.executable)).toBe(true);
  const creator = Keypair.generate().publicKey,
    platform = Keypair.generate().publicKey;
  vi.stubEnv("HYMET_PLATFORM_FEE_RECIPIENT", platform.toBase58());
  // Public RPC load balancers may route the fee read to a node behind a fresh
  // confirmed blockhash. A finalized hash is known across those nodes while
  // still allowing the real fee RPC and production fail-closed logic to run.
  const blockhash = c.getLatestBlockhash.bind(c);
  vi.spyOn(c, "getLatestBlockhash").mockImplementation(() =>
    blockhash("finalized"),
  );
  // Cache immutable program/mint reads within this test to avoid public RPC bursts.
  const read = c.getAccountInfo.bind(c),
    cache = new Map<string, ReturnType<typeof read>>();
  vi.spyOn(c, "getAccountInfo").mockImplementation((address, config) => {
    const k = address.toBase58();
    if (!cache.has(k)) cache.set(k, read(address, config));
    return cache.get(k)!;
  });
  const epoch = await c.getEpochInfo();
  vi.spyOn(c, "getEpochInfo").mockResolvedValue(epoch);
  const rent = c.getMinimumBalanceForRentExemption.bind(c),
    rents = new Map<number, ReturnType<typeof rent>>();
  vi.spyOn(c, "getMinimumBalanceForRentExemption").mockImplementation(
    (size) => {
      if (!rents.has(size)) rents.set(size, rent(size));
      return rents.get(size)!;
    },
  );
  for (const buy of ["0", "0.7"]) {
    const values = {
      ...defaults,
      name: "Mainnet review",
      symbol: "REVIEW",
      creatorShare: "100",
      buy,
    };
    if (buy !== "0") {
      // HYPE is the only quote asset: an unfunded creator fails closed before any signing.
      await expect(
        buildPlan(c, values, creator, "mainnet-beta", "https://example.com/metadata.json"),
      ).rejects.toThrow("Insufficient HYPE");
      continue;
    }
    const plan = await buildPlan(
      c,
      values,
      creator,
      "mainnet-beta",
      "https://example.com/metadata.json",
    );
    expect(plan.network).toBe("mainnet-beta");
    expect(plan.steps).toHaveLength(2);
    expect(plan.poolFee).toBe(0n);
    expect(plan.recipients).toEqual({
      partner: platform.toBase58(),
      leftover: creator.toBase58(),
    });
    expect(remainingRequirement(plan)).toBe(plan.total);
    for (const step of plan.steps) {
      assertSigners(step.tx, creator, step.signers);
      expect(step.tx.compileMessage().header.numRequiredSignatures).toBe(2);
      expect(step.signature).toBeUndefined();
    }
    const sdk = new DynamicBondingCurveClient(c),
      coder = new BorshInstructionCoder(sdk.program.idl);
    const instructions = plan.steps
      .flatMap((s) => s.tx.instructions)
      .filter((ix) => ix.programId.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID))
      .map((ix) => coder.decode(ix.data)!);
    expect(instructions.map((ix) => ix.name)).toEqual(
      buy === "0"
        ? ["createConfig2", "initializeVirtualPoolWithSplToken"]
        : ["createConfig2", "initializeVirtualPoolWithSplToken", "swap"],
    );
    const configured = (
      instructions[0].data as {
        configParameters: {
          creatorTradingFeePercentage: number;
          migrationOption: number;
          tokenUpdateAuthority: number;
          creatorPermanentLockedLiquidityPercentage: number;
        };
      }
    ).configParameters;
    expect(configured).toMatchObject({
      // HYMET: 20% partner (platform) / 80% creator; migrated creator liquidity locked.
      creatorTradingFeePercentage: 80,
      migrationOption: 1,
      tokenUpdateAuthority: 1,
      creatorPermanentLockedLiquidityPercentage: 80,
    });
    const html = renderToStaticMarkup(
      <MainnetConfirmation
        plan={plan}
        onConfirm={() => {
          throw Error("No confirmation in static test");
        }}
        onCancel={() => {}}
      />,
    );
    for (const value of [
      "Solana Mainnet Beta",
      "STEP 2 OF 2",
      "Transaction verification",
      plan.mint.publicKey.toBase58(),
      plan.pool.toBase58(),
      creator.toBase58(),
      "80%",
      "Estimated SOL requirement",
      "/docs#distribution",
      "simulation",
    ])
      expect(html).toContain(value);
    expect(html).toMatch(/<button class="primary">Confirm Launch<\/button>/);
    expect(html).not.toContain('type="checkbox"');
  }
  expect(noSend).not.toHaveBeenCalled();
}, 30000);
afterEach(() => vi.unstubAllEnvs());
