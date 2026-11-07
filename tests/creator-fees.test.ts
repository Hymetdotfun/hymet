import { TransactionInstruction } from "@solana/web3.js";
import { LIGHTHOUSE_PROGRAM_ID } from "../lib/wallet-guards";
import { HYPE_MINT } from "../lib/quote-assets";
import {
  deriveDbcPoolAddress,
  type PoolConfig,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { afterEach, expect, it, vi } from "vitest";
import {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  ComputeBudgetProgram,
  ComputeBudgetInstruction,
  Message,
} from "@solana/web3.js";
import {
  DynamicBondingCurveClient,
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
  type VirtualPool,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { BorshInstructionCoder } from "@coral-xyz/anchor";
import bs58 from "bs58";
import {
  AccountLayout,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import fixture from "./fixtures/creator-fees-mainnet.json";
import {
  readCreatorFees,
  prepareCreatorClaim,
  executeCreatorClaim,
  refreshClaim,
  refreshClaimBlockhash,
  claimRecord,
  saveClaim,
  assertNoPendingClaim,
  assertClaimAuthority,
  knownCreatorPools,
  rememberCreatorPool,
  tokenAmount,
  type ClaimRecord,
} from "../lib/creator-fees";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
const pool = fixture.accounts[0].address;
function store() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      data.set(k, v);
    },
    data,
  };
}
function setup(network: "devnet" | "mainnet-beta" = "devnet") {
  const diagnostic = vi.spyOn(console, "info").mockImplementation(() => {});
  vi.stubGlobal(
    "fetch",
    vi.fn().mockRejectedValue(Error("Unexpected external request")),
  );
  const c = new Connection("http://localhost:8899");
  const accounts = new Map(
    fixture.accounts.map((a) => [
      a.address,
      a.account
        ? {
            ...a.account,
            owner: new PublicKey(a.account.owner),
            data: Buffer.from(a.account.data, "base64"),
            rentEpoch: 0,
          }
        : null,
    ]),
  );
  const sdk = new DynamicBondingCurveClient(c);
  const executable = {
    owner: DYNAMIC_BONDING_CURVE_PROGRAM_ID,
    executable: true,
    data: Buffer.alloc(0),
    lamports: 1,
    rentEpoch: 0,
  };
  vi.spyOn(c, "getGenesisHash").mockResolvedValue(
    network === "mainnet-beta"
      ? fixture.genesis
      : "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  );
  vi.spyOn(c, "getAccountInfo").mockImplementation(async (key) =>
    key.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID)
      ? executable
      : (accounts.get(key.toBase58()) ?? null),
  );
  vi.spyOn(c, "getMultipleAccountsInfo").mockImplementation(async (keys) =>
    keys.map((k) => accounts.get(k.toBase58()) ?? null),
  );
  vi.spyOn(c, "getLatestBlockhash").mockResolvedValue({
    blockhash: Keypair.generate().publicKey.toBase58(),
    lastValidBlockHeight: 100,
  });
  vi.spyOn(c, "getFeeForMessage").mockResolvedValue({
    context: { slot: 1 },
    value: 5000,
  });
  vi.spyOn(c, "getMinimumBalanceForRentExemption").mockResolvedValue(2039280);
  vi.spyOn(c, "getBalance").mockResolvedValue(1000000000);
  vi.spyOn(c, "getBlockHeight").mockResolvedValue(50);
  vi.spyOn(c, "simulateTransaction").mockResolvedValue({
    context: { slot: 1 },
    value: { err: null, logs: [] },
  });
  vi.spyOn(c, "getSignatureStatuses").mockResolvedValue({
    context: { slot: 1 },
    value: [
      { slot: 1, err: null, confirmationStatus: "confirmed", confirmations: 1 },
    ],
  });
  const send = vi
    .spyOn(c, "sendRawTransaction")
    .mockRejectedValue(Error("Synthetic ambiguous transport"));
  vi.spyOn(c, "getTransaction").mockResolvedValue(null);
  const state = sdk.program.coder.accounts.decode<VirtualPool>(
    "virtualPool",
    accounts.get(pool)!.data,
  );
  async function update() {
    accounts.get(pool)!.data = Buffer.from(
      await sdk.program.coder.accounts.encode("virtualPool", state),
    );
  }
  return { c, accounts, sdk, send, state, update, diagnostic };
}
it("reads actual owned Mainnet fixture counters, metadata, creator and config without a wallet or scan", async () => {
  const { c, send } = setup("mainnet-beta");
  const view = await readCreatorFees(c, "mainnet-beta", pool);
  expect(view).toMatchObject({
    creator: fixture.summary.creator,
    creatorShare: 100,
    collectMode: 0,
    base: 0n,
    quote: 6904167n,
    status: "active",
    supported: true,
    mint: fixture.summary.mint,
    config: fixture.summary.config,
    name: "Pathtrick",
  });
  expect(tokenAmount(view.quote, 9)).toBe("0.006904167");
  expect(send).not.toHaveBeenCalled();
  expect(() =>
    assertClaimAuthority(view, Keypair.generate().publicKey),
  ).toThrow("not this pool's creator");
  expect(() =>
    assertClaimAuthority(
      { ...view, base: 0n, quote: 0n },
      new PublicKey(view.creator),
    ),
  ).toThrow("No DBC");
});
it("rejects missing/wrong-owner accounts and wrong selected network", async () => {
  const { c, accounts } = setup();
  await expect(readCreatorFees(c, "mainnet-beta", pool)).rejects.toThrow(
    "genesis",
  );
  accounts.get(fixture.summary.config)!.owner = Keypair.generate().publicKey;
  await expect(readCreatorFees(c, "devnet", pool)).rejects.toThrow("Config");
  accounts.delete(pool);
  await expect(readCreatorFees(c, "devnet", pool)).rejects.toThrow("Pool");
});
it("constructs exact official creator claim with counter limits and creator-only destinations", async () => {
  const { c, sdk, send } = setup();
  const wallet = new PublicKey(fixture.summary.creator);
  const plan = await prepareCreatorClaim(c, "devnet", pool, wallet);
  expect(plan.rent).toBe(4078560n);
  expect(plan.fee).toBe(5000n);
  const ix = plan.tx.instructions.find((ix) =>
    ix.programId.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID),
  )!;
  const decoded = new BorshInstructionCoder(sdk.program.idl).decode(ix.data)!;
  expect(decoded.name).toBe("claimCreatorTradingFee");
  expect(
    (
      decoded.data as { maxBaseAmount: { toString(): string } }
    ).maxBaseAmount.toString(),
  ).toBe("0");
  expect(
    (
      decoded.data as { maxQuoteAmount: { toString(): string } }
    ).maxQuoteAmount.toString(),
  ).toBe("6904167");
  expect(
    ix.keys.filter((k) => k.isSigner).map((k) => k.pubkey.toBase58()),
  ).toEqual([wallet.toBase58()]);
  expect(plan.tx.instructions.at(-1)!.keys[1].pubkey.equals(wallet)).toBe(true); // WSOL close destination
  expect(send).not.toHaveBeenCalled();
});
it("distinguishes migrated DBC counters from unsupported DAMM position fees", async () => {
  const { c, state, update } = setup();
  state.poolState.isMigrated = 1;
  state.poolState.migrationProgress = 2;
  await update();
  const v = await readCreatorFees(c, "devnet", pool);
  expect(v.status).toBe("migrated");
  expect(v.quote).toBe(6904167n);
  expect(v).not.toHaveProperty("dammClaimable");
  state.poolState.isMigrated = 0;
  await update();
  expect((await readCreatorFees(c, "devnet", pool)).status).toBe("unknown");
});
it("keeps saved pool discovery and pending claim journals separated by network and wallet", () => {
  const s = store(),
    wallet = fixture.summary.creator;
  rememberCreatorPool(s, "devnet", wallet, pool);
  expect(knownCreatorPools(s, "devnet", wallet)).toEqual([pool]);
  expect(knownCreatorPools(s, "mainnet-beta", wallet)).toEqual([]);
  expect(
    knownCreatorPools(s, "devnet", Keypair.generate().publicKey.toBase58()),
  ).toEqual([]);
  const r: ClaimRecord = {
    network: "devnet",
    wallet,
    pool,
    signature: bs58.encode(Buffer.alloc(64, 1)),
    lastValidBlockHeight: 100,
    state: "pending",
  };
  saveClaim(s, r);
  expect(() => assertNoPendingClaim(s, "devnet", wallet)).toThrow("pending");
  expect(() => assertNoPendingClaim(s, "mainnet-beta", wallet)).not.toThrow();
  expect(JSON.stringify([...s.data.values()])).not.toContain("secretKey");
});
it("backfills a closed local launch only as a candidate requiring account verification", () => {
  const s = store(),
    wallet = fixture.summary.creator;
  s.setItem(
    `dbc-recovery-v1:devnet:${wallet}`,
    JSON.stringify({
      state: "closed",
      network: "devnet",
      creator: wallet,
      pool,
    }),
  );
  expect(knownCreatorPools(s, "devnet", wallet)).toEqual([pool]);
  expect(knownCreatorPools(s, "mainnet-beta", wallet)).toEqual([]);
});
it("records a signature before ambiguous send, refuses duplicates, and refreshes after confirmation", async () => {
  const { c, state, update, send } = setup(),
    wallet = Keypair.generate(),
    s = store();
  state.poolState.creator = wallet.publicKey;
  await update();
  const plan = await prepareCreatorClaim(c, "devnet", pool, wallet.publicKey);
  const sign = vi.fn(async (tx: Transaction) => {
    tx.partialSign(wallet);
    return tx;
  });
  await expect(
    executeCreatorClaim(c, plan, wallet.publicKey, sign, s),
  ).rejects.toThrow("ambiguous");
  const r = claimRecord(s, "devnet", wallet.publicKey.toBase58())!;
  expect(r.state).toBe("pending");
  expect(send).toHaveBeenCalledTimes(1);
  await expect(
    executeCreatorClaim(c, plan, wallet.publicKey, sign, s),
  ).rejects.toThrow("pending");
  expect(sign).toHaveBeenCalledTimes(1);
  state.poolState.creatorQuoteFee = state.poolState.creatorQuoteFee.sub(
    state.poolState.creatorQuoteFee,
  );
  await update();
  const result = await refreshClaim(c, s, r);
  expect(result.record.state).toBe("confirmed");
  expect(result.view!.quote).toBe(0n);
  expect(send).toHaveBeenCalledTimes(1);
});
it("requires wallet approval and signs an old review with a fresh blockhash, changing nothing else", async () => {
  const { c, state, update, send } = setup(),
    wallet = Keypair.generate(),
    s = store();
  state.poolState.creator = wallet.publicKey;
  await update();
  const offered: Transaction[] = [];
  const plan = await prepareCreatorClaim(c, "devnet", pool, wallet.publicKey),
    reject = vi.fn(async (tx: Transaction) => {
      offered.push(tx);
      throw Error("Wallet rejected");
    });
  await expect(
    executeCreatorClaim(c, plan, wallet.publicKey, reject, s),
  ).rejects.toThrow("Wallet rejected");
  expect(send).not.toHaveBeenCalled();
  // The review's blockhash (valid to height 100) has expired: the next attempt gets the latest one instead of failing.
  vi.mocked(c.getBlockHeight).mockResolvedValue(101);
  const latest = Keypair.generate().publicKey.toBase58();
  vi.mocked(c.getLatestBlockhash).mockResolvedValue({ blockhash: latest, lastValidBlockHeight: 250 });
  await expect(
    executeCreatorClaim(c, plan, wallet.publicKey, reject, s),
  ).rejects.toThrow("Wallet rejected");
  expect(reject).toHaveBeenCalledTimes(2);
  expect(offered[1].recentBlockhash).toBe(latest);
  const comparable = Message.from(offered[1].serializeMessage());
  comparable.recentBlockhash = plan.tx.recentBlockhash!;
  expect(Buffer.from(comparable.serialize()).toString("base64")).toBe(plan.message);
  expect(plan.tx.recentBlockhash).not.toBe(latest);
  expect(send).not.toHaveBeenCalled();
  expect(claimRecord(s, "devnet", wallet.publicKey.toBase58())).toBeUndefined();
});
it("refreshes only the blockhash of a reviewed claim and refuses a claim that changed after review", async () => {
  const { c, state, update } = setup(),
    wallet = Keypair.generate();
  state.poolState.creator = wallet.publicKey;
  await update();
  const plan = await prepareCreatorClaim(c, "devnet", pool, wallet.publicKey);
  const latest = Keypair.generate().publicKey.toBase58();
  vi.mocked(c.getLatestBlockhash).mockResolvedValue({ blockhash: latest, lastValidBlockHeight: 400 });
  const fresh = await refreshClaimBlockhash(c, plan);
  expect(fresh.tx.recentBlockhash).toBe(latest);
  expect(fresh.lastValidBlockHeight).toBe(400);
  expect([fresh.fee, fresh.rent, fresh.destinations]).toEqual([plan.fee, plan.rent, plan.destinations]);
  expect(fresh.message).not.toBe(plan.message);
  expect(plan.lastValidBlockHeight).toBe(100);
  plan.tx.instructions.pop();
  await expect(refreshClaimBlockhash(c, plan)).rejects.toThrow("Claim changed after review");
});
it("never sends a claim whose blockhash expired during a slow approval, and clears it once it cannot land", async () => {
  const { c, state, update, send } = setup(),
    wallet = Keypair.generate(),
    s = store();
  state.poolState.creator = wallet.publicKey;
  await update();
  const plan = await prepareCreatorClaim(c, "devnet", pool, wallet.publicKey);
  vi.mocked(c.getSignatureStatuses).mockResolvedValue({ context: { slot: 1 }, value: [null] });
  const slow = vi.fn(async (tx: Transaction) => {
    tx.partialSign(wallet);
    vi.mocked(c.getBlockHeight).mockResolvedValue(101); // Approval outlasted the blockhash, valid to height 100.
    return tx;
  });
  await expect(
    executeCreatorClaim(c, plan, wallet.publicKey, slow, s),
  ).rejects.toThrow("Nothing was sent. Confirm again to sign a fresh claim.");
  expect(send).not.toHaveBeenCalled();
  expect(claimRecord(s, "devnet", wallet.publicKey.toBase58())!.state).toBe("expired");
  // Nothing blocks the next attempt, which signs with a fresh blockhash and reaches the network.
  vi.mocked(c.getBlockHeight).mockResolvedValue(150);
  vi.mocked(c.getLatestBlockhash).mockResolvedValue({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 300 });
  const quick = vi.fn(async (tx: Transaction) => {
    tx.partialSign(wallet);
    return tx;
  });
  await expect(
    executeCreatorClaim(c, plan, wallet.publicKey, quick, s),
  ).rejects.toThrow("ambiguous");
  expect(quick).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledTimes(1);
});
it("keeps a slow-approval claim pending when the network has a record of its signature", async () => {
  const { c, state, update, send } = setup(),
    wallet = Keypair.generate(),
    s = store();
  state.poolState.creator = wallet.publicKey;
  await update();
  const plan = await prepareCreatorClaim(c, "devnet", pool, wallet.publicKey);
  const slow = vi.fn(async (tx: Transaction) => {
    tx.partialSign(wallet);
    vi.mocked(c.getBlockHeight).mockResolvedValue(101);
    return tx;
  });
  await expect(
    executeCreatorClaim(c, plan, wallet.publicKey, slow, s),
  ).rejects.toThrow("Check claim signature & refresh");
  expect(send).not.toHaveBeenCalled();
  expect(claimRecord(s, "devnet", wallet.publicKey.toBase58())!.state).toBe("pending");
});
it.each([100, 101])(
  "resolves unknown claims only after finalized expiry at %s",
  async (height) => {
    const { c, send } = setup(),
      s = store();
    const r: ClaimRecord = {
      network: "devnet",
      wallet: fixture.summary.creator,
      pool,
      signature: bs58.encode(Buffer.alloc(64, 2)),
      lastValidBlockHeight: 100,
      state: "pending",
    };
    saveClaim(s, r);
    vi.mocked(c.getSignatureStatuses).mockResolvedValue({
      context: { slot: 1 },
      value: [null],
    });
    vi.mocked(c.getBlockHeight).mockResolvedValue(height);
    expect((await refreshClaim(c, s, r)).record.state).toBe(
      height === 100 ? "pending" : "expired",
    );
    expect(send).not.toHaveBeenCalled();
  },
);
it("fails closed if claim recovery persistence fails", async () => {
  const { c, state, update, send } = setup(),
    wallet = Keypair.generate();
  state.poolState.creator = wallet.publicKey;
  await update();
  const s = store();
  const plan = await prepareCreatorClaim(c, "devnet", pool, wallet.publicKey);
  s.setItem = () => {
    throw Error("Storage unavailable");
  };
  await expect(
    executeCreatorClaim(
      c,
      plan,
      wallet.publicKey,
      async (tx) => {
        tx.partialSign(wallet);
        return tx;
      },
      s,
    ),
  ).rejects.toThrow("Storage unavailable");
  expect(send).not.toHaveBeenCalled();
});
it("refreshes actual counters and returns a signature after a mocked successful confirmation", async () => {
  const { c, state, update, send } = setup(),
    wallet = Keypair.generate(),
    s = store();
  state.poolState.creator = wallet.publicKey;
  await update();
  const plan = await prepareCreatorClaim(c, "devnet", pool, wallet.publicKey);
  send.mockImplementation(async (raw) => {
    const tx = Transaction.from(raw);
    state.poolState.creatorQuoteFee = state.poolState.creatorQuoteFee.sub(
      state.poolState.creatorQuoteFee,
    );
    await update();
    return bs58.encode(tx.signature!);
  });
  const result = await executeCreatorClaim(
    c,
    plan,
    wallet.publicKey,
    async (tx) => {
      tx.partialSign(wallet);
      return tx;
    },
    s,
  );
  expect(result.record.state).toBe("confirmed");
  expect(result.view!.quote).toBe(0n);
  expect(result.record.signature).toBeTruthy();
  expect(send).toHaveBeenCalledTimes(1);
});
it("refuses altered signed messages and signed simulation errors before broadcasting", async () => {
  const { c, state, update, send } = setup(),
    wallet = Keypair.generate(),
    s = store();
  state.poolState.creator = wallet.publicKey;
  await update();
  const plan = await prepareCreatorClaim(c, "devnet", pool, wallet.publicKey);
  await expect(
    executeCreatorClaim(
      c,
      plan,
      wallet.publicKey,
      async (tx) => {
        tx.recentBlockhash = Keypair.generate().publicKey.toBase58();
        tx.partialSign(wallet);
        return tx;
      },
      s,
    ),
  ).rejects.toThrow("changed");
  expect(
    claimRecord(s, "devnet", wallet.publicKey.toBase58())?.expiryKnown,
  ).toBe(false);
  const fresh = await prepareCreatorClaim(c, "devnet", pool, wallet.publicKey);
  const freshStore = store();
  vi.mocked(c.simulateTransaction)
    .mockResolvedValueOnce({
      context: { slot: 1 },
      value: { err: null, logs: [] },
    })
    .mockResolvedValueOnce({
      context: { slot: 1 },
      value: { err: "BlockhashNotFound", logs: [] },
    });
  await expect(
    executeCreatorClaim(
      c,
      fresh,
      wallet.publicKey,
      async (tx) => {
        tx.partialSign(wallet);
        return tx;
      },
      freshStore,
    ),
  ).rejects.toThrow("Signed simulation failed");
  expect(send).not.toHaveBeenCalled();
  expect(
    claimRecord(freshStore, "devnet", wallet.publicKey.toBase58())?.state,
  ).toBe("pending");
});
it("retains an ambiguous journal on RPC failure and reports a confirmed on-chain failure without resending", async () => {
  const { c, send } = setup(),
    s = store();
  const r: ClaimRecord = {
    network: "devnet",
    wallet: fixture.summary.creator,
    pool,
    signature: bs58.encode(Buffer.alloc(64, 3)),
    lastValidBlockHeight: 100,
    state: "pending",
  };
  saveClaim(s, r);
  vi.mocked(c.getSignatureStatuses).mockRejectedValueOnce(
    Error("RPC unavailable"),
  );
  await expect(refreshClaim(c, s, r)).rejects.toThrow("RPC unavailable");
  expect(claimRecord(s, "devnet", r.wallet)?.state).toBe("pending");
  vi.mocked(c.getSignatureStatuses).mockResolvedValue({
    context: { slot: 1 },
    value: [
      {
        slot: 1,
        err: { InstructionError: [0, "Custom"] },
        confirmationStatus: "confirmed",
        confirmations: 1,
      },
    ],
  });
  expect((await refreshClaim(c, s, r)).record.state).toBe("failed");
  expect(send).not.toHaveBeenCalled();
});
it("enforces the existing Mainnet gate even for a constructed Mainnet claim", async () => {
  const { c, send } = setup("mainnet-beta"),
    wallet = new PublicKey(fixture.summary.creator),
    s = store();
  vi.stubEnv("NEXT_PUBLIC_ENABLE_MAINNET", "false");
  const plan = await prepareCreatorClaim(c, "mainnet-beta", pool, wallet),
    sign = vi.fn();
  await expect(executeCreatorClaim(c, plan, wallet, sign, s)).rejects.toThrow(
    "Mainnet transactions are disabled",
  );
  expect(sign).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});
it("requires a new review if existing WSOL changes before Phantom approval", async () => {
  const { c, state, update, accounts, send } = setup(),
    wallet = Keypair.generate(),
    s = store();
  state.poolState.creator = wallet.publicKey;
  await update();
  const plan = await prepareCreatorClaim(c, "devnet", pool, wallet.publicKey),
    data = Buffer.alloc(165);
  AccountLayout.encode(
    {
      mint: NATIVE_MINT,
      owner: wallet.publicKey,
      amount: 1n,
      delegateOption: 0,
      delegate: PublicKey.default,
      state: 1,
      isNativeOption: 1,
      isNative: 2039280n,
      delegatedAmount: 0n,
      closeAuthorityOption: 0,
      closeAuthority: PublicKey.default,
    },
    data,
  );
  accounts.set(plan.destinations[1], {
    owner: TOKEN_PROGRAM_ID,
    data,
    lamports: 2039281,
    executable: false,
    rentEpoch: 0,
  });
  const sign = vi.fn();
  await expect(
    executeCreatorClaim(c, plan, wallet.publicKey, sign, s),
  ).rejects.toThrow("WSOL changed");
  expect(sign).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});
it("preserves the reviewed message through legacy serialized wallet round trips", async () => {
  const { c, state, update } = setup(),
    wallet = Keypair.generate();
  state.poolState.creator = wallet.publicKey;
  await update();
  const plan = await prepareCreatorClaim(c, "devnet", pool, wallet.publicKey);
  const returned = Transaction.from(
    plan.tx.serialize({ requireAllSignatures: false, verifySignatures: false }),
  );
  returned.partialSign(wallet);
  expect(Buffer.from(returned.serializeMessage()).toString("base64")).toBe(
    plan.message,
  );
  expect(returned.verifySignatures()).toBe(true);
});
it("explicitly fixes the reviewed compute-unit price at zero", async () => {
  const { c } = setup();
  const plan = await prepareCreatorClaim(
    c,
    "devnet",
    pool,
    new PublicKey(fixture.summary.creator),
  );
  expect(
    ComputeBudgetInstruction.decodeSetComputeUnitLimit(plan.tx.instructions[0])
      .units,
  ).toBe(400000);
  expect(
    ComputeBudgetInstruction.decodeSetComputeUnitPrice(plan.tx.instructions[1])
      .microLamports,
  ).toBe(20000n);
});
it("accepts a serialized Phantom-style signed return and checks the exact fee before sending", async () => {
  const { c, state, update, send } = setup(),
    wallet = Keypair.generate(),
    s = store();
  state.poolState.creator = wallet.publicKey;
  await update();
  const plan = await prepareCreatorClaim(c, "devnet", pool, wallet.publicKey);
  await expect(
    executeCreatorClaim(
      c,
      plan,
      wallet.publicKey,
      async (input) => {
        const signed = Transaction.from(
          input.serialize({ requireAllSignatures: false }),
        );
        signed.partialSign(wallet);
        return Transaction.from(signed.serialize());
      },
      s,
    ),
  ).rejects.toThrow("ambiguous");
  expect(send).toHaveBeenCalledTimes(1);
  expect(claimRecord(s, "devnet", wallet.publicKey.toBase58())).toMatchObject({
    reviewedFee: "5000",
    signedFee: "5000",
    state: "pending",
  });
});
it("distinguishes valid wallet priority-fee mutation from invalid signatures and preserves its public signature", async () => {
  const { c, state, update, send } = setup(),
    wallet = Keypair.generate(),
    s = store();
  state.poolState.creator = wallet.publicKey;
  await update();
  const plan = await prepareCreatorClaim(c, "devnet", pool, wallet.publicKey);
  vi.mocked(c.getFeeForMessage).mockResolvedValue({
    context: { slot: 1 },
    value: 15000,
  });
  await expect(
    executeCreatorClaim(
      c,
      plan,
      wallet.publicKey,
      async (tx) => {
        tx.instructions[1] = ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: 25000,
        });
        tx.partialSign(wallet);
        expect(tx.verifySignatures()).toBe(true);
        return tx;
      },
      s,
    ),
  ).rejects.toThrow("changed the reviewed transaction message");
  const r = claimRecord(s, "devnet", wallet.publicKey.toBase58())!;
  expect(r).toMatchObject({
    state: "pending",
    reviewedFee: "5000",
    signedFee: "15000",
    expiryKnown: true,
  });
  expect(r.signingIssue).toBeTruthy();
  expect(send).not.toHaveBeenCalled();
  const sign = vi.fn();
  await expect(
    executeCreatorClaim(c, plan, wallet.publicKey, sign, s),
  ).rejects.toThrow("pending");
  expect(sign).not.toHaveBeenCalled();
});
it("rejects cryptographically invalid payer signatures without sending", async () => {
  const { c, state, update, send } = setup(),
    wallet = Keypair.generate(),
    s = store();
  state.poolState.creator = wallet.publicKey;
  await update();
  const plan = await prepareCreatorClaim(c, "devnet", pool, wallet.publicKey);
  await expect(
    executeCreatorClaim(
      c,
      plan,
      wallet.publicKey,
      async (tx) => {
        tx.partialSign(wallet);
        tx.signatures[0].signature![0] ^= 1;
        return tx;
      },
      s,
    ),
  ).rejects.toThrow("cryptographically invalid");
  expect(send).not.toHaveBeenCalled();
});
it("keeps a changed-blockhash signature pending rather than applying the reviewed hash expiry", async () => {
  const { c, send } = setup(),
    s = store();
  const r: ClaimRecord = {
    network: "devnet",
    wallet: fixture.summary.creator,
    pool,
    signature: bs58.encode(Buffer.alloc(64, 4)),
    lastValidBlockHeight: 100,
    expiryKnown: false,
    state: "pending",
  };
  saveClaim(s, r);
  vi.mocked(c.getSignatureStatuses).mockResolvedValue({
    context: { slot: 1 },
    value: [null],
  });
  vi.mocked(c.getBlockHeight).mockResolvedValue(999);
  expect((await refreshClaim(c, s, r)).record.state).toBe("pending");
  expect(c.getBlockHeight).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});
it("reads the actual confirmed transaction fee separately from reviewed and signed estimates", async () => {
  const { c, send } = setup(),
    s = store();
  const r: ClaimRecord = {
    network: "devnet",
    wallet: fixture.summary.creator,
    pool,
    signature: bs58.encode(Buffer.alloc(64, 5)),
    lastValidBlockHeight: 100,
    reviewedFee: "5000",
    signedFee: "5000",
    state: "pending",
  };
  saveClaim(s, r);
  vi.mocked(c.getTransaction).mockResolvedValue({
    meta: { fee: 5000 },
  } as never);
  const result = await refreshClaim(c, s, r);
  expect(result.record).toMatchObject({
    state: "confirmed",
    actualFee: "5000",
    reviewedFee: "5000",
  });
  expect(send).not.toHaveBeenCalled();
});
it("never resubmits an already confirmed signed claim even if fees subsequently accrue again", async () => {
  const { c, state, update, send } = setup(),
    wallet = Keypair.generate(),
    s = store();
  state.poolState.creator = wallet.publicKey;
  await update();
  const plan = await prepareCreatorClaim(c, "devnet", pool, wallet.publicKey);
  send.mockImplementation(async (raw) =>
    bs58.encode(Transaction.from(raw).signature!),
  );
  const sign = async (tx: Transaction) => {
    tx.partialSign(wallet);
    return tx;
  };
  expect(
    (await executeCreatorClaim(c, plan, wallet.publicKey, sign, s)).record
      .state,
  ).toBe("confirmed");
  await expect(
    executeCreatorClaim(c, plan, wallet.publicKey, sign, s),
  ).rejects.toThrow("already recorded or processed");
  expect(send).toHaveBeenCalledTimes(1);
  expect(claimRecord(s, "devnet", wallet.publicKey.toBase58())?.state).toBe(
    "confirmed",
  );
});
it("rejects a signature-only response instead of treating it as a signed transaction", async () => {
  const { c, state, update, send } = setup(),
    wallet = Keypair.generate(),
    s = store();
  state.poolState.creator = wallet.publicKey;
  await update();
  const plan = await prepareCreatorClaim(c, "devnet", pool, wallet.publicKey);
  await expect(
    executeCreatorClaim(
      c,
      plan,
      wallet.publicKey,
      async () =>
        ({ signature: Buffer.alloc(64, 1) }) as unknown as Transaction,
      s,
    ),
  ).rejects.toThrow("did not return a signed transaction");
  expect(send).not.toHaveBeenCalled();
  expect(claimRecord(s, "devnet", wallet.publicKey.toBase58())).toBeUndefined();
});
it("reports a missing signature independently from message integrity and logs only safe diagnostic fields", async () => {
  const { c, state, update, send, diagnostic } = setup(),
    wallet = Keypair.generate(),
    s = store();
  state.poolState.creator = wallet.publicKey;
  await update();
  const plan = await prepareCreatorClaim(c, "devnet", pool, wallet.publicKey);
  await expect(
    executeCreatorClaim(
      c,
      plan,
      wallet.publicKey,
      async (tx) =>
        Transaction.from(tx.serialize({ requireAllSignatures: false })),
      s,
    ),
  ).rejects.toThrow("[CLAIM_SIGNATURE_MISSING]");
  expect(diagnostic).toHaveBeenCalledWith(
    "[CreatorFees claim-signing-v3] after-wallet",
    expect.objectContaining({
      messageUnchanged: true,
      missingSignatures: 1,
      signaturesValid: false,
    }),
  );
  const logs = JSON.stringify(diagnostic.mock.calls);
  for (const forbidden of [
    wallet.publicKey.toBase58(),
    "secretKey",
    "privateKey",
    plan.message,
    plan.tx.recentBlockhash!,
  ])
    expect(logs).not.toContain(forbidden);
  expect(send).not.toHaveBeenCalled();
  expect(claimRecord(s, "devnet", wallet.publicKey.toBase58())).toBeUndefined();
});
it("rejects pre-existing partial signatures before opening Phantom rather than reusing or clearing them", async () => {
  const { c, state, update, send, diagnostic } = setup(),
    wallet = Keypair.generate(),
    s = store();
  state.poolState.creator = wallet.publicKey;
  await update();
  const plan = await prepareCreatorClaim(c, "devnet", pool, wallet.publicKey);
  plan.tx.partialSign(wallet);
  const sign = vi.fn();
  await expect(
    executeCreatorClaim(c, plan, wallet.publicKey, sign, s),
  ).rejects.toThrow("[CLAIM_PREEXISTING_SIGNATURE]");
  expect(diagnostic).toHaveBeenCalledWith(
    "[CreatorFees claim-signing-v3] before-wallet",
    expect.objectContaining({
      partialSignatures: 1,
      computeBudgetInstructions: 2,
      feePayerMatches: true,
    }),
  );
  expect(sign).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
  expect(plan.tx.verifySignatures()).toBe(true);
});

it("constructs a HYPE creator fee claim to the creator HYPE ATA without WSOL closing (synthetic accounts)", async () => {
  const x = setup();
  const cfgAddress = new PublicKey(fixture.summary.config);
  const cfgAccount = x.accounts.get(cfgAddress.toBase58())!;
  const cfg = x.sdk.program.coder.accounts.decode<PoolConfig>(
    "poolConfig",
    cfgAccount.data,
  );
  cfg.quoteMint = HYPE_MINT;
  const quoteOffset = cfgAccount.data.indexOf(NATIVE_MINT.toBuffer());
  expect(quoteOffset).toBeGreaterThan(0);
  HYPE_MINT.toBuffer().copy(cfgAccount.data, quoteOffset);
  const native = x.accounts.get(NATIVE_MINT.toBase58())!;
  x.accounts.set(HYPE_MINT.toBase58(), {
    ...native,
    data: Buffer.from(native.data),
  });
  const address = deriveDbcPoolAddress(
    HYPE_MINT,
    x.state.poolState.baseMint,
    cfgAddress,
  );
  x.accounts.set(address.toBase58(), {
    ...x.accounts.get(pool)!,
    data: Buffer.from(
      await x.sdk.program.coder.accounts.encode("virtualPool", x.state),
    ),
  });
  const owner = x.state.poolState.creator;
  const view = await readCreatorFees(x.c, "devnet", address.toBase58());
  expect(view.supported).toBe(true);
  expect(view.quoteMint).toBe(HYPE_MINT.toBase58());
  expect(view.quote).toBe(6904167n);
  const plan = await prepareCreatorClaim(
    x.c,
    "devnet",
    address.toBase58(),
    owner,
  );
  expect(plan.destinations[1]).toBe(
    getAssociatedTokenAddressSync(HYPE_MINT, owner).toBase58(),
  );
  expect(plan.existingWrappedSol).toBe(0n);
  expect(
    plan.tx.instructions
      .flatMap((i) => i.keys)
      .some((k) => k.pubkey.equals(NATIVE_MINT)),
  ).toBe(false);
  const coder = new BorshInstructionCoder(x.sdk.program.idl);
  const claims = plan.tx.instructions.filter((i) =>
    i.programId.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID),
  );
  expect(claims).toHaveLength(1);
  expect(coder.decode(claims[0].data)!.name).toBe("claimCreatorTradingFee");
  expect(
    claims[0].keys.some((k) => k.pubkey.toBase58() === plan.destinations[1]),
  ).toBe(true);
  expect(x.send).not.toHaveBeenCalled();
});

it("sends a claim Phantom only added a Lighthouse assertion to, and records the reviewed fee", async () => {
  const { c, state, update, send } = setup(),
    wallet = Keypair.generate(),
    s = store();
  state.poolState.creator = wallet.publicKey;
  await update();
  const plan = await prepareCreatorClaim(c, "devnet", pool, wallet.publicKey);
  await expect(
    executeCreatorClaim(
      c,
      plan,
      wallet.publicKey,
      async (tx) => {
        tx.instructions.push(new TransactionInstruction({ programId: LIGHTHOUSE_PROGRAM_ID, keys: [], data: Buffer.from([9]) }));
        tx.partialSign(wallet);
        return tx;
      },
      s,
    ),
  ).rejects.toThrow("ambiguous");
  expect(send).toHaveBeenCalledTimes(1);
  const r = claimRecord(s, "devnet", wallet.publicKey.toBase58())!;
  expect(r.signingIssue).toBeUndefined();
  expect(r.signedFee).toBe("5000");
});
