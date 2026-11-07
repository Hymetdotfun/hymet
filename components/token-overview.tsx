import { allocationFromBps } from "../lib/hymet-policy";

const percent = (bps: number) => `${Number((bps / 100).toFixed(2))}%`;

export type OverviewRow = { label: string; value: string; detail?: string };

/** Trading-fee rows from a token's confirmed split: the total fee per swap, then how the distributable fees (what remains
 *  after Meteora's protocol share) are divided. Returns null when the stored split is not a valid allocation. */
export function tradingFeeRows(tradingFeeBps: number, creatorBpsOfRemaining: number, holderBpsOfRemaining: number) {
  let allocation;
  try {
    allocation = allocationFromBps(creatorBpsOfRemaining, holderBpsOfRemaining);
  } catch {
    return null;
  }
  const { hymet, creator, holders } = allocation.effectiveBps;
  const remaining = percent(10_000 - hymet);
  return {
    total: [
      { label: "Trading fee", value: percent(tradingFeeBps), detail: "Charged on every swap, set at launch" },
      { label: "Meteora protocol share", value: "Deducted first", detail: "20% of the fee on the bonding curve; DAMM v2 sets its own" },
    ] satisfies OverviewRow[],
    distributable: [
      { label: "HYMET platform", value: percent(hymet), detail: "Fixed platform share" },
      { label: "Creator", value: percent(creator), detail: `${percent(creatorBpsOfRemaining)} of the remaining ${remaining}` },
      { label: "Holders", value: percent(holders), detail: `${percent(holderBpsOfRemaining)} of the remaining ${remaining}` },
    ] satisfies OverviewRow[],
  };
}

function Rows({ rows }: { rows: OverviewRow[] }) {
  return (
    <dl className="overview-rows">
      {rows.map((row) => (
        <div key={row.label}>
          <dt>
            {row.label}
            {row.detail && <small>{row.detail}</small>}
          </dt>
          <dd>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function socialHost(url: string) {
  try {
    const parsed = new URL(url);
    return (parsed.host + parsed.pathname).replace(/^www\./, "").replace(/\/$/, "");
  } catch {
    return "Open link";
  }
}

const short = (value: string) => `${value.slice(0, 6)}…${value.slice(-6)}`;

export function TokenOverview({
  mint,
  creator,
  tradingFeeBps,
  creatorBpsOfRemaining,
  holderBpsOfRemaining,
  socialLinks,
  launchedAt,
}: {
  mint: string;
  creator: string;
  tradingFeeBps: number;
  creatorBpsOfRemaining: number;
  holderBpsOfRemaining: number;
  socialLinks: Record<string, string>;
  launchedAt?: Date | string;
}) {
  const fees = tradingFeeRows(tradingFeeBps, creatorBpsOfRemaining, holderBpsOfRemaining);
  const socials = Object.entries(socialLinks || {}).filter(([, url]) => typeof url === "string" && /^https?:\/\//i.test(url));
  const launched = launchedAt ? new Date(launchedAt) : undefined;
  return (
    <div className="token-overview">
      <div className="overview-panel" role="group" aria-labelledby="overview-fees-title">
        <h3 id="overview-fees-title">Trading Fees</h3>
        {fees ? (
          <>
            <Rows rows={fees.total} />
            <p className="overview-subhead">Distributable fees · after Meteora&apos;s share</p>
            <Rows rows={fees.distributable} />
            <p className="overview-note">Immutable for this token. Shares are percentages of distributable fees.</p>
          </>
        ) : (
          <p className="overview-note">Fee distribution unavailable for this launch record.</p>
        )}
      </div>
      <div className="overview-panel" role="group" aria-labelledby="overview-info-title">
        <h3 id="overview-info-title">Token Information</h3>
        <dl className="overview-rows">
          <div>
            <dt>Creator</dt>
            <dd>
              <a href={`https://solscan.io/account/${encodeURIComponent(creator)}`} target="_blank" rel="noreferrer" title={creator}>
                {short(creator)} ↗
              </a>
            </dd>
          </div>
          <div>
            <dt>Mint</dt>
            <dd>
              <a href={`https://solscan.io/token/${encodeURIComponent(mint)}`} target="_blank" rel="noreferrer" title={mint}>
                {short(mint)} ↗
              </a>
            </dd>
          </div>
          {launched && Number.isFinite(launched.getTime()) && (
            <div>
              <dt>Launched</dt>
              <dd>
                {new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC", timeZoneName: "short" }).format(launched)}
              </dd>
            </div>
          )}
          {socials.map(([label, url]) => (
            <div key={label}>
              <dt>{label.charAt(0).toUpperCase() + label.slice(1)}</dt>
              <dd>
                <a href={url} target="_blank" rel="noreferrer">
                  {socialHost(url)} ↗
                </a>
              </dd>
            </div>
          ))}
          {!socials.length && (
            <div>
              <dt>Social links</dt>
              <dd className="overview-muted">None provided</dd>
            </div>
          )}
        </dl>
      </div>
    </div>
  );
}
