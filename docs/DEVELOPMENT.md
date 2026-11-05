# Development

## Requirements

- Node.js 20 or newer (production runs Node 24)
- PostgreSQL 16
- For the program: Rust and Solana CLI (Agave) 2.2.1; Anchor 0.31.1 is pinned in `Anchor.toml`

## Install and run

```bash
npm ci                        # install scripts stay off (.npmrc: ignore-scripts=true)
# create .env.local (see Configuration below)
npm run db:migrate            # applies migrations/ in order, each in a transaction
npm run dev                   # http://127.0.0.1:4173
```

`npm ci` must keep `ignore-scripts=true`: `bigint-buffer` is replaced by the bounds-checked pure-JS copy in
`vendor/bigint-buffer` (GHSA-3gc7-fjrx-p6mg), and `npm run security:runtime` fails if anything else resolves.

## Configuration

Put the app's variables in `.env.local`; the keeper's are described in [KEEPER.md](KEEPER.md). The important ones:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection |
| `MAINNET_RPC_URL` | Server-side Mainnet RPC |
| `NEXT_PUBLIC_ENABLE_MAINNET`, `ENABLE_MAINNET` | Both `true` to allow Mainnet transactions; they must match |
| `HYMET_PLATFORM_FEE_RECIPIENT`, `NEXT_PUBLIC_HYMET_PLATFORM_FEE_RECIPIENT` | HYMET fee wallet; must equal `config/production.json` |
| `HYMET_LAUNCH_MODE` | `native-split` (default) or `distributor` |
| `HYMET_DISTRIBUTOR_PROGRAM_ID`, `HYMET_SNAPSHOT_AUTHORITY`, `HYMET_UPGRADE_AUTHORITY`, `HYMET_DEPLOYER` | Distributor identities, checked against chain state at runtime |
| `HYMET_DISTRIBUTOR_VERIFIED`, `HYMET_DISTRIBUTOR_APP_VERIFIED`, `HYMET_HOLDER_PAYOUTS_VERIFIED` | Owner sign-off gates for the distributor path |
| `PINATA_JWT`, `IPFS_GATEWAY` | Metadata uploads |
| `HYMET_PUBLIC_ORIGIN` | Exact public origin when served behind a reverse proxy (for example `https://hymet.fun`); unset means loopback only |
| `HYMET_PUBLIC_TOKEN_EXCLUDED_MINTS` | Comma-separated mints left out of the public token directory (server-only). This is the only exclusion list; the repository holds none |

Never put a private key in an environment variable. The keeper reads its key from a file (`HYMET_KEEPER_KEYPAIR`).

## Checks

```bash
npm test             # Vitest: transactions, fee math, keeper, indexer, guards, owner console
npm run typecheck
npm run lint
npm run build
cargo test --manifest-path programs/hymet-rewards-distributor/Cargo.toml
```

## Scripts

| Script | Purpose |
|---|---|
| `npm run db:migrate` | Apply database migrations |
| `npm run index:distributor` | Index confirmed distributor events |
| `npm run rewards:keeper` | Keeper ([KEEPER.md](KEEPER.md)); dry run unless `--send` |
| `node scripts/graduation-watcher.mjs -- <keeper command>` | Instant-graduation watcher |
| `node scripts/keeper-alerts.mjs` | Keeper health check |
| `node scripts/check-production.mjs --online` | Read-only production readiness review |
| `npm run distributor:handover`, `distributor:initialize` | One-time deployment steps; refuse anything but the pinned configuration |
| `scripts/validator-*.cjs` | Lifecycle tests against a local validator loaded with Mainnet-dumped Meteora programs |
| `scripts/devnet-*` | Devnet end-to-end tooling (expects its own build-host layout) |

## Local Mainnet fork

[LOCAL-TEST-NETWORK.md](LOCAL-TEST-NETWORK.md) describes running the app and Phantom against a loopback validator that
carries the HYPE mint, Meteora programs and the distributor, with every Mainnet path disabled.
