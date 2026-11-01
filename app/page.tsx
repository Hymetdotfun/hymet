import Link from "next/link";
import { TokenFeed } from "../components/token-feed";
import { CosmicCanvas } from "../components/cosmic-canvas";

export default function Home() {
  return (
    <main className="home-page home-landing">
      <section className="home-hero cosmic-hero" aria-labelledby="hero-title">
        <CosmicCanvas />
        <div className="hero-copy cosmic-copy">
          <h1 id="hero-title"><span className="cosmic-headline-line">LAUNCH WITH</span><br /><em className="cosmic-headline-line">HYPE.</em></h1>
          <p>Create, launch, and trade tokens on Solana, paired with HYPE.</p>
          <div className="hero-actions">
            <Link className="button-primary" href="/launch">Launch a Token</Link>
            <Link className="hero-secondary cosmic-secondary" href="#explore">Explore Launches</Link>
          </div>
        </div>
      </section>

      <section className="home-explore" id="explore" aria-labelledby="explore-title">
        <header className="home-explore-heading">
          <div><h2 id="explore-title">Discover What&apos;s<br /><span>Launching.</span></h2><p>Explore tokens launched with HYPE. Discover new projects, follow their progress, and find your next opportunity.</p></div>
          <Link className="text-link explore-all" href="/explore">Open Explore <span aria-hidden="true">↗</span></Link>
        </header>
        <TokenFeed emptyVariant="explore" />
      </section>

    </main>
  );
}
