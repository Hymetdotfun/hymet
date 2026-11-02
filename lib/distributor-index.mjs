function asBig(value) {
  return BigInt(value);
}
// Same rule as lib/quote-assets.ts: the Devnet test HYPE mint only in Devnet test mode, otherwise Mainnet HYPE.
const HYPE_MINT_TEXT =
  (process.env.NEXT_PUBLIC_HYMET_TEST_NETWORK === "devnet" && process.env.NEXT_PUBLIC_HYMET_TEST_HYPE_MINT) ||
  "98sMhvDwXj1RQi5c5Mndm3vPe9cBqPrbLaufMXFNMh5g";
export function assertSplit(e, creatorBpsOfRemaining) {
  const total = asBig(e.distributable),
    platform = asBig(e.hymet),
    creator = asBig(e.creator),
    holders = asBig(e.holders);
  // Same integer math as the program: 20% first, creator rounded down, holders take the remainder.
  if (
    platform + creator + holders !== total ||
    platform !== (total * 2_000n) / 10_000n ||
    creator !== ((total - platform) * BigInt(creatorBpsOfRemaining)) / 10_000n
  )
    throw new Error("Confirmed fee event violates HYMET allocation invariants");
  if (e.source !== 0 && e.source !== 1)
    throw new Error("Unknown fee source in distributor event");
}

export async function indexDistributorEvent(client, program, signature, slot, index, event) {
  const e = event.payload;
  const inserted = await client.query(
    `INSERT INTO distributor_chain_events(signature,event_index,program_id,event_type,mint_address,slot,commitment,payload)
     VALUES($1,$2,$3,$4,$5,$6,'confirmed',$7::jsonb) ON CONFLICT DO NOTHING RETURNING signature`,
    [
      signature,
      index,
      program.toBase58(),
      event.type,
      e.mint,
      slot,
      JSON.stringify(e),
    ],
  );
  if (!inserted.rowCount) return;
  const token = await client.query(
    "SELECT quote_mint,creator_wallet,distributor_program_id,creator_share_of_remaining_bps FROM tokens WHERE mint_address=$1",
    [e.mint],
  );
  if (
    token.rowCount !== 1 ||
    token.rows[0].distributor_program_id !== program.toBase58() ||
    token.rows[0].quote_mint !== HYPE_MINT_TEXT
  )
    throw new Error(`Event token ${e.mint} is not registered as HYPE-paired`);

  if (event.type === "FeesSettled") {
    assertSplit(e, token.rows[0].creator_share_of_remaining_bps);
    const source = e.source === 0 ? "dbc_partner_fee" : "damm_partner_fee";
    const accrual = await client.query(
      `INSERT INTO fee_accruals(mint_address,source_signature,event_index,source,gross_amount,protocol_cost,distributable_amount,quote_mint)
       VALUES($1,$2,$3,$4,$5,0,$5,$6) ON CONFLICT(source_signature,event_index,source) DO NOTHING RETURNING id`,
      [
        e.mint,
        signature,
        index,
        source,
        e.distributable,
        token.rows[0].quote_mint,
      ],
    );
    if (accrual.rowCount)
      await client.query(
        `INSERT INTO fee_settlements(mint_address,accrual_id,distributable_amount,hymet_amount,creator_amount,holder_amount,quote_mint,transaction_signature,event_index)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          e.mint,
          accrual.rows[0].id,
          e.distributable,
          e.hymet,
          e.creator,
          e.holders,
          token.rows[0].quote_mint,
          signature,
          index,
        ],
      );
  } else if (event.type === "HolderEpochFunded") {
    const candidate = await client.query(
      `SELECT * FROM holder_snapshot_candidates WHERE mint_address=$1 AND epoch=$2 AND snapshot_slot=$3 AND snapshot_hash=$4 AND merkle_root=$5 AND funded_amount=$6 AND (chunk_count IS NULL OR chunk_count=$7) AND status='prepared' FOR UPDATE`,
      [
        e.mint,
        e.epoch,
        e.snapshotSlot,
        e.snapshotHash,
        e.merkleRoot,
        e.fundedAmount,
        e.chunkCount ?? null,
      ],
    );
    if (!candidate.rowCount) return; // no entitlement is trusted until a matching funded root was prepared
    const c = candidate.rows[0];
    const epoch = await client.query(
      `INSERT INTO holder_reward_epochs(mint_address,epoch,snapshot_slot,snapshot_hash,merkle_root,funded_amount,allocated_amount,quote_mint,funding_signature,funding_event_index,status)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'funded') ON CONFLICT(mint_address,epoch) DO NOTHING RETURNING epoch`,
      [
        e.mint,
        e.epoch,
        e.snapshotSlot,
        e.snapshotHash,
        e.merkleRoot,
        e.fundedAmount,
        c.allocated_amount,
        token.rows[0].quote_mint,
        signature,
        index,
      ],
    );
    if (epoch.rowCount) {
      await client.query(
        `INSERT INTO holder_reward_entitlements(mint_address,wallet_address,epoch,snapshot_slot,token_balance,reward_amount,quote_mint,leaf_hash,merkle_proof,chunk_index)
         SELECT mint_address,wallet_address,epoch,$3,token_balance,reward_amount,$4,leaf_hash,merkle_proof,chunk_index FROM holder_snapshot_candidate_rows WHERE mint_address=$1 AND epoch=$2`,
        [e.mint, e.epoch, e.snapshotSlot, token.rows[0].quote_mint],
      );
      // The funded plan's carry ledger becomes current only once its funding is confirmed.
      await client.query("DELETE FROM holder_reward_carry WHERE mint_address=$1", [e.mint]);
      await client.query(
        `INSERT INTO holder_reward_carry(mint_address,wallet_address,amount)
         SELECT $1,key,value::numeric FROM jsonb_each_text($2::jsonb) WHERE value::numeric>0`,
        [e.mint, JSON.stringify(c.carry_after ?? {})],
      );
      await client.query(
        "UPDATE holder_snapshot_candidates SET status='funded',funding_signature=$3,funding_event_index=$4 WHERE mint_address=$1 AND epoch=$2",
        [e.mint, e.epoch, signature, index],
      );
    }
  } else if (event.type === "HolderPaid") {
    // Pushed by the keeper; the program already verified the committed chunk and its bitmap.
    const entitlement = await client.query(
      `UPDATE holder_reward_entitlements SET claimed_amount=claimed_amount+$4 WHERE mint_address=$1 AND wallet_address=$2 AND epoch=$3 AND claimed_amount+$4<=reward_amount RETURNING id`,
      [e.mint, e.wallet, e.epoch, e.amount],
    );
    if (!entitlement.rowCount)
      throw new Error(
        "Confirmed holder payout does not match an indexed funded entitlement",
      );
    await client.query(
      `INSERT INTO claims(mint_address,wallet_address,claim_type,entitlement_id,amount,quote_mint,transaction_signature,event_index)
       VALUES($1,$2,'holder',$3,$4,$5,$6,$7)`,
      [
        e.mint,
        e.wallet,
        entitlement.rows[0].id,
        e.amount,
        token.rows[0].quote_mint,
        signature,
        index,
      ],
    );
  } else if (event.type === "HolderEpochClosed") {
    // Unpaid entitlements of an expired epoch went back to the holder pool on-chain;
    // return them to the carry ledger so they are paid in a later epoch.
    await client.query(
      `INSERT INTO holder_reward_carry(mint_address,wallet_address,amount)
       SELECT mint_address,wallet_address,reward_amount-claimed_amount FROM holder_reward_entitlements
        WHERE mint_address=$1 AND epoch=$2 AND claimed_amount<reward_amount
       ON CONFLICT(mint_address,wallet_address) DO UPDATE SET amount=holder_reward_carry.amount+EXCLUDED.amount,updated_at=now()`,
      [e.mint, e.epoch],
    );
    await client.query(
      "UPDATE holder_reward_epochs SET status='closed',finalized_signature=$3 WHERE mint_address=$1 AND epoch=$2",
      [e.mint, e.epoch, signature],
    );
  } else if (event.type === "CreatorClaimed") {
    if (e.wallet !== token.rows[0].creator_wallet)
      throw new Error(
        "Confirmed creator claim signer does not match launch creator",
      );
    await client.query(
      `INSERT INTO claims(mint_address,wallet_address,claim_type,amount,quote_mint,transaction_signature,event_index)
       VALUES($1,$2,'creator',$3,$4,$5,$6)`,
      [e.mint, e.wallet, e.amount, token.rows[0].quote_mint, signature, index],
    );
  } else if (event.type === "MigrationPoolRegistered") {
    await client.query("UPDATE tokens SET status='graduated' WHERE mint_address=$1", [e.mint]);
    await client.query(
      "UPDATE pools SET status='migrated' WHERE mint_address=$1 AND protocol='meteora_dbc'",
      [e.mint],
    );
    await client.query(
      `INSERT INTO pools(pool_address,mint_address,protocol,quote_mint,status) VALUES($1,$2,'meteora_damm_v2',$3,'active') ON CONFLICT(pool_address) DO NOTHING`,
      [e.pool, e.mint, token.rows[0].quote_mint],
    );
  }
}

