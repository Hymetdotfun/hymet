import {afterEach,expect,it,vi} from 'vitest';
import {ComputeBudgetProgram,Connection,Keypair,Transaction,SystemProgram,VersionedTransaction} from '@solana/web3.js';
import {executeWalletOperation} from '../lib/wallet-operation';
afterEach(()=>vi.unstubAllEnvs());
function fixture(){
 const payer=Keypair.generate(),target=Keypair.generate().publicKey;
 const tx=new Transaction({feePayer:payer.publicKey,recentBlockhash:Keypair.generate().publicKey.toBase58()}).add(SystemProgram.transfer({fromPubkey:payer.publicKey,toPubkey:target,lamports:1}));
 const values=new Map<string,string>();const storage={getItem:(k:string)=>values.get(k)||null,setItem:(k:string,v:string)=>{values.set(k,v);}};
 const rpc={getGenesisHash:vi.fn(async()=>'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'),simulateTransaction:vi.fn(async(_tx:VersionedTransaction)=>({value:{err:null}})),getSignatureStatuses:vi.fn(async()=>({value:[null]})),getBlockHeight:vi.fn(async()=>1),sendRawTransaction:vi.fn(),confirmTransaction:vi.fn(async()=>({value:{err:null}}))};
 return {payer,tx,values,storage,rpc,c:rpc as unknown as Connection};
}
it('keeps financial operations disabled before signing',async()=>{const f=fixture();const sign=vi.fn();await expect(executeWalletOperation(f.c,f.tx,f.payer.publicKey,sign,f.storage,100)).rejects.toThrow('disabled');expect(sign).not.toHaveBeenCalled();});
it('rejects wallet message changes before broadcast',async()=>{vi.stubEnv('NEXT_PUBLIC_ENABLE_MAINNET','true');vi.stubEnv('ENABLE_MAINNET','true');const f=fixture();await expect(executeWalletOperation(f.c,f.tx,f.payer.publicKey,async t=>{t.instructions[0].data[0]^=1; t.partialSign(f.payer);return t;},f.storage,100)).rejects.toThrow('changed');expect(f.rpc.sendRawTransaction).not.toHaveBeenCalled();});
it('records the signature before an ambiguous send and prevents a second signing',async()=>{vi.stubEnv('NEXT_PUBLIC_ENABLE_MAINNET','true');vi.stubEnv('ENABLE_MAINNET','true');const f=fixture();const sign=vi.fn(async(t:Transaction)=>{t.partialSign(f.payer);return t;});f.rpc.sendRawTransaction.mockImplementation(async()=>{expect([...f.values.values()][0]).toContain('signed');throw Error('transport failed');});await expect(executeWalletOperation(f.c,f.tx,f.payer.publicKey,sign,f.storage,100)).rejects.toThrow('transport');await expect(executeWalletOperation(f.c,f.tx,f.payer.publicKey,sign,f.storage,100)).rejects.toThrow('unresolved');expect(sign).toHaveBeenCalledTimes(1);});
it('names a Phantom-inserted priority fee and still refuses to send',async()=>{vi.stubEnv('NEXT_PUBLIC_ENABLE_MAINNET','true');vi.stubEnv('ENABLE_MAINNET','true');const f=fixture();
 const phantom=async(t:Transaction)=>{t.instructions.unshift(ComputeBudgetProgram.setComputeUnitPrice({microLamports:100_000}));t.signatures=[];t.sign(f.payer);return t;};
 await expect(executeWalletOperation(f.c,f.tx,f.payer.publicKey,phantom,f.storage,100)).rejects.toThrow(/changed the reviewed transaction message \(compute budget \/ priority fee\)/);
 expect(f.rpc.sendRawTransaction).not.toHaveBeenCalled();});
