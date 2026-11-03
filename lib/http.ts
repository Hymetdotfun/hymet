export function localRequest(request: Request) {
  try {
    const url = new URL(request.url);
    const authority = request.headers.get("host") || url.host;
    return (
      url.protocol === "http:" &&
      /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(authority)
    );
  } catch {
    return false;
  }
}
/** The one public origin a reverse-proxied deployment is served at (e.g. "https://hymet.fun"), or null: loopback only. */
function publicOrigin(): URL | null {
  const value = process.env.HYMET_PUBLIC_ORIGIN;
  if (!value) return null;
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) && url.origin === value ? url : null;
  } catch {
    return null;
  }
}
/** Loopback, or the configured public host (the proxy passes the original Host header). */
export function trustedHost(request: Request) {
  if (localRequest(request)) return true;
  const pub = publicOrigin();
  return Boolean(pub && request.headers.get("host") === pub.host);
}
export function sameOrigin(request: Request) {
  if (!trustedHost(request)) return false;
  const origin = request.headers.get("origin");
  if (!origin) return false;
  const pub = publicOrigin();
  // Behind the proxy the app sees plain HTTP; the browser's Origin must equal the configured origin exactly.
  if (pub && request.headers.get("host") === pub.host) return origin === pub.origin;
  try {
    const url = new URL(origin),
      requestUrl = new URL(request.url);
    return (
      url.host === (request.headers.get("host") || requestUrl.host) &&
      url.protocol === requestUrl.protocol
    );
  } catch {
    return false;
  }
}
export async function limitedBody(
  request: Pick<Request, "body">,
  limit: number,
) {
  const reader = request.body?.getReader();
  if (!reader) throw Error("Request body required");
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > limit) {
      await reader.cancel();
      throw Error("Request exceeds size limit");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return body;
}
