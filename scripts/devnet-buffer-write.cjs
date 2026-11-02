/* eslint-disable @typescript-eslint/no-require-imports -- standalone Devnet tooling */
// Devnet only: finishes writing an existing upgradeable-loader buffer (left by a rate-limited `solana program deploy`)
// with the Devnet build, paced under the public RPC limits. The buffer authority (the Devnet test deployer) signs each
// Write; the buffer's own keypair is not needed. Only chunks that differ from the .so are written, so re-runs never
// duplicate work. Verifies the full buffer against the file at the end. Never touches a program account.
//   HYMET_DEVNET_DIR=/srv/hymet-build/devnet-e2e node scripts/devnet-buffer-write.cjs <buffer-address>
const fs = require('node:fs');
const crypto = require('node:crypto');
const { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } = require('@solana/web3.js');
const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const HEADER = 37; // UpgradeableLoaderState::Buffer: u32 tag + Option<Pubkey> authority
const CHUNK = 1000; // fits one Write in a single-signer legacy transaction (1232-byte packet)
const SENDS_PER_SECOND = 2; // public Devnet: 40 requests / 10 s per method per IP
const dir = process.env.HYMET_DEVNET_DIR || '/srv/hymet-build/devnet-e2e';
if (!/^\/srv\/hymet-build\/[\w.\/-]+$/.test(dir) || dir.includes('..')) throw Error('HYMET_DEVNET_DIR must be inside /srv/hymet-build');
const rpcUrl = process.env.DEVNET_RPC_URL || 'https://api.devnet.solana.com';
const c = new Connection(rpcUrl, { commitment: 'confirmed', disableRetryOnRateLimit: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(f) {
  for (let i = 0; ; i++) {
    try { return await f(); } catch (e) {
      if (!/429|Too Many|fetch failed|ECONNRESET|timed out/i.test(e.message) || i > 20) throw e;
      await sleep(Math.min(60_000, 2_000 * 2 ** Math.min(i, 5)));
    }
  }
}

(async () => {
  const buffer = new PublicKey(process.argv[2]);
  if ((await call(() => c.getGenesisHash())) !== DEVNET_GENESIS) throw Error('RPC is not Devnet');
  const deployer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${dir}/keys/deployer.json`, 'utf8'))));
  const so = fs.readFileSync(`${dir}/build/target/deploy/hymet_rewards_distributor.so`);
  console.log(JSON.stringify({ buffer: buffer.toBase58(), authority: deployer.publicKey.toBase58(), program: { bytes: so.length, sha256: crypto.createHash('sha256').update(so).digest('hex') } }));
  const read = async () => {
    const a = await call(() => c.getAccountInfo(buffer, 'confirmed'));
    if (!a?.owner.equals(LOADER) || a.data.readUInt32LE(0) !== 1) throw Error('Not an upgradeable-loader buffer');
    if (a.data[4] !== 1 || !a.data.subarray(5, 37).equals(deployer.publicKey.toBuffer())) throw Error('Buffer authority is not the Devnet deployer');
    if (a.data.length !== HEADER + so.length) throw Error(`Buffer holds ${a.data.length - HEADER} bytes; build is ${so.length}`);
    return a.data.subarray(HEADER);
  };
  const missing = (data) => { const out = []; for (let o = 0; o < so.length; o += CHUNK) if (!data.subarray(o, o + CHUNK).equals(so.subarray(o, o + CHUNK))) out.push(o); return out; };
  const write = (offset) => {
    const bytes = so.subarray(offset, offset + CHUNK);
    const data = Buffer.alloc(16 + bytes.length);
    data.writeUInt32LE(1, 0); data.writeUInt32LE(offset, 4); data.writeBigUInt64LE(BigInt(bytes.length), 8); bytes.copy(data, 16);
    return new TransactionInstruction({ programId: LOADER, keys: [{ pubkey: buffer, isSigner: false, isWritable: true }, { pubkey: deployer.publicKey, isSigner: true, isWritable: false }], data });
  };
  for (let pass = 1; pass <= 8; pass++) {
    const todo = missing(await read());
    console.log(JSON.stringify({ pass, chunksToWrite: todo.length, ofTotal: Math.ceil(so.length / CHUNK) }));
    if (!todo.length) break;
    let block = await call(() => c.getLatestBlockhash('confirmed')), blockAt = Date.now(), sent = 0;
    for (const offset of todo) {
      if (Date.now() - blockAt > 30_000) { block = await call(() => c.getLatestBlockhash('confirmed')); blockAt = Date.now(); }
      const tx = new Transaction({ feePayer: deployer.publicKey, blockhash: block.blockhash, lastValidBlockHeight: block.lastValidBlockHeight }).add(write(offset));
      tx.sign(deployer);
      await call(() => c.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 }));
      if (++sent % 50 === 0) console.log(JSON.stringify({ pass, sent }));
      await sleep(1000 / SENDS_PER_SECOND);
    }
    await sleep(20_000); // let the last writes land before re-reading the buffer
  }
  const left = missing(await read());
  if (left.length) throw Error(`${left.length} chunks still differ after 8 passes`);
  console.log(JSON.stringify({ result: 'PASS', buffer: buffer.toBase58(), matchesBuild: true, deployerLamports: await call(() => c.getBalance(deployer.publicKey)) }));
  if (process.argv.includes('--deploy')) await deploy(buffer, deployer, so);
})().catch((e) => { console.error(`FAIL: ${e.message}`); process.exitCode = 1; });

// The two instructions `solana program deploy` sends after writing: create the program account (program keypair signs),
// then DeployWithMaxDataLen from the verified buffer. The buffer's lamports pay the program data; the deployer is the
// payer and becomes the upgrade authority (the Devnet test deployer, as devnet-e2e.cjs --pre-init expects).
async function deploy(buffer, deployer, so) {
  const { SystemProgram, ComputeBudgetProgram, SYSVAR_RENT_PUBKEY, SYSVAR_CLOCK_PUBKEY } = require('@solana/web3.js');
  const program = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${dir}/keys/program.json`, 'utf8'))));
  if (await call(() => c.getAccountInfo(program.publicKey, 'confirmed'))) throw Error(`Program ${program.publicKey.toBase58()} already exists; not redeploying`);
  const programData = PublicKey.findProgramAddressSync([program.publicKey.toBuffer()], LOADER)[0];
  const data = Buffer.alloc(12); data.writeUInt32LE(2, 0); data.writeBigUInt64LE(BigInt(so.length), 4);
  const deployIx = new TransactionInstruction({ programId: LOADER, data, keys: [
    { pubkey: deployer.publicKey, isSigner: true, isWritable: true },
    { pubkey: programData, isSigner: false, isWritable: true },
    { pubkey: program.publicKey, isSigner: false, isWritable: true },
    { pubkey: buffer, isSigner: false, isWritable: true },
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: deployer.publicKey, isSigner: true, isWritable: false },
  ] });
  const block = await call(() => c.getLatestBlockhash('confirmed'));
  const tx = new Transaction({ feePayer: deployer.publicKey, blockhash: block.blockhash, lastValidBlockHeight: block.lastValidBlockHeight }).add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    SystemProgram.createAccount({ fromPubkey: deployer.publicKey, newAccountPubkey: program.publicKey, lamports: await call(() => c.getMinimumBalanceForRentExemption(36)), space: 36, programId: LOADER }),
    deployIx,
  );
  tx.sign(deployer, program);
  const sim = await call(() => c.simulateTransaction(tx));
  if (sim.value.err) throw Error(`deploy simulation failed: ${JSON.stringify(sim.value.err)} ${(sim.value.logs || []).slice(-3).join(' | ')}`);
  const signature = await call(() => c.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 5 }));
  for (let i = 0; i < 90; i++) {
    const s = (await call(() => c.getSignatureStatuses([signature], { searchTransactionHistory: true }))).value[0];
    if (s?.err) throw Error(`deploy failed: ${JSON.stringify(s.err)} ${signature}`);
    if (s && ['confirmed', 'finalized'].includes(s.confirmationStatus)) break;
    await sleep(2_000);
  }
  const pd = await call(() => c.getAccountInfo(programData, 'confirmed'));
  // ProgramData: u32 tag 3, u64 slot, Option<Pubkey> authority, then the program bytes.
  if (!pd || pd.data.readUInt32LE(0) !== 3 || pd.data[12] !== 1 || !pd.data.subarray(13, 45).equals(deployer.publicKey.toBuffer())) throw Error('Program data or upgrade authority missing after deploy');
  if (!pd.data.subarray(45, 45 + so.length).equals(so)) throw Error('Deployed bytes differ from the Devnet build');
  console.log(JSON.stringify({ result: 'PASS deploy', signature, program: program.publicKey.toBase58(), programData: programData.toBase58(), upgradeAuthority: deployer.publicKey.toBase58(), bytesMatchBuild: true, deployerLamports: await call(() => c.getBalance(deployer.publicKey)) }));
}
