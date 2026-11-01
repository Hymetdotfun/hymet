import { expect, it } from "vitest";
import { friendly } from "../lib/config";

it("shows an actionable error for Phantom's empty-message WalletNotReadyError", () => {
  const error = new Error("");
  error.name = "WalletNotReadyError";
  expect(friendly(error)).toContain("Phantom is not available in this browser");
});

it("keeps rejection handling and does not suppress unnamed wallet failures", () => {
  expect(friendly(new Error("User rejected request (4001)"))).toContain(
    "No automatic retry",
  );
  const error = new Error("");
  error.name = "WalletConnectionError";
  expect(friendly(error)).toBe("WalletConnectionError");
});
it("preserves sanitized RPC method and HTTP status ahead of generic blockhash handling", () => {
  const safe =
    "RPC operation getLatestBlockhash: HTTP 429; endpoint=configured-mainnet; attempts=3; request=4.";
  expect(
    friendly(Error(`upstream at https://credential.invalid ${safe}`)),
  ).toBe(safe);
  expect(
    friendly(
      Error(
        "RPC operation getBalance: timeout; endpoint=public-mainnet; attempts=1; request=2.",
      ),
    ),
  ).toContain("timeout");
});
