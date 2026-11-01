import Link from "next/link";

export default function NotFound() {
  return <main className="page-shell recovery-page"><span className="eyebrow">404 · OFF THE CURVE</span><h1>This page hasn’t launched.</h1><p>The link may have changed, or this page is no longer available.</p><div className="recovery-actions"><Link href="/explore" className="button-primary">Explore tokens →</Link><Link href="/" className="button-secondary">Back to home</Link></div></main>;
}
