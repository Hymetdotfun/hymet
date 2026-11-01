/* eslint-disable @typescript-eslint/no-require-imports -- standalone validator tooling */
// Authentic SDK transactions on loopback only. All signers are ephemeral test wallets.
const fs = require('node:fs');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,esModuleInterop:true,target:ts.ScriptTarget.ES2022}}).outputText,filename);
const {Connection,Keypair,PublicKey,ComputeBudgetProgram,SystemProgram,Transaction} = require('@solana/web3.js');
const {Program} = require('@coral-xyz/anchor');
const BN = require('bn.js');
const {CpAmm,MIN_SQRT_PRICE,MAX_SQRT_PRICE,getBaseFeeParams,derivePositionAddress,derivePositionNftAccount,getUnClaimLpFee}=require('@meteora-ag/cp-amm-sdk');
const {createHash} = require('node:crypto');
const {TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,AuthorityType,createSetAuthorityInstruction,getAssociatedTokenAddressSync,createAssociatedTokenAccountIdempotentInstruction,getAccount,getMint} = require('@solana/spl-token');
const {DynamicBondingCurveClient,deriveDbcPoolAddress,deriveDammV2PoolAddress,DAMM_V2_MIGRATION_FEE_ADDRESS} = require('@meteora-ag/dynamic-bonding-curve-sdk');
const {defaults,distributorCurve} = require('../lib/config.ts');
const {createDistributorPool,distributorSettlement,creatorDistributorClaim,registerDistributorMigration,fundDistributorEpoch,distributeHolderChunk,closeHolderEpoch,holderEpochAddress,verifyDistributorPool}=require('../lib/distributor-engine.ts');
const {HOLDER_PAYOUT_POLICY,eligibleHolders,planHolderEpoch}=require('../lib/holder-payouts.mjs');
const {setSnapshotAuthorityInstruction}=require('../lib/distributor-init.mjs');
const assert = require('node:assert/strict');
// Creator share of the 80% in bps (default 50/50); holders get the rest. Same integer math as the program.
const CREATOR_BPS = Number(process.env.HYMET_LIFECYCLE_CREATOR_BPS ?? 5000);
if (!Number.isInteger(CREATOR_BPS) || CREATOR_BPS < 0 || CREATOR_BPS > 9999) throw Error('HYMET_LIFECYCLE_CREATOR_BPS must be 0-9999 (holders need a share)');
const creatorPart = (remainder) => remainder * BigInt(CREATOR_BPS) / 10000n;
const chunkProof = (plan) => plan.chunks.map((c) => ({index:c.index,leaf:c.leaf.toString('hex'),proof:c.proof.map((h)=>h.toString('hex')),entries:c.entries.map((e)=>({wallet:e.wallet,tokenBalance:e.tokenBalance.toString(),reward:e.reward.toString(),newAccount:Boolean(e.newAccount)}))}));
const endpoint = process.env.VALIDATOR_RPC_URL || 'http://127.0.0.1:19899';
// Same build-output override as validator-fixture-start.cjs; must stay inside the isolated build root.
const programTarget = process.env.HYMET_PROGRAM_TARGET || '/srv/hymet-build/src/target';
if (!/^\/srv\/hymet-build\/[\w.\/-]+$/.test(programTarget) || programTarget.includes('..')) throw Error('HYMET_PROGRAM_TARGET must be inside /srv/hymet-build');
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint)) throw Error('Loopback validator required');
const connection = new Connection(endpoint,'confirmed');
const execution=[];
async function confirm(signature) {
  for(let n=0;n<100;n++) {
    const status=(await connection.getSignatureStatuses([signature])).value[0];
    if(status && ['confirmed','finalized'].includes(status.confirmationStatus)) {
      if(status.err) throw Error(JSON.stringify(status.err));
      return;
    }
    await new Promise(resolve=>setTimeout(resolve,300));
  }
  throw Error('Local confirmation timed out');
}
async function submit(label,transaction,signers) {
  transaction.instructions=transaction.instructions.filter(ix=>!ix.programId.equals(ComputeBudgetProgram.programId));
  transaction.instructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({units:1000000}));
  transaction.feePayer=signers[0].publicKey;
  transaction.recentBlockhash=(await connection.getLatestBlockhash()).blockhash;
  transaction.sign(...signers);
  try {
    const signature=await connection.sendRawTransaction(transaction.serialize());
    await confirm(signature);
    execution.push({label,signature});
    console.log(`PASS ${label}: ${signature}`);
  } catch(error) {
    console.error(JSON.stringify({instruction:label,accounts:transaction.instructions.map(ix=>({program:ix.programId.toBase58(),data:ix.data.toString('hex'),accounts:ix.keys.map(k=>({address:k.pubkey.toBase58(),signer:k.isSigner,writable:k.isWritable}))})),error:error.message,logs:error.logs || error.transactionLogs},null,2));
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
  assert(failed,`${label} unexpectedly succeeded`);
  const result=await connection.getTransaction(signature,{commitment:'confirmed',maxSupportedTransactionVersion:0});
  assert(result?.meta?.err,`${label}: missing confirmed failure`);
  assert(result.meta.logMessages.some(line=>line.includes(expectedLog)),`${label}: unexpected error ${JSON.stringify(result.meta.logMessages)}`);
  console.log(`PASS rejected ${label}: ${signature}; ${expectedLog}`);
}
(async()=>{
  const payer=Keypair.fromSeed(createHash('sha256').update('HYMET LOCAL VALIDATOR ONLY TRADER').digest()),config=Keypair.generate(),base=Keypair.generate();
  const program=new PublicKey(JSON.parse(fs.readFileSync(`${programTarget}/idl/hymet_rewards_distributor.json`,'utf8')).address);
  const [feePool]=PublicKey.findProgramAddressSync([Buffer.from('fee-pool'),base.publicKey.toBuffer()],program);
  await confirm(await connection.requestAirdrop(payer.publicKey,20e9));
  const hype = new PublicKey('98sMhvDwXj1RQi5c5Mndm3vPe9cBqPrbLaufMXFNMh5g');
  const platform=Keypair.fromSeed(createHash('sha256').update('HYMET LOCAL VALIDATOR ONLY PLATFORM').digest());
  await confirm(await connection.requestAirdrop(platform.publicKey,2e9));
  const idl=JSON.parse(fs.readFileSync(`${programTarget}/idl/hymet_rewards_distributor.json`,'utf8'));
  const distributor=new Program({...idl,address:program.toBase58()},{connection});
  const [globalConfig]=PublicKey.findProgramAddressSync([Buffer.from('config')],program);
  const [programData]=PublicKey.findProgramAddressSync([program.toBuffer()],new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'));
  const initialize=()=>distributor.methods.initialize(platform.publicKey).accountsPartial({platformWallet:platform.publicKey,config:globalConfig,program,programData,systemProgram:SystemProgram.programId});
  if (!(await connection.getAccountInfo(globalConfig))) {
    await rejected('non-upgrade-authority initialize',await initialize().accountsPartial({authority:platform.publicKey}).transaction(),[platform],'NotUpgradeAuthority');
    await submit('distributor initialize by upgrade authority',await initialize().accountsPartial({authority:payer.publicKey}).transaction(),[payer]);
    const state=await connection.getAccountInfo(globalConfig);
    assert(state.data.subarray(8,40).equals(payer.publicKey.toBuffer())&&state.data.subarray(40,72).equals(platform.publicKey.toBuffer()));
  }
  const sdk=new DynamicBondingCurveClient(connection);
  const parameters=distributorCurve({...defaults,name:'Validator HYMET',symbol:'VHY'},payer.publicKey);
  await submit('DBC create_config2',await sdk.partner.createConfig2({...parameters,config:config.publicKey,feeClaimer:feePool,leftoverReceiver:payer.publicKey,quoteMint:new PublicKey('98sMhvDwXj1RQi5c5Mndm3vPe9cBqPrbLaufMXFNMh5g'),payer:payer.publicKey,transferFeeParameters:null}),[payer,config]);
  const pool=deriveDbcPoolAddress(new PublicKey('98sMhvDwXj1RQi5c5Mndm3vPe9cBqPrbLaufMXFNMh5g'),base.publicKey,config.publicKey);
  const launchTransaction=await sdk.creator.createPool({name:'Validator HYMET',symbol:'VHY',uri:'https://example.invalid/local-validator.json',payer:payer.publicKey,poolCreator:payer.publicKey,config:config.publicKey,baseMint:base.publicKey});
  launchTransaction.add(createDistributorPool(program,base.publicKey,payer.publicKey,pool,CREATOR_BPS));
  await submit('application atomic token/pool/distributor launch',launchTransaction,[payer,base]);
  assert(await connection.getAccountInfo(pool));
  console.log(`PASS authentic DBC pool creation: ${pool.toBase58()}`);
  const configState=await distributor.account.distributorConfig.fetch(globalConfig);
  const hypeVault=getAssociatedTokenAddressSync(hype,feePool,true);
  const platformHype=getAssociatedTokenAddressSync(hype,configState.platformWallet);
  await submit('platform HYPE ATA',new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(payer.publicKey,platformHype,configState.platformWallet,hype)),[payer]);
  const claim=await sdk.partner.claimPartnerTradingFee({feeClaimer:feePool,payer:payer.publicKey,pool,maxBaseAmount:new BN('18446744073709551615'),maxQuoteAmount:new BN('18446744073709551615')});
  const claimIx=claim.instructions.find(ix=>ix.programId.equals(sdk.program.programId));
  assert(claimIx,'SDK claim instruction missing');
  const before=(await getAccount(connection,hypeVault)).amount;
  await submit('application settle_dbc (real CPI, zero accrued fees)',new Transaction().add(distributorSettlement(program,base.publicKey,configState.platformWallet,payer.publicKey,claimIx)),[payer]);
  assert.equal((await getAccount(connection,hypeVault)).amount,before);
  const traderHype=getAssociatedTokenAddressSync(hype,payer.publicKey);
  const spendable=(await getAccount(connection,traderHype)).amount;
  assert(spendable>=1000000000n,'Local genesis HYPE faucet account missing or exhausted');
  await submit('DBC quote-to-base swap (accrue actual HYPE fees)',await sdk.pool.swap({owner:payer.publicKey,pool,amountIn:new BN('1000000000'),minimumAmountOut:new BN(1),swapBaseForQuote:false,referralTokenAccount:null}),[payer]);
  const poolAfterSwap=await sdk.program.account.virtualPool.fetch(pool);
  console.log('Accrued DBC pool fee fields:',JSON.stringify(poolAfterSwap,(k,v)=>BN.isBN(v)?v.toString():v));
  const platformBefore=(await getAccount(connection,platformHype)).amount;
  await submit('application settle_dbc (real accrued HYPE fees)',new Transaction().add(distributorSettlement(program,base.publicKey,configState.platformWallet,payer.publicKey,claimIx)),[payer]);
  const platformDelta=(await getAccount(connection,platformHype)).amount-platformBefore;
  const vaultDelta=(await getAccount(connection,hypeVault)).amount-before;
  const total=platformDelta+vaultDelta;
  assert(total>0n,'No distributable HYPE fee was received');
  assert.equal(platformDelta,total*2000n/10000n);
  assert.equal(vaultDelta,total-platformDelta);
  const ledger=await distributor.account.feePool.fetch(feePool);
  await verifyDistributorPool(connection,program,base.publicKey,payer.publicKey,pool,CREATOR_BPS);
  const rawLedger=await connection.getAccountInfo(feePool,'confirmed');
  assert.equal(rawLedger.data.readBigUInt64LE(146),BigInt(ledger.holderUnallocated.toString()));
  assert.equal(rawLedger.data.readBigUInt64LE(162),BigInt(ledger.nextEpoch.toString()));
  assert.equal(BigInt(ledger.creatorClaimable.toString())+BigInt(ledger.holderUnallocated.toString()),vaultDelta);
  assert.equal(BigInt(ledger.creatorClaimable.toString()),creatorPart(vaultDelta));
  console.log(JSON.stringify({verifiedRealDbcCpi:true,distributable:total.toString(),platform20Percent:platformDelta.toString(),remaining80Percent:vaultDelta.toString(),creator:ledger.creatorClaimable.toString(),holders:ledger.holderUnallocated.toString()}));
  const creatorAmount=BigInt(ledger.creatorClaimable.toString());
  const creatorBefore=(await getAccount(connection,traderHype)).amount;
  await rejected('unauthorized creator claim',await distributor.methods.claimCreator().accountsPartial({feePool,creator:platform.publicKey,hypeVault,creatorHype:platformHype,hypeMint:hype,tokenProgram:TOKEN_PROGRAM_ID}).transaction(),[platform],'ConstraintHasOne');
  const creatorClaim=async()=>new Transaction().add(creatorDistributorClaim(program,base.publicKey,payer.publicKey));
  if(creatorAmount===0n) await rejected('creator claim at 0% creator share',await creatorClaim(),[payer],'NothingToClaim');
  else await submit('creator HYPE claim',await creatorClaim(),[payer]);
  assert.equal((await getAccount(connection,traderHype)).amount-creatorBefore,creatorAmount);
  await rejected('creator double claim',await creatorClaim(),[payer],'NothingToClaim');
  const holderTotal=BigInt(ledger.holderUnallocated.toString());
  const balance=(await getAccount(connection,getAssociatedTokenAddressSync(base.publicKey,payer.publicKey))).amount;
  // Eight committed holders = two chunks (6 + 2). Synthetic on-curve wallets stand in for buyers;
  // committed balances are snapshot data, and the program enforces only the committed root.
  const extra=Array.from({length:7},(_,i)=>Keypair.fromSeed(createHash('sha256').update(`HYMET LOCAL VALIDATOR HOLDER ${i}`).digest()).publicKey);
  const holders=eligibleHolders([{owner:payer.publicKey.toBase58(),amount:balance,state:1},...extra.map((k,i)=>({owner:k.toBase58(),amount:balance*BigInt(i+1)/4n,state:1}))]);
  const testPolicy={...HOLDER_PAYOUT_POLICY,minPayout:1n,minPayoutNewAccount:1n};
  const mintText=base.publicKey.toBase58(),allHave=()=>true;
  const snapshotSlot=BigInt((await connection.getSlot('confirmed'))-1);
  const plan=planHolderEpoch({mint:mintText,epoch:0n,snapshotSlot,available:holderTotal/2n,holders,hasHypeAccount:allHave,policy:testPolicy});
  assert.equal(plan.chunks.length,2);
  const {snapshotHash,root}=plan,funded=plan.fundedAmount;
  const fund=(authority,amount,p=plan)=>new Transaction().add(fundDistributorEpoch(program,base.publicKey,authority,{epoch:p.epoch,snapshotSlot:p.snapshotSlot,snapshotHash:p.snapshotHash.toString('hex'),root:p.root.toString('hex'),amount,chunkCount:p.chunks.length}));
  const crank=Keypair.generate();
  await confirm(await connection.requestAirdrop(crank.publicKey,1e9));
  const chunkTx=(c,epochNumber=0n,mutate=(e)=>e)=>new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({units:200000}),distributeHolderChunk(program,base.publicKey,crank.publicKey,{epoch:epochNumber,chunkIndex:c.index,entries:c.entries.map(mutate),proof:c.proof}));
  const close=(epochNumber,authority=platform)=>new Transaction().add(closeHolderEpoch(program,base.publicKey,authority.publicKey,epochNumber));
  await rejected('unauthorized epoch funding',fund(payer.publicKey,funded),[payer],'Unauthorized');
  await rejected('epoch overfunding',fund(platform.publicKey,holderTotal+1n),[platform],'InsufficientFunds');
  await submit('fund committed holder payout epoch (2 chunks)',fund(platform.publicKey,funded),[platform]);
  await rejected('epoch funding replay',fund(platform.publicKey,funded),[platform],'already in use');
  await submit('create holder HYPE accounts',new Transaction().add(...extra.map(k=>createAssociatedTokenAccountIdempotentInstruction(payer.publicKey,getAssociatedTokenAddressSync(hype,k),k,hype))),[payer]);
  await rejected('tampered payout amount',chunkTx(plan.chunks[0],0n,(e,i)=>i===0?{...e,reward:e.reward+1n}:e),[crank],'InvalidProof');
  const redirected=chunkTx(plan.chunks[0]);
  redirected.instructions[1].keys[7].pubkey=platformHype;
  await rejected('payout redirected to another HYPE account',redirected,[crank],'InvalidRecipient');
  await rejected('close while paying out',close(0n),[platform],'EpochActive');
  const hypeOf=(w)=>getAccount(connection,getAssociatedTokenAddressSync(hype,new PublicKey(w))).then(a=>a.amount);
  const before0=await Promise.all(plan.payouts.map(p=>hypeOf(p.wallet)));
  await submit('permissionless push of chunk 0 (holders do not sign)',chunkTx(plan.chunks[0]),[crank]);
  await rejected('chunk replay',chunkTx(plan.chunks[0]),[crank],'AlreadyPaid');
  await submit('permissionless push of chunk 1',chunkTx(plan.chunks[1]),[crank]);
  const after0=await Promise.all(plan.payouts.map(p=>hypeOf(p.wallet)));
  plan.payouts.forEach((p,i)=>assert.equal(after0[i]-before0[i],p.reward));
  await rejected('close by non-authority',close(0n,payer),[payer],'Unauthorized');
  await submit('close fully paid epoch (rent back to authority)',close(0n),[platform]);
  assert.equal(await connection.getAccountInfo(holderEpochAddress(program,base.publicKey,0n)),null);
  const remainingHolders=holderTotal-funded;
  const closedLedger=await distributor.account.feePool.fetch(feePool);
  assert.equal(BigInt(closedLedger.holderReserved.toString()),0n);
  assert.equal(BigInt(closedLedger.holderUnallocated.toString()),remainingHolders);
  const single=[{wallet:payer.publicKey.toBase58(),tokenBalance:balance}];
  const stale=planHolderEpoch({mint:mintText,epoch:1n,snapshotSlot,available:remainingHolders,holders:single,hasHypeAccount:allHave,policy:testPolicy});
  await rejected('stale snapshot slot',fund(platform.publicKey,stale.fundedAmount,stale),[platform],'InvalidEpoch');
  const over=planHolderEpoch({mint:mintText,epoch:1n,snapshotSlot:BigInt((await connection.getSlot('confirmed'))-1),available:remainingHolders+1n,holders:single,hasHypeAccount:allHave,policy:testPolicy});
  await submit('fund adversarial over-committed epoch',fund(platform.publicKey,remainingHolders,over),[platform]);
  const vaultBeforeRejected=(await getAccount(connection,hypeVault)).amount;
  await rejected('valid-proof overpayment',chunkTx(over.chunks[0],1n),[crank],'OverClaim');
  assert.equal((await getAccount(connection,hypeVault)).amount,vaultBeforeRejected);
  const finalLedger=await distributor.account.feePool.fetch(feePool);
  assert.equal(BigInt(finalLedger.holderReserved.toString()),remainingHolders);
  assert.equal((await getAccount(connection,hypeVault)).amount,remainingHolders);
  console.log(JSON.stringify({verifiedPushPayouts:true,holders:plan.payouts.length,chunks:plan.chunks.length,funded:funded.toString(),dust:plan.dust.toString()}));
  console.log('PASS: real validator push payouts, replay/redirect/tamper/overpayment rejection, close and vault-liability conservation');
  const cp=new CpAmm(connection);
  let nft=Keypair.generate(),custom,nftAccount,lockAmount;
  const authenticMigration=process.env.TEST_AUTHENTIC_MIGRATION==='true';
  if(authenticMigration) {
    await submit('DBC graduation swap',await sdk.pool.swap2({owner:payer.publicKey,pool,amountIn:new BN('300000000000'),minimumAmountOut:new BN(1),swapMode:1,swapBaseForQuote:false,referralTokenAccount:null}),[payer]);
    const graduated=await sdk.program.account.virtualPool.fetch(pool);
    console.log('DBC graduation state',JSON.stringify(graduated));
    const dammConfig=DAMM_V2_MIGRATION_FEE_ADDRESS[6];
    assert(await connection.getAccountInfo(dammConfig),`Missing authentic DAMM migration config ${dammConfig}`);
    await submit('local faucet funding for DBC migration authority rent',new Transaction().add(SystemProgram.transfer({fromPubkey:payer.publicKey,toPubkey:new PublicKey('FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM'),lamports:100000000})),[payer]);
    const migration=await sdk.migration.migrateToDammV2({payer:payer.publicKey,pool,dammConfig});
    await submit('DBC migration_damm_v2',migration.transaction,[payer,migration.firstPositionNftKeypair,migration.secondPositionNftKeypair]);
    nft=migration.firstPositionNftKeypair;
    custom={pool:deriveDammV2PoolAddress(dammConfig,base.publicKey,hype),position:derivePositionAddress(nft.publicKey)};
    nftAccount=derivePositionNftAccount(nft.publicKey);
    const migratedPosition=await cp._program.account.position.fetch(custom.position);
    assert(migratedPosition.pool.equals(custom.pool));
    assert((await getAccount(connection,nftAccount,'confirmed',TOKEN_2022_PROGRAM_ID)).owner.equals(feePool));
    assert(migratedPosition.unlockedLiquidity.isZero(),'Distributor migration liquidity must be 100% permanently locked');
    assert(migratedPosition.permanentLockedLiquidity.gtn(0));
    lockAmount=migratedPosition.permanentLockedLiquidity;
    console.log('PASS authentic migration position ownership and 100% permanently locked liquidity');
  } else {
  const tokenAAmount=new BN((balance/2n).toString()),tokenBAmount=new BN('1000000000');
  const prepared=cp.preparePoolCreationParams({tokenAAmount,tokenBAmount,minSqrtPrice:MIN_SQRT_PRICE,maxSqrtPrice:MAX_SQRT_PRICE,collectFeeMode:1});
  custom=await cp.createCustomPool({payer:payer.publicKey,creator:payer.publicKey,positionNft:nft.publicKey,tokenAMint:base.publicKey,tokenBMint:hype,tokenAAmount,tokenBAmount,sqrtMinPrice:MIN_SQRT_PRICE,sqrtMaxPrice:MAX_SQRT_PRICE,liquidityDelta:prepared.liquidityDelta,initSqrtPrice:prepared.initSqrtPrice,poolFees:{baseFee:getBaseFeeParams({baseFeeMode:0,feeTimeSchedulerParam:{startingFeeBps:100,endingFeeBps:100,numberOfPeriod:0,totalDuration:0}}),compoundingFeeBps:0,padding:0,dynamicFee:null},hasAlphaVault:false,activationType:1,collectFeeMode:1,activationPoint:null,tokenAProgram:TOKEN_PROGRAM_ID,tokenBProgram:TOKEN_PROGRAM_ID});
  await submit('DAMM v2 authentic custom pool and position creation',custom.tx,[payer,nft]);
  nftAccount=derivePositionNftAccount(nft.publicKey);
  const positionBefore=await cp._program.account.position.fetch(custom.position);
  lockAmount=positionBefore.unlockedLiquidity.divn(10);
  await submit('DAMM permanently lock 10% liquidity',await cp.permanentLockPosition({owner:payer.publicKey,position:custom.position,positionNftAccount:nftAccount,pool:custom.pool,unlockedLiquidity:lockAmount}),[payer]);
  const lockedPosition=await cp._program.account.position.fetch(custom.position);
  assert(lockedPosition.permanentLockedLiquidity.eq(lockAmount));
  await submit('transfer position NFT custody to distributor PDA',new Transaction().add(createSetAuthorityInstruction(nftAccount,payer.publicKey,AuthorityType.AccountOwner,feePool,[],TOKEN_2022_PROGRAM_ID)),[payer]);
  }
  const stranger=Keypair.generate();
  await confirm(await connection.requestAirdrop(stranger.publicKey,1e9));
  await rejected('stranger registers DAMM pool',new Transaction().add(registerDistributorMigration(program,base.publicKey,stranger.publicKey,custom.pool)),[stranger],'Unauthorized');
  // The keeper (snapshot authority) can register the migrated pool without the creator.
  if(!authenticMigration) await submit('keeper registers DAMM pool',new Transaction().add(registerDistributorMigration(program,base.publicKey,platform.publicKey,custom.pool)),[platform]);
  let graduationCreator=0n,graduationHolders=0n,graduationRemainder=0n;
  if(authenticMigration) {
    const beforeGraduationPlatform=(await getAccount(connection,platformHype)).amount;
    const beforeGraduationVault=(await getAccount(connection,hypeVault)).amount;
    await submit('application collect residual DBC graduation fees after migration',new Transaction().add(distributorSettlement(program,base.publicKey,configState.platformWallet,payer.publicKey,claimIx)),[payer]);
    const platformDelta=(await getAccount(connection,platformHype)).amount-beforeGraduationPlatform;
    graduationRemainder=(await getAccount(connection,hypeVault)).amount-beforeGraduationVault;
    assert(platformDelta+graduationRemainder>0n);
    assert.equal(platformDelta,(platformDelta+graduationRemainder)*2000n/10000n);
    graduationCreator=creatorPart(graduationRemainder);graduationHolders=graduationRemainder-graduationCreator;
    console.log(JSON.stringify({verifiedGraduationResidual:true,platform:platformDelta.toString(),creatorAndHolders:graduationRemainder.toString()}));
  }
  const dammPool=await cp._program.account.pool.fetch(custom.pool);
  await submit('DAMM HYPE swap to accrue actual fees',await cp.swap({payer:payer.publicKey,pool:custom.pool,inputTokenMint:hype,outputTokenMint:base.publicKey,amountIn:new BN('10000000'),minimumAmountOut:new BN(1),tokenAMint:base.publicKey,tokenBMint:hype,tokenAVault:dammPool.tokenAVault,tokenBVault:dammPool.tokenBVault,tokenAProgram:TOKEN_PROGRAM_ID,tokenBProgram:TOKEN_PROGRAM_ID,referralTokenAccount:null}),[payer]);
  const dammClaim=await cp.claimPositionFee({owner:feePool,position:custom.position,pool:custom.pool,positionNftAccount:nftAccount,tokenAMint:base.publicKey,tokenBMint:hype,tokenAVault:dammPool.tokenAVault,tokenBVault:dammPool.tokenBVault,tokenAProgram:TOKEN_PROGRAM_ID,tokenBProgram:TOKEN_PROGRAM_ID,feePayer:payer.publicKey});
  const dammIx=dammClaim.instructions.find(ix=>ix.programId.equals(cp._program.programId));
  assert(dammIx);
  const dammPlatformBefore=(await getAccount(connection,platformHype)).amount;
  const dammVaultBefore=(await getAccount(connection,hypeVault)).amount;
  const feePoolSnapshot=await cp._program.account.pool.fetch(custom.pool);
  const feePositionSnapshot=await cp._program.account.position.fetch(custom.position);
  const expectedFees=getUnClaimLpFee(feePoolSnapshot,feePositionSnapshot);
  const unlockedOnly=getUnClaimLpFee(feePoolSnapshot,{...feePositionSnapshot,permanentLockedLiquidity:new BN(0)});
  assert(expectedFees.feeTokenB.gt(unlockedOnly.feeTokenB),'Locked liquidity did not contribute to accrued HYPE fees');
  const settlementTransaction=new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(payer.publicKey,platformHype,configState.platformWallet,hype));
  if(authenticMigration) settlementTransaction.add(registerDistributorMigration(program,base.publicKey,platform.publicKey,custom.pool));
  settlementTransaction.add(distributorSettlement(program,base.publicKey,configState.platformWallet,payer.publicKey,dammIx,nftAccount));
  await submit('application atomic migration handoff and locked/liquid DAMM settlement',settlementTransaction,authenticMigration?[payer,platform]:[payer]);
  const dammPlatform=(await getAccount(connection,platformHype)).amount-dammPlatformBefore;
  const dammVault=(await getAccount(connection,hypeVault)).amount-dammVaultBefore;
  assert(dammPlatform+dammVault>0n);
  assert.equal(dammPlatform+dammVault,BigInt(expectedFees.feeTokenB.toString()));
  assert.equal(expectedFees.feeTokenA.toString(),'0');
  assert.equal(dammPlatform,(dammPlatform+dammVault)*2000n/10000n);
  const positionAfter=await cp._program.account.position.fetch(custom.position);
  assert(positionAfter.permanentLockedLiquidity.eq(lockAmount));
  const settledLedger=await distributor.account.feePool.fetch(feePool);
  assert.equal(BigInt(settledLedger.creatorClaimable.toString()),graduationCreator+creatorPart(dammVault));
  assert.equal(BigInt(settledLedger.holderUnallocated.toString()),graduationHolders+dammVault-creatorPart(dammVault));
  assert.equal(BigInt(settledLedger.creatorClaimable.toString())+BigInt(settledLedger.holderUnallocated.toString())+BigInt(settledLedger.holderReserved.toString()),(await getAccount(connection,hypeVault)).amount);
  console.log(JSON.stringify({verifiedRealDammCpi:true,authenticDbcMigration:authenticMigration,distributable:(dammPlatform+dammVault).toString(),platform:dammPlatform.toString(),vault:dammVault.toString(),lockedLiquidityFeeContribution:expectedFees.feeTokenB.sub(unlockedOnly.feeTokenB).toString(),permanentlyLockedLiquidity:lockAmount.toString()}));
  const beforeDammClaims=(await getAccount(connection,traderHype)).amount;
  if(BigInt(settledLedger.creatorClaimable.toString())===0n) await rejected('creator DAMM claim at 0% creator share',await creatorClaim(),[payer],'NothingToClaim');
  else await submit('creator claims settled DAMM HYPE',await creatorClaim(),[payer]);
  const dammHolderAmount=BigInt(settledLedger.holderUnallocated.toString());
  const dammHolderBalance=(await getAccount(connection,getAssociatedTokenAddressSync(base.publicKey,payer.publicKey))).amount;
  const dammPlan=planHolderEpoch({mint:mintText,epoch:2n,snapshotSlot:BigInt((await connection.getSlot('confirmed'))-1),available:dammHolderAmount,holders:[{wallet:payer.publicKey.toBase58(),tokenBalance:dammHolderBalance}],hasHypeAccount:allHave,policy:testPolicy});
  await submit('fund holder epoch from settled DAMM HYPE',fund(platform.publicKey,dammPlan.fundedAmount,dammPlan),[platform]);
  await submit('push settled DAMM HYPE to holder',chunkTx(dammPlan.chunks[0],2n),[crank]);
  await submit('close DAMM payout epoch',close(2n),[platform]);
  const root2=dammPlan.root;
  assert.equal((await getAccount(connection,traderHype)).amount-beforeDammClaims,graduationRemainder+dammVault);
  assert.equal((await getAccount(connection,hypeVault)).amount,remainingHolders);
  console.log('PASS: creator claim and automatic holder payout from real DAMM fee settlement; prior reserved epoch remains fully backed');
  await verifyDistributorPool(connection,program,base.publicKey,payer.publicKey,pool,CREATOR_BPS);
  // Keeper key rotation: only the upgrade authority (payer here) can rotate; roles stay separate.
  // Seed-derived (loopback only) so validator-keeper-expiry.cjs can run the real keeper with this key afterwards.
  const keeper2=Keypair.fromSeed(createHash('sha256').update('HYMET LOCAL VALIDATOR ONLY KEEPER').digest());
  await confirm(await connection.requestAirdrop(keeper2.publicKey,1e9));
  const rotate=(signer,next)=>new Transaction().add(setSnapshotAuthorityInstruction(program,signer.publicKey,next));
  await rejected('snapshot authority rotates itself',rotate(platform,keeper2.publicKey),[platform],'NotUpgradeAuthority');
  await rejected('stranger rotates snapshot authority',rotate(stranger,keeper2.publicKey),[stranger],'NotUpgradeAuthority');
  await rejected('rotate to default key',rotate(payer,PublicKey.default),[payer],'InvalidRecipient');
  await rejected('rotate to upgrade authority',rotate(payer,payer.publicKey),[payer],'InvalidRecipient');
  await rejected('rotate to current snapshot authority',rotate(payer,platform.publicKey),[payer],'InvalidRecipient');
  await submit('upgrade authority rotates keeper key',rotate(payer,keeper2.publicKey),[payer]);
  assert((await connection.getAccountInfo(globalConfig)).data.subarray(72,104).equals(keeper2.publicKey.toBuffer()));
  await rejected('old keeper key loses epoch authority',close(1n,platform),[platform],'Unauthorized');
  await rejected('new keeper key passes authority (open epoch still active)',close(1n,keeper2),[keeper2],'EpochActive');
  await rejected('rotate to platform fee wallet',rotate(payer,platform.publicKey),[payer],'InvalidRecipient');
  console.log('PASS: keeper rotation restricted to the upgrade authority; old key revoked, new key authorized');
  const mint=await getMint(connection,hype);
  console.log(JSON.stringify({hypeMintAuthority:mint.mintAuthority?.toBase58()||null,hypeFreezeAuthority:mint.freezeAuthority?.toBase58()||null,localGenesisFunding:true}));
  fs.writeFileSync('work/application-proof.json',JSON.stringify({mint:base.publicKey.toBase58(),creator:payer.publicKey.toBase58(),dbcPool:pool.toBase58(),program:program.toBase58(),feePool:feePool.toBase58(),snapshotHash:snapshotHash.toString('hex'),epochs:[{epoch:'0',snapshotSlot:snapshotSlot.toString(),root:root.toString('hex'),funded:funded.toString(),chunks:chunkProof(plan)},{epoch:'2',snapshotSlot:dammPlan.snapshotSlot.toString(),root:root2.toString('hex'),funded:dammPlan.fundedAmount.toString(),chunks:chunkProof(dammPlan)}],execution},null,2));
})().catch(error=>{console.error(error.message);process.exitCode=1;});
