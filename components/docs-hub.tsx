"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { DocsCosmicBackground } from "./docs-cosmic-background";
import { docHref, docsArticles, docsGroups, type DocsArticle, type DocsSection } from "../lib/docs-content";

function SearchIcon() {
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></svg>;
}

function Arrow() {
  return <span className="dh-arrow" aria-hidden="true">↗</span>;
}

function Sidebar({ activeSlug }: { activeSlug: string }) {
  return (
    <nav className="dh-sidebar-nav" aria-label="Documentation sections">
      {docsGroups.map((group) => (
        <section className="dh-nav-group" key={group.name}>
          <h2>{group.name}</h2>
          {group.articles.map((item) => (
            <Link key={item.slug || "introduction"} href={docHref(item.slug)} className={activeSlug === item.slug ? "is-active" : undefined} aria-current={activeSlug === item.slug ? "page" : undefined}>
              <span className="dh-nav-icon" aria-hidden="true" />{item.title}
            </Link>
          ))}
        </section>
      ))}
    </nav>
  );
}

function QuickLinks() {
  const links = [
    ["create-token", "Create a Token", "Prepare and review a HYPE-paired launch."],
    ["trading-protocol-fees", "Trading & Fees", "Understand pool fees and platform allocation."],
    ["how-hymet-works", "How HYMET Works", "Follow the launch-to-trade lifecycle."],
  ];
  return (
    <div className="dh-quick-links">
      {links.map(([slug, title, summary]) => <Link href={docHref(slug)} key={slug}><span><strong>{title}</strong><small>{summary}</small></span><Arrow /></Link>)}
    </div>
  );
}

function Introduction() {
  return (
    <>
      <section className="dh-intro-hero" aria-labelledby="docs-title">
        <DocsCosmicBackground />
        <div className="dh-intro-copy">
          <span className="dh-eyebrow">HYMET DOCUMENTATION</span>
          <h1 id="docs-title"><span>Build With</span><em>HYPE.</em></h1>
          <p className="dh-intro-subtitle">Everything you need to launch, trade, and understand tokens on HYMET.</p>
          <p className="dh-intro-body">HYMET is a HYPE-paired token launchpad on Solana, powered by Meteora. Use these guides to prepare a token, understand its market, and review how fees, holder rewards, and migration work.</p>
          <div className="dh-hero-actions"><Link className="dh-primary-button" href="/launch">Create a Token</Link><Link className="dh-secondary-button" href="/explore">Explore Tokens</Link></div>
        </div>
      </section>
      <section className="dh-intro-links" aria-labelledby="quick-start-title">
        <div className="dh-section-heading"><div><span className="dh-eyebrow">QUICK START</span><h2 id="quick-start-title">Choose a guide</h2></div></div>
        <QuickLinks />
      </section>
      <section className="dh-workflow" aria-labelledby="workflow-title">
        <div className="dh-section-heading"><div><span className="dh-eyebrow">THE BASICS</span><h2 id="workflow-title">From launch to trade</h2></div><p>One clear path for creators and traders.</p></div>
        <ol>{[["01", "Launch", "Prepare your token and approve the launch in Phantom."], ["02", "Trade", "Trade against HYPE through the verified Meteora pool."], ["03", "Graduate", "The pool may migrate from DBC to DAMM v2 when conditions are met."], ["04", "Earn", "Creators claim their share, and holders receive eligible HYPE payouts automatically."]].map(([number, title, text]) => <li key={number}><span>{number}</span><div><strong>{title}</strong><p>{text}</p></div></li>)}</ol>
      </section>
      <aside className="dh-note"><span aria-hidden="true">i</span><p>{process.env.NEXT_PUBLIC_ENABLE_MAINNET === "true" ? "" : "Launching Soon: token creation, trading, and claims are not open yet. "}HYMET only reports transactions, pool states, and market values it can verify. A page being available does not mean every Mainnet feature is enabled.</p></aside>
    </>
  );
}

function SectionContent({ section }: { section: DocsSection }) {
  return (
    <section className="dh-article-section" id={section.id} aria-labelledby={`${section.id}-title`}>
      <h2 id={`${section.id}-title`}>{section.title}</h2>
      {section.paragraphs?.map((paragraph, index) => <p key={index}>{paragraph}</p>)}
      {section.facts && <dl className="dh-facts">{section.facts.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>}
      {section.steps && <ol className="dh-list dh-numbered">{section.steps.map((step, index) => <li key={index}>{step}</li>)}</ol>}
      {section.bullets && <ul className="dh-list">{section.bullets.map((item) => <li key={item}>{item}</li>)}</ul>}
      {section.flow && <div className="dh-flow" aria-label={section.flow.join(" then ")}>{section.flow.map((item, index) => <span key={item}>{index > 0 && <b aria-hidden="true">→</b>}<strong>{item}</strong></span>)}</div>}
      {section.note && <aside className="dh-note"><span aria-hidden="true">i</span><p>{section.note}</p></aside>}
    </section>
  );
}

function ArticleView({ article }: { article: DocsArticle }) {
  const currentIndex = docsArticles.findIndex((item) => item.slug === article.slug);
  const previous = docsArticles[currentIndex - 1];
  const next = docsArticles[currentIndex + 1];
  return (
    <article className="dh-article">
      <div className="dh-breadcrumb"><Link href="/docs">Docs</Link><span aria-hidden="true">/</span><span>{article.category}</span></div>
      <header className="dh-article-header"><span className="dh-eyebrow">{article.category.toUpperCase()}</span><h1>{article.title}</h1><p>{article.summary}</p></header>
      <div className="dh-article-content">{article.sections.map((section) => <SectionContent section={section} key={section.id} />)}</div>
      {article.slug === "official-links" && <OfficialLinks />}
      <nav className="dh-pager" aria-label="Documentation article navigation">
        {previous ? <Link href={docHref(previous.slug)}><small>PREVIOUS</small><strong>← {previous.title}</strong></Link> : <span />}
        {next ? <Link href={docHref(next.slug)}><small>NEXT</small><strong>{next.title} →</strong></Link> : <span />}
      </nav>
    </article>
  );
}

const officialLinks: Record<string, string> = {
  Meteora: "https://meteora.ag/",
  Phantom: "https://phantom.app/download",
  "HYPE source registry": "https://pump.fun/docs/custom-pairs",
};

export default function DocsHub({ activeSlug, article }: { activeSlug: string; article?: DocsArticle }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [activeSection, setActiveSection] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const sections = useMemo(() => article?.sections ?? [], [article]);
  const results = useMemo(() => {
    const value = query.trim().toLowerCase();
    if (!value) return [];
    return docsArticles.filter((item) => `${item.title} ${item.summary} ${item.category}`.toLowerCase().includes(value)).slice(0, 7);
  }, [query]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
        setSearchOpen(true);
      }
      if (event.key === "Escape") setSearchOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (!sections.length || !("IntersectionObserver" in window)) return;
    const observer = new IntersectionObserver((entries) => {
      const current = entries.filter((entry) => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (current?.target instanceof HTMLElement) setActiveSection(current.target.id);
    }, { rootMargin: "-18% 0px -67% 0px", threshold: 0 });
    sections.forEach((section) => {
      const element = document.getElementById(section.id);
      if (element) observer.observe(element);
    });
    return () => observer.disconnect();
  }, [sections]);

  function navigateSearch(slug: string) {
    setQuery("");
    setSearchOpen(false);
    router.push(docHref(slug));
  }

  return (
    <div className="dh-shell">
      <details className="dh-mobile-menu"><summary><span>Browse documentation</span><small>{docsArticles.length} articles</small></summary><Sidebar activeSlug={activeSlug} /></details>
      <div className="dh-grid">
        <aside className="dh-sidebar"><div className="dh-sidebar-title">HYMET DOCS</div><Sidebar activeSlug={activeSlug} /></aside>
        <div className="dh-main">
          <div className="dh-topbar"><span className="dh-current-label">{article ? article.category : "HYMET DOCUMENTATION"}</span><div className="dh-search-wrap"><label className="dh-search"><SearchIcon /><input ref={searchRef} type="search" role="combobox" aria-label="Search documentation" aria-expanded={searchOpen && Boolean(query.trim())} aria-controls="dh-search-results" aria-autocomplete="list" placeholder="Search documentation…" value={query} onFocus={() => setSearchOpen(true)} onChange={(event) => { setQuery(event.target.value); setSearchOpen(true); }} onKeyDown={(event) => { if (event.key === "Enter" && results[0]) { event.preventDefault(); navigateSearch(results[0].slug); } }} onBlur={() => window.setTimeout(() => setSearchOpen(false), 120)} /><kbd>Ctrl K</kbd></label>
              {searchOpen && query.trim() && <div className="dh-results" id="dh-search-results" role="listbox" aria-label="Documentation search results">{results.length ? results.map((item) => <button type="button" role="option" aria-selected={false} key={item.slug || "introduction"} onMouseDown={(event) => event.preventDefault()} onClick={() => navigateSearch(item.slug)}><strong>{item.title}</strong><small>{item.category} · {item.summary}</small></button>) : <p>No matching articles. Try another search.</p>}</div>}
            </div></div>
          {article ? <ArticleView article={article} /> : <Introduction />}
        </div>
        {article && sections.length > 2 ? <aside className="dh-toc"><span>ON THIS PAGE</span><nav>{sections.map((section) => <a href={`#${section.id}`} key={section.id} className={activeSection === section.id ? "is-active" : undefined} onClick={() => setActiveSection(section.id)}>{section.title}</a>)}</nav><div className="dh-toc-help"><small>NEED HELP?</small><Link href="/fees">Fees &amp; Rewards</Link></div></aside> : <aside className="dh-toc dh-toc-quiet">{article ? <><span>IN THIS GUIDE</span><p>{sections.length} topics</p></> : <><span>HYMET GUIDES</span><nav><Link href={docHref("create-token")}>Create a Token</Link><Link href={docHref("trading-protocol-fees")}>Trading &amp; Fees</Link><Link href={docHref("holder-rewards")}>Holder Rewards</Link></nav></>}</aside>}
      </div>
    </div>
  );
}

export function OfficialLinks() {
  return <div className="dh-official-links">
    <Link href="/launch">HYMET Launch Studio<Arrow /></Link>
    <Link href="/explore">HYMET Explore<Arrow /></Link>
    <Link href="/fees">HYMET Fees &amp; Rewards<Arrow /></Link>
    {Object.entries(officialLinks).map(([label, href]) => <a href={href} key={label} target="_blank" rel="noopener noreferrer">{label}<Arrow /></a>)}
  </div>;
}
