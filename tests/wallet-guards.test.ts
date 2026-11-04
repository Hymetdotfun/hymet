import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { LIGHTHOUSE_PROGRAM_ID, MAX_WALLET_GUARDS, verifyWalletMessage } from "../lib/wallet-guards";
import { executeWalletOperation } from "../lib/wallet-operation";

const wallet = Keypair.generate(), target = Keypair.generate().publicKey, blockhash = Keypair.generate().publicKey.toBase58();
const budget = () => [ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 20_000 })];
const transfer = (lamports = 1, to = target) => SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: to, lamports });
const swap = (extra: PublicKey = Keypair.generate().publicKey) => new TransactionInstruction({ programId: new PublicKey("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN"), keys: [{ pubkey: wallet.publicKey, isSigner: true, isWritable: true }, { pubkey: target, isSigner: false, isWritable: true }, { pubkey: extra, isSigner: false, isWritable: false }], data: Buffer.from([1, 2, 3]) });
const guard = (...accounts: { pubkey: PublicKey; isSigner?: boolean; isWritable?: boolean }[]) => new TransactionInstruction({ programId: LIGHTHOUSE_PROGRAM_ID, keys: accounts.map((a) => ({ pubkey: a.pubkey, isSigner: a.isSigner ?? false, isWritable: a.isWritable ?? false })), data: Buffer.from([9]) });
const reader = Keypair.generate().publicKey, shared = swap(reader);

const message = (instructions: TransactionInstruction[], payer = wallet.publicKey, hash = blockhash) => new Transaction({ feePayer: payer, recentBlockhash: hash }).add(...instructions).serializeMessage();
const reviewedList = () => [...budget(), shared, transfer()];
const reviewed = () => message(reviewedList());
const check = (instructions: TransactionInstruction[], payer?: PublicKey, hash?: string) => verifyWalletMessage(reviewed(), message(instructions, payer, hash));
const refused = (instructions: TransactionInstruction[], reason: RegExp, payer?: PublicKey, hash?: string) => {
  const result = check(instructions, payer, hash);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toMatch(reason);
};

describe("verifyWalletMessage", () => {
  it("accepts an unchanged message with no guards", () => {
    expect(verifyWalletMessage(reviewed(), reviewed())).toEqual({ ok: true, guards: 0 });
  });

  it("accepts added Lighthouse assertions, wherever they sit, reading a reviewed or new account", () => {
    const [limit, price] = budget();
    expect(check([limit, price, shared, transfer(), guard({ pubkey: target })])).toEqual({ ok: true, guards: 1 });
    expect(check([guard({ pubkey: reader }), limit, price, guard(), shared, guard({ pubkey: Keypair.generate().publicKey }), transfer()])).toEqual({ ok: true, guards: 3 });
  });

  it("refuses any other added instruction, including priority fees and transfers", () => {
    refused([...reviewedList(), ComputeBudgetProgram.setComputeUnitLimit({ units: 1 })], /reviewed instructions added or removed|instruction added/);
    refused([...reviewedList(), transfer(5, Keypair.generate().publicKey)], /added account is a signer or writable/);
    const memo = new TransactionInstruction({ programId: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"), keys: [], data: Buffer.from("x") });
    refused([...reviewedList(), memo], /instruction added by Memo/);
  });

  it("refuses changed compute settings, even alongside a guard", () => {
    const [limit] = budget();
    refused([limit, ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 20_001 }), shared, transfer(), guard()], /reviewed instruction 1 changed/);
    refused([ComputeBudgetProgram.setComputeUnitLimit({ units: 300_001 }), budget()[1], shared, transfer(), guard()], /reviewed instruction 0 changed/);
    refused([budget()[1], shared, transfer(), guard()], /added or removed/);
  });

  it("refuses removed, reordered or altered reviewed instructions", () => {
    const [limit, price] = budget();
    refused([limit, price, transfer(), shared, guard()], /changed or moved/);
    refused([limit, price, shared, transfer(2), guard()], /reviewed instruction 3 changed/);
    refused([limit, price, shared, guard()], /account removed/);
    const changed = new TransactionInstruction({ ...shared, data: Buffer.from([1, 2, 4]) });
    refused([limit, price, changed, transfer(), guard()], /reviewed instruction 2 changed/);
    const otherAccount = new TransactionInstruction({ ...shared, keys: [shared.keys[0], { ...shared.keys[1], pubkey: Keypair.generate().publicKey }, shared.keys[2]] });
    refused([limit, price, otherAccount, transfer(), guard({ pubkey: target })], /added account is a signer or writable|changed/);
  });

  it("refuses a changed fee payer, blockhash or extra signer", () => {
    const list = [...reviewedList(), guard()];
    refused(list, /fee payer changed/, Keypair.generate().publicKey);
    refused(list, /blockhash changed/, undefined, Keypair.generate().publicKey.toBase58());
    refused([...reviewedList(), guard({ pubkey: Keypair.generate().publicKey, isSigner: true })], /signers changed/);
  });

  it("refuses a guard that touches the wallet, or raises any account's permissions", () => {
    refused([...reviewedList(), guard({ pubkey: wallet.publicKey })], /guard instruction uses signer/);
    refused([...reviewedList(), guard({ pubkey: reader, isWritable: true })], /account permissions changed/);
    refused([...reviewedList(), guard({ pubkey: Keypair.generate().publicKey, isWritable: true })], /added account is a signer or writable/);
  });

  it("refuses a look-alike program, too many guards, and an unparseable message", () => {
    const fake = new TransactionInstruction({ programId: Keypair.generate().publicKey, keys: [], data: Buffer.from([9]) });
    refused([...reviewedList(), fake], /instruction added by/);
    refused([...reviewedList(), ...Array.from({ length: MAX_WALLET_GUARDS + 1 }, () => guard())], /too many guard/);
    const versioned = Buffer.concat([Buffer.from([0x80]), Buffer.from(reviewed())]);
    expect(verifyWalletMessage(reviewed(), versioned)).toEqual({ ok: false, reason: "message format changed" });
  });
});

describe("executeWalletOperation with guards", () => {
  afterEach(() => vi.unstubAllEnvs());
  const setup = (lockKey?: Keypair) => {
    vi.stubEnv("NEXT_PUBLIC_ENABLE_MAINNET", "true"); vi.stubEnv("ENABLE_MAINNET", "true"); vi.stubEnv("NEXT_PUBLIC_HYMET_TEST_NETWORK", "");
    const tx = new Transaction({ feePayer: wallet.publicKey, recentBlockhash: blockhash }).add(...reviewedList());
    if (lockKey) { tx.add(new TransactionInstruction({ programId: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"), keys: [{ pubkey: lockKey.publicKey, isSigner: true, isWritable: false }], data: Buffer.from("x") })); tx.partialSign(lockKey); }
    const values = new Map<string, string>();
    const storage = { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => { values.set(k, v); } };
    const rpc = {
      getGenesisHash: vi.fn(async () => "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"),
      simulateTransaction: vi.fn(async () => ({ value: { err: null } })),
      getSignatureStatuses: vi.fn(async () => ({ value: [{ confirmationStatus: "confirmed", err: null }] })),
      getBlockHeight: vi.fn(async () => 1),
      sendRawTransaction: vi.fn(async (raw: Buffer) => { const { default: bs58 } = await import("bs58"); return bs58.encode(Transaction.from(raw).signature!); }),
    };
    return { tx, storage, rpc, c: rpc as unknown as Connection };
  };
  const phantom = (...extra: TransactionInstruction[]) => async (t: Transaction) => {
    const altered = new Transaction({ feePayer: t.feePayer, recentBlockhash: t.recentBlockhash }).add(...t.instructions, ...extra);
    altered.sign(wallet);
    return altered;
  };

  it("sends the guarded message Phantom signed, after simulating those bytes, when the caller opts in", async () => {
    const f = setup();
    await executeWalletOperation(f.c, f.tx, wallet.publicKey, phantom(guard({ pubkey: target })), f.storage, 100, undefined, undefined, { allowWalletGuards: true });
    expect(f.rpc.simulateTransaction).toHaveBeenCalledTimes(2);
    expect(f.rpc.sendRawTransaction).toHaveBeenCalledTimes(1);
    const sent = Transaction.from(f.rpc.sendRawTransaction.mock.calls[0][0]);
    expect(sent.verifySignatures()).toBe(true);
    expect(sent.instructions.at(-1)!.programId.equals(LIGHTHOUSE_PROGRAM_ID)).toBe(true);
  });

  it("stays byte-for-byte by default, as for the owner console", async () => {
    const f = setup();
    await expect(executeWalletOperation(f.c, f.tx, wallet.publicKey, phantom(guard()), f.storage, 100)).rejects.toThrow("Phantom changed the reviewed transaction message");
    expect(f.rpc.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("refuses anything but a guard even when the caller opts in, and says why", async () => {
    const f = setup();
    await expect(executeWalletOperation(f.c, f.tx, wallet.publicKey, phantom(transfer(9, Keypair.generate().publicKey)), f.storage, 100, undefined, undefined, { allowWalletGuards: true })).rejects.toThrow(/added account is a signer or writable/);
    expect(f.rpc.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("stays byte-for-byte when another key has already signed", async () => {
    const lock = Keypair.generate(), f = setup(lock);
    const alter = async (t: Transaction) => { const a = new Transaction({ feePayer: t.feePayer, recentBlockhash: t.recentBlockhash }).add(...t.instructions, guard()); a.partialSign(wallet, lock); return a; };
    await expect(executeWalletOperation(f.c, f.tx, wallet.publicKey, alter, f.storage, 100, undefined, undefined, { allowWalletGuards: true })).rejects.toThrow("Phantom changed the reviewed transaction message");
    expect(f.rpc.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("still refuses an invalid signature on a guarded message", async () => {
    const f = setup();
    const forged = async (t: Transaction) => {
      const altered = new Transaction({ feePayer: t.feePayer, recentBlockhash: t.recentBlockhash }).add(...t.instructions, guard());
      altered.addSignature(wallet.publicKey, Buffer.alloc(64, 7));
      return altered;
    };
    await expect(executeWalletOperation(f.c, f.tx, wallet.publicKey, forged, f.storage, 100, undefined, undefined, { allowWalletGuards: true })).rejects.toThrow(/signature is missing or invalid/);
    expect(f.rpc.sendRawTransaction).not.toHaveBeenCalled();
  });
});

describe("signing paths", () => {
  it.each([
    ["DBC and DAMM swaps", "components/trade-panel.tsx", /allowWalletGuards:\s*true/],
    ["distributor creator claim", "components/fee-ledger.tsx", /allowWalletGuards:\s*true/],
    ["platform claims", "components/platform-fee-claims.tsx", /allowWalletGuards:\s*true/],
    ["creator and DAMM position claims", "lib/creator-fees.ts", /verifyWalletMessage\(/],
    ["confirmed DAMM claim check", "lib/damm-fees.ts", /verifyWalletMessage\(/],
  ])("%s use the validator", (_name, file, pattern) => {
    expect(readFileSync(file as string, "utf8")).toMatch(pattern as RegExp);
  });

  it("the owner console stays byte-for-byte", () => {
    expect(readFileSync("components/owner-console.tsx", "utf8")).not.toContain("allowWalletGuards");
  });
});
