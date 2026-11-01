import { u64 } from "@solana/buffer-layout-utils";

export function getU64Codec() {
  const layout = u64();
  return {
    encode(value: bigint) {
      const out = Buffer.alloc(8);
      layout.encode(value, out, 0);
      return out;
    },
    decode: (buf: Buffer) => layout.decode(buf, 0),
  };
}
