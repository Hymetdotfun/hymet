/* eslint-disable @typescript-eslint/no-require-imports -- standalone Devnet tooling */
// Devnet only: upgrades the isolated Devnet distributor build in place (same program id, existing accounts kept),
// paced under the public RPC limits. Steps, each skipped when already done so re-runs never repeat work:
//   1. ExtendProgram when the new build is larger than the program data account;
//   2. create + initialize a buffer (its keypair is saved under keys/ so a re-run resumes the same buffer);
//   3. write only the chunks that differ, then verify the whole buffer against the .so;
//   4. simulate, then Upgrade (the buffer's lamports go back to the deployer), and verify the deployed bytes.
// The deployer must be the upgrade authority. Refuses anything but Devnet.
//   HYMET_DEVNET_DIR=/srv/hymet-build/devnet-e2e node scripts/devnet-program-upgrade.cjs <path/to/program.so> [--send]
const fs = require('node:fs');
const crypto = require('node:crypto');
const { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, SYSVAR_RENT_PUBKEY, SYSVAR_CLOCK_PUBKEY } = require('@solana/web3.js');
const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const PROGRAM = new PublicKey('H8PvVTwq6C9ZUtppfrFnp93rZasbbYbKfHMEeFSMy8ws');
const LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const BUFFER_HEADER = 37, PROGRAMDATA_HEADER = 45, CHUNK = 1000, SENDS_PER_SECOND = 2;
const dir = process.env.HYMET_DEVNET_DIR || '/srv/hymet-build/devnet-e2e';
if (!/^\/srv\/hymet-build\/[\w.\/-]+$/.test(dir) || dir.includes('..')) throw Error('HYMET_DEVNET_DIR must be inside /srv/hymet-build');
const send = process.argv.includes('--send');
const c = new Connection('https://api.devnet.solana.com', { commitment: 'confirmed', disableRetryOnRateLimit: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(f) {
  for (let i = 0; ; i++) {
    try { return await f(); } catch (e) {
      if (!/429|Too Many|fetch failed|ECONNRESET|timed out/i.test(e.message) || i > 20) throw e;
      await sleep(Math.min(60_000, 2_000 * 2 ** Math.min(i, 5)));
    }
  }
}
const loaderIx = (data, keys) => new TransactionInstruction({ programId: LOADER, data, keys });
const meta = (pubkey, isSigner, isWritable) => ({ pubkey, isSigner, isWritable });

(async () => {
  const soPath = process.argv[2];
  if (!soPath || !soPath.endsWith('.so')) throw Error('Usage: devnet-program-upgrade.cjs <program.so> [--send]');
  if ((await call(() => c.getGenesisHash())) !== DEVNET_GENESIS) throw Error('RPC is not Devnet');
  const so = fs.readFileSync(soPath);
  const deployer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${dir}/keys/deployer.json`, 'utf8'))));
  const programData = PublicKey.findProgramAddressSync([PROGRAM.toBuffer()], LOADER)[0];
  const readProgramData = async () => {
    const a = await call(() => c.getAccountInfo(programData, 'confirmed'));
    if (!a || a.data.readUInt32LE(0) !== 3 || a.data[12] !== 1 || !a.data.subarray(13, 45).equals(deployer.publicKey.toBuffer())) throw Error('Deployer is not the program upgrade authority');
    return a;
  };
  const sendTx = async (label, ixs, signers = []) => {
    const block = await call(() => c.getLatestBlockhash('confirmed'));
    const tx = new Transaction({ feePayer: deployer.publicKey, blockhash: block.blockhash, lastValidBlockHeight: block.lastValidBlockHeight }).add(...ixs);
    tx.sign(deployer, ...signers);
    const sim = await call(() => c.simulateTransaction(tx));
    if (sim.value.err) throw Error(`${label} simulation failed: ${JSON.stringify(sim.value.err)} ${(sim.value.logs || []).slice(-3).join(' | ')}`);
    if (!send) { console.log(JSON.stringify({ step: label, simulated: true, sent: false })); return null; }
    const signature = await call(() => c.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 5 }));
    for (let i = 0; i < 90; i++) {
      const s = (await call(() => c.getSignatureStatuses([signature], { searchTransactionHistory: true }))).value[0];
      if (s?.err) throw Error(`${label} failed: ${JSON.stringify(s.err)} ${signature}`);
      if (s && ['confirmed', 'finalized'].includes(s.confirmationStatus)) { console.log(JSON.stringify({ step: label, signature })); return signature; }
      await sleep(2_000);
    }
    throw Error(`${label} unconfirmed; inspect ${signature} before re-running`);
  };

  const before = await readProgramData();
  const deployed = before.data.subarray(PROGRAMDATA_HEADER);
  console.log(JSON.stringify({ program: PROGRAM.toBase58(), authority: deployer.publicKey.toBase58(), newBuild: { bytes: so.length, sha256: crypto.createHash('sha256').update(so).digest('hex') }, programDataCapacity: deployed.length, deployerLamports: await call(() => c.getBalance(deployer.publicKey)), send }));
  if (deployed.subarray(0, so.length).equals(so) && !deployed.subarray(so.length).some((b) => b)) { console.log(JSON.stringify({ result: 'ALREADY UPGRADED' })); return; }

  // 1. ExtendProgram (tag 6, u32 additional bytes): programdata, program, system program, payer.
  if (deployed.length < so.length) {
    const data = Buffer.alloc(8); data.writeUInt32LE(6, 0); data.writeUInt32LE(Math.max(so.length - deployed.length, 10_240), 4); // the loader's minimum extension
    await sendTx('extend program', [loaderIx(data, [meta(programData, false, true), meta(PROGRAM, false, true), meta(SystemProgram.programId, false, false), meta(deployer.publicKey, true, true)])]);
    if (!send) { console.log(JSON.stringify({ result: 'DRY RUN stops here: later steps depend on the extension' })); return; }
  }

  // 2. Buffer: create + InitializeBuffer (tag 0) with the deployer as buffer authority. Saved keypair = resumable.
  const bufferPath = `${dir}/keys/upgrade-buffer.json`;
  if (!fs.existsSync(bufferPath)) fs.writeFileSync(bufferPath, JSON.stringify(Array.from(Keypair.generate().secretKey)), { mode: 0o600 });
  const buffer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(bufferPath, 'utf8'))));
  let account = await call(() => c.getAccountInfo(buffer.publicKey, 'confirmed'));
  if (!account) {
    const lamports = await call(() => c.getMinimumBalanceForRentExemption(BUFFER_HEADER + so.length));
    const init = Buffer.alloc(4); init.writeUInt32LE(0, 0);
    await sendTx('create buffer', [
      SystemProgram.createAccount({ fromPubkey: deployer.publicKey, newAccountPubkey: buffer.publicKey, lamports, space: BUFFER_HEADER + so.length, programId: LOADER }),
      loaderIx(init, [meta(buffer.publicKey, false, true), meta(deployer.publicKey, false, false)]),
    ], [buffer]);
    if (!send) return;
    account = await call(() => c.getAccountInfo(buffer.publicKey, 'confirmed'));
  }
  const readBuffer = async () => {
    const a = await call(() => c.getAccountInfo(buffer.publicKey, 'confirmed'));
    if (!a?.owner.equals(LOADER) || a.data.readUInt32LE(0) !== 1 || a.data[4] !== 1 || !a.data.subarray(5, 37).equals(deployer.publicKey.toBuffer())) throw Error('Upgrade buffer is not a deployer-owned loader buffer');
    if (a.data.length !== BUFFER_HEADER + so.length) throw Error('Upgrade buffer size differs from the build');
    return a.data.subarray(BUFFER_HEADER);
  };

  // 3. Write (tag 1, u32 offset, u64 length, bytes) only chunks that differ; verify the full buffer.
  const missing = (data) => { const out = []; for (let o = 0; o < so.length; o += CHUNK) if (!data.subarray(o, o + CHUNK).equals(so.subarray(o, o + CHUNK))) out.push(o); return out; };
  for (let pass = 1; pass <= 8; pass++) {
    const todo = missing(await readBuffer());
    console.log(JSON.stringify({ pass, chunksToWrite: todo.length, ofTotal: Math.ceil(so.length / CHUNK) }));
    if (!todo.length) break;
    let block = await call(() => c.getLatestBlockhash('confirmed')), blockAt = Date.now(), sent = 0;
    for (const offset of todo) {
      if (Date.now() - blockAt > 30_000) { block = await call(() => c.getLatestBlockhash('confirmed')); blockAt = Date.now(); }
      const bytes = so.subarray(offset, offset + CHUNK), data = Buffer.alloc(16 + bytes.length);
      data.writeUInt32LE(1, 0); data.writeUInt32LE(offset, 4); data.writeBigUInt64LE(BigInt(bytes.length), 8); bytes.copy(data, 16);
      const tx = new Transaction({ feePayer: deployer.publicKey, blockhash: block.blockhash, lastValidBlockHeight: block.lastValidBlockHeight }).add(loaderIx(data, [meta(buffer.publicKey, false, true), meta(deployer.publicKey, true, false)]));
      tx.sign(deployer);
      await call(() => c.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 }));
      if (++sent % 50 === 0) console.log(JSON.stringify({ pass, sent }));
      await sleep(1000 / SENDS_PER_SECOND);
    }
    await sleep(20_000);
  }
  if (missing(await readBuffer()).length) throw Error('Buffer still differs from the build after 8 passes');
  console.log(JSON.stringify({ buffer: buffer.publicKey.toBase58(), matchesBuild: true }));

  // 4. Upgrade (tag 3): programdata, program, buffer, spill (deployer gets the buffer lamports), rent, clock, authority.
  const upgrade = Buffer.alloc(4); upgrade.writeUInt32LE(3, 0);
  await sendTx('upgrade', [loaderIx(upgrade, [meta(programData, false, true), meta(PROGRAM, false, true), meta(buffer.publicKey, false, true), meta(deployer.publicKey, false, true), meta(SYSVAR_RENT_PUBKEY, false, false), meta(SYSVAR_CLOCK_PUBKEY, false, false), meta(deployer.publicKey, true, false)])]);
  const after = (await readProgramData()).data.subarray(PROGRAMDATA_HEADER);
  if (!after.subarray(0, so.length).equals(so) || after.subarray(so.length).some((b) => b)) throw Error('Deployed bytes differ from the new build');
  fs.unlinkSync(bufferPath); // the buffer account is closed by Upgrade
  console.log(JSON.stringify({ result: 'PASS upgrade', program: PROGRAM.toBase58(), bytesMatchBuild: true, upgradeAuthority: deployer.publicKey.toBase58(), deployerLamports: await call(() => c.getBalance(deployer.publicKey)) }));
})().catch((e) => { console.error(`FAIL: ${e.message}`); process.exitCode = 1; });
