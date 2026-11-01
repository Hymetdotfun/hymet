import { createPrivateKey, sign } from "node:crypto";
import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { platformFeeAuthorizationMessage } from "../lib/platform-fee-auth";
import { verifyPlatformFeeAuthorization } from "../lib/platform-fee-auth-server";

const origin = "https://hymet.example";

function authorization(wallet = Keypair.generate(), overrides = {}) {
  const request = {
    wallet: wallet.publicKey.toBase58(),
    action: "prepare-dbc" as const,
    pool: Keypair.generate().publicKey.toBase58(),
    issuedAt: new Date(1_800_000_000_000).toISOString(),
    nonce: "fdb52d99-8b80-44cc-844c-76b27dc2ef2d",
    ...overrides,
  };
  const privateKey = createPrivateKey({
    key: Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"),
      Buffer.from(wallet.secretKey.subarray(0, 32)),
    ]),
    format: "der",
    type: "pkcs8",
  });
  const signature = sign(
    null,
    Buffer.from(platformFeeAuthorizationMessage(request, origin)),
    privateKey,
  ).toString("base64");
  return { wallet, request: { ...request, signature } };
}

describe("platform fee wallet authorization", () => {
  it("accepts a fresh platform signature bound to origin, action, and pool", () => {
    const now = 1_800_000_000_000;
    const proof = authorization();
    expect(
      verifyPlatformFeeAuthorization(
        proof.request,
        origin,
        proof.wallet.publicKey,
        now,
      ).equals(proof.wallet.publicKey),
    ).toBe(true);
  });

  it("rejects another wallet and signatures reused for another API origin", () => {
    const now = 1_800_000_000_000;
    const proof = authorization();
    expect(() =>
      verifyPlatformFeeAuthorization(
        proof.request,
        origin,
        Keypair.generate().publicKey,
        now,
      ),
    ).toThrow("Unauthorized platform wallet");
    expect(() =>
      verifyPlatformFeeAuthorization(
        proof.request,
        "https://attacker.example",
        proof.wallet.publicKey,
        now,
      ),
    ).toThrow("Invalid platform wallet signature");
  });

  it("rejects stale and malformed authorizations", () => {
    const proof = authorization();
    expect(() =>
      verifyPlatformFeeAuthorization(
        proof.request,
        origin,
        proof.wallet.publicKey,
        1_800_000_000_000 + 2 * 60_000 + 1,
      ),
    ).toThrow("authorization expired");
    expect(() =>
      verifyPlatformFeeAuthorization(
        { ...proof.request, signature: "AA==" },
        origin,
        proof.wallet.publicKey,
        1_800_000_000_000,
      ),
    ).toThrow("Invalid platform wallet signature");
  });
});
