export type OwnerProof = { owner: string; program: string; issuedAt: string; nonce: string };
export function ownerProofMessage(proof: OwnerProof): string;
