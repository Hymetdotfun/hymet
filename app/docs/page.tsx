import DocsHub from "../../components/docs-hub";

export const metadata = { title: "HYMET Documentation · HYMET", description: "Guides to launch, trade, and understand tokens on HYMET." };

export default function Docs() {
  return (
    <main className="page-shell docs-page">
      <DocsHub activeSlug="" />
    </main>
  );
}
