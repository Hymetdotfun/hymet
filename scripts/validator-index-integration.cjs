/* eslint-disable @typescript-eslint/no-require-imports -- standalone validator tooling */
// Replays authentic validator events through the production index writer inside a rolled-back test transaction.
// Distributor v2: holder epochs are prepared exactly as the keeper prepares them, then pushed (HolderPaid) on-chain.
const fs=require('node:fs');
const assert=require('node:assert/strict');
const {Client}=require('pg');
const {Connection,PublicKey}=require('@solana/web3.js');
(async()=>{
  const {decodeDistributorEvents}=await import('../lib/distributor-events.mjs');
  const {indexDistributorEvent}=await import('../lib/distributor-index.mjs');
  const proof=JSON.parse(fs.readFileSync('work/application-proof.json','utf8'));
  const connection=new Connection(process.env.VALIDATOR_RPC_URL||'http://127.0.0.1:19899','confirmed');
  const rows=[];
  for(const item of proof.execution) {
    const tx=await connection.getTransaction(item.signature,{commitment:'confirmed',maxSupportedTransactionVersion:0});
    assert(tx?.meta && !tx.meta.err);
    rows.push({signature:item.signature,slot:tx.slot,events:decodeDistributorEvents(tx.meta.logMessages,proof.program)});
  }
  const events=rows.flatMap(row=>row.events);
  const db=new Client({host:'/var/run/postgresql',user:'hymet_build',database:'hymet_validator_app'});
  await db.connect();
  await db.query('BEGIN');
  try {
    await db.query('INSERT INTO creators(wallet_address) VALUES($1) ON CONFLICT DO NOTHING',[proof.creator]);
    const unique=proof.mint.slice(0,16);
    const reservation=await db.query("INSERT INTO launch_reservations(creator_wallet,name,ticker,name_key,ticker_key,status,idempotency_key,expires_at) VALUES($1,$2,$2,$2,$2,'confirmed',$2,now()+interval '1 hour') RETURNING id",[proof.creator,unique]);
    const launch=proof.execution.find(item=>item.label.includes('atomic token/pool/distributor launch'));
    assert(launch,'Atomic application launch was not verified');
    const launchRow=rows.find(row=>row.signature===launch.signature);
    const creatorBps=Number(process.env.HYMET_LIFECYCLE_CREATOR_BPS??5000);
    await db.query("INSERT INTO tokens(mint_address,reservation_id,creator_wallet,name,ticker,name_key,ticker_key,description,metadata_uri,artwork_uri,quote_mint,trading_fee_bps,creator_share_of_remaining_bps,holder_share_of_remaining_bps,status,launch_signature,confirmed_slot,distributor_program_id,distributor_fee_pool) VALUES($1,$2,$3,$4,$4,$4,$4,'validator integration','https://example.invalid/test.json','https://example.invalid/test.png',$5,100,$10,$11,'bonding',$6,$7,$8,$9)",[proof.mint,reservation.rows[0].id,proof.creator,unique,'98sMhvDwXj1RQi5c5Mndm3vPe9cBqPrbLaufMXFNMh5g',launch.signature,launchRow.slot,proof.program,proof.feePool,creatorBps,10000-creatorBps]);
    await db.query("INSERT INTO pools(pool_address,mint_address,protocol,quote_mint,status) VALUES($1,$2,'meteora_dbc',$3,'active')",[proof.dbcPool,proof.mint,'98sMhvDwXj1RQi5c5Mndm3vPe9cBqPrbLaufMXFNMh5g']);
    // Same rows the keeper writes before funding (lib/holder-keeper.ts); only these epochs become payable.
    for(const candidate of proof.epochs) {
      const event=events.find(event=>event.type==='HolderEpochFunded' && event.payload.epoch===candidate.epoch);
      assert(event,'Funded event unavailable');
      const e=event.payload;
      await db.query('INSERT INTO holder_snapshot_candidates(mint_address,epoch,snapshot_slot,snapshot_hash,merkle_root,funded_amount,allocated_amount,chunk_count,carry_after) VALUES($1,$2,$3,$4,$5,$6,$6,$7,$8::jsonb)',[proof.mint,e.epoch,e.snapshotSlot,e.snapshotHash,e.merkleRoot,e.fundedAmount,candidate.chunks.length,'{}']);
      for(const c of candidate.chunks) for(const r of c.entries)
        await db.query('INSERT INTO holder_snapshot_candidate_rows(mint_address,epoch,wallet_address,token_balance,reward_amount,leaf_hash,merkle_proof,chunk_index,new_account) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)',[proof.mint,e.epoch,r.wallet,r.tokenBalance,r.reward,c.leaf,JSON.stringify(c.proof),c.index,r.newAccount]);
    }
    const program=new PublicKey(proof.program);
    for(let pass=0;pass<2;pass++) for(const row of rows) for(let i=0;i<row.events.length;i++) await indexDistributorEvent(db,program,row.signature,row.slot,i,row.events[i]);
    const totals=(await db.query('SELECT count(*)::int AS count,sum(distributable_amount)::text AS total,sum(hymet_amount)::text AS platform,sum(creator_amount)::text AS creator,sum(holder_amount)::text AS holders FROM fee_settlements WHERE mint_address=$1',[proof.mint])).rows[0];
    const settlements=events.filter(e=>e.type==='FeesSettled');
    const sum=key=>settlements.reduce((n,e)=>n+BigInt(e.payload[key]),0n).toString();
    assert.deepEqual(totals,{count:settlements.length,total:sum('distributable'),platform:sum('hymet'),creator:sum('creator'),holders:sum('holders')});
    const paid=events.filter(e=>e.type==='HolderPaid'),creatorClaims=events.filter(e=>e.type==='CreatorClaimed');
    assert(paid.length>0,'No holder push payouts were confirmed');
    const claims=(await db.query("SELECT claim_type,count(*)::int AS n,sum(amount)::text AS amount FROM claims WHERE mint_address=$1 GROUP BY claim_type ORDER BY claim_type",[proof.mint])).rows;
    const byType=Object.fromEntries(claims.map(r=>[r.claim_type,r]));
    assert.equal(byType.holder?.n,paid.length);
    assert.equal(byType.holder?.amount,paid.reduce((n,e)=>n+BigInt(e.payload.amount),0n).toString());
    assert.equal(byType.creator?.n??0,creatorClaims.length);
    // Every prepared epoch was pushed in full and closed; the adversarial epoch 1 root was never prepared, so it is not indexed.
    assert.equal((await db.query('SELECT sum(reward_amount-claimed_amount)::text AS n FROM holder_reward_entitlements WHERE mint_address=$1',[proof.mint])).rows[0].n,'0');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM holder_reward_epochs WHERE mint_address=$1 AND epoch=1',[proof.mint])).rows[0].n,0,'Unprepared adversarial root became payable');
    assert.equal((await db.query("SELECT count(*)::int AS n FROM holder_reward_epochs WHERE mint_address=$1 AND status='closed'",[proof.mint])).rows[0].n,proof.epochs.length);
    assert.equal((await db.query('SELECT status FROM tokens WHERE mint_address=$1',[proof.mint])).rows[0].status,'graduated');
    assert.equal((await db.query("SELECT status FROM pools WHERE mint_address=$1 AND protocol='meteora_dbc'",[proof.mint])).rows[0].status,'migrated');
    assert.equal((await db.query("SELECT count(*)::int AS n FROM pools WHERE mint_address=$1 AND protocol='meteora_damm_v2'",[proof.mint])).rows[0].n,1);
    console.log('PASS: authentic confirmed events -> PostgreSQL settlements at the stored split, migration, funded push epochs, holder payouts and creator claims; duplicate replay is idempotent; unprepared root stays unpayable');
    console.log(JSON.stringify({totals,claims}));
  } finally {await db.query('ROLLBACK');await db.end();}
})().catch(error=>{console.error(error);process.exitCode=1;});
