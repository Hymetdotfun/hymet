import type { MigrationView } from "../lib/migration";
import type { Network } from "../lib/transactions";

export function MigrationStatus({
  migration,
  network,
}: {
  migration: MigrationView;
  network: Network;
}) {
  return (
    <div className="fine">
      <p>
        <strong>{migration.label}</strong> · Trading venue: {migration.venue}
      </p>
      {migration.destination && (
        <p>
          DAMM V2 pool:{" "}
          <a
            href={`https://solscan.io/account/${migration.destination}${network === "devnet" ? "?cluster=devnet" : ""}`}
            target="_blank"
            rel="noreferrer"
          >
            {migration.destination} ↗
          </a>
        </p>
      )}
      {migration.detail && <p>{migration.detail}</p>}
      <p>
        <strong>DAMM V2 Claimable Fees:</strong> Verify wallet-owned positions
        in Creator Fees to read balances and review a supported claim.
        Unverified entitlements are unavailable, not zero.
      </p>
      <p>
        DBC creator fee allocation does not establish DAMM V2 position
        ownership. Migration is never initiated here.
      </p>
    </div>
  );
}
