#!/usr/bin/env node
/**
 * aggregate-busy.js — phronesis build script
 *
 * Reads (in this order, each optional and non-fatal if missing):
 *   1. D1 (remote) via `wrangler d1 execute skeptou-op --remote --json` —
 *      commitments (recurring + long_running, expanded via cadence), tasks
 *      with due_date, and projects with due_date.  Needs
 *      CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID in env (the deploy
 *      workflow injects these).  Skipped locally if absent.
 *   2. content/calendar-sync.md — committed in skeptou
 *      (modules/phronesis/content/) or synced from a vault by sync-vault.js.
 *      Markdown export from macOS Calendar.
 *   3. content/commitments.md — legacy markdown form. Same parser as before;
 *      only used as a fallback when D1 yields no commitments (e.g. before
 *      migration).
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

const fs           = require('fs');
const path         = require('path');
const { spawnSync } = require('child_process');

const ROOT        = path.resolve(__dirname, '..');
const CAL_PATH    = path.join(ROOT, 'content', 'calendar-sync.md');
const COMM_PATH   = path.join(ROOT, 'content', 'commitments.md');
const CONFIG_PATH = path.join(ROOT, 'config', 'event-types.yaml');
const OUT_PATH    = path.join(ROOT, 'src', 'data', 'busy-scores.json');
const WINDOW_DAYS  = 364; /* look back this many days for historical tasks */
const FORWARD_DAYS = 120; /* look forward this many days for calendar events */

/* ── Date window ─────────────────────────────────────────────────────────── */
/* Both past tasks (commitments.md) and future calendar events (calendar-sync.md)
 * should contribute to busy-scores.  calendar-sync.md exports today → +30 days,
 * so any upper bound ≥ 30 days forward is sufficient; 120 provides headroom for
 * further-out commitments.md tasks and future calendar-sync range expansions. */
const today    = new Date();
today.setHours(0, 0, 0, 0);
const windowStart = new Date(today);
windowStart.setDate(today.getDate() - WINDOW_DAYS);
const windowEnd = new Date(today);
windowEnd.setDate(today.getDate() + FORWARD_DAYS);

function inWindow(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d >= windowStart && d <= windowEnd;
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

/* ── Markdown calendar parser ────────────────────────────────────────────── */
/* Format: ## Section\n- YYYY-MM-DD (Day)  [HH:MM–HH:MM  ]Title            */
/* Section headings are ignored; type classification uses keyword inference.  */
function parseCalendarSync(raw) {
  const lines = raw.split('\n');
  for (const line of lines) {
    const m = /^-\s+(\d{4}-\d{2}-\d{2})\s+\([^)]+\)\s+(?:\d{1,2}:\d{2}[–\-]\d{1,2}:\d{2}\s+)?(.+)$/.exec(line.trim());
    if (!m) continue;
    const dateStr = m[1];
    const title   = m[2].trim();
    const type    = categorize({ title, categories: [] });
    addTypedScore(dateStr, type, 1);
  }
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

    /* Task line: - [ ] text, - [x] text, or - [/] (in-progress, treated as incomplete) */
    const taskMatch = /^-\s+\[([ x\/])\]\s+(.*)$/.exec(line);
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

/* ── D1 (remote) reader ──────────────────────────────────────────────────── */
/* Shells out to `wrangler d1 execute skeptou-op --remote --json`. Returns
 * an array of result rows, or null if D1 isn't reachable (missing
 * credentials, network error, schema mismatch). Caller treats null as
 * "skip, fall back to whatever other input we have". */
function d1Query(sql) {
  if (!process.env.CLOUDFLARE_API_TOKEN || !process.env.CLOUDFLARE_ACCOUNT_ID) {
    return null;
  }
  const proc = spawnSync('npx', [
    '--yes', 'wrangler@3', 'd1', 'execute', 'skeptou-op',
    '--remote', '--json', '--command', sql,
  ], { cwd: ROOT, encoding: 'utf8' });
  if (proc.status !== 0) {
    const firstLine = (proc.stderr || proc.stdout || '').split('\n').find(l => l.trim()) || '(no output)';
    console.warn('aggregate-busy: D1 query failed —', firstLine);
    return null;
  }
  try {
    const parsed = JSON.parse(proc.stdout);
    return (parsed[0] && parsed[0].results) || [];
  } catch (e) {
    console.warn('aggregate-busy: D1 JSON parse failed —', e.message);
    return null;
  }
}

/* ── Cadence expansion ───────────────────────────────────────────────────── */
const DOW_INDEX = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
};

/* Returns an array of YYYY-MM-DD date strings the commitment lands on
 * within the busy window. Supported cadence strings (case-insensitive):
 *   daily
 *   weekdays
 *   weekly:Mon            weekly:Mon,Wed,Fri
 *   biweekly:Tue
 *   monthly:15            (numeric day-of-month)
 * Anything else falls back to scoring start_date once. kind='long_running'
 * scores every day in the active window regardless of cadence. */
function expandCommitmentDates(comm) {
  const start = comm.start_date ? new Date(comm.start_date + 'T00:00:00') : null;
  const end   = comm.end_date   ? new Date(comm.end_date   + 'T00:00:00') : windowEnd;
  if (!start) return [];

  const clipStart = new Date(Math.max(start.getTime(), windowStart.getTime()));
  const clipEnd   = new Date(Math.min(end.getTime(),   windowEnd.getTime()));
  if (clipEnd < clipStart) return [];

  const isoDay = (d) => d.toISOString().slice(0, 10);
  const dates = [];

  if (comm.kind === 'long_running') {
    for (let d = new Date(clipStart); d <= clipEnd; d.setDate(d.getDate() + 1)) {
      dates.push(isoDay(d));
    }
    return dates;
  }

  const cad = (comm.cadence || '').trim().toLowerCase();
  if (!cad) {
    if (start >= windowStart && start <= windowEnd) dates.push(isoDay(start));
    return dates;
  }

  if (cad === 'daily') {
    for (let d = new Date(clipStart); d <= clipEnd; d.setDate(d.getDate() + 1)) {
      dates.push(isoDay(d));
    }
    return dates;
  }
  if (cad === 'weekdays') {
    for (let d = new Date(clipStart); d <= clipEnd; d.setDate(d.getDate() + 1)) {
      const dow = d.getDay();
      if (dow >= 1 && dow <= 5) dates.push(isoDay(d));
    }
    return dates;
  }

  const wm = /^(weekly|biweekly):(.+)$/.exec(cad);
  if (wm) {
    const interval = wm[1] === 'biweekly' ? 14 : 7;
    const dows = wm[2].split(',').map(s => DOW_INDEX[s.trim()]).filter(n => n !== undefined);
    for (const dow of dows) {
      const cursor = new Date(start);
      while (cursor.getDay() !== dow) cursor.setDate(cursor.getDate() + 1);
      while (cursor <= clipEnd) {
        if (cursor >= windowStart) dates.push(isoDay(cursor));
        cursor.setDate(cursor.getDate() + interval);
      }
    }
    return dates;
  }

  const mm = /^monthly:(\d{1,2})$/.exec(cad);
  if (mm) {
    const dom = parseInt(mm[1], 10);
    const cursor = new Date(clipStart.getFullYear(), clipStart.getMonth(), 1);
    while (cursor <= clipEnd) {
      const candidate = new Date(cursor.getFullYear(), cursor.getMonth(), dom);
      if (candidate >= start && candidate <= end
          && candidate >= windowStart && candidate <= windowEnd) {
        dates.push(isoDay(candidate));
      }
      cursor.setMonth(cursor.getMonth() + 1);
    }
    return dates;
  }

  /* Unknown cadence string — score the start date once and move on. */
  if (start >= windowStart && start <= windowEnd) dates.push(isoDay(start));
  return dates;
}

/* ── D1 ingest ───────────────────────────────────────────────────────────── */
/* Pulls active commitments, dated tasks, and dated projects from D1 and
 * adds them to the score grid. Returns the count of D1 entries scored
 * (so the caller knows whether D1 was the source).  */
function ingestFromD1() {
  const commitments = d1Query(
    "SELECT slug, title, kind, status, cadence, start_date, end_date FROM commitments "
    + "WHERE status IN ('active','paused')",
  );
  if (commitments === null) {
    console.warn('aggregate-busy: D1 unavailable — skipping commitments/tasks/projects');
    return 0;
  }

  let scored = 0;
  for (const c of commitments) {
    const type  = categorize({ title: c.title || '', categories: [] });
    const dates = expandCommitmentDates(c);
    for (const dateStr of dates) {
      addTypedScore(dateStr, type, 1);
      scored++;
    }
  }

  const tasks = d1Query(
    "SELECT slug, title, due_date, status, priority FROM tasks "
    + "WHERE due_date IS NOT NULL AND status NOT IN ('completed','cancelled')",
  ) || [];
  for (const t of tasks) {
    if (!t.due_date) continue;
    const type   = categorize({ title: t.title || '', categories: [] });
    const weight = t.priority === 1 ? 3
                 : t.priority === 2 ? 2
                 :                    1;
    if (inWindow(t.due_date)) {
      addTypedScore(t.due_date, type, weight);
      scored++;
    }
  }

  const projects = d1Query(
    "SELECT slug, title, due_date, area, status FROM projects "
    + "WHERE due_date IS NOT NULL AND status NOT IN ('archived','completed')",
  ) || [];
  for (const p of projects) {
    if (!p.due_date) continue;
    /* Project's area maps onto an event type when it lines up; otherwise
     * fall back to title-keyword categorization. */
    const type = (p.area && TYPE_KEYS.includes(p.area))
      ? p.area
      : categorize({ title: p.title || '', categories: [] });
    if (inWindow(p.due_date)) {
      addTypedScore(p.due_date, type, 2);
      scored++;
    }
  }

  console.log(`aggregate-busy: pulled ${commitments.length} commitments, `
    + `${tasks.length} dated tasks, ${projects.length} dated projects from D1; `
    + `wrote ${scored} day-scores`);
  return scored;
}

/* ── Main ────────────────────────────────────────────────────────────────── */
let parsed = 0;

const d1Scored = ingestFromD1();
if (d1Scored > 0) parsed++;

if (fs.existsSync(CAL_PATH)) {
  try {
    parseCalendarSync(fs.readFileSync(CAL_PATH, 'utf8'));
    console.log('aggregate-busy: parsed calendar-sync.md');
    parsed++;
  } catch (e) {
    console.error('aggregate-busy: calendar-sync.md parse error —', e.message);
  }
} else {
  console.warn('aggregate-busy: calendar-sync.md not found at', CAL_PATH, '— skipping');
}

/* commitments.md is now a legacy fallback: D1 is canonical. Only parse it
 * if D1 yielded nothing AND the markdown exists. */
if (d1Scored === 0 && fs.existsSync(COMM_PATH)) {
  try {
    parseCommitments(fs.readFileSync(COMM_PATH, 'utf8'));
    console.log('aggregate-busy: parsed commitments.md (D1 fallback)');
    parsed++;
  } catch (e) {
    console.error('aggregate-busy: commitments.md parse error —', e.message);
  }
} else if (d1Scored === 0) {
  console.warn('aggregate-busy: commitments.md not found at', COMM_PATH,
    '— and D1 yielded nothing — heatmap will be empty');
}

const maxTotal = Object.values(scores).reduce((m, v) => Math.max(m, v.total), 0);
const output = {
  generated:    new Date().toISOString(),
  window_days:  WINDOW_DAYS,
  forward_days: FORWARD_DAYS,
  types:        ALL_TYPES,
  scores,
  max_total:    maxTotal
};

fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
fs.writeFileSync(OUT_PATH, JSON.stringify(output, null, 2));
console.log(`aggregate-busy: wrote ${Object.keys(scores).length} scored dates → ${OUT_PATH}`);
if (parsed === 0) {
  console.warn('aggregate-busy: no input files found; output contains empty scores');
}
