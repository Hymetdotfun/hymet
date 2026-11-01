import { createRequire } from "node:module";
import { expect, it } from "vitest";
import { getU64Codec } from "./u64-helper";

type BigintBuffer = {
  toBigIntLE(buf: Buffer): bigint;
  toBigIntBE(buf: Buffer): bigint;
  toBufferLE(num: bigint, width: number): Buffer;
  toBufferBE(num: bigint, width: number): Buffer;
};
// Resolve exactly as the SPL layout code does.
const require = createRequire(createRequire(import.meta.url).resolve("@solana/buffer-layout-utils"));
const bb = require("bigint-buffer") as BigintBuffer;

it("resolves the vendored pure-JS bigint-buffer", () => {
  expect(require.resolve("bigint-buffer").split(String.fromCharCode(92)).join("/")).toContain("vendor/bigint-buffer/");
});

it("round-trips little- and big-endian values", () => {
  const max = 2n ** 64n - 1n;
  for (const n of [0n, 1n, 255n, 256n, 1_000_000_000n * 10n ** 9n, max]) {
    expect(bb.toBigIntLE(bb.toBufferLE(n, 8))).toBe(n);
    expect(bb.toBigIntBE(bb.toBufferBE(n, 8))).toBe(n);
  }
  expect(bb.toBufferLE(1n, 8)).toEqual(Buffer.from([1, 0, 0, 0, 0, 0, 0, 0]));
  expect(bb.toBigIntLE(Buffer.alloc(0))).toBe(0n);
  expect(bb.toBufferLE(0n, 0)).toEqual(Buffer.alloc(0));
});

it("rejects overflow, negatives and non-buffer input instead of truncating", () => {
  expect(() => bb.toBufferLE(2n ** 64n, 8)).toThrow(RangeError);
  expect(() => bb.toBufferLE(-1n, 8)).toThrow(RangeError);
  expect(() => bb.toBufferLE(1n, -1)).toThrow(RangeError);
  expect(() => bb.toBigIntLE("ff" as unknown as Buffer)).toThrow(TypeError);
});

it("keeps SPL u64 layouts working through @solana/buffer-layout-utils", () => {
  const { encode, decode } = getU64Codec();
  const value = 123_456_789_012_345_678n;
  expect(decode(encode(value))).toBe(value);
  expect(() => encode(2n ** 64n)).toThrow(RangeError);
});
