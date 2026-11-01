import { NextRequest, NextResponse } from 'next/server';
import { Connection, PublicKey, Transaction, ComputeBudgetProgram } from '@solana/web3.js';
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { DynamicBondingCurveClient, DAMM_V2_MIGRATION_FEE_ADDRESS } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { settlementInstructions } from '../../../../lib/distributor-settlement';
import { query } from '../../../../lib/db';
import { sameOrigin, limitedBody } from '../../../../lib/http';
import { HYPE_MINT } from '../../../../lib/quote-assets';
import { expectedGenesis, serverRpcUrl } from '../../../../lib/app-network';
import { configuredPlatformFeeRecipient } from '../../../../lib/transactions';
import { distributorAllowed } from '../../../../lib/launch-mode';
import { creatorDistributorClaim, verifyConfiguredDistributorAuthorities, verifyDistributorDeployment, verifyDistributorPool } from '../../../../lib/distributor-engine';
export const runtime='nodejs';
export async function POST(request:NextRequest) {
  if(!sameOrigin(request)) return NextResponse.json({error:'Origin denied'},{status:403});
  try {
    const body=JSON.parse(new TextDecoder().decode(await limitedBody(request,4096)));
    if(!['collect','migrate','creator'].includes(body.action)) throw Error('Unknown fee action');
    const mint=new PublicKey(body.mint),wallet=new PublicKey(body.wallet);
    const programText=process.env.HYMET_DISTRIBUTOR_PROGRAM_ID;
    if(!distributorAllowed() || !programText || process.env.HYMET_DISTRIBUTOR_VERIFIED!=='true' || process.env.HYMET_DISTRIBUTOR_APP_VERIFIED!=='true') throw Error('Distributor deployment and full application flow are not verified');
    const program=new PublicKey(programText),platform=configuredPlatformFeeRecipient();
    const connection=new Connection(serverRpcUrl(),'confirmed');
    if(await connection.getGenesisHash()!==expectedGenesis()) throw Error('RPC network mismatch');
    await verifyDistributorDeployment(connection,program,platform);
    await verifyConfiguredDistributorAuthorities(connection,program);
    const registered=await query<{creator_wallet:string;creator_share_of_remaining_bps:number;pool_address:string;distributor_program_id:string}>("SELECT t.creator_wallet,t.creator_share_of_remaining_bps,t.distributor_program_id,p.pool_address FROM tokens t JOIN pools p USING(mint_address) WHERE t.mint_address=$1 AND p.protocol='meteora_dbc'",[mint.toBase58()]);
    const token=registered.rows[0];
    if(!token || token.distributor_program_id!==programText) throw Error('Token is not bound to this distributor');
    const creator=new PublicKey(token.creator_wallet),dbcPool=new PublicKey(token.pool_address);
    const a=await verifyDistributorPool(connection,program,mint,creator,dbcPool,token.creator_share_of_remaining_bps);
    let tx=new Transaction();
    const sdk=new DynamicBondingCurveClient(connection,'confirmed');
    const pool=await sdk.state.getPool(dbcPool);
    if(!pool || !pool.poolState.baseMint.equals(mint)) throw Error('DBC mint or pool missing');
    const config=await sdk.state.getPoolConfig(pool.poolState.config);
    if(!config || !config.quoteMint.equals(HYPE_MINT) || !config.feeClaimer.equals(a.feePool)) throw Error('DBC distributor binding differs from launch');
    if(body.action==='creator') {
      if(!wallet.equals(creator)) throw Error('Only the creator can claim creator fees');
      tx.add(createAssociatedTokenAccountIdempotentInstruction(wallet,getAssociatedTokenAddressSync(HYPE_MINT,wallet),wallet,HYPE_MINT));
      tx.add(creatorDistributorClaim(program,mint,wallet));
    } else if(body.action==='migrate') {
      if(pool.poolState.isMigrated) throw Error('Pool is already migrated');
      const migration=await sdk.migration.migrateToDammV2({payer:wallet,pool:dbcPool,dammConfig:DAMM_V2_MIGRATION_FEE_ADDRESS[config.migrationFeeOption]});
      tx=migration.transaction;
      tx.instructions=tx.instructions.filter(ix=>!ix.programId.equals(ComputeBudgetProgram.programId));
      tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({units:1000000}));
      const block=await connection.getLatestBlockhash('confirmed');
      tx.feePayer=wallet;tx.recentBlockhash=block.blockhash;
      tx.partialSign(migration.firstPositionNftKeypair,migration.secondPositionNftKeypair);
      return NextResponse.json({transaction:tx.serialize({requireAllSignatures:false}).toString('base64'),...block,action:body.action},{headers:{'Cache-Control':'no-store'}});
    } else {
      // The creator signs migration registration from this route; the keeper uses its own authority.
      const settle=await settlementInstructions(connection,program,mint,dbcPool,platform,wallet,wallet.equals(creator)?creator:undefined);
      tx.add(...settle.instructions);
    }
    tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({units:1000000}));
    const block=await connection.getLatestBlockhash('confirmed');tx.feePayer=wallet;tx.recentBlockhash=block.blockhash;
    return NextResponse.json({transaction:tx.serialize({requireAllSignatures:false}).toString('base64'),...block,action:body.action},{headers:{'Cache-Control':'no-store'}});
  } catch(error) {
    return NextResponse.json({error:error instanceof Error?error.message:'Fee transaction construction failed'},{status:400,headers:{'Cache-Control':'no-store'}});
  }
}
