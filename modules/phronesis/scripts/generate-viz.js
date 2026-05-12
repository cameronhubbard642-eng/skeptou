#!/usr/bin/env node
/**
 * generate-viz.js — phronesis build script
 *
 * Reads:   src/data/busy-scores.json
 * Writes:  src/data/heatmap.svg
 *          src/data/density.svg
 *
 * Both SVGs use design-token hex values directly (inline SVG; no CSS vars).
 * The generated files are injected into index.html at build time or served
 * statically. For baseline, the SPA renders these client-side; CI replaces
 * the embedded JS data with injected SVG files.
 *
 * Design token hex values (single update point per spec §VIII.2):
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT       = path.resolve(__dirname, '..');
const SCORES_IN  = path.join(ROOT, 'src', 'data', 'busy-scores.json');
const HEATMAP_OUT = path.join(ROOT, 'src', 'data', 'heatmap.svg');
const DENSITY_OUT = path.join(ROOT, 'src', 'data', 'density.svg');

/* Design token hex values — update here if tokens change */
const COLORS = {
  parchment:  '#fcf5e5',
  purple:     '#301934',
  mauve:      '#915f6d',
  wine:       '#722f37',
  quartz:     '#51414f',
  lightSteel: '#b0c4de',
  steel:      '#4682b4'
};

/* Heatmap color scale: 4 stops at 0%, 25%, 50%, 75%+ of max_score */
const HEAT_SCALE = [COLORS.parchment, COLORS.lightSteel, COLORS.steel, COLORS.purple];

/* ── Load scores ─────────────────────────────────────────────────────────── */
if (!fs.existsSync(SCORES_IN)) {
  console.warn('generate-viz: busy-scores.json not found — writing empty SVGs');
}

const scoreData = fs.existsSync(SCORES_IN)
  ? JSON.parse(fs.readFileSync(SCORES_IN, 'utf8'))
  : { scores: {}, max_score: 0, window_days: 364 };

const scores   = scoreData.scores || {};
const maxScore = scoreData.max_score || 1;

function colorFor(score) {
  if (!score || score === 0) return HEAT_SCALE[0];
  const ratio = score / maxScore;
  if (ratio < 0.25) return HEAT_SCALE[0];
  if (ratio < 0.50) return HEAT_SCALE[1];
  if (ratio < 0.75) return HEAT_SCALE[2];
  return HEAT_SCALE[3];
}

/* ── Heatmap SVG ─────────────────────────────────────────────────────────── */
/* 52 cols × 7 rows; 12px cells; 2px gap; month labels; M/W/F row labels     */
function buildHeatmap() {
  const CELL = 12, GAP = 2, STEP = CELL + GAP;
  const COLS = 52, ROWS = 7;
  const LEFT_MARGIN = 18, TOP_MARGIN = 22;
  const W = LEFT_MARGIN + COLS * STEP + 4;
  const H = TOP_MARGIN + ROWS * STEP + 4;

  const today = new Date();
  const startDate = new Date(today);
  /* Align start to Sunday 52 weeks back */
  startDate.setDate(startDate.getDate() - (364 + startDate.getDay()));
  startDate.setHours(0, 0, 0, 0);

  const cells = [];
  const monthSeen = {};
  const monthLabels = [];
  const DOW_LABELS = [null, 'M', null, 'W', null, 'F', null];

  let d = new Date(startDate);

  for (let col = 0; col < COLS; col++) {
    for (let row = 0; row < ROWS; row++) {
      const key   = d.toISOString().slice(0, 10);
      const score = scores[key] || 0;
      const x     = LEFT_MARGIN + col * STEP;
      const y     = TOP_MARGIN + row * STEP;

      cells.push(
        `<rect x="${x}" y="${y}" width="${CELL}" height="${CELL}" rx="1" fill="${colorFor(score)}">`
        + `<title>${key} — Score: ${score}</title></rect>`
      );

      /* Month label on row=0, first occurrence of month */
      if (row === 0) {
        const monthKey = `${d.getFullYear()}-${d.getMonth()}`;
        if (!monthSeen[monthKey]) {
          monthSeen[monthKey] = true;
          const label = d.toLocaleDateString('en-US', { month: 'short' });
          monthLabels.push(`<text x="${x}" y="${TOP_MARGIN - 6}" font-size="8" fill="${COLORS.mauve}" font-family="Cinzel,serif" font-variant="small-caps">${label}</text>`);
        }
      }

      d.setDate(d.getDate() + 1);
    }
  }

  const dowSvg = DOW_LABELS.map((lbl, i) =>
    lbl
      ? `<text x="${LEFT_MARGIN - 4}" y="${TOP_MARGIN + i * STEP + CELL - 2}" text-anchor="end" font-size="8" fill="${COLORS.quartz}" font-family="Cinzel,serif">${lbl}</text>`
      : ''
  ).join('');

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Activity heatmap — 52-week calendar grid">`
    + monthLabels.join('')
    + dowSvg
    + cells.join('')
    + `</svg>`
  );
}

/* ── Density gradient SVG ─────────────────────────────────────────────────── */
/* Area chart; weekly aggregation; Steel fill 25% opacity; Mauve stroke 1.5px */
function buildDensity() {
  const W = 780, H = 140;
  const MARGIN_L = 12, MARGIN_R = 12, MARGIN_T = 20, MARGIN_B = 22;
  const chartW = W - MARGIN_L - MARGIN_R;
  const chartH = H - MARGIN_T - MARGIN_B;

  /* Build 52 weekly buckets from 52 weeks ago */
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const startDate = new Date(today);
  startDate.setDate(startDate.getDate() - 364);

  const weeks = [];
  let d = new Date(startDate);

  for (let w = 0; w < 52; w++) {
    let sum = 0;
    const monthLabel = d.toLocaleDateString('en-US', { month: 'short' });
    for (let day = 0; day < 7; day++) {
      const key = d.toISOString().slice(0, 10);
      sum += scores[key] || 0;
      d.setDate(d.getDate() + 1);
    }
    weeks.push({ sum, monthLabel });
  }

  const maxWeek = Math.max(...weeks.map(w => w.sum), 1);

  const xFor = i => MARGIN_L + (i / 51) * chartW;
  const yFor = v => MARGIN_T + chartH - (v / maxWeek) * chartH;

  const pts = weeks.map((w, i) => `${xFor(i).toFixed(1)},${yFor(w.sum).toFixed(1)}`);
  const areaPath = `M ${xFor(0).toFixed(1)},${(MARGIN_T + chartH).toFixed(1)} L ${pts.join(' L ')} L ${xFor(51).toFixed(1)},${(MARGIN_T + chartH).toFixed(1)} Z`;
  const linePath = `M ${pts.join(' L ')}`;

  /* Month labels — first occurrence only */
  const seenMonths = {};
  const monthLabels = weeks.map((w, i) => {
    if (!seenMonths[w.monthLabel]) {
      seenMonths[w.monthLabel] = true;
      return `<text x="${xFor(i).toFixed(1)}" y="${H - 4}" font-size="8" fill="${COLORS.mauve}" font-family="Cinzel,serif" text-anchor="middle" font-variant="small-caps">${w.monthLabel}</text>`;
    }
    return '';
  }).join('');

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Activity density — area chart over 52 weeks">`
    + `<path d="${areaPath}" fill="${COLORS.steel}" fill-opacity="0.25" />`
    + `<path d="${linePath}" fill="none" stroke="${COLORS.mauve}" stroke-width="1.5" stroke-linejoin="round" />`
    + monthLabels
    + `</svg>`
  );
}

/* ── Write output ────────────────────────────────────────────────────────── */
fs.mkdirSync(path.dirname(HEATMAP_OUT), { recursive: true });

const heatmapSVG = buildHeatmap();
const densitySVG = buildDensity();

fs.writeFileSync(HEATMAP_OUT, heatmapSVG);
fs.writeFileSync(DENSITY_OUT, densitySVG);

console.log('generate-viz: wrote heatmap.svg');
console.log('generate-viz: wrote density.svg');
console.log(`generate-viz: max_score=${maxScore}; ${Object.keys(scores).length} scored dates`);
