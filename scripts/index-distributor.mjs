import { Connection, PublicKey } from "@solana/web3.js";
import pg from "pg";
import { indexDistributorEvent } from "../lib/distributor-index.mjs";
import { decodeDistributorEvents } from "../lib/distributor-events.mjs";

const { Pool } = pg;
const programText = process.env.HYMET_DISTRIBUTOR_PROGRAM_ID;
if (!process.env.DATABASE_URL || !programText)
  throw new Error("Set DATABASE_URL and HYMET_DISTRIBUTOR_PROGRAM_ID");
const program = new PublicKey(programText);
if (programText === "CWDBD8de82UWLL3xZBd117t3uPoe25ZKy5TcHLLTg9xY")
  throw new Error("The configured distributor ID is the local placeholder");
const rpc = new Connection(
  process.env.MAINNET_RPC_URL || "https://api.mainnet-beta.solana.com",
  "confirmed",
);
const db = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });

try {
  const state = await db.query(
    "SELECT last_signature,last_slot FROM indexer_checkpoints WHERE source=$1",
    [program.toBase58()],
  );
  const cursor = state.rows[0]?.last_signature ?? null;
  const fetched = [];
  let before;
  let foundCursor = !cursor;
  for (;;) {
    const page = await rpc.getSignaturesForAddress(
      program,
      {
        limit: 1000,
        ...(before ? { before } : {}),
        ...(cursor ? { until: cursor } : {}),
      },
      "confirmed",
    );
    if (!page.length) break;
    if (cursor && page.some((x) => x.signature === cursor)) foundCursor = true;
    fetched.push(...page.filter((x) => !cursor || x.signature !== cursor));
    before = page.at(-1).signature;
    if (page.length < 1000 || (cursor && foundCursor)) break;
  }
  if (cursor && !foundCursor && fetched.length === 0)
    console.warn("Cursor is newer than the RPC page; no new signatures found.");
  // RPC pages are newest-first. Index in chain order so the cursor never leaps over an error.
  const ordered = fetched.reverse();
  for (const row of ordered) {
    const tx = row.err
      ? null
      : await rpc.getTransaction(row.signature, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        });
    if (!row.err && !tx?.meta)
      throw new Error(
        `Confirmed transaction ${row.signature} is unavailable from the configured RPC; cursor not advanced`,
      );
    const events =
      tx?.meta && !tx.meta.err
        ? decodeDistributorEvents(tx.meta.logMessages, program.toBase58())
        : [];
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      for (let i = 0; i < events.length; i++)
        await indexDistributorEvent(client, program, row.signature, row.slot, i, events[i]);
      await client.query(
        `INSERT INTO indexer_checkpoints(source,last_slot,last_signature) VALUES($1,$2,$3)
         ON CONFLICT(source) DO UPDATE SET last_slot=GREATEST(indexer_checkpoints.last_slot,EXCLUDED.last_slot),last_signature=EXCLUDED.last_signature,updated_at=now()`,
        [program.toBase58(), row.slot, row.signature],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  console.log(
    `confirmed signatures processed: ${ordered.length}; last slot: ${ordered.at(-1)?.slot ?? state.rows[0]?.last_slot ?? "unchanged"}`,
  );
} finally {
  await db.end();
}
