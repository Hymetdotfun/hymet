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
it("labels the Devnet test endpoint and waits out Devnet Retry-After for reads only", async () => {
  const limited = () => new Response("limited", { status: 429, headers: { "retry-after": "8" } });
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(limited()).mockResolvedValueOnce(limited()).mockResolvedValue(new Response('{"result":"EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"}'));
  const sleep = vi.fn(async () => {});
  const r = await forwardRpc("https://api.devnet.solana.com", "{}", "getGenesisHash", 1, fetcher, sleep);
  expect(await r.json()).toEqual({ result: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG" });
  expect(sleep.mock.calls).toEqual([[8000], [8000]]);
  // The budget is bounded: four 8-second waits would exceed 30 s, so the fourth 429 is returned, labelled devnet.
  const always = vi.fn<typeof fetch>().mockImplementation(async () => limited());
  const failed = await (await forwardRpc("https://api.devnet.solana.com", "{}", "getGenesisHash", 1, always, async () => {})).text();
  expect(always).toHaveBeenCalledTimes(4);
  expect(failed).toContain("endpoint=devnet");
  expect(failed).not.toContain("mainnet");
  // A broadcast is never replayed, on Devnet either.
  const sends = vi.fn<typeof fetch>().mockImplementation(async () => limited());
  await forwardRpc("https://api.devnet.solana.com", "{}", "sendTransaction", 1, sends, async () => {});
  expect(sends).toHaveBeenCalledTimes(1);
});
it("labels endpoints without exposing URLs", async () => {
  const { rpcEndpointLabel } = await import("../lib/rpc-forward");
  expect(rpcEndpointLabel("https://api.devnet.solana.com")).toBe("devnet");
  expect(rpcEndpointLabel("http://127.0.0.1:19995")).toBe("localnet");
  expect(rpcEndpointLabel("https://api.mainnet-beta.solana.com")).toBe("public-mainnet");
  expect(rpcEndpointLabel("https://private.invalid/SECRET")).toBe("configured-mainnet");
});
