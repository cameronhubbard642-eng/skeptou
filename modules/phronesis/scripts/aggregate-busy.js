#!/usr/bin/env node
/**
 * aggregate-busy.js — phronesis build script
 *
 * Reads:
 *   content/calendar.ics    — iCloud calendar export (vault path: calendar/icloud-export.ics)
 *   content/commitments.md  — COMMITMENTS.md synced from O&P vault
 *   config/event-types.yaml — type definitions, colors, keywords
 *
 * Writes:
 *   src/data/busy-scores.json
 *
 * Output schema (per-type breakdown):
 *   {
 *     generated, window_days,
 *     types: ['teaching', 'research', ...],
 *     scores: {
 *       'YYYY-MM-DD': { teaching: N, research: N, ..., untyped: N, total: N }
 *     },
 *     max_total: N
 *   }
 *
 * Categorization source order (per spec):
 *   1. iCal CATEGORIES field — case-insensitive type name/label match
 *   2. Title prefix: [Teaching], [Research], etc.
 *   3. Keyword inference from title
 *   4. 'untyped' fallback
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT       = path.resolve(__dirname, '..');
const ICS_PATH   = path.join(ROOT, 'content', 'calendar.ics');
const COMM_PATH  = path.join(ROOT, 'content', 'commitments.md');
const CONFIG_PATH = path.join(ROOT, 'config', 'event-types.yaml');
const OUT_PATH   = path.join(ROOT, 'src', 'data', 'busy-scores.json');
const WINDOW_DAYS = 364;

/* ── Date window ─────────────────────────────────────────────────────────── */
const today    = new Date();
today.setHours(0, 0, 0, 0);
const windowStart = new Date(today);
windowStart.setDate(today.getDate() - WINDOW_DAYS);

function inWindow(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d >= windowStart && d <= today;
}

/* ── Load event-types config (minimal inline YAML parser) ───────────────── */
function loadEventTypes(yamlPath) {
  const raw   = fs.readFileSync(yamlPath, 'utf8');
  const lines = raw.split('\n');
  const types = {};
  let currentKey = null;
  let inKeywords = false;

  for (const line of lines) {
    /* Skip blank lines and comments */
    if (!line.trim() || line.trimStart().startsWith('#')) continue;

    /* Top-level "types:" sentinel */
    if (line === 'types:') continue;

    /* Type key — 2-space indent, word chars, ends with ':' */
    const typeMatch = /^  ([a-z][a-z0-9_]+):$/.exec(line);
    if (typeMatch) {
      currentKey = typeMatch[1];
      types[currentKey] = { keywords: [] };
      inKeywords = false;
      continue;
    }

    if (!currentKey) continue;

    /* 'keywords:' sentinel (4-space indent) */
    if (line === '    keywords:') {
      inKeywords = true;
      continue;
    }

    /* Keyword list item — 6-space indent, starts with '- ' */
    if (inKeywords) {
      const kwMatch = /^      - (.+)$/.exec(line);
      if (kwMatch) {
        types[currentKey].keywords.push(kwMatch[1].trim().toLowerCase());
        continue;
      }
      /* Non-keyword line at 4-space indent ends the keywords block */
      if (/^    \w/.test(line)) inKeywords = false;
    }

    /* Scalar field — 4-space indent: key: value */
    const fieldMatch = /^    ([a-z][a-zA-Z0-9_]+):\s*(.+)$/.exec(line);
    if (fieldMatch) {
      types[currentKey][fieldMatch[1]] = fieldMatch[2].trim().replace(/^["']|["']$/g, '');
    }
  }

  return types;
}

const EVENT_TYPES_CONFIG = fs.existsSync(CONFIG_PATH)
  ? loadEventTypes(CONFIG_PATH)
  : {};

/* Canonical ordered type list (UNTYPED always last) */
const TYPE_KEYS   = Object.keys(EVENT_TYPES_CONFIG);
const ALL_TYPES   = [...TYPE_KEYS, 'untyped'];

/* Lookup helpers */
const typeNamesLower = new Set(TYPE_KEYS.map(k => k.toLowerCase()));
const typeLabelsLower = Object.fromEntries(
  TYPE_KEYS.map(k => [(EVENT_TYPES_CONFIG[k].label || k).toLowerCase(), k])
);

function findTypeByName(str) {
  const s = str.toLowerCase().trim();
  if (typeNamesLower.has(s)) return s;
  return typeLabelsLower[s] || null;
}

/* ── categorize(event) ───────────────────────────────────────────────────── */
/* event = { title: string, categories: string[] }                            */
/* Returns one of: ALL_TYPES keys                                             */
function categorize(event) {
  const title      = (event.title || '').trim();
  const categories = event.categories || [];
  const cfg        = EVENT_TYPES_CONFIG;

  /* Step 1 — iCal CATEGORIES field */
  for (const cat of categories) {
    const key = findTypeByName(cat);
    if (key) return key;
  }

  /* Step 2 — Title prefix [Type] */
  const prefixMatch = /^\[([^\]]+)\]/.exec(title);
  if (prefixMatch) {
    const key = findTypeByName(prefixMatch[1]);
    if (key) return key;
  }

  /* Step 3 — Keyword inference (first match wins, order = type key order) */
  const titleLower = title.toLowerCase();
  for (const key of TYPE_KEYS) {
    for (const kw of (cfg[key].keywords || [])) {
      if (titleLower.includes(kw)) return key;
    }
  }

  /* Step 4 — Untyped fallback */
  return 'untyped';
}

/* ── Busy scores accumulator ─────────────────────────────────────────────── */
const scores = {};

function emptyDay() {
  const d = {};
  for (const t of ALL_TYPES) d[t] = 0;
  d.total = 0;
  return d;
}

function addTypedScore(dateStr, type, weight) {
  if (!dateStr || !inWindow(dateStr)) return;
  if (!scores[dateStr]) scores[dateStr] = emptyDay();
  scores[dateStr][type] = (scores[dateStr][type] || 0) + weight;
  scores[dateStr].total += weight;
}

/* ── iCal parser — minimal, no external deps ─────────────────────────────── */
/* Handles DTSTART as DATE (YYYYMMDD) or DATETIME (YYYYMMDDTHHmmssZ).        */
/* Handles VALUE=DATE property parameter.                                      */
/* Captures SUMMARY and CATEGORIES in addition to DTSTART.                    */
function parseICS(raw) {
  const lines = unfoldICS(raw);
  let inEvent    = false;
  let dtstart    = null;
  let summary    = null;
  let categories = [];

  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      inEvent    = true;
      dtstart    = null;
      summary    = null;
      categories = [];
      continue;
    }
    if (line === 'END:VEVENT') {
      if (inEvent && dtstart) {
        const type = categorize({ title: summary || '', categories });
        addTypedScore(dtstart, type, 1);
      }
      inEvent = false;
      continue;
    }
    if (!inEvent) continue;

    /* DTSTART with optional property params */
    const dtMatch = /^DTSTART(?:;[^:]+)?:(\d{8})/.exec(line);
    if (dtMatch) {
      const raw8 = dtMatch[1];
      dtstart = `${raw8.slice(0, 4)}-${raw8.slice(4, 6)}-${raw8.slice(6, 8)}`;
      continue;
    }

    /* SUMMARY */
    const sumMatch = /^SUMMARY(?:;[^:]+)?:(.*)$/.exec(line);
    if (sumMatch) {
      summary = sumMatch[1];
      continue;
    }

    /* CATEGORIES: comma-separated list */
    const catMatch = /^CATEGORIES(?:;[^:]+)?:(.*)$/.exec(line);
    if (catMatch) {
      categories = catMatch[1].split(',').map(s => s.trim()).filter(Boolean);
    }
  }
}

/* Unfold iCal line continuations (lines starting with space/tab) */
function unfoldICS(raw) {
  return raw
    .replace(/\r\n/g, '\n')
    .replace(/\n[ \t]/g, '')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);
}

/* ── COMMITMENTS.md parser ───────────────────────────────────────────────── */
/* Format: markdown with date headings (## YYYY-MM-DD or ## [[YYYY-MM-DD]])  */
/* and task lines: - [ ] task text [priority emoji]                           */
/* Applies keyword inference for type (no CATEGORIES / prefix available).     */
function parseCommitments(raw) {
  const lines = raw.split('\n');
  let currentDate = null;

  for (const line of lines) {
    /* Date heading: ## 2026-05-12 or ## [[2026-05-12]] */
    const headMatch = /^#{1,4}\s+\[?\[?(\d{4}-\d{2}-\d{2})\]?\]?/.exec(line);
    if (headMatch) {
      currentDate = headMatch[1];
      continue;
    }

    /* Task line: - [ ] text or - [x] text */
    const taskMatch = /^-\s+\[( |x)\]\s+(.*)$/.exec(line);
    if (!taskMatch) continue;

    const done = taskMatch[1] === 'x';
    if (done) continue; /* Completed tasks don't contribute */

    const text   = taskMatch[2];
    const weight = priorityWeight(text);

    /* Extract inline date override: YYYY-MM-DD anywhere in the task text */
    const inlineDateMatch = /\[?\[?(\d{4}-\d{2}-\d{2})\]?\]?/.exec(text);
    const dateStr = inlineDateMatch ? inlineDateMatch[1] : currentDate;

    if (dateStr) {
      const type = categorize({ title: text, categories: [] });
      addTypedScore(dateStr, type, weight);
    }
  }
}

function priorityWeight(text) {
  if (text.includes('🔺')) return 3;
  if (text.includes('⏫')) return 2;
  if (text.includes('🔼')) return 1;
  return 1;
}

/* ── Main ────────────────────────────────────────────────────────────────── */
let parsed = 0;

if (fs.existsSync(ICS_PATH)) {
  try {
    parseICS(fs.readFileSync(ICS_PATH, 'utf8'));
    console.log('aggregate-busy: parsed calendar.ics');
    parsed++;
  } catch (e) {
    console.error('aggregate-busy: calendar.ics parse error —', e.message);
  }
} else {
  console.warn('aggregate-busy: calendar.ics not found at', ICS_PATH, '— skipping');
}

if (fs.existsSync(COMM_PATH)) {
  try {
    parseCommitments(fs.readFileSync(COMM_PATH, 'utf8'));
    console.log('aggregate-busy: parsed commitments.md');
    parsed++;
  } catch (e) {
    console.error('aggregate-busy: commitments.md parse error —', e.message);
  }
} else {
  console.warn('aggregate-busy: commitments.md not found at', COMM_PATH, '— skipping');
}

const maxTotal = Object.values(scores).reduce((m, v) => Math.max(m, v.total), 0);
const output = {
  generated:   new Date().toISOString(),
  window_days: WINDOW_DAYS,
  types:       ALL_TYPES,
  scores,
  max_total:   maxTotal
};

fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
fs.writeFileSync(OUT_PATH, JSON.stringify(output, null, 2));
console.log(`aggregate-busy: wrote ${Object.keys(scores).length} scored dates → ${OUT_PATH}`);
if (parsed === 0) {
  console.warn('aggregate-busy: no input files found; output contains empty scores');
}
