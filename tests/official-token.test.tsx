import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { OFFICIAL_TOKEN_MINT, orderDirectory } from "../lib/token-directory";
import { TokenCard } from "../components/token-feed";

const official = { mint: OFFICIAL_TOKEN_MINT, name: "Hymet", ticker: "HYMET", status: "bonding", createdAt: "2026-11-07T16:43:58.000Z", marketCapUsd: 12345, volume24hHype: "12.5" };
const alpha = { mint: "So11111111111111111111111111111111111111112", name: "Alpha", ticker: "ALP", status: "bonding", createdAt: "2026-11-08T10:00:00.000Z" };
const zeta = { mint: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", name: "Zeta", ticker: "ZET", status: "graduated", createdAt: "2026-11-09T10:00:00.000Z" };
const view = (o: Partial<{ search: string; status: string; sort: string }> = {}) => ({ search: "", status: "all", sort: "recent", ...o });
const mints = (list: { mint: string }[]) => list.map((token) => token.mint);

describe("Explore order", () => {
  it("puts the official token first under every sort, ahead of newer launches, and keeps the others in their normal order", () => {
    expect(mints(orderDirectory([alpha, zeta, official], view()))).toEqual([OFFICIAL_TOKEN_MINT, zeta.mint, alpha.mint]);
    expect(mints(orderDirectory([zeta, official, alpha], view({ sort: "name" })))).toEqual([OFFICIAL_TOKEN_MINT, alpha.mint, zeta.mint]);
  });

  it("never shows the official token twice", () => {
    const list = orderDirectory([official, alpha, { ...official }, zeta, official], view());
    expect(mints(list)).toEqual([OFFICIAL_TOKEN_MINT, zeta.mint, alpha.mint]);
  });

  it("finds the official token by name, ticker and mint, and leaves it out when the search does not match", () => {
    for (const search of ["hymet", "HYMET", " Hymet ", OFFICIAL_TOKEN_MINT.slice(0, 6), OFFICIAL_TOKEN_MINT])
      expect(orderDirectory([alpha, official], view({ search }))[0].mint).toBe(OFFICIAL_TOKEN_MINT);
    expect(mints(orderDirectory([alpha, official, zeta], view({ search: "zeta" })))).toEqual([zeta.mint]);
  });

  it("applies the status filter to the official token as to every other token", () => {
    expect(mints(orderDirectory([alpha, official, zeta], view({ status: "graduated" })))).toEqual([zeta.mint]);
    expect(mints(orderDirectory([alpha, official, zeta], view({ status: "bonding" })))).toEqual([OFFICIAL_TOKEN_MINT, alpha.mint]);
  });

  it("lists the other tokens normally when the official token is not in the feed", () => {
    expect(mints(orderDirectory([alpha, zeta], view()))).toEqual([zeta.mint, alpha.mint]);
  });

  it("keeps the official token in the five-card home preview however many tokens launch after it", () => {
    const newer = Array.from({ length: 12 }, (_, i) => ({ ...alpha, mint: `${i}`.padStart(44, "1"), name: `New ${i}`, createdAt: `2026-12-${String(i + 1).padStart(2, "0")}T00:00:00.000Z` }));
    expect(orderDirectory([...newer, official], view()).slice(0, 5)[0].mint).toBe(OFFICIAL_TOKEN_MINT);
  });
});

describe("Official card", () => {
  it("marks only the official card as official and pinned, and shows its market data exactly like any other card", () => {
    const html = renderToStaticMarkup(<TokenCard token={official} />);
    const plain = renderToStaticMarkup(<TokenCard token={{ ...official, mint: alpha.mint }} />);
    const cap = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 2 }).format(12345);

    expect(html).toContain('class="token-card token-card-official"');
    expect(html).toContain('data-official="true"');
    expect(html).toContain(">OFFICIAL<");
    expect(html).toContain('title="Pinned"');
    expect(html).toContain('aria-label="View Hymet token, the official HYMET token, pinned"');
    expect(html).toContain(cap);
    expect(html).toContain(">12.5<");

    expect(plain).toContain('class="token-card"');
    expect(plain).not.toMatch(/OFFICIAL|Pinned|token-card-official|data-official|official HYMET/);
    const metrics = (markup: string) => markup.slice(markup.indexOf('<div class="token-card-metrics">'));
    expect(metrics(html)).toBe(metrics(plain));
  });
});

describe("Official card styling", () => {
  const css = readFileSync("app/globals.css", "utf8");
  it("moves the light around the ring and holds it still for reduced motion", () => {
    expect(css).toMatch(/\.token-card\.token-card-official::before\{[^}]*conic-gradient\(from var\(--official-orbit\)[^}]*animation:official-orbit 7s linear infinite\}/);
    expect(css).toContain("@keyframes official-orbit{to{--official-orbit:360deg}}");
    expect(css).toContain("@media(prefers-reduced-motion:reduce){.token-directory .token-card.token-card-official::before{animation:none}}");
  });
});
