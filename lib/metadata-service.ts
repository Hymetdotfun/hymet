import { limitedBody } from "./http";
// Server-only metadata transport. Upload POSTs are never retried.
export class MetadataOperationError extends Error {
  constructor(
    public operation: string,
    public outcome: string,
    public status: number,
    public upstreamStatus?: number,
    public code?: string,
  ) {
    super(
      `${operation}: ${outcome}${upstreamStatus ? ` (upstream HTTP ${upstreamStatus})` : ""}${code ? ` [${code}]` : ""}`,
    );
  }
}
export async function metadataFetch(
  url: string,
  init: RequestInit,
  operation: string,
  readOnly: boolean,
  request: string,
  fetcher: typeof fetch = fetch,
  sleep = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms)),
) {
  for (let attempt = 1; ; attempt++) {
    const start = Date.now();
    let failure: MetadataOperationError;
    let retryAfter: string | null = null;
    try {
      const response = await fetcher(url, {
        ...init,
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(readOnly ? 30000 : 60000),
      });
      console.info("Metadata diagnostic", {
        request,
        operation,
        attempt,
        httpStatus: response.status,
        durationMs: Date.now() - start,
      });
      if (response.ok) return response;
      retryAfter = response.headers.get("retry-after");
      await response.body?.cancel();
      failure = new MetadataOperationError(
        operation,
        "service rejected request",
        response.status === 429 ? 429 : response.status >= 500 ? 502 : 400,
        response.status,
      );
    } catch (e) {
      const error = e as { name?: string; cause?: { code?: unknown } };
      const code =
        typeof error.cause?.code === "string" &&
        /^[A-Z][A-Z0-9_]{0,63}$/.test(error.cause.code)
          ? error.cause.code
          : undefined;
      const timeout = ["TimeoutError", "AbortError"].includes(error.name || "");
      failure = new MetadataOperationError(
        operation,
        timeout ? "timeout" : "transport failure",
        timeout ? 504 : 502,
        undefined,
        code,
      );
      console.info("Metadata diagnostic", {
        request,
        operation,
        attempt,
        outcome: failure.outcome,
        code,
        durationMs: Date.now() - start,
      });
    }
    let wait = 500 * attempt;
    if (retryAfter) {
      const n = Number(retryAfter);
      const delay = Number.isFinite(n)
        ? n * 1000
        : Date.parse(retryAfter) - Date.now();
      if (Number.isFinite(delay)) wait = Math.max(wait, delay);
    }
    // Retry only public GET/HEAD verification, never uncertain Pinata writes.
    if (
      readOnly &&
      ["GET", "HEAD"].includes(init.method || "GET") &&
      attempt < 3 &&
      wait <= 5000 &&
      (!failure.upstreamStatus ||
        failure.upstreamStatus === 429 ||
        failure.upstreamStatus >= 500)
    ) {
      await sleep(wait);
      continue;
    }
    throw failure;
  }
}

export async function metadataJson(response: Response, operation: string) {
  try {
    return JSON.parse(
      new TextDecoder().decode(await limitedBody(response, 1024 * 1024)),
    );
  } catch (e) {
    const error = e as { name?: string; cause?: { code?: unknown } };
    const timeout = ["TimeoutError", "AbortError"].includes(error.name || "");
    const code =
      typeof error.cause?.code === "string" &&
      /^[A-Z][A-Z0-9_]{0,63}$/.test(error.cause.code)
        ? error.cause.code
        : undefined;
    throw new MetadataOperationError(
      operation,
      timeout
        ? "timeout reading response"
        : "invalid or incomplete JSON response",
      timeout ? 504 : 502,
      undefined,
      code,
    );
  }
}
