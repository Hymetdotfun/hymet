/* eslint-disable @typescript-eslint/no-require-imports -- standalone CommonJS validator tooling */
// Local validator only. No key files, production RPC, or production funds.
const {Connection, PublicKey, Keypair, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction} = require('@solana/web3.js');
const {createHash} = require('node:crypto');
const assert = require('node:assert/strict');
(async () => {
  const endpoint = process.env.VALIDATOR_RPC_URL || 'http://127.0.0.1:19899';
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint)) throw new Error('Validator tests require a loopback RPC');
  const connection = new Connection(endpoint, 'confirmed');
  connection.confirmTransaction = async (transaction) => {
    const signature = typeof transaction === 'string' ? transaction : transaction.signature;
    for (let attempt=0; attempt<60; attempt++) {
      const result = await connection.getSignatureStatuses([signature]);
      const status = result.value[0];
      if (status && ['confirmed','finalized'].includes(status.confirmationStatus)) return {context:result.context,value:{err:status.err}};
      await new Promise(resolve=>setTimeout(resolve,500));
    }
    throw new Error('Local transaction confirmation timed out');
  };
  const genesis = await connection.getGenesisHash();
  assert.notEqual(genesis, '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2d');
  const programId = new PublicKey(require('../config/production.json').distributorProgramId);
  assert.equal((await connection.getAccountInfo(programId)).executable, true);
  const payer = Keypair.generate();
  const signature = await connection.requestAirdrop(payer.publicKey, 2e9);
  await connection.confirmTransaction(signature, 'confirmed');
  if (process.env.VERIFY_METEORA_BINARIES === 'true') {
    for (const [address,name,args] of [
      ['dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN','claim_trading_fee',Buffer.alloc(16,255)],
      ['cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG','claim_position_fee',Buffer.alloc(0)],
    ]) {
      const target = new PublicKey(address);
      assert.equal((await connection.getAccountInfo(target)).executable,true);
      const transaction = new Transaction({feePayer:payer.publicKey,recentBlockhash:(await connection.getLatestBlockhash()).blockhash}).add(new TransactionInstruction({programId:target,keys:[],data:Buffer.concat([createHash('sha256').update(`global:${name}`).digest().subarray(0,8),args])}));
      const result = await connection.simulateTransaction(transaction);
      assert(result.value.err);
      assert(result.value.logs.some(line=>line.includes('AccountNotEnoughKeys')));
      console.log(`PASS: actual ${name} binary rejects missing accounts (negative direct invocation; NOT successful distributor CPI)`);
    }
  }
  const [config] = PublicKey.findProgramAddressSync([Buffer.from('config')], programId);
  const authority = Keypair.generate().publicKey;
  const programData = PublicKey.findProgramAddressSync([programId.toBuffer()], new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'))[0];
  const ix = new TransactionInstruction({programId, keys:[
    {pubkey:payer.publicKey,isSigner:true,isWritable:true},
    {pubkey:payer.publicKey,isSigner:false,isWritable:false},
    {pubkey:config,isSigner:false,isWritable:true},
    {pubkey:programId,isSigner:false,isWritable:false},
    {pubkey:programData,isSigner:false,isWritable:false},
    {pubkey:SystemProgram.programId,isSigner:false,isWritable:false},
  ], data:Buffer.concat([createHash('sha256').update('global:initialize').digest().subarray(0,8),authority.toBuffer()])});
  if (await connection.getAccountInfo(config)) {
    const before = await connection.getAccountInfo(config);
    assert(before.owner.equals(programId));
    await assert.rejects(sendAndConfirmTransaction(connection,new Transaction().add(ix),[payer]));
    assert((await connection.getAccountInfo(config)).data.equals(before.data));
    console.log('PASS: persisted config rejects unauthorized reinitialization without changing authority (fresh initialization was not repeated)');
    return;
  }
  // A random payer is not the upgrade authority, so a fresh initialize must be rejected.
  await assert.rejects(sendAndConfirmTransaction(connection,new Transaction().add(ix),[payer]));
  assert.equal(await connection.getAccountInfo(config), null);
  console.log('PASS: local SBF execution; non-upgrade-authority initialization rejected without creating config');
})().catch(error => { console.error(error); process.exitCode=1; });
