import { inflateSync } from "node:zlib";

export type ArtworkFormat = "image/png" | "image/jpeg" | "image/gif";
export function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function png(data: Buffer) {
  const signature = Buffer.from([137,80,78,71,13,10,26,10]);
  if (data.length < 45 || !data.subarray(0,8).equals(signature)) throw Error("Malformed PNG file");
  let offset = 8, width = 0, height = 0, seenData = false, ended = false;
  const compressed: Buffer[] = [];
  while (offset + 12 <= data.length) {
    const length = data.readUInt32BE(offset); const end = offset + 12 + length;
    if (length > data.length || end > data.length) throw Error("Truncated PNG chunk");
    const kind = data.toString("ascii", offset + 4, offset + 8);
    const payload = data.subarray(offset + 8, offset + 8 + length);
    const check = crc32(data.subarray(offset + 4, offset + 8 + length));
    if (check !== data.readUInt32BE(offset + 8 + length)) throw Error("PNG checksum failed");
    if (offset === 8) {
      if (kind !== "IHDR" || length !== 13) throw Error("PNG header is invalid");
      width = payload.readUInt32BE(0); height = payload.readUInt32BE(4);
      const depth = payload[8], color = payload[9];
      const validDepth = color === 3 ? [1,2,4,8].includes(depth) : [0,2,4,6].includes(color) && [8,16].includes(depth);
      if (!validDepth || payload[10] !== 0 || payload[11] !== 0 || payload[12] > 1) throw Error("Unsupported PNG encoding");
    }
    if (kind === "IDAT") { seenData = true; compressed.push(payload); }
    if (kind === "IEND") { if (length !== 0) throw Error("PNG end marker is invalid"); ended = true; offset = end; break; }
    offset = end;
  }
  if (!ended || !seenData || offset !== data.length) throw Error("PNG image data is incomplete");
  try { if (!inflateSync(Buffer.concat(compressed), { maxOutputLength: 4 * 1024 * 1024 }).length) throw Error(); }
  catch { throw Error("PNG image data is malformed"); }
  return { format: "image/png" as const, width, height };
}
function jpeg(data: Buffer) {
  if (data.length < 16 || data[0] !== 0xff || data[1] !== 0xd8) throw Error("Malformed JPEG file");
  let i = 2, width = 0, height = 0, scan = false, ended = false;
  const sof = new Set([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf]);
  while (i < data.length) {
    if (data[i] !== 0xff) { if (!scan) throw Error("JPEG marker is invalid"); i++; continue; }
    while (data[i] === 0xff) i++;
    const marker = data[i++];
    if (marker === 0xd9) { ended = true; break; }
    if (marker === 0x00 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) continue;
    if (i + 2 > data.length) throw Error("JPEG segment is truncated");
    const length = data.readUInt16BE(i);
    if (length < 2 || i + length > data.length) throw Error("JPEG segment length is invalid");
    if (sof.has(marker)) { if (length < 8) throw Error("JPEG frame is invalid"); height = data.readUInt16BE(i + 3); width = data.readUInt16BE(i + 5); }
    if (marker === 0xda) scan = true;
    i += length;
  }
  if (!ended || !scan || !width || !height) throw Error("JPEG frame or end marker is missing");
  return { format: "image/jpeg" as const, width, height };
}
function gif(data: Buffer) {
  if (data.length < 14 || !["GIF87a","GIF89a"].includes(data.toString("ascii",0,6))) throw Error("Malformed GIF file");
  const width = data.readUInt16LE(6), height = data.readUInt16LE(8), packed = data[10];
  let i = 13, frames = 0, trailer = false;
  if (packed & 0x80) i += 3 * (1 << ((packed & 7) + 1));
  function blocks() { while (i < data.length) { const size=data[i++]; if (size===0) return; i+=size; if (i>data.length) throw Error("GIF block is truncated"); } throw Error("GIF data is truncated"); }
  while (i < data.length) {
    const tag=data[i++];
    if (tag===0x3b) { trailer=true; break; }
    if (tag===0x21) { if(i>=data.length) throw Error("GIF extension is truncated"); i++; blocks(); continue; }
    if (tag!==0x2c || i+9>data.length) throw Error("GIF image descriptor is invalid");
    const flags=data[i+8]; i+=9;
    if(flags&0x80) i+=3*(1<<((flags&7)+1));
    if(i>=data.length || data[i]<2 || data[i]>8) throw Error("GIF LZW header is invalid"); i++; blocks(); frames++;
  }
  if (!trailer || !frames || i!==data.length) throw Error("GIF image or trailer is incomplete");
  return { format: "image/gif" as const, width, height };
}
export function validateArtwork(data: Uint8Array, declaredType: string) {
  const bytes = Buffer.from(data);
  const actual = bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? png(bytes) : bytes[0]===0xff&&bytes[1]===0xd8 ? jpeg(bytes) : ["GIF87a","GIF89a"].includes(bytes.toString("ascii",0,6)) ? gif(bytes) : undefined;
  if (!actual || actual.format !== declaredType) throw Error("Artwork bytes do not match PNG, JPEG, or GIF file type");
  if (actual.width !== 500 || actual.height !== 500) throw Error("Processed artwork must be 500 × 500 pixels");
  return actual;
}
