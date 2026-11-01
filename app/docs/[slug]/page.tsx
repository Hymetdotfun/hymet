import { notFound } from "next/navigation";
import DocsHub from "../../../components/docs-hub";
import { docsArticles, findDoc } from "../../../lib/docs-content";

export function generateStaticParams() {
  return docsArticles.filter((article) => article.slug).map((article) => ({ slug: article.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const article = findDoc(slug);
  if (!article) return { title: "Guide Not Found · HYMET" };
  return { title: `${article.title} · HYMET Docs`, description: article.summary };
}

export default async function DocumentationArticle({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const article = findDoc(slug);
  if (!article) notFound();
  return <main className="page-shell docs-page"><DocsHub activeSlug={article.slug} article={article} /></main>;
}
