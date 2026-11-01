import { it, expect, vi, afterEach } from "vitest";
import { forwardRpc } from "../lib/rpc-forward";
afterEach(() => vi.restoreAllMocks());
it("retries only rate-limited reads and respects Retry-After", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      new Response("limited", { status: 429, headers: { "retry-after": "2" } }),
    )
    .mockResolvedValue(new Response('{"result":42}'));
  const sleep = vi.fn(async () => {});
  const r = await forwardRpc(
    "https://api.mainnet-beta.solana.com",
    "{}",
    "getBalance",
    1,
    fetcher,
    sleep,
  );
  expect(await r.json()).toEqual({ result: 42 });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(sleep).toHaveBeenCalledWith(2000);
});
it("bounds read retries and redacts endpoint credentials", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response("secret", { status: 429 }));
  const r = await forwardRpc(
    "https://private.invalid/SECRET",
    "{}",
    "getBalance",
    1,
    fetcher,
    async () => {},
  );
  const text = await r.text();
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(text).toContain("HTTP 429");
  expect(text).toContain("configured-mainnet");
  expect(text).not.toContain("SECRET");
});
it.each(["sendTransaction", "getBalance"])(
  "does not retry timeout for %s",
  async (method) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new DOMException("credential", "TimeoutError"));
    const r = await forwardRpc(
      "https://private.invalid/SECRET",
      "{}",
      method,
      1,
      fetcher,
      async () => {},
    );
    const text = await r.text();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(text).toContain("timeout");
    expect(text).not.toContain("credential");
    if (method === "sendTransaction") expect(text).toContain("UNKNOWN");
  },
);
it("never retries rate-limited broadcasts", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response("", { status: 429 }));
  const r = await forwardRpc(
    "https://api.mainnet-beta.solana.com",
    "{}",
    "sendTransaction",
    1,
    fetcher,
    async () => {},
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(await r.text()).toContain("Do not resend");
});
it.each([503, 403])("does not retry HTTP %s", async (status) => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response("", { status }));
  const r = await forwardRpc(
    "https://api.mainnet-beta.solana.com",
    "{}",
    "getBalance",
    1,
    fetcher,
    async () => {},
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(await r.text()).toContain(`HTTP ${status}`);
});
it("does not exceed bounded Retry-After budget", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      new Response("", { status: 429, headers: { "retry-after": "60" } }),
    );
  await forwardRpc(
    "https://api.mainnet-beta.solana.com",
    "{}",
    "getBalance",
    1,
    fetcher,
    async () => {},
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("separates transport failures from HTTP 429 and timeout without retry", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockRejectedValue(new TypeError("fetch failed at SECRET"));
  const r = await forwardRpc(
    "https://private.invalid/SECRET",
    "{}",
    "getBalance",
    1,
    fetcher,
    async () => {},
  );
  const text = await r.text();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(text).toContain("transport or bounded-response failure");
  expect(text).not.toContain("SECRET");
});
