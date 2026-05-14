#!/usr/bin/env node
/**
 * generate-viz.js — phronesis build script
 *
 * Reads:   src/data/busy-scores.json   (new per-type schema from aggregate-busy.js)
 * Writes:  src/data/heatmap.svg
 *          src/data/density.svg
 *
 * Heatmap: 52-week calendar grid; cell color = dominant event type for that day;
 *          cell opacity = day.total / max_total.
 * Density: stacked area chart; one band per type ordered by yearly total (desc);
 *          Mauve topline stroke.
 *
 * Design token hex values (single update point):
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT        = path.resolve(__dirname, '..');
const SCORES_IN   = path.join(ROOT, 'src', 'data', 'busy-scores.json');
const HEATMAP_OUT = path.join(ROOT, 'src', 'data', 'heatmap.svg');
const DENSITY_OUT = path.join(ROOT, 'src', 'data', 'density.svg');

/* Design token hex values */
const COLORS = {
  parchment:  '#fcf5e5',
  purple:     '#301934',
  mauve:      '#915f6d',
  wine:       '#722f37',
  quartz:     '#51414f',
  lightSteel: '#b0c4de',
  steel:      '#4682b4',
  coral:      '#f08080',
  neutral:    '#999999'
};

/* Type → color mapping (mirrors index.html EVENT_TYPES) */
const TYPE_COLORS = {
  teaching:  COLORS.steel,
  research:  COLORS.wine,
  fitness:   COLORS.mauve,
  admin:     COLORS.quartz,
  personal:  COLORS.lightSteel,
  travel:    COLORS.coral,
  deadlines: COLORS.purple,
  untyped:   COLORS.neutral
};

/* ── Load scores ─────────────────────────────────────────────────────────── */
if (!fs.existsSync(SCORES_IN)) {
  console.warn('generate-viz: busy-scores.json not found — writing empty SVGs');
}

const scoreData = fs.existsSync(SCORES_IN)
  ? JSON.parse(fs.readFileSync(SCORES_IN, 'utf8'))
  : { scores: {}, max_total: 0, types: Object.keys(TYPE_COLORS), window_days: 364 };

const scores   = scoreData.scores || {};
const maxTotal = scoreData.max_total || 1;
const TYPE_KEYS = scoreData.types
  ? scoreData.types.filter(t => t !== 'untyped')
  : Object.keys(TYPE_COLORS).filter(t => t !== 'untyped');
const ALL_TYPES = [...TYPE_KEYS, 'untyped'];

/* ── Helpers ─────────────────────────────────────────────────────────────── */
function dominantType(dayScores) {
  if (!dayScores || dayScores.total === 0) return null;
  let best = null, bestCount = 0;
  for (const t of ALL_TYPES) {
    const v = dayScores[t] || 0;
    if (v > bestCount) { bestCount = v; best = t; }
  }
  return best;
}

/* ── Heatmap SVG ─────────────────────────────────────────────────────────── */
/* 52 cols × 7 rows; 12px cells; 2px gap; month labels above; M/W/F row labels */
function buildHeatmap() {
  const CELL = 12, GAP = 2, STEP = CELL + GAP;
  const COLS = 52, ROWS = 7;
  const LEFT_MARGIN = 18, TOP_MARGIN = 22;
  const W = LEFT_MARGIN + COLS * STEP + 4;
  const H = TOP_MARGIN + ROWS * STEP + 4;

  const today = new Date();
  const startDate = new Date(today);
  startDate.setDate(startDate.getDate() - (364 + startDate.getDay()));
  startDate.setHours(0, 0, 0, 0);

  const cells      = [];
  const monthSeen  = {};
  const monthLabels = [];
  const DOW_LABELS  = [null, 'M', null, 'W', null, 'F', null];

  let d = new Date(startDate);

  for (let col = 0; col < COLS; col++) {
    for (let row = 0; row < ROWS; row++) {
      const key   = d.toISOString().slice(0, 10);
      const day   = scores[key];
      const total = day ? day.total : 0;
      const x     = LEFT_MARGIN + col * STEP;
      const y     = TOP_MARGIN + row * STEP;

      let fill, opacity;
      if (total === 0 || !day) {
        fill    = COLORS.parchment;
        opacity = 1;
      } else {
        const dom = dominantType(day);
        fill    = dom ? (TYPE_COLORS[dom] || COLORS.neutral) : COLORS.parchment;
        opacity = Math.max(0.12, total / maxTotal);
      }

      /* Tooltip: per-type breakdown */
      const tipParts = ALL_TYPES.filter(t => day && day[t] > 0)
        .map(t => `${t}: ${day[t]}`);
      const tip = tipParts.length ? `${key} — ${tipParts.join(', ')}` : key;

      cells.push(
        `<rect x="${x}" y="${y}" width="${CELL}" height="${CELL}" rx="1"`
        + ` fill="${fill}" fill-opacity="${opacity.toFixed(2)}">`
        + `<title>${tip}</title></rect>`
      );

      if (row === 0) {
        const monthKey = `${d.getFullYear()}-${d.getMonth()}`;
        if (!monthSeen[monthKey]) {
          monthSeen[monthKey] = true;
          const label = d.toLocaleDateString('en-US', { month: 'short' });
          monthLabels.push(
            `<text x="${x}" y="${TOP_MARGIN - 6}" font-size="8" fill="${COLORS.mauve}"`
            + ` font-family="Cinzel,serif" font-variant="small-caps">${label}</text>`
          );
        }
      }

      d.setDate(d.getDate() + 1);
    }
  }

  const dowSvg = DOW_LABELS.map((lbl, i) =>
    lbl
      ? `<text x="${LEFT_MARGIN - 4}" y="${TOP_MARGIN + i * STEP + CELL - 2}"`
        + ` text-anchor="end" font-size="8" fill="${COLORS.quartz}" font-family="Cinzel,serif">${lbl}</text>`
      : ''
  ).join('');

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"`
    + ` role="img" aria-label="Activity heatmap — 52-week calendar grid">`
    + monthLabels.join('') + dowSvg + cells.join('')
    + `</svg>`
  );
}

/* ── Density (stacked area) SVG ───────────────────────────────────────────── */
/* One band per type, ordered by yearly total descending (largest at bottom). */
/* Mauve stroke on topline.                                                    */
function buildDensity() {
  const W = 780, H = 140;
  const MARGIN_L = 12, MARGIN_R = 12, MARGIN_T = 20, MARGIN_B = 22;
  const chartW = W - MARGIN_L - MARGIN_R;
  const chartH = H - MARGIN_T - MARGIN_B;

  /* Build 52 weekly buckets */
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const startDate = new Date(today);
  startDate.setDate(startDate.getDate() - 364);

  const weeks = [];
  let d = new Date(startDate);

  for (let w = 0; w < 52; w++) {
    const weekData = {};
    for (const t of ALL_TYPES) weekData[t] = 0;
    let total = 0;
    const monthLabel = d.toLocaleDateString('en-US', { month: 'short' });

    for (let day = 0; day < 7; day++) {
      const key = d.toISOString().slice(0, 10);
      const ds  = scores[key];
      if (ds) {
        for (const t of ALL_TYPES) weekData[t] += ds[t] || 0;
        total += ds.total || 0;
      }
      d.setDate(d.getDate() + 1);
    }
    weekData.total = total;
    weeks.push({ weekData, monthLabel });
  }

  /* Sort types by yearly total descending; largest band at bottom */
  const yearlyTotals = {};
  for (const t of ALL_TYPES) {
    yearlyTotals[t] = weeks.reduce((sum, w) => sum + w.weekData[t], 0);
  }
  const stackOrder = [...ALL_TYPES].sort((a, b) => yearlyTotals[b] - yearlyTotals[a]);

  const maxWeek = Math.max(
    ...weeks.map(w => stackOrder.reduce((s, t) => s + w.weekData[t], 0)),
    1
  );

  const xFor = i  => MARGIN_L + (i / 51) * chartW;
  const yFor = v  => MARGIN_T + chartH - (v / maxWeek) * chartH;

  /* Stacked area paths */
  const paths = [];
  for (let ti = 0; ti < stackOrder.length; ti++) {
    const t = stackOrder[ti];
    if (yearlyTotals[t] === 0) continue; /* skip empty types */

    const upperPts = weeks.map((w, i) => {
      let cum = 0;
      for (let j = 0; j <= ti; j++) cum += w.weekData[stackOrder[j]];
      return `${xFor(i).toFixed(1)},${yFor(cum).toFixed(1)}`;
    });
    const lowerPts = weeks.map((w, i) => {
      let cum = 0;
      for (let j = 0; j < ti; j++) cum += w.weekData[stackOrder[j]];
      return `${xFor(i).toFixed(1)},${yFor(cum).toFixed(1)}`;
    });

    const areaPath = `M ${upperPts.join(' L ')} L ${[...lowerPts].reverse().join(' L ')} Z`;
    const color = TYPE_COLORS[t] || COLORS.neutral;
    paths.push(`<path d="${areaPath}" fill="${color}" fill-opacity="0.75" />`);
  }

  /* Topline: sum of all types with Mauve stroke */
  const topPts = weeks.map((w, i) => {
    const sum = stackOrder.reduce((s, t) => s + w.weekData[t], 0);
    return `${xFor(i).toFixed(1)},${yFor(sum).toFixed(1)}`;
  });
  const topLine = `<path d="M ${topPts.join(' L ')}" fill="none" stroke="${COLORS.mauve}" stroke-width="1.5" stroke-linejoin="round" />`;

  /* Month labels — first occurrence only */
  const seenMonths = {};
  const monthLabels = weeks.map((w, i) => {
    if (!seenMonths[w.monthLabel]) {
      seenMonths[w.monthLabel] = true;
      return `<text x="${xFor(i).toFixed(1)}" y="${H - 4}" font-size="8" fill="${COLORS.mauve}"`
        + ` font-family="Cinzel,serif" text-anchor="middle" font-variant="small-caps">${w.monthLabel}</text>`;
    }
    return '';
  }).join('');

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"`
    + ` role="img" aria-label="Activity density — stacked area chart over 52 weeks">`
    + paths.join('') + topLine + monthLabels
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
console.log(`generate-viz: max_total=${maxTotal}; ${Object.keys(scores).length} scored dates`);
