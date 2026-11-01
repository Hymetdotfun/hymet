import { createPublicKey, verify } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import {
  platformFeeAuthorizationMessage,
  type PlatformFeeAuthorization,
} from "./platform-fee-auth";

export function verifyPlatformFeeAuthorization(
  authorization: PlatformFeeAuthorization & { signature: string },
  origin: string,
  expectedWallet: PublicKey | readonly PublicKey[],
  now = Date.now(),
) {
  const wallet = new PublicKey(authorization.wallet);
  // A list admits the current platform wallet and the legacy wallets that earlier pools still name as feeClaimer.
  if (!(Array.isArray(expectedWallet) ? expectedWallet : [expectedWallet]).some((k: PublicKey) => wallet.equals(k)))
    throw Error("Unauthorized platform wallet");
  const issued = Date.parse(authorization.issuedAt);
  if (
    !Number.isFinite(issued) ||
    Math.abs(now - issued) > 2 * 60_000 ||
    !/^[0-9a-f-]{36}$/i.test(authorization.nonce)
  )
    throw Error("Platform wallet authorization expired; sign again");
  if (
    !["inspect", "prepare-dbc", "prepare-damm"].includes(
      authorization.action,
    )
  )
    throw Error("Unsupported platform fee action");
  const key = createPublicKey({
    key: Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      wallet.toBuffer(),
    ]),
    format: "der",
    type: "spki",
  });
  const signature = Buffer.from(authorization.signature, "base64");
  if (
    signature.length !== 64 ||
    signature.toString("base64") !== authorization.signature ||
    !verify(
      null,
      Buffer.from(
        platformFeeAuthorizationMessage(authorization, origin),
        "utf8",
      ),
      key,
      signature,
    )
  )
    throw Error("Invalid platform wallet signature");
  return wallet;
}
