import { Buffer } from "buffer";
import { PublicKey, SystemProgram } from "@solana/web3.js";
// Borsh prefix verified against mpl-token-metadata's generated Metadata account.
// This launcher always creates metadata with creators=None and immutable authority.
export function verifyMetadataBytes(
  data: Buffer,
  mint: PublicKey,
  name: string,
  symbol: string,
  uri: string,
) {
  if (data.length < 75) throw Error("Metadata account is truncated");
  // Official mpl-token-metadata Key.MetadataV1 discriminator.
  if (data[0] !== 4) throw Error("Account is not Metaplex MetadataV1");
  if (
    !new PublicKey(data.subarray(1, 33)).equals(SystemProgram.programId) ||
    !new PublicKey(data.subarray(33, 65)).equals(mint)
  )
    throw Error("Metadata authority or mint mismatch");
  let offset = 65;
  const string = () => {
    if (offset + 4 > data.length) throw Error("Metadata length invalid");
    const size = data.readUInt32LE(offset);
    offset += 4;
    if (size > 200 || offset + size > data.length)
      throw Error("Metadata string invalid");
    const value = data
      .subarray(offset, offset + size)
      .toString("utf8")
      .replace(/\0+$/, "");
    offset += size;
    return value;
  };
  if (string() !== name || string() !== symbol || string() !== uri)
    throw Error("On-chain metadata differs from reviewed token details");
  if (
    offset + 5 > data.length ||
    data.readUInt16LE(offset) !== 0 ||
    data[offset + 2] !== 0 ||
    data[offset + 4] !== 0
  )
    throw Error(
      "Metadata creator list, royalties or immutability differs from launch",
    );
}
