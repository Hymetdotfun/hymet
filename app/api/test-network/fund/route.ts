import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createTransferInstruction, getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { MAINNET_GENESIS, expectedGenesis, serverRpcUrl, testNetworkActive } from "../../../../lib/app-network";
import { localRequest, sameOrigin } from "../../../../lib/http";
import { HYPE_MINT } from "../../../../lib/quote-assets";
export const runtime = "nodejs";

const SOL = 2, HYPE = 500n * 10n ** 9n;
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

// Test network only: gives a wallet test SOL from the local validator faucet and test HYPE from the local
// genesis-funded HYPE account (scripts/validator-fixture-start.cjs). The funding key is derived from a public,
// local-only seed and holds nothing outside the loopback validator.
export async function POST(req: NextRequest) {
  try {
    if (!testNetworkActive()) return json({ error: "Test network is not active" }, 404);
    if (!localRequest(req) || !sameOrigin(req)) return json({ error: "Loopback same-origin request required" }, 403);
    const wallet = new PublicKey(String((await req.json()).wallet));
    const connection = new Connection(serverRpcUrl(), "confirmed");
    const genesis = await connection.getGenesisHash();
    if (genesis === MAINNET_GENESIS || genesis !== expectedGenesis()) return json({ error: "RPC is not the local test validator" }, 409);
    const funder = Keypair.fromSeed(createHash("sha256").update("HYMET LOCAL VALIDATOR ONLY TRADER").digest());
    if ((await connection.getBalance(funder.publicKey)) < LAMPORTS_PER_SOL / 10) {
      const fee = await connection.requestAirdrop(funder.publicKey, LAMPORTS_PER_SOL);
      await connection.confirmTransaction({ signature: fee, ...(await connection.getLatestBlockhash("confirmed")) }, "confirmed");
    }
    const airdrop = await connection.requestAirdrop(wallet, SOL * LAMPORTS_PER_SOL);
    const source = getAssociatedTokenAddressSync(HYPE_MINT, funder.publicKey), target = getAssociatedTokenAddressSync(HYPE_MINT, wallet, true);
    if ((await getAccount(connection, source)).amount < HYPE) return json({ error: "Local HYPE faucet is empty; restart the test validator" }, 409);
    const block = await connection.getLatestBlockhash("confirmed");
    const tx = new Transaction({ feePayer: funder.publicKey, ...block }).add(
      createAssociatedTokenAccountIdempotentInstruction(funder.publicKey, target, wallet, HYPE_MINT),
      createTransferInstruction(source, target, funder.publicKey, HYPE),
    );
    tx.sign(funder);
    const transfer = await connection.sendRawTransaction(tx.serialize());
    await connection.confirmTransaction({ signature: transfer, ...block }, "confirmed");
    await connection.confirmTransaction({ signature: airdrop, ...block }, "confirmed");
    return json({ wallet: wallet.toBase58(), sol: SOL, hype: "500", airdrop, transfer });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Funding failed" }, 400);
  }
}
