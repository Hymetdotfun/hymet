import { it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Keypair } from "@solana/web3.js";
import { NextRequest } from "next/server";
import { officialLogoUrl, type Xstock } from "../lib/xstocks";
import { issuerLogo } from "../lib/xstocks-logo";
import { XstockLogo, logoInitials } from "../components/xstock-logo";
import { XstockPicker, visibleXstocks } from "../components/xstock-picker";
import { officialXstocks } from "../lib/xstocks-registry";
import { GET } from "../app/api/xstocks/logo/route";
vi.mock("../lib/xstocks-registry", () => ({ officialXstocks: vi.fn() }));
const mint = Keypair.generate().publicKey.toBase58();
const asset: Xstock = {
  mint,
  symbol: "TESTx",
  name: "Fixture",
  active: true,
  icon: "https://xstocks-metadata.backed.fi/logos/fixture.png",
  status: "Unsupported by Migration",
  reasons: [],
};
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9ioAAAAASUVORK5CYII=",
  "base64",
);
it("accepts exact issuer raster URLs and rejects unsafe URLs and SVG", () => {
  expect(officialLogoUrl(asset.icon)).toBe(asset.icon);
  for (const value of [
    "javascript:alert(1)",
    "http://xstocks-metadata.backed.fi/a.png",
    "https://evil.example/a.png",
    "https://user@xstocks-metadata.backed.fi/a.png",
    "https://xstocks-metadata.backed.fi/a.svg",
    asset.icon + "?wallet=x",
    asset.icon + "#x",
  ])
    expect(officialLogoUrl(value)).toBeUndefined();
});
it("validates image bytes and forwards no wallet, origin, cookies or authorization", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(
      new Response(png, { headers: { "content-type": "image/png" } }),
    );
  expect((await issuerLogo(asset.icon!, fetcher)).type).toBe("image/png");
  expect(fetcher.mock.calls[0][1]).toMatchObject({
    credentials: "omit",
    redirect: "error",
    cache: "no-store",
  });
  expect(fetcher.mock.calls[0][1].headers).toBeUndefined();
  await issuerLogo(asset.icon!, fetcher);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("rejects error pages, mislabeled images and oversized content", async () => {
  await expect(
    issuerLogo(
      "https://xstocks-metadata.backed.fi/error.png",
      vi.fn().mockResolvedValue(new Response("oops", { status: 404 })),
    ),
  ).rejects.toThrow("unavailable");
  await expect(
    issuerLogo(
      "https://xstocks-metadata.backed.fi/html.png",
      vi
        .fn()
        .mockResolvedValue(
          new Response("<svg/>", { headers: { "content-type": "image/png" } }),
        ),
    ),
  ).rejects.toThrow("format");
  await expect(
    issuerLogo(
      "https://xstocks-metadata.backed.fi/large.png",
      vi
        .fn()
        .mockResolvedValue(
          new Response(new Uint8Array(262145), {
            headers: { "content-type": "image/png" },
          }),
        ),
    ),
  ).rejects.toThrow();
});
it("keeps exact mint association and lazy same-origin images", () => {
  const html = renderToStaticMarkup(<XstockLogo asset={asset} />);
  expect(html).toContain(`/api/xstocks/logo?mint=${mint}`);
  expect(html).toContain('loading="lazy"');
  expect(html).toContain("no-referrer");
  expect(html).not.toContain(asset.icon);
});
it("renders missing-image initials without a broken image request", () => {
  const html = renderToStaticMarkup(
    <XstockLogo asset={{ ...asset, icon: undefined }} />,
  );
  expect(html).toContain("TE");
  expect(html).not.toContain("<img");
  expect(logoInitials("?x")).toBe("?");
  expect(logoInitials("AAPLx")).toBe("AA");
});
it("renders selected asset logo and bounded results for 1474 entries", () => {
  const rows = Array.from({ length: 1474 }, (_, i) => ({
    ...asset,
    mint: Keypair.generate().publicKey.toBase58(),
    symbol: `T${i}x`,
  }));
  const html = renderToStaticMarkup(
    <XstockPicker
      rows={rows}
      selected={rows[0]}
      searching
      onSelect={() => {}}
    />,
  );
  expect(html.match(/role="option"/g) || []).toHaveLength(12);
  expect(html).toContain('aria-setsize="1474"');
  expect(html).toContain('role="combobox"');
  expect(html).toContain(rows[0].mint);
  expect(html).not.toContain(rows[100].mint);
  expect(visibleXstocks(1474, 64000)).toEqual({ start: 997, end: 1009 });
});
it("filters remain small and empty search results are clear", () => {
  expect(
    renderToStaticMarkup(
      <XstockPicker rows={[]} searching onSelect={() => {}} />,
    ),
  ).toContain("No matching official assets");
  expect(visibleXstocks(1, 0)).toEqual({ start: 0, end: 1 });
});
it("logo route enforces loopback, origin and activation before metadata fetch", async () => {
  vi.mocked(officialXstocks).mockClear();
  expect(
    (
      await GET(
        new NextRequest(`http://evil.example/api/xstocks/logo?mint=${mint}`),
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await GET(
        new NextRequest(`http://localhost/api/xstocks/logo?mint=${mint}`, {
          headers: { "sec-fetch-site": "cross-site" },
        }),
      )
    ).status,
  ).toBe(403);
  vi.stubEnv("ENABLE_MAINNET", "false");
  expect(
    (
      await GET(
        new NextRequest(`http://localhost/api/xstocks/logo?mint=${mint}`),
      )
    ).status,
  ).toBe(403);
  vi.unstubAllEnvs();
  expect(officialXstocks).not.toHaveBeenCalled();
});
it("logo route rejects unknown or malformed mints rather than accepting arbitrary image URLs", async () => {
  vi.stubEnv("ENABLE_MAINNET", "true");
  vi.mocked(officialXstocks).mockResolvedValue({ assets: [], fetchedAt: 0 });
  expect(
    (
      await GET(
        new NextRequest("http://localhost/api/xstocks/logo?mint=invalid"),
      )
    ).status,
  ).toBe(404);
  expect(
    (
      await GET(
        new NextRequest(
          `http://localhost/api/xstocks/logo?mint=${mint}&url=https://evil.example/a.png`,
        ),
      )
    ).status,
  ).toBe(404);
  vi.unstubAllEnvs();
});
it("logo route selects image only from the official exact-mint row", async () => {
  const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(png, { headers: { "content-type": "image/png" } }));
  vi.stubEnv("ENABLE_MAINNET", "true");
  vi.mocked(officialXstocks).mockResolvedValue({
    assets: [{ ...asset, icon: "https://xstocks-metadata.backed.fi/route-fixture.png" }],
    fetchedAt: 0,
  });
  const r = await GET(
    new NextRequest(`http://localhost/api/xstocks/logo?mint=${mint}`),
  );
  expect(r.status).toBe(200);
  expect(r.headers.get("content-type")).toBe("image/png");
  expect(r.headers.get("cross-origin-resource-policy")).toBe("same-origin");
  expect(fetcher).toHaveBeenCalledTimes(1);
  fetcher.mockRestore();
  vi.unstubAllEnvs();
});
