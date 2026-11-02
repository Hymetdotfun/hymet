import Link from "next/link";
import { PublicKey } from "@solana/web3.js";
import { query, databaseConfigured } from "../../../lib/db";
import { MarketPanel } from "../../../components/market-panel";
import { HYPE_MINT } from "../../../lib/quote-assets";
import { TokenAvatar } from "../../../components/token-avatar";
import { TradePanel } from "../../../components/trade-panel";
import { FeeDistribution } from "../../../components/fee-distribution";
import { Connection } from "@solana/web3.js";
import { serverRpcUrl } from "../../../lib/app-network";
import { syncGraduation } from "../../../lib/graduation";
export const dynamic="force-dynamic";
type Token={mint_address:string;creator_wallet:string;name:string;ticker:string;description:string;metadata_uri:string;artwork_uri:string;trading_fee_bps:number;creator_share_of_remaining_bps:number;holder_share_of_remaining_bps:number;status:string;created_at:Date;social_links:Record<string,string>;pool_address?:string;pool_status?:string;pool_protocol?:string;dbc_pool?:string};
export default async function TokenDetail({params}:{params:Promise<{mint:string}>}){
  const {mint}=await params;try{new PublicKey(mint)}catch{return <main className="page-shell recovery-page"><span className="eyebrow">TOKEN LOOKUP</span><h1>Invalid token address</h1><p>Check the Solana mint address, or explore confirmed HYMET launches.</p><Link className="button-primary" href="/explore">Explore tokens →</Link></main>}
  let token:Token|undefined;let unavailable=false;
  if(databaseConfigured())try{await syncGraduation(new Connection(serverRpcUrl(),"confirmed"),mint).catch(()=>undefined);const r=await query<Token>(`SELECT t.*,p.pool_address,p.status AS pool_status,p.protocol AS pool_protocol,(SELECT d.pool_address FROM pools d WHERE d.mint_address=t.mint_address AND d.protocol='meteora_dbc') AS dbc_pool FROM tokens t LEFT JOIN pools p ON p.mint_address=t.mint_address AND p.status IN ('active','migrated') WHERE t.mint_address=$1 AND t.quote_mint=$2 ORDER BY CASE WHEN p.protocol='meteora_damm_v2' THEN 0 ELSE 1 END LIMIT 1`,[mint,HYPE_MINT.toBase58()]);token=r.rows[0]}catch{unavailable=true}else unavailable=true;
  return <main className="page-shell"><header className="detail-heading"><TokenAvatar src={token?.artwork_uri} symbol={token?.ticker||"H"} name={token?.name||"Token"}/><div><span className="eyebrow">HYMET TOKEN · HYPE QUOTE</span><h1>{token?token.name:"Token detail"} {token&&<small>${token.ticker}</small>}</h1><code>{mint}</code><p>{token?.status||"Awaiting HYMET index confirmation"}</p></div><Link className="text-link" href={`https://solscan.io/token/${encodeURIComponent(mint)}`} target="_blank" rel="noreferrer">Solscan ↗</Link></header>
    {token?.description&&<p className="token-description">{token.description}</p>}
    <div className="detail-columns"><div className="detail-main"><MarketPanel mint={mint}/><section className="panel-card"><div className="section-title-row"><h2>Token overview</h2><span className="quiet-label">Confirmed launch details</span></div>{token?<><FeeDistribution tradingFeeBps={token.trading_fee_bps} creatorBpsOfRemaining={token.creator_share_of_remaining_bps} holderBpsOfRemaining={token.holder_share_of_remaining_bps}/><div className="token-metadata"><div><small>CREATOR</small><code>{token.creator_wallet}</code></div>{Object.entries(token.social_links||{}).filter(([,url])=>url).map(([label,url])=><div key={label}><small>{label.toUpperCase()}</small><a href={url} target="_blank" rel="noreferrer">Open ↗</a></div>)}</div></>:<div className="empty-panel"><b>{unavailable?"Launch registry unavailable":"Token not yet verified in the HYMET index"}</b><p>{unavailable?"Connect PostgreSQL and verify a launch before token details can be shown.":"No matching, confirmed HYMET launch record exists for this mint."}</p></div>}</section></div>
      <aside className="panel-card trade-card"><h2>Trade with HYPE</h2><p>DBC swaps before graduation and DAMM v2 swaps afterward.</p>{token?<TradePanel mint={mint} pool={token.pool_address} poolStatus={token.pool_status} protocol={token.pool_protocol} dbcPool={token.dbc_pool} ticker={token.ticker} tokenStatus={token.status}/>:<small>Trading opens once this launch is verified in the HYMET index.</small>}<div className="curve-meter"><span>Pool state</span><b>{token?.pool_status||"—"}</b></div>{token?.pool_address&&<a href={`https://solscan.io/account/${encodeURIComponent(token.pool_address)}`} target="_blank" rel="noreferrer">View pool account ↗</a>}</aside></div>
  </main>
}
