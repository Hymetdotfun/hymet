"use client";

import Link from "next/link";
import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { useWallet } from "@solana/wallet-adapter-react";
import { PhantomWalletName } from "@solana/wallet-adapter-phantom";
type PhantomProvider = { isPhantom?: boolean };
declare global { interface Window { solana?: PhantomProvider } }

function BrandMark({ size = 29 }: { size?: number }) {
  return (
    <Image
      className="site-mark"
      src="/hymet-logo.svg"
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      unoptimized
    />
  );
}

function SiteBrand({ symbolOnly = false, wordmark = "HYMET" }: { symbolOnly?: boolean; wordmark?: string }) {
  return (
    <Link className={`site-brand${symbolOnly ? " site-brand-symbol-only" : ""}`} href="/" aria-label="HYMET home">
      <BrandMark size={symbolOnly ? 58 : 29} />
      {!symbolOnly && <span>{wordmark}</span>}
    </Link>
  );
}

export function SiteNav() {
  const { publicKey, wallet: selectedWallet, select, connect: connectWallet, disconnect, connecting } = useWallet();
  const [menu, setMenu] = useState(false);
  const [notice,setNotice]=useState("");
  const [installPrompt,setInstallPrompt]=useState(false);
  const [connectionRequested, setConnectionRequested] = useState(false);
  const pathname=usePathname();
  const wallet = publicKey?.toBase58() || "";
  const [openedOn,setOpenedOn]=useState<string|null>(null);
  const menuOpen=menu&&openedOn===pathname;
  const headerRef=useRef<HTMLElement>(null);
  const toggleRef=useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!connectionRequested || !selectedWallet) return;
    void connectWallet().catch(() => setNotice("Wallet connection was not completed. You can try again.")).finally(() => setConnectionRequested(false));
  }, [connectionRequested, selectedWallet, connectWallet]);
  useEffect(()=>{if(!menuOpen&&!notice)return;const close=(event:KeyboardEvent)=>{if(event.key==='Escape'){setMenu(false);setNotice('');toggleRef.current?.focus();}};window.addEventListener('keydown',close);return()=>window.removeEventListener('keydown',close);},[menuOpen,notice]);
  useEffect(()=>{if(!menuOpen)return;const close=(event:PointerEvent)=>{if(!(event.target instanceof Node))return;const root=headerRef.current;const inMenu=root?.querySelector('.site-menu')?.contains(event.target);const onToggle=root?.querySelector('.nav-toggle')?.contains(event.target);if(!inMenu&&!onToggle)setMenu(false);};document.addEventListener('pointerdown',close);return()=>document.removeEventListener('pointerdown',close);},[menuOpen]);
  async function connect() {
    setNotice("");
    setInstallPrompt(false);
    if (typeof window !== "undefined" && !window.solana?.isPhantom) { setInstallPrompt(true);setNotice("Open this site in Phantom or install the Phantom browser extension to connect."); return; }
    try {
      if (selectedWallet?.adapter.name !== PhantomWalletName) {
        select(PhantomWalletName);
        setConnectionRequested(true);
        return;
      }
      await connectWallet();
    }
    catch { setNotice("Wallet connection was not completed. You can try again."); }
  }
  async function disconnectWallet(){try{await disconnect();setMenu(false);}catch{setInstallPrompt(false);setNotice('Wallet disconnection was not completed. Please try again.');}}
  const menuItems = [["/dashboard","Dashboard"],["/fees","Fees & Rewards"],["/docs","Docs"]] as const;
  const mobileItems = [["/explore","Explore"],["/launch","Launch a Token"],...menuItems] as const;
  const socialItems = [
    { label: "X (Twitter)", href: "https://x.com/Hymetdotfun", hosts: ["x.com", "www.x.com", "twitter.com", "www.twitter.com"], icon: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18.9 2h3.1l-6.8 7.8L23.2 22h-6.3l-4.9-7.3L5.5 22H2.3l7.3-8.4L1.7 2h6.5l4.4 6.7L18.9 2Zm-1.1 17.9h1.7L7.2 4H5.4l12.4 15.9Z"/></svg> },
    { label: "GitHub", href: "https://github.com/Hymetdotfun", hosts: ["github.com", "www.github.com"], icon: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 .9a11.1 11.1 0 0 0-3.5 21.6c.6.1.8-.2.8-.5v-2c-3.1.7-3.8-1.3-3.8-1.3-.5-1.3-1.2-1.6-1.2-1.6-1-.7.1-.7.1-.7 1.1.1 1.7 1.1 1.7 1.1 1 .1.8 1.9 3.6 1.4.1-.7.4-1.2.7-1.5-2.5-.3-5.1-1.3-5.1-5.5 0-1.2.4-2.1 1.1-2.9-.1-.3-.5-1.4.1-2.9 0 0 .9-.3 3 1.1a10.4 10.4 0 0 1 5.5 0c2.1-1.4 3-1.1 3-1.1.6 1.5.2 2.6.1 2.9.7.8 1.1 1.7 1.1 2.9 0 4.2-2.6 5.2-5.1 5.5.4.3.8 1 .8 2v2.8c0 .3.2.6.8.5A11.1 11.1 0 0 0 12 .9Z"/></svg> },
    { label: "DexScreener", href: process.env.NEXT_PUBLIC_HYMET_DEXSCREENER_URL, hosts: ["dexscreener.com", "www.dexscreener.com"], icon: <Image className="site-menu-dex-icon" src="/hymet-owl-mark.png" alt="" width={24} height={24} unoptimized /> },
  ].map((item) => {
    if (!item.href) return { ...item, href: undefined };
    try { const url = new URL(item.href); if (url.protocol !== "https:" || !item.hosts.includes(url.hostname)) return { ...item, href: undefined }; return { ...item, href: url.toString() }; }
    catch { return { ...item, href: undefined }; }
  });
  const setNavigationClosed=()=>{setMenu(false);setNotice("");};
  return <header className="site-header" ref={headerRef}>
    <SiteBrand symbolOnly />
    <nav className="site-primary-nav" aria-label="Primary navigation">
      <Link href="/explore" onClick={setNavigationClosed} aria-current={pathname==="/explore"?"page":undefined}>Explore</Link>
      <Link href="/launch" onClick={setNavigationClosed} aria-current={pathname==="/launch"?"page":undefined}>Launch a Token</Link>
    </nav>
    <button ref={toggleRef} className={`nav-toggle${menuOpen?" is-open":""}`} aria-expanded={menuOpen} aria-controls="site-menu" aria-label={menuOpen?"Close navigation menu":"Open navigation menu"} onClick={() => {setOpenedOn(pathname);setMenu(!menuOpen);}}><span/><span/></button>
    <div className={`site-menu${menuOpen?" is-open":""}`} id="site-menu" aria-label="Navigation menu" aria-hidden={!menuOpen}>
      <nav className="site-menu-links" aria-label="More navigation">
        {mobileItems.map(([href,label])=><Link className={href==="/explore"||href==="/launch"?"mobile-menu-link":""} key={href} href={href} tabIndex={menuOpen?0:-1} onClick={setNavigationClosed} aria-current={pathname===href?"page":undefined}>{label}</Link>)}
      </nav>
      <div className="site-menu-wallet">
        {wallet ? <><span className="site-menu-connected" title={wallet}>{`${wallet.slice(0,6)}…${wallet.slice(-5)}`}</span><button type="button" tabIndex={menuOpen?0:-1} disabled={connecting} onClick={()=>void disconnectWallet()}>Disconnect</button></> : <button type="button" tabIndex={menuOpen?0:-1} disabled={connecting} onClick={()=>void connect()}>{connecting?"Connecting…":"Connect Wallet"}</button>}
      </div>
      {notice&&<p className="site-menu-notice" role="status">{notice}{installPrompt&&<a href="https://phantom.app/download" target="_blank" rel="noopener noreferrer">Get Phantom</a>}</p>}
      <div className="site-menu-socials" aria-label="HYMET social links">{socialItems.map((item)=>item.href ? <a key={item.label} href={item.href} aria-label={item.label} title={item.label} target="_blank" rel="noopener noreferrer" tabIndex={menuOpen?0:-1}>{item.icon}</a> : <span key={item.label} role="img" aria-label={`${item.label}: official HYMET link not configured`} title={`${item.label}: official HYMET link not configured`}>{item.icon}</span>)}</div>
    </div>
  </header>;
}

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <section className="footer-column footer-brand-column" aria-label="HYMET brand">
        <SiteBrand wordmark="Hymet" />
        <small>© 2026 Hymet</small>
      </section>
      <nav className="footer-column" aria-labelledby="footer-platform">
        <h2 className="footer-heading" id="footer-platform">Platform</h2>
        <Link href="/launch">Launch</Link>
        <Link href="/explore">Explore</Link>
        <Link href="/dashboard">Dashboard</Link>
        <Link href="/fees">Fees &amp; Rewards</Link>
      </nav>
      <nav className="footer-column" aria-labelledby="footer-resources">
        <h2 className="footer-heading" id="footer-resources">Resources</h2>
        <Link href="/docs">Documentation</Link>
        <a href="https://meteora.ag" target="_blank" rel="noreferrer">Meteora</a>
      </nav>
      <div className="footer-column footer-about" role="group" aria-labelledby="footer-about">
        <h2 className="footer-heading" id="footer-about">About HYMET</h2>
        <p>A HYPE-paired token launchpad on Solana, built for creators and communities.</p>
      </div>
    </footer>
  );
}
