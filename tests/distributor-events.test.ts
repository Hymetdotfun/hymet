import { createHash } from "node:crypto";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import { decodeDistributorEvents } from "../lib/distributor-events.mjs";

const b58 = (n: number) => bs58.encode(Buffer.alloc(32, n));
const event = (name: string, fields: Buffer[]) =>
  Buffer.concat([
    createHash("sha256").update(`event:${name}`).digest().subarray(0, 8),
    ...fields,
  ]).toString("base64");
const u64 = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
};

describe("confirmed distributor event decoding", () => {
  it("decodes fee allocations from the distributor program invocation", () => {
    const mint = Buffer.alloc(32, 4),
      payload = event("FeesSettled", [
        mint,
        Buffer.from([1]),
        u64(100n),
        u64(20n),
        u64(40n),
        u64(40n),
        u64(91n),
      ]);
    const logs = [
      `Program ${b58(1)} invoke [1]`,
      `Program ${b58(1)} success`,
      `Program ${b58(2)} invoke [1]`,
      `Program data: ${payload}`,
      `Program ${b58(2)} success`,
    ];
    expect(decodeDistributorEvents(logs, b58(2))).toEqual([
      {
        type: "FeesSettled",
        payload: {
          mint: bs58.encode(mint),
          source: 1,
          distributable: "100",
          hymet: "20",
          creator: "40",
          holders: "40",
          slot: "91",
        },
      },
    ]);
  });
  it("ignores spoofed nested CPI data and unknown events", () => {
    const fake = event("FeesSettled", [
      Buffer.alloc(32, 3),
      Buffer.from([0]),
      u64(1n),
      u64(0n),
      u64(1n),
      u64(0n),
      u64(5n),
    ]);
    const logs = [
      `Program ${b58(8)} invoke [1]`,
      `Program ${b58(9)} invoke [2]`,
      `Program data: ${fake}`,
      `Program ${b58(9)} success`,
      `Program ${b58(8)} success`,
    ];
    expect(decodeDistributorEvents(logs, b58(8))).toHaveLength(0);
  });
});
