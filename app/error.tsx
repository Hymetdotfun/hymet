"use client";
import Link from "next/link";

export default function PageError({retry}:{retry:()=>void}) {
  return <main className="page-shell recovery-page"><span className="eyebrow">LET’S TRY THAT AGAIN</span><h1>This page couldn’t load.</h1><p>Try loading it again, or return to the home page.</p><div className="recovery-actions"><button className="button-primary" onClick={retry}>Try again ↻</button><Link href="/" className="button-secondary">Back to home</Link></div></main>;
}
