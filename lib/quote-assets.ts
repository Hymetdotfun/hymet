import { PublicKey, type Connection } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  unpackMint,
  unpackAccount,
} from "@solana/spl-token";
// Devnet test mode only (lib/app-network.ts): Mainnet HYPE does not exist on Devnet, so the isolated Devnet build and this
// app use a Devnet test mint. Ignored in every other build; the test-network guard rejects a missing or Mainnet value.
const DEVNET_TEST_HYPE =
  process.env.NEXT_PUBLIC_HYMET_TEST_NETWORK === "devnet" ? process.env.NEXT_PUBLIC_HYMET_TEST_HYPE_MINT : undefined;
export const HYPE_MINT = new PublicKey(
  DEVNET_TEST_HYPE || "98sMhvDwXj1RQi5c5Mndm3vPe9cBqPrbLaufMXFNMh5g",
);
export const HYPE_SOURCE = "https://pump.fun/docs/custom-pairs";
export function quoteAsset(v: { quote?: string }) {
  if (v.quote !== undefined && v.quote !== "hype")
    throw Error("HYMET supports HYPE as its only quote asset");
  return { mint: HYPE_MINT, symbol: "HYPE", decimals: 9, native: false };
}
export async function verifyHypeMint(c: Connection) {
  const account = await c.getAccountInfo(HYPE_MINT, "confirmed");
  if (
    !account ||
    !account.owner.equals(TOKEN_PROGRAM_ID) ||
    account.data.length !== 82
  )
    throw Error("HYPE mint must be the verified standard SPL mint");
  const mint = unpackMint(HYPE_MINT, account, TOKEN_PROGRAM_ID);
  if (
    !mint.isInitialized ||
    mint.decimals !== 9 ||
    mint.freezeAuthority ||
    mint.tlvData.length
  )
    throw Error("HYPE mint configuration is unsupported; launch blocked");
  return mint;
}
export async function hypeBalance(c: Connection, owner: PublicKey) {
  const ata = getAssociatedTokenAddressSync(HYPE_MINT, owner);
  const info = await c.getAccountInfo(ata, "confirmed");
  if (!info) return 0n;
  const a = unpackAccount(ata, info, TOKEN_PROGRAM_ID);
  if (!a.owner.equals(owner) || !a.mint.equals(HYPE_MINT) || a.isFrozen)
    throw Error("HYPE funding account owner, mint or state mismatch");
  return a.amount;
}
export async function requireHypeFunding(
  c: Connection,
  owner: PublicKey,
  amount: bigint,
) {
  const available = await hypeBalance(c, owner);
  if (available < amount)
    throw Error(
      "Insufficient HYPE in the creator's associated token account for the initial buy",
    );
  return available;
}
