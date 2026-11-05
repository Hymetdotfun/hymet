# Local test network (Phantom testing)

A guarded development mode that runs the HYMET app against a loopback `solana-test-validator` started from the Mainnet fixtures (`scripts/validator-fixture-start.cjs`). The validator carries the same HYPE mint, Meteora DBC/DAMM v2/Metaplex programs and reviewed distributor program, so it behaves like a Mainnet fork. No Mainnet transaction is possible while the mode is active. Mainnet stays the default: without `NEXT_PUBLIC_HYMET_TEST_NETWORK`, nothing changes.

## Configuration (local `.env.local` of an isolated checkout only)

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_HYMET_TEST_NETWORK`, `HYMET_TEST_NETWORK` | `localnet` (both required) |
| `NEXT_PUBLIC_HYMET_TEST_GENESIS` | `solana genesis-hash` of the local validator (rebuild after every ledger reset) |
| `HYMET_TEST_RPC_URL` | loopback validator, e.g. `http://127.0.0.1:19995` |
| `HYMET_TEST_PUBLIC_ORIGIN` | the app origin, e.g. `http://localhost:3917` (local metadata URLs) |
| `NEXT_PUBLIC_ENABLE_MAINNET`, `ENABLE_MAINNET` | `false` (required) |
| `DATABASE_URL` | a dedicated, throwaway test database |
| `HYMET_PLATFORM_FEE_RECIPIENT` | a local test wallet, never a production address |

## Guards (`lib/app-network.ts`, tested in `tests/test-network.test.ts`)

- Every server RPC goes to `HYMET_TEST_RPC_URL` (loopback only). Every genesis check expects the local genesis, never Mainnet.
- Any misconfiguration disables all transactions; the app never falls back to Mainnet. That includes:
  - a Mainnet switch left on;
  - Mainnet genesis;
  - a non-loopback RPC;
  - running on Vercel (`VERCEL` / `VERCEL_ENV`);
  - a server/browser flag mismatch;
  - a page not served on localhost.
- A yellow banner on every page names the network; a red banner shows a misconfiguration. Review screens say "Local test network (localnet)".
- Launch metadata is stored on local disk (`/api/test-network/files`), never pinned to public IPFS.
- `/api/test-network/fund` (test mode only) sends the connected wallet 2 SOL from the validator faucet and 500 HYPE from the local genesis-funded account.
- xStocks stays Mainnet-only and disabled.

## Creator/holder splits on localnet

The `work/` scripts and `testnet-setup.sh` named below live on the private build host and are not part of this repository.

- `scripts/test-network-distributor.ts` (loopback RPC only, refuses the Mainnet genesis) initializes the deployed distributor with local seed keys:
  - upgrade authority: the validator trader;
  - platform: `HYMET LOCAL VALIDATOR ONLY PLATFORM`;
  - snapshot authority: `HYMET LOCAL VALIDATOR ONLY KEEPER`.

  It also writes the local keeper key file. `work/testnet-distributor-setup.sh` runs it and appends the distributor flags to the isolated app's `.env.local`.
- `/api/launch/allocation` on the test network offers 0–100% only while the validator shows the distributor initialized with the configured recipient and authorities (`servedAllocationPolicy`). The Mainnet policy stays flag-only and unchanged.
- The swap panel accepts distributor launches only in builds with `NEXT_PUBLIC_HYMET_HOLDER_REWARDS=true` (`distributorConfigError`). The fee pool must be the DBC fee claimer, the DBC creator share must be 0, and all migrated LP must be locked to the distributor.
- Test keeper: transient systemd timer `hymet-keeper-testnet` (every 60 s, `--min-payout=1`). It runs `work/testnet-keeper-tick.sh` and logs to `work/testnet-keeper.log`.
- A ledger reset is one command: `testnet-setup.sh`. It:
  - starts a fresh validator with a 1,000,000 HYPE local-only faucet (`VALIDATOR_HYPE_FAUCET`);
  - empties the test DB;
  - re-initializes the distributor;
  - builds and starts the app.

  Restart the keeper timer afterwards.
- End-to-end accounting check: `node work/e2e-verify.cjs`. It is read-only and compares the chain (fee pools, vaults, per-transaction HYPE deltas) with the test DB. The 2026-11-01 run of 73/27, 50/50 and 0/100 passed 34/34, on a build that predates the Mainnet deployment.

## Graduation (DBC → DAMM v2)

- `lib/graduation.ts` records a graduation only after the chain confirms it:
  - **Check:** the DBC pool must report migrated, and its derived DAMM v2 destination must pass owner, PDA, layout and mint-pair checks.
  - **Writes, in one transaction:** a `meteora_damm_v2` pool row, the DBC pool set to `migrated`, the token set to `graduated`, and a `migration_events` row when the migration transaction is still retrievable.
  - **Triggers:** the token page, `/api/market/[mint]`, and `/api/tokens` (Explore) for pools that the batched read shows as migrated.
- The trade panel uses `lib/damm-swap.ts` after graduation. Each quote and review re-verifies:
  - that the DAMM pool is the launch's verified migration destination;
  - that its flat fee equals the launch's `migratedPoolFeeBps` and is collected in HYPE, with no dynamic or compounding fee.

  Tokens still on their curve keep DBC trading.
- The local validator keeps only about a minute of transaction history (default ledger size). Older signatures, such as a migration transaction, cannot be fetched later; the verified pool state is still recorded.

## Remote test host

The validator and app can run on a separate build host instead of the workstation. Bind both to loopback there
(validator RPC e.g. `127.0.0.1:19995`, app `127.0.0.1:3917`) and reach them through SSH port forwarding:

```bash
ssh -N -L 3917:127.0.0.1:3917 -L 8899:127.0.0.1:19995 -L 8900:127.0.0.1:19996 <user>@<build-host>
```

Phantom: Settings → Developer Settings → Testnet Mode on → network **Solana Localnet** (`localhost:8899`). Use a separate test account.
