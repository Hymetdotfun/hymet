import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import Terminal from "../components/terminal";
import { WalletAppProvider } from "../components/wallet-app-provider";
import {
  ApplicationTabs,
  ApplicationPanel,
  appTabs,
} from "../components/application-tabs";
// Terminal navigates after a confirmed launch; static rendering has no mounted App Router.
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, replace: () => {}, prefetch: () => {} }) }));
it("renders three accessible tabs with mounted inactive panels and a Mainnet-only header", () => {
  const html = renderToStaticMarkup(<WalletAppProvider><Terminal /></WalletAppProvider>);
  for (const t of appTabs) {
    expect(html).toContain(`id="tab-${t.id}"`);
    expect(html).toContain(`aria-controls="panel-${t.id}"`);
    expect(html).toContain(`id="panel-${t.id}"`);
  }
  expect(html).toMatch(/id="panel-launch"[^>]*>/);
  expect(html).toMatch(/id="panel-tokens"[^>]*hidden=""/);
  expect(html).toMatch(/id="panel-fees"[^>]*hidden=""/);
  expect(html).toContain("Create your token");
  expect(html).toContain("Connect Phantom from the navigation to discover your tokens");
  expect(html).toContain("DBC pool address");
  expect(html).not.toContain('aria-label="Solana network"');
  expect(html).not.toMatch(/devnet/i);
  expect(html.indexOf("Mainnet Beta")).toBeLessThan(html.indexOf("</header>"));
  expect(html.indexOf('role="tablist"')).toBeLessThan(
    html.indexOf("</header>"),
  );
  expect(html).toContain("Bring Your Idea.");
  expect(html).toContain("Launch With HYPE.");
});
it("tab clicks and keyboard navigation only select a tab and focus its control", () => {
  const change = vi.fn();
  const element = ApplicationTabs({ active: "launch", onChange: change });
  const buttons = element.props.children;
  buttons[1].props.onClick();
  expect(change).toHaveBeenLastCalledWith("tokens");
  const focus = vi.fn(),
    querySelector = vi.fn(() => ({ focus })),
    preventDefault = vi.fn();
  buttons[0].props.onKeyDown({
    key: "ArrowLeft",
    preventDefault,
    currentTarget: { parentElement: { querySelector } },
  });
  expect(change).toHaveBeenLastCalledWith("fees");
  expect(querySelector).toHaveBeenLastCalledWith("#tab-fees");
  expect(focus).toHaveBeenCalledTimes(1);
  buttons[2].props.onKeyDown({
    key: "Home",
    preventDefault,
    currentTarget: { parentElement: { querySelector } },
  });
  expect(change).toHaveBeenLastCalledWith("launch");
});
it("retains inactive panel children instead of conditional unmounting", () => {
  const child = <input defaultValue="Unsaved token" />;
  const hidden = ApplicationPanel({
    id: "launch",
    active: "fees",
    children: child,
  });
  const shown = ApplicationPanel({
    id: "launch",
    active: "launch",
    children: child,
  });
  expect(hidden.props.hidden).toBe(true);
  expect(shown.props.hidden).toBe(false);
  expect(hidden.props.children).toBe(child);
  expect(shown.props.children).toBe(child);
});
