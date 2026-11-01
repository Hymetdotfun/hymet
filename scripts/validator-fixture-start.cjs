/* eslint-disable @typescript-eslint/no-require-imports -- standalone validator tooling */
// Local genesis funding only: no production keys, no changes to captured mint or Meteora state.
const fs=require('node:fs');
const {spawn}=require('node:child_process');
const {createHash}=require('node:crypto');
const {Keypair,PublicKey}=require('@solana/web3.js');
const {AccountLayout,TOKEN_PROGRAM_ID,getAssociatedTokenAddressSync}=require('@solana/spl-token');
const root='/srv/hymet-build';
const label=process.env.VALIDATOR_LEDGER_LABEL || 'meteora-funded-v3';
if (!/^meteora-funded-v\d+$/.test(label)) throw Error('Invalid isolated ledger label');
const faucetPort=Number(process.env.VALIDATOR_FAUCET_PORT || '19912');
if (!Number.isInteger(faucetPort) || faucetPort<19912 || faucetPort>19999) throw Error('Invalid isolated faucet port');
// Overridable for a separate verification checkout; both must stay inside the isolated build root.
const inRoot=(name,fallback)=>{const v=process.env[name]||fallback;if(!/^\/srv\/hymet-build\/[\w.-]+(\/[\w.-]+)*$/.test(v)||v.includes('..')) throw Error(`${name} must be inside ${root}`);return v;};
const workspace=inRoot('HYMET_VALIDATOR_WORKSPACE',`${root}/web-check`);
const programTarget=inRoot('HYMET_PROGRAM_TARGET',`${root}/src/target`);
if(process.cwd()!==workspace) throw Error('Run only in the isolated VPS fixture workspace');
const trader=Keypair.fromSeed(createHash('sha256').update('HYMET LOCAL VALIDATOR ONLY TRADER').digest());
const hype=new PublicKey('98sMhvDwXj1RQi5c5Mndm3vPe9cBqPrbLaufMXFNMh5g');
const account=getAssociatedTokenAddressSync(hype,trader.publicKey);
// Synthetic local-only HYPE balance (base units); default 1,000 HYPE. Only exists in this loopback genesis.
const faucet=BigInt(process.env.VALIDATOR_HYPE_FAUCET||'1000000000000');if(faucet<1n||faucet>18446744073709551615n) throw Error('Invalid VALIDATOR_HYPE_FAUCET');
const bytes=Buffer.alloc(AccountLayout.span);
AccountLayout.encode({mint:hype,owner:trader.publicKey,amount:faucet,delegateOption:0,delegate:PublicKey.default,state:1,isNativeOption:0,isNative:0n,delegatedAmount:0n,closeAuthorityOption:0,closeAuthority:PublicKey.default},bytes);
const fundingPath=`${workspace}/work/validator-fixtures/local-hype-faucet.json`;
fs.writeFileSync(fundingPath,JSON.stringify({pubkey:account.toBase58(),account:{lamports:2039280,data:[bytes.toString('base64'),'base64'],owner:TOKEN_PROGRAM_ID.toBase58(),executable:false,rentEpoch:0}}));
fs.writeFileSync(`${workspace}/work/validator-fixtures/local-funding-manifest.json`,JSON.stringify({syntheticLocalGenesisFunding:true,amount:faucet.toString(),mint:hype.toBase58(),tokenAccount:account.toBase58(),owner:trader.publicKey.toBase58(),mintDataModified:false,meteoraStateInjected:false},null,2));
const port=(name,fallback,min,max)=>{const n=Number(process.env[name]||fallback);if(!Number.isInteger(n)||n<min||n>max) throw Error(`Invalid isolated ${name}`);return n;};
const rpcPort=port('VALIDATOR_RPC_PORT',19899,19800,19999),gossipPort=port('VALIDATOR_GOSSIP_PORT',19001,19001,19099),dynamicStart=port('VALIDATOR_DYNAMIC_PORT_START',19100,19100,19180);
const args=['--ledger',`${root}/${label}-ledger`,'--rpc-port',String(rpcPort),'--gossip-port',String(gossipPort),'--faucet-port',String(faucetPort),'--dynamic-port-range',`${dynamicStart}-${dynamicStart+20}`,'--bind-address','127.0.0.1'];
// Load the distributor as an upgradeable program, as on Mainnet, so initialize's
// upgrade-authority check runs; the local-only trader key stands in for the deployer.
args.push('--upgradeable-program',JSON.parse(fs.readFileSync(`${programTarget}/idl/hymet_rewards_distributor.json`,'utf8')).address,`${programTarget}/deploy/hymet_rewards_distributor.so`,trader.publicKey.toBase58());
for(const [id,file] of [
 ['dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN',`${workspace}/work/validator-fixtures/dbc.so`],
 ['cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG',`${workspace}/work/validator-fixtures/damm.so`],
 ['metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',`${workspace}/work/validator-fixtures/metadata.so`],
]) args.push('--bpf-program',id,file);
args.push('--account',hype.toBase58(),`${workspace}/work/validator-fixtures/hype.json`,'--account',account.toBase58(),fundingPath);
const migrationFixture=`${workspace}/work/validator-fixtures/migrationConfig.json`;
if(fs.existsSync(migrationFixture)) args.push('--account',JSON.parse(fs.readFileSync(migrationFixture,'utf8')).pubkey,migrationFixture);
const log=fs.openSync(`${root}/${label}.log`,'a');
// Restart an existing ledger at a later slot (epoch-expiry tests); the ledger keeps all accounts.
if(process.env.VALIDATOR_WARP_SLOT){const w=Number(process.env.VALIDATOR_WARP_SLOT);if(!Number.isSafeInteger(w)||w<1) throw Error('Invalid VALIDATOR_WARP_SLOT');args.push('--warp-slot',String(w));}
const child=spawn(`${root}/.local/share/solana/install/active_release/bin/solana-test-validator`,args,{detached:true,stdio:['ignore',log,log]});
fs.writeFileSync(`${root}/${label}.pid`,String(child.pid));
child.unref();
console.log(`Started isolated validator PID ${child.pid}; local HYPE faucet account ${account.toBase58()}`);
