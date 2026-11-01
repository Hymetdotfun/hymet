import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { readFileSync, readdirSync } from "node:fs";

// bigint-buffer has no upstream patched release (GHSA-3gc7-fjrx-p6mg). package.json overrides it
// with the bounds-checked pure-JS vendor/bigint-buffer; fail closed if anything else resolves.
const require = createRequire(import.meta.url);
for (const name of ["react-native", "metro"]) {
  let installed = false;
  try {
    require.resolve(`${name}/package.json`);
    installed = true;
  } catch (error) {
    if (error.code !== "MODULE_NOT_FOUND") throw error;
  }
  if (installed)
    throw Error(
      `Unused ${name} peer tooling detected. Reinstall with npm ci using the committed .npmrc (omit=peer, ignore-scripts=true).`,
    );
}
// Resolve as the actual consumer (SPL layout utils) does; fall back to a hoisted install.
function resolveBigintBuffer() {
  try {
    return createRequire(require.resolve("@solana/buffer-layout-utils")).resolve(
      "bigint-buffer/package.json",
    );
  } catch (error) {
    if (error.code !== "MODULE_NOT_FOUND") throw error;
    return require.resolve("bigint-buffer/package.json");
  }
}
const root = dirname(resolveBigintBuffer());
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
if (pkg.name !== "bigint-buffer")
  throw Error(
    "Could not resolve bigint-buffer package for runtime security check",
  );
function nativeFiles(path) {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? nativeFiles(join(path, entry.name))
      : entry.name.endsWith(".node")
        ? [join(path, entry.name)]
        : [],
  );
}
if (nativeFiles(root).length)
  throw Error(
    "Unpatched native bigint-buffer binary detected. Use a clean npm ci --ignore-scripts installation; do not ship the native converter.",
  );
if (!String(pkg.version).endsWith("-hymet.1"))
  throw Error(
    `bigint-buffer ${pkg.version} is not the vendored HYMET replacement. Reinstall with npm ci so the package.json override applies.`,
  );
console.log(
  `Runtime guard passed: bigint-buffer ${pkg.version} is the vendored pure-JS replacement; retain --ignore-scripts in deployment.`,
);
