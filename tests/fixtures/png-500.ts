import { deflateSync } from "node:zlib";
import { crc32 } from "../../lib/artwork";

function chunk(type: string, payload: Buffer) {
  const name=Buffer.from(type), length=Buffer.alloc(4), crc=Buffer.alloc(4);
  length.writeUInt32BE(payload.length);
  crc.writeUInt32BE(crc32(Buffer.concat([name,payload])));
  return Buffer.concat([length,name,payload,crc]);
}
export function png500() {
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(500,0);ihdr.writeUInt32BE(500,4);ihdr[8]=8;ihdr[9]=6;
  const row=Buffer.alloc(1+500*4);const pixels=Buffer.alloc(500*row.length);
  for(let y=0;y<500;y++)row.copy(pixels,y*row.length);
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk("IHDR",ihdr),chunk("IDAT",deflateSync(pixels)),chunk("IEND",Buffer.alloc(0))]);
}
