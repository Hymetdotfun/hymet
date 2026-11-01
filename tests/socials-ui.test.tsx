import { it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import Terminal from "../components/terminal";
import { WalletAppProvider } from "../components/wallet-app-provider";
// Terminal navigates after a confirmed launch; static rendering has no mounted App Router.
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, replace: () => {}, prefetch: () => {} }) }));
it("renders optional social inputs directly in the token form, outside collapsed details", () => {
  const html = renderToStaticMarkup(<WalletAppProvider><Terminal /></WalletAppProvider>);
  const tokenInformation = html.match(/<section>[\s\S]*?<\/section>/)?.[0];
  expect(tokenInformation).toContain("Create your token");
  for (const [label, placeholder] of [
    ["Website URL", "https://yourproject.com"],
    ["X (Twitter) URL", "https://x.com/yourproject"],
    ["Telegram URL", "https://t.me/yourproject"],
  ]) {
    expect(tokenInformation).toContain(label);
    const tag = tokenInformation?.match(
      new RegExp(
        `<input[^>]*placeholder="${placeholder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*>`,
      ),
    )?.[0];
    expect(tag).toContain('type="url"');
    expect(tag).not.toMatch(/\brequired(?:=|\s|\/?>)/);
  }
  expect(tokenInformation).not.toContain("<details");
  expect(tokenInformation).toContain("Optional");
});
