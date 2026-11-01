import { quoteAsset } from "../lib/quote-assets";
import { sol, type Plan } from "../lib/transactions";
export default function LaunchCostBreakdown({ plan }: { plan: Plan }) {
  const quote = quoteAsset(plan.values);
  const preview = plan.costPreview;
  const row = (label: string, value: bigint) => (
    <div className="review-row" key={label}>
      <span>{label}</span>
      <strong>{sol(value)} SOL</strong>
    </div>
  );
  return (
    <section aria-label="Launch Cost Breakdown">
      <h3>Launch Cost Breakdown</h3>
      {row("Transaction fees — estimated expense", plan.fee)}
      {row("Rent deposits — RPC allowance", plan.rent)}
      {row("↳ Config rent included", plan.configRent)}
      {preview?.temporaryRent !== undefined && (
        <>
          {row("↳ Temporary WSOL rent included", preview.temporaryRent)}
          {row(
            "↳ Other rent allowance — no refund assumed",
            plan.rent >= preview.temporaryRent
              ? plan.rent - preview.temporaryRent
              : 0n,
          )}
        </>
      )}
      {row("Pool creation charge — expense", plan.poolFee)}
      {quote.native ? (
        row("Initial token purchase", plan.buy)
      ) : (
        <div className="review-row">
          <span>Initial token purchase — separate HYPE funding</span>
          <strong>{sol(plan.buy)} HYPE</strong>
        </div>
      )}
      {row("Estimated total SOL requirement", plan.total)}
      <p className="fine">
        Fees are RPC quotes for the actual transaction messages. Rent is
        calculated at current RPC rates from SDK account sizes with existing
        metadata/account headroom; it is an allowance, not a fixed launch price.
        Network and pool creation fees are nonrefundable expenses if charged.
        The initial purchase buys tokens and is not a rent deposit.
      </p>
      <p className="fine">
        {quote.native
          ? "On a successful SOL initial buy"
          : "For HYPE buys no WSOL account is created or unwrapped. For SOL buys"}{" "}
        the SDK closes temporary wrapped SOL back to the payer, returning its
        rent. No refund is promised if that transaction fails. Config, mint,
        pool, vault and immutable metadata deposits have no supported owner
        refund path here. Buyer token-account rent is only potentially
        recoverable after the account is empty and explicitly closed; this
        launcher does not close it. Unused allowance stays in the wallet.
      </p>
      {preview?.simulations.map((s, i) => (
        <p className="fine" key={i}>
          {s.label}:{" "}
          {s.status === "passed" ||
          plan.steps.find((step) => step.label === s.label)?.simulationUnits !==
            undefined
            ? `unsigned simulation passed${s.units === undefined ? "" : ` · ${s.units} CU`}${s.payerDebit === undefined ? "" : ` · simulated net payer debit ${sol(s.payerDebit)} SOL`}`
            : s.status === "deferred"
              ? "simulation waits for the new config to exist on-chain"
              : "preview unavailable; mandatory pre-sign simulation still applies"}
          .
          {s.observedRent !== undefined &&
            ` Simulation-observed new account rent minimums: ${sol(s.observedRent)} SOL (already covered by the allowance; not added again).`}
        </p>
      ))}
      <p className="fine">
        Simulation net debit is not peak funding or a guaranteed final charge. A
        pool depending on a new config cannot yet be fully simulated; its
        rent/total remain provisional and extra program charges may apply. Every
        actual step still requires successful unsigned and signed simulation
        before broadcast. No transaction is sent by this breakdown.
      </p>
    </section>
  );
}
