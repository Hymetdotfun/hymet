/* eslint-disable @typescript-eslint/no-require-imports -- standalone validator tooling */
// Phase 1 native-split lifecycle on a loopback validator with Mainnet-dumped Meteora DBC/DAMM v2 programs.
// No HYMET program is used. Verifies on-chain 20% platform / 80% creator for DBC trading fees and for
// fees on the permanently locked DAMM v2 positions after graduation, through the app's own claim builders.
const fs = require('node:fs');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,esModuleInterop:true,target:ts.ScriptTarget.ES2022}}).outputText,filename);
const {Connection,Keypair,PublicKey,ComputeBudgetProgram,SystemProgram,Transaction} = require('@solana/web3.js');
const BN = require('bn.js');
const {createHash} = require('node:crypto');
const {getAssociatedTokenAddressSync,getAccount,TOKEN_PROGRAM_ID} = require('@solana/spl-token');
const {CpAmm} = require('@meteora-ag/cp-amm-sdk');
const {DynamicBondingCurveClient,deriveDbcPoolAddress,DAMM_V2_MIGRATION_FEE_ADDRESS} = require('@meteora-ag/dynamic-bonding-curve-sdk');
const {defaults,curve} = require('../lib/config.ts');
const {prepareCreatorClaim,readCreatorFees} = require('../lib/creator-fees.ts');
const {preparePlatformClaim,readPlatformFees} = require('../lib/platform-fees.ts');
const {readDammPositions,prepareDammClaim} = require('../lib/damm-fees.ts');
const {HYPE_MINT} = require('../lib/quote-assets.ts');
const {prepareDbcSwap,formatUnits} = require('../lib/dbc-swap.ts');
const assert = require('node:assert/strict');
const endpoint = process.env.VALIDATOR_RPC_URL || 'http://127.0.0.1:19899';
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint)) throw Error('Loopback validator required');
const connection = new Connection(endpoint,'confirmed');
// TEST SHIM: the app's checkNetwork() accepts only real cluster genesis hashes. The loopback validator runs
// Mainnet-dumped Meteora programs, so the app libraries alone are told "mainnet-beta". Never used outside this script.
const appConnection = new Proxy(connection,{get(target,key){ if(key==='getGenesisHash') return async()=>'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'; const v=target[key]; return typeof v==='function'?v.bind(target):v; }});
const execution = [];

async function confirm(signature) {
  for(let n=0;n<100;n++) {
    const status=(await connection.getSignatureStatuses([signature])).value[0];
    if(status && ['confirmed','finalized'].includes(status.confirmationStatus)) { if(status.err) throw Error(JSON.stringify(status.err)); return; }
    await new Promise(r=>setTimeout(r,300));
  }
  throw Error('Local confirmation timed out');
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
  const signature=await connection.sendRawTransaction(transaction.serialize());
  await confirm(signature);
  execution.push({label,signature});
  console.log(`PASS ${label}: ${signature}`);
}
async function rejectedBuild(label,build,expected) {
  await assert.rejects(build,e=>{assert.match(e.message,expected);return true;});
  console.log(`PASS rejected ${label}: ${expected}`);
}
const bal=async(owner,mint)=>{try{return (await getAccount(connection,getAssociatedTokenAddressSync(mint,owner))).amount;}catch{return 0n;}};

(async()=>{
  const creator=Keypair.fromSeed(createHash('sha256').update('HYMET LOCAL VALIDATOR ONLY TRADER').digest());
  const platform=Keypair.generate(),config=Keypair.generate(),base=Keypair.generate();
  await confirm(await connection.requestAirdrop(creator.publicKey,20e9));
  await confirm(await connection.requestAirdrop(platform.publicKey,2e9));
  const sdk=new DynamicBondingCurveClient(connection,'confirmed');
  const params=curve({...defaults,name:'Native HYMET',symbol:'NHY'},creator.publicKey);
  await submit('DBC create_config2 (native split: feeClaimer = platform, creator 80%)',await sdk.partner.createConfig2({...params,config:config.publicKey,feeClaimer:platform.publicKey,leftoverReceiver:creator.publicKey,quoteMint:HYPE_MINT,payer:creator.publicKey,transferFeeParameters:null}),[creator,config]);
  const pool=deriveDbcPoolAddress(HYPE_MINT,base.publicKey,config.publicKey);
  await submit('DBC create_pool (no HYMET program)',await sdk.creator.createPool({name:'Native HYMET',symbol:'NHY',uri:'https://example.invalid/native.json',payer:creator.publicKey,poolCreator:creator.publicKey,config:config.publicKey,baseMint:base.publicKey}),[creator,base]);
  const view=await readPlatformFees(appConnection,'mainnet-beta',pool.toBase58(),platform.publicKey);
  assert.equal(view.creatorShare,80);
  console.log('PASS on-chain config enforces native split (fee claimer, 80% creator, 20/80 locked LP, HYPE quote)');
  await rejectedBuild('platform view for a different platform wallet',readPlatformFees(appConnection,'mainnet-beta',pool.toBase58(),creator.publicKey),/fee claimer/);

  await submit('DBC buy with 10 HYPE (accrue fees)',await sdk.pool.swap({owner:creator.publicKey,pool,amountIn:new BN('10000000000'),minimumAmountOut:new BN(1),swapBaseForQuote:false,referralTokenAccount:null}),[creator]);
  // The app's own trade route (prepareDbcSwap: pool verification, quote, slippage floor, simulation), buy then sell.
  const swap=(side,amount,slippageBps=100)=>prepareDbcSwap(appConnection,{mint:base.publicKey.toBase58(),pool:pool.toBase58(),wallet:creator.publicKey,side,amount,slippageBps,platform:platform.publicKey});
  const tokensBefore=await bal(creator.publicKey,base.publicKey);
  const buy=await swap('buy','1');
  assert(buy.minimumOut<=buy.expectedOut&&buy.minimumOut>=buy.expectedOut*9900n/10000n-1n,'buy slippage floor');
  await submit('app DBC buy 1 HYPE (1% slippage)',buy.tx,[creator],{keepBudget:true});
  const bought=await bal(creator.publicKey,base.publicKey)-tokensBefore;
  assert(bought>=buy.minimumOut,'buy delivered less than the slippage floor');
  const hypeBefore=await bal(creator.publicKey,HYPE_MINT);
  const sellUnits=bought/2n,sellAmount=formatUnits(sellUnits,9);
  const sell=await swap('sell',sellAmount);
  await submit('app DBC sell (1% slippage)',sell.tx,[creator],{keepBudget:true});
  const received=await bal(creator.publicKey,HYPE_MINT)-hypeBefore;
  assert(received>=sell.minimumOut&&received>0n,'sell delivered less than the slippage floor');
  console.log(JSON.stringify({appTrades:{buyHype:'1',tokensOut:bought.toString(),buyMinOut:buy.minimumOut.toString(),sellTokens:sell.amountIn.toString(),hypeOut:received.toString(),sellMinOut:sell.minimumOut.toString()}}));
  await rejectedBuild('sell above balance',swap('sell','1000000000'),/Insufficient token balance/);
  await rejectedBuild('slippage above 50%',swap('buy','1',5001),/Slippage/);
  await rejectedBuild('zero amount',swap('buy','0'),/greater than zero/);
  const partnerFee=(await readPlatformFees(appConnection,'mainnet-beta',pool.toBase58(),platform.publicKey)).quote;
  const creatorFee=(await readCreatorFees(appConnection,'mainnet-beta',pool.toBase58())).quote;
  assert(partnerFee>0n&&creatorFee>0n,'no DBC fees accrued');
  const total=partnerFee+creatorFee;
  assert(partnerFee===total*20n/100n||partnerFee===total*20n/100n+1n,`platform share not 20%: ${partnerFee}/${total}`);
  console.log(JSON.stringify({dbcFees:{total:total.toString(),platform:partnerFee.toString(),creator:creatorFee.toString(),platformPercent:Number(partnerFee*10000n/total)/100}}));

  await rejectedBuild('creator claim by the platform wallet',prepareCreatorClaim(appConnection,'mainnet-beta',pool.toBase58(),platform.publicKey),/not this pool's creator/);
  await rejectedBuild('platform claim by the creator wallet',preparePlatformClaim(appConnection,'mainnet-beta',pool.toBase58(),creator.publicKey),/fee claimer/);
  const p0=await bal(platform.publicKey,HYPE_MINT);
  const platformPlan=await preparePlatformClaim(appConnection,'mainnet-beta',pool.toBase58(),platform.publicKey);
  await submit('platform claims 20% DBC fees (app builder, platform signs)',platformPlan.tx,[platform],{keepBudget:true});
  assert.equal(await bal(platform.publicKey,HYPE_MINT)-p0,partnerFee);
  const c0=await bal(creator.publicKey,HYPE_MINT);
  const creatorPlan=await prepareCreatorClaim(appConnection,'mainnet-beta',pool.toBase58(),creator.publicKey);
  await submit('creator claims 80% DBC fees (app builder, creator signs)',creatorPlan.tx,[creator],{keepBudget:true});
  assert.equal(await bal(creator.publicKey,HYPE_MINT)-c0,creatorFee);
  await rejectedBuild('platform double claim',preparePlatformClaim(appConnection,'mainnet-beta',pool.toBase58(),platform.publicKey),/No DBC platform trading fees/);
  console.log('PASS DBC: 20% platform / 80% creator paid exactly, wrong-wallet and double claims rejected');

  await submit('DBC graduation buy (reach 300 HYPE)',await sdk.pool.swap2({owner:creator.publicKey,pool,amountIn:new BN('300000000000'),minimumAmountOut:new BN(1),swapMode:1,swapBaseForQuote:false,referralTokenAccount:null}),[creator]);
  const dammConfig=DAMM_V2_MIGRATION_FEE_ADDRESS[6];
  assert(await connection.getAccountInfo(dammConfig),`Missing DAMM migration config ${dammConfig}`);
  await submit('fund DBC migration authority rent (local)',new Transaction().add(SystemProgram.transfer({fromPubkey:creator.publicKey,toPubkey:new PublicKey('FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM'),lamports:100000000})),[creator]);
  const migration=await sdk.migration.migrateToDammV2({payer:creator.publicKey,pool,dammConfig});
  await submit('DBC migration_damm_v2 (permissionless)',migration.transaction,[creator,migration.firstPositionNftKeypair,migration.secondPositionNftKeypair]);

  const platformPositions=(await readDammPositions(appConnection,'mainnet-beta',pool.toBase58(),platform.publicKey)).positions;
  const creatorView=await readDammPositions(appConnection,'mainnet-beta',pool.toBase58(),creator.publicKey);
  assert.equal(platformPositions.length,1,'platform must own exactly one DAMM position');
  assert.equal(creatorView.positions.length,1,'creator must own exactly one DAMM position');
  const [pp,cp]=[platformPositions[0],creatorView.positions[0]];
  const lockedTotal=BigInt(pp.locked)+BigInt(cp.locked);
  const platformLockPct=Number(BigInt(pp.locked)*1000000n/lockedTotal)/10000;
  console.log(JSON.stringify({dammLiquidity:{platform:{locked:pp.locked,unlocked:pp.unlocked,vested:pp.vested},creator:{locked:cp.locked,unlocked:cp.unlocked,vested:cp.vested},platformLockedPercent:platformLockPct}}));
  // DBC's migration rounds each position's locked liquidity down, which can leave 1 liquidity unit unlocked
  // (observed: 1 of ~2.1e33 on the creator position). More than that means the liquidity is not permanently locked.
  for (const [name,p] of [['platform',pp],['creator',cp]]) assert(BigInt(p.unlocked)<=1n&&BigInt(p.vested)===0n&&BigInt(p.locked)>10n**12n,`migrated ${name} liquidity must be permanently locked (unlocked ${p.unlocked})`);
  assert(Math.abs(platformLockPct-20)<0.05,`platform locked liquidity ${platformLockPct}%`);

  const amm=new CpAmm(connection),poolState=creatorView.pool,dammPool=new PublicKey(creatorView.dbc.migration.destination);
  await submit('DAMM v2 swap 20 HYPE (accrue LP fees)',await amm.swap({payer:creator.publicKey,pool:dammPool,inputTokenMint:HYPE_MINT,outputTokenMint:base.publicKey,amountIn:new BN('20000000000'),minimumAmountOut:new BN(1),tokenAMint:poolState.tokenAMint,tokenBMint:poolState.tokenBMint,tokenAVault:poolState.tokenAVault,tokenBVault:poolState.tokenBVault,tokenAProgram:TOKEN_PROGRAM_ID,tokenBProgram:TOKEN_PROGRAM_ID,referralTokenAccount:null}),[creator]);
  const [pv,cv]=[await readDammPositions(appConnection,'mainnet-beta',pool.toBase58(),platform.publicKey),await readDammPositions(appConnection,'mainnet-beta',pool.toBase58(),creator.publicKey)];
  const pFee=pv.positions[0].a+pv.positions[0].b,cFee=cv.positions[0].a+cv.positions[0].b;
  assert(pFee>0n&&cFee>0n,'locked positions earned no fees');
  const dPct=Number(pFee*10000n/(pFee+cFee))/100;
  assert(Math.abs(dPct-20)<0.05,`platform DAMM fee share ${dPct}%`);
  await rejectedBuild('DAMM claim of the creator position by the platform wallet',prepareDammClaim(appConnection,'mainnet-beta',pool.toBase58(),cp.position,platform.publicKey),/No supported, wallet-owned DAMM position/);
  const before=[await bal(platform.publicKey,HYPE_MINT)+await bal(platform.publicKey,base.publicKey),await bal(creator.publicKey,HYPE_MINT)+await bal(creator.publicKey,base.publicKey)];
  await submit('platform claims DAMM fees on its 20% locked position (app builder)',(await prepareDammClaim(appConnection,'mainnet-beta',pool.toBase58(),pp.position,platform.publicKey)).claim.tx,[platform],{keepBudget:true});
  await submit('creator claims DAMM fees on its 80% locked position (app builder)',(await prepareDammClaim(appConnection,'mainnet-beta',pool.toBase58(),cp.position,creator.publicKey)).claim.tx,[creator],{keepBudget:true});
  assert.equal(await bal(platform.publicKey,HYPE_MINT)+await bal(platform.publicKey,base.publicKey)-before[0],pFee);
  const after=await readDammPositions(appConnection,'mainnet-beta',pool.toBase58(),creator.publicKey);
  assert.equal(after.positions[0].locked,cp.locked,'locked liquidity changed after claim');
  console.log(JSON.stringify({dammFees:{platform:pFee.toString(),creator:cFee.toString(),platformPercent:dPct}}));
  console.log('PASS native split: DBC and DAMM v2 fees paid 20% platform / 80% creator on-chain; no HYMET program; no holder rewards');
  fs.writeFileSync('work/native-split-proof.json',JSON.stringify({mint:base.publicKey.toBase58(),dbcPool:pool.toBase58(),dammPool:dammPool.toBase58(),execution},null,2));
})().catch(error=>{console.error(`FAIL: ${error.message}`);process.exitCode=1;});
