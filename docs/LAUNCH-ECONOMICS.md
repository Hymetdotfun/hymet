# Launch economics

Every HYMET launch uses one curve, built by `lib/config.ts` with the Meteora DBC SDK (`buildCurveWithMarketCap`). The
figures below come from the SDK's own swap simulator applied to that config.

## Fixed parameters

| Parameter | Value |
|---|---|
| Supply | 1,000,000,000 tokens, 9 decimals |
| Quote asset | HYPE (`98sMhvDwXj1RQi5c5Mndm3vPe9cBqPrbLaufMXFNMh5g`) |
| Start market cap | 33.5 HYPE (price 3.35 × 10⁻⁸ HYPE per token) |
| Graduation market cap | 447 HYPE (price 4.47 × 10⁻⁷ HYPE per token) |
| Trading fee | 0.25%–3%, default 1%, flat (no dynamic fee), collected in HYPE |
| After graduation | DAMM v2 with the same flat fee, collected in HYPE; liquidity 100% permanently locked |
| Migration fee / pool creation fee | 0 / 0 |

The caps are fixed in HYPE: graduation happens when the curve holds the threshold amount of HYPE, whatever HYPE's USD
price is. Only the USD values move.

## Market cap is not money raised

Market cap prices the whole supply at the current price. Only 78.5% of the supply is sold along the curve, at rising
prices, so the HYPE actually deposited is much smaller than the graduation market cap.

| | Value |
|---|---|
| HYPE in the curve at graduation (`migrationQuoteThreshold`) | 96.0702 HYPE |
| Tokens sold on the curve | 785,077,701 (78.5%) |
| Tokens moved to DAMM v2 with the 96.07 HYPE | 214,922,299 |

## Cost to reach each stage (1% fee)

| Progress | HYPE in the curve | Buyers pay, fee included | Tokens bought (cumulative) |
|---|---|---|---|
| 25% | 24.0176 | 24.2602 | 431.1 M (43.1%) |
| 50% | 48.0351 | 48.5203 | 616.3 M (61.6%) |
| 75% | 72.0527 | 72.7805 | 719.4 M (71.9%) |
| 100% | 96.0702 | 97.0406 | 785.1 M (78.5%) |

Progress is the pool's HYPE reserve over the threshold, so it is linear in HYPE. At a 0.25% fee, buyers pay 96.311
HYPE for 0 → 100%; at 3%, 99.041 HYPE.

## Example first buys

| First buy | Tokens | Share of supply |
|---|---|---|
| 0.1 HYPE | 2.95 M | 0.29% |
| 1 HYPE | 28.8 M | 2.88% |
| 5 HYPE | 130.0 M | 13.0% |
| 10 HYPE | 232.1 M | 23.2% |

The first buy is optional and pays the normal fee.

## Creator costs

| Item | SOL |
|---|---|
| Rent: curve config, pool, mint, metadata, two vaults | ≈ 0.0187 |
| Creator's token account (only with a first buy) | ≈ 0.0015 |
| Distributor mode: fee pool and its two vaults | ≈ 0.0046 |
| Network fees | ≈ 0.00002 plus any wallet priority fee |

HYMET charges no launch fee.
