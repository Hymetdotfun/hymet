import { allocationFromBps } from "../lib/hymet-policy";

const percent = (bps: number) => `${Number((bps / 100).toFixed(2))}%`;

export type FeeCard = { label: string; value: string; detail: string };

/** Fee cards from a token's confirmed split (verified against its launch transaction and immutable on-chain fee pool). */
export function feeDistributionCards(tradingFeeBps: number, creatorBpsOfRemaining: number, holderBpsOfRemaining: number): FeeCard[] | null {
  let allocation;
  try {
    allocation = allocationFromBps(creatorBpsOfRemaining, holderBpsOfRemaining);
  } catch {
    return null;
  }
  const { hymet, creator, holders } = allocation.effectiveBps;
  const remaining = percent(10_000 - hymet);
  return [
    { label: "TRADING FEE", value: percent(tradingFeeBps), detail: "Per swap, set at launch" },
    { label: "HYMET PLATFORM", value: percent(hymet), detail: "Fixed platform share" },
    { label: "CREATOR SHARE", value: percent(creator), detail: `${percent(creatorBpsOfRemaining)} of the remaining ${remaining}` },
    { label: "HOLDER REWARDS", value: percent(holders), detail: `${percent(holderBpsOfRemaining)} of the remaining ${remaining}` },
  ];
}

export function FeeDistribution({ tradingFeeBps, creatorBpsOfRemaining, holderBpsOfRemaining }: { tradingFeeBps: number; creatorBpsOfRemaining: number; holderBpsOfRemaining: number }) {
  const cards = feeDistributionCards(tradingFeeBps, creatorBpsOfRemaining, holderBpsOfRemaining);
  if (!cards) return <p className="fee-distribution-note">Fee distribution unavailable for this launch record.</p>;
  return (
    <div className="fee-distribution">
      <div className="fee-distribution-cards" aria-label="Immutable fee distribution">
        {cards.map((card) => (
          <div key={card.label}>
            <small>{card.label}</small>
            <b>{card.value}</b>
            <span>{card.detail}</span>
          </div>
        ))}
      </div>
      <p className="fee-distribution-note">
        Immutable for this token. HYMET, creator and holder shares split the trading fees remaining after Meteora protocol fees.
      </p>
    </div>
  );
}
