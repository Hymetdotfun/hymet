import { HYPE_MINT } from "../lib/quote-assets";
import { deriveDbcPoolAddress } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { NATIVE_MINT, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { afterEach, expect, it, vi } from "vitest";
import BN from "bn.js";
import bs58 from "bs58";
import { BorshAccountsCoder, type Idl } from "@coral-xyz/anchor";
import { IdlCoder } from "@coral-xyz/anchor/dist/cjs/coder/borsh/idl";
import { convertIdlToCamelCase } from "@coral-xyz/anchor/dist/cjs/idl";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
  type AccountInfo,
} from "@solana/web3.js";
import {
  CpAmm,
  CpAmmIdl,
  cpAmmCoder,
  CP_AMM_PROGRAM_ID,
  derivePositionAddress,
  deriveTokenVaultAddress,
  derivePoolAuthority,
  getUnClaimLpFee,
  type PoolState,
  type PositionState,
} from "@meteora-ag/cp-amm-sdk";
import {
  DynamicBondingCurveClient,
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
  DAMM_V2_MIGRATION_FEE_ADDRESS,
  deriveDammV2PoolAddress,
  type VirtualPool,
  type PoolConfig,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import {
  AccountLayout,
  MintLayout,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import {
  readDammPositions,
  prepareDammClaim,
  executeDammClaim,
  dammRecord,
  refreshDammClaim,
  protectDammInstructions,
} from "../lib/damm-fees";
import fixture from "./fixtures/creator-fees-mainnet.json";
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
const idl = convertIdlToCamelCase(CpAmmIdl as Idl);
function encode(name: string, state: unknown) {
  const coder = new BorshAccountsCoder(idl),
    body = Buffer.alloc(coder.size(name) - 8);
  IdlCoder.typeDefLayout({
    typeDef: idl.types!.find((t) => t.name === name)!,
    types: idl.types!,
  }).encode(state, body);
  return Buffer.concat([
    Buffer.from(idl.accounts!.find((a) => a.name === name)!.discriminator),
    body,
  ]);
}
function zero<T>(name: string): T {
  const coder = new BorshAccountsCoder(idl),
    data = Buffer.alloc(coder.size(name));
  Buffer.from(idl.accounts!.find((a) => a.name === name)!.discriminator).copy(
    data,
  );
  return coder.decode<T>(name, data);
}
function token(mint: PublicKey, owner: PublicKey, amount = 1n) {
  const data = Buffer.alloc(AccountLayout.span);
  AccountLayout.encode(
    {
      mint,
      owner,
      amount,
      delegateOption: 0,
      delegate: PublicKey.default,
      state: 1,
      isNativeOption: 0,
      isNative: 0n,
      delegatedAmount: 0n,
      closeAuthorityOption: 0,
      closeAuthority: PublicKey.default,
    },
    data,
  );
  return data;
}
function storage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      data.set(k, v);
    },
  };
}
async function setup(hype = false) {
  vi.spyOn(console, "info").mockImplementation(() => {});
  const c = new Connection("http://localhost:8899"),
    wallet = Keypair.generate(),
    nft = Keypair.generate().publicKey,
    nftAccount = Keypair.generate().publicKey,
    position = derivePositionAddress(nft),
    s = storage();
  const accounts = new Map<string, AccountInfo<Buffer>>();
  for (const a of fixture.accounts)
    if (a.account)
      accounts.set(a.address, {
        ...a.account,
        owner: new PublicKey(a.account.owner),
        data: Buffer.from(a.account.data, "base64"),
        rentEpoch: 0,
      });
  const sdk = new DynamicBondingCurveClient(c);
  const dbc = sdk.program.coder.accounts.decode<VirtualPool>(
    "virtualPool",
    accounts.get(fixture.accounts[0].address)!.data,
  );
  const cfg = sdk.program.coder.accounts.decode<PoolConfig>(
    "poolConfig",
    accounts.get(fixture.accounts[1].address)!.data,
  );
  let dbcAddress = fixture.accounts[0].address;
  if (hype) {
    cfg.quoteMint = HYPE_MINT;
    const cfgInfo = accounts.get(fixture.accounts[1].address)!;
    const quoteOffset = cfgInfo.data.indexOf(NATIVE_MINT.toBuffer());
    expect(quoteOffset).toBeGreaterThan(0);
    HYPE_MINT.toBuffer().copy(cfgInfo.data, quoteOffset);
    const native = accounts.get(NATIVE_MINT.toBase58())!;
    accounts.set(HYPE_MINT.toBase58(), {
      ...native,
      data: Buffer.from(native.data),
    });
    dbcAddress = deriveDbcPoolAddress(
      HYPE_MINT,
      dbc.poolState.baseMint,
      dbc.poolState.config,
    ).toBase58();
  }
  dbc.poolState.isMigrated = 1;
  dbc.poolState.migrationProgress = 3;
  accounts.get(fixture.accounts[0].address)!.data = Buffer.from(
    await sdk.program.coder.accounts.encode("virtualPool", dbc),
  );
  if (hype)
    accounts.set(dbcAddress, { ...accounts.get(fixture.accounts[0].address)! });
  const destination = deriveDammV2PoolAddress(
    DAMM_V2_MIGRATION_FEE_ADDRESS[cfg.migrationFeeOption],
    dbc.poolState.baseMint,
    cfg.quoteMint,
  );
  const pool = zero<PoolState>("pool"),
    p = zero<PositionState>("position");
  pool.tokenAMint = dbc.poolState.baseMint;
  pool.tokenBMint = cfg.quoteMint;
  pool.tokenAVault = deriveTokenVaultAddress(pool.tokenAMint, destination);
  pool.tokenBVault = deriveTokenVaultAddress(pool.tokenBMint, destination);
  pool.feeAPerLiquidity = new BN(1).shln(128).toArray("le", 32);
  p.pool = destination;
  p.nftMint = nft;
  p.feeAPending = new BN(7);
  p.feeBPending = new BN(11);
  p.unlockedLiquidity = new BN(1);
  p.vestedLiquidity = new BN(2);
  p.permanentLockedLiquidity = new BN(3);
  const info = (
    owner: PublicKey,
    data: Buffer,
    executable = false,
  ): AccountInfo<Buffer> => ({
    owner,
    data,
    executable,
    lamports: 2039280,
    rentEpoch: 0,
  });
  accounts.set(
    DYNAMIC_BONDING_CURVE_PROGRAM_ID.toBase58(),
    info(PublicKey.default, Buffer.alloc(0), true),
  );
  accounts.set(
    CP_AMM_PROGRAM_ID.toBase58(),
    info(PublicKey.default, Buffer.alloc(0), true),
  );
  accounts.set(
    destination.toBase58(),
    info(CP_AMM_PROGRAM_ID, encode("pool", pool)),
  );
  accounts.set(
    position.toBase58(),
    info(CP_AMM_PROGRAM_ID, encode("position", p)),
  );
  accounts.set(
    nftAccount.toBase58(),
    info(TOKEN_2022_PROGRAM_ID, token(nft, wallet.publicKey)),
  );
  const mintData = Buffer.alloc(MintLayout.span);
  MintLayout.encode(
    {
      mintAuthorityOption: 0,
      mintAuthority: PublicKey.default,
      supply: 1n,
      decimals: 0,
      isInitialized: true,
      freezeAuthorityOption: 0,
      freezeAuthority: PublicKey.default,
    },
    mintData,
  );
  accounts.set(nft.toBase58(), info(TOKEN_2022_PROGRAM_ID, mintData));
  for (const [vault, mint] of [
    [pool.tokenAVault, pool.tokenAMint],
    [pool.tokenBVault, pool.tokenBMint],
  ])
    accounts.set(
      vault.toBase58(),
      info(TOKEN_PROGRAM_ID, token(mint, derivePoolAuthority(), 1000000000n)),
    );
  vi.spyOn(c, "getGenesisHash").mockResolvedValue(
    "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  );
  vi.spyOn(c, "getAccountInfo").mockImplementation(
    async (key) => accounts.get(key.toBase58()) ?? null,
  );
  vi.spyOn(c, "getMultipleAccountsInfo").mockImplementation(async (keys) =>
    keys.map((key) => accounts.get(key.toBase58()) ?? null),
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
  const discover = vi
    .spyOn(CpAmm.prototype, "getUserPositionByPool")
    .mockResolvedValue([
      { position, positionNftAccount: nftAccount, positionState: p },
    ]);
  const simulation = vi.spyOn(c, "simulateTransaction").mockResolvedValue({
    context: { slot: 1 },
    value: { err: null, logs: [], unitsConsumed: 120000 },
  });
  const send = vi
    .spyOn(c, "sendRawTransaction")
    .mockRejectedValue(Error("No real sends"));
  vi.spyOn(c, "getSignatureStatuses").mockResolvedValue({
    context: { slot: 1 },
    value: [
      { slot: 1, confirmations: 1, err: null, confirmationStatus: "confirmed" },
    ],
  });
  const getTx = vi.spyOn(c, "getTransaction").mockResolvedValue(null);
  const sign = vi.fn(async (tx: Transaction) => {
    const canonical = Transaction.from(
      tx.serialize({ requireAllSignatures: false, verifySignatures: false }),
    );
    canonical.partialSign(wallet);
    return canonical;
  });
  return {
    c,
    wallet,
    nft,
    nftAccount,
    position,
    s,
    accounts,
    p,
    pool,
    destination,
    discover,
    simulation,
    send,
    getTx,
    sign,
    dbcPool: dbcAddress,
  };
}
it("resolves migration and independently verifies discovered NFT-owned positions and locked/vesting fee accounting", async () => {
  const x = await setup(),
    view = await readDammPositions(
      x.c,
      "devnet",
      x.dbcPool,
      x.wallet.publicKey,
    );
  expect(x.discover).toHaveBeenCalledWith(x.destination, x.wallet.publicKey);
  expect(view.positions[0]).toMatchObject({
    a: 13n,
    b: 11n,
    unlocked: "1",
    vested: "2",
    locked: "3",
  });
  expect(getUnClaimLpFee(x.pool, x.p).feeTokenA.toString()).toBe("13");
  expect(x.send).not.toHaveBeenCalled();
});
it("rejects a foreign NFT owner, wrong position pool, invalid NFT supply, and program-owned fee positions", async () => {
  const x = await setup();
  x.accounts.get(x.nftAccount.toBase58())!.data = token(
    x.nft,
    Keypair.generate().publicKey,
  );
  await expect(
    readDammPositions(x.c, "devnet", x.dbcPool, x.wallet.publicKey),
  ).rejects.toThrow("own the position NFT");
  x.accounts.get(x.nftAccount.toBase58())!.data = token(
    x.nft,
    x.wallet.publicKey,
  );
  x.p.pool = Keypair.generate().publicKey;
  x.accounts.get(x.position.toBase58())!.data = encode("position", x.p);
  await expect(
    readDammPositions(x.c, "devnet", x.dbcPool, x.wallet.publicKey),
  ).rejects.toThrow("pool or NFT PDA");
  x.p.pool = x.destination;
  x.accounts.get(x.position.toBase58())!.data = encode("position", x.p);
  x.accounts.get(x.nft.toBase58())!.data.writeBigUInt64LE(2n, 36);
  await expect(
    readDammPositions(x.c, "devnet", x.dbcPool, x.wallet.publicKey),
  ).rejects.toThrow("Invalid position NFT");
});
it("constructs the actual pinned SDK claim with protected destinations, RPC rent and unsigned simulation", async () => {
  const x = await setup(),
    plan = await prepareDammClaim(
      x.c,
      "devnet",
      x.dbcPool,
      x.position.toBase58(),
      x.wallet.publicKey,
    );
  expect(plan.claim.fee).toBe(5000n);
  expect(plan.claim.rent).toBe(4078560n);
  expect(plan.claim.tx.signatures.every((s) => !s.signature)).toBe(true);
  expect(x.simulation).toHaveBeenCalledWith(
    expect.any(VersionedTransaction),
    expect.objectContaining({ sigVerify: false }),
  );
  const ix = plan.claim.tx.instructions.find((i) =>
    i.programId.equals(CP_AMM_PROGRAM_ID),
  )!;
  expect(cpAmmCoder.instruction.decode(ix.data)?.name).toBe(
    "claim_position_fee",
  );
  ix.keys[3].pubkey = Keypair.generate().publicKey;
  expect(() =>
    protectDammInstructions(
      plan.claim.tx,
      plan.view,
      plan.position,
      x.wallet.publicKey,
    ),
  ).toThrow("recipients changed");
  expect(x.send).not.toHaveBeenCalled();
});
it("signs canonical Phantom legacy serialization, verifies signed simulation, journals before send and confirms exact message", async () => {
  const x = await setup(),
    plan = await prepareDammClaim(
      x.c,
      "devnet",
      x.dbcPool,
      x.position.toBase58(),
      x.wallet.publicKey,
    );
  x.send.mockImplementation(async (bytes) => {
    expect(
      dammRecord(x.s, "devnet", x.wallet.publicKey.toBase58())?.state,
    ).toBe("pending");
    const signed = Transaction.from(Buffer.from(bytes));
    expect(signed.verifySignatures()).toBe(true);
    x.getTx.mockResolvedValue({
      slot: 1,
      blockTime: null,
      meta: { err: null, fee: 5000 },
      transaction: { message: signed.compileMessage(), signatures: [] },
    } as never);
    return dammRecord(x.s, "devnet", x.wallet.publicKey.toBase58())!.signature;
  });
  const result = await executeDammClaim(
    x.c,
    plan,
    x.wallet.publicKey,
    x.sign,
    x.s,
  );
  expect(result.record.state).toBe("confirmed");
  expect(result.record.actualFee).toBe("5000");
  expect(x.simulation).toHaveBeenCalledWith(
    expect.any(VersionedTransaction),
    expect.objectContaining({ sigVerify: true }),
  );
  expect(
    x.s.data.has(
      `dbc-creator-claim-v1:devnet:${x.wallet.publicKey.toBase58()}`,
    ),
  ).toBe(false);
  expect(
    dammRecord(x.s, "mainnet-beta", x.wallet.publicKey.toBase58()),
  ).toBeUndefined();
  await expect(
    executeDammClaim(x.c, plan, x.wallet.publicKey, x.sign, x.s),
  ).rejects.toThrow("already recorded");
  expect(x.send).toHaveBeenCalledTimes(1);
});
it("retains ambiguous broadcast signatures and prevents retry; recovery checks status without sending", async () => {
  const x = await setup(),
    plan = await prepareDammClaim(
      x.c,
      "devnet",
      x.dbcPool,
      x.position.toBase58(),
      x.wallet.publicKey,
    );
  await expect(
    executeDammClaim(x.c, plan, x.wallet.publicKey, x.sign, x.s),
  ).rejects.toThrow("No real sends");
  const r = dammRecord(x.s, "devnet", x.wallet.publicKey.toBase58())!;
  expect(r.state).toBe("pending");
  await expect(
    executeDammClaim(x.c, plan, x.wallet.publicKey, x.sign, x.s),
  ).rejects.toThrow("pending");
  vi.mocked(x.c.getSignatureStatuses).mockResolvedValue({
    context: { slot: 1 },
    value: [null],
  });
  expect((await refreshDammClaim(x.c, x.s, r)).record.state).toBe("pending");
  vi.mocked(x.c.getBlockHeight).mockResolvedValue(101);
  expect((await refreshDammClaim(x.c, x.s, r)).record.state).toBe("expired");
  expect(x.send).toHaveBeenCalledTimes(1);
});
it("refuses modified wallet messages and retains their valid signature for inspection without broadcasting", async () => {
  const x = await setup(),
    plan = await prepareDammClaim(
      x.c,
      "devnet",
      x.dbcPool,
      x.position.toBase58(),
      x.wallet.publicKey,
    );
  const modified = async (tx: Transaction) => {
    tx.recentBlockhash = Keypair.generate().publicKey.toBase58();
    tx.partialSign(x.wallet);
    return tx;
  };
  await expect(
    executeDammClaim(x.c, plan, x.wallet.publicKey, modified, x.s),
  ).rejects.toThrow("CLAIM_MESSAGE_CHANGED");
  expect(
    dammRecord(x.s, "devnet", x.wallet.publicKey.toBase58())?.expiryKnown,
  ).toBe(false);
  expect(x.send).not.toHaveBeenCalled();
});
it("fails closed for simulation errors, unavailable fees, expired blocks and incorrect network before signing", async () => {
  const x = await setup();
  x.simulation.mockResolvedValueOnce({
    context: { slot: 1 },
    value: { err: { InstructionError: [0, "failed"] }, logs: [] },
  });
  await expect(
    prepareDammClaim(
      x.c,
      "devnet",
      x.dbcPool,
      x.position.toBase58(),
      x.wallet.publicKey,
    ),
  ).rejects.toThrow("simulation failed");
  vi.mocked(x.c.getFeeForMessage).mockResolvedValueOnce({
    context: { slot: 1 },
    value: null,
  });
  await expect(
    prepareDammClaim(
      x.c,
      "devnet",
      x.dbcPool,
      x.position.toBase58(),
      x.wallet.publicKey,
    ),
  ).rejects.toThrow("fee unavailable");
  const plan = await prepareDammClaim(
    x.c,
    "devnet",
    x.dbcPool,
    x.position.toBase58(),
    x.wallet.publicKey,
  );
  vi.mocked(x.c.getBlockHeight).mockResolvedValue(101);
  await expect(
    executeDammClaim(x.c, plan, x.wallet.publicKey, x.sign, x.s),
  ).rejects.toThrow("expired");
  await expect(
    readDammPositions(x.c, "mainnet-beta", x.dbcPool, x.wallet.publicKey),
  ).rejects.toThrow();
  expect(x.sign).not.toHaveBeenCalled();
  expect(x.send).not.toHaveBeenCalled();
});
it("rejects invalid and missing Phantom signatures before any broadcast", async () => {
  const x = await setup(),
    plan = await prepareDammClaim(
      x.c,
      "devnet",
      x.dbcPool,
      x.position.toBase58(),
      x.wallet.publicKey,
    );
  await expect(
    executeDammClaim(x.c, plan, x.wallet.publicKey, async (tx) => tx, x.s),
  ).rejects.toThrow("SIGNATURE_MISSING");
  await expect(
    executeDammClaim(
      x.c,
      plan,
      x.wallet.publicKey,
      async (tx) => {
        tx.signatures[0].signature = Buffer.alloc(64, 1);
        return tx;
      },
      x.s,
    ),
  ).rejects.toThrow("SIGNATURE_INVALID");
  expect(x.send).not.toHaveBeenCalled();
});

it("does not prepare zero-fee positions and marks unsupported token modes read-only", async () => {
  const x = await setup();
  x.p.feeAPending = new BN(0);
  x.p.feeBPending = new BN(0);
  x.pool.feeAPerLiquidity = Array(32).fill(0);
  x.accounts.get(x.position.toBase58())!.data = encode("position", x.p);
  x.accounts.get(x.destination.toBase58())!.data = encode("pool", x.pool);
  const view = await readDammPositions(
    x.c,
    "devnet",
    x.dbcPool,
    x.wallet.publicKey,
  );
  expect(view.positions[0]).toMatchObject({ a: 0n, b: 0n });
  await expect(
    prepareDammClaim(
      x.c,
      "devnet",
      x.dbcPool,
      x.position.toBase58(),
      x.wallet.publicKey,
    ),
  ).rejects.toThrow("No DAMM position fees");
  x.pool.collectFeeMode = 2;
  x.accounts.get(x.destination.toBase58())!.data = encode("pool", x.pool);
  expect(
    (await readDammPositions(x.c, "devnet", x.dbcPool, x.wallet.publicKey))
      .supported,
  ).toBe(false);
});
it("rejects delegated NFTs and vault redirection, rather than inventing an entitlement", async () => {
  const x = await setup();
  const account = x.accounts.get(x.nftAccount.toBase58())!;
  account.data.writeUInt32LE(1, 72);
  await expect(
    readDammPositions(x.c, "devnet", x.dbcPool, x.wallet.publicKey),
  ).rejects.toThrow("delegated claims unsupported");
  account.data = token(x.nft, x.wallet.publicKey);
  x.accounts.get(x.pool.tokenAVault.toBase58())!.data = token(
    x.pool.tokenAMint,
    x.wallet.publicKey,
  );
  await expect(
    readDammPositions(x.c, "devnet", x.dbcPool, x.wallet.publicKey),
  ).rejects.toThrow("vault authority");
});
it("requires confirmed transaction data to match the reviewed message and does not trust a status label alone", async () => {
  const x = await setup(),
    plan = await prepareDammClaim(
      x.c,
      "devnet",
      x.dbcPool,
      x.position.toBase58(),
      x.wallet.publicKey,
    );
  await expect(
    executeDammClaim(x.c, plan, x.wallet.publicKey, x.sign, x.s),
  ).rejects.toThrow("No real sends");
  const r = dammRecord(x.s, "devnet", x.wallet.publicKey.toBase58())!;
  await expect(refreshDammClaim(x.c, x.s, r)).rejects.toThrow(
    "transaction data unavailable",
  );
  const changed = Transaction.from(
    plan.claim.tx.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    }),
  );
  changed.recentBlockhash = Keypair.generate().publicKey.toBase58();
  x.getTx.mockResolvedValue({
    slot: 1,
    meta: { err: null, fee: 5000 },
    transaction: { message: changed.compileMessage(), signatures: [] },
  } as never);
  await expect(refreshDammClaim(x.c, x.s, r)).rejects.toThrow(
    "message differs",
  );
  const recorded = dammRecord(x.s, "devnet", x.wallet.publicKey.toBase58())!;
  const signed = await x.sign.mock.results[0].value;
  expect(recorded.state).toBe("pending");
  expect(recorded.signature).toBe(bs58.encode(signed.signature!));
  const restored = storage();
  for (const [key, value] of x.s.data) restored.setItem(key, value);
  expect(dammRecord(restored, "devnet", x.wallet.publicKey.toBase58())).toEqual(
    recorded,
  );
  await expect(
    executeDammClaim(x.c, plan, x.wallet.publicKey, x.sign, restored),
  ).rejects.toThrow("pending");
  expect(x.send).toHaveBeenCalledTimes(1);
});
it("accepts a VersionedTransaction wrapper when its legacy wire message and signature are unchanged", async () => {
  const x = await setup(),
    plan = await prepareDammClaim(
      x.c,
      "devnet",
      x.dbcPool,
      x.position.toBase58(),
      x.wallet.publicKey,
    );
  await expect(
    executeDammClaim(
      x.c,
      plan,
      x.wallet.publicKey,
      async (tx) => {
        // The installed SDK builds legacy transactions; a wallet may not replace the format.
        const v = new VersionedTransaction(tx.compileMessage());
        v.sign([x.wallet]);
        return v as unknown as Transaction;
      },
      x.s,
    ),
  ).rejects.toThrow("No real sends");
  expect(x.send).toHaveBeenCalledTimes(1);
});

it("rejects an unreviewed v0 message rather than converting or accepting a different transaction format", async () => {
  const x = await setup(),
    plan = await prepareDammClaim(
      x.c,
      "devnet",
      x.dbcPool,
      x.position.toBase58(),
      x.wallet.publicKey,
    );
  await expect(
    executeDammClaim(
      x.c,
      plan,
      x.wallet.publicKey,
      async (tx) => {
        const message = new TransactionMessage({
          payerKey: x.wallet.publicKey,
          recentBlockhash: tx.recentBlockhash!,
          instructions: tx.instructions,
        }).compileToV0Message();
        const v = new VersionedTransaction(message);
        v.sign([x.wallet]);
        return v as unknown as Transaction;
      },
      x.s,
    ),
  ).rejects.toThrow();
  expect(x.send).not.toHaveBeenCalled();
});
it("persists a signed public signature when signed simulation fails and never submits it", async () => {
  const x = await setup(),
    plan = await prepareDammClaim(
      x.c,
      "devnet",
      x.dbcPool,
      x.position.toBase58(),
      x.wallet.publicKey,
    );
  x.simulation.mockImplementation(async (_tx, config) => ({
    context: { slot: 1 },
    value: {
      err:
        config && "sigVerify" in config && config.sigVerify
          ? { InstructionError: [0, "failed"] }
          : null,
      logs: [],
    },
  }));
  await expect(
    executeDammClaim(x.c, plan, x.wallet.publicKey, x.sign, x.s),
  ).rejects.toThrow("Signed simulation failed");
  const recorded = dammRecord(x.s, "devnet", x.wallet.publicKey.toBase58())!;
  const signed = await x.sign.mock.results[0].value;
  expect(recorded.state).toBe("pending");
  expect(recorded.signature).toBe(bs58.encode(signed.signature!));
  const restored = storage();
  for (const [key, value] of x.s.data) restored.setItem(key, value);
  expect(dammRecord(restored, "devnet", x.wallet.publicKey.toBase58())).toEqual(
    recorded,
  );
  await expect(
    executeDammClaim(x.c, plan, x.wallet.publicKey, x.sign, restored),
  ).rejects.toThrow("pending");
  expect(x.send).not.toHaveBeenCalled();
});
it("quotes pool accumulators and position checkpoints from a single RPC bank rather than mixed reads", async () => {
  const x = await setup();
  const original = vi.mocked(x.c.getAccountInfo).getMockImplementation()!;
  const stale = { ...x.pool, feeAPerLiquidity: Array(32).fill(0) };
  vi.mocked(x.c.getAccountInfo).mockImplementation(async (key, ...args) =>
    key.equals(x.destination)
      ? {
          ...x.accounts.get(x.destination.toBase58())!,
          data: encode("pool", stale),
        }
      : original(key, ...args),
  );
  const view = await readDammPositions(
    x.c,
    "devnet",
    x.dbcPool,
    x.wallet.publicKey,
  );
  expect(view.positions[0].a).toBe(13n);
  expect(x.c.getMultipleAccountsInfo).toHaveBeenCalledWith(
    [x.destination, x.position],
    "confirmed",
  );
});
it("supports BothToken and OnlyB claims without changing the protected instruction destinations", async () => {
  for (const mode of [0, 1]) {
    const x = await setup();
    x.pool.collectFeeMode = mode;
    if (mode === 1) {
      x.pool.feeAPerLiquidity = Array(32).fill(0);
      x.p.feeAPending = new BN(0);
      x.accounts.get(x.position.toBase58())!.data = encode("position", x.p);
    }
    x.accounts.get(x.destination.toBase58())!.data = encode("pool", x.pool);
    const plan = await prepareDammClaim(
      x.c,
      "devnet",
      x.dbcPool,
      x.position.toBase58(),
      x.wallet.publicKey,
    );
    expect(plan.view.supported).toBe(true);
    expect(plan.position.b).toBe(11n);
    protectDammInstructions(
      plan.claim.tx,
      plan.view,
      plan.position,
      x.wallet.publicKey,
    );
    expect(x.send).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  }
});
it("blocks a claim when SDK discovery finds no position owned by the connected wallet", async () => {
  const x = await setup();
  x.discover.mockResolvedValue([]);
  expect(
    (await readDammPositions(x.c, "devnet", x.dbcPool, x.wallet.publicKey))
      .positions,
  ).toEqual([]);
  await expect(
    prepareDammClaim(
      x.c,
      "devnet",
      x.dbcPool,
      x.position.toBase58(),
      x.wallet.publicKey,
    ),
  ).rejects.toThrow("No supported, wallet-owned DAMM position");
  expect(x.sign).not.toHaveBeenCalled();
  expect(x.send).not.toHaveBeenCalled();
});

it.each([0, 1])(
  "HYPE DAMM positions retain NFT ownership and exact HYPE destinations in claim mode %s (synthetic migration)",
  async (mode) => {
    const x = await setup(true);
    x.pool.collectFeeMode = mode;
    x.accounts.get(x.destination.toBase58())!.data = encode("pool", x.pool);
    const view = await readDammPositions(
      x.c,
      "devnet",
      x.dbcPool,
      x.wallet.publicKey,
    );
    expect(view.supported).toBe(true);
    expect(view.pool.tokenBMint.equals(HYPE_MINT)).toBe(true);
    expect(view.positions).toHaveLength(1);
    const plan = await prepareDammClaim(
      x.c,
      "devnet",
      x.dbcPool,
      x.position.toBase58(),
      x.wallet.publicKey,
    );
    expect(plan.claim.destinations[1]).toBe(
      getAssociatedTokenAddressSync(HYPE_MINT, x.wallet.publicKey).toBase58(),
    );
    expect(plan.existingWsol).toBe(0n);
    await expect(
      prepareDammClaim(
        x.c,
        "devnet",
        x.dbcPool,
        x.position.toBase58(),
        Keypair.generate().publicKey,
      ),
    ).rejects.toThrow("does not exclusively own");
    expect(
      plan.claim.tx.instructions
        .flatMap((i) => i.keys)
        .some((k) => k.pubkey.equals(NATIVE_MINT)),
    ).toBe(false);
    expect(x.send).not.toHaveBeenCalled();
  },
);
