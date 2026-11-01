/* eslint-disable @typescript-eslint/no-require-imports -- standalone CommonJS validator tooling */
// Read-only public-chain fixture capture. Never signs or sends transactions.
const fs = require('node:fs/promises');
const path = require('node:path');
const {PublicKey} = require('@solana/web3.js');
const {createHash} = require('node:crypto');
const addresses = {
  hype: '98sMhvDwXj1RQi5c5Mndm3vPe9cBqPrbLaufMXFNMh5g',
  dbc: 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN',
  damm: 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG',
  metadata: 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',
  migrationConfig: require('@meteora-ag/dynamic-bonding-curve-sdk').DAMM_V2_MIGRATION_FEE_ADDRESS[6].toBase58(),
};
async function rpc(method, params) {
  const response = await fetch(process.env.FIXTURE_RPC_URL || 'https://api.mainnet-beta.solana.com', {
    method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`Fixture RPC HTTP ${response.status}`);
  const body = await response.json();
  if (body.error) throw new Error(JSON.stringify(body.error));
  return body.result;
}
(async()=>{
  const destination = path.resolve('work/validator-fixtures');
  await fs.mkdir(destination,{recursive:true});
  const manifest = {rpc:process.env.FIXTURE_RPC_URL ? 'configured' : 'public-mainnet',mocked:false,accounts:[]};
  const fetched = await rpc('getMultipleAccounts',[Object.values(addresses),{encoding:'base64',commitment:'finalized'}]);
  for (const [index,[name,address]] of Object.entries(addresses).entries()) {
    const account = fetched.value[index];
    if (!account) throw new Error(`Missing real fixture ${name}: ${address}`);
    const data = Buffer.from(account.data[0],'base64');
    // Mainnet rentEpoch may be u64::MAX, which JSON.parse rounds beyond u64.
    // Local genesis uses epoch zero; preserve the authentic account data bytes.
    await fs.writeFile(path.join(destination,`${name}.json`),JSON.stringify({pubkey:address,account:{...account,rentEpoch:0}}));
    const record = {name,address,slot:fetched.context.slot,owner:account.owner,genesisOverrides:{rentEpoch:0},sha256:createHash('sha256').update(data).digest('hex')};
    if (account.executable) {
      if (!account.executable || data.readUInt32LE(0)!==2) throw new Error(`Unexpected program loader layout: ${name}`);
      const programDataAddress = new PublicKey(data.subarray(4,36)).toBase58();
      const result = await rpc('getAccountInfo',[programDataAddress,{encoding:'base64',commitment:'finalized'}]);
      if (!result.value || result.value.owner!==account.owner) throw new Error(`Missing/invalid program data: ${name}`);
      const bytes = Buffer.from(result.value.data[0],'base64');
      if (bytes.readUInt32LE(0)!==3) throw new Error('Invalid upgradeable ProgramData');
      const binary = bytes.subarray(45);
      await fs.writeFile(path.join(destination,`${name}.so`),binary);
      record.programDataAddress=programDataAddress;
      record.binarySha256=createHash('sha256').update(binary).digest('hex');
      record.programDataSlot=result.context.slot;
    }
    manifest.accounts.push(record);
  }
  await fs.writeFile(path.join(destination,'manifest.json'),JSON.stringify(manifest,null,2));
  console.log(JSON.stringify(manifest,null,2));
})().catch(error=>{console.error(error.message);process.exitCode=1;});
