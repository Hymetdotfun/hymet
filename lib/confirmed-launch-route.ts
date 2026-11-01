import { PublicKey } from "@solana/web3.js";

/** Build the detail route only after chain verification and confirmed registry persistence. */
export function confirmedLaunchDestination(
  mint: string,
  onChainVerified: boolean,
  registered: boolean,
): string | null {
  if (!onChainVerified || !registered) return null;
  try {
    const publicKey = new PublicKey(mint);
    const canonicalMint = publicKey.toBase58();
    if (canonicalMint !== mint) return null;
    return `/token/${encodeURIComponent(canonicalMint)}`;
  } catch {
    return null;
  }
}
