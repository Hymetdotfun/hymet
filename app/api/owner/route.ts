import { NextRequest, NextResponse } from "next/server";
import { Connection, PublicKey } from "@solana/web3.js";
import { assertMainnetTransactionsEnabled, serverRpcUrl } from "../../../lib/app-network";
import { ownerStatus, prepareOwnerInitialize, prepareOwnerRotation } from "../../../lib/distributor-owner";
import { limitedBody, publicError, sameOrigin } from "../../../lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Loopback, same-origin only (like the platform fee route). Returns chain state or an unsigned transaction;
// it never holds a key: the owner signs in Phantom and the browser broadcasts.
export async function POST(request: NextRequest) {
  if (!sameOrigin(request)) return NextResponse.json({ error: "Same-origin request required" }, { status: 403 });
  if (request.headers.get("content-type")?.split(";")[0] !== "application/json")
    return NextResponse.json({ error: "JSON request required" }, { status: 415 });
  const noStore = { "Cache-Control": "no-store" };
  try {
    const body = JSON.parse(new TextDecoder().decode(await limitedBody(request, 2048))) as { action?: unknown; wallet?: unknown; newAuthority?: unknown };
    const connection = new Connection(serverRpcUrl(), "confirmed");
    if (body.action === "status") return NextResponse.json(await ownerStatus(connection), { headers: noStore });
    if (body.action === "prepare-initialize") {
      assertMainnetTransactionsEnabled();
      if (typeof body.wallet !== "string") throw Error("Owner wallet is required");
      const plan = await prepareOwnerInitialize(connection, new PublicKey(body.wallet));
      return NextResponse.json(
        {
          transaction: plan.tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"),
          lastValidBlockHeight: plan.lastValidBlockHeight,
          summary: plan.summary,
        },
        { headers: noStore },
      );
    }
    if (body.action === "prepare-rotate") {
      assertMainnetTransactionsEnabled();
      if (typeof body.wallet !== "string" || typeof body.newAuthority !== "string") throw Error("Owner wallet and new keeper key are required");
      const plan = await prepareOwnerRotation(connection, new PublicKey(body.wallet), new PublicKey(body.newAuthority));
      return NextResponse.json(
        {
          transaction: plan.tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"),
          lastValidBlockHeight: plan.lastValidBlockHeight,
          rotation: plan.summary,
        },
        { headers: noStore },
      );
    }
    throw Error("Unsupported owner action");
  } catch (error) {
    const message = error instanceof Error ? publicError(error.message) : "Owner request failed";
    return NextResponse.json({ error: message }, { status: /RPC|network/i.test(message) ? 503 : 400, headers: noStore });
  }
}
