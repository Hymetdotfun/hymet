/* eslint-disable @typescript-eslint/no-require-imports -- standalone Devnet tooling */
// Devnet only: runs the unmodified holder payout keeper (scripts/holder-rewards-keeper.ts: automatic DAMM v2 migration,
// settlement, snapshots, push payouts) against the isolated Devnet distributor build. The only change is the one
// devnet-e2e.cjs applies to the app libraries: lib/quote-assets.ts gets the Devnet HYPE test mint at load time.
// Genesis-checked before the keeper loads; refuses Mainnet and, outside a loopback rehearsal, anything but Devnet.
//   HYMET_DEVNET_DIR=... HYMET_KEEPER_RPC_URL=... DATABASE_URL=... node scripts/devnet-keeper.cjs --send --min-payout=1
const fs = require('node:fs');
const ts = require('typescript');
const { Connection, Keypair } = require('@solana/web3.js');
const MAINNET_HYPE = '98sMhvDwXj1RQi5c5Mndm3vPe9cBqPrbLaufMXFNMh5g';
const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const dir = process.env.HYMET_DEVNET_DIR || '/srv/hymet-build/devnet-e2e';
if (!/^\/srv\/hymet-build\/[\w.\/-]+$/.test(dir) || dir.includes('..')) throw Error('HYMET_DEVNET_DIR must be inside /srv/hymet-build');
const rpc = process.env.HYMET_KEEPER_RPC_URL || '';
const rehearsal = process.env.HYMET_DEVNET_REHEARSAL === '1';
if (rehearsal ? !/^http:\/\/127\.0\.0\.1:\d+$/.test(rpc) : !/^https:\/\//.test(rpc)) throw Error('HYMET_KEEPER_RPC_URL must be Devnet (or loopback for a rehearsal)');
if (process.env.ENABLE_MAINNET === 'true' || process.env.NEXT_PUBLIC_ENABLE_MAINNET === 'true') throw Error('Mainnet switches must stay off');
const hype = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${dir}/keys/hype-mint.json`, 'utf8')))).publicKey.toBase58();
require.extensions['.ts'] = (module, filename) => {
  let source = fs.readFileSync(filename, 'utf8');
  if (filename.endsWith('quote-assets.ts')) {
    if (!source.includes(MAINNET_HYPE)) throw Error('quote-assets.ts no longer contains the HYPE mint');
    source = source.split(MAINNET_HYPE).join(hype);
  }
  module._compile(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true, target: ts.ScriptTarget.ES2022 } }).outputText, filename);
};

(async () => {
  const genesis = await new Connection(rpc, 'confirmed').getGenesisHash();
  if (genesis === MAINNET_GENESIS || (!rehearsal && genesis !== DEVNET_GENESIS)) throw Error('Keeper RPC is not Devnet');
  if (!require('../lib/quote-assets.ts').HYPE_MINT.equals(new (require('@solana/web3.js').PublicKey)(hype))) throw Error('Devnet HYPE substitution failed');
  require('./holder-rewards-keeper.ts');
})().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
