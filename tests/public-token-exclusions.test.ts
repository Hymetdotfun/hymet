import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { isPublicTokenExcluded, publicTokenExcludedMints } from "../lib/public-token-exclusions";

const A = "So11111111111111111111111111111111111111112", B = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

it("excludes exactly the server-configured mints", () => {
  const env = { HYMET_PUBLIC_TOKEN_EXCLUDED_MINTS: `${A},${B}` };
  expect(publicTokenExcludedMints(env)).toEqual([A, B]);
  expect(isPublicTokenExcluded(A, env)).toBe(true);
  expect(isPublicTokenExcluded("11111111111111111111111111111111", env)).toBe(false);
});

it("ignores malformed entries and duplicates", () => {
  const env = { HYMET_PUBLIC_TOKEN_EXCLUDED_MINTS: ` ${A}, not a mint ,,${B},${A}` };
  expect(publicTokenExcludedMints(env)).toEqual([A, B]);
});

it("excludes nothing without the server setting", () => {
  expect(publicTokenExcludedMints({})).toEqual([]);
  expect(isPublicTokenExcluded(A, {})).toBe(false);
});

it("keeps every address out of the repository", () => {
  expect(readFileSync("lib/public-token-exclusions.ts", "utf8")).not.toMatch(/["'`][1-9A-HJ-NP-Za-km-z]{32,44}["'`]/);
});
