import { it, expect } from "vitest";
import { sameOrigin, limitedBody, localRequest } from "../lib/http";
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
