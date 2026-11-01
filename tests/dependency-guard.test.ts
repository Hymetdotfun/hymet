import { expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

function guardedFixture(extra: "native" | "mobile") {
  const base = resolve(tmpdir());
  const dir = mkdtempSync(join(base, "dbc-dependency-guard-"));
  try {
    const pkg = join(dir, "node_modules", "bigint-buffer");
    mkdirSync(join(pkg, "dist"), { recursive: true });
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({ name: "bigint-buffer", version: "1.1.5", main: "dist/node.js" }),
    );
    writeFileSync(join(pkg, "dist", "node.js"), "");
    if (extra === "native") writeFileSync(join(pkg, "unsafe.node"), "");
    else {
      const mobile = join(dir, "node_modules", "react-native");
      mkdirSync(mobile);
      writeFileSync(join(mobile, "package.json"), JSON.stringify({ name: "react-native" }));
    }
    const scripts = join(dir, "scripts");
    mkdirSync(scripts);
    const script = join(scripts, "check-native-deps.mjs");
    writeFileSync(script, readFileSync(new URL("../scripts/check-native-deps.mjs", import.meta.url)));
    return spawnSync(process.execPath, [script], { encoding: "utf8" });
  } finally {
    if (dirname(resolve(dir)) !== base) throw Error("Unexpected fixture path");
    rmSync(dir, { recursive: true, force: true });
  }
}

it("fails closed if a bigint-buffer native addon is introduced", () => {
  const result = guardedFixture("native");
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("Unpatched native bigint-buffer binary detected");
});

it("fails closed if omitted React Native peer tooling is reintroduced", () => {
  const result = guardedFixture("mobile");
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("Unused react-native peer tooling detected");
});
