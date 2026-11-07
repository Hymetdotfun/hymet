/** $HYMET, HYMET's official token. Explore always lists it first; this is a public on-chain address, not a setting. */
export const OFFICIAL_TOKEN_MINT = "8QTBDqUVWQjP6KzfrtLkBKhfaFLDenxvqFv2tDkGdMpu";

export function isOfficialToken(mint: string) {
  return mint === OFFICIAL_TOKEN_MINT;
}

export type DirectoryEntry = { mint: string; name: string; ticker: string; status: string; createdAt: string };
export type DirectoryView = { search: string; status: string; sort: string };

/**
 * The Explore order. Search and the status filter apply to every token, so the official token is found by its name,
 * ticker or mint like any other. Sorting applies to the other tokens only; the official token, when it matches, always
 * comes first. Each mint appears once.
 */
export function orderDirectory<T extends DirectoryEntry>(tokens: readonly T[], view: DirectoryView): T[] {
  const query = view.search.trim().toLowerCase();
  const seen = new Set<string>();
  const matching = tokens.filter((token) => {
    if (seen.has(token.mint)) return false;
    seen.add(token.mint);
    return (
      (view.status === "all" || token.status === view.status) &&
      `${token.name} ${token.ticker} ${token.mint}`.toLowerCase().includes(query)
    );
  });
  const official = matching.find((token) => isOfficialToken(token.mint));
  const others = matching
    .filter((token) => !isOfficialToken(token.mint))
    .sort((a, b) =>
      view.sort === "name"
        ? a.name.localeCompare(b.name)
        : new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  return official ? [official, ...others] : others;
}
