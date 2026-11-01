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
export function sameOrigin(request: Request) {
  if (!localRequest(request)) return false;
  const origin = request.headers.get("origin");
  if (!origin) return false;
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
