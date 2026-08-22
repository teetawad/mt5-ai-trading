#!/usr/bin/env node
// Generates placeholder square PNG icons for the PWA manifest / apple-touch-icon
// (see apps/web/public/manifest.webmanifest and nuxt.config.ts app.head).
// Hand-rolled PNG encoder (signature + IHDR/IDAT/IEND chunks) so no image
// library dependency is needed for what is explicitly a placeholder - swap
// these files for real branded artwork before an App Store submission (see
// docs/MOBILE_IOS.md TestFlight checklist).
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

const OUT_DIR = join(import.meta.dirname, '..', 'public', 'icons');
const SIZES = [180, 192, 512];

// Emerald-on-slate, matching the app's existing brand accent (see
// apps/web/layouts/default.vue's "MT5" badge: emerald-400 on slate-950).
const BG = [2, 6, 23]; // slate-950
const FG = [52, 211, 153]; // emerald-400

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function pixelAt(x, y, size) {
  // A simple centered square badge: emerald square inset by ~22% on a dark
  // background - legible as a plain app icon shape at small sizes.
  const inset = Math.round(size * 0.22);
  const inFg = x >= inset && x < size - inset && y >= inset && y < size - inset;
  return inFg ? FG : BG;
}

function generatePng(size) {
  const rowBytes = size * 3;
  const raw = Buffer.alloc((rowBytes + 1) * size);
  for (let y = 0; y < size; y++) {
    const rowStart = y * (rowBytes + 1);
    raw[rowStart] = 0; // filter type: none
    for (let x = 0; x < size; x++) {
      const [r, g, b] = pixelAt(x, y, size);
      const px = rowStart + 1 + x * 3;
      raw[px] = r;
      raw[px + 1] = g;
      raw[px + 2] = b;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const path = join(OUT_DIR, `icon-${size}.png`);
  writeFileSync(path, generatePng(size));
  console.log(`[generate-pwa-icons] wrote ${path}`);
}
