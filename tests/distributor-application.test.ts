import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { Connection, Keypair, PublicKey, TransactionInstruction } from '@solana/web3.js';
import { POST } from '../app/api/fees/transaction/route';
import { createDistributorPool, distributorAddresses, distributorSettlement, verifyDistributorDeployment, DISTRIBUTOR_PLACEHOLDER } from '../lib/distributor-engine';
afterEach(()=>{vi.unstubAllEnvs();vi.restoreAllMocks();});
describe('application distributor safeguards',()=>{
  it('rejects cross-origin fee transaction construction before RPC',async()=>{
    const fetcher=vi.spyOn(globalThis,'fetch');
    const result=await POST(new NextRequest('http://localhost/api/fees/transaction',{method:'POST',headers:{origin:'https://attacker.invalid'},body:'{}'}));
    expect(result.status).toBe(403);expect(fetcher).not.toHaveBeenCalled();
  });
  it('builds only creator claims: settlement and migration are keeper-only',async()=>{
    vi.stubEnv('HYMET_DISTRIBUTOR_VERIFIED','true');
    const fetcher=vi.spyOn(globalThis,'fetch');
    for(const action of ['collect','migrate']) {
      const result=await POST(new NextRequest('http://localhost/api/fees/transaction',{method:'POST',headers:{origin:'http://localhost','content-type':'application/json'},body:JSON.stringify({action,mint:Keypair.generate().publicKey.toBase58(),wallet:Keypair.generate().publicKey.toBase58()})}));
      expect(result.status).toBe(400);expect((await result.json()).error).toBe('Unknown fee action');
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('keeps financial transaction construction disabled without owner verification',async()=>{
    vi.stubEnv('HYMET_DISTRIBUTOR_VERIFIED','false');
    const fetcher=vi.spyOn(globalThis,'fetch');
    const result=await POST(new NextRequest('http://localhost/api/fees/transaction',{method:'POST',headers:{origin:'http://localhost','content-type':'application/json'},body:JSON.stringify({action:'creator',mint:Keypair.generate().publicKey.toBase58(),wallet:Keypair.generate().publicKey.toBase58()})}));
    expect(result.status).toBe(400);expect((await result.json()).error).toContain('not verified');expect(fetcher).not.toHaveBeenCalled();
  });
  it('never treats the validator placeholder as a production deployment',async()=>{
    const rpc={getMultipleAccountsInfo:vi.fn()} as unknown as Connection;
    await expect(verifyDistributorDeployment(rpc,new PublicKey(DISTRIBUTOR_PLACEHOLDER),Keypair.generate().publicKey)).rejects.toThrow('placeholder');
    expect(rpc.getMultipleAccountsInfo).not.toHaveBeenCalled();
  });
  it('rejects account substitution before constructing a settlement signer PDA',()=>{
    const program=Keypair.generate().publicKey,mint=Keypair.generate().publicKey,wallet=Keypair.generate().publicKey;
    const malicious=new TransactionInstruction({programId:Keypair.generate().publicKey,keys:[],data:Buffer.alloc(0)});
    expect(()=>distributorSettlement(program,mint,wallet,wallet,malicious)).toThrow('does not belong');
  });
  it('binds atomic launch custody to the mint and prevents invalid allocation input',()=>{
    const program=Keypair.generate().publicKey,mint=Keypair.generate().publicKey,creator=Keypair.generate().publicKey,pool=Keypair.generate().publicKey;
    const a=distributorAddresses(program,mint);
    const ix=createDistributorPool(program,mint,creator,pool,5000);
    expect(ix.keys[5].pubkey.equals(a.feePool)).toBe(true);
    expect(distributorAddresses(program,Keypair.generate().publicKey).feePool.equals(a.feePool)).toBe(false);
    expect(()=>createDistributorPool(program,mint,creator,pool,10001)).toThrow('Invalid');
  });
});
