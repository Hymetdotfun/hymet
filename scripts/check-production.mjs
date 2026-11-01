// Read-only deployment review. Does not generate keys, deploy, sign, or send transactions.
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {Connection,PublicKey} from '@solana/web3.js';
import {getMint,TOKEN_PROGRAM_ID} from '@solana/spl-token';
const blockers=[];
const placeholder='CWDBD8de82UWLL3xZBd117t3uPoe25ZKy5TcHLLTg9xY';
const manifest=JSON.parse(await readFile(new URL('../config/production.json',import.meta.url),'utf8'));
const environment={...process.env,HYMET_DISTRIBUTOR_PROGRAM_ID:process.env.HYMET_DISTRIBUTOR_PROGRAM_ID||manifest.distributorProgramId,HYMET_PLATFORM_FEE_RECIPIENT:process.env.HYMET_PLATFORM_FEE_RECIPIENT||manifest.platformFeeWallet,HYMET_SNAPSHOT_AUTHORITY:process.env.HYMET_SNAPSHOT_AUTHORITY||manifest.snapshotAuthority,HYMET_DEPLOYER:process.env.HYMET_DEPLOYER||manifest.deployer,HYMET_UPGRADE_AUTHORITY:process.env.HYMET_UPGRADE_AUTHORITY||manifest.upgradeAuthority};
const configured=environment.HYMET_DISTRIBUTOR_PROGRAM_ID;
// Phase 1 "native-split": Meteora enforces 20% HYMET / 80% creator; the distributor is deferred and must stay off.
const mode=manifest.launchMode==='distributor'?'distributor':'native-split';
const native=mode==='native-split';
if((process.env.HYMET_LAUNCH_MODE||'native-split')!==mode) blockers.push(`HYMET_LAUNCH_MODE must be ${mode} (config/production.json)`);
// Browser (NEXT_PUBLIC_) and server RPC proxy switches must agree, or wallet operations fail after signing starts.
if((process.env.NEXT_PUBLIC_ENABLE_MAINNET==='true')!==(process.env.ENABLE_MAINNET==='true')) blockers.push('NEXT_PUBLIC_ENABLE_MAINNET and ENABLE_MAINNET must be set together');
if(process.env.NEXT_PUBLIC_ENABLE_MAINNET==='true'&&process.env.HYPE_DEV_READ_ONLY==='true') blockers.push('HYPE_DEV_READ_ONLY=true blocks broadcasting while Mainnet is enabled');
if(native&&(process.env.HYMET_DISTRIBUTOR_VERIFIED==='true'||process.env.HYMET_DISTRIBUTOR_APP_VERIFIED==='true'||process.env.HYMET_HOLDER_PAYOUTS_VERIFIED==='true'||process.env.NEXT_PUBLIC_HYMET_HOLDER_REWARDS==='true')) blockers.push('Distributor/holder-reward flags must stay false in native-split mode');
if(process.env.NEXT_PUBLIC_HYMET_HOLDER_REWARDS==='true'&&process.env.HYMET_HOLDER_PAYOUTS_VERIFIED!=='true') blockers.push('The launch form must not offer holder allocations before the payout keeper is verified');
if(native&&(manifest.holderSplits||manifest.nativeSplit?.platformPercent!==20||manifest.nativeSplit?.creatorPercent!==80||manifest.nativeSplit?.holderPercent!==0)) blockers.push('native-split manifest must be 20% platform / 80% creator / 0% holders');
// The app reads only process.env; the manifest fallback above must not hide a missing runtime value.
for(const [name,expected] of [['HYMET_PLATFORM_FEE_RECIPIENT',manifest.platformFeeWallet],['NEXT_PUBLIC_HYMET_PLATFORM_FEE_RECIPIENT',manifest.platformFeeWallet],...(native?[]:[['HYMET_SNAPSHOT_AUTHORITY',manifest.snapshotAuthority],['HYMET_DEPLOYER',manifest.deployer],['HYMET_UPGRADE_AUTHORITY',manifest.upgradeAuthority]])])
  if(process.env[name]!==expected) blockers.push(`${name}: runtime environment must equal config/production.json`);
if(process.env.HYMET_DISTRIBUTOR_PROGRAM_ID&&process.env.HYMET_DISTRIBUTOR_PROGRAM_ID!==manifest.distributorProgramId) blockers.push('HYMET_DISTRIBUTOR_PROGRAM_ID differs from config/production.json');
const publicKeys={};
for(const name of native?['HYMET_PLATFORM_FEE_RECIPIENT']:['HYMET_DISTRIBUTOR_PROGRAM_ID','HYMET_PLATFORM_FEE_RECIPIENT','HYMET_SNAPSHOT_AUTHORITY','HYMET_DEPLOYER']) {
  try { if(!environment[name]) throw Error();publicKeys[name]=new PublicKey(environment[name]);if(name!=='HYMET_DISTRIBUTOR_PROGRAM_ID'&&!PublicKey.isOnCurve(publicKeys[name].toBytes())) throw Error(); }
  catch {blockers.push(`${name}: owner-provided public address required`);}
}
const source=await readFile(new URL('../programs/hymet-rewards-distributor/src/lib.rs',import.meta.url),'utf8');
// Roles: platform fee recipient (+ legacy feeClaimers of earlier pools), keeper, deployment payer, owner upgrade authority.
// The payer cannot sign for the owner, and the program lets only the upgrade authority sign and pay `initialize`.
const legacy=manifest.legacyPlatformFeeWallets??[];
// deployKey: CLI key that uploads and deploys (the payer is Phantom-only) and holds the authority only until handover.
const roles=[environment.HYMET_PLATFORM_FEE_RECIPIENT,...legacy,environment.HYMET_SNAPSHOT_AUTHORITY,environment.HYMET_DEPLOYER,environment.HYMET_UPGRADE_AUTHORITY,manifest.deployKey];
if(roles.some(k=>!k)||new Set(roles).size!==roles.length) blockers.push('Platform fee wallet, legacy fee wallets, snapshot authority, deployment payer, upgrade authority and deploy key must all be distinct');
for(const k of legacy){try{if(new PublicKey(k).toBase58()!==k) throw Error();}catch{blockers.push(`legacyPlatformFeeWallets: invalid address ${k}`);}}
const init=manifest.initialization??{};
if(init.signerAndPayer!==manifest.upgradeAuthority) blockers.push('initialization.signerAndPayer must be the owner upgrade authority (the program accepts only it)');
if(init.platformWallet!==manifest.platformFeeWallet||init.snapshotAuthority!==manifest.snapshotAuthority) blockers.push('initialization platform wallet / snapshot authority differ from config/production.json');
const anchor=await readFile(new URL('../Anchor.toml',import.meta.url),'utf8');
if(!native&&(!configured || configured===placeholder || !source.includes(`declare_id!("${configured}")`) || !anchor.includes(`"${configured}"`))) blockers.push('Production program ID must be owner-generated and match the reviewed Rust and Anchor build');
if(process.argv.includes('--online')) {
  const c=new Connection(process.env.MAINNET_RPC_URL||'https://api.mainnet-beta.solana.com','confirmed');
  if(await c.getGenesisHash()!=='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d') throw Error('RPC is not Mainnet');
  const mint=await getMint(c,new PublicKey('98sMhvDwXj1RQi5c5Mndm3vPe9cBqPrbLaufMXFNMh5g'),'confirmed',TOKEN_PROGRAM_ID);
  if(mint.decimals!==9 || mint.freezeAuthority!==null) blockers.push('HYPE mint decimals/freeze authority mismatch');
  for(const id of ['dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN','cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG']) if(!(await c.getAccountInfo(new PublicKey(id)))?.executable) blockers.push(`Meteora program not executable: ${id}`);
  if(native) {
    const migration=await c.getAccountInfo(new PublicKey(manifest.nativeSplit.dammMigrationConfig),'confirmed');
    if(!migration?.owner.equals(new PublicKey('cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG'))) blockers.push('DAMM v2 migration config for DBC graduation is missing on Mainnet');
  }
  if(!native && configured && configured!==placeholder && publicKeys.HYMET_DISTRIBUTOR_PROGRAM_ID) {
    const program=publicKeys.HYMET_DISTRIBUTOR_PROGRAM_ID;
    const config=PublicKey.findProgramAddressSync([Buffer.from('config')],program)[0];
    const [binary,state]=await c.getMultipleAccountsInfo([program,config]);
    if(!binary?.executable || !state?.owner.equals(program)) blockers.push('Production distributor/config not deployed and initialized');
    else {
      if(!publicKeys.HYMET_PLATFORM_FEE_RECIPIENT || !state.data.subarray(40,72).equals(publicKeys.HYMET_PLATFORM_FEE_RECIPIENT.toBuffer())) blockers.push('HYMET recipient differs from on-chain custody configuration');
      if(!publicKeys.HYMET_SNAPSHOT_AUTHORITY || !state.data.subarray(72,104).equals(publicKeys.HYMET_SNAPSHOT_AUTHORITY.toBuffer())) blockers.push('Snapshot authority differs from on-chain configuration');
      if(!state.data.subarray(8,40).equals(new PublicKey(manifest.upgradeAuthority).toBuffer())) blockers.push('Config admin is not the owner upgrade authority that initialized it');
    }
    // ProgramData: u32 tag 3, u64 slot, Option<Pubkey> upgrade authority, then the ELF bytes.
    const programData=PublicKey.findProgramAddressSync([program.toBuffer()],new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'))[0];
    const pd=(await c.getAccountInfo(programData,'confirmed'))?.data;
    if(!pd || pd.readUInt32LE(0)!==3) blockers.push('Distributor ProgramData account missing');
    else {
      const authority=pd[12]===1?new PublicKey(pd.subarray(13,45)).toBase58():null;
      const expectedAuthority=manifest.upgradeAuthority;
      if(authority!==expectedAuthority) blockers.push(`Upgrade authority is ${authority??'none (immutable)'}, expected ${expectedAuthority}`);
      if(manifest.programSha256) {
        const so=await readFile(new URL('../'+manifest.programArtifact,import.meta.url)).catch(()=>null);
        const deployed=pd.subarray(45,45+(so?.length??0));
        if(!so || createHash('sha256').update(so).digest('hex')!==manifest.programSha256) blockers.push('Local program artifact missing or differs from reviewed programSha256');
        else if(!deployed.equals(so) || pd.subarray(45+so.length).some(b=>b!==0)) blockers.push('On-chain program bytes differ from the reviewed build');
      }
    }
  }
}
console.log(JSON.stringify({readOnly:true,launchMode:mode,distributor:native?'deferred (not required)':'required',technicalBlockers:blockers.length,productionReady:false,blockers,financialOperationsEnabled:process.env.NEXT_PUBLIC_ENABLE_MAINNET==='true'&&process.env.ENABLE_MAINNET==='true',holderSplitsEnabled:!native&&process.env.HYMET_DISTRIBUTOR_VERIFIED==='true'&&process.env.HYMET_DISTRIBUTOR_APP_VERIFIED==='true',holderPayoutsAutomatic:!native&&process.env.HYMET_DISTRIBUTOR_VERIFIED==='true'&&process.env.HYMET_DISTRIBUTOR_APP_VERIFIED==='true'&&process.env.HYMET_HOLDER_PAYOUTS_VERIFIED==='true',nextRequiredCheck:'Owner review and authorized Phantom Mainnet verification are required before activation'},null,2));
if(blockers.length) process.exitCode=1;
