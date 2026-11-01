// Owner proof: a Phantom signMessage (no transaction, no funds) showing the owner wallet can sign
// before the distributor upgrade authority is handed to it. Pure: safe for the browser bundle.

/** The exact text the owner signs in Phantom. */
export function ownerProofMessage(proof) {
  return [
    "HYMET distributor owner proof v1",
    "Purpose: accept the upgrade authority of the HYMET rewards distributor",
    `Program: ${proof.program}`,
    `Owner: ${proof.owner}`,
    `IssuedAt: ${proof.issuedAt}`,
    `Nonce: ${proof.nonce}`,
  ].join("\n");
}
