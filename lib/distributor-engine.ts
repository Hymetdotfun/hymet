import { Buffer } from "buffer";
import { sha256 } from "@noble/hashes/sha256";
import { Connection, PublicKey, SystemProgram, TransactionInstruction, type AccountMeta } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, getAccount } from "@solana/spl-token";
import { HYPE_MINT } from "./quote-assets";
export const DISTRIBUTOR_PLACEHOLDER = "CWDBD8de82UWLL3xZBd117t3uPoe25ZKy5TcHLLTg9xY";
const discriminator = (name: string) => Buffer.from(sha256(Buffer.from(name))).subarray(0, 8);
export function distributorAddresses(program: PublicKey, mint: PublicKey) {
  const config = PublicKey.findProgramAddressSync([Buffer.from("config")], program)[0];
  const feePool = PublicKey.findProgramAddressSync([Buffer.from("fee-pool"), mint.toBuffer()], program)[0];
  return { config, feePool, baseVault: getAssociatedTokenAddressSync(mint, feePool, true), hypeVault: getAssociatedTokenAddressSync(HYPE_MINT, feePool, true) };
}
export function createDistributorPool(program: PublicKey, mint: PublicKey, creator: PublicKey, dbcPool: PublicKey, creatorBps: number) {
  if (!Number.isInteger(creatorBps) || creatorBps < 0 || creatorBps > 10000) throw Error("Invalid distributor split");
  const a = distributorAddresses(program, mint);
  const split = Buffer.alloc(2); split.writeUInt16LE(creatorBps);
  return new TransactionInstruction({ programId: program, data: Buffer.concat([discriminator("global:create_fee_pool"), split]), keys: [
    [creator, true, true], [a.config, false, false], [HYPE_MINT, false, false], [dbcPool, false, false], [mint, false, false],
    [a.feePool, false, true], [a.baseVault, false, true], [a.hypeVault, false, true],
    [TOKEN_PROGRAM_ID, false, false], [ASSOCIATED_TOKEN_PROGRAM_ID, false, false], [SystemProgram.programId, false, false],
  ].map(([pubkey,isSigner,isWritable]) => ({ pubkey: pubkey as PublicKey, isSigner: isSigner as boolean, isWritable: isWritable as boolean })) });
}
const UPGRADEABLE_LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
/** Upgrade authority recorded in the program's ProgramData account; null when immutable. */
export async function programUpgradeAuthority(c: Connection, program: PublicKey) {
  const programData = PublicKey.findProgramAddressSync([program.toBuffer()], UPGRADEABLE_LOADER)[0];
  const data = (await c.getAccountInfo(programData, "confirmed"))?.data;
  // ProgramData: u32 state tag (3), u64 slot, Option<Pubkey> authority.
  if (!data || data.length < 45 || data.readUInt32LE(0) !== 3) throw Error("Distributor ProgramData account is missing");
  return data[12] === 1 ? new PublicKey(data.subarray(13, 45)) : null;
}
/** Server-side check of the owner-designated snapshot authority and upgrade authority. */
export async function verifyDistributorAuthorities(c: Connection, program: PublicKey, snapshotAuthority: PublicKey, upgradeAuthority: PublicKey) {
  const state = await c.getAccountInfo(PublicKey.findProgramAddressSync([Buffer.from("config")], program)[0], "confirmed");
  if (!state?.data.subarray(72, 104).equals(snapshotAuthority.toBuffer())) throw Error("Distributor snapshot authority differs from HYMET_SNAPSHOT_AUTHORITY");
  const authority = await programUpgradeAuthority(c, program);
  if (authority && !authority.equals(upgradeAuthority)) throw Error("Distributor upgrade authority differs from HYMET_UPGRADE_AUTHORITY");
}
/** Server routes only: owner-designated authorities from the runtime environment. */
export async function verifyConfiguredDistributorAuthorities(c: Connection, program: PublicKey) {
  // The owner's upgrade authority is a separate wallet from the deployment payer (HYMET_DEPLOYER); it may later move to a multisig.
  const snapshot = process.env.HYMET_SNAPSHOT_AUTHORITY,
    upgrade = process.env.HYMET_UPGRADE_AUTHORITY;
  if (!snapshot || !upgrade) throw Error("HYMET_SNAPSHOT_AUTHORITY and HYMET_UPGRADE_AUTHORITY must be configured");
  await verifyDistributorAuthorities(c, program, new PublicKey(snapshot), new PublicKey(upgrade));
}
export async function verifyDistributorDeployment(c: Connection, program: PublicKey, platform: PublicKey) {
  if (program.toBase58() === DISTRIBUTOR_PLACEHOLDER) throw Error("Production distributor cannot use the local placeholder ID");
  const config = PublicKey.findProgramAddressSync([Buffer.from("config")], program)[0];
  const [executable, state] = await c.getMultipleAccountsInfo([program, config], "confirmed");
  if (!executable?.executable || !state?.owner.equals(program) || state.data.length !== 105 || !state.data.subarray(0,8).equals(discriminator("account:DistributorConfig")) || !state.data.subarray(40,72).equals(platform.toBuffer())) throw Error("Distributor deployment or HYMET recipient is not verified");
  if(new PublicKey(state.data.subarray(72,104)).equals(PublicKey.default)) throw Error('Distributor snapshot authority is not initialized');
  return config;
}
export async function verifyDistributorPool(c: Connection, program: PublicKey, mint: PublicKey, creator: PublicKey, pool: PublicKey, creatorBps: number) {
  const a = distributorAddresses(program, mint);
  const state = await c.getAccountInfo(a.feePool, "confirmed");
  if (!state?.owner.equals(program) || state.data.length < 187 || !state.data.subarray(0,8).equals(discriminator("account:FeePool")) || !state.data.subarray(8,40).equals(creator.toBuffer()) || !state.data.subarray(40,72).equals(mint.toBuffer()) || !state.data.subarray(72,104).equals(pool.toBuffer()) || state.data.readUInt16LE(136) !== creatorBps) throw Error("Confirmed distributor pool or allocation differs from launch");
  const [hype,base]=await Promise.all([getAccount(c,a.hypeVault,'confirmed',TOKEN_PROGRAM_ID),getAccount(c,a.baseVault,'confirmed',TOKEN_PROGRAM_ID)]);
  for(const [vault,expectedMint] of [[hype,HYPE_MINT],[base,mint]] as const) if(!vault.owner.equals(a.feePool) || !vault.mint.equals(expectedMint) || vault.isFrozen || vault.delegate || vault.closeAuthority) throw Error('Distributor vault custody is not exclusive');
  const liabilities=state.data.readBigUInt64LE(138)+state.data.readBigUInt64LE(146)+state.data.readBigUInt64LE(154);
  if(hype.amount<liabilities) throw Error('Distributor HYPE vault does not cover recorded liabilities');
  return a;
}
/** `registrar` is the token creator or the distributor's snapshot authority (the payout keeper). */
export function registerDistributorMigration(program: PublicKey, mint: PublicKey, registrar: PublicKey, dammPool: PublicKey) {
  const a=distributorAddresses(program,mint);
  return new TransactionInstruction({programId:program,data:discriminator('global:register_damm_pool'),keys:[{pubkey:a.feePool,isSigner:false,isWritable:true},{pubkey:a.config,isSigner:false,isWritable:false},{pubkey:registrar,isSigner:true,isWritable:false},{pubkey:dammPool,isSigner:false,isWritable:false}]});
}
export function creatorDistributorClaim(program: PublicKey, mint: PublicKey, creator: PublicKey) {
  const a=distributorAddresses(program,mint);
  return new TransactionInstruction({programId:program,data:discriminator('global:claim_creator'),keys:[
    {pubkey:a.feePool,isSigner:false,isWritable:true},{pubkey:creator,isSigner:true,isWritable:true},
    {pubkey:a.hypeVault,isSigner:false,isWritable:true},{pubkey:getAssociatedTokenAddressSync(HYPE_MINT,creator),isSigner:false,isWritable:true},
    {pubkey:HYPE_MINT,isSigner:false,isWritable:false},{pubkey:TOKEN_PROGRAM_ID,isSigner:false,isWritable:false},
  ]});
}
const u64=(n:bigint)=>{if(n<0n || n>0xffff_ffff_ffff_ffffn) throw Error('Epoch value exceeds u64');const b=Buffer.alloc(8);b.writeBigUInt64LE(n);return b;};
const u32=(n:number)=>{const b=Buffer.alloc(4);b.writeUInt32LE(n);return b;};
export function holderEpochAddress(program:PublicKey,mint:PublicKey,epoch:bigint) {
  return PublicKey.findProgramAddressSync([Buffer.from('epoch'),distributorAddresses(program,mint).feePool.toBuffer(),u64(epoch)],program)[0];
}
export function fundDistributorEpoch(program:PublicKey,mint:PublicKey,authority:PublicKey,input:{epoch:bigint;snapshotSlot:bigint;snapshotHash:string;root:string;amount:bigint;chunkCount:number}) {
  if(input.amount<=0n || !/^[0-9a-f]{64}$/.test(input.snapshotHash) || !/^[0-9a-f]{64}$/.test(input.root) || !Number.isInteger(input.chunkCount) || input.chunkCount<1 || input.chunkCount>1024) throw Error('Invalid funded snapshot');
  const a=distributorAddresses(program,mint),epoch=holderEpochAddress(program,mint,input.epoch);
  return new TransactionInstruction({programId:program,data:Buffer.concat([discriminator('global:fund_holder_epoch'),u64(input.epoch),u64(input.snapshotSlot),Buffer.from(input.snapshotHash,'hex'),Buffer.from(input.root,'hex'),u64(input.amount),u32(input.chunkCount)]),keys:[{pubkey:a.feePool,isSigner:false,isWritable:true},{pubkey:a.config,isSigner:false,isWritable:false},{pubkey:authority,isSigner:true,isWritable:true},{pubkey:epoch,isSigner:false,isWritable:true},{pubkey:SystemProgram.programId,isSigner:false,isWritable:false}]});
}
/** Permissionless push of one committed chunk to each holder's canonical HYPE ATA. */
export function distributeHolderChunk(program:PublicKey,mint:PublicKey,payer:PublicKey,input:{epoch:bigint;chunkIndex:number;entries:{wallet:string;tokenBalance:bigint;reward:bigint}[];proof:Buffer[]}) {
  if(!input.entries.length || input.entries.length>6 || input.proof.length>32 || input.proof.some(p=>p.length!==32)) throw Error('Invalid holder payout chunk');
  const a=distributorAddresses(program,mint);
  const args=Buffer.concat([u32(input.chunkIndex),u32(input.entries.length),...input.entries.flatMap(e=>[u64(e.tokenBalance),u64(e.reward)]),u32(input.proof.length),...input.proof]);
  const keys:AccountMeta[]=[
    {pubkey:a.feePool,isSigner:false,isWritable:true},{pubkey:holderEpochAddress(program,mint,input.epoch),isSigner:false,isWritable:true},
    {pubkey:a.hypeVault,isSigner:false,isWritable:true},{pubkey:HYPE_MINT,isSigner:false,isWritable:false},
    {pubkey:TOKEN_PROGRAM_ID,isSigner:false,isWritable:false},{pubkey:payer,isSigner:true,isWritable:false},
    ...input.entries.flatMap(e=>{const wallet=new PublicKey(e.wallet);return [{pubkey:wallet,isSigner:false,isWritable:false},{pubkey:getAssociatedTokenAddressSync(HYPE_MINT,wallet,true),isSigner:false,isWritable:true}];}),
  ];
  return new TransactionInstruction({programId:program,data:Buffer.concat([discriminator('global:distribute_holder_chunk'),args]),keys});
}
export function closeHolderEpoch(program:PublicKey,mint:PublicKey,authority:PublicKey,epoch:bigint) {
  const a=distributorAddresses(program,mint);
  return new TransactionInstruction({programId:program,data:discriminator('global:close_holder_epoch'),keys:[
    {pubkey:a.feePool,isSigner:false,isWritable:true},{pubkey:a.config,isSigner:false,isWritable:false},
    {pubkey:authority,isSigner:true,isWritable:true},{pubkey:holderEpochAddress(program,mint,epoch),isSigner:false,isWritable:true},
  ]});
}
/** FeePool accounting fields (offsets follow the program's Borsh layout). */
export function decodeFeePool(data:Buffer) {
  if(data.length<195 || !data.subarray(0,8).equals(discriminator('account:FeePool'))) throw Error('Not a distributor FeePool account');
  return {creator:new PublicKey(data.subarray(8,40)),mint:new PublicKey(data.subarray(40,72)),dbcPool:new PublicKey(data.subarray(72,104)),dammPool:new PublicKey(data.subarray(104,136)),
    creatorBpsOfRemaining:data.readUInt16LE(136),creatorClaimable:data.readBigUInt64LE(138),holderUnallocated:data.readBigUInt64LE(146),holderReserved:data.readBigUInt64LE(154),
    nextEpoch:data.readBigUInt64LE(162),totalSettled:data.readBigUInt64LE(170),totalPlatform:data.readBigUInt64LE(178),lastSnapshotSlot:data.readBigUInt64LE(187)};
}
export function distributorSettlement(program: PublicKey, mint: PublicKey, platform: PublicKey, caller: PublicKey, sdkClaim: TransactionInstruction, positionNft?: PublicKey) {
  const a=distributorAddresses(program,mint);
  const damm=Boolean(positionNft), expectedProgram=new PublicKey(damm?'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG':'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN');
  const signerIndex=damm?10:9;
  if(!sdkClaim.programId.equals(expectedProgram) || sdkClaim.keys.length!==(damm?15:14) || !sdkClaim.keys[signerIndex].pubkey.equals(a.feePool)) throw Error('Meteora claim does not belong to the distributor');
  const keys:AccountMeta[]=[
    {pubkey:a.feePool,isSigner:false,isWritable:true},{pubkey:a.config,isSigner:false,isWritable:false},
    {pubkey:a.baseVault,isSigner:false,isWritable:true},{pubkey:a.hypeVault,isSigner:false,isWritable:true},
    {pubkey:getAssociatedTokenAddressSync(HYPE_MINT,platform),isSigner:false,isWritable:true},{pubkey:HYPE_MINT,isSigner:false,isWritable:false},
  ];
  if(positionNft) keys.push({pubkey:positionNft,isSigner:false,isWritable:false});
  keys.push({pubkey:TOKEN_PROGRAM_ID,isSigner:false,isWritable:false},{pubkey:caller,isSigner:true,isWritable:false});
  keys.push(...sdkClaim.keys.filter((_,i)=>i!==signerIndex).map(k=>({...k,isSigner:false})));
  return new TransactionInstruction({programId:program,data:discriminator(damm?'global:settle_damm_v2':'global:settle_dbc'),keys});
}
