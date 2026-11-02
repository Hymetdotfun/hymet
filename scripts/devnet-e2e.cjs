/* eslint-disable @typescript-eslint/no-require-imports -- standalone Devnet tooling */
// Public Devnet end-to-end run of HYMET with authentic Meteora DBC/DAMM v2 transactions and test-only keys.
// Devnet only (genesis-checked). The distributor is an isolated Devnet build of the reviewed v2 source whose ONLY
// differences are declare_id and HYPE_MINT (a Devnet test mint we control); see build.sh in HYMET_DEVNET_DIR.
// The app libraries run unmodified except that lib/quote-assets.ts gets the same HYPE mint substitution at load time.
// Phases (run in this order; each is safe to re-run):
//   --pre-init   fund test wallets, prove only the upgrade authority can initialize, then initialize (Devnet config)
//   --native     Phase 1 native split: launch, app buy/sell, 20/80 platform and creator claims
//   (default)    distributor v2: atomic launch, trades, settlement, claims, push payouts, graduation, DAMM v2
//   --automatic  7c9b9e2 flow at 5/95 and 0/100: app trades, real keeper (scripts/devnet-keeper.cjs) settles, migrates
//                to DAMM v2 and pays holders with no creator action; needs HYMET_DEVNET_DATABASE_URL (hymet_devnet*)
// Usage: HYMET_DEVNET_DIR=/srv/hymet-build/devnet-e2e node scripts/devnet-e2e.cjs [--pre-init|--native]
// Rehearsal before spending Devnet SOL: HYMET_DEVNET_REHEARSAL=1 DEVNET_RPC_URL=http://127.0.0.1:<port> (loopback only).
const fs = require('node:fs');
const ts = require('typescript');
const MAINNET_HYPE = '98sMhvDwXj1RQi5c5Mndm3vPe9cBqPrbLaufMXFNMh5g';
const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const dir = process.env.HYMET_DEVNET_DIR || '/srv/hymet-build/devnet-e2e';
if (!/^\/srv\/hymet-build\/[\w.\/-]+$/.test(dir) || dir.includes('..')) throw Error('HYMET_DEVNET_DIR must be inside /srv/hymet-build');
const {Connection,Keypair,PublicKey,ComputeBudgetProgram,SystemProgram,Transaction,LAMPORTS_PER_SOL} = require('@solana/web3.js');
const key = name => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${dir}/keys/${name}.json`,'utf8'))));
const hypeMintKey = key('hype-mint');
const hype = hypeMintKey.publicKey;
// The app's swap builders accept distributor launches only in holder-reward builds (the launch form's flags).
process.env.NEXT_PUBLIC_HYMET_HOLDER_REWARDS = 'true';
process.env.NEXT_PUBLIC_HYMET_DISTRIBUTOR_PROGRAM_ID = key('program').publicKey.toBase58();
require.extensions['.ts'] = (module, filename) => {
  let source = fs.readFileSync(filename,'utf8');
  if (filename.endsWith('quote-assets.ts')) {
    if (!source.includes(MAINNET_HYPE)) throw Error('quote-assets.ts no longer contains the HYPE mint');
    source = source.split(MAINNET_HYPE).join(hype.toBase58());
  }
  module._compile(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,esModuleInterop:true,target:ts.ScriptTarget.ES2022}}).outputText,filename);
};
const {Program} = require('@coral-xyz/anchor');
const BN = require('bn.js');
const {CpAmm,derivePositionAddress,derivePositionNftAccount,getUnClaimLpFee}=require('@meteora-ag/cp-amm-sdk');
const {createHash} = require('node:crypto');
const {TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,getAssociatedTokenAddressSync,createAssociatedTokenAccountIdempotentInstruction,createInitializeMint2Instruction,createMintToInstruction,getMinimumBalanceForRentExemptMint,MINT_SIZE,getAccount} = require('@solana/spl-token');
const {DynamicBondingCurveClient,deriveDbcPoolAddress,deriveDammV2PoolAddress,DAMM_V2_MIGRATION_FEE_ADDRESS} = require('@meteora-ag/dynamic-bonding-curve-sdk');
const {defaults,curve,distributorCurve} = require('../lib/config.ts');
const quoteAssets = require('../lib/quote-assets.ts');
const {createDistributorPool,distributorSettlement,creatorDistributorClaim,registerDistributorMigration,fundDistributorEpoch,distributeHolderChunk,closeHolderEpoch,holderEpochAddress,verifyDistributorPool}=require('../lib/distributor-engine.ts');
const {prepareDbcSwap,formatUnits} = require('../lib/dbc-swap.ts');
const {prepareDammSwap} = require('../lib/damm-swap.ts');
const {decodeFeePool} = require('../lib/distributor-engine.ts');
const {BorshEventCoder} = require('@coral-xyz/anchor');
const {CpAmmIdl} = require('@meteora-ag/cp-amm-sdk');
const {execFileSync} = require('node:child_process');
const path = require('node:path');
const {prepareCreatorClaim,readCreatorFees} = require('../lib/creator-fees.ts');
const {preparePlatformClaim,readPlatformFees} = require('../lib/platform-fees.ts');
const {HOLDER_PAYOUT_POLICY,eligibleHolders,planHolderEpoch}=require('../lib/holder-payouts.mjs');
const assert = require('node:assert/strict');
assert(quoteAssets.HYPE_MINT.equals(hype),'HYPE mint substitution did not reach the app libraries');

const rpcUrl = process.env.DEVNET_RPC_URL || 'https://api.devnet.solana.com';
const rehearsal = process.env.HYMET_DEVNET_REHEARSAL === '1';
if (rehearsal && !/^http:\/\/127\.0\.0\.1:\d+$/.test(rpcUrl)) throw Error('Rehearsal requires a loopback validator');
const connection = new Connection(rpcUrl,'confirmed');
// TEST SHIM, Devnet only: the app libraries accept only the Mainnet genesis (the app is Mainnet-only). After this
// script has verified the RPC is Devnet, the app builders alone are told "mainnet-beta" so they run unmodified.
const appConnection = new Proxy(connection,{get(target,k){ if(k==='getGenesisHash') return async()=>MAINNET_GENESIS; const v=target[k]; return typeof v==='function'?v.bind(target):v; }});
const programTarget = `${dir}/build/target`;
const execution = [];
const save = (name,extra) => fs.writeFileSync(`${dir}/devnet-proof-${name}.json`,JSON.stringify({cluster:'devnet',hypeTestMint:hype.toBase58(),...extra,execution},null,2));

async function confirm(signature) {
  for(let n=0;n<240;n++) {
    const status=(await connection.getSignatureStatuses([signature],{searchTransactionHistory:true})).value[0];
    if(status && ['confirmed','finalized'].includes(status.confirmationStatus)) {
      if(status.err) throw Error(JSON.stringify(status.err));
      return;
    }
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  throw Error(`Devnet confirmation timed out: ${signature}`);
}
async function submit(label,transaction,signers,{keepBudget=false}={}) {
  if(!keepBudget) {
    transaction.instructions=transaction.instructions.filter(ix=>!ix.programId.equals(ComputeBudgetProgram.programId));
    transaction.instructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({units:1000000}));
  }
  transaction.feePayer=signers[0].publicKey;
  transaction.recentBlockhash=(await connection.getLatestBlockhash()).blockhash;
  transaction.signatures=[];
  transaction.sign(...signers);
  try {
    const signature=await connection.sendRawTransaction(transaction.serialize());
    await confirm(signature);
    execution.push({result:'PASS',label,signature});
    console.log(`PASS ${label}: ${signature}`);
  } catch(error) {
    console.error(JSON.stringify({instruction:label,error:error.message,logs:error.logs || error.transactionLogs},null,2));
    execution.push({result:'FAIL',label,error:error.message});
    throw error;
  }
}
async function rejected(label,transaction,signers,expectedLog) {
  transaction.feePayer=signers[0].publicKey;
  transaction.recentBlockhash=(await connection.getLatestBlockhash()).blockhash;
  transaction.sign(...signers);
  const signature=await connection.sendRawTransaction(transaction.serialize(),{skipPreflight:true});
  let failed=false;
  try { await confirm(signature); } catch { failed=true; }
  assert(failed,`${label} unexpectedly succeeded: ${signature}`);
  let result;
  for(let n=0;n<40 && !result;n++) { result=await connection.getTransaction(signature,{commitment:'confirmed',maxSupportedTransactionVersion:0}); if(!result) await new Promise(r=>setTimeout(r,500)); }
  assert(result?.meta?.err,`${label}: missing confirmed failure`);
  assert(result.meta.logMessages.some(line=>line.includes(expectedLog)),`${label}: unexpected error ${JSON.stringify(result.meta.logMessages)}`);
  execution.push({result:'PASS',label:`rejected ${label}`,signature,expected:expectedLog});
  console.log(`PASS rejected ${label}: ${signature}; ${expectedLog}`);
}
async function rejectedBuild(label,build,expected) {
  await assert.rejects(build,e=>{assert.match(e.message,expected);return true;});
  execution.push({result:'PASS',label:`rejected ${label}`,expected:String(expected)});
  console.log(`PASS rejected ${label}: ${expected}`);
}
const bal=async(owner,mint)=>{try{return (await getAccount(connection,getAssociatedTokenAddressSync(mint,owner))).amount;}catch{return 0n;}};
async function fundSol(payer,to,label,sol) {
  if ((await connection.getBalance(to))<sol*LAMPORTS_PER_SOL/2)
    await submit(`fund ${label} test wallet`,new Transaction().add(SystemProgram.transfer({fromPubkey:payer.publicKey,toPubkey:to,lamports:Math.round(sol*LAMPORTS_PER_SOL)})),[payer]);
}
// Devnet HYPE test mint: 9 decimals, same as Mainnet HYPE; the deployer is its mint authority.
async function testHype(payer,owner,amount) {
  if (!(await connection.getAccountInfo(hype)))
    await submit('create Devnet HYPE test mint (9 decimals)',new Transaction().add(
      SystemProgram.createAccount({fromPubkey:payer.publicKey,newAccountPubkey:hype,space:MINT_SIZE,lamports:await getMinimumBalanceForRentExemptMint(connection),programId:TOKEN_PROGRAM_ID}),
      createInitializeMint2Instruction(hype,9,payer.publicKey,null)),[payer,hypeMintKey]);
  const ata=getAssociatedTokenAddressSync(hype,owner);
  await submit(`mint ${amount/1_000_000_000n} test HYPE`,new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(payer.publicKey,ata,owner,hype),createMintToInstruction(hype,ata,payer.publicKey,amount)),[payer]);
  return ata;
}

async function nativeSplit(payer,platform) {
  // Phase 1 (what runs on Mainnet today): Meteora alone enforces 20% platform / 80% creator. No HYMET program.
  await testHype(payer,payer.publicKey,50_000_000_000n);
  const sdk=new DynamicBondingCurveClient(connection,'confirmed');
  const config=Keypair.generate(),base=Keypair.generate();
  const params=curve({...defaults,name:'Devnet Native',symbol:'DNAT'},payer.publicKey);
  await submit('DBC create_config2 (native split: feeClaimer = platform, creator 80%)',await sdk.partner.createConfig2({...params,config:config.publicKey,feeClaimer:platform.publicKey,leftoverReceiver:payer.publicKey,quoteMint:hype,payer:payer.publicKey,transferFeeParameters:null}),[payer,config]);
  const pool=deriveDbcPoolAddress(hype,base.publicKey,config.publicKey);
  await submit('DBC create_pool (native split)',await sdk.creator.createPool({name:'Devnet Native',symbol:'DNAT',uri:'https://example.invalid/devnet-native.json',payer:payer.publicKey,poolCreator:payer.publicKey,config:config.publicKey,baseMint:base.publicKey}),[payer,base]);
  assert.equal((await readPlatformFees(appConnection,'mainnet-beta',pool.toBase58(),platform.publicKey)).creatorShare,80);
  // The app's trade route: pool verification, quote, slippage floor and simulation, then a real Devnet transaction.
  const swap=(side,amount,slippageBps=100)=>prepareDbcSwap(appConnection,{mint:base.publicKey.toBase58(),pool:pool.toBase58(),wallet:payer.publicKey,side,amount,slippageBps,platform:platform.publicKey});
  const t0=await bal(payer.publicKey,base.publicKey);
  const buy=await swap('buy','5');
  await submit('app DBC buy 5 test HYPE (1% slippage)',buy.tx,[payer],{keepBudget:true});
  const bought=await bal(payer.publicKey,base.publicKey)-t0;
  assert(bought>=buy.minimumOut,'buy delivered less than the slippage floor');
  const h0=await bal(payer.publicKey,hype);
  const sell=await swap('sell',formatUnits(bought/2n,9));
  await submit('app DBC sell half (1% slippage)',sell.tx,[payer],{keepBudget:true});
  const received=await bal(payer.publicKey,hype)-h0;
  assert(received>=sell.minimumOut&&received>0n,'sell delivered less than the slippage floor');
  await rejectedBuild('sell above balance',swap('sell','1000000000'),/Insufficient token balance/);
  await rejectedBuild('slippage above 50%',swap('buy','1',5001),/Slippage/);
  const partnerFee=(await readPlatformFees(appConnection,'mainnet-beta',pool.toBase58(),platform.publicKey)).quote;
  const creatorFee=(await readCreatorFees(appConnection,'mainnet-beta',pool.toBase58())).quote;
  const total=partnerFee+creatorFee;
  assert(total>0n,'no DBC fees accrued');
  assert(partnerFee*10000n/total>=1999n&&partnerFee*10000n/total<=2001n,'platform share is not 20%');
  await rejectedBuild('creator claim by the platform wallet',prepareCreatorClaim(appConnection,'mainnet-beta',pool.toBase58(),platform.publicKey),/not this pool's creator/);
  await rejectedBuild('platform claim by the creator wallet',preparePlatformClaim(appConnection,'mainnet-beta',pool.toBase58(),payer.publicKey),/fee claimer/);
  const p0=await bal(platform.publicKey,hype);
  await submit('platform claims 20% DBC fees (app builder)',(await preparePlatformClaim(appConnection,'mainnet-beta',pool.toBase58(),platform.publicKey)).tx,[platform],{keepBudget:true});
  assert.equal(await bal(platform.publicKey,hype)-p0,partnerFee);
  const c0=await bal(payer.publicKey,hype);
  await submit('creator claims 80% DBC fees (app builder)',(await prepareCreatorClaim(appConnection,'mainnet-beta',pool.toBase58(),payer.publicKey)).tx,[payer],{keepBudget:true});
  assert.equal(await bal(payer.publicKey,hype)-c0,creatorFee);
  await rejectedBuild('platform double claim',preparePlatformClaim(appConnection,'mainnet-beta',pool.toBase58(),platform.publicKey),/No DBC platform trading fees/);
  const result={mint:base.publicKey.toBase58(),pool:pool.toBase58(),trades:{boughtTokens:bought.toString(),soldTokens:sell.amountIn.toString(),hypeOut:received.toString()},fees:{total:total.toString(),platform:partnerFee.toString(),creator:creatorFee.toString()}};
  save('native',result);
  console.log(JSON.stringify(result));
  console.log('PASS: Devnet native split: launch, app buy/sell, 20% platform / 80% creator claims, wrong-wallet and double claims rejected');
}

// Automatic distributor flow (7c9b9e2): fresh 5/95 and 0/100 launches; holders trade through the app's swap builders;
// the unmodified keeper (scripts/devnet-keeper.cjs) settles, migrates the complete curve to DAMM v2 and pays holders.
// No creator action after launch. Every amount is reconciled against swap events, fee-pool counters and the test DB.
async function automatic(payer,platform,snapshot,program) {
  const dbUrl=process.env.HYMET_DEVNET_DATABASE_URL||'';
  assert(/\/hymet_devnet\w*(\?|$)/.test(dbUrl),'HYMET_DEVNET_DATABASE_URL must point at a hymet_devnet* test database');
  const {Client}=require('pg');
  const db=new Client({connectionString:dbUrl});
  await db.connect();
  // Always release the DB connection so a failed check exits instead of keeping the process alive.
  try { await automaticFlow(payer,platform,snapshot,program,db); } finally { await db.end(); }
}
async function automaticFlow(payer,platform,snapshot,program,db) {
  const dbUrl=process.env.HYMET_DEVNET_DATABASE_URL;
  const q=async(sql,args=[])=>(await db.query(sql,args)).rows;
  const check=(label,ok,detail)=>{ assert(ok,`${label}: ${detail}`); execution.push({result:'PASS',label,detail}); console.log(`PASS ${label} — ${detail}`); };
  // Earlier phases' tokens are not in this test DB; the indexer starts after them (it fails closed on unknown tokens).
  const latest=(await connection.getSignaturesForAddress(program,{limit:1},'confirmed'))[0];
  if (latest && !(await q('SELECT 1 FROM indexer_checkpoints WHERE source=$1',[program.toBase58()])).length)
    await q('INSERT INTO indexer_checkpoints(source,last_slot,last_signature) VALUES($1,$2,$3)',[program.toBase58(),latest.slot,latest.signature]);
  // The DB keeps the app's logical HYPE label (the indexer requires it); on-chain the Devnet test mint is used.
  const HYPE_LABEL=MAINNET_HYPE;
  await fundSol(payer,snapshot.publicKey,'keeper (snapshot authority; pays migration rent)',0.3);
  if (rehearsal && (await connection.getBalance(new PublicKey('FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM')))<100_000_000)
    throw Error('Rehearsal: fund the DBC pool authority on the loopback validator first (devnet-rehearsal.sh does this)');
  const holderA=Keypair.fromSeed(createHash('sha256').update('HYMET DEVNET AUTO HOLDER A').digest());
  const holderB=Keypair.fromSeed(createHash('sha256').update('HYMET DEVNET AUTO HOLDER B').digest());
  for (const [label,h] of [['holder A',holderA],['holder B',holderB]]) { await fundSol(payer,h.publicKey,label,0.03); if ((await bal(h.publicKey,hype))<300_000_000_000n) await testHype(payer,h.publicKey,300_000_000_000n); }
  const sdk=new DynamicBondingCurveClient(connection,'confirmed'), dammCoder=new BorshEventCoder(CpAmmIdl);
  const keeperEnv={...process.env,DATABASE_URL:dbUrl,HYMET_DEVNET_DIR:dir,HYMET_DISTRIBUTOR_PROGRAM_ID:program.toBase58(),HYMET_KEEPER_KEYPAIR:`${dir}/keys/snapshot.json`,HYMET_KEEPER_RPC_URL:rpcUrl,MAINNET_RPC_URL:rpcUrl,HYMET_PLATFORM_FEE_RECIPIENT:platform.publicKey.toBase58(),HYMET_AUTO_MIGRATE:'all',ENABLE_MAINNET:'false',NEXT_PUBLIC_ENABLE_MAINNET:'false'};
  const runKeeper=(label)=>{
    const out=execFileSync(process.execPath,[path.join(__dirname,'devnet-keeper.cjs'),'--send','--min-payout=1'],{env:keeperEnv,cwd:path.join(__dirname,'..'),encoding:'utf8',timeout:1_200_000,maxBuffer:64*1024*1024});
    const lines=out.split('\n').flatMap(l=>{ try { return l.startsWith('{')?[JSON.parse(l)]:[]; } catch { return []; } });
    console.log(`PASS keeper run (${label}): ${lines.filter(l=>/^(migrate|settle|fund epoch|pay chunk|close epoch)/.test(l.message)).map(l=>l.message).join(', ')}`);
    return lines;
  };
  const paidByWallet=async(mint)=>Object.fromEntries((await q('SELECT wallet_address w,sum(claimed_amount)::text p FROM holder_reward_entitlements WHERE mint_address=$1 GROUP BY 1',[mint])).map(r=>[r.w,BigInt(r.p)]));
  const feeEvents=async(sig)=>{
    const tx=await connection.getTransaction(sig,{commitment:'confirmed',maxSupportedTransactionVersion:0});
    const keys=tx.transaction.message.staticAccountKeys, out=[];
    for (const inner of tx.meta.innerInstructions||[]) for (const ix of inner.instructions) {
      const data=Buffer.from((require('bs58').default||require('bs58')).decode(ix.data)).subarray(8).toString('base64');
      if (keys[ix.programIdIndex].equals(sdk.program.programId)) { let ev; try { ev=sdk.program.coder.events.decode(data); } catch { /* not an event */ }
        if (ev?.name==='evtSwap3') { const e=ev.data,buy=e.tradeDirection===1,fee=BigInt(e.tradingFee.toString())+BigInt(e.protocolFee.toString())+BigInt(e.referralFee.toString());
          out.push({sig,venue:'DBC',gross:buy?BigInt(e.includedTransferFeeAmountIn.toString()):BigInt(e.includedTransferFeeAmountOut.toString())+fee,fee,protocol:BigInt(e.protocolFee.toString()),eligible:BigInt(e.tradingFee.toString())}); } }
      else if (keys[ix.programIdIndex].toBase58()==='cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG') { let ev; try { ev=dammCoder.decode(data); } catch { /* not an event */ }
        if (ev?.name==='EvtSwap2') { const r=ev.data.swap_result,buy=ev.data.trade_direction===1,lp=BigInt(r.claiming_fee.toString())+BigInt(r.compounding_fee.toString()),protocol=BigInt(r.protocol_fee.toString()),fee=lp+protocol+BigInt(r.referral_fee.toString());
          out.push({sig,venue:'DAMM v2',gross:buy?BigInt(r.included_fee_input_amount.toString()):BigInt(r.output_amount.toString())+fee,fee,protocol,eligible:lp}); } }
    }
    assert(out.length===1,`expected one swap event in ${sig}`);
    return out[0];
  };
  const launches=[];
  for (const creatorBps of [500,0]) {
    const tag=`${creatorBps/100}/${100-creatorBps/100}`;
    const config=Keypair.generate(),base=Keypair.generate(),mint=base.publicKey.toBase58();
    const [feePool]=PublicKey.findProgramAddressSync([Buffer.from('fee-pool'),base.publicKey.toBuffer()],program);
    const parameters=distributorCurve({...defaults,name:'Devnet Auto',symbol:'DAUT',creatorShare:String(creatorBps/100)},payer.publicKey);
    await submit(`[${tag}] DBC create_config2 (1% fee, fee claimer = distributor PDA)`,await sdk.partner.createConfig2({...parameters,config:config.publicKey,feeClaimer:feePool,leftoverReceiver:payer.publicKey,quoteMint:hype,payer:payer.publicKey,transferFeeParameters:null}),[payer,config]);
    const cfg=await sdk.state.getPoolConfig(config.publicKey);
    check(`[${tag}] configured trading fee 1%`,cfg.poolFees.baseFee.cliffFeeNumerator.toString()==='10000000'&&cfg.migratedPoolFeeBps===100,`DBC ${cfg.poolFees.baseFee.cliffFeeNumerator}/1e9, migrated ${cfg.migratedPoolFeeBps} bps`);
    const pool=deriveDbcPoolAddress(hype,base.publicKey,config.publicKey);
    const launchTx=await sdk.creator.createPool({name:'Devnet Auto',symbol:'DAUT',uri:'https://example.invalid/devnet-auto.json',payer:payer.publicKey,poolCreator:payer.publicKey,config:config.publicKey,baseMint:base.publicKey});
    launchTx.add(createDistributorPool(program,base.publicKey,payer.publicKey,pool,creatorBps));
    await submit(`[${tag}] atomic token/DBC pool/distributor launch`,launchTx,[payer,base]);
    await verifyDistributorPool(connection,program,base.publicKey,payer.publicKey,pool,creatorBps);
    const unique=`devauto${creatorBps}${mint.slice(0,8)}`.toLowerCase();
    await q('INSERT INTO creators(wallet_address) VALUES($1) ON CONFLICT DO NOTHING',[payer.publicKey.toBase58()]);
    const reservation=await q("INSERT INTO launch_reservations(creator_wallet,name,ticker,name_key,ticker_key,status,idempotency_key,expires_at) VALUES($1,$2,$2,$2,$2,'confirmed',$2,now()+interval '1 hour') RETURNING id",[payer.publicKey.toBase58(),unique]);
    const launchSig=execution.at(-1).signature, slot=(await connection.getSignatureStatuses([launchSig],{searchTransactionHistory:true})).value[0].slot;
    await q("INSERT INTO tokens(mint_address,reservation_id,creator_wallet,name,ticker,name_key,ticker_key,description,metadata_uri,artwork_uri,quote_mint,trading_fee_bps,creator_share_of_remaining_bps,holder_share_of_remaining_bps,status,launch_signature,confirmed_slot,distributor_program_id,distributor_fee_pool) VALUES($1,$2,$3,$4,$4,$4,$4,'Devnet automatic flow','https://example.invalid/devnet-auto.json','https://example.invalid/devnet-auto.png',$5,100,$6,$7,'bonding',$8,$9,$10,$11)",[mint,reservation[0].id,payer.publicKey.toBase58(),unique,HYPE_LABEL,creatorBps,10000-creatorBps,launchSig,slot,program.toBase58(),feePool.toBase58()]);
    await q("INSERT INTO pools(pool_address,mint_address,protocol,quote_mint,status) VALUES($1,$2,'meteora_dbc',$3,'active')",[pool.toBase58(),mint,HYPE_LABEL]);
    launches.push({tag,creatorBps,mint,base,pool,feePool,trades:[]});
  }
  const fp=async(l)=>decodeFeePool((await connection.getAccountInfo(l.feePool,'confirmed')).data);
  const app=(l,wallet,side,amount)=>prepareDbcSwap(appConnection,{mint:l.mint,pool:l.pool.toBase58(),wallet:wallet.publicKey,side,amount,slippageBps:100,platform:platform.publicKey});
  const trade=async(l,label,plan,signer)=>{ await submit(`[${l.tag}] ${label}`,plan.tx,[signer],{keepBudget:true}); l.trades.push(await feeEvents(execution.at(-1).signature)); return plan; };
  const platformHype=getAssociatedTokenAddressSync(hype,platform.publicKey);
  await submit('platform HYPE ATA',new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(payer.publicKey,platformHype,platform.publicKey,hype)),[payer]);
  // One keeper phase: wallet HYPE deltas must equal exactly the payouts indexed in that run; the platform gets exactly 20%.
  const keeperPhase=async(label)=>{
    const wallets=[holderA.publicKey,holderB.publicKey,payer.publicKey];
    const before={bal:await Promise.all(wallets.map(w=>bal(w,hype))),platform:await bal(platform.publicKey,hype),paid:await Promise.all(launches.map(l=>paidByWallet(l.mint))),pools:await Promise.all(launches.map(fp))};
    const log=runKeeper(label);
    const after={bal:await Promise.all(wallets.map(w=>bal(w,hype))),platform:await bal(platform.publicKey,hype),paid:await Promise.all(launches.map(l=>paidByWallet(l.mint))),pools:await Promise.all(launches.map(fp))};
    wallets.forEach((w,i)=>{ const paid=launches.reduce((s,_,j)=>s+(after.paid[j][w.toBase58()]??0n)-(before.paid[j][w.toBase58()]??0n),0n);
      check(`${label}: ${['holder A','holder B','creator'][i]} HYPE rose by exactly its automatic payouts`,after.bal[i]-before.bal[i]===paid,`delta ${after.bal[i]-before.bal[i]}, payouts ${paid}`); });
    const platformIn=launches.reduce((s,_,j)=>s+after.pools[j].totalPlatform-before.pools[j].totalPlatform,0n);
    check(`${label}: platform wallet received exactly the 20% shares settled`,after.platform-before.platform===platformIn,`+${after.platform-before.platform}`);
    return log;
  };

  for (const l of launches) {
    await trade(l,'holder A app buy 30 test HYPE (DBC)',await app(l,holderA,'buy','30'),holderA);
    await trade(l,'holder B app buy 40 test HYPE (DBC)',await app(l,holderB,'buy','40'),holderB);
    await trade(l,'holder B app sell 25% (DBC)',await app(l,holderB,'sell',formatUnits((await bal(holderB.publicKey,l.base.publicKey))/4n,9)),holderB);
  }
  const k1=await keeperPhase('keeper run 1 (DBC fees)');
  for (const l of launches) check(`[${l.tag}] keeper left the bonding curve alone`,k1.some(x=>x.message==='migration check'&&x.data?.mint===l.mint&&/^bonding/.test(x.data.status)),'status bonding');

  for (const l of launches) {
    const plan=await app(l,holderB,'buy','200');
    check(`[${l.tag}] final app buy fills exactly to the curve end`,plan.requestedIn===200_000_000_000n&&plan.amountIn<plan.requestedIn,`spends ${plan.amountIn} of ${plan.requestedIn}`);
    await trade(l,'holder B curve-completing app buy (PartialFill)',plan,holderB);
    const st=(await sdk.state.getPool(l.pool)).poolState, c=await sdk.state.getPoolConfig(st.config);
    check(`[${l.tag}] curve complete and ready for migration`,BigInt(st.quoteReserve.toString())>=BigInt(c.migrationQuoteThreshold.toString())&&st.migrationProgress===2&&st.isMigrated===0,`reserve ${st.quoteReserve}, progress ${st.migrationProgress}`);
  }
  const k2=await keeperPhase('keeper run 2 (graduation)');
  for (const l of launches) {
    const m=k2.find(x=>x.message==='migration check'&&x.data?.mint===l.mint);
    check(`[${l.tag}] keeper migrated the pool to DAMM v2 itself`,m?.data?.status==='migrated'&&Boolean(m.data.signature),`${m?.data?.signature}`);
    const st=(await sdk.state.getPool(l.pool)).poolState, c=await sdk.state.getPoolConfig(st.config);
    l.damm=deriveDammV2PoolAddress(DAMM_V2_MIGRATION_FEE_ADDRESS[c.migrationFeeOption],l.base.publicKey,hype);
    check(`[${l.tag}] DBC migrated; derived DAMM v2 pool exists`,st.isMigrated===1&&Boolean(await connection.getAccountInfo(l.damm,'confirmed')),l.damm.toBase58());
    await q("UPDATE pools SET status='migrated' WHERE pool_address=$1",[l.pool.toBase58()]);
  }

  for (const l of launches) {
    const damm=(wallet,side,amount)=>prepareDammSwap(appConnection,{mint:l.mint,dbcPool:l.pool.toBase58(),pool:l.damm.toBase58(),wallet:wallet.publicKey,side,amount,slippageBps:100,platform:platform.publicKey});
    await trade(l,'holder A app buy 10 test HYPE (DAMM v2)',await damm(holderA,'buy','10'),holderA);
    await trade(l,'holder B app sell 50% (DAMM v2)',await damm(holderB,'sell',formatUnits((await bal(holderB.publicKey,l.base.publicKey))/2n,9)),holderB);
  }
  await keeperPhase('keeper run 3 (DAMM v2 fees)');
  // Settlement after migration first drains any unsettled DBC fees; the keeper registers the DAMM v2 pool on its next run.
  for (const l of launches) check(`[${l.tag}] fee pool registered the derived DAMM v2 pool`,(await fp(l)).dammPool.equals(l.damm),l.damm.toBase58());

  for (const l of launches) {
    const f=await fp(l), cb=BigInt(l.creatorBps);
    for (const t of l.trades) { const exp=t.gross*100n/10_000n;
      check(`[${l.tag}] ${t.venue} ${t.sig.slice(0,8)} fee 1%, Meteora 20%`,t.fee>=exp&&t.fee<=exp+1n&&t.protocol===t.fee*2000n/10_000n,`gross ${t.gross} fee ${t.fee}`); }
    const eligible=l.trades.reduce((s,t)=>s+t.eligible,0n);
    const st=await q('SELECT distributable_amount d,hymet_amount h,creator_amount c,holder_amount o FROM fee_settlements WHERE mint_address=$1',[l.mint]);
    const sum=(k)=>st.reduce((s,r)=>s+BigInt(r[k]),0n), D=sum('d'),H=sum('h'),C=sum('c'),O=sum('o');
    check(`[${l.tag}] every settlement: HYMET 20%, creator ${l.creatorBps/100}% / holders ${100-l.creatorBps/100}%`,st.length>0&&st.every(r=>BigInt(r.h)===BigInt(r.d)*2000n/10_000n&&BigInt(r.c)===(BigInt(r.d)-BigInt(r.h))*cb/10_000n&&BigInt(r.h)+BigInt(r.c)+BigInt(r.o)===BigInt(r.d)),`${st.length} settlements`);
    check(`[${l.tag}] settled = eligible DBC + DAMM v2 swap fees (Meteora rounds DAMM down by ≤2)`,D<=eligible&&D>=eligible-2n,`DB ${D}, swaps ${eligible}`);
    check(`[${l.tag}] DB totals = on-chain counters`,D===f.totalSettled&&H===f.totalPlatform,`settled ${f.totalSettled}, platform ${f.totalPlatform}`);
    check(`[${l.tag}] creator share = on-chain claimable`,C===f.creatorClaimable&&(cb>0n||f.creatorClaimable===0n),`${C}`);
    const ent=await q('SELECT e.reward_amount r,e.claimed_amount p,h.status FROM holder_reward_entitlements e JOIN holder_reward_epochs h USING(mint_address,epoch) WHERE e.mint_address=$1',[l.mint]);
    const paid=ent.reduce((s,r)=>s+BigInt(r.p),0n);
    check(`[${l.tag}] holders: settled = paid + unallocated + reserved; all paid and closed`,O===paid+f.holderUnallocated+f.holderReserved&&ent.length>0&&ent.every(r=>r.r===r.p&&r.status==='closed'),`${O} = ${paid} + ${f.holderUnallocated} + ${f.holderReserved}`);
    const vault=(await getAccount(connection,getAssociatedTokenAddressSync(hype,l.feePool,true))).amount;
    check(`[${l.tag}] HYPE vault = recorded liabilities`,vault===f.creatorClaimable+f.holderUnallocated+f.holderReserved,`vault ${vault}`);
  }
  save('automatic',{program:program.toBase58(),launches:launches.map(l=>({tag:l.tag,mint:l.mint,dbcPool:l.pool.toBase58(),dammPool:l.damm.toBase58(),trades:l.trades.map(t=>({...t,gross:t.gross.toString(),fee:t.fee.toString(),protocol:t.protocol.toString(),eligible:t.eligible.toString()}))}))});
  console.log('PASS: Devnet automatic flow (5/95, 0/100): app trades, keeper settlement, automatic DAMM v2 migration, push payouts, exact accounting');
}

(async()=>{
  const genesis=await connection.getGenesisHash();
  assert(rehearsal?genesis!==MAINNET_GENESIS:genesis===DEVNET_GENESIS,'RPC is not Devnet');
  const payer=key('deployer'),platform=key('platform'),snapshot=key('snapshot');
  const production=['9X9fnj4Uh9WC9nmxCahTVsixHZ6VGxNpMesuGhK239Px','2LWe6h2qEqj2BKD3T8hNdqPmsPaZcBvFgArfzGW4Ethe','GHydbkZNJk6STZuA9WWL5Xy5ohHbMmnraxTwQNt4RL9K','9G9v3Ax4K2prmVQfDzp2HY6YYZ5UFmCo24761pgEmMo7','7sAoyG3ZdewKrZKLzU8VTpfzNh6YuJKQAgnWjgjSqPEs','719pLtfhA7BinfgqEgtpfzxL6FcMChQxHYLiwJ6BSvGK','GHZHuBqZvmixBDHsApwEJeW3dCgR1p39UPNszHeuoL8S'];
  for (const k of [payer,platform,snapshot,hypeMintKey,key('program')]) assert(!production.includes(k.publicKey.toBase58()),'Refusing a production key');
  console.log(JSON.stringify({deployer:payer.publicKey.toBase58(),platform:platform.publicKey.toBase58(),snapshot:snapshot.publicKey.toBase58(),hype:hype.toBase58(),payerSol:(await connection.getBalance(payer.publicKey))/LAMPORTS_PER_SOL}));
  await fundSol(payer,platform.publicKey,'platform',0.05);

  if (process.argv.includes('--native')) return nativeSplit(payer,platform);

  const idl=JSON.parse(fs.readFileSync(`${programTarget}/idl/hymet_rewards_distributor.json`,'utf8'));
  const program=new PublicKey(idl.address);
  assert(program.equals(key('program').publicKey),'Devnet build IDL is not the Devnet Program ID');
  const distributor=new Program({...idl,address:program.toBase58()},{connection});
  const [globalConfig]=PublicKey.findProgramAddressSync([Buffer.from('config')],program);
  const [programData]=PublicKey.findProgramAddressSync([program.toBuffer()],new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'));
  const initialize=signer=>distributor.methods.initialize(snapshot.publicKey).accountsPartial({authority:signer.publicKey,platformWallet:platform.publicKey,config:globalConfig,program,programData,systemProgram:SystemProgram.programId}).transaction();
  assert((await connection.getAccountInfo(program))?.executable,'Devnet distributor is not deployed (see devnet-run.sh)');
  await fundSol(payer,snapshot.publicKey,'snapshot',0.05);

  if (process.argv.includes('--pre-init')) {
    if (!(await connection.getAccountInfo(globalConfig))) {
      await rejected('non-upgrade-authority initialize (platform wallet)',await initialize(platform),[platform],'NotUpgradeAuthority');
      await rejected('non-upgrade-authority initialize (snapshot authority)',await initialize(snapshot),[snapshot],'NotUpgradeAuthority');
      await submit('initialize Devnet distributor (upgrade authority)',await initialize(payer),[payer]);
    }
    save('init',{program:program.toBase58()});
    return;
  }

  const state=await connection.getAccountInfo(globalConfig);
  assert(state,'config not initialized; run --pre-init first');
  assert(state.data.subarray(8,40).equals(payer.publicKey.toBuffer())&&state.data.subarray(40,72).equals(platform.publicKey.toBuffer())&&state.data.subarray(72,104).equals(snapshot.publicKey.toBuffer()),'config does not match Devnet test authorities');
  if (process.argv.includes('--automatic')) return automatic(payer,platform,snapshot,program);
  await rejected('re-initialize by upgrade authority (replay)',await initialize(payer),[payer],'already in use');
  const traderHype=await testHype(payer,payer.publicKey,1000_000_000_000n);

  const creatorBps=Number(process.env.HYMET_DEVNET_CREATOR_BPS??7300);
  const creatorPart=r=>r*BigInt(creatorBps)/10000n;
  const config=Keypair.generate(),base=Keypair.generate();
  const [feePool]=PublicKey.findProgramAddressSync([Buffer.from('fee-pool'),base.publicKey.toBuffer()],program);
  const sdk=new DynamicBondingCurveClient(connection,'confirmed');
  const parameters=distributorCurve({...defaults,name:'Devnet HYMET',symbol:'DHY',creatorShare:String(creatorBps/100)},payer.publicKey);
  await submit('DBC create_config2 (HYPE quote, fee claimer = distributor PDA)',await sdk.partner.createConfig2({...parameters,config:config.publicKey,feeClaimer:feePool,leftoverReceiver:payer.publicKey,quoteMint:hype,payer:payer.publicKey,transferFeeParameters:null}),[payer,config]);
  const pool=deriveDbcPoolAddress(hype,base.publicKey,config.publicKey);
  const launchTransaction=await sdk.creator.createPool({name:'Devnet HYMET',symbol:'DHY',uri:'https://example.invalid/devnet.json',payer:payer.publicKey,poolCreator:payer.publicKey,config:config.publicKey,baseMint:base.publicKey});
  launchTransaction.add(createDistributorPool(program,base.publicKey,payer.publicKey,pool,creatorBps));
  await submit(`atomic token/DBC pool/distributor launch (${creatorBps/100}/${100-creatorBps/100})`,launchTransaction,[payer,base]);
  await verifyDistributorPool(connection,program,base.publicKey,payer.publicKey,pool,creatorBps);
  const proof={program:program.toBase58(),mint:base.publicKey.toBase58(),dbcPool:pool.toBase58(),feePool:feePool.toBase58(),creatorBps};
  save('distributor',proof);

  const hypeVault=getAssociatedTokenAddressSync(hype,feePool,true);
  const platformHype=getAssociatedTokenAddressSync(hype,platform.publicKey);
  await submit('platform HYPE ATA',new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(payer.publicKey,platformHype,platform.publicKey,hype)),[payer]);
  const claim=await sdk.partner.claimPartnerTradingFee({feeClaimer:feePool,payer:payer.publicKey,pool,maxBaseAmount:new BN('18446744073709551615'),maxQuoteAmount:new BN('18446744073709551615')});
  const claimIx=claim.instructions.find(ix=>ix.programId.equals(sdk.program.programId));
  assert(claimIx,'SDK claim instruction missing');
  const settle=()=>new Transaction().add(distributorSettlement(program,base.publicKey,platform.publicKey,payer.publicKey,claimIx));
  await submit('DBC buy with 1 test HYPE (accrue real fees)',await sdk.pool.swap({owner:payer.publicKey,pool,amountIn:new BN('1000000000'),minimumAmountOut:new BN(1),swapBaseForQuote:false,referralTokenAccount:null}),[payer]);
  const held=await bal(payer.publicKey,base.publicKey);
  await submit('DBC sell 10% of tokens (accrue real fees)',await sdk.pool.swap({owner:payer.publicKey,pool,amountIn:new BN((held/10n).toString()),minimumAmountOut:new BN(1),swapBaseForQuote:true,referralTokenAccount:null}),[payer]);
  const platformBefore=(await getAccount(connection,platformHype)).amount;
  await submit('settle_dbc (real CPI into Devnet DBC)',settle(),[payer]);
  const platformDelta=(await getAccount(connection,platformHype)).amount-platformBefore;
  const vaultDelta=(await getAccount(connection,hypeVault)).amount;
  const total=platformDelta+vaultDelta;
  assert(total>0n,'No distributable HYPE fee was received');
  assert.equal(platformDelta,total*2000n/10000n,'platform share is not 20%');
  const ledger=await distributor.account.feePool.fetch(feePool);
  assert.equal(BigInt(ledger.creatorClaimable.toString())+BigInt(ledger.holderUnallocated.toString()),vaultDelta);
  assert.equal(BigInt(ledger.creatorClaimable.toString()),creatorPart(vaultDelta));
  const split={distributable:total.toString(),platform20:platformDelta.toString(),creatorAndHolders80:vaultDelta.toString(),creator:ledger.creatorClaimable.toString(),holders:ledger.holderUnallocated.toString()};
  console.log(JSON.stringify({dbcSplit:split}));
  const attackerHype=getAssociatedTokenAddressSync(hype,snapshot.publicKey);
  await submit('attacker HYPE ATA (for redirect attempt)',new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(payer.publicKey,attackerHype,snapshot.publicKey,hype)),[payer]);
  await rejected('settle_dbc redirecting the 20% to another wallet',new Transaction().add(distributorSettlement(program,base.publicKey,snapshot.publicKey,payer.publicKey,claimIx)),[payer],'ConstraintTokenOwner');

  const creatorAmount=BigInt(ledger.creatorClaimable.toString());
  const creatorBefore=(await getAccount(connection,traderHype)).amount;
  await rejected('unauthorized creator claim',await distributor.methods.claimCreator().accountsPartial({feePool,creator:platform.publicKey,hypeVault,creatorHype:platformHype,hypeMint:hype,tokenProgram:TOKEN_PROGRAM_ID}).transaction(),[platform],'ConstraintHasOne');
  const creatorClaim=()=>new Transaction().add(creatorDistributorClaim(program,base.publicKey,payer.publicKey));
  await submit('creator HYPE claim',creatorClaim(),[payer]);
  assert.equal((await getAccount(connection,traderHype)).amount-creatorBefore,creatorAmount);
  await rejected('creator double claim',creatorClaim(),[payer],'NothingToClaim');

  // v2 automatic holder payouts: the keeper commits a chunked root, then anyone pushes chunks; holders never sign.
  const holderTotal=BigInt(ledger.holderUnallocated.toString());
  const balance=await bal(payer.publicKey,base.publicKey);
  const extra=Array.from({length:7},(_,i)=>Keypair.fromSeed(createHash('sha256').update(`HYMET DEVNET TEST HOLDER ${i}`).digest()).publicKey);
  const holders=eligibleHolders([{owner:payer.publicKey.toBase58(),amount:balance,state:1},...extra.map((k,i)=>({owner:k.toBase58(),amount:balance*BigInt(i+1)/4n,state:1}))]);
  const testPolicy={...HOLDER_PAYOUT_POLICY,minPayout:1n,minPayoutNewAccount:1n};
  const mintText=base.publicKey.toBase58(),allHave=()=>true;
  const snapshotSlot=BigInt((await connection.getSlot('confirmed'))-1);
  const plan=planHolderEpoch({mint:mintText,epoch:0n,snapshotSlot,available:holderTotal/2n,holders,hasHypeAccount:allHave,policy:testPolicy});
  assert.equal(plan.chunks.length,2);
  const funded=plan.fundedAmount;
  const fund=(authority,amount,p=plan)=>new Transaction().add(fundDistributorEpoch(program,base.publicKey,authority,{epoch:p.epoch,snapshotSlot:p.snapshotSlot,snapshotHash:p.snapshotHash.toString('hex'),root:p.root.toString('hex'),amount,chunkCount:p.chunks.length}));
  const crank=Keypair.generate();
  await fundSol(payer,crank.publicKey,'one-off crank',0.01);
  const chunkTx=(c,epochNumber=0n,mutate=(e)=>e)=>new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({units:200000}),distributeHolderChunk(program,base.publicKey,crank.publicKey,{epoch:epochNumber,chunkIndex:c.index,entries:c.entries.map(mutate),proof:c.proof}));
  const close=(epochNumber,authority=snapshot)=>new Transaction().add(closeHolderEpoch(program,base.publicKey,authority.publicKey,epochNumber));
  await rejected('epoch funding by creator',fund(payer.publicKey,funded),[payer],'Unauthorized');
  await rejected('epoch funding by platform wallet',fund(platform.publicKey,funded),[platform],'Unauthorized');
  await rejected('epoch overfunding',fund(snapshot.publicKey,holderTotal+1n),[snapshot],'InsufficientFunds');
  await submit('fund committed holder payout epoch 0 (2 chunks, snapshot authority)',fund(snapshot.publicKey,funded),[snapshot]);
  await rejected('epoch funding replay',fund(snapshot.publicKey,funded),[snapshot],'already in use');
  await submit('create holder HYPE accounts',new Transaction().add(...extra.map(k=>createAssociatedTokenAccountIdempotentInstruction(payer.publicKey,getAssociatedTokenAddressSync(hype,k),k,hype))),[payer]);
  await rejected('tampered payout amount',chunkTx(plan.chunks[0],0n,(e,i)=>i===0?{...e,reward:e.reward+1n}:e),[crank],'InvalidProof');
  const redirected=chunkTx(plan.chunks[0]);
  redirected.instructions[1].keys[7].pubkey=platformHype;
  await rejected('payout redirected to another HYPE account',redirected,[crank],'InvalidRecipient');
  await rejected('close while paying out',close(0n),[snapshot],'EpochActive');
  const before0=await Promise.all(plan.payouts.map(p=>bal(new PublicKey(p.wallet),hype)));
  await submit('permissionless push of chunk 0 (holders do not sign)',chunkTx(plan.chunks[0]),[crank]);
  await rejected('chunk replay',chunkTx(plan.chunks[0]),[crank],'AlreadyPaid');
  await submit('permissionless push of chunk 1',chunkTx(plan.chunks[1]),[crank]);
  const after0=await Promise.all(plan.payouts.map(p=>bal(new PublicKey(p.wallet),hype)));
  plan.payouts.forEach((p,i)=>assert.equal(after0[i]-before0[i],p.reward));
  await rejected('close by non-authority',close(0n,payer),[payer],'Unauthorized');
  await submit('close fully paid epoch 0',close(0n),[snapshot]);
  assert.equal(await connection.getAccountInfo(holderEpochAddress(program,base.publicKey,0n)),null);
  const remainingHolders=holderTotal-funded;
  const single=[{wallet:payer.publicKey.toBase58(),tokenBalance:balance}];
  const over=planHolderEpoch({mint:mintText,epoch:1n,snapshotSlot:BigInt((await connection.getSlot('confirmed'))-1),available:remainingHolders+1n,holders:single,hasHypeAccount:allHave,policy:testPolicy});
  await submit('fund adversarial over-committed epoch 1',fund(snapshot.publicKey,remainingHolders,over),[snapshot]);
  const vaultBeforeRejected=(await getAccount(connection,hypeVault)).amount;
  await rejected('valid-proof overpayment beyond funded epoch',chunkTx(over.chunks[0],1n),[crank],'OverClaim');
  assert.equal((await getAccount(connection,hypeVault)).amount,vaultBeforeRejected);
  const finalLedger=await distributor.account.feePool.fetch(feePool);
  assert.equal(BigInt(finalLedger.holderReserved.toString()),remainingHolders);
  assert.equal((await getAccount(connection,hypeVault)).amount,remainingHolders);
  save('distributor',{...proof,dbcSplit:split,holderPayouts:{holders:plan.payouts.length,chunks:plan.chunks.length,funded:funded.toString()}});
  console.log('PASS: Devnet DBC settlement at the selected split, creator claim, push payouts, replay/redirect/tamper/overpayment rejection');

  // Authentic DBC graduation to DAMM v2 and post-migration settlement.
  const cp=new CpAmm(connection);
  let stage='DBC graduation swap';
  try {
    await submit('DBC graduation swap (reach 300 HYPE migration threshold)',await sdk.pool.swap2({owner:payer.publicKey,pool,amountIn:new BN('300000000000'),minimumAmountOut:new BN(1),swapMode:1,swapBaseForQuote:false,referralTokenAccount:null}),[payer]);
    stage='migration';
    const dammConfig=DAMM_V2_MIGRATION_FEE_ADDRESS[6];
    assert(await connection.getAccountInfo(dammConfig),`Missing DAMM migration config ${dammConfig}`);
    const migration=await sdk.migration.migrateToDammV2({payer:payer.publicKey,pool,dammConfig});
    await submit('DBC migration_damm_v2 (permissionless)',migration.transaction,[payer,migration.firstPositionNftKeypair,migration.secondPositionNftKeypair]);
    const nft=migration.firstPositionNftKeypair;
    const custom={pool:deriveDammV2PoolAddress(dammConfig,base.publicKey,hype),position:derivePositionAddress(nft.publicKey)};
    const nftAccount=derivePositionNftAccount(nft.publicKey);
    const migratedPosition=await cp._program.account.position.fetch(custom.position);
    assert(migratedPosition.pool.equals(custom.pool));
    assert((await getAccount(connection,nftAccount,'confirmed',TOKEN_2022_PROGRAM_ID)).owner.equals(feePool),'migrated position NFT is not in distributor custody');
    assert(migratedPosition.unlockedLiquidity.isZero(),'Distributor migration liquidity must be 100% permanently locked');
    const lockAmount=migratedPosition.permanentLockedLiquidity;
    assert(lockAmount.gtn(0));
    console.log('PASS authentic migration: position NFT owned by distributor PDA, 100% permanently locked liquidity');
    stage='post-migration settlement';
    const p0=(await getAccount(connection,platformHype)).amount,v0=(await getAccount(connection,hypeVault)).amount;
    await submit('collect residual DBC fees after graduation',settle(),[payer]);
    const gPlatform=(await getAccount(connection,platformHype)).amount-p0,gRemainder=(await getAccount(connection,hypeVault)).amount-v0;
    assert(gPlatform+gRemainder>0n);
    assert.equal(gPlatform,(gPlatform+gRemainder)*2000n/10000n);
    const gCreator=creatorPart(gRemainder),gHolders=gRemainder-gCreator;
    const dammPool=await cp._program.account.pool.fetch(custom.pool);
    await submit('DAMM v2 HYPE swap (accrue real LP fees)',await cp.swap({payer:payer.publicKey,pool:custom.pool,inputTokenMint:hype,outputTokenMint:base.publicKey,amountIn:new BN('10000000000'),minimumAmountOut:new BN(1),tokenAMint:base.publicKey,tokenBMint:hype,tokenAVault:dammPool.tokenAVault,tokenBVault:dammPool.tokenBVault,tokenAProgram:TOKEN_PROGRAM_ID,tokenBProgram:TOKEN_PROGRAM_ID,referralTokenAccount:null}),[payer]);
    const dammClaim=await cp.claimPositionFee({owner:feePool,position:custom.position,pool:custom.pool,positionNftAccount:nftAccount,tokenAMint:base.publicKey,tokenBMint:hype,tokenAVault:dammPool.tokenAVault,tokenBVault:dammPool.tokenBVault,tokenAProgram:TOKEN_PROGRAM_ID,tokenBProgram:TOKEN_PROGRAM_ID,feePayer:payer.publicKey});
    const dammIx=dammClaim.instructions.find(ix=>ix.programId.equals(cp._program.programId));
    assert(dammIx);
    const expectedFees=getUnClaimLpFee(await cp._program.account.pool.fetch(custom.pool),await cp._program.account.position.fetch(custom.position));
    await rejected('settle_damm_v2 before pool registration',new Transaction().add(distributorSettlement(program,base.publicKey,platform.publicKey,payer.publicKey,dammIx,nftAccount)),[payer],'InvalidPool');
    const dp0=(await getAccount(connection,platformHype)).amount,dv0=(await getAccount(connection,hypeVault)).amount;
    await submit('atomic register DAMM pool + settle_damm_v2 (real CPI)',new Transaction().add(registerDistributorMigration(program,base.publicKey,payer.publicKey,custom.pool),distributorSettlement(program,base.publicKey,platform.publicKey,payer.publicKey,dammIx,nftAccount)),[payer]);
    const dPlatform=(await getAccount(connection,platformHype)).amount-dp0,dVault=(await getAccount(connection,hypeVault)).amount-dv0;
    assert(dPlatform+dVault>0n);
    assert.equal(dPlatform+dVault,BigInt(expectedFees.feeTokenB.toString()));
    assert.equal(dPlatform,(dPlatform+dVault)*2000n/10000n);
    assert((await cp._program.account.position.fetch(custom.position)).permanentLockedLiquidity.eq(lockAmount),'locked liquidity changed');
    await rejected('register a second DAMM pool (replay)',new Transaction().add(registerDistributorMigration(program,base.publicKey,payer.publicKey,custom.pool)),[payer],'AlreadyRegistered');
    const settled=await distributor.account.feePool.fetch(feePool);
    assert.equal(BigInt(settled.creatorClaimable.toString()),gCreator+creatorPart(dVault));
    assert.equal(BigInt(settled.holderUnallocated.toString()),gHolders+dVault-creatorPart(dVault));
    assert.equal(BigInt(settled.creatorClaimable.toString())+BigInt(settled.holderUnallocated.toString())+BigInt(settled.holderReserved.toString()),(await getAccount(connection,hypeVault)).amount,'vault liabilities not conserved');
    const before=(await getAccount(connection,traderHype)).amount;
    await submit('creator claims DAMM-settled HYPE',creatorClaim(),[payer]);
    const dPlan=planHolderEpoch({mint:mintText,epoch:2n,snapshotSlot:BigInt((await connection.getSlot('confirmed'))-1),available:BigInt(settled.holderUnallocated.toString()),holders:[{wallet:payer.publicKey.toBase58(),tokenBalance:await bal(payer.publicKey,base.publicKey)}],hasHypeAccount:allHave,policy:testPolicy});
    await submit('fund holder epoch 2 from DAMM-settled HYPE',fund(snapshot.publicKey,dPlan.fundedAmount,dPlan),[snapshot]);
    await submit('push DAMM-settled HYPE to holder (epoch 2)',chunkTx(dPlan.chunks[0],2n),[crank]);
    await submit('close DAMM payout epoch 2',close(2n),[snapshot]);
    assert.equal((await getAccount(connection,traderHype)).amount-before,gRemainder+dVault);
    assert.equal((await getAccount(connection,hypeVault)).amount,remainingHolders,'epoch 1 reserve no longer fully backed');
    save('distributor',{...proof,dbcSplit:split,dammPool:custom.pool.toBase58(),dammSplit:{platform20:dPlatform.toString(),vault80:dVault.toString(),graduationPlatform:gPlatform.toString(),graduationVault:gRemainder.toString()}});
    console.log('PASS: Devnet graduation, DAMM v2 settlement, 20% platform, creator claim and holder push payout; epoch 1 reserve fully backed');
  } catch (error) {
    save('distributor',{...proof,dbcSplit:split,dammFailedAt:stage,dammError:error.message});
    throw error;
  }
})().catch(error=>{console.error(`FAIL: ${error.message}`);process.exitCode=1;});
