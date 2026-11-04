import bs58 from "bs58";
import { Message, PublicKey } from "@solana/web3.js";

/** Lighthouse assertion program, which Phantom may add to a transaction it signs. Immutable on Mainnet (no upgrade authority). */
export const LIGHTHOUSE_PROGRAM_ID = new PublicKey("L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95");
export const MAX_WALLET_GUARDS = 16;
/** Lighthouse instruction tags that only read accounts and fail or pass: AssertAccountData through AssertSysvarClock. Memory
 *  write and close (0, 1) can spend the signer's SOL, and the rest (16, 17) have no use here, so both are refused. */
const ASSERTION_TAGS = new Set([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
/** AssertAccountInfo and AssertAccountInfoMulti: the only assertions allowed to name the wallet, e.g. its SOL balance. */
const WALLET_ASSERTION_TAGS = new Set([5, 6]);

export type WalletMessageCheck =
  | { ok: true; guards: number }
  | { ok: false; reason: string };

type Meta = { key: string; signer: boolean; writable: boolean };
type Instruction = { program: Meta; accounts: Meta[]; data: string };

function expand(message: Message): { flags: Map<string, Meta>; instructions: Instruction[] } {
  const metas = message.accountKeys.map((key, index): Meta => ({
    key: key.toBase58(),
    signer: message.isAccountSigner(index),
    writable: message.isAccountWritable(index),
  }));
  return {
    flags: new Map(metas.map((meta) => [meta.key, meta])),
    instructions: message.instructions.map((ix) => ({
      program: metas[ix.programIdIndex],
      accounts: ix.accounts.map((index) => metas[index]),
      data: ix.data,
    })),
  };
}

const sameMeta = (a: Meta, b: Meta) => a.key === b.key && a.signer === b.signer && a.writable === b.writable;
const sameInstruction = (a: Instruction, b: Instruction) =>
  sameMeta(a.program, b.program) &&
  a.data === b.data &&
  a.accounts.length === b.accounts.length &&
  a.accounts.every((meta, index) => sameMeta(meta, b.accounts[index]));

/**
 * Decides whether a wallet-returned message is the reviewed one. Byte-identical messages pass. Otherwise the only accepted
 * change is added Lighthouse assertion instructions: every reviewed instruction must remain, in order, with the same program,
 * accounts, signer and writable permissions and data, which covers compute-budget settings; the fee payer, blockhash and
 * signers must match; a guard must be a read-only assertion and may not make any account writable; and it may name a signer
 * only as the single target of an account-info assertion on the fee payer. Anything else is refused.
 * Permissions are compared by account, because adding accounts renumbers the message's account table.
 */
export function verifyWalletMessage(reviewedBytes: Uint8Array, signedBytes: Uint8Array): WalletMessageCheck {
  if (Buffer.from(reviewedBytes).equals(Buffer.from(signedBytes))) return { ok: true, guards: 0 };
  let reviewed: Message, signed: Message;
  try {
    reviewed = Message.from(Buffer.from(reviewedBytes));
    signed = Message.from(Buffer.from(signedBytes));
  } catch {
    return { ok: false, reason: "message format changed" };
  }
  if (reviewed.recentBlockhash !== signed.recentBlockhash) return { ok: false, reason: "blockhash changed" };
  if (!reviewed.accountKeys[0].equals(signed.accountKeys[0])) return { ok: false, reason: "fee payer changed" };
  if (reviewed.header.numRequiredSignatures !== signed.header.numRequiredSignatures) return { ok: false, reason: "signers changed" };

  const feePayer = reviewed.accountKeys[0].toBase58();
  const before = expand(reviewed), after = expand(signed);
  const lighthouse = LIGHTHOUSE_PROGRAM_ID.toBase58();
  if (before.flags.has(lighthouse)) return { ok: false, reason: "reviewed message already uses the guard program" };

  for (const [key, meta] of before.flags) {
    const now = after.flags.get(key);
    if (!now) return { ok: false, reason: `account removed: ${key}` };
    if (!sameMeta(meta, now)) return { ok: false, reason: `account permissions changed: ${key}` };
  }
  for (const [key, meta] of after.flags)
    if (!before.flags.has(key) && (meta.signer || meta.writable)) return { ok: false, reason: `added account is a signer or writable: ${key}` };

  const added = after.instructions.filter((ix) => ix.program.key === lighthouse);
  const kept = after.instructions.filter((ix) => ix.program.key !== lighthouse);
  if (kept.length !== before.instructions.length) {
    const unknown = kept.find((ix) => !before.flags.has(ix.program.key));
    return { ok: false, reason: unknown ? `instruction added by ${unknown.program.key}` : "reviewed instructions added or removed" };
  }
  for (let index = 0; index < kept.length; index++)
    if (!sameInstruction(kept[index], before.instructions[index])) return { ok: false, reason: `reviewed instruction ${index} changed or moved` };

  if (added.length === 0) return { ok: false, reason: "accounts or message fields changed" };
  if (added.length > MAX_WALLET_GUARDS) return { ok: false, reason: `too many guard instructions: ${added.length}` };
  for (const guard of added) {
    if (guard.program.signer || guard.program.writable) return { ok: false, reason: "guard program has elevated permissions" };
    const tag = bs58.decode(guard.data)[0];
    if (!ASSERTION_TAGS.has(tag)) return { ok: false, reason: `guard instruction is not an assertion: tag ${tag ?? "none"}` };
    const signer = guard.accounts.find((meta) => meta.signer);
    if (signer && !(signer.key === feePayer && guard.accounts.length === 1 && WALLET_ASSERTION_TAGS.has(tag)))
      return { ok: false, reason: `guard instruction uses signer ${signer.key} (tag ${tag}, ${guard.accounts.length} accounts)` };
  }
  return { ok: true, guards: added.length };
}
