import { describe, expect, it, vi } from "vitest";
import { keeperFetch } from "../lib/keeper-rpc";

const body = (method: string) => JSON.stringify({ jsonrpc: "2.0", id: "1", method, params: [] });
const deadSocket = () => Promise.reject(new TypeError("fetch failed"));

describe("keeper RPC transport", () => {
  it("retries a read once after a transport failure such as a closed keep-alive socket", async () => {
    const fetcher = vi.fn().mockImplementationOnce(deadSocket).mockResolvedValueOnce(new Response("{}"));
    const response = await keeperFetch(30_000, fetcher)("https://rpc.invalid", { method: "POST", body: body("getAccountInfo") });
    expect(response.status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("never replays a broadcast", async () => {
    const fetcher = vi.fn().mockImplementation(deadSocket);
    await expect(keeperFetch(30_000, fetcher)("https://rpc.invalid", { method: "POST", body: body("sendTransaction") })).rejects.toThrow("fetch failed");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("does not retry a timed-out request and bounds every request with a signal", async () => {
    const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    const fetcher = vi.fn().mockRejectedValue(timeout);
    await expect(keeperFetch(30_000, fetcher)("https://rpc.invalid", { method: "POST", body: body("getSlot") })).rejects.toBe(timeout);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it("gives up after a single retry", async () => {
    const fetcher = vi.fn().mockImplementation(deadSocket);
    await expect(keeperFetch(30_000, fetcher)("https://rpc.invalid", { method: "POST", body: body("getProgramAccounts") })).rejects.toThrow("fetch failed");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
