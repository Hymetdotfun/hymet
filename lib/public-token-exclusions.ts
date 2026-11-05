const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Mints omitted from HYMET's public Explore directory: HYMET_PUBLIC_TOKEN_EXCLUDED_MINTS, comma-separated, server-only, read at request time. */
export function publicTokenExcludedMints(env: Record<string, string | undefined> = process.env): string[] {
  const configured = (env.HYMET_PUBLIC_TOKEN_EXCLUDED_MINTS ?? "").split(",").map((mint) => mint.trim()).filter((mint) => MINT.test(mint));
  return [...new Set(configured)];
}

export function isPublicTokenExcluded(mint: string, env: Record<string, string | undefined> = process.env) {
  return publicTokenExcludedMints(env).includes(mint);
}
