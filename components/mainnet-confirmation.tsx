import Link from "next/link";
import { quoteAsset } from "../lib/quote-assets";
import { sol, remainingRequirement, type Plan } from "../lib/transactions";
import { activeNetworkLabel } from "../lib/app-network";

export default function MainnetConfirmation({
  plan,
  onConfirm,
  onCancel,
}: {
  plan: Plan;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const quote = quoteAsset(plan.values);
  const creatorAllocation = plan.allocation.creatorPercent;
  const holderAllocation = plan.allocation.holderPercent;

  return (
    <section aria-label="Confirm Mainnet launch">
      <span className="eyebrow">STEP 2 OF 2 · CONFIRM LAUNCH</span>
      <h2>Ready to launch?</h2>
      <p className="fine">
        Review the essentials, then continue to Phantom signing.
      </p>
      <div className="review-row">
        <span>Token</span>
        <strong>
          {plan.values.name} (${plan.values.symbol})
        </strong>
      </div>
      <div className="review-row">
        <span>Network · quote</span>
        <strong>{activeNetworkLabel()} · {quote.symbol}</strong>
      </div>
      <div className="review-row">
        <span>Trading fee</span>
        <strong>{plan.values.fee}% · max 3%</strong>
      </div>
      <div className="review-row">
        <span>Creator / holders of creator share</span>
        <strong>{creatorAllocation}% / {holderAllocation}%</strong>
      </div>
      <div className="review-row">
        <span>Initial buy</span>
        <strong>
          {sol(plan.buy)} {quote.symbol}
        </strong>
      </div>
      <div className="review-row">
        <span>Estimated SOL requirement</span>
        <strong>{sol(plan.total)} SOL</strong>
      </div>
      <div className="review-row">
        <span>Additional HYMET launch fee</span>
        <strong>0 SOL</strong>
      </div>
      <p className="fine fee-disclosure">
        After Meteora protocol fees, eligible distributable fees allocate 20%
        to HYMET and 80% to the creator-controlled share ({creatorAllocation}%
        creator / {holderAllocation}% holders). DAMM v2 migration fees are
        separate. <Link href="/docs/fee-distribution">Fee details ↗</Link>
      </p>
      <details>
        <summary>Transaction verification</summary>
        <div className="review-row">
          <span>HYPE quote mint</span>
          <strong>{quote.mint.toBase58()}</strong>
        </div>
        <div className="review-row">
          <span>Token mint</span>
          <strong>{plan.mint.publicKey.toBase58()}</strong>
        </div>
        <div className="review-row">
          <span>DBC pool</span>
          <strong>{plan.pool.toBase58()}</strong>
        </div>
        <div className="review-row">
          <span>Config</span>
          <strong>{plan.config.toBase58()}</strong>
        </div>
        <div className="review-row">
          <span>HYMET fee recipient</span>
          <strong>{plan.recipients.partner}</strong>
        </div>
        <div className="review-row">
          <span>Creator fee recipient</span>
          <strong>{plan.creator.toBase58()}</strong>
        </div>
        <div className="review-row">
          <span>Migration destination</span>
          <strong>Meteora DAMM v2</strong>
        </div>
        <div className="review-row">
          <span>Estimated remaining SOL requirement</span>
          <strong>{sol(remainingRequirement(plan))} SOL</strong>
        </div>
        <p className="fine">
          Network and fee-recipient checks passed. Transaction simulation
          completed before Phantom signing.
        </p>
        <a href={plan.uri} target="_blank" rel="noreferrer">
          View token metadata ↗
        </a>
      </details>
      <button className="primary" onClick={onConfirm}>
        Confirm Launch
      </button>
      <button onClick={onCancel}>Back to review</button>
    </section>
  );
}
