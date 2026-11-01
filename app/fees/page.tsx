import Link from "next/link";
import { FeeLedger } from "../../components/fee-ledger";
import { PlatformFeeClaims } from "../../components/platform-fee-claims";
import { CreatorFeeClaims } from "../../components/creator-fee-claims";
export const metadata = { title: "Fees & rewards · HYMET" };
export default function Fees() {
  return (
    <main className="page-shell fees-page">
      <header className="fees-hero">
        <h1><span>Earn With</span><em>Every Trade.</em></h1>
        <p>Track trading fees, creator earnings, and holder rewards in one place.</p>
      </header>
      <FeeLedger />
      <CreatorFeeClaims />
      <PlatformFeeClaims />
      <p className="fees-disclosure">Trading fees are subject to Meteora protocol fees. HYMET receives 20% of distributable fees; the remaining 80% follows the creator’s configured allocation. <Link href="/docs/fee-distribution">View fee and migration details ↗</Link></p>
    </main>
  );
}
