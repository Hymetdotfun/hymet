import { expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import {
  isPublicTokenExcluded,
  PUBLIC_TOKEN_EXCLUSIONS,
  PUBLIC_TOKEN_EXCLUDED_MINTS,
} from "../lib/public-token-exclusions";

it("excludes only the verified test-token mint addresses from public listings", () => {
  expect(PUBLIC_TOKEN_EXCLUSIONS).toEqual([
    { mint: "E6RAS7L5zMroRtjnkeFnioxUqWL2rpipNtUXLJszcVGj", label: "Hypadlaunch.fun (HYPAD)" },
    { mint: "D6HdDQ9MykpvFa914bBxip45CKVFre6TPoNN1bsBYTfs", label: "doge (DOGE)" },
    { mint: "DA2ijvE3TQaNEb1dP4D9LSg1LSFLoqUdMV5RMTGLkFmo", label: "hytest (HYTEST)" },
  ]);
  expect(PUBLIC_TOKEN_EXCLUDED_MINTS).toHaveLength(3);
  for (const { mint } of PUBLIC_TOKEN_EXCLUSIONS) {
    expect(new PublicKey(mint).toBase58()).toBe(mint);
    expect(isPublicTokenExcluded(mint)).toBe(true);
  }
  expect(isPublicTokenExcluded("11111111111111111111111111111111")).toBe(false);
});
