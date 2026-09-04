#!/usr/bin/env node
// Generates the extension's toolbar icons as real PNGs.
//
// Written by hand rather than pulled from a dependency because the alternative
// is either an image library we do not otherwise need, or a manifest that
// references files which do not exist - and Chrome refuses to load an extension
// whose declared icons are missing.
//
// Colours are Duel's own (dark-800 ground, blue-600 mark) so the toolbar button
// reads as part of the same product.

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../src/collector/extension/icons');

const GROUND = [0x0c, 0x10, 0x2b]; // dark-800
const MARK = [0x45, 0x58, 0xff]; // blue-600
const MARK_DIM = [0x76, 0x5d, 0xc5]; // purple-600, for the trailing dot

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/**
 * The mark is a magnifying-lens ring with a sight dot: "scout", not "bet".
 * Drawn analytically per pixel so it stays crisp at 16px without any scaling.
 */
function pixel(x, y, size) {
  const cx = size * 0.44;
  const cy = size * 0.44;
  const r = size * 0.27;
  const thickness = Math.max(1, size * 0.1);
  const d = Math.hypot(x - cx, y - cy);

  // Lens ring.
  if (Math.abs(d - r) <= thickness / 2) return MARK;
  // Sight dot at the centre.
  if (d <= size * 0.08) return MARK;
  // Handle running down-right from the ring.
  const hx = x - (cx + r * 0.72);
  const hy = y - (cy + r * 0.72);
  if (hx > -thickness && hy > -thickness && Math.abs(hx - hy) <= thickness / 2 && hx < size * 0.28) {
    return MARK_DIM;
  }
  return GROUND;
}

function png(size) {
  const raw = Buffer.alloc(size * (size * 3 + 1));
  let p = 0;
  for (let y = 0; y < size; y++) {
    raw[p++] = 0; // filter type 0 (None)
    for (let x = 0; x < size; x++) {
      const [r, g, b] = pixel(x + 0.5, y + 0.5, size);
      raw[p++] = r;
      raw[p++] = g;
      raw[p++] = b;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type 2 = truecolour RGB
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const file = resolve(OUT, `icon${size}.png`);
  writeFileSync(file, png(size));
  console.log(`wrote ${file}`);
}
