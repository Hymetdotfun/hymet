import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  Connection,
  Keypair,
  PublicKey,
  type AccountInfo,
} from "@solana/web3.js";
import {
  MintLayout,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ExtensionType,
  getTypeLen,
  getMintLen,
} from "@solana/spl-token";
import { QuoteAssets } from "../components/quote-assets";
import {
  assertLaunchQuote,
  createOfficialRegistry,
  officialPage,
  type OfficialXstock,
} from "../lib/xstocks";
import { inspectXstock, verifyXstocks } from "../lib/xstocks-chain";
import { MAINNET_GENESIS } from "../lib/app-network";
import { GET } from "../app/api/xstocks/route";
import { NextRequest } from "next/server";
import { QuoteIdentity } from "../components/quote-identity";

const asset: OfficialXstock = {
  name: "Synthetic issuer asset",
  symbol: "TESTx",
  mint: Keypair.generate().publicKey.toBase58(),
  active: true,
};
function page(n = 0, next = false, mint = asset.mint) {
  return {
    nodes: [
      {
        name: asset.name,
        symbol: asset.symbol,
        isTradingHalted: false,
        allowedOperations: ["Issuance"],
        logo: "https://untrusted.example/logo.png",
        deployments: [{ network: "Solana", address: mint }],
      },
    ],
    page: { currentPage: n, hasNextPage: next },
  };
}
function info(
  types: ExtensionType[] = [],
  owner = TOKEN_2022_PROGRAM_ID,
): AccountInfo<Buffer> {
  const data = Buffer.alloc(types.length ? getMintLen(types) : 82);
  MintLayout.encode(
    {
      mintAuthorityOption: 0,
      mintAuthority: PublicKey.default,
      supply: 10n,
      decimals: 8,
      isInitialized: true,
      freezeAuthorityOption: 0,
      freezeAuthority: PublicKey.default,
    },
    data,
  );
  if (types.length) {
    data[165] = 1;
    let offset = 166;
    for (const type of types) {
      data.writeUInt16LE(type, offset);
      data.writeUInt16LE(getTypeLen(type), offset + 2);
      offset += 4 + getTypeLen(type);
    }
  }
  return { data, owner, executable: false, lamports: 1, rentEpoch: 0 };
}
it("discovers all pages, deduplicates exact mints and ignores untrusted icons", async () => {
  const second = Keypair.generate().publicKey.toBase58();
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json(page(0, true)))
    .mockResolvedValueOnce(
      Response.json({
        ...page(1),
        nodes: [...page().nodes, ...page(1, false, second).nodes],
      }),
    );
  const load = createOfficialRegistry(fetcher);
  expect((await load()).assets).toHaveLength(2);
  expect((await load()).assets[0].icon).toBeUndefined();
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(String(fetcher.mock.calls[1][0])).toContain("page=1");
  expect(String(fetcher.mock.calls[0][0])).toContain("https://api.xstocks.fi/");
});
it("rejects incomplete pagination, conflicting mint identities and invalid mints", async () => {
  expect(() => officialPage(page(2), 0)).toThrow("pagination");
  expect(() => officialPage(page(0, false, "fake"), 0)).toThrow();
  const conflict = page();
  conflict.nodes.push({ ...page().nodes[0], symbol: "SPOOFx" });
  await expect(
    createOfficialRegistry(
      vi.fn().mockResolvedValue(Response.json(conflict)),
    )(),
  ).rejects.toThrow("Conflicting");
});
it("expires publisher cache, removes delisted entries on refresh and never serves stale data after failure", async () => {
  let now = 0;
  const replacement = Keypair.generate().publicKey.toBase58();
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json(page()))
    .mockResolvedValueOnce(Response.json(page(0, false, replacement)))
    .mockRejectedValue(Error("offline"));
  const load = createOfficialRegistry(fetcher, () => now);
  await load();
  now = 61_000;
  expect((await load()).assets.map((a) => a.mint)).toEqual([replacement]);
  now = 122_000;
  await expect(load()).rejects.toThrow("offline");
  await expect(load()).rejects.toThrow("offline");
});
it("does not use halted or issuance-inactive assets as launch-verified", () => {
  const p = page();
  p.nodes[0].isTradingHalted = true;
  expect(officialPage(p, 0).assets[0].active).toBe(false);
  expect(inspectXstock({ ...asset, active: false }, info(), false).status).toBe(
    "Verification Unavailable",
  );
});
it.each([TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID])(
  "keeps even plain quote mints blocked without a complete migration/claim path (%s)",
  (owner) => {
    const result = inspectXstock(asset, info([], owner), false);
    expect(result.decimals).toBe(8);
    expect(result.program).toBe(owner.toBase58());
    expect(result.status).toBe("Unsupported by Migration");
  },
);
it("identifies scaled amounts, permanent delegation and pausing and requires a DBC badge", () => {
  const result = inspectXstock(
    asset,
    info([
      ExtensionType.ScaledUiAmountConfig,
      ExtensionType.PermanentDelegate,
      ExtensionType.PausableConfig,
    ]),
    false,
  );
  expect(result.status).toBe("Unsupported by DBC");
  expect(result.extensions).toContain("ScaledUiAmountConfig");
  expect(
    inspectXstock(
      asset,
      info([ExtensionType.TransferHook]),
      false,
    ).restrictions?.join(" "),
  ).toContain("currently disabled");
  expect(result.restrictions?.join(" ")).toMatch(
    /Permanent delegate.*pause.*Scaled UI/,
  );
  expect(
    inspectXstock(asset, info([ExtensionType.ScaledUiAmountConfig]), true)
      .status,
  ).toBe("Unsupported by Migration");
});
it("never trusts foreign token programs, missing accounts or malformed extensions", () => {
  expect(
    inspectXstock(asset, info([], Keypair.generate().publicKey), false).status,
  ).toBe("Verification Unavailable");
  expect(inspectXstock(asset, null, false).status).toBe(
    "Verification Unavailable",
  );
  const broken = info();
  broken.data = Buffer.alloc(4);
  expect(inspectXstock(asset, broken, false).status).toBe(
    "Verification Unavailable",
  );
});
it("distinguishes immutable zero transfer fees from a live transfer-fee authority", () => {
  const zero = info([ExtensionType.TransferFeeConfig]);
  expect(inspectXstock(asset, zero, false).status).toBe(
    "Unsupported by Migration",
  );
  // First TLV payload byte belongs to the transfer-fee configuration authority.
  zero.data[170] = 1;
  expect(inspectXstock(asset, zero, true).status).toBe("Unsupported by DBC");
});
it("accepts only Mainnet and executable Meteora programs; RPC failures do not produce compatible tokens", async () => {
  const c = new Connection("http://127.0.0.1:3000");
  vi.spyOn(c, "getGenesisHash").mockResolvedValue("devnet");
  await expect(verifyXstocks(c, [asset])).rejects.toThrow("Mainnet");
  vi.mocked(c.getGenesisHash).mockResolvedValue(MAINNET_GENESIS);
  const accounts = vi
    .spyOn(c, "getMultipleAccountsInfo")
    .mockResolvedValue([null, null]);
  await expect(verifyXstocks(c, [asset])).rejects.toThrow("programs");
  accounts
    .mockResolvedValueOnce([
      { ...info(), executable: true },
      { ...info(), executable: true },
    ])
    .mockRejectedValueOnce(Error("RPC"));
  expect((await verifyXstocks(c, [asset]))[0].status).toBe(
    "Verification Unavailable",
  );
});
it("does not treat a malformed owned badge as a quote authorization", async () => {
  const { DYNAMIC_BONDING_CURVE_PROGRAM_ID } =
    await import("@meteora-ag/dynamic-bonding-curve-sdk");
  const c = new Connection("http://127.0.0.1:3000");
  vi.spyOn(c, "getGenesisHash").mockResolvedValue(MAINNET_GENESIS);
  vi.spyOn(c, "getMultipleAccountsInfo")
    .mockResolvedValueOnce([
      { ...info(), executable: true },
      { ...info(), executable: true },
    ])
    .mockResolvedValueOnce([
      info([ExtensionType.ScaledUiAmountConfig]),
      { ...info(), owner: DYNAMIC_BONDING_CURVE_PROGRAM_ID },
    ]);
  expect((await verifyXstocks(c, [asset]))[0]).toMatchObject({
    badge: false,
    status: "Unsupported by DBC",
  });
});
it("renders exactly SOL/xStocks categories and blocks preparation independently of the UI", () => {
  const html = renderToStaticMarkup(
    <QuoteAssets category="sol" onChange={() => {}} disabled={false} />,
  );
  expect(html.match(/<option/g)).toHaveLength(3);
  expect(html).toContain("HYPE — Wormhole bridged Hyperliquid");
  expect(html).not.toContain("USDC");
  expect(html).not.toContain("custom mint");
  expect(() => assertLaunchQuote("sol")).not.toThrow();
  expect(() => assertLaunchQuote("xstocks")).toThrow("disabled");
});
it("verifies a correct badge's program owner, discriminator and mint without enabling the unproven migration path", async () => {
  const { DynamicBondingCurveClient, DYNAMIC_BONDING_CURVE_PROGRAM_ID } =
    await import("@meteora-ag/dynamic-bonding-curve-sdk");
  const c = new Connection("http://127.0.0.1:3000");
  const sdk = new DynamicBondingCurveClient(c, "confirmed");
  const data = await sdk.program.coder.accounts.encode("tokenBadge", {
    tokenMint: new PublicKey(asset.mint),
    padding: Array(128).fill(0),
  });
  vi.spyOn(c, "getGenesisHash").mockResolvedValue(MAINNET_GENESIS);
  vi.spyOn(c, "getMultipleAccountsInfo")
    .mockResolvedValueOnce([
      { ...info(), executable: true },
      { ...info(), executable: true },
    ])
    .mockResolvedValueOnce([
      info([ExtensionType.ScaledUiAmountConfig]),
      { ...info(), data, owner: DYNAMIC_BONDING_CURVE_PROGRAM_ID },
    ]);
  expect((await verifyXstocks(c, [asset]))[0]).toMatchObject({
    badge: true,
    status: "Unsupported by Migration",
  });
});
it("keeps nontransferable and currently paused tokens blocked even with a badge", () => {
  expect(
    inspectXstock(asset, info([ExtensionType.NonTransferable]), true).status,
  ).toBe("Unsupported by DBC");
  const paused = info([ExtensionType.PausableConfig]);
  paused.data[paused.data.length - 1] = 1;
  expect(inspectXstock(asset, paused, true).status).toBe("Unsupported by DBC");
  const state = info([ExtensionType.DefaultAccountState]);
  state.data[170] = 2; // Official AccountState.Frozen.
  expect(inspectXstock(asset, state, true).status).toBe("Unsupported by DBC");
  state.data[170] = 1; // Official AccountState.Initialized.
  expect(inspectXstock(asset, state, true).status).toBe(
    "Unsupported by Migration",
  );
});
it("preserves SOL display and labels non-SOL quote accounting honestly without changing claim authority", () => {
  expect(
    renderToStaticMarkup(
      <QuoteIdentity
        mint="So11111111111111111111111111111111111111112"
        decimals={9}
      />,
    ),
  ).toBe("");
  const html = renderToStaticMarkup(
    <QuoteIdentity mint={asset.mint} decimals={8} />,
  );
  expect(html).toContain(asset.mint);
  expect(html).toContain("before any issuer UI multiplier");
  expect(html).toContain("Unsupported Token-2022 claims remain disabled");
});
it("keeps registry loopback/origin and activation restrictions before any fetch", async () => {
  const fetcher = vi.spyOn(globalThis, "fetch");
  expect(
    (await GET(new NextRequest("http://evil.example/api/xstocks"))).status,
  ).toBe(403);
  vi.stubEnv("ENABLE_MAINNET", "false");
  expect(
    (
      await GET(
        new NextRequest("http://localhost/api/xstocks", {
          headers: { "sec-fetch-site": "cross-site" },
        }),
      )
    ).status,
  ).toBe(403);
  expect(
    (await GET(new NextRequest("http://localhost/api/xstocks"))).status,
  ).toBe(403);
  expect(fetcher).not.toHaveBeenCalled();
  fetcher.mockRestore();
  vi.unstubAllEnvs();
});
