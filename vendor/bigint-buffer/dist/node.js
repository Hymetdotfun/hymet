'use strict';
// Pure-JS, bounds-checked replacement for bigint-buffer 1.1.5. Upstream has no patched
// release for GHSA-3gc7-fjrx-p6mg (native toBigIntLE overflow); this never loads a native addon.
const { Buffer } = require('buffer');

function bytes(buf) {
  if (!(buf instanceof Uint8Array)) throw new TypeError('bigint-buffer: expected a Buffer or Uint8Array');
  return buf;
}

function checkedWidth(width) {
  if (!Number.isSafeInteger(width) || width < 0) throw new RangeError('bigint-buffer: width must be a non-negative integer');
  return width;
}

function toBigIntBE(buf) {
  const hex = Buffer.from(bytes(buf)).toString('hex');
  return hex.length === 0 ? 0n : BigInt(`0x${hex}`);
}

function toBigIntLE(buf) {
  return toBigIntBE(Buffer.from(bytes(buf)).reverse());
}

function toBufferBE(num, width) {
  if (typeof num !== 'bigint') throw new TypeError('bigint-buffer: expected a bigint');
  checkedWidth(width);
  if (num < 0n) throw new RangeError('bigint-buffer: negative values are not representable');
  const hex = num.toString(16);
  if (hex !== '0' && hex.length > width * 2) throw new RangeError(`bigint-buffer: value does not fit in ${width} bytes`);
  return Buffer.from(hex.padStart(width * 2, '0'), 'hex');
}

function toBufferLE(num, width) {
  return toBufferBE(num, width).reverse();
}

exports.toBigIntLE = toBigIntLE;
exports.toBigIntBE = toBigIntBE;
exports.toBufferLE = toBufferLE;
exports.toBufferBE = toBufferBE;
