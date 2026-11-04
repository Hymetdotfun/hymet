// Read-only: compares one distributor token's chain state, database and wallet payments to the base unit, and proves every
// carried wallet's origin balance against the snapshot hash committed on-chain. Signs nothing, sends nothing, writes nothing.
//   node node_modules/jiti/lib/jiti-cli.mjs scripts/reconcile-holder-rewards.ts <mint>
// Env: DATABASE_URL, MAINNET_RPC_URL.
import { Connection, PublicKey } from "@solana/web3.js";
import pg from "pg";
import { distributorAddresses, decodeFeePool } from "../lib/distributor-engine";
import { verifyCarryOrigin } from "../lib/holder-keeper";
import { reconcileHolderRewards } from "../lib/holder-reconciliation.mjs";
import { HYPE_MINT } from "../lib/quote-assets";

const redact = (text: unknown) => String(text).replace(/\b(?:https?|postgres(?:ql)?):\/\/\S+/g, "<url>");

async function main() {
  const mintText = process.argv[2];
  const mint = new PublicKey(mintText);
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    const token = (await db.query("SELECT name,ticker,trading_fee_bps,creator_share_of_remaining_bps,holder_share_of_remaining_bps,distributor_program_id FROM tokens WHERE mint_address=$1", [mintText])).rows[0];
    if (!token?.distributor_program_id) throw Error("Not a distributor token");
    const program = new PublicKey(token.distributor_program_id);
    const connection = new Connection(process.env.MAINNET_RPC_URL || "https://api.mainnet-beta.solana.com", "confirmed");
    const a = distributorAddresses(program, mint);
    const info = await connection.getAccountInfo(a.feePool, "confirmed");
    if (!info) throw Error("Fee pool missing");
    const chain = decodeFeePool(info.data as Buffer);
    const vault = BigInt((await connection.getTokenAccountBalance(a.hypeVault, "confirmed")).value.amount);
    const rows = async (sql: string) => (await db.query(sql, [mintText])).rows;
    const settlements = await rows("SELECT distributable_amount,hymet_amount,creator_amount,holder_amount FROM fee_settlements WHERE mint_address=$1");
    const claims = await rows("SELECT wallet_address,claim_type,amount,transaction_signature FROM claims WHERE mint_address=$1");
    const epochs = await rows(`SELECT e.epoch,e.snapshot_slot,e.funded_amount,e.status,
        CASE WHEN e.status='closed' THEN e.funded_amount-COALESCE((SELECT sum(x.claimed_amount) FROM holder_reward_entitlements x WHERE x.mint_address=e.mint_address AND x.epoch=e.epoch),0) ELSE 0 END AS returned_amount
        FROM holder_reward_epochs e WHERE e.mint_address=$1 ORDER BY e.epoch`);
    const entitlements = await rows("SELECT wallet_address,epoch,token_balance,reward_amount,claimed_amount,origin_epoch FROM holder_reward_entitlements WHERE mint_address=$1 ORDER BY epoch,wallet_address");
    const carry = await rows("SELECT wallet_address,amount,origin_epoch,origin_snapshot_slot,origin_token_balance FROM holder_reward_carry WHERE mint_address=$1 ORDER BY wallet_address");

    console.log(`token ${token.ticker}: fee ${token.trading_fee_bps} bps, creator ${token.creator_share_of_remaining_bps}, holders ${token.holder_share_of_remaining_bps}`);
    const report = reconcileHolderRewards({ chain, vault, settlements, claims, epochs, entitlements, carry });
    let failures = report.checks.filter((c) => !c.ok).length;
    for (const c of report.checks) console.log(`${c.ok ? "ok      " : "MISMATCH"} ${c.name}: ${c.left} vs ${c.right}`);
    console.log(`attributed carry ${report.attributedCarry}; not yet assigned to a wallet ${report.unassigned}`);

    let previous: number | null = null;
    for (const e of epochs) {
      const time = await connection.getBlockTime(Number(e.snapshot_slot)).catch(() => null);
      console.log(`epoch ${e.epoch}: funded ${e.funded_amount}, ${e.status}, snapshot ${time ? new Date(time * 1000).toISOString() : "time unavailable"}${previous && time ? `, ${time - previous}s after the previous snapshot` : ""}`);
      previous = time ?? previous;
    }
    for (const x of entitlements) console.log(`entitlement epoch ${x.epoch} ${x.wallet_address}: balance ${x.token_balance}, reward ${x.reward_amount}, paid ${x.claimed_amount}${x.origin_epoch !== null ? `, seller, allocated at epoch ${x.origin_epoch}` : ""}`);

    const proofs = new Map();
    for (const c of carry) {
      const origin = c.origin_epoch === null ? null : { epoch: BigInt(c.origin_epoch), snapshotSlot: BigInt(c.origin_snapshot_slot), tokenBalance: BigInt(c.origin_token_balance) };
      const problem = origin ? await verifyCarryOrigin({ connection, program, db: db as never }, mintText, c.wallet_address, origin, proofs) : "no recorded origin snapshot";
      if (problem && origin) failures++;
      console.log(`carry ${c.wallet_address}: ${c.amount}, origin ${problem ? `UNPROVEN (${problem})` : `proven at epoch ${origin!.epoch}, balance ${origin!.tokenBalance}`}`);
    }

    const hype = HYPE_MINT.toBase58();
    for (const k of claims) {
      const tx = await connection.getTransaction(k.transaction_signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      const balance = (list: { mint: string; owner?: string; uiTokenAmount: { amount: string } }[] | null | undefined) => BigInt(list?.find((b) => b.mint === hype && b.owner === k.wallet_address)?.uiTokenAmount.amount ?? 0);
      const moved = tx?.meta ? balance(tx.meta.postTokenBalances) - balance(tx.meta.preTokenBalances) : null;
      const ok = moved === BigInt(k.amount);
      if (!ok) failures++;
      console.log(`${ok ? "ok      " : "MISMATCH"} ${k.claim_type} payment to ${k.wallet_address}: database ${k.amount}, wallet change ${moved}`);
    }
    console.log(failures ? `RESULT: ${failures} failure(s)` : "RESULT: every check matches");
    if (failures) process.exitCode = 1;
  } finally {
    await db.end();
  }
}

main().catch((e) => {
  console.error(redact(e instanceof Error ? e.message : e));
  process.exitCode = 1;
});
