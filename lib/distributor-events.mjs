import { createHash } from "node:crypto";
import bs58 from "bs58";

const u64 = (b, o) => b.readBigUInt64LE(o).toString();
const key = (b, o) => bs58.encode(b.subarray(o, o + 32));
const disc = (name) =>
  createHash("sha256").update(`event:${name}`).digest().subarray(0, 8);

const decoders = new Map(
  [
    [
      "FeesSettled",
      (b) => ({
        mint: key(b, 8),
        source: b[40],
        distributable: u64(b, 41),
        hymet: u64(b, 49),
        creator: u64(b, 57),
        holders: u64(b, 65),
        slot: u64(b, 73),
      }),
    ],
    [
      "HolderEpochFunded",
      (b) => ({
        mint: key(b, 8),
        epoch: u64(b, 40),
        epochAccount: key(b, 48),
        snapshotSlot: u64(b, 80),
        snapshotHash: b.subarray(88, 120).toString("hex"),
        merkleRoot: b.subarray(120, 152).toString("hex"),
        fundedAmount: u64(b, 152),
        chunkCount: b.readUInt32LE(160),
        slot: u64(b, 164),
      }),
    ],
    [
      "HolderPaid",
      (b) => ({
        mint: key(b, 8),
        epoch: u64(b, 40),
        chunk: b.readUInt32LE(48),
        wallet: key(b, 52),
        amount: u64(b, 84),
        slot: u64(b, 92),
      }),
    ],
    [
      "HolderEpochClosed",
      (b) => ({
        mint: key(b, 8),
        epoch: u64(b, 40),
        paidAmount: u64(b, 48),
        returnedAmount: u64(b, 56),
        slot: u64(b, 64),
      }),
    ],
    [
      "CreatorClaimed",
      (b) => ({
        mint: key(b, 8),
        wallet: key(b, 40),
        amount: u64(b, 72),
        slot: u64(b, 80),
      }),
    ],
    [
      "MigrationPoolRegistered",
      (b) => ({ mint: key(b, 8), pool: key(b, 40), slot: u64(b, 72) }),
    ],
  ].map(([name, fn]) => [disc(name).toString("hex"), { name, fn }]),
);

/** Decode only Anchor events emitted while the configured distributor is the active program. */
export function decodeDistributorEvents(logs, programId) {
  const stack = [];
  const events = [];
  for (const line of logs ?? []) {
    const invoke = /^Program ([1-9A-HJ-NP-Za-km-z]+) invoke \[(\d+)\]$/.exec(
      line,
    );
    if (invoke) {
      const depth = Number(invoke[2]);
      stack.length = depth - 1;
      stack[depth - 1] = invoke[1];
      continue;
    }
    if (/^Program [1-9A-HJ-NP-Za-km-z]+ (?:success|failed:)/.test(line)) {
      stack.pop();
      continue;
    }
    if (stack.at(-1) !== programId) continue;
    const data = /^Program data: ([A-Za-z0-9+/=]+)$/.exec(line);
    if (!data) continue;
    const bytes = Buffer.from(data[1], "base64");
    if (bytes.length < 8) continue;
    const match = decoders.get(bytes.subarray(0, 8).toString("hex"));
    if (match) events.push({ type: match.name, payload: match.fn(bytes) });
  }
  return events;
}
