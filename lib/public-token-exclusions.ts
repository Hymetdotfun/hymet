/** Exact verified test-token mints omitted from HYMET's public Explore directory. */
export const PUBLIC_TOKEN_EXCLUSIONS = [
  { mint: "E6RAS7L5zMroRtjnkeFnioxUqWL2rpipNtUXLJszcVGj", label: "Hypadlaunch.fun (HYPAD)" },
  { mint: "D6HdDQ9MykpvFa914bBxip45CKVFre6TPoNN1bsBYTfs", label: "doge (DOGE)" },
  { mint: "DA2ijvE3TQaNEb1dP4D9LSg1LSFLoqUdMV5RMTGLkFmo", label: "hytest (HYTEST)" },
] as const;

export const PUBLIC_TOKEN_EXCLUDED_MINTS: string[] = PUBLIC_TOKEN_EXCLUSIONS.map(({ mint }) => mint);

const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Fixed exclusions plus HYMET_PUBLIC_TOKEN_EXCLUDED_MINTS: comma-separated, server-only, read at request time. */
export function publicTokenExcludedMints(env: Record<string, string | undefined> = process.env): string[] {
  const configured = (env.HYMET_PUBLIC_TOKEN_EXCLUDED_MINTS ?? "").split(",").map((mint) => mint.trim()).filter((mint) => MINT.test(mint));
  return [...new Set([...PUBLIC_TOKEN_EXCLUDED_MINTS, ...configured])];
}

export function isPublicTokenExcluded(mint: string, env: Record<string, string | undefined> = process.env) {
  return publicTokenExcludedMints(env).includes(mint);
}
