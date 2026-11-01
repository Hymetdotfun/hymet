import { afterEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { IdlCoder } from "@coral-xyz/anchor/dist/cjs/coder/borsh/idl";
import type { Idl } from "@coral-xyz/anchor";
import idl from "../lib/idl/damm-v2-pool.json";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  DynamicBondingCurveClient,
  DAMM_V2_PROGRAM_ID,
  DAMM_V2_MIGRATION_FEE_ADDRESS,
  deriveDammV2PoolAddress,
  type VirtualPool,
  type PoolConfig,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { migrationState, readMigration, dammPoolCoder } from "../lib/migration";
import { MigrationStatus } from "../components/migration-status";
import fixture from "./fixtures/creator-fees-mainnet.json";
import { readCreatorFees } from "../lib/creator-fees";
afterEach(() => vi.restoreAllMocks());
it.skipIf(!process.env.TEST_MAINNET_RPC_URL)("reads the existing Mainnet fixture pool with network verification and no broadcast when a test RPC is configured", async () => {
  const c = new Connection(process.env.TEST_MAINNET_RPC_URL || "https://api.mainnet-beta.solana.com", {
    commitment: "confirmed",
    disableRetryOnRateLimit: true,
  });
  const send = vi
    .spyOn(c, "sendRawTransaction")
    .mockRejectedValue(Error("must never send"));
  const view = await readCreatorFees(
    c,
    "mainnet-beta",
    fixture.accounts[0].address,
  );
  expect(view.mint).toBe(fixture.summary.mint);
  expect(view.creator).toBe(fixture.summary.creator);
  expect(view.migration.claiming).toBe("verify-position");
  expect(view.migration.label).not.toBe("Unknown");
  expect(send).not.toHaveBeenCalled();
}, 30000);
function setup() {
  const c = new Connection("http://localhost:8899");
  const coder = new DynamicBondingCurveClient(c).program.coder.accounts;
  const p = coder.decode<VirtualPool>(
    "virtualPool",
    Buffer.from(fixture.accounts[0].account!.data, "base64"),
  ).poolState;
  const cfg = coder.decode<PoolConfig>(
    "poolConfig",
    Buffer.from(fixture.accounts[1].account!.data, "base64"),
  );
  return { c, p, cfg };
}
it("reads active, eligible, pending and completed states from exact on-chain flags and quote threshold", () => {
  const { p, cfg } = setup();
  expect(migrationState(p, cfg).label).toBe("Bonding Curve Active");
  p.quoteReserve = cfg.migrationQuoteThreshold.clone();
  expect(migrationState(p, cfg).label).toBe("Migration Eligible");
  for (const flag of [1, 2, 3]) {
    p.migrationProgress = flag;
    expect(migrationState(p, cfg)).toMatchObject({
      label: "Migration Pending",
      venue: "Unknown",
    });
  }
  p.isMigrated = 1;
  expect(migrationState(p, cfg)).toMatchObject({
    label: "Migrated to DAMM V2",
    venue: "Unknown",
  });
  p.migrationProgress = 99;
  expect(migrationState(p, cfg).label).toBe("Unknown");
});
it("does not query a successor before completion or treat DAMM V1 as V2", async () => {
  const { c, p, cfg } = setup();
  const rpc = vi.spyOn(c, "getMultipleAccountsInfo");
  await readMigration(c, p, cfg);
  cfg.migrationOption = 0;
  p.isMigrated = 1;
  expect((await readMigration(c, p, cfg)).venue).toBe("Unknown");
  expect(rpc).not.toHaveBeenCalled();
});
async function migrated() {
  const { c, p, cfg } = setup();
  p.isMigrated = 1;
  const zero = Buffer.alloc(dammPoolCoder.size("Pool"));
  Buffer.from([241, 154, 109, 4, 17, 177, 109, 188]).copy(zero);
  const state = dammPoolCoder.decode<Record<string, unknown>>("Pool", zero);
  state.token_a_mint = p.baseMint;
  state.token_b_mint = cfg.quoteMint;
  const account = {
    owner: DAMM_V2_PROGRAM_ID,
    executable: false,
    lamports: 1,
    rentEpoch: 0,
    data: encodePool(state),
  };
  const rpc = vi
    .spyOn(c, "getMultipleAccountsInfo")
    .mockResolvedValue([{ ...account, executable: true }, account]);
  const send = vi
    .spyOn(c, "sendRawTransaction")
    .mockRejectedValue(Error("must never send"));
  return { c, p, cfg, account, rpc, send, state };
}
it("verifies program, owner, full official account layout, mint pair and SDK destination PDA without constructing a transaction", async () => {
  const { c, p, cfg, rpc, send } = await migrated();
  const view = await readMigration(c, p, cfg);
  const destination = deriveDammV2PoolAddress(
    DAMM_V2_MIGRATION_FEE_ADDRESS[cfg.migrationFeeOption],
    p.baseMint,
    cfg.quoteMint,
  );
  expect(view).toMatchObject({
    venue: "DAMM V2",
    destination: destination.toBase58(),
    claiming: "verify-position",
  });
  expect(rpc).toHaveBeenCalledWith(
    [DAMM_V2_PROGRAM_ID, destination],
    "confirmed",
  );
  expect(send).not.toHaveBeenCalled();
  expect(view).not.toHaveProperty("fees");
});
it("rejects missing/foreign accounts, changed mints, discriminator, layout, nonexecutable program and RPC failure without inventing balances", async () => {
  const { c, p, cfg, account, rpc, state } = await migrated();
  for (const accounts of [
    [null, account],
    [{ ...account, executable: false }, account],
    [{ ...account, executable: true }, null],
    [
      { ...account, executable: true },
      { ...account, owner: Keypair.generate().publicKey },
    ],
    [
      { ...account, executable: true },
      { ...account, data: Buffer.alloc(account.data.length) },
    ],
    [
      { ...account, executable: true },
      { ...account, data: account.data.subarray(0, 100) },
    ],
  ]) {
    rpc.mockResolvedValueOnce(accounts);
    expect(await readMigration(c, p, cfg)).toMatchObject({
      venue: "Unknown",
      claiming: "verify-position",
    });
  }
  state.token_a_mint = PublicKey.default;
  rpc.mockResolvedValueOnce([
    { ...account, executable: true },
    { ...account, data: encodePool(state) },
  ]);
  expect((await readMigration(c, p, cfg)).destination).toBeUndefined();
  rpc.mockRejectedValueOnce(Error("RPC unavailable"));
  expect((await readMigration(c, p, cfg)).detail).toContain("RPC unavailable");
});
it("separates network links and labels unavailable fees and claims without enabling any signing action", () => {
  const destination = Keypair.generate().publicKey.toBase58();
  for (const network of ["devnet", "mainnet-beta"] as const) {
    const html = renderToStaticMarkup(
      <MigrationStatus
        network={network}
        migration={{
          label: "Migrated to DAMM V2",
          venue: "DAMM V2",
          destination,
          claiming: "verify-position",
        }}
      />,
    );
    expect(html).toContain("DAMM V2 Claimable Fees:");
    expect(html).toContain("Verify wallet-owned positions");
    expect(html).not.toContain("<button");
    expect(html.includes("?cluster=devnet")).toBe(network === "devnet");
  }
});

function encodePool(state: Record<string, unknown>) {
  const schema = idl as Idl;
  const body = Buffer.alloc(dammPoolCoder.size("Pool") - 8);
  const layout = IdlCoder.typeDefLayout({
    typeDef: schema.types!.find((t) => t.name === "Pool")!,
    types: schema.types!,
  });
  layout.encode(state, body);
  return Buffer.concat([Buffer.from(idl.accounts[0].discriminator), body]);
}
