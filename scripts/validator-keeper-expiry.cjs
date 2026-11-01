/* eslint-disable @typescript-eslint/no-require-imports -- standalone validator tooling */
// Scheduled-keeper and epoch-expiry checks on a loopback validator, run after validator-meteora-lifecycle.cjs
// (which leaves adversarial epoch 1 funded but unpayable, and seed-derived local keeper keys in charge).
// The real keeper (scripts/holder-rewards-keeper.ts) is run between these phases by the orchestrator.
//   --seed         commit the lifecycle token to the test DB (hymet_validator_app) as the app would
//   --trade        move tokens to fresh holder wallets and swap on the migrated DAMM v2 pool (accrues fees)
//   --inspect      print the fee pool and latest epoch (used to prove the keeper was killed mid-epoch)
//   --expiry-pre   epoch 1 is open and not yet closeable (EpochActive)
//   --expiry-post  after a slot warp past EPOCH_EXPIRY_SLOTS: authority closes the expired epoch; reserve returns
//   --verify       DB and on-chain accounting after the keeper runs
//   --cleanup      remove this token's rows from the test DB
const fs = require('node:fs');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,esModuleInterop:true,target:ts.ScriptTarget.ES2022}}).outputText,filename);
const {Connection,Keypair,PublicKey,ComputeBudgetProgram,Transaction} = require('@solana/web3.js');
const BN = require('bn.js');
const {Client} = require('pg');
const {createHash} = require('node:crypto');
const {CpAmm} = require('@meteora-ag/cp-amm-sdk');
const {TOKEN_PROGRAM_ID,getAssociatedTokenAddressSync,createAssociatedTokenAccountIdempotentInstruction,createTransferInstruction,getAccount} = require('@solana/spl-token');
const {closeHolderEpoch,decodeFeePool,distributorAddresses,holderEpochAddress} = require('../lib/distributor-engine.ts');
const {decodeRewardEpoch} = require('../lib/holder-keeper.ts');
const {HOLDER_PAYOUT_POLICY} = require('../lib/holder-payouts.mjs');
const assert = require('node:assert/strict');

const endpoint = process.env.VALIDATOR_RPC_URL || 'http://127.0.0.1:19899';
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint)) throw Error('Loopback validator required');
const connection = new Connection(endpoint,'confirmed');
const seeded = (label) => Keypair.fromSeed(createHash('sha256').update(label).digest());
const payer = seeded('HYMET LOCAL VALIDATOR ONLY TRADER'), platform = seeded('HYMET LOCAL VALIDATOR ONLY PLATFORM'), keeper = seeded('HYMET LOCAL VALIDATOR ONLY KEEPER');
const holders = [0,1,2].map((i) => seeded(`HYMET LOCAL VALIDATOR KEEPER HOLDER ${i}`));
const HYPE = new PublicKey('98sMhvDwXj1RQi5c5Mndm3vPe9cBqPrbLaufMXFNMh5g');
const EXPIRY = HOLDER_PAYOUT_POLICY.expirySlots;
const proof = JSON.parse(fs.readFileSync('work/application-proof.json','utf8'));
const program = new PublicKey(proof.program), mint = new PublicKey(proof.mint), a = distributorAddresses(program,mint);
const statePath = 'work/keeper-expiry.json';
const db = () => { const c = new Client({host:'/var/run/postgresql',user:'hymet_build',database:'hymet_validator_app'}); return c.connect().then(() => c); };
const pool = async () => decodeFeePool((await connection.getAccountInfo(a.feePool,'confirmed')).data);
const vault = async () => (await getAccount(connection,a.hypeVault)).amount;
const show = (o) => JSON.stringify(o,(k,v) => typeof v === 'bigint' ? v.toString() : v instanceof PublicKey ? v.toBase58() : v);

async function confirm(signature) {
  for (let n = 0; n < 100; n++) {
    const status = (await connection.getSignatureStatuses([signature])).value[0];
    if (status && ['confirmed','finalized'].includes(status.confirmationStatus)) {
      if (status.err) throw Error(JSON.stringify(status.err));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve,300));
  }
  throw Error('Local confirmation timed out');
}
async function submit(label,transaction,signers) {
  transaction.instructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({units:400000}));
  transaction.feePayer = signers[0].publicKey;
  transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  transaction.sign(...signers);
  const signature = await connection.sendRawTransaction(transaction.serialize());
  await confirm(signature);
  console.log(`PASS ${label}: ${signature}`);
  return signature;
}
async function rejected(label,transaction,signers,expectedLog) {
  transaction.feePayer = signers[0].publicKey;
  transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  transaction.sign(...signers);
  const signature = await connection.sendRawTransaction(transaction.serialize(),{skipPreflight:true});
  let failed = false;
  try { await confirm(signature); } catch { failed = true; }
  assert(failed,`${label} unexpectedly succeeded`);
  const result = await connection.getTransaction(signature,{commitment:'confirmed',maxSupportedTransactionVersion:0});
  assert(result?.meta?.err,`${label}: missing confirmed failure`);
  assert(result.meta.logMessages.some((line) => line.includes(expectedLog)),`${label}: unexpected error ${JSON.stringify(result.meta.logMessages)}`);
  console.log(`PASS rejected ${label}: ${signature}; ${expectedLog}`);
}
const close = (signer,epoch) => new Transaction().add(closeHolderEpoch(program,mint,signer.publicKey,epoch));

async function seed() {
  const config = (await connection.getAccountInfo(a.config,'confirmed')).data;
  assert(config.subarray(72,104).equals(keeper.publicKey.toBuffer()),'Lifecycle did not hand the snapshot authority to the local keeper key');
  await confirm(await connection.requestAirdrop(keeper.publicKey,5e9));
  const launch = proof.execution.find((item) => item.label.includes('atomic token/pool/distributor launch'));
  const launchTx = await connection.getTransaction(launch.signature,{commitment:'confirmed',maxSupportedTransactionVersion:0});
  const creatorBps = (await pool()).creatorBpsOfRemaining, unique = proof.mint.slice(0,16);
  const c = await db();
  try {
    await c.query('BEGIN');
    await c.query('INSERT INTO creators(wallet_address) VALUES($1) ON CONFLICT DO NOTHING',[proof.creator]);
    const reservation = await c.query("INSERT INTO launch_reservations(creator_wallet,name,ticker,name_key,ticker_key,status,idempotency_key,expires_at) VALUES($1,$2,$2,$2,$2,'confirmed',$2,now()+interval '1 hour') RETURNING id",[proof.creator,unique]);
    await c.query("INSERT INTO tokens(mint_address,reservation_id,creator_wallet,name,ticker,name_key,ticker_key,description,metadata_uri,artwork_uri,quote_mint,trading_fee_bps,creator_share_of_remaining_bps,holder_share_of_remaining_bps,status,launch_signature,confirmed_slot,distributor_program_id,distributor_fee_pool) VALUES($1,$2,$3,$4,$4,$4,$4,'keeper schedule test','https://example.invalid/test.json','https://example.invalid/test.png',$5,100,$10,$11,'bonding',$6,$7,$8,$9)",[proof.mint,reservation.rows[0].id,proof.creator,unique,HYPE.toBase58(),launch.signature,launchTx.slot,proof.program,proof.feePool,creatorBps,10000-creatorBps]);
    await c.query("INSERT INTO pools(pool_address,mint_address,protocol,quote_mint,status) VALUES($1,$2,'meteora_dbc',$3,'active')",[proof.dbcPool,proof.mint,HYPE.toBase58()]);
    // Epochs 0 and 2 were prepared by the lifecycle exactly as the keeper prepares them; epoch 1 (adversarial) was not.
    // Candidate fields come from the confirmed HolderEpochFunded events, as the indexer matches them exactly.
    const {decodeDistributorEvents} = await import('../lib/distributor-events.mjs');
    const funded = [];
    for (const item of proof.execution) {
      const t = await connection.getTransaction(item.signature,{commitment:'confirmed',maxSupportedTransactionVersion:0});
      funded.push(...decodeDistributorEvents(t.meta.logMessages,proof.program).filter((ev) => ev.type === 'HolderEpochFunded').map((ev) => ev.payload));
    }
    for (const e of proof.epochs) {
      const f = funded.find((x) => x.epoch === e.epoch);
      assert(f && f.merkleRoot === e.root,`Funded event for epoch ${e.epoch} not found`);
      await c.query('INSERT INTO holder_snapshot_candidates(mint_address,epoch,snapshot_slot,snapshot_hash,merkle_root,funded_amount,allocated_amount,chunk_count,carry_after) VALUES($1,$2,$3,$4,$5,$6,$6,$7,$8::jsonb)',[proof.mint,f.epoch,f.snapshotSlot,f.snapshotHash,f.merkleRoot,f.fundedAmount,e.chunks.length,'{}']);
      for (const ch of e.chunks) for (const r of ch.entries)
        await c.query('INSERT INTO holder_snapshot_candidate_rows(mint_address,epoch,wallet_address,token_balance,reward_amount,leaf_hash,merkle_proof,chunk_index,new_account) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)',[proof.mint,e.epoch,r.wallet,r.tokenBalance,r.reward,ch.leaf,JSON.stringify(ch.proof),ch.index,r.newAccount]);
    }
    await c.query('DELETE FROM indexer_checkpoints WHERE source=$1',[proof.program]);
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { await c.end(); }
  console.log(`PASS seeded test DB token ${proof.mint} (creator ${creatorBps / 100}% / holders ${(10000 - creatorBps) / 100}% of the 80%)`);
}

async function trade(round) {
  const base = getAssociatedTokenAddressSync(mint,payer.publicKey);
  const balance = (await getAccount(connection,base)).amount;
  // Fresh holders each round get different balances; only holder 0 has a HYPE account, so the keeper must create the others.
  const tx = new Transaction();
  holders.forEach((h,i) => {
    const ata = getAssociatedTokenAddressSync(mint,h.publicKey);
    tx.add(createAssociatedTokenAccountIdempotentInstruction(payer.publicKey,ata,h.publicKey,mint),createTransferInstruction(base,ata,payer.publicKey,balance / BigInt(20 * (i + 1) + round)));
  });
  tx.add(createAssociatedTokenAccountIdempotentInstruction(payer.publicKey,getAssociatedTokenAddressSync(HYPE,holders[0].publicKey),holders[0].publicKey,HYPE));
  await submit(`round ${round}: tokens to 3 holder wallets`,tx,[payer]);
  const cp = new CpAmm(connection), dammPool = (await pool()).dammPool, state = await cp.fetchPoolState(dammPool);
  const swap = (input,output,amountIn) => cp.swap({payer:payer.publicKey,pool:dammPool,inputTokenMint:input,outputTokenMint:output,amountIn:new BN(amountIn),minimumAmountOut:new BN(1),tokenAMint:state.tokenAMint,tokenBMint:state.tokenBMint,tokenAVault:state.tokenAVault,tokenBVault:state.tokenBVault,tokenAProgram:TOKEN_PROGRAM_ID,tokenBProgram:TOKEN_PROGRAM_ID,referralTokenAccount:null});
  await submit(`round ${round}: DAMM v2 buy 20 HYPE`,await swap(HYPE,mint,'20000000000'),[payer]);
  await submit(`round ${round}: DAMM v2 sell`,await swap(mint,HYPE,(balance / 50n).toString()),[payer]);
}

async function inspect() {
  const p = await pool(), last = p.nextEpoch - 1n, info = await connection.getAccountInfo(holderEpochAddress(program,mint,last),'confirmed');
  const epoch = info ? decodeRewardEpoch(info.data) : null;
  console.log(`INSPECT ${show({slot:await connection.getSlot('confirmed'),nextEpoch:p.nextEpoch,holderUnallocated:p.holderUnallocated,holderReserved:p.holderReserved,vault:await vault(),last:last.toString(),open:epoch ? {paidChunks:epoch.paidChunks,chunkCount:epoch.chunkCount,funded:epoch.fundedAmount,claimed:epoch.claimedAmount} : null})}`);
}

async function expiryPre() {
  const info = await connection.getAccountInfo(holderEpochAddress(program,mint,1n),'confirmed');
  assert(info,'Adversarial epoch 1 is not open');
  const e = decodeRewardEpoch(info.data), slot = BigInt(await connection.getSlot('confirmed'));
  assert(e.paidChunks < e.chunkCount && e.claimedAmount === 0n,'Epoch 1 should be unpaid');
  assert(slot < e.snapshotSlot + EXPIRY);
  await rejected('keeper closes unpaid epoch before expiry',close(keeper,1n),[keeper],'EpochActive');
  const p = await pool();
  const state = {snapshotSlot:e.snapshotSlot.toString(),funded:e.fundedAmount.toString(),expirySlot:(e.snapshotSlot + EXPIRY).toString(),warpSlot:(e.snapshotSlot + EXPIRY + 200n).toString(),reserved:p.holderReserved.toString(),unallocated:p.holderUnallocated.toString(),vault:(await vault()).toString()};
  fs.writeFileSync(statePath,JSON.stringify(state,null,2));
  console.log(`EXPIRY ${JSON.stringify(state)}`);
  console.log(`PASS epoch 1 open at slot ${slot}; closeable from slot ${state.expirySlot} (${EXPIRY} slots after snapshot ${e.snapshotSlot})`);
}

async function expiryPost() {
  const before = JSON.parse(fs.readFileSync(statePath,'utf8'));
  const slot = BigInt(await connection.getSlot('confirmed'));
  assert(slot >= BigInt(before.expirySlot),`Validator slot ${slot} has not passed the expiry slot ${before.expirySlot}`);
  const p0 = await pool(), v0 = await vault();
  assert.equal(p0.holderReserved.toString(),before.reserved,'Reserve changed across the warp');
  assert.equal(v0.toString(),before.vault,'Vault changed across the warp');
  const stranger = Keypair.generate();
  await confirm(await connection.requestAirdrop(stranger.publicKey,1e9));
  await rejected('stranger closes expired epoch',close(stranger,1n),[stranger],'Unauthorized');
  await rejected('rotated-out platform key closes expired epoch',close(platform,1n),[platform],'Unauthorized');
  await submit(`keeper closes expired unpaid epoch 1 at slot ${slot}`,close(keeper,1n),[keeper]);
  assert.equal(await connection.getAccountInfo(holderEpochAddress(program,mint,1n),'confirmed'),null,'Expired epoch account still open');
  const p1 = await pool(), v1 = await vault(), returned = BigInt(before.funded);
  assert.equal(p1.holderReserved,p0.holderReserved - returned,'Reserve did not drop by the unpaid amount');
  assert.equal(p1.holderUnallocated,p0.holderUnallocated + returned,'Unpaid reserve did not return to the holder pool');
  assert.equal(p1.creatorClaimable,p0.creatorClaimable,'Expiry changed the creator balance');
  assert.equal(v1,v0,'Expiry moved HYPE out of the vault');
  assert(v1 >= p1.creatorClaimable + p1.holderUnallocated + p1.holderReserved,'Vault no longer covers liabilities');
  await rejected('re-close of the closed epoch',close(keeper,1n),[keeper],'AccountNotInitialized');
  console.log(`PASS expired epoch 1 closed: ${returned} HYPE base units returned to the holder pool (not to HYMET or the creator); vault unchanged, liabilities covered`);
}

async function verify() {
  const p = await pool(), v = await vault();
  assert(v >= p.creatorClaimable + p.holderUnallocated + p.holderReserved,'Vault does not cover liabilities');
  assert.equal(p.holderReserved,0n,'An epoch is still holding reserved HYPE');
  const c = await db();
  try {
    const epochs = (await c.query('SELECT epoch::int,status,funded_amount::text FROM holder_reward_epochs WHERE mint_address=$1 ORDER BY epoch',[proof.mint])).rows;
    const keeperEpochs = epochs.filter((e) => e.epoch >= 3);
    assert(keeperEpochs.length >= 3,`Expected at least 3 keeper epochs, indexed ${JSON.stringify(epochs)}`);
    assert(keeperEpochs.every((e) => e.status === 'closed'),`Keeper epoch left open: ${JSON.stringify(keeperEpochs)}`);
    const owed = (await c.query('SELECT coalesce(sum(reward_amount-claimed_amount),0)::text AS n,count(*)::int AS rows FROM holder_reward_entitlements WHERE mint_address=$1',[proof.mint])).rows[0];
    assert.equal(owed.n,'0','Indexed entitlements are not fully paid');
    const paid = (await c.query("SELECT count(*)::int AS n,sum(amount)::text AS amount FROM claims WHERE mint_address=$1 AND claim_type='holder'",[proof.mint])).rows[0];
    const funded = keeperEpochs.reduce((n,e) => n + BigInt(e.funded_amount),0n);
    const received = await Promise.all(holders.map(async (h) => { try { return (await getAccount(connection,getAssociatedTokenAddressSync(HYPE,h.publicKey))).amount; } catch { return 0n; } }));
    assert(received.every((x) => x > 0n),`A snapshot holder received no HYPE: ${received}`);
    console.log(`VERIFY ${show({epochs,entitlementRows:owed.rows,holderClaims:paid,keeperFunded:funded,holderHype:received,pool:{unallocated:p.holderUnallocated,reserved:p.holderReserved,creatorClaimable:p.creatorClaimable},vault:v})}`);
    console.log('PASS scheduled keeper: every keeper epoch funded, pushed and closed; entitlements fully paid; keeper-created HYPE accounts paid; vault covers liabilities');
  } finally { await c.end(); }
}

async function cleanup() {
  const c = await db();
  try {
    await c.query('BEGIN');
    const tokenRow = (await c.query('SELECT reservation_id FROM tokens WHERE mint_address=$1',[proof.mint])).rows[0];
    for (const table of ['claims','holder_reward_entitlements','holder_reward_epochs','holder_snapshot_candidate_rows','holder_snapshot_candidates','holder_reward_carry','fee_settlements','fee_accruals','distributor_chain_events','migration_events','market_snapshots','trading_events','pools','tokens'])
      await c.query(`DELETE FROM ${table} WHERE mint_address=$1`,[proof.mint]);
    if (tokenRow) await c.query('DELETE FROM launch_reservations WHERE id=$1',[tokenRow.reservation_id]);
    await c.query('DELETE FROM indexer_checkpoints WHERE source=$1',[proof.program]);
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { await c.end(); }
  console.log('PASS test DB rows removed');
}

const mode = process.argv[2];
const run = {'--seed':seed,'--trade':() => trade(Number(process.argv[3] || 1)),'--inspect':inspect,'--expiry-pre':expiryPre,'--expiry-post':expiryPost,'--verify':verify,'--cleanup':cleanup}[mode];
if (!run) throw Error('Usage: validator-keeper-expiry.cjs --seed|--trade <round>|--inspect|--expiry-pre|--expiry-post|--verify|--cleanup');
run().catch((error) => { console.error(error.message, error.logs ? JSON.stringify(error.logs) : ''); process.exitCode = 1; });
