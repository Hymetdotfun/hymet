import { limitedBody } from "./http";
import { officialLogoUrl } from "./xstocks";

// Small bounded cache, no cookies, wallet headers, redirects or arbitrary image hosts.
const cache = new Map<
  string,
  { until: number; bytes: Uint8Array; type: string }
>();
export async function issuerLogo(url: string, fetcher: typeof fetch = fetch) {
  const verified = officialLogoUrl(url);
  if (!verified) throw Error("Invalid issuer image");
  const hit = cache.get(verified);
  if (hit && hit.until > Date.now()) return hit;
  cache.delete(verified);
  const r = await fetcher(verified, {
    redirect: "error",
    credentials: "omit",
    cache: "no-store",
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw Error("Issuer image unavailable");
  const bytes = await limitedBody(r, 256 * 1024);
  const type = r.headers
    .get("content-type")
    ?.split(";")[0]
    .trim()
    .toLowerCase();
  const png =
    bytes.length >= 8 &&
    [137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b);
  const jpeg =
    bytes.length >= 3 &&
    bytes[0] === 255 &&
    bytes[1] === 216 &&
    bytes[2] === 255;
  const webp =
    bytes.length >= 12 &&
    new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" &&
    new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP";
  if (!(
    (type === "image/png" && png) ||
    (type === "image/jpeg" && jpeg) ||
    (type === "image/webp" && webp)
  ))
    throw Error("Invalid issuer image format");
  const result = { bytes, type, until: Date.now() + 60 * 60 * 1000 };
  if (cache.size >= 32) cache.delete(cache.keys().next().value!);
  cache.set(verified, result);
  return result;
}
