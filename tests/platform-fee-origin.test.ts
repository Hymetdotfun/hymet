import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "../app/api/platform-fees/route";

// Next.js serves `next start --hostname 127.0.0.1` with request.url rewritten to localhost; the Host header keeps 127.0.0.1.
const call = (origin: string, host = "127.0.0.1:4180") =>
  POST(new NextRequest("http://localhost:4180/api/platform-fees", { method: "POST", headers: { origin, host, "content-type": "application/json" }, body: "{}" }));

describe("platform fee route origin check", () => {
  it("accepts the page's real 127.0.0.1 origin even though request.url says localhost", async () => {
    const r = await call("http://127.0.0.1:4180");
    expect((await r.json()).error).not.toBe("Same-origin request required");
  });
  it("still rejects cross-origin, mismatched-port and non-loopback requests", async () => {
    for (const [origin, host] of [["https://evil.example", "127.0.0.1:4180"], ["http://127.0.0.1:9999", "127.0.0.1:4180"], ["http://attacker.example", "attacker.example"]]) {
      const r = await call(origin, host);
      expect(r.status).toBe(403);
    }
  });
});
