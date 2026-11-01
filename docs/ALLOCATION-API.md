# Creator/holder allocation: frontend integration contract

HYMET's 20% platform share is fixed. The creator chooses how the remaining **80%** is split between the creator and token holders, in **1% steps** from 0 to 100. The split is bound on-chain at launch and cannot be changed afterwards.

## Input

| Field | Type | Values | Meaning |
|---|---|---|---|
| `values.creatorShare` | string | `"0"` … `"100"` (canonical integer: no leading zeros, decimals, signs or spaces) | Creator percent of the 80%. Holders get `100 - creatorShare`. Default `"100"`. |

- Slider: `min` / `max` / `step` / `default` come from `GET /api/launch/allocation` (below). Display holders as `100 - creatorShare`.
- `"07"`, `"7.0"`, `" 7"`, `"101"` and numbers (not strings) are rejected with: *Creator allocation must be a whole percentage from 0 to 100 of the 80% creator share*.
- Never rewrite the user's choice. If holder splits are unavailable, keep the user's value and show the server error; the backend never coerces a split to 100% creator.

## `GET /api/launch/allocation` (read-only, no auth)

```json
{
  "field": "values.creatorShare",
  "min": 100, "max": 100, "step": 1, "default": 100,
  "platformBps": 2000,
  "launchMode": "native-split",
  "holderAllocationsEnabled": false
}
```

- `holderAllocationsEnabled` is `true` only when the distributor and the payout keeper are owner-verified (`HYMET_LAUNCH_MODE=distributor`, `HYMET_DISTRIBUTOR_VERIFIED`, `HYMET_DISTRIBUTOR_APP_VERIFIED`, `HYMET_HOLDER_PAYOUTS_VERIFIED`). Then `min` is `0`; otherwise `min` is `100` and the slider stays at 100% creator.
- Use this endpoint (server env) to enable the slider. The existing build flag `NEXT_PUBLIC_HYMET_HOLDER_REWARDS` must agree; `check-production` blocks if the flag is on while payouts are unverified.

## `Allocation` object (returned everywhere below)

```json
{
  "creatorPercent": 73, "holderPercent": 27,
  "creatorBpsOfRemaining": 7300, "holderBpsOfRemaining": 2700,
  "effectiveBps": { "hymet": 2000, "creator": 5840, "holders": 2160 }
}
```

- `*BpsOfRemaining` are of the 80% and always sum to 10,000. `creatorBpsOfRemaining` is the on-chain `creator_bps_of_remaining`.
- `effectiveBps` are of all distributable fees and always sum to 10,000 (1% of the 80% = 80 bps). Display "% of fees" as `effectiveBps.x / 100` (73/27 → 58.4% / 21.6% / 20%).

| Where | Field |
|---|---|
| Launch preview: `buildPlan(...)` result (`Plan`) | `plan.allocation` |
| Mainnet confirmation screen | `plan.allocation` (use it instead of recomputing from `plan.values.creatorShare`) |
| `POST /api/launch/confirm` response (201, and idempotent 200) | `allocation`, read back from what was persisted |
| `GET /api/tokens` (each token) | `allocation` |
| `GET /api/creator-launches?wallet=` (each launch) | `allocation` |

Existing launches (HYTEST, DOGE, HYPAD and every native-split token) report their original 100/0.

## Enforcement (backend; nothing for the frontend to add)

- `buildPlan` and `/api/launch/confirm` refuse any holder share unless the verified distributor route is used: *This creator/holder split requires the HYMET on-chain reward distributor…*.
- Distributor launches create the fee pool in the same transaction as the DBC pool with `creator_bps_of_remaining = creatorShare × 100`. The program has no instruction to change it; confirm re-reads it on-chain before persisting.
- Every DBC and DAMM v2 fee settlement splits on-chain: 20% HYMET first, creator rounded down, holders take the remainder (no overdistribution). The indexer rejects any settlement event that differs from the stored split.

## Verification (2026-11-01)

- Unit tests (`tests/flexible-allocation.test.ts` and others): 100/0, 73/27, 50/50, 1/99 and 0/100. They cover input validation, exact bps, splits of 0 to 2^64−1 base units with no overdistribution, indexer agreement for DBC and DAMM v2 sources, fee-pool instruction encoding, round-tripping persisted records (including legacy 100/0), the policy gate, the keeper paying at 73/27 and 1/99, and no fallback to 100% creator.
- Real-validator lifecycle with Mainnet-dumped DBC/DAMM v2, authentic graduation, and the **unmodified reviewed binary** `f0ec833a…7105`. Run on the VPS in `/srv/hymet-build/alloc-20261101` with `HYMET_LIFECYCLE_CREATOR_BPS`:
  - **7300:** 52 PASS. A DBC settlement of 8,000,000 split into 1,600,000 HYMET, 4,672,000 creator and 1,728,000 holders. DAMM v2 settlement, creator claim and holder push payout also passed.
  - **100:** 52 PASS. The same settlement split into 1,600,000 HYMET, 64,000 creator and 6,336,000 holders. DAMM v2 settlement, creator claim and holder push payout also passed.
- The distributor program is unchanged: same SHA-256, size, rent and deployment readiness.
