import { Buffer } from 'buffer';
import bs58 from 'bs58';
import { ComputeBudgetProgram, Connection, Message, PublicKey, Transaction } from '@solana/web3.js';
import { awaitSignature, simulateReviewedTransaction } from './transactions';
import { expectedGenesis, assertMainnetTransactionsEnabled } from './app-network';
type Store=Pick<Storage,'getItem'|'setItem'>;
/** Human-readable summary of how a wallet altered a reviewed message (diagnostics only; the byte comparison decides). */
export function messageChanges(reviewed:Buffer,signed:Transaction) {
  // From the saved bytes: a wallet may mutate the reviewed Transaction object in place.
  const a=Message.from(reviewed), b=signed.compileMessage();
  const budget=(m:typeof a)=>m.instructions.filter(ix=>m.accountKeys[ix.programIdIndex].equals(ComputeBudgetProgram.programId)).map(ix=>ix.data).join(',');
  const programs=(m:typeof a)=>m.instructions.filter(ix=>!m.accountKeys[ix.programIdIndex].equals(ComputeBudgetProgram.programId)).map(ix=>m.accountKeys[ix.programIdIndex].toBase58()).join(',');
  const found=[
    a.recentBlockhash!==b.recentBlockhash?'blockhash':'',
    !a.accountKeys[0].equals(b.accountKeys[0])?'fee payer':'',
    budget(a)!==budget(b)?'compute budget / priority fee':'',
    programs(a)!==programs(b)?'instructions added or removed':'',
  ].filter(Boolean);
  return found.join(', ')||'accounts or instruction data';
}
// outcome distinguishes an on-chain failure from an expired (never landed) transaction; phase values are unchanged for existing readers.
type RecordState={phase:'awaiting-signature'|'signed'|'confirmed'|'failed';signature?:string;lastValidBlockHeight:number;outcome?:'failed'|'expired'};
/** Public transaction journal only. Never stores keys or retries ambiguous broadcasts. */
export async function executeWalletOperation(c:Connection,tx:Transaction,wallet:PublicKey,sign:(tx:Transaction)=>Promise<Transaction>,storage:Store,lastValidBlockHeight:number,confirmation?:Parameters<typeof awaitSignature>[3],journal='fee-operation') {
  assertMainnetTransactionsEnabled();
  if(await c.getGenesisHash()!==expectedGenesis()) throw Error('Wallet RPC is not the active network');
  if(!tx.feePayer?.equals(wallet) || !tx.recentBlockhash) throw Error('Transaction wallet or blockhash mismatch');
  // Separate journals keep swaps out of the fee-claim recovery view; each still allows one unresolved operation.
  const key=`hymet:${journal}:v1:${wallet.toBase58()}`;
  const previous=JSON.parse(storage.getItem(key)||'null') as RecordState|null;
  if(previous && (!Number.isSafeInteger(previous.lastValidBlockHeight) || previous.lastValidBlockHeight<0 || !['awaiting-signature','signed','confirmed','failed'].includes(previous.phase))) throw Error('Saved wallet operation is invalid; inspect the public record before continuing');
  if(previous && !['confirmed','failed'].includes(previous.phase)) {
    const status=previous.signature?(await c.getSignatureStatuses([previous.signature],{searchTransactionHistory:true})).value[0]:null;
    if(status && ['confirmed','finalized'].includes(status.confirmationStatus||'')) storage.setItem(key,JSON.stringify({...previous,phase:status.err?'failed':'confirmed'}));
    else if(await c.getBlockHeight('finalized')<=previous.lastValidBlockHeight) throw Error(`Previous wallet operation is unresolved${previous.signature?` · ${previous.signature}`:''}. Wait for confirmation or finalized blockhash expiry.`);
  }
  await simulateReviewedTransaction(c,tx,false);
  const message=Buffer.from(tx.serializeMessage());
  const temporary=tx.signatures.filter(s=>!s.publicKey.equals(wallet)).map(s=>({publicKey:s.publicKey,signature:s.signature&&Buffer.from(s.signature)}));
  const record:RecordState={phase:'awaiting-signature',lastValidBlockHeight};
  storage.setItem(key,JSON.stringify(record));
  let signed:Transaction;
  try { signed=await sign(tx); }
  catch(error) {
    if((error as {code?:number}).code===4001) storage.setItem(key,JSON.stringify({...record,phase:'failed'}));
    throw error;
  }
  if(!message.equals(signed.serializeMessage())) {
    // Never sent from here, but Phantom's altered copy may carry a valid signature: journal it so a retry first checks
    // its on-chain status and waits for blockhash expiry instead of risking a second, overlapping operation.
    const altered=signed.signature?bs58.encode(signed.signature):undefined;
    storage.setItem(key,JSON.stringify(altered?{...record,phase:'signed',signature:altered}:{...record,phase:'failed'}));
    throw Error(`Phantom changed the reviewed transaction message (${messageChanges(message,signed)}); nothing was sent${altered?` · its signature ${altered} is checked on-chain before any retry`:''}`);
  }
  for(const signer of temporary) {
    const current=signed.signatures.find(s=>s.publicKey.equals(signer.publicKey));
    if(signer.signature && !current?.signature) signed.addSignature(signer.publicKey,signer.signature);
  }
  if(!signed.signature || !signed.verifySignatures()) throw Error('Phantom or temporary mint signature is missing or invalid');
  const signature=bs58.encode(signed.signature);
  storage.setItem(key,JSON.stringify({...record,phase:'signed',signature}));
  await simulateReviewedTransaction(c,signed,true);
  const sent=await c.sendRawTransaction(signed.serialize(),{skipPreflight:false,preflightCommitment:'confirmed',maxRetries:0});
  if(sent!==signature) throw Error(`RPC returned a different signature; inspect saved transaction ${signature}`);
  // HTTP polling only: the app RPC proxy has no WebSocket endpoint.
  const result=await awaitSignature(c,signature,lastValidBlockHeight,confirmation);
  if(result.state==='failed') {storage.setItem(key,JSON.stringify({...record,phase:'failed',outcome:'failed',signature}));throw Error(`Transaction failed on-chain · ${signature}`);}
  if(result.state==='expired') {storage.setItem(key,JSON.stringify({...record,phase:'failed',outcome:'expired',signature}));throw Error(`Transaction expired without landing; nothing was executed · ${signature}`);}
  if(result.state==='unresolved') throw Error(`Confirmation unresolved; do not retry until it confirms or its blockhash expires · ${signature}`);
  storage.setItem(key,JSON.stringify({...record,phase:'confirmed',signature}));
  return signature;
}
