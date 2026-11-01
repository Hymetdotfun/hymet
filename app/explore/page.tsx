import { TokenFeed } from "../../components/token-feed";

export const metadata = { title: "Explore launches · HYMET" };
export default function Explore() {
  return (
    <main className="page-shell explore-page">
      <header className="page-heading explore-page-heading">
        <h1>
          Discover What&apos;s
          <br />
          <span>Launching.</span>
        </h1>
        <p>
          Explore tokens launched with HYPE. Discover new projects, follow their progress, and find your next opportunity.
        </p>
      </header>
      <TokenFeed emptyVariant="explore" />
    </main>
  );
}
