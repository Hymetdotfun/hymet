import { Buffer } from "buffer";
import {
  PublicKey,
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
  type Connection,
  type AccountInfo,
} from "@solana/web3.js";
import {
  CpAmm,
  CP_AMM_PROGRAM_ID,
  CpAmmIdl,
  derivePositionAddress,
  derivePoolAuthority,
  deriveTokenVaultAddress,
  getUnClaimLpFee,
  type PoolState,
  type PositionState,
} from "@meteora-ag/cp-amm-sdk";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  ACCOUNT_SIZE,
  unpackAccount,
  unpackMint,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
} from "@solana/spl-token";
import {
  readCreatorFees,
  signCreatorClaim,
  claimRecord,
  saveClaim,
  assertNoPendingClaim,
  type ClaimPlan,
  type ClaimRecord,
  type FeeView,
} from "./creator-fees";
import {
  checkNetwork,
  assertSigners,
  simulateReviewedTransaction,
  pollConfirmation,
  type Network,
  estimateMessageFee,
  WALLET_PRIORITY_MICROLAMPORTS,
} from "./transactions";
import { verifyWalletMessage } from "./wallet-guards";
import { assertMainnetTransactionsEnabled } from "./app-network";
type Store = Pick<Storage, "getItem" | "setItem">;
export type DammPosition = {
  position: string;
  nft: string;
  nftAccount: string;
  a: bigint;
  b: bigint;
  unlocked: string;
  vested: string;
  locked: string;
};
export type DammView = {
  dbc: FeeView;
  pool: PoolState;
  positions: DammPosition[];
  decimals: number[];
  supported: boolean;
};
const amount = (n: number) => {
  if (!Number.isSafeInteger(n) || n < 0) throw Error("Invalid RPC amount");
  return BigInt(n);
};
async function owned(c: Connection, address: PublicKey) {
  const a = await c.getAccountInfo(address, "confirmed");
  if (!a?.owner.equals(CP_AMM_PROGRAM_ID) || a.executable)
    throw Error("DAMM account owner mismatch or account missing");
  return a;
}
export async function verifyPosition(
  c: Connection,
  pool: PublicKey,
  position: PublicKey,
  nftAccount: PublicKey,
  wallet: PublicKey,
  snapshot?: AccountInfo<Buffer>,
): Promise<PositionState> {
  const account = snapshot || (await owned(c, position));
  if (!account.owner.equals(CP_AMM_PROGRAM_ID) || account.executable)
    throw Error("Position account owner mismatch");
  const state = new CpAmm(c)._program.coder.accounts.decode<PositionState>(
    "position",
    account.data,
  );
  if (
    !state.pool.equals(pool) ||
    !derivePositionAddress(state.nftMint).equals(position)
  )
    throw Error("Position pool or NFT PDA mismatch");
  const info = await c.getAccountInfo(nftAccount, "confirmed");
  if (
    !info ||
    ![TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].some((p) => p.equals(info.owner))
  )
    throw Error("Position NFT account missing or unsupported");
  const token = unpackAccount(nftAccount, info, info.owner);
  if (
    !token.owner.equals(wallet) ||
    !token.mint.equals(state.nftMint) ||
    token.amount !== 1n ||
    !token.isInitialized ||
    token.isFrozen ||
    token.delegate
  )
    throw Error(
      "Connected wallet does not exclusively own the position NFT; delegated claims unsupported",
    );
  const mintInfo = await c.getAccountInfo(state.nftMint, "confirmed");
  if (!mintInfo || !mintInfo.owner.equals(info.owner))
    throw Error("Position NFT mint program mismatch");
  const mint = unpackMint(state.nftMint, mintInfo, info.owner);
  if (mint.decimals !== 0 || mint.supply !== 1n || !mint.isInitialized)
    throw Error("Invalid position NFT mint");
  return state;
}
export async function readDammPositions(
  c: Connection,
  network: Network,
  dbcAddress: string,
  wallet: PublicKey,
): Promise<DammView> {
  const dbc = await readCreatorFees(c, network, dbcAddress);
  if (dbc.migration.venue !== "DAMM V2" || !dbc.migration.destination)
    throw Error("DBC migration destination is not verified");
  const address = new PublicKey(dbc.migration.destination);
  let pool = new CpAmm(c)._program.coder.accounts.decode<PoolState>(
    "pool",
    (await owned(c, address)).data,
  );
  if (
    !pool.tokenAMint.equals(new PublicKey(dbc.mint)) ||
    !pool.tokenBMint.equals(new PublicKey(dbc.quoteMint))
  )
    throw Error("DAMM mint pair mismatch");
  const mints = await c.getMultipleAccountsInfo(
    [pool.tokenAMint, pool.tokenBMint],
    "confirmed",
  );
  const supported =
    pool.tokenAFlag === 0 &&
    pool.tokenBFlag === 0 &&
    [0, 1].includes(pool.collectFeeMode) &&
    mints.every((a) => a?.owner.equals(TOKEN_PROGRAM_ID));
  const decimals = mints.map((info, i) => {
    if (!info) throw Error("DAMM token mint missing");
    return unpackMint(
      i === 0 ? pool.tokenAMint : pool.tokenBMint,
      info,
      info.owner,
    ).decimals;
  });
  if (supported) {
    const vaults = [pool.tokenAVault, pool.tokenBVault];
    const mintKeys = [pool.tokenAMint, pool.tokenBMint];
    const infos = await c.getMultipleAccountsInfo(vaults, "confirmed");
    for (let i = 0; i < vaults.length; i++) {
      if (
        !deriveTokenVaultAddress(mintKeys[i], address).equals(vaults[i]) ||
        !infos[i]
      )
        throw Error("DAMM token vault missing or PDA mismatch");
      const vault = unpackAccount(vaults[i], infos[i], TOKEN_PROGRAM_ID);
      if (
        !vault.owner.equals(derivePoolAuthority()) ||
        !vault.mint.equals(mintKeys[i])
      )
        throw Error("DAMM vault authority or mint mismatch");
    }
  }
  const discovered = await new CpAmm(c).getUserPositionByPool(address, wallet);
  if (discovered.length > 99)
    throw Error("More than 99 positions: atomic fee snapshot unavailable");
  // Pool accumulators and position checkpoints must come from one RPC bank.
  // Mixing independently fetched checkpoints can wrap U256 and inflate a quote.
  const snapshot = await c.getMultipleAccountsInfo(
    [address, ...discovered.map((p) => p.position)],
    "confirmed",
  );
  const poolAccount = snapshot[0];
  if (!poolAccount?.owner.equals(CP_AMM_PROGRAM_ID) || poolAccount.executable)
    throw Error("DAMM snapshot pool missing or owner mismatch");
  const currentPool = new CpAmm(c)._program.coder.accounts.decode<PoolState>(
    "pool",
    poolAccount.data,
  );
  if (
    !(
      ["tokenAMint", "tokenBMint", "tokenAVault", "tokenBVault"] as const
    ).every((k) => currentPool[k].equals(pool[k])) ||
    currentPool.collectFeeMode !== pool.collectFeeMode ||
    currentPool.tokenAFlag !== pool.tokenAFlag ||
    currentPool.tokenBFlag !== pool.tokenBFlag
  )
    throw Error("DAMM pool changed during snapshot");
  pool = currentPool;
  const positions: DammPosition[] = [];
  for (const [i, candidate] of discovered.entries()) {
    if (!snapshot[i + 1])
      throw Error("Position missing from atomic fee snapshot");
    const p = await verifyPosition(
      c,
      address,
      candidate.position,
      candidate.positionNftAccount,
      wallet,
      snapshot[i + 1]!,
    );
    const fees = getUnClaimLpFee(pool, p);
    positions.push({
      position: candidate.position.toBase58(),
      nft: p.nftMint.toBase58(),
      nftAccount: candidate.positionNftAccount.toBase58(),
      a: BigInt(fees.feeTokenA.toString()),
      b: BigInt(fees.feeTokenB.toString()),
      unlocked: p.unlockedLiquidity.toString(),
      vested: p.vestedLiquidity.toString(),
      locked: p.permanentLockedLiquidity.toString(),
    });
  }
  return { dbc, pool, positions, decimals, supported };
}
export type DammRecord = ClaimRecord & { position: string; message: string };
// Reuse the proven wallet signature validator with a separate, network/wallet-scoped journal.
function journal(
  storage: Store,
  metadata?: Pick<DammRecord, "position" | "message">,
): Store {
  const key = (k: string) =>
    k.replace("dbc-creator-claim-v1:", "damm-v2-claim-v1:");
  return {
    getItem: (k) => storage.getItem(key(k)),
    setItem: (k, v) =>
      storage.setItem(
        key(k),
        JSON.stringify({ ...JSON.parse(v), ...metadata }),
      ),
  };
}
export function dammRecord(
  storage: Store,
  network: Network,
  wallet: string,
): DammRecord | undefined {
  const r = claimRecord(journal(storage), network, wallet) as
    DammRecord | undefined;
  if (r) {
    new PublicKey(r.position);
    if (typeof r.message !== "string" || !r.message)
      throw Error("Invalid DAMM review journal");
  }
  return r;
}
export type DammPlan = {
  view: DammView;
  position: DammPosition;
  claim: ClaimPlan;
  existingWsol: bigint;
  instructions: string[];
};
function sameInstruction(a: TransactionInstruction, b: TransactionInstruction) {
  return (
    a.programId.equals(b.programId) &&
    a.data.equals(b.data) &&
    a.keys.length === b.keys.length &&
    a.keys.every(
      (k, i) =>
        k.pubkey.equals(b.keys[i].pubkey) &&
        k.isSigner === b.keys[i].isSigner &&
        k.isWritable === b.keys[i].isWritable,
    )
  );
}
export function protectDammInstructions(
  tx: Transaction,
  view: DammView,
  position: DammPosition,
  wallet: PublicKey,
) {
  const p = view.pool,
    pool = new PublicKey(view.dbc.migration.destination!);
  const mints = [p.tokenAMint, p.tokenBMint],
    atas = mints.map((m) => getAssociatedTokenAddressSync(m, wallet));
  const [event] = PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")],
    CP_AMM_PROGRAM_ID,
  );
  const def = CpAmmIdl.instructions.find(
    (i) => i.name === "claim_position_fee",
  )!;
  const keys = [
    derivePoolAuthority(),
    pool,
    new PublicKey(position.position),
    ...atas,
    p.tokenAVault,
    p.tokenBVault,
    ...mints,
    new PublicKey(position.nftAccount),
    wallet,
    TOKEN_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    event,
    CP_AMM_PROGRAM_ID,
  ];
  const expected = new TransactionInstruction({
    programId: CP_AMM_PROGRAM_ID,
    data: Buffer.from(def.discriminator),
    keys: keys.map((pubkey, i) => ({
      pubkey,
      isSigner: "signer" in def.accounts[i] && def.accounts[i].signer === true,
      isWritable:
        "writable" in def.accounts[i] && def.accounts[i].writable === true,
    })),
  });
  let claims = 0,
    closed = 0;
  const budgets = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: WALLET_PRIORITY_MICROLAMPORTS }),
  ];
  for (const [i, ix] of tx.instructions.entries()) {
    if (i < 2) {
      if (!sameInstruction(ix, budgets[i]))
        throw Error("Unexpected DAMM compute budget");
      continue;
    }
    if (ix.programId.equals(CP_AMM_PROGRAM_ID)) {
      if (claims++ || closed || !sameInstruction(ix, expected))
        throw Error("DAMM claim instructions or fee recipients changed");
    } else if (ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) {
      if (
        claims ||
        !mints.some(
          (m, j) =>
            sameInstruction(
              ix,
              createAssociatedTokenAccountInstruction(
                wallet,
                atas[j],
                wallet,
                m,
              ),
            ) ||
            sameInstruction(
              ix,
              createAssociatedTokenAccountIdempotentInstruction(
                wallet,
                atas[j],
                wallet,
                m,
              ),
            ),
        )
      )
        throw Error("Unapproved DAMM destination account creation");
    } else if (ix.programId.equals(TOKEN_PROGRAM_ID)) {
      if (
        !claims ||
        closed++ ||
        !mints.some(
          (m, j) =>
            m.equals(NATIVE_MINT) &&
            sameInstruction(
              ix,
              createCloseAccountInstruction(atas[j], wallet, wallet),
            ),
        )
      )
        throw Error("Unapproved DAMM token account operation");
    } else throw Error("Unapproved DAMM program instruction");
  }
  if (claims !== 1) throw Error("Missing DAMM claim instruction");
  assertSigners(tx, wallet, []);
}
export async function prepareDammClaim(
  c: Connection,
  network: Network,
  dbcPool: string,
  positionAddress: string,
  wallet: PublicKey,
): Promise<DammPlan> {
  const view = await readDammPositions(c, network, dbcPool, wallet);
  const position = view.positions.find((p) => p.position === positionAddress);
  if (!view.supported || !position)
    throw Error("No supported, wallet-owned DAMM position");
  if (!position.a && !position.b) throw Error("No DAMM position fees to claim");
  const pool = view.pool;
  const destinations = [pool.tokenAMint, pool.tokenBMint].map((m) =>
    getAssociatedTokenAddressSync(m, wallet),
  );
  const infos = await c.getMultipleAccountsInfo(destinations, "confirmed");
  let existingWsol = 0n;
  for (let i = 0; i < infos.length; i++)
    if (infos[i]) {
      const a = unpackAccount(destinations[i], infos[i], TOKEN_PROGRAM_ID);
      const mint = i === 0 ? pool.tokenAMint : pool.tokenBMint;
      if (
        !a.owner.equals(wallet) ||
        !a.mint.equals(mint) ||
        a.isFrozen ||
        (a.closeAuthority && !a.closeAuthority.equals(wallet))
      )
        throw Error("DAMM destination owner/mint/close authority mismatch");
      if (mint.equals(NATIVE_MINT)) existingWsol = a.amount;
    }
  const tx = await new CpAmm(c).claimPositionFee2({
    owner: wallet,
    receiver: wallet,
    feePayer: wallet,
    pool: new PublicKey(view.dbc.migration.destination!),
    position: new PublicKey(position.position),
    positionNftAccount: new PublicKey(position.nftAccount),
    tokenAMint: pool.tokenAMint,
    tokenBMint: pool.tokenBMint,
    tokenAVault: pool.tokenAVault,
    tokenBVault: pool.tokenBVault,
    tokenAProgram: TOKEN_PROGRAM_ID,
    tokenBProgram: TOKEN_PROGRAM_ID,
  });
  tx.instructions.unshift(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: WALLET_PRIORITY_MICROLAMPORTS }),
  );
  const block = await c.getLatestBlockhash("confirmed");
  tx.feePayer = wallet;
  tx.recentBlockhash = block.blockhash;
  protectDammInstructions(tx, view, position, wallet);
  const estimate = await estimateMessageFee(c, tx);
  if (estimate === null) throw Error("DAMM transaction fee unavailable");
  const rent =
    BigInt(infos.filter((a) => !a).length) *
    amount(await c.getMinimumBalanceForRentExemption(ACCOUNT_SIZE));
  if (
    amount(await c.getBalance(wallet, "confirmed")) <
    rent + amount(estimate)
  )
    throw Error("Insufficient SOL for DAMM transaction fee and rent");
  await simulateReviewedTransaction(c, tx, false);
  return {
    view,
    position,
    existingWsol,
    instructions: tx.instructions.map(
      (ix) =>
        `${ix.programId.toBase58()} | ${ix.data.toString("hex")} | ${ix.keys.map((k) => `${k.pubkey.toBase58()}${k.isSigner ? " signer" : ""}${k.isWritable ? " writable" : ""}`).join(", ")}`,
    ),
    claim: {
      view: view.dbc,
      wallet: wallet.toBase58(),
      tx,
      message: Buffer.from(tx.serializeMessage()).toString("base64"),
      fee: amount(estimate),
      rent,
      destinations: destinations.map((p) => p.toBase58()),
      lastValidBlockHeight: block.lastValidBlockHeight,
      existingWrappedSol: existingWsol,
    },
  };
}
export async function executeDammClaim(
  c: Connection,
  plan: DammPlan,
  wallet: PublicKey,
  sign: (tx: Transaction) => Promise<Transaction>,
  storage: Store,
) {
  if (plan.view.dbc.network === "mainnet-beta") assertMainnetTransactionsEnabled();
  const n = plan.view.dbc.network;
  if (wallet.toBase58() !== plan.claim.wallet) throw Error("Wallet changed");
  assertNoPendingClaim(journal(storage), n, plan.claim.wallet);
  assertNoPendingClaim(storage, n, plan.claim.wallet);
  // Rebuild from current verified accounts; require the complete reviewed message again.
  const fresh = await prepareDammClaim(
    c,
    n,
    plan.view.dbc.pool,
    plan.position.position,
    wallet,
  );
  fresh.claim.tx.recentBlockhash = plan.claim.tx.recentBlockhash;
  if (
    Buffer.from(fresh.claim.tx.serializeMessage()).toString("base64") !==
      plan.claim.message ||
    fresh.position.a !== plan.position.a ||
    fresh.position.b !== plan.position.b ||
    fresh.existingWsol !== plan.existingWsol ||
    fresh.claim.fee !== plan.claim.fee ||
    fresh.claim.rent !== plan.claim.rent
  )
    throw Error("DAMM accounts, amounts or costs changed; review again");
  protectDammInstructions(plan.claim.tx, fresh.view, fresh.position, wallet);
  if (
    Buffer.from(plan.claim.tx.serializeMessage()).toString("base64") !==
    plan.claim.message
  )
    throw Error("DAMM review changed");
  if ((await c.getBlockHeight("confirmed")) > plan.claim.lastValidBlockHeight)
    throw Error("Blockhash expired; review again");
  const store = journal(storage, {
    position: plan.position.position,
    message: plan.claim.message,
  });
  const { signed, record } = await signCreatorClaim(
    c,
    plan.claim,
    wallet,
    sign,
    store,
  );
  await simulateReviewedTransaction(c, signed, true);
  const sent = await c.sendRawTransaction(signed.serialize(), {
    skipPreflight: false,
    preflightCommitment: "confirmed",
    maxRetries: 0,
  });
  if (sent !== record.signature)
    throw Error("RPC signature differs; check saved DAMM signature");
  await pollConfirmation(c, record.signature, record.lastValidBlockHeight);
  return refreshDammClaim(
    c,
    storage,
    dammRecord(storage, n, plan.claim.wallet)!,
  );
}
export async function refreshDammClaim(
  c: Connection,
  storage: Store,
  record: DammRecord,
) {
  await checkNetwork(c, record.network);
  let r = { ...record };
  if (r.state === "pending") {
    const statuses = await c.getSignatureStatuses([r.signature], {
      searchTransactionHistory: true,
    });
    if (statuses.value.length !== 1)
      throw Error("Incomplete DAMM signature status");
    const s = statuses.value[0];
    if (
      s?.confirmationStatus === "confirmed" ||
      s?.confirmationStatus === "finalized"
    ) {
      const tx = await c.getTransaction(r.signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      if (!tx?.meta)
        throw Error(
          "Confirmed DAMM transaction data unavailable; retain pending journal",
        );
      if (
        !verifyWalletMessage(
          Buffer.from(r.message, "base64"),
          tx.transaction.message.serialize(),
        ).ok
      )
        throw Error(
          "Confirmed message differs from DAMM review; inspect saved signature",
        );
      r = {
        ...r,
        state: tx.meta.err ? "failed" : "confirmed",
        actualFee: amount(tx.meta.fee).toString(),
      };
    } else if (
      !s &&
      r.expiryKnown !== false &&
      (await c.getBlockHeight("finalized")) > r.lastValidBlockHeight
    )
      r.state = "expired";
    saveClaim(
      journal(storage, { position: r.position, message: r.message }),
      r,
    );
  }
  return {
    record: r,
    view: await readDammPositions(
      c,
      r.network,
      r.pool,
      new PublicKey(r.wallet),
    ),
  };
}
