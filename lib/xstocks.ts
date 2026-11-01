import { PublicKey } from "@solana/web3.js";
import { limitedBody } from "./http";

export const XSTOCKS_SOURCE = "https://api.xstocks.fi/api/v2/public/assets";
export type QuoteCategory = "sol" | "hype" | "xstocks";
export type OfficialXstock = {
  mint: string;
  name: string;
  symbol: string;
  icon?: string;
  active: boolean;
};
export type XstockStatus =
  | "Available for Launch"
  | "Unsupported by DBC"
  | "Unsupported by Migration"
  | "Verification Unavailable";
export type Xstock = OfficialXstock & {
  status: XstockStatus;
  reasons: string[];
  decimals?: number;
  program?: string;
  extensions?: string[];
  badge?: boolean;
  restrictions?: string[];
};
export type XstocksRegistry = {
  source: string;
  fetchedAt: number;
  verifiedAt: number;
  assets: Xstock[];
};
export function assertLaunchQuote(category: QuoteCategory) {
  if (category !== "sol" && category !== "hype")
    throw Error(
      "xStocks launches are disabled: the complete quote, migration and fee-claim path is not verified. Select SOL to launch.",
    );
}

// Issuer images are display-only and never establish token identity.
export function officialLogoUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2048) return;
  try {
    const u = new URL(value);
    if (
      u.origin === "https://xstocks-metadata.backed.fi" &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash &&
      /\.(png|jpe?g|webp)$/i.test(u.pathname)
    )
      return u.href;
  } catch {
    /* Invalid/missing image: use initials. */
  }
}

function text(value: unknown, max: number) {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw Error("Official registry schema changed");
  return value;
}
export function officialPage(value: unknown, page: number) {
  const data = value as {
    nodes?: unknown[];
    page?: { currentPage?: number; hasNextPage?: boolean };
  };
  if (
    !data ||
    !Array.isArray(data.nodes) ||
    data.nodes.length > 100 ||
    data.page?.currentPage !== page ||
    typeof data.page.hasNextPage !== "boolean"
  )
    throw Error("Official registry pagination is invalid");
  const assets: OfficialXstock[] = [];
  for (const item of data.nodes) {
    if (!item || typeof item !== "object")
      throw Error("Invalid official asset");
    const a = item as Record<string, unknown>;
    const name = text(a.name, 160),
      symbol = text(a.symbol, 32);
    if (
      !Array.isArray(a.deployments) ||
      typeof a.isTradingHalted !== "boolean" ||
      !Array.isArray(a.allowedOperations)
    )
      throw Error("Official asset status unavailable");
    const icon = officialLogoUrl(a.logo);
    for (const deployment of a.deployments) {
      if (!deployment || typeof deployment !== "object")
        throw Error("Invalid official deployment");
      if (deployment.network !== "Solana") continue;
      const address = text(deployment.address, 44);
      if (new PublicKey(address).toBase58() !== address)
        throw Error("Invalid official mint");
      assets.push({
        name,
        symbol,
        mint: address,
        icon,
        active: !a.isTradingHalted && a.allowedOperations.includes("Issuance"),
      });
    }
  }
  return { assets, next: data.page.hasNextPage };
}

// Only complete publisher snapshots are cached. Failed refreshes invalidate the cache;
// cached identity is never a transaction authorization or a cached on-chain balance.
export function createOfficialRegistry(
  fetcher: typeof fetch = fetch,
  now = Date.now,
) {
  let cache: { fetchedAt: number; assets: OfficialXstock[] } | undefined;
  let pending: Promise<NonNullable<typeof cache>> | undefined;
  return async () => {
    if (cache && now() - cache.fetchedAt < 60_000) return cache;
    if (pending) return pending;
    pending = (async () => {
      try {
        const unique = new Map<string, OfficialXstock>();
        for (let page = 0; page < 20; page++) {
          const url = new URL(XSTOCKS_SOURCE);
          url.search = new URLSearchParams({
            network: "Solana",
            page: String(page),
            pageSize: "100",
          }).toString();
          const response = await fetcher(url, {
            redirect: "error",
            credentials: "omit",
            cache: "no-store",
            signal: AbortSignal.timeout(15_000),
          });
          if (!response.ok) throw Error("Official registry unavailable");
          const parsed = officialPage(
            JSON.parse(
              new TextDecoder().decode(
                await limitedBody(response, 3 * 1024 * 1024),
              ),
            ),
            page,
          );
          for (const a of parsed.assets) {
            const previous = unique.get(a.mint);
            if (previous && JSON.stringify(previous) !== JSON.stringify(a))
              throw Error("Conflicting official mint identities");
            unique.set(a.mint, a);
          }
          if (!parsed.next) {
            if (!unique.size) throw Error("Official Solana registry is empty");
            cache = {
              fetchedAt: now(),
              assets: [...unique.values()].sort((a, b) =>
                a.symbol.localeCompare(b.symbol),
              ),
            };
            return cache;
          }
          if (!parsed.assets.length)
            throw Error("Official pagination did not advance");
        }
        throw Error(
          "Official registry exceeds bounded pagination; coverage unavailable",
        );
      } catch (error) {
        cache = undefined;
        throw error;
      } finally {
        pending = undefined;
      }
    })();
    return pending;
  };
}
