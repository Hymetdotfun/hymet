import { it, expect } from "vitest";
import { Keypair, SystemProgram } from "@solana/web3.js";
import { publicKey } from "@metaplex-foundation/umi";
import {
  getMetadataAccountDataSerializer,
  Key,
  type MetadataAccountDataArgs,
} from "@metaplex-foundation/mpl-token-metadata";
import { verifyMetadataBytes } from "../lib/metadata";
const serializer = getMetadataAccountDataSerializer();
function fixture() {
  const mint = Keypair.generate().publicKey;
  const args: MetadataAccountDataArgs = {
    updateAuthority: publicKey(SystemProgram.programId.toBase58()),
    mint: publicKey(mint.toBase58()),
    name: "Trajectory",
    symbol: "TRJ",
    uri: "https://example.com/meta",
    sellerFeeBasisPoints: 0,
    creators: null,
    primarySaleHappened: false,
    isMutable: false,
    editionNonce: null,
    tokenStandard: null,
    collection: null,
    uses: null,
    collectionDetails: null,
    programmableConfig: null,
  };
  return { mint, args };
}
it.each([false, true])(
  "independently validates the manual prefix against official Metaplex 3.4.0 bytes (puffed strings: %s)",
  (padded) => {
    const { mint, args } = fixture();
    const data = Buffer.from(
      serializer.serialize({
        ...args,
        name: padded ? args.name.padEnd(32, "\0") : args.name,
        symbol: padded ? args.symbol.padEnd(10, "\0") : args.symbol,
        uri: padded ? args.uri.padEnd(200, "\0") : args.uri,
      }),
    );
    const [official] = serializer.deserialize(data);
    expect(official.key).toBe(Key.MetadataV1);
    expect(official.isMutable).toBe(false);
    expect(official.creators.__option).toBe("None");
    expect(() =>
      verifyMetadataBytes(data, mint, args.name, args.symbol, args.uri),
    ).not.toThrow();
  },
);
it.each([
  "authority",
  "mint",
  "name",
  "symbol",
  "uri",
  "royalties",
  "creators",
  "mutable",
] as const)(
  "rejects an official serialized account with mismatched %s",
  (field) => {
    const { mint, args } = fixture();
    const other = publicKey(Keypair.generate().publicKey.toBase58());
    switch (field) {
      case "authority":
        args.updateAuthority = other;
        break;
      case "mint":
        args.mint = other;
        break;
      case "name":
        args.name = "Wrong";
        break;
      case "symbol":
        args.symbol = "BAD";
        break;
      case "uri":
        args.uri = "https://example.com/wrong";
        break;
      case "royalties":
        args.sellerFeeBasisPoints = 1;
        break;
      case "creators":
        args.creators = [{ address: other, verified: false, share: 100 }];
        break;
      case "mutable":
        args.isMutable = true;
        break;
    }
    const data = Buffer.from(serializer.serialize(args));
    expect(() =>
      verifyMetadataBytes(
        data,
        mint,
        "Trajectory",
        "TRJ",
        "https://example.com/meta",
      ),
    ).toThrow();
  },
);
it("rejects a wrong account discriminator and truncated string data", () => {
  const { mint, args } = fixture();
  const data = Buffer.from(serializer.serialize(args));
  data[0] = Key.MasterEditionV2;
  expect(() =>
    verifyMetadataBytes(data, mint, args.name, args.symbol, args.uri),
  ).toThrow("MetadataV1");
  const valid = Buffer.from(serializer.serialize(args));
  expect(() =>
    verifyMetadataBytes(
      valid.subarray(0, 80),
      mint,
      args.name,
      args.symbol,
      args.uri,
    ),
  ).toThrow();
});
