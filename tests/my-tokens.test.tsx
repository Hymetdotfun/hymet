import BN from "bn.js";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, it, expect, vi } from "vitest";
import {
  Connection,
  PublicKey,
  Keypair,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  DynamicBondingCurveClient,
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
  type VirtualPool,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { renderToStaticMarkup } from "react-dom/server";
import bs58 from "bs58";
import fixture from "./fixtures/creator-fees-mainnet.json";
import { defaults } from "../lib/config";
import { rememberCreatorPool, saveClaim } from "../lib/creator-fees";
import {
  discoverTokenPools,
  importToken,
  refreshTokens,
  readToken,
  savedTokens,
  publicTokenUrl,
  selectCreatorFees,
  tokenExplorer,
} from "../lib/my-tokens";
import { TokenCard } from "../components/my-tokens";
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const owner = fixture.summary.creator,
  pool = fixture.accounts[0].address,
  network = "mainnet-beta" as const;
function storage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      data.set(k, v);
    },
  };
}
it("starts empty on both networks without fetching or inserting any public fixture", async () => {
  const s = storage();
  const c = new Connection("http://localhost:8899");
  const rpc = vi.spyOn(c, "getAccountInfo");
  const genesis = vi.spyOn(c, "getGenesisHash");
  for (const n of ["devnet", "mainnet-beta"] as const) {
    expect(discoverTokenPools(s, n, owner)).toEqual([]);
    expect(await refreshTokens(c, n, owner, s)).toEqual({ tokens: [], errors: [] });
  }
  expect(s.data.size).toBe(0);
  expect(rpc).not.toHaveBeenCalled();
  expect(genesis).not.toHaveBeenCalled();
  expect(defaults.name).toBe("");
  expect(defaults.symbol).toBe("");
});
it("keeps historical token identities and fixture imports out of production source", () => {
  const identities = ["Patntrick", "Pathtrick", owner, pool, fixture.accounts[1].address, fixture.summary.mint];
  function check(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) check(path);
      else if (/\.(?:tsx?|mjs|json)$/.test(entry.name)) {
        const source = readFileSync(path, "utf8");
        for (const identity of identities.filter(Boolean))
          expect(source.toLowerCase(), path).not.toContain(identity.toLowerCase());
        expect(source, path).not.toMatch(/(?:from\s*|import\s*\()["'][^"']*fixtures\//);
      }
    }
  }
  for (const directory of ["app", "components", "lib", "scripts"]) check(directory);
});
function setup() {
  const c = new Connection("http://localhost:8899"),
    s = storage(),
    sdk = new DynamicBondingCurveClient(c);
  const accounts = new Map(
    fixture.accounts.map((a) => [
      a.address,
      a.account
        ? {
            ...a.account,
            data: Buffer.from(a.account.data, "base64"),
            owner: new PublicKey(a.account.owner),
            rentEpoch: 0,
          }
        : null,
    ]),
  );
  vi.spyOn(c, "getGenesisHash").mockResolvedValue(fixture.genesis);
  vi.spyOn(c, "getAccountInfo").mockImplementation(async (k) =>
    k.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID)
      ? {
          owner: DYNAMIC_BONDING_CURVE_PROGRAM_ID,
          data: Buffer.alloc(0),
          executable: true,
          lamports: 1,
          rentEpoch: 0,
        }
      : (accounts.get(k.toBase58()) ?? null),
  );
  vi.spyOn(c, "getMultipleAccountsInfo").mockImplementation(async (ks) =>
    ks.map((k) => accounts.get(k.toBase58()) ?? null),
  );
  vi.spyOn(c, "getTransaction").mockResolvedValue(null);
  const send = vi
    .spyOn(c, "sendRawTransaction")
    .mockRejectedValue(Error("Dashboard must never send"));
  const simulate = vi
    .spyOn(c, "simulateTransaction")
    .mockRejectedValue(
      Error("Dashboard must never construct/simulate transactions"),
    );
  const fetcher = vi
    .fn()
    .mockResolvedValue(
      Response.json({ image: "https://images.example/token.png" }),
    );
  vi.stubGlobal("fetch", fetcher);
  const state = sdk.program.coder.accounts.decode<VirtualPool>(
    "virtualPool",
    accounts.get(pool)!.data,
  );
  async function update() {
    accounts.get(pool)!.data = Buffer.from(
      await sdk.program.coder.accounts.encode("virtualPool", state),
    );
  }
  return { c, s, sdk, accounts, send, simulate, fetcher, state, update };
}
function recovery() {
  return {
    version: 1,
    state: "closed",
    network,
    creator: owner,
    pool,
    mint: fixture.summary.mint,
    config: fixture.summary.config,
    values: { ...defaults, name: "Pathtrick", symbol: "PATH" },
    recipients: { partner: owner, leftover: owner },
    uri: "https://gateway.example/meta",
    steps: [{ label: "Pool" }],
  };
}
it("discovers existing recovery/creator-pool candidates without altering those records and isolates networks and wallets", () => {
  const s = storage(),
    key = `dbc-recovery-v1:${network}:${owner}`,
    r = JSON.stringify(recovery());
  s.setItem(key, r);
  rememberCreatorPool(s, network, owner, pool);
  expect(discoverTokenPools(s, network, owner)).toEqual([pool]);
  expect(discoverTokenPools(s, "devnet", owner)).toEqual([]);
  expect(
    discoverTokenPools(s, network, Keypair.generate().publicKey.toBase58()),
  ).toEqual([]);
  expect(s.getItem(key)).toBe(r);
});
it("verifies actual fixture pool/config/mint/creator before saving an import and displays exact fees and real SDK progress", async () => {
  const { c, s, send, simulate, fetcher } = setup();
  const v = await importToken(c, network, pool, owner, s);
  expect(v).toMatchObject({
    name: "Pathtrick",
    mint: fixture.summary.mint,
    config: fixture.summary.config,
    creator: owner,
    base: 0n,
    quote: 6904167n,
    status: "active",
    logo: "https://images.example/token.png",
  });
  expect(v.progress).toBeGreaterThanOrEqual(0);
  expect(v.progress).toBeLessThanOrEqual(1);
  expect(savedTokens(s, network, owner).map((t) => t.pool)).toEqual([pool]);
  expect(savedTokens(s, "devnet", owner)).toEqual([]);
  expect(fetcher).toHaveBeenCalledWith(
    expect.stringContaining("https://gateway.pinata.cloud/"),
    expect.objectContaining({
      credentials: "omit",
      referrerPolicy: "no-referrer",
      redirect: "error",
    }),
  );
  expect(send).not.toHaveBeenCalled();
  expect(simulate).not.toHaveBeenCalled();
});
it("never saves an invalid, missing, wrong-owner, or wrong-network pool", async () => {
  const { c, s, accounts } = setup();
  await expect(
    importToken(c, network, pool, Keypair.generate().publicKey.toBase58(), s),
  ).rejects.toThrow("creator wallet");
  await expect(importToken(c, "devnet", pool, owner, s)).rejects.toThrow(
    "genesis",
  );
  await expect(
    importToken(c, network, "not-a-public-key", owner, s),
  ).rejects.toThrow();
  accounts.get(fixture.summary.config)!.owner = SystemProgram.programId;
  await expect(importToken(c, network, pool, owner, s)).rejects.toThrow(
    "Config",
  );
  expect(s.data.size).toBe(0);
});
it("filters foreign creators during refresh and reports unavailable RPC/pools without inventing token data", async () => {
  const { c, s, state, update } = setup();
  rememberCreatorPool(s, network, owner, pool);
  state.poolState.creator = Keypair.generate().publicKey;
  await update();
  const foreign = await refreshTokens(c, network, owner, s);
  expect(foreign.tokens).toEqual([]);
  expect(foreign.errors[0].message).toContain("creator wallet");
  vi.mocked(c.getGenesisHash).mockRejectedValue(Error("RPC unavailable"));
  const down = await refreshTokens(c, network, owner, s);
  expect(down.tokens).toEqual([]);
  expect(down.errors[0].message).toBe("RPC unavailable");
});
it("requires successful on-chain claim instructions scoped to the actual creator and pool for the last-claim display", async () => {
  const { c, s, sdk, send } = setup(),
    sig = bs58.encode(Buffer.alloc(64, 7));
  saveClaim(s, {
    network,
    wallet: owner,
    pool,
    signature: sig,
    lastValidBlockHeight: 100,
    state: "confirmed",
  });
  const original = [...s.data.values()][0];
  const tx = await sdk.creator.claimCreatorTradingFee({
    creator: new PublicKey(owner),
    payer: new PublicKey(owner),
    receiver: new PublicKey(owner),
    pool: new PublicKey(pool),
    maxBaseAmount: new BN(0),
    maxQuoteAmount: new BN(0),
  });
  tx.feePayer = new PublicKey(owner);
  tx.recentBlockhash = SystemProgram.programId.toBase58();
  vi.mocked(c.getTransaction).mockResolvedValue({
    slot: 123,
    blockTime: 1792600000,
    meta: { err: null },
    transaction: { message: tx.compileMessage() },
  } as never);
  const view = await importToken(c, network, pool, owner, s);
  expect(view.lastClaim).toEqual({
    signature: sig,
    slot: 123,
    blockTime: 1792600000,
  });
  expect(s.getItem(`dbc-creator-claim-v1:${network}:${owner}`)).toBe(original);
  saveClaim(s, {
    network,
    wallet: owner,
    pool,
    signature: bs58.encode(Buffer.alloc(64, 8)),
    lastValidBlockHeight: 100,
    state: "pending",
  });
  vi.mocked(c.getTransaction).mockImplementation(async (signature) =>
    signature === sig
      ? ({
          slot: 123,
          blockTime: 1792600000,
          meta: { err: null },
          transaction: { message: tx.compileMessage() },
        } as never)
      : null,
  );
  expect(
    (await readToken(c, network, pool, owner, s)).lastClaim?.signature,
  ).toBe(sig);
  expect(send).not.toHaveBeenCalled();
});
it("does not trust a local confirmed label when the transaction failed or was not a DBC creator claim", async () => {
  const { c, s } = setup(),
    sig = bs58.encode(Buffer.alloc(64, 6));
  saveClaim(s, {
    network,
    wallet: owner,
    pool,
    signature: sig,
    lastValidBlockHeight: 100,
    state: "confirmed",
  });
  const tx = new Transaction({
    feePayer: new PublicKey(owner),
    recentBlockhash: SystemProgram.programId.toBase58(),
  }).add(
    SystemProgram.transfer({
      fromPubkey: new PublicKey(owner),
      toPubkey: Keypair.generate().publicKey,
      lamports: 1,
    }),
  );
  vi.mocked(c.getTransaction).mockResolvedValue({
    slot: 1,
    meta: { err: null },
    transaction: { message: tx.compileMessage() },
  } as never);
  expect(
    (await readToken(c, network, pool, owner, s)).lastClaim,
  ).toBeUndefined();
  vi.mocked(c.getTransaction).mockResolvedValue({
    slot: 1,
    meta: { err: { InstructionError: [0, "Custom"] } },
    transaction: { message: tx.compileMessage() },
  } as never);
  expect(
    (await readToken(c, network, pool, owner, s)).lastClaim,
  ).toBeUndefined();
});
it("does not fabricate migrated curve progress or accept unsafe logo URLs", async () => {
  const { c, s, state, update, fetcher } = setup();
  state.poolState.isMigrated = 1;
  await update();
  fetcher.mockResolvedValue(Response.json({ image: "javascript:alert(1)" }));
  const view = await readToken(c, network, pool, owner, s);
  expect(view.progress).toBeUndefined();
  expect(view.logo).toBeUndefined();
  expect(view.quote).toBe(6904167n);
  for (const value of [
    "http://example.com/x",
    "https://localhost/x",
    "https://127.0.0.1/x",
    "https://user:pass@example.com/x",
    "data:image/png;base64,x",
  ])
    expect(publicTokenUrl(value)).toBeUndefined();
});
it("renders real fee amounts, correct Solscan network links, and routes to the existing creator fee dashboard without claiming", async () => {
  const { c, s, send } = setup(),
    view = await readToken(c, network, pool, owner, s),
    select = vi.fn();
  selectCreatorFees(view, network, select);
  expect(select).toHaveBeenCalledExactlyOnceWith(pool);
  expect(() => selectCreatorFees(view, "devnet", select)).toThrow(
    "Network changed",
  );
  const html = renderToStaticMarkup(<TokenCard token={view} onFees={select} />);
  for (const value of [
    "Pathtrick",
    fixture.summary.mint,
    pool,
    owner,
    "0.006904167",
    "View Creator Fees",
    'href="#creator-fees"',
    "View on Solscan",
  ])
    expect(html).toContain(value);
  expect(tokenExplorer("devnet", "account", pool)).toContain("?cluster=devnet");
  expect(tokenExplorer(network, "account", pool)).not.toContain("?cluster");
  expect(send).not.toHaveBeenCalled();
});
