/** Exact verified test-token mints omitted from HYMET's public Explore directory. */
export const PUBLIC_TOKEN_EXCLUSIONS = [
  { mint: "E6RAS7L5zMroRtjnkeFnioxUqWL2rpipNtUXLJszcVGj", label: "Hypadlaunch.fun (HYPAD)" },
  { mint: "D6HdDQ9MykpvFa914bBxip45CKVFre6TPoNN1bsBYTfs", label: "doge (DOGE)" },
  { mint: "DA2ijvE3TQaNEb1dP4D9LSg1LSFLoqUdMV5RMTGLkFmo", label: "hytest (HYTEST)" },
] as const;

export const PUBLIC_TOKEN_EXCLUDED_MINTS: string[] = PUBLIC_TOKEN_EXCLUSIONS.map(({ mint }) => mint);

export function isPublicTokenExcluded(mint: string) {
  return PUBLIC_TOKEN_EXCLUDED_MINTS.includes(mint);
}
