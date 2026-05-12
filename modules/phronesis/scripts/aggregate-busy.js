#!/usr/bin/env node
/**
 * aggregate-busy.js — phronesis build script
 *
 * Reads:
 *   content/calendar.ics    — iCloud calendar export (vault path: calendar/icloud-export.ics)
 *   content/commitments.md  — COMMITMENTS.md synced from O&P vault
 *
 * Writes:
 *   src/data/busy-scores.json
 *
 * Algorithm per spec §VIII.1:
 *   - Each calendar VEVENT on a date: weight 1
 *   - Each undone commitment task: weight by priority emoji (🔺=3, ⏫=2, 🔼=1, none=1)
 *   - Rolling 52-week window from build date
 *   - Dates outside window or with score=0 are omitted
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT       = path.resolve(__dirname, '..');
const ICS_PATH   = path.join(ROOT, 'content', 'calendar.ics');
const COMM_PATH  = path.join(ROOT, 'content', 'commitments.md');
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

/* ── Busy scores accumulator ─────────────────────────────────────────────── */
const scores = {};

function addScore(dateStr, weight) {
  if (!dateStr || !inWindow(dateStr)) return;
  scores[dateStr] = (scores[dateStr] || 0) + weight;
}

/* ── iCal parser — minimal, no external deps ─────────────────────────────── */
/* Handles DTSTART as DATE (YYYYMMDD) or DATETIME (YYYYMMDDTHHmmssZ).        */
/* Handles VALUE=DATE property parameter.                                      */
function parseICS(raw) {
  const lines = unfoldICS(raw);
  let inEvent = false;
  let dtstart  = null;

  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      inEvent = true;
      dtstart  = null;
      continue;
    }
    if (line === 'END:VEVENT') {
      if (inEvent && dtstart) {
        addScore(dtstart, 1);
      }
      inEvent = false;
      continue;
    }
    if (!inEvent) continue;

    /* Match DTSTART with optional property params */
    const dtMatch = /^DTSTART(?:;[^:]+)?:(\d{8})/.exec(line);
    if (dtMatch) {
      const raw8 = dtMatch[1];
      dtstart = `${raw8.slice(0, 4)}-${raw8.slice(4, 6)}-${raw8.slice(6, 8)}`;
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

    if (dateStr) addScore(dateStr, weight);
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

const maxScore = Object.values(scores).reduce((m, v) => Math.max(m, v), 0);
const output = {
  generated:   new Date().toISOString(),
  window_days: WINDOW_DAYS,
  scores,
  max_score:   maxScore
};

fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
fs.writeFileSync(OUT_PATH, JSON.stringify(output, null, 2));
console.log(`aggregate-busy: wrote ${Object.keys(scores).length} scored dates → ${OUT_PATH}`);
if (parsed === 0) {
  console.warn('aggregate-busy: no input files found; output contains empty scores');
}
