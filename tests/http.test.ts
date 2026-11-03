import { it, expect } from "vitest";
import { sameOrigin, limitedBody, localRequest, trustedHost } from "../lib/http";
it("rejects matching attacker origins and non-loopback host headers", () => {
  const request = new Request("http://localhost:3000/api/metadata", {
    headers: {
      host: "attacker.example:3000",
      origin: "http://attacker.example:3000",
    },
  });
  expect(localRequest(request)).toBe(false);
  expect(sameOrigin(request)).toBe(false);
  expect(localRequest(new Request("http://192.168.1.2:3000"))).toBe(false);
  expect(localRequest(new Request("http://127.0.0.1:3000"))).toBe(true);
});
it("accepts loopback host headers despite Next URL normalization", () => {
  expect(
    sameOrigin(
      new Request("http://localhost:3000/api/rpc", {
        headers: { origin: "http://127.0.0.1:3000", host: "127.0.0.1:3000" },
      }),
    ),
  ).toBe(true);
  expect(
    sameOrigin(
      new Request("http://localhost:3000/api/rpc", {
        headers: { origin: "https://foreign.example", host: "127.0.0.1:3000" },
      }),
    ),
  ).toBe(false);
});
it("bounds actual request bytes rather than trusting content-length", async () => {
  await expect(
    limitedBody(
      new Request("http://localhost", { method: "POST", body: "123456" }),
      5,
    ),
  ).rejects.toThrow("size limit");
});
it("accepts only the configured public origin behind a reverse proxy", () => {
  const prev = process.env.HYMET_PUBLIC_ORIGIN;
  process.env.HYMET_PUBLIC_ORIGIN = "https://hymet.example";
  try {
    const proxied = (host: string, origin?: string) =>
      new Request("http://127.0.0.1:3919/api/graduation/x", { headers: { host, ...(origin ? { origin } : {}) } });
    expect(trustedHost(proxied("hymet.example"))).toBe(true);
    expect(sameOrigin(proxied("hymet.example", "https://hymet.example"))).toBe(true);
    expect(sameOrigin(proxied("hymet.example", "http://hymet.example"))).toBe(false);
    expect(sameOrigin(proxied("hymet.example", "https://attacker.example"))).toBe(false);
    expect(sameOrigin(proxied("hymet.example"))).toBe(false);
    expect(trustedHost(proxied("attacker.example"))).toBe(false);
    expect(sameOrigin(proxied("attacker.example", "https://attacker.example"))).toBe(false);
    // The loopback-only checks (test-network faucet) never accept the public host.
    expect(localRequest(proxied("hymet.example"))).toBe(false);
    process.env.HYMET_PUBLIC_ORIGIN = "https://hymet.example/path";
    expect(trustedHost(proxied("hymet.example"))).toBe(false);
  } finally {
    if (prev === undefined) delete process.env.HYMET_PUBLIC_ORIGIN;
    else process.env.HYMET_PUBLIC_ORIGIN = prev;
  }
});
