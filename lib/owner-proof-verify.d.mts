import type { PublicKey } from "@solana/web3.js";
import type { OwnerProof } from "./owner-proof.mjs";
export const OWNER_PROOF_MAX_AGE_MS: number;
export function verifyOwnerProof(proof: (OwnerProof & { signature: string }) | unknown, owner: PublicKey, program: PublicKey, now?: number): void;
