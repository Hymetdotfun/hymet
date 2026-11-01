"use client";
import dynamic from "next/dynamic";
const Terminal = dynamic(async () => { await import("../../lib/browser"); return import("../../components/terminal"); }, { ssr: false, loading: () => <main className="page-shell" aria-busy="true"><header className="page-heading"><span className="eyebrow">LAUNCH STUDIO</span><h1>Launch your next idea</h1><p role="status">Preparing the launch studio…</p></header><div className="studio-loading" aria-hidden="true"><div className="launch-skeleton"/><div className="launch-skeleton"/></div></main> });
export default function Launch() { return <div className="launch-shell"><Terminal/></div>; }
