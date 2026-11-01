// Node-only verification of a Phantom owner proof (see lib/owner-proof.mjs).
import { createPublicKey, verify } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { ownerProofMessage } from "./owner-proof.mjs";

export const OWNER_PROOF_MAX_AGE_MS = 24 * 60 * 60_000;

/** Throws unless `proof` is a fresh ed25519 signature by `owner` over the proof message for `program`. */
export function verifyOwnerProof(proof, owner, program, now = Date.now()) {
  if (!proof || typeof proof !== "object") throw Error("Owner proof is missing");
  if (proof.owner !== owner.toBase58()) throw Error("Owner proof is for another wallet");
  if (proof.program !== program.toBase58()) throw Error("Owner proof is for another program");
  const issued = Date.parse(proof.issuedAt);
  if (!Number.isFinite(issued) || issued > now + 60_000 || now - issued > OWNER_PROOF_MAX_AGE_MS)
    throw Error("Owner proof is older than 24 hours; sign a new one in Phantom");
  if (typeof proof.nonce !== "string" || !/^[0-9a-f-]{36}$/i.test(proof.nonce)) throw Error("Owner proof nonce is invalid");
  const signature = Buffer.from(String(proof.signature ?? ""), "base64");
  const key = createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), new PublicKey(proof.owner).toBuffer()]),
    format: "der",
    type: "spki",
  });
  if (signature.length !== 64 || !verify(null, Buffer.from(ownerProofMessage(proof), "utf8"), key, signature))
    throw Error("Owner proof signature is invalid");
}
