#!/usr/bin/env node
/**
 * generate-icons.js — phronesis build script
 *
 * Generates PWA icons: icon-192.png and icon-512.png
 * Design: Parchment (#fcf5e5) background, Cinzel "φ" glyph in Purple (#301934).
 *
 * Writes SVG → static/icons/ directly (SVG icons suffice for modern browsers).
 * PNG conversion requires sharp or canvas; falls back to SVG if unavailable.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT    = path.resolve(__dirname, '..');
const ICONS_DIR = path.join(ROOT, 'static', 'icons');

fs.mkdirSync(ICONS_DIR, { recursive: true });

/* ── SVG icon template ── */
function iconSVG(size) {
  const fontSize = Math.round(size * 0.55);
  const center   = size / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" fill="#fcf5e5"/>
  <text x="${center}" y="${center + fontSize * 0.35}" text-anchor="middle"
    font-family="Cinzel, 'Palatino Linotype', Palatino, serif"
    font-size="${fontSize}"
    fill="#301934"
    font-weight="400">φ</text>
</svg>`;
}

/* Write SVG versions (immediately deployable; no native deps) */
fs.writeFileSync(path.join(ICONS_DIR, 'icon-192.svg'), iconSVG(192));
fs.writeFileSync(path.join(ICONS_DIR, 'icon-512.svg'), iconSVG(512));
console.log('generate-icons: wrote SVG icons (192, 512)');

/* ── Attempt PNG conversion via sharp ── */
let sharp;
try {
  sharp = require('sharp');
} catch (_) {
  /* sharp not installed; SVG icons written above are sufficient for most browsers */
  console.log('generate-icons: sharp not available — PNG icons skipped; SVG icons ready');
  process.exit(0);
}

(async () => {
  for (const size of [192, 512]) {
    const svgBuf = Buffer.from(iconSVG(size));
    const outPath = path.join(ICONS_DIR, `icon-${size}.png`);
    await sharp(svgBuf).png().toFile(outPath);
    console.log(`generate-icons: wrote icon-${size}.png`);
  }
})().catch(e => {
  console.error('generate-icons: PNG error —', e.message);
  process.exit(0); /* Non-fatal; SVG icons still present */
});
