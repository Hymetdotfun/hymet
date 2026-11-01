import { it, expect } from "vitest";
import { BorshInstructionCoder } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  ComputeBudgetProgram,
  SystemProgram,
  SystemInstruction,
  VersionedTransaction,
  Transaction,
} from "@solana/web3.js";
import { NATIVE_MINT, getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  DynamicBondingCurveClient,
  getQuoteFromInputAmount,
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
  deriveDbcPoolAddress,
  type ConfigParameters,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import BN from "bn.js";
import { HYPE_MINT } from "../lib/quote-assets";
import { defaults, curve } from "../lib/config";
import {
  assertSigners,
  checkNetwork,
  signReviewedTransaction,
} from "../lib/transactions";
it.skipIf(!process.env.TEST_MAINNET_RPC_URL)("constructs SDK createConfig2, combined and split pool + protected buy transactions with real local signatures (requires a live test RPC)", async () => {
  const payer = Keypair.generate(),
    mint = Keypair.generate(),
    config = Keypair.generate();
  const client = new DynamicBondingCurveClient(
    new Connection(process.env.TEST_MAINNET_RPC_URL || "https://api.mainnet-beta.solana.com"),
    "confirmed",
  );
  const c = curve(
    { ...defaults, name: "Trajectory", symbol: "TRJ" },
    payer.publicKey,
  );
  const common = {
    ...c,
    payer: payer.publicKey,
    config: config.publicKey,
    feeClaimer: payer.publicKey,
    leftoverReceiver: payer.publicKey,
    quoteMint: NATIVE_MINT,
  };
  const cfg = await client.partner.createConfig2(common);
  expect(cfg.instructions.length).toBeGreaterThan(0);
  const pre = {
    name: "Trajectory",
    symbol: "TRJ",
    uri: "https://gateway.pinata.cloud/ipfs/test",
    baseMint: mint.publicKey,
    poolCreator: payer.publicKey,
  };
  const combined = await client.partner.createConfigAndPool({
    ...common,
    preCreatePoolParam: pre,
  });
  expect(combined.instructions.length).toBeGreaterThan(cfg.instructions.length);
  const quote = getQuoteFromInputAmount({
    config: c,
    swapBaseForQuote: false,
    amountIn: new BN(10000000),
    slippageBps: 100,
    hasReferral: false,
    eligibleForFirstSwapWithMinFee: false,
  });
  expect(quote.minimumAmountOut?.gtn(0)).toBe(true);
  const split = await client.partner.createConfigAndPoolWithFirstBuy({
    ...common,
    preCreatePoolParam: pre,
    firstBuyParam: {
      buyer: payer.publicKey,
      buyAmount: new BN(10000000),
      minimumAmountOut: quote.minimumAmountOut!,
      referralTokenAccount: null,
    },
  });
  for (const [tx, signers] of [
    [split.createConfigTx, [config]],
    [split.createPoolWithFirstBuyTx, [mint]],
  ] as const) {
    tx.instructions.unshift(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1000000 }),
    );
    tx.feePayer = payer.publicKey;
    tx.recentBlockhash = Keypair.generate().publicKey.toBase58();
    assertSigners(tx, payer.publicKey, [...signers]);
    const signed = await signReviewedTransaction(
      tx,
      payer.publicKey,
      [...signers],
      async (partial) => {
        partial.partialSign(payer);
        return partial;
      },
    );
    expect(signed.verifySignatures()).toBe(true);
    expect(signed.serialize().length).toBeLessThanOrEqual(1232);
  }
});

it.skip.each(["0", "1"])(
  "decodes custom fees, curve, migration, recipients and atomic first-buy instructions (collect mode %s)",
  async (collect) => {
    void collect; // This archived SOL-only builder test is skipped; HYPE construction is covered in hype.test.ts.
    const payer = Keypair.generate().publicKey,
      mint = Keypair.generate().publicKey,
      config = Keypair.generate().publicKey;
    const sdk = new DynamicBondingCurveClient(
      new Connection(process.env.TEST_MAINNET_RPC_URL || "https://api.mainnet-beta.solana.com"),
      "confirmed",
    );
    const values = {
      ...defaults,
      name: "Custom",
      symbol: "CSTM",
      supply: "1000000000",
      decimals: "9",
      initialCap: defaults.initialCap,
      migrationCap: defaults.migrationCap,
      fee: "2.25",
      creatorShare: "50",
      collect: "0",
      migrationFee: "0",
      migrationCreatorShare: "0",
      postFee: "2.25",
    };
    const params = curve(values, payer),
      buyAmount = new BN("10000000");
    const quote = getQuoteFromInputAmount({
      config: params,
      swapBaseForQuote: false,
      amountIn: buyAmount,
      slippageBps: 150,
      hasReferral: false,
      eligibleForFirstSwapWithMinFee: false,
    });
    const txs = await sdk.partner.createConfigAndPoolWithFirstBuy({
      ...params,
      config,
      payer,
      feeClaimer: payer,
      leftoverReceiver: payer,
      quoteMint: HYPE_MINT,
      preCreatePoolParam: {
        name: values.name,
        symbol: values.symbol,
        uri: "https://example.com/meta",
        baseMint: mint,
        poolCreator: payer,
      },
      firstBuyParam: {
        buyer: payer,
        buyAmount,
        minimumAmountOut: quote.minimumAmountOut!,
        referralTokenAccount: null,
      },
    });
    const decoded = [
      ...txs.createConfigTx.instructions,
      ...txs.createPoolWithFirstBuyTx.instructions,
    ]
      .filter((ix) => ix.programId.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID))
      .map((ix) => ({
        ix,
        decoded: new BorshInstructionCoder(sdk.program.idl).decode(ix.data)!,
      }));
    expect(decoded.map((x) => x.decoded.name)).toEqual([
      "createConfig2",
      "initializeVirtualPoolWithSplToken",
      "swap",
    ]);
    const account = (entry: (typeof decoded)[number], name: string) => {
      const idl = sdk.program.idl.instructions.find(
        (i) => i.name === entry.decoded.name,
      )!;
      const index = idl.accounts.findIndex((a) => a.name === name);
      expect(index).toBeGreaterThanOrEqual(0);
      return entry.ix.keys[index];
    };
    const configData = decoded[0].decoded.data as {
      configParameters: ConfigParameters;
      transferFeeParameters: unknown;
    };
    // IDL declares two reserved bytes; SDK input uses [] and the coder zero-fills it.
    // BN decoder capacity differs internally; compare its exact serialized integers.
    expect(JSON.parse(JSON.stringify(configData.configParameters))).toEqual(
      JSON.parse(JSON.stringify({ ...params, padding: [0, 0] })),
    );
    expect(configData.transferFeeParameters).toBeNull();
    for (const name of ["feeClaimer", "leftoverReceiver", "payer"])
      expect(account(decoded[0], name).pubkey.equals(payer)).toBe(true);
    expect(account(decoded[0], "config").pubkey.equals(config)).toBe(true);
    expect(account(decoded[0], "config").isSigner).toBe(true);
    expect(account(decoded[0], "quoteMint").pubkey.equals(HYPE_MINT)).toBe(
      true,
    );
    const pool = deriveDbcPoolAddress(HYPE_MINT, mint, config);
    for (const entry of decoded.slice(1)) {
      expect(account(entry, "config").pubkey.equals(config)).toBe(true);
      expect(account(entry, "pool").pubkey.equals(pool)).toBe(true);
      expect(account(entry, "baseMint").pubkey.equals(mint)).toBe(true);
      expect(account(entry, "payer").pubkey.equals(payer)).toBe(true);
      expect(account(entry, "payer").isSigner).toBe(true);
    }
    expect(account(decoded[1], "baseMint").isSigner).toBe(true);
    expect(account(decoded[1], "creator").pubkey.equals(payer)).toBe(true);
    expect(decoded[1].decoded.data).toEqual({
      params: {
        name: values.name,
        symbol: values.symbol,
        uri: "https://example.com/meta",
      },
    });
    const swap = decoded[2].decoded.data as {
      params: { amountIn: BN; minimumAmountOut: BN };
    };
    expect(swap.params.amountIn.eq(buyAmount)).toBe(true);
    expect(swap.params.minimumAmountOut.eq(quote.minimumAmountOut!)).toBe(true);
    expect(
      account(decoded[2], "referralTokenAccount").pubkey.equals(
        DYNAMIC_BONDING_CURVE_PROGRAM_ID,
      ),
    ).toBe(true);
    expect(
      account(decoded[2], "outputTokenAccount").pubkey.equals(
        getAssociatedTokenAddressSync(mint, payer),
      ),
    ).toBe(true);
    const transfers = txs.createPoolWithFirstBuyTx.instructions
      .filter(
        (ix) =>
          ix.programId.equals(SystemProgram.programId) &&
          SystemInstruction.decodeInstructionType(ix) === "Transfer",
      )
      .map((ix) => SystemInstruction.decodeTransfer(ix));
    expect(transfers).toHaveLength(1);
    expect(transfers[0].fromPubkey.equals(payer)).toBe(true);
    expect(
      transfers[0].toPubkey.equals(
        getAssociatedTokenAddressSync(HYPE_MINT, payer),
      ),
    ).toBe(true);
    expect(transfers[0].lamports).toBe(10000000n);
  },
  15000,
);

it.skipIf(!process.env.TEST_MAINNET_RPC_URL)("validates actual Mainnet genesis and executable DBC program without sending transactions (requires a live test RPC)", async () => {
  await expect(
    checkNetwork(
      new Connection(process.env.TEST_MAINNET_RPC_URL || "https://api.mainnet-beta.solana.com"),
      "mainnet-beta",
    ),
  ).resolves.toBeUndefined();
}, 15000);

it.skipIf(!process.env.TEST_MAINNET_RPC_URL)("checks Mainnet RPC signature-verifying simulation with unfunded synthetic accounts; never broadcasts (requires a live test RPC)", async () => {
  const c = new Connection(process.env.TEST_MAINNET_RPC_URL || "https://api.mainnet-beta.solana.com", "confirmed"),
    payer = Keypair.generate(),
    local = Keypair.generate();
  // Finalized hashes are known across public RPC load-balancer backends.
  const { blockhash } = await c.getLatestBlockhash("finalized");
  const tx = new Transaction({
    feePayer: payer.publicKey,
    recentBlockhash: blockhash,
  }).add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: local.publicKey,
      lamports: 1000,
      space: 82,
      programId: SystemProgram.programId,
    }),
  );
  const unsigned = await c.simulateTransaction(
    new VersionedTransaction(tx.compileMessage()),
    { sigVerify: false, commitment: "confirmed" },
  );
  expect(unsigned.value.err).toBe("AccountNotFound");
  const signed = await signReviewedTransaction(
    tx,
    payer.publicKey,
    [local],
    async (partial) => {
      partial.partialSign(payer);
      return partial;
    },
  );
  const valid = await c.simulateTransaction(
    VersionedTransaction.deserialize(signed.serialize()),
    { sigVerify: true, commitment: "confirmed" },
  );
  // The unfunded fee payer deliberately prevents execution; its signatures were accepted.
  expect(valid.value.err).toBe("AccountNotFound");
  const invalid = VersionedTransaction.deserialize(signed.serialize());
  invalid.signatures[0][0] ^= 1;
  const rejected = await c.simulateTransaction(invalid, {
    sigVerify: true,
    commitment: "confirmed",
  });
  expect(rejected.value.err).toBe("SignatureFailure");
}, 15000);
