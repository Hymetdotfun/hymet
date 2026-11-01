// Test-network metadata storage: launch artwork and metadata JSON are kept on local disk and served by
// /api/test-network/files/<sha256> instead of being pinned to public IPFS. Only used while the guarded local
// test network is active (lib/app-network.ts).
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { testNetworkActive } from "./app-network";

const ID = /^[0-9a-f]{64}$/;
const TYPES = new Set(["image/png", "image/jpeg", "image/gif", "application/json"]);
const dir = () => path.resolve(process.env.HYMET_TEST_FILES_DIR || ".hymet-test-network/files");

/** Public origin the browser and the server both reach the test app at (e.g. http://localhost:3917). */
export function testFilesOrigin() {
  const origin = process.env.HYMET_TEST_PUBLIC_ORIGIN || "";
  if (!testNetworkActive() || !/^http:\/\/(localhost|127\.0\.0\.1):\d{1,5}$/.test(origin))
    throw Error("Test metadata storage needs the active test network and a loopback HYMET_TEST_PUBLIC_ORIGIN");
  return origin;
}
export function testFileUrl(id: string) {
  return `${testFilesOrigin()}/api/test-network/files/${id}`;
}
export function isTestFileUrl(value: string) {
  const url = new URL(value);
  return url.origin === testFilesOrigin() && /^\/api\/test-network\/files\/[0-9a-f]{64}$/.test(url.pathname);
}
export async function saveTestFile(bytes: Uint8Array, type: string) {
  if (!TYPES.has(type)) throw Error("Unsupported test file type");
  testFilesOrigin();
  const id = createHash("sha256").update(bytes).digest("hex");
  await mkdir(dir(), { recursive: true });
  await writeFile(path.join(dir(), id), bytes);
  await writeFile(path.join(dir(), `${id}.type`), type);
  return testFileUrl(id);
}
export async function readTestFile(id: string) {
  if (!testNetworkActive() || !ID.test(id)) return null;
  try {
    const type = (await readFile(path.join(dir(), `${id}.type`), "utf8")).trim();
    if (!TYPES.has(type)) return null;
    return { bytes: await readFile(path.join(dir(), id)), type };
  } catch {
    return null;
  }
}
