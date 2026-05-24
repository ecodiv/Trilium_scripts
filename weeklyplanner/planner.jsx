/**
 * Task Planner — TriliumNext (Preact)
 *
 * A weekly board (Backlog + day columns) built from line-prefixed tasks found
 * across all text notes. Recognised prefixes: TODO, IDEA, CHECK, TOREAD, DEFER
 * (case-sensitive, at the start of a line/block, followed by a space). See the
 * separate user manual for end-user features (@date, #tag, ~recurrence, etc.).
 *
 * ARCHITECTURE NOTES FOR MAINTAINERS
 *   - Runs as a render-note widget; `api` is Trilium's FrontendScriptApi.
 *   - Two JSON child notes are auto-created under this note on first load:
 *       #plannerdata    UI state — day assignments, _order, _progress,
 *                       _filters, _viewMode, _backlogWidth.
 *       #plannerConfig  scan scope — { mode: 'include'|'exclude', subtrees }.
 *     They are JSON code notes so the rich-text editor can't mangle them.
 *   - All DB access goes through runOnBackend; those callbacks are serialised
 *     and run on the backend, so each must be SELF-CONTAINED (no closure over
 *     module-scope helpers). This is why some scan logic is intentionally
 *     duplicated between fetchAllTasks and fetchTasksForNote.
 *   - Mark-done rewrites the source line to a greyed DONE span; the colour
 *     (THEME_DEFAULTS.colorDoneText) is written into note content and so must
 *     stay a literal, never a CSS variable.
 *   - Task ids are derived from note + kind + slug and are used as #plannerdata
 *     keys, so they must stay stable across edits (see flattenGroups).
 *   - Theme follows the active Trilium theme via CSS variables; every neutral
 *     token can be overridden per-install by a #wp_* label on #plannerdata
 *     (see THEME_DEFAULTS / loadPlannerData). Accent colours are fixed literals.
 */

import { useEffect, useRef, useState, useCallback, useMemo } from "trilium:preact";
import { runOnBackend, runAsyncOnBackendWithManualTransactionHandling, activateNote } from "trilium:api";

/* ── CONSTANTS — kinds, colors, dimensions ─────────────────────── */

const KINDS = {
    TODO:   { label: 'TODO',   color: '#ed7a2a' },
    IDEA:   { label: 'IDEA',   color: '#348cbb' },
    CHECK:  { label: 'CHECK',  color: '#42ae2e' },
    TOREAD: { label: 'TOREAD', color: '#9d4edd' },
    DEFER:  { label: 'DEFER',  color: '#589393' },
};
const KIND_KEYS = Object.keys(KINDS);
const KIND_RE_SOURCE = `(?:${KIND_KEYS.join('|')})`;

/* Whitelist a label-provided CSS color so a #wp_* override can't break out of
   the CSS value context (no ; { } < > " ' / etc.) and can't smuggle url()/
   expression() for exfiltration. Anything unrecognised falls back to default.
   Accepts: hex (3/4/6/8), a bare named color, rgb/hsl(a)(...), var(--x[, #hex]). */
function safeCssColor(value, fallback) {
    const s = String(value == null ? '' : value).trim();
    if (/^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(s)) return s;
    if (/^[a-zA-Z]+$/.test(s)) return s;                                  // named color
    if (/^(?:rgb|rgba|hsl|hsla)\([0-9.,%/\s]+\)$/.test(s)) return s;
    if (/^var\(\s*--[\w-]+\s*(?:,\s*#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8}))?\s*\)$/.test(s)) return s;
    return fallback;
}

/* Stricter: colors written into source-note HTML attributes must be bare hex,
   so they can never break out of the style="" attribute. */
function safeHexColor(value, fallback) {
    const s = String(value == null ? '' : value).trim();
    return /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(s) ? s : fallback;
}

/* Per-kind color overrides from #wp_* labels on #plannerdata (see header).
   Kind colors only ever reach Preact style objects, but validate anyway. */
function getKindColor(kind, overrides) {
    const fallback = KINDS[kind]?.color || '#666';
    if (overrides && overrides[kind]) return safeCssColor(overrides[kind], fallback);
    return fallback;
}

/* Neutral tokens default to Trilium's theme CSS variables (with a light-value
   fallback) and can be overridden per-install via #wp_* labels — see
   themeLabelMap in loadPlannerData. Accent tokens are fixed literals. */
const THEME_DEFAULTS = {
    bgRoot:     'var(--main-background-color, #fff)',           // root, header, buttons, inputs, dialogs
    bgPanel:    'var(--accented-background-color, #fafafa)',    // columns / panels
    bgTask:     'var(--more-accented-background-color, #f3f3f3)', // task cards
    bgHover:    'var(--hover-item-background-color, #eee)',     // button / row hover
    bgActive:   'var(--active-item-background-color, #444)',    // selected toggle segment
    textActive: 'var(--active-item-text-color, #fff)',         // text on selected segment
    text:       'var(--main-text-color, #333)',                // primary text
    textMuted:  'var(--muted-text-color, #666)',               // labels, subtitles, muted buttons
    border:     'var(--main-border-color, #d0d0d0)',           // borders / separators

    colorDoneText:  '#cfcfcf',                          // grey written into source notes (must stay literal)
    colorDoneBtn:   '#79a574',                          // mark-done button color
    colorDateTag:   'var(--muted-text-color, #a8a8a8)', // inline @date token color
    colorProgress:  '#79a574',                          // progress-bar fill
};

/* Merge defaults with label overrides, validating each override against the
   CSS value context. colorDoneText is written into source-note HTML, so it
   gets the stricter hex-only check; everything else allows any safe CSS color.
   Unset keys keep their trusted literal default. */
function resolveTheme(overrides) {
    const o = overrides || {};
    const out = {};
    for (const key in THEME_DEFAULTS) {
        const fallback = THEME_DEFAULTS[key];
        if (!(key in o)) { out[key] = fallback; continue; }
        out[key] = key === 'colorDoneText'
            ? safeHexColor(o[key], fallback)
            : safeCssColor(o[key], fallback);
    }
    return out;
}

const BACKLOG_WIDTH_DEFAULT = 260;
const BACKLOG_WIDTH_MIN     = 150;
const BACKLOG_WIDTH_MAX     = 600;

/* Scan archived notes by default; override with #wp_scan_archived on #plannerdata. */
const SCAN_ARCHIVED_DEFAULT = true;

const WEEKDAY_ALIASES = {
    mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 0,
};

/* ── PARSING HELPERS — @date suffix and #tag extraction ────────── */

/* Timezone-safe local-date formatter.
   `d.toISOString()` converts to UTC, which silently shifts the date by ±1
   when the user's offset crosses midnight. Use local Y/M/D to get the
   actual calendar day the user sees. */
function toLocalIsoDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

/* Returns 'YYYY-MM-DD' | null for a token like 'today', 'mon', '2026-05-20' */
function tokenToIsoDate(token, baseDate) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(token)) return token;
    if (token === 'today')    return toLocalIsoDate(baseDate);
    if (token === 'tomorrow') {
        const d = new Date(baseDate);
        d.setDate(baseDate.getDate() + 1);
        return toLocalIsoDate(d);
    }
    if (token in WEEKDAY_ALIASES) {
        const target = WEEKDAY_ALIASES[token];
        const now    = baseDate.getDay();
        let delta = target - now;
        if (delta < 0) delta += 7;
        const d = new Date(baseDate);
        d.setDate(baseDate.getDate() + delta);
        return toLocalIsoDate(d);
    }
    return null;
}

/* Extracts @date and #tags from raw task text.
   Returns { isoDate, tags } where:
     isoDate = null or 'YYYY-MM-DD'
     tags    = string[] of lowercase tag names (without #)*/
function parseTaskMeta(rawText) {
    const tags = [];
    const tagRe = /#([a-zA-Z][\w-]*)/g;
    let m;
    while ((m = tagRe.exec(rawText)) !== null) tags.push(m[1].toLowerCase());

    // @date: anywhere in the text, surrounded by whitespace or ends.
    const dateMatch = rawText.match(/(^|\s)@(\S+)(?=\s|$)/);
    if (dateMatch) {
        const iso = tokenToIsoDate(dateMatch[2].toLowerCase(), todayBase());
        if (iso) return { isoDate: iso, tags };
    }
    return { isoDate: null, tags };
}

/* Inline recurrence token `~<n><unit>` (unit d|w), e.g. ~7d, ~2w. Same bounding
   rule as @date; only the first token on a line counts. Returns { token, n, unit }
   or null for a one-off. Weeks are n×7 days; for monthly cadence use weeks. */
function parseInterval(rawText) {
    const m = rawText.match(/(^|\s)~(\d+)([dw])(?=\s|$)/);
    if (!m) return null;
    const n = parseInt(m[2], 10);
    if (!Number.isFinite(n) || n < 1) return null;   // ~0d etc. is not recurring
    const unit = m[3];
    return { token: `${n}${unit}`, n, unit };
}

/* Advance an ISO date by an interval (w = n×7 days), in local time. */
function addIntervalToIso(iso, interval) {
    const [y, mo, d] = iso.split('-').map(Number);
    const date = new Date(y, mo - 1, d);   // local midnight, no UTC shift
    const days = interval.unit === 'w' ? interval.n * 7 : interval.n;
    date.setDate(date.getDate() + days);
    return toLocalIsoDate(date);
}

/* Next due date for a recurring task on completion. Steps along the task's
   own cadence grid (dueIso + k·interval) to the first slot after today, so an
   overdue task skips missed slots without piling up and never lands in the
   past. With no stored due date, the completion day anchors the grid. Always
   advances at least once. The guard caps a degenerate interval, not normal use. */
function nextRecurDate(dueIso, interval, todayIso) {
    let next = addIntervalToIso(dueIso || todayIso, interval);
    let guard = 0;
    while (next <= todayIso && guard++ < 10000) {
        next = addIntervalToIso(next, interval);
    }
    return next;
}

/* Human-readable cadence for the recurring glyph's tooltip, e.g.
   "Repeats every 7 days", "Repeats every week", "Repeats every 2 weeks". */
function recurCadenceLabel(interval) {
    const word = interval.unit === 'w' ? 'week' : 'day';
    return interval.n === 1
        ? `Repeats every ${word}`
        : `Repeats every ${interval.n} ${word}s`;
}

/* ── BACKEND HELPERS ───────────────────────────────────────────── */

async function loadPlannerData() {
    return await runOnBackend((defaultScanArchived) => {
        const note = api.getNoteWithLabel('plannerdata');
        if (!note) {
            return {
                data: {},
                labelWidth: null,
                colorOverrides: {},
                themeOverrides: {},
                scanArchived: defaultScanArchived,
            };
        }

        const labelStr = (name) => {
            const v = note.getLabelValue(name);
            return (v != null && String(v).trim()) ? String(v).trim() : null;
        };

        // #wp_backlog_width → number of pixels
        let labelWidth = null;
        const widthLabel = labelStr('wp_backlog_width');
        if (widthLabel) {
            const n = parseInt(widthLabel, 10);
            if (!isNaN(n) && n > 0) labelWidth = n;
        }

        // #wp_scan_archived → explicit override of SCAN_ARCHIVED_DEFAULT.
        let scanArchived = defaultScanArchived;
        const scanLabel = labelStr('wp_scan_archived');
        if (scanLabel != null) {
            const v = scanLabel.toLowerCase();
            if (/^(false|no|0|off)$/.test(v))      scanArchived = false;
            else if (/^(true|yes|1|on)$/.test(v))  scanArchived = true;
        }

        // Per-kind color overrides:
        const kindLabelMap = {
            TODO:   'wp_todo',
            IDEA:   'wp_idea',
            CHECK:  'wp_check',
            TOREAD: 'wp_toread',
            DEFER:  'wp_defer',
        };
        const colorOverrides = {};
        for (const kind in kindLabelMap) {
            const val = labelStr(kindLabelMap[kind]);
            if (val) colorOverrides[kind] = val;
        }

        // Theme overrides — any CSS color string per #wp_* label (see header).
        const themeLabelMap = {
            bgRoot:         'wp_bg_root',
            bgPanel:        'wp_bg_panel',
            bgTask:         'wp_bg_task',
            bgHover:        'wp_bg_hover',
            text:           'wp_color_text',
            textMuted:      'wp_color_muted',
            border:         'wp_border',
            colorDoneText:  'wp_color_done_text',
            colorDoneBtn:   'wp_color_done_btn',
            colorDateTag:   'wp_color_date_tag',
            colorProgress:  'wp_color_progress',
        };
        const themeOverrides = {};
        for (const key in themeLabelMap) {
            const val = labelStr(themeLabelMap[key]);
            if (val) themeOverrides[key] = val;
        }

        // Note content holds the JSON planner state.
        let data = {};
        try {
            const raw = note.getContent();
            if (raw) data = JSON.parse(raw);
        } catch (_) { /* corrupt JSON → start fresh */ }

        return { data, labelWidth, colorOverrides, themeOverrides, scanArchived };
    }, [SCAN_ARCHIVED_DEFAULT]);
}

async function savePlannerData(plannerData) {
    const data = JSON.stringify(plannerData, null, 2);
    await runAsyncOnBackendWithManualTransactionHandling(async (jsonData) => {
        const note = api.getNoteWithLabel('plannerdata');
        if (!note) throw new Error('#plannerdata note not found');
        note.setContent(jsonData);
        await note.save();
    }, [data]);
}

/* Ensure the #plannerdata state note exists. If missing, create it as a
   JSON code note (type:'code', mime:'application/json') under parentNoteId,
   seeded with '{}'. Returns { created, noteId }. Idempotent. */
async function ensurePlannerNote(parentNoteId) {
    return await runAsyncOnBackendWithManualTransactionHandling(
        async (parentId) => {
            let note = api.getNoteWithLabel('plannerdata');
            if (note) return { created: false, noteId: note.noteId };

            const created = await api.createNewNote({
                parentNoteId: parentId,
                title: 'Planner — State',
                type: 'code',
                mime: 'application/json',
                content: '{}',
            });
            note = created.note;
            await note.setLabel('plannerdata', '');
            await note.setLabel('hidePromotedAttributes', '');
            await note.setLabel('iconClass', 'bx bx-calendar');
            return { created: true, noteId: note.noteId };
        },
        [parentNoteId]
    );
}

/* ── CONFIG NOTE — scan scope only (#plannerConfig), JSON body: ────────
   { mode: 'exclude'|'include', subtrees: [{noteId, title}, ...] }
   UI preferences (view mode, filters, …) live in #plannerdata, not here. */

const PLANNER_CONFIG_LABEL = 'plannerConfig';
const DEFAULT_PLANNER_CONFIG = { mode: 'exclude', subtrees: [] };

/* Load scope config. Returns { config, configNoteId }; noteId is null when
   the note doesn't exist yet (the ensure call creates it on first mount). */
async function loadPlannerConfig() {
    return await runOnBackend((label, defaults) => {
        const note = api.getNoteWithLabel(label);
        if (!note) return { config: defaults, configNoteId: null };
        let cfg = defaults;
        try {
            const raw = note.getContent();
            if (raw) {
                const parsed = JSON.parse(raw);
                cfg = {
                    mode: (parsed.mode === 'include' ? 'include' : 'exclude'),
                    subtrees: Array.isArray(parsed.subtrees) ? parsed.subtrees : [],
                };
            }
        } catch (_) { /* corrupt JSON → defaults */ }
        return { config: cfg, configNoteId: note.noteId };
    }, [PLANNER_CONFIG_LABEL, DEFAULT_PLANNER_CONFIG]);
}

/* Save scope config. The note is guaranteed to exist by the time we get
   here — ensurePlannerConfig runs on mount, and this save effect is gated
   on configLoaded. Throws if somehow called before that. */
async function savePlannerConfig(config) {
    const json = JSON.stringify(config, null, 2);
    return await runAsyncOnBackendWithManualTransactionHandling(
        async (jsonStr, label) => {
            const note = api.getNoteWithLabel(label);
            if (!note) throw new Error('#plannerConfig note not found');
            note.setContent(jsonStr);
            await note.save();
            return note.noteId;
        },
        [json, PLANNER_CONFIG_LABEL]
    );
}

/* Ensure the #plannerConfig note exists, mirroring ensurePlannerNote.
   Created as a JSON code note under parentNoteId on first run, seeded with
   the defaults. Idempotent. */
async function ensurePlannerConfig(parentNoteId) {
    return await runAsyncOnBackendWithManualTransactionHandling(
        async (parentId, label, defaultsJson) => {
            let note = api.getNoteWithLabel(label);
            if (note) return { created: false, noteId: note.noteId };

            const created = await api.createNewNote({
                parentNoteId: parentId,
                title: 'Planner — Config',
                type: 'code',
                mime: 'application/json',
                content: defaultsJson,
            });
            note = created.note;
            await note.setLabel(label, '');
            await note.setLabel('hidePromotedAttributes', '');
            await note.setLabel('iconClass', 'bx bx-cog');
            return { created: true, noteId: note.noteId };
        },
        [parentNoteId, PLANNER_CONFIG_LABEL, JSON.stringify(DEFAULT_PLANNER_CONFIG, null, 2)]
    );
}

/* Parse Trilium tree drag payload from dataTransfer.
   Trilium sets text/plain to a JSON array:
     [{"noteId":"...","branchId":"...","title":"..."}, ...]
   Returns [] if anything goes wrong. */
function parseDragPayload(dt) {
    try {
        const txt = dt.getData('text/plain');
        if (!txt) return [];
        const parsed = JSON.parse(txt);
        if (!Array.isArray(parsed)) return [];
        return parsed
            .filter(item => item && item.noteId)
            .map(item => ({
                noteId: String(item.noteId),
                title: String(item.title || item.noteId),
            }));
    } catch (_) {
        return [];
    }
}

/* Scan all text notes for prefixed lines.
   `config`        — { mode: 'include'|'exclude', subtrees: [{noteId,title}, ...] }
   `systemNoteIds` — noteIds to always skip (this JSX note + state + config) */
async function fetchAllTasks({
    scanArchived = SCAN_ARCHIVED_DEFAULT,
    config = DEFAULT_PLANNER_CONFIG,
    systemNoteIds = [],
} = {}) {
    const kindRe = KIND_RE_SOURCE;
    const cfgMode = config.mode === 'include' ? 'include' : 'exclude';
    const cfgSubtreeRoots = (config.subtrees || []).map(s => s.noteId).filter(Boolean);

    const groups = await runOnBackend((
        kindReSource, includeArchived,
        mode, subtreeRoots, sysNoteIds
    ) => {
        const findRe = new RegExp(
            `(^|>|<br\\s*/?>)\\s*(${kindReSource})\\s+([\\s\\S]*?)(?=</(?:p|li|div|h[1-6])>|<br\\s*/?>|$)`,
            'g'
        );
        const cleanText = s => s
            .replace(/<[^>]+>/g, '')
            .replace(/&nbsp;/g,  ' ')
            .replace(/&amp;/g,   '&')
            .replace(/&lt;/g,    '<')
            .replace(/&gt;/g,    '>')
            .replace(/&quot;/g,  '"')
            .replace(/&#39;/g,   "'")
            .replace(/\s+/g,     ' ')
            .trim();

        /* Quote a JS array of strings into a SQL IN-list. */
        function sqlList(arr) {
            return arr.map(v => "'" + String(v).replace(/'/g, "''") + "'").join(',');
        }

        /* Walk the branches table from root noteIds to collect every
           descendant. Iterative BFS, bounded to 50 levels. */
        function expandSubtrees(rootIds) {
            const expanded = new Set();
            if (!rootIds || !rootIds.length) return expanded;
            let frontier = rootIds.filter(id => id);
            for (const id of frontier) expanded.add(id);
            for (let depth = 0; depth < 50 && frontier.length; depth++) {
                const list = sqlList(frontier);
                const children = api.sql.getRows(
                    `SELECT DISTINCT noteId FROM branches
                     WHERE parentNoteId IN (${list}) AND isDeleted = 0`
                );
                const newOnes = [];
                for (const r of children) {
                    if (!expanded.has(r.noteId)) {
                        expanded.add(r.noteId);
                        newOnes.push(r.noteId);
                    }
                }
                frontier = newOnes;
            }
            return expanded;
        }

        function scanContent(content) {
            const tasks = [];
            const indexByKind = {};
            let m;
            findRe.lastIndex = 0;
            while ((m = findRe.exec(content)) !== null) {
                const kind = m[2];
                const text = cleanText(m[3]);
                const idxForKind = (indexByKind[kind] = (indexByKind[kind] || 0) + 1) - 1;
                if (!text) continue;
                tasks.push({ kind, text, indexForKind: idxForKind });
            }
            return tasks;
        }

        /* Apply user scope config: include/exclude subtrees from #plannerConfig.
           Empty subtree list → no scope filter (full-tree scan).
           Include mode with empty subtree list is special-cased upstream
           (the scan is skipped entirely), so here we only need to handle the
           "subtrees present" path. */
        const expandedSubtrees = expandSubtrees(subtreeRoots);
        const expandedArr = [...expandedSubtrees];
        let SCOPE_CLAUSE = '1=1';
        if (expandedArr.length) {
            const list = sqlList(expandedArr);
            SCOPE_CLAUSE = mode === 'include'
                ? `n.noteId IN (${list})`
                : `n.noteId NOT IN (${list})`;
        }

        /* Always exclude infrastructure notes (this JSX note, state, config).
           Hardcoded into the SQL — invisible to user, survives config resets. */
        const NOT_INFRASTRUCTURE = sysNoteIds && sysNoteIds.length
            ? `n.noteId NOT IN (${sqlList(sysNoteIds)})`
            : '1=1';

        /* Select in-scope text notes, then read content in JS. We don't
           content-prefilter via SQL GLOB: synced blob rows on server builds
           aren't visible to GLOB, whereas getContent() decodes everywhere.
           Cost is loading every in-scope note — subsecond even on large bases;
           #plannerConfig scoping is how users keep big bases fast. */
        const rows = api.sql.getRows(
            "SELECT noteId, title FROM notes n " +
            "WHERE isDeleted = 0 AND isProtected = 0 AND type = 'text' " +
            "AND " + SCOPE_CLAUSE + " " +
            "AND " + NOT_INFRASTRUCTURE + " " +
            "ORDER BY title COLLATE NOCASE"
        );

        const result = [];
        for (const row of rows) {
            const note = api.getNote(row.noteId);
            if (!note) continue;
            if (!includeArchived && note.hasLabel('archived')) continue;
            const content = note.getContent();
            if (!content) continue;
            const tasks = scanContent(content);
            if (tasks.length) {
                result.push({ noteId: row.noteId, title: row.title || '(no title)', tasks });
            }
        }
        return result;
    }, [kindRe, scanArchived, cfgMode, cfgSubtreeRoots, systemNoteIds]);

    return flattenGroups(groups);
}

/* Re-scan a single note. Used after mark-done and capture
   to avoid a full database scan when we know which note changed. */
async function fetchTasksForNote(noteId, { scanArchived = SCAN_ARCHIVED_DEFAULT } = {}) {
    const kindRe = KIND_RE_SOURCE;

    const groups = await runOnBackend((kindReSource, includeArchived, targetNoteId) => {
        const findRe = new RegExp(
            `(^|>|<br\\s*/?>)\\s*(${kindReSource})\\s+([\\s\\S]*?)(?=</(?:p|li|div|h[1-6])>|<br\\s*/?>|$)`,
            'g'
        );
        const cleanText = s => s
            .replace(/<[^>]+>/g, '')
            .replace(/&nbsp;/g,  ' ')
            .replace(/&amp;/g,   '&')
            .replace(/&lt;/g,    '<')
            .replace(/&gt;/g,    '>')
            .replace(/&quot;/g,  '"')
            .replace(/&#39;/g,   "'")
            .replace(/\s+/g,     ' ')
            .trim();

        const note = api.getNote(targetNoteId);
        if (!note) return [];
        if (note.isDeleted || note.isProtected || note.type !== 'text') return [];
        if (!includeArchived && note.hasLabel('archived')) return [];
        const content = note.getContent();
        if (!content) return [];

        const tasks = [];
        const indexByKind = {};
        let m;
        findRe.lastIndex = 0;
        while ((m = findRe.exec(content)) !== null) {
            const kind = m[2];
            const text = cleanText(m[3]);
            const idxForKind = (indexByKind[kind] = (indexByKind[kind] || 0) + 1) - 1;
            if (!text) continue;
            tasks.push({ kind, text, indexForKind: idxForKind });
        }
        if (!tasks.length) return [];
        return [{ noteId: note.noteId, title: note.title || '(no title)', tasks }];
    }, [kindRe, scanArchived, noteId]);

    return flattenGroups(groups);
}

/* For state compaction: the set of note ids we could fully read (non-deleted,
   non-protected text notes) and the set of all note ids that still exist.
   Together with a full task scan, these let us prune only TRUE orphans —
   never tasks in protected/unreadable notes whose absence we can't confirm. */
async function fetchNoteIdSets() {
    return await runOnBackend(() => {
        const readable = api.sql
            .getRows("SELECT noteId FROM notes WHERE isDeleted = 0 AND isProtected = 0 AND type = 'text'")
            .map(r => r.noteId);
        const existing = api.sql
            .getRows("SELECT noteId FROM notes WHERE isDeleted = 0")
            .map(r => r.noteId);
        return { readableNoteIds: readable, existingNoteIds: existing };
    }, []);
}

/* Flatten {noteId, title, tasks:[...]} groups */
function flattenGroups(groups) {
    const all = [];
    for (const g of groups) {
        for (const t of g.tasks) {
            const meta = parseTaskMeta(t.text);
            const interval = parseInterval(t.text);   // null = ordinary one-off
            // id is the #plannerdata key, so it must stay stable across edits.
            // The interval token is stripped from the slug so changing a cadence
            // (~2d→~1w) doesn't re-key the task and orphan its date/_order/_progress.
            // @date is left in for backward compat (stripping it would re-key
            // existing scheduled one-offs).
            const idText = t.text
                .replace(/(^|\s)~\d+[dw](?=\s|$)/g, ' ')
                .trim()
                .replace(/\s+/g, '_')
                .slice(0, 48);
            const id = `${g.noteId}::${t.kind}::${idText}`;
            all.push({
                id,
                kind:         t.kind,
                text:         t.text,
                tags:         meta.tags,
                isoDate:      meta.isoDate,
                interval,                              // { token, n, unit } | null
                indexForKind: t.indexForKind,
                noteId:       g.noteId,
                noteTitle:    g.title,
            });
        }
    }
    return all;
}

/* Mark done: wrap the line in a grey span and replace prefix with DONE.
   Replaces the Nth occurrence of `<kind> <body>` (up to a line/block boundary)
   with `<span style="color:#cfcfcf">DONE <body></span>`. */
async function markTaskDone(task, doneTextColor) {
    await runOnBackend((noteId, kind, indexForKind, doneColor) => {
        const note = api.getNote(noteId);
        if (!note) return;
        let content = note.getContent();
        let count = 0;

        // Capture: leading boundary, leading whitespace, body (greedy until block-end)
        const re = new RegExp(
            `((?:^|>|<br\\s*/?>))(\\s*)${kind}\\s+([\\s\\S]*?)(?=</(?:p|li|div|h[1-6])>|<br\\s*/?>|$)`,
            'g'
        );
        content = content.replace(re, (match, boundary, ws, body) => {
            if (count++ === indexForKind) {
                return `${boundary}${ws}<span style="color:${doneColor}">DONE ${body}</span>`;
            }
            return match;
        });
        note.setContent(content);
    }, [task.noteId, task.kind, task.indexForKind, doneTextColor]);
}

/* Escape text destined for note HTML so typed markup (e.g. "a < b", an <img>
   tag) is stored as literal text, not interpreted. cleanText decodes these
   entities back when the task is later scanned, so display is unaffected. */
function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/* Append a new task to today's daily note.
   If the typed text starts with a known kind followed by a space, use that
   kind verbatim. Otherwise default to TODO. */
async function appendTodoToToday(text) {
    const prefixRe = new RegExp(`^(${KIND_RE_SOURCE})\\s+(.+)$`);
    const m = text.match(prefixRe);
    const kind = m ? m[1] : 'TODO';
    const body = m ? m[2] : text;
    const lineText = escapeHtml(`${kind} ${body}`);

    return await runOnBackend((line) => {
        const note = api.getTodayNote();
        if (!note) throw new Error("Couldn't get or create today's daily note");
        const current = note.getContent() || '';
        note.setContent(current + `<p>${line}</p>`);
        return { noteId: note.noteId, title: note.title };
    }, [lineText]);
}

/* ── DATE HELPERS ──────────────────────────────────────────────── */

function todayBase() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
}

function getWeekCols(offset) {
    const base = todayBase();
    const ref = new Date(base);
    ref.setDate(base.getDate() + offset * 7);
    const dow = ref.getDay();
    const mon = new Date(ref);
    mon.setDate(ref.getDate() + (dow === 0 ? -6 : 1 - dow));
    const labels = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
    return labels.map((label, i) => {
        const d = new Date(mon);
        d.setDate(mon.getDate() + i);
        const iso = toLocalIsoDate(d);
        return {
            key:     iso,
            label,
            dateStr: `${d.getDate()}/${d.getMonth() + 1}`,
            isToday: d.getTime() === base.getTime(),
        };
    });
}

function weekLabel(cols) {
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    if (!cols || !cols.length) return '';
    const d0 = new Date(cols[0].key + 'T12:00:00');
    const d1 = new Date(cols[cols.length - 1].key + 'T12:00:00');
    if (cols.length === 1) {
        return `${cols[0].label} ${d0.getDate()} ${months[d0.getMonth()]} ${d0.getFullYear()}`;
    }
    if (d0.getMonth() === d1.getMonth())
        return `${d0.getDate()}–${d1.getDate()} ${months[d0.getMonth()]} ${d0.getFullYear()}`;
    return `${d0.getDate()} ${months[d0.getMonth()]} – ${d1.getDate()} ${months[d1.getMonth()]} ${d1.getFullYear()}`;
}

function getDayCol(offset) {
    const labels = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const base = todayBase();
    const d = new Date(base);
    d.setDate(base.getDate() + offset);
    const iso = toLocalIsoDate(d);
    return {
        key: iso,
        label: labels[d.getDay()],
        dateStr: `${d.getDate()}/${d.getMonth() + 1}`,
        isToday: d.getTime() === base.getTime(),
    };
}

const VIEW_MODES = {
    WEEK: 'week',
    WORK: 'work',
    DAY:  'day',
};

/* Short "27 May" / "27 May '25" formatter for the overdue badge.
   Omits the year if it matches the current year. */
function formatOverdueDate(iso) {
    if (!iso || typeof iso !== 'string') return '';
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const d = new Date(iso + 'T12:00:00');
    if (isNaN(d.getTime())) return iso;
    const day = d.getDate();
    const mon = months[d.getMonth()];
    const yr  = d.getFullYear();
    const thisYear = new Date().getFullYear();
    return yr === thisYear ? `${day} ${mon}` : `${day} ${mon} '${String(yr).slice(2)}`;
}

/* ── ORDER + FILTER HELPERS ────────────────────────────────────── */

function applyFilters(tasks, filters) {
    const { kinds, tags, tagMode } = filters;
    return tasks.filter(t => {
        // Kind filter: if no kinds selected (empty set), show all
        if (kinds && kinds.size > 0 && !kinds.has(t.kind)) return false;
        // Tag filter: AND requires every selected tag, OR requires any.
        // Default to AND if tagMode isn't set (backward compat).
        if (tags && tags.size > 0) {
            if (tagMode === 'OR') {
                let any = false;
                for (const tag of tags) {
                    if (t.tags.includes(tag)) { any = true; break; }
                }
                if (!any) return false;
            } else {
                for (const tag of tags) {
                    if (!t.tags.includes(tag)) return false;
                }
            }
        }
        return true;
    });
}

/* Backlog = unscheduled tasks, plus past-due ones (scheduled before today),
   which are tagged isOverdue so they show a marker and stay reachable from any
   week for rescheduling. State is not mutated; the original date is preserved. */
function getBacklog(allTasks, plannerData, todayIso) {
    const result = [];
    for (const t of allTasks) {
        const scheduled = plannerData[t.id];
        if (!scheduled) {
            result.push(t);
        } else if (todayIso && scheduled < todayIso) {
            // ISO date strings sort lexicographically == chronologically.
            result.push({ ...t, isOverdue: true, overdueDate: scheduled });
        }
    }
    return result;
}

function getDayTasks(allTasks, plannerData, iso) {
    const tasks = allTasks.filter(t => plannerData[t.id] === iso);
    const order = ((plannerData._order || {})[iso]) || [];
    tasks.sort((a, b) => {
        const ai = order.indexOf(a.id);
        const bi = order.indexOf(b.id);
        if (ai === -1 && bi === -1) return 0;
        if (ai === -1) return 1;
        if (bi === -1) return -1;
        return ai - bi;
    });
    return tasks;
}

function withOrderUpdate(plannerData, col, taskId, insertBeforeId, allTasks) {
    const next = { ...plannerData };
    if (!next._order) next._order = {};
    else next._order = { ...next._order };
    let order = (next._order[col] || getDayTasks(allTasks, plannerData, col).map(t => t.id)).slice();
    order = order.filter(id => id !== taskId);
    if (insertBeforeId) {
        const idx = order.indexOf(insertBeforeId);
        order.splice(idx !== -1 ? idx : order.length, 0, taskId);
    } else {
        order.push(taskId);
    }
    next._order[col] = order;
    return next;
}

/* Compact #plannerdata: drop entries for TRUE orphans only. Inputs come from a
   full, scope-ignoring scan:
     liveIds         — task ids still present anywhere in readable notes
     readableNoteIds — notes we could fully read (non-protected text notes)
     existingNoteIds — every note that still exists
   An id is an orphan iff its source note was deleted, OR the note is readable
   and the line is gone. Ids whose note exists but is unreadable (protected or
   non-text) are KEPT, since protected notes are never scanned and pruning them
   would lose live schedules. Returns { data, removed } (removed = orphan count). */
function compactPlannerData(plannerData, { liveIds, readableNoteIds, existingNoteIds }) {
    const live     = liveIds instanceof Set ? liveIds : new Set(liveIds);
    const readable = readableNoteIds instanceof Set ? readableNoteIds : new Set(readableNoteIds);
    const existing = existingNoteIds instanceof Set ? existingNoteIds : new Set(existingNoteIds);

    const noteIdOf = (id) => { const i = id.indexOf('::'); return i === -1 ? null : id.slice(0, i); };
    const isOrphan = (id) => {
        if (live.has(id)) return false;
        const n = noteIdOf(id);
        if (!n) return false;               // malformed key — leave alone
        if (!existing.has(n)) return true;  // source note deleted
        if (readable.has(n)) return true;   // note readable, line gone
        return false;                       // exists but unreadable (protected/non-text) — keep
    };

    let removed = 0;
    const next = {};
    for (const key in plannerData) {
        if (key.startsWith('_')) { next[key] = plannerData[key]; continue; }
        if (isOrphan(key)) { removed++; continue; }
        next[key] = plannerData[key];
    }
    if (plannerData._order) {
        const order = {};
        for (const date in plannerData._order) {
            const kept = (plannerData._order[date] || []).filter(id => !isOrphan(id));
            if (kept.length) order[date] = kept;   // also drops now-empty day arrays
        }
        next._order = order;
    }
    if (plannerData._progress) {
        const progress = {};
        for (const id in plannerData._progress) {
            if (!isOrphan(id)) progress[id] = plannerData._progress[id];
        }
        next._progress = progress;
    }
    return { data: next, removed };
}

/* ── CSS — built from the resolved theme ───────────────────────── */

/* Builds the planner's CSS for a given resolved theme. */
function buildStyle(theme) {
    return `
.pl-root { display:flex; flex-direction:column; height:100%; overflow:hidden;
           font-family: var(--detail-font-family,"Segoe UI",sans-serif);
           font-size:14px; color:${theme.text}; background:${theme.bgRoot}; }

.pl-header { display:flex; align-items:center; gap:7px; padding:10px 16px;
             flex-shrink:0; border-bottom:1px solid ${theme.border};
             flex-wrap:wrap; background:${theme.bgRoot}; }

.pl-board { display:flex; gap:10px; overflow-x:auto;
            padding:0 16px 20px; flex:1; align-items:flex-start;
            -webkit-overflow-scrolling:touch; }

.pl-col { flex-shrink:0; display:flex; flex-direction:column; border-radius:8px;
          border:1px solid ${theme.border};
          background:${theme.bgPanel};
          max-height:calc(100vh - 240px); position:relative; }
.pl-col.today { border-color:#89b4fa; border-width:2px; }

.pl-col-head { padding:10px 12px 8px; border-bottom:1px solid ${theme.border};
               flex-shrink:0; }
.pl-col-label { font-size:14px; font-weight:700; text-transform:uppercase;
                letter-spacing:.08em; color:${theme.textMuted}; }
.pl-col.today .pl-col-label { color:#5a7fb8; }
.pl-col-sub { font-size:13px; color:${theme.textMuted}; margin-top:2px; }

.pl-tasks { padding:8px; display:flex; flex-direction:column; gap:6px;
            overflow-y:auto; flex:1; min-height:64px; }
.pl-task { background:${theme.bgTask}; border-radius:5px;
           padding:7px 10px; font-size:15px; line-height:1.4; cursor:pointer;
           border:1.5px solid transparent; transition:border-color .1s, opacity .15s;
           user-select:none; color:${theme.text}; }
.pl-task:hover { border-color:${theme.border}; }
.pl-task.dragging { opacity:.35; cursor:grabbing; }
.pl-task[draggable="true"] { cursor:grab; }
.pl-task-note { font-size:12px; color:${theme.textMuted}; margin-top:3px;
                overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.pl-task-kind { display:inline-block; font-size:10px; font-weight:700;
                padding:1px 5px; border-radius:3px; margin-right:5px;
                vertical-align:middle; letter-spacing:.05em; color:#fff; }
.pl-task-date { color:${theme.colorDateTag}; }
/* Recurring marker inside the kind chip. Kept static — an animated spinner
   would read as "loading" and clash with the done button's .working state. */
.pl-recur-mark { margin-left:4px; font-weight:400; opacity:.95; cursor:default; }

.pl-drop { display:none; height:40px; border:2px dashed ${theme.border};
           border-radius:5px; opacity:.5; }
.pl-tasks.drag-over { background:rgba(137,180,250,.10); }
.pl-tasks.drag-over .pl-drop { display:block; }
.pl-insert-marker { height:2px; border-radius:2px; flex-shrink:0;
                    background:#89b4fa; margin:2px 0; pointer-events:none; }

.pl-resize-handle { position:absolute; top:0; right:-3px; width:7px; height:100%;
                    cursor:col-resize; z-index:5; background:transparent;
                    transition:background .15s; }
.pl-resize-handle:hover, .pl-resize-handle.dragging {
    background:#89b4fa; opacity:.5;
}
body.pl-resizing { cursor:col-resize !important; user-select:none; }
body.pl-resizing * { cursor:col-resize !important; }

.pl-btn { background:${theme.bgRoot}; border:1px solid ${theme.border}; border-radius:5px;
          color:${theme.text}; font-size:14px; padding:3px 10px;
          cursor:pointer; line-height:1.4; }
.pl-btn:hover { background:${theme.bgHover}; }
.pl-btn.icon { font-size:19px; width:28px; height:26px; padding:0; }
.pl-btn.muted { color:${theme.textMuted}; }
.pl-btn:disabled { opacity:.5; cursor:not-allowed; }
.pl-icon-btn { display:inline-flex; align-items:center; justify-content:center; }
.pl-icon-btn svg { display:block; }

.pl-capture { display:flex; gap:6px; padding:8px 16px; flex-shrink:0;
              border-bottom:1px solid ${theme.border}; background:${theme.bgRoot}; }
.pl-capture input { flex:1; background:${theme.bgRoot};
                    border:1px solid ${theme.border}; border-radius:5px;
                    color:${theme.text}; font-size:14px; padding:6px 10px;
                    font-family:inherit; }
.pl-capture input:focus { outline:1px solid #89b4fa; }

/* Filter dropdown uses position:fixed to escape the root's overflow:hidden;
   its position is computed from the trigger's rect at open time. */
.pl-filter-wrap { position:relative; }
.pl-filter-panel { position:fixed; z-index:9998;
                   background:${theme.bgRoot}; border:1px solid ${theme.border}; border-radius:6px;
                   box-shadow:0 4px 12px rgba(0,0,0,.12);
                   padding:10px 12px; min-width:200px; max-width:240px;
                   max-height:80vh; overflow-y:auto; }
.pl-filter-panel h5 { margin:0 0 4px; font-size:12px;
                      text-transform:uppercase; letter-spacing:.05em;
                      color:${theme.textMuted}; font-weight:700; }
.pl-filter-panel h5:not(:first-child) { margin-top:10px; }
.pl-filter-row { display:flex; align-items:center; gap:6px;
                 padding:3px 0; cursor:pointer; user-select:none;
                 font-size:13px; }
.pl-filter-row input { margin:0; }
.pl-filter-badge { display:inline-block; min-width:16px; height:16px;
                   padding:0 4px; border-radius:8px; font-size:10px;
                   line-height:16px; text-align:center; background:#89b4fa;
                   color:#fff; margin-left:4px; font-weight:700; }
.pl-tagmode-btn { margin-left:auto; padding:1px 6px; font-size:10px; font-weight:700;
                  border:1px solid ${theme.border}; background:${theme.bgRoot};
                  color:${theme.textMuted}; border-radius:3px; cursor:pointer;
                  letter-spacing:.05em; }

/* Done button on each card (shown on hover, always visible on mobile) */
.pl-task { position:relative; }
.pl-task-done-btn {
    position:absolute; top:5px; right:5px;
    width:18px; height:18px;
    border:1.5px solid ${theme.border}; border-radius:50%;
    background:${theme.bgRoot}; color:${theme.colorDoneBtn};
    font-size:12px; font-weight:700; line-height:1;
    display:flex; align-items:center; justify-content:center;
    cursor:pointer; opacity:0;
    transition:opacity .12s, background .12s, border-color .12s;
}
.pl-task:hover .pl-task-done-btn { opacity:1; }
.pl-task-done-btn:hover {
    background:${theme.colorDoneBtn}; border-color:${theme.colorDoneBtn}; color:#fff;
}
.pl-task-done-btn.working { opacity:1; background:${theme.bgHover}; cursor:wait; }
/* Always visible on touch devices (no hover) */
@media (hover: none) {
    .pl-task-done-btn { opacity:.7; }
}

/* Progress bar at the bottom edge of the card. Clicking cycles 0→25→50→75→0. */
.pl-task-progress {
    position:absolute; left:0; right:0; bottom:0;
    height:5px; border-radius:0 0 5px 5px;
    background:rgba(128,128,128,.18);
    cursor:pointer; overflow:hidden;
}
.pl-task-progress-fill {
    height:100%;
    background:${theme.colorProgress};
    opacity:.55;
    transition:width .15s, opacity .15s;
}
.pl-task-progress:hover .pl-task-progress-fill { opacity:.85; }
.pl-task-progress-label {
    position:absolute; right:6px; top:-15px;
    font-size:10px; color:${theme.textMuted};
    background:${theme.bgRoot}; padding:0 4px; border-radius:3px;
    pointer-events:none; opacity:0;
    transition:opacity .15s;
}
.pl-task-progress:hover .pl-task-progress-label { opacity:1; }
/* Add bottom padding so card content doesn't sit under the bar */
.pl-task { padding-bottom:9px; }

/* Config panel — scope (include/exclude subtrees) */
.pl-config-panel {
    padding:12px 16px;
    background:${theme.bgPanel};
    border-bottom:1px solid ${theme.border};
    flex-shrink:0;
}
.pl-config-row {
    display:flex; align-items:center; gap:12px;
    margin-bottom:10px; flex-wrap:wrap;
}
.pl-config-label {
    font-size:11px; font-weight:600; text-transform:uppercase;
    color:${theme.textMuted}; letter-spacing:0.05em;
}
.pl-mode-toggle {
    display:inline-flex; border:1px solid ${theme.border};
    border-radius:4px; overflow:hidden;
}
.pl-mode-btn {
    padding:4px 12px; font-size:12px; cursor:pointer;
    background:transparent; border:none; color:${theme.textMuted};
}
.pl-mode-btn.active {
    background:${theme.bgActive}; color:${theme.textActive}; font-weight:600;
}
.pl-dropzone {
    border:2px dashed ${theme.border};
    border-radius:6px; padding:12px;
    text-align:center; font-size:12px; color:${theme.textMuted};
    transition:background .15s, border-color .15s;
}
.pl-dropzone.over {
    background:rgba(137,180,250,0.10);
    border-color:#89b4fa; color:${theme.text};
}
.pl-chips {
    display:flex; flex-wrap:wrap; gap:6px; margin-top:8px;
}
.pl-chip {
    display:inline-flex; align-items:center; gap:6px;
    padding:3px 6px 3px 10px;
    background:${theme.bgRoot}; border:1px solid ${theme.border};
    border-radius:12px; font-size:12px;
}
.pl-chip-title {
    max-width:200px; overflow:hidden;
    text-overflow:ellipsis; white-space:nowrap;
}
.pl-chip-x {
    cursor:pointer; padding:0 4px; border-radius:50%;
    color:${theme.textMuted}; font-weight:700;
}
.pl-chip-x:hover { color:#d97070; background:rgba(217,112,112,0.1); }
.pl-config-hint {
    font-size:11px; color:${theme.textMuted}; font-style:italic; margin-top:6px;
}
.pl-badge {
    display:inline-block; min-width:16px; height:16px;
    padding:0 4px; border-radius:8px; font-size:10px;
    line-height:16px; text-align:center;
    background:#89b4fa; color:#fff; margin-left:4px; font-weight:700;
}
.pl-btn.active {
    background:${theme.bgActive}; color:${theme.textActive}; border-color:${theme.bgActive};
}
.pl-view-toggle {
    display:inline-flex; align-items:center; gap:0;
    border:1px solid ${theme.border}; border-radius:5px; overflow:hidden;
    background:${theme.bgRoot};
}
.pl-view-btn {
    border:none; border-right:1px solid ${theme.border};
    background:${theme.bgRoot}; color:${theme.textMuted}; padding:3px 9px;
    font-size:12px; line-height:1.4; cursor:pointer;
}
.pl-view-btn:last-child { border-right:none; }
.pl-view-btn:hover { background:${theme.bgHover}; }
.pl-view-btn.active { background:${theme.bgActive}; color:${theme.textActive}; font-weight:700; }
.pl-confirm-overlay {
    position:fixed; inset:0; z-index:10000;
    background:rgba(0,0,0,.18);
    display:flex; align-items:flex-start; justify-content:center;
    padding-top:76px;
}
.pl-confirm-dialog {
    width:min(420px, calc(100vw - 32px));
    background:${theme.bgRoot}; border:1px solid ${theme.border}; border-radius:8px;
    box-shadow:0 8px 28px rgba(0,0,0,.20);
    padding:14px 16px; color:${theme.text};
}
.pl-confirm-title { font-size:15px; font-weight:700; margin-bottom:6px; }
.pl-confirm-body { font-size:13px; color:${theme.textMuted}; line-height:1.4; margin-bottom:12px; }
.pl-confirm-actions { display:flex; justify-content:flex-end; gap:8px; }
.pl-btn.danger { border-color:#d97070; color:#9b3434; }
.pl-btn.danger:hover { background:#fae9e9; }

/* Overdue badge on backlog cards (scheduled date in the past). Text span plus
   a hover-only × that clears the stored date, returning the task to unplanned. */
.pl-overdue-badge {
    display:inline-flex; align-items:center;
    margin-right:6px;
    padding:1px 2px 1px 6px;
    border-radius:4px;
    background:#fbe9b8;
    color:#7a5a00;
    font-size:11px;
    font-weight:600;
    vertical-align:middle;
    white-space:nowrap;
    gap:2px;
}
.pl-overdue-text { padding-right:2px; }
.pl-overdue-x {
    display:inline-block;
    padding:0 5px;
    border-radius:3px;
    cursor:pointer;
    color:#a37800;
    font-weight:700;
    opacity:0;
    transition:opacity .12s, background .12s, color .12s;
}
.pl-task:hover .pl-overdue-x { opacity:0.6; }
.pl-overdue-x:hover {
    opacity:1 !important;
    background:rgba(217,112,112,0.15);
    color:#a83333;
}
`;
}

/* Inject/replace the planner's <style> tag in <head>; re-run on theme change. */
function injectStyle(css) {
    let el = document.getElementById('pl-preact-styles');
    if (!el) {
        el = document.createElement('style');
        el.id = 'pl-preact-styles';
        document.head.appendChild(el);
    }
    if (el.textContent !== css) el.textContent = css;
}

/* ── COMPONENTS ────────────────────────────────────────────────── */

function KindChip({ kind, overrides, recurring, recurTitle }) {
    const k = KINDS[kind];
    if (!k) return null;
    const color = getKindColor(kind, overrides);
    return (
        <span class="pl-task-kind" style={{ background: color }}>
            {k.label}
            {recurring && (
                <span class="pl-recur-mark" title={recurTitle} aria-label={recurTitle}>↻</span>
            )}
        </span>
    );
}

/* Render task text, styling @date / #tag / ~interval tokens as muted spans. */
function renderTaskText(text) {
    const parts = [];
    // @date, #tag, or ~interval at start-of-text or after whitespace.
    const re = /(^|\s)(@\S+|#[A-Za-z][\w-]*|~\d+[dw](?=\s|$))/g;
    let last = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
        const tokenStart = m.index + m[1].length;
        if (tokenStart > last) parts.push(text.slice(last, tokenStart));
        const token = m[2];
        parts.push(
            <span class="pl-task-date" key={`${tokenStart}-${token}`}>{token}</span>
        );
        last = tokenStart + token.length;
    }
    if (last < text.length) parts.push(text.slice(last));
    return parts;
}

function TaskCard({ task, progress, overrides, draggable, onClick, onMarkDone, onSetProgress, onDismissOverdue, onDragStart, onDragEnd }) {
    const [working, setWorking] = useState(false);

    const handleDone = async (e) => {
        e.stopPropagation();
        if (working) return;
        setWorking(true);
        try {
            await onMarkDone(task);
            // A recurring card isn't removed — it just moves columns — so there's
            // no unmount to discard the spinner. Clear it explicitly.
            if (task.interval) setWorking(false);
        }
        catch (err) { console.error(err); setWorking(false); }
    };

    // Progress click: cycle 0 → 25 → 50 → 75 → 0.
    const handleProgressClick = (e) => {
        e.stopPropagation();
        const current = progress || 0;
        const next = current >= 75 ? 0 : current + 25;
        onSetProgress(task, next);
    };

    const pct = Math.max(0, Math.min(75, progress || 0));

    return (
        <div
            class="pl-task"
            draggable={draggable}
            data-task-id={task.id}
            onClick={onClick}
            onAuxClick={onClick}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
        >
            <button
                class={`pl-task-done-btn${working ? ' working' : ''}`}
                title="Mark done"
                onClick={handleDone}
                draggable={false}
                onMouseDown={(e) => e.stopPropagation()}
            >
                ✓
            </button>
            <div style={{ paddingRight: '20px' }}>
                <KindChip
                    kind={task.kind}
                    overrides={overrides}
                    recurring={!!task.interval}
                    recurTitle={task.interval ? recurCadenceLabel(task.interval) : undefined}
                />
                {task.isOverdue && (
                    <span class="pl-overdue-badge">
                        <span
                            class="pl-overdue-text"
                            title={`Originally scheduled for ${task.overdueDate}`}
                        >
                            ⚠ {formatOverdueDate(task.overdueDate)}
                        </span>
                        <span
                            class="pl-overdue-x"
                            title="Dismiss (keep task, clear schedule)"
                            onClick={(e) => {
                                e.stopPropagation();
                                onDismissOverdue && onDismissOverdue(task);
                            }}
                            onMouseDown={(e) => e.stopPropagation()}
                            draggable={false}
                        >×</span>
                    </span>
                )}
                {renderTaskText(task.text)}
            </div>
            <div class="pl-task-note">{task.noteTitle}</div>
            <div
                class="pl-task-progress"
                title={`Progress: ${pct}% — click to advance`}
                onClick={handleProgressClick}
                onMouseDown={(e) => e.stopPropagation()}
            >
                <div class="pl-task-progress-fill" style={{ width: `${pct}%` }} />
                {pct > 0 && <span class="pl-task-progress-label">{pct}%</span>}
            </div>
        </div>
    );
}

function Column({
    col, tasks, mobile, isResizing, widthStyle, overrides, progressMap,
    onCardClick, onCardMarkDone, onCardSetProgress, onCardDismissOverdue,
    onCardDragStart, onCardDragEnd,
    onDragOver, onDragLeave, onDrop,
    onResizeStart, insertMarkerBeforeId,
}) {
    const classes = [
        'pl-col',
        col.isToday ? 'today' : '',
        col.isBacklog ? 'backlog' : '',
    ].filter(Boolean).join(' ');

    return (
        <div class={classes} style={widthStyle}>
            <div class="pl-col-head">
                <div class="pl-col-label">{col.label}</div>
                <div class="pl-col-sub">
                    {col.dateStr}{!col.isBacklog && tasks.length ? ` · ${tasks.length}` : ''}
                </div>
            </div>
            <div
                class="pl-tasks"
                data-col={col.key}
                onDragOver={onDragOver}
                onDragLeave={onDragLeave}
                onDrop={onDrop}
            >
                {tasks.map(t => (
                    <>
                        {insertMarkerBeforeId === t.id ? <div class="pl-insert-marker" /> : null}
                        <TaskCard
                            key={t.id}
                            task={t}
                            progress={progressMap ? progressMap[t.id] : 0}
                            overrides={overrides}
                            draggable={!mobile}
                            onClick={(e) => onCardClick(t, e)}
                            onMarkDone={onCardMarkDone}
                            onSetProgress={onCardSetProgress}
                            onDismissOverdue={onCardDismissOverdue}
                            onDragStart={(e) => onCardDragStart(t, e)}
                            onDragEnd={onCardDragEnd}
                        />
                    </>
                ))}
                {insertMarkerBeforeId === '__end__' ? <div class="pl-insert-marker" /> : null}
                <div class="pl-drop" />
            </div>
            {col.isBacklog && !mobile && (
                <div
                    class={`pl-resize-handle${isResizing ? ' dragging' : ''}`}
                    title="Drag to resize"
                    onMouseDown={onResizeStart}
                />
            )}
        </div>
    );
}

function CapturePanel({ onCapture, working }) {
    const [text, setText] = useState('');
    const inputRef = useRef(null);

    const submit = async () => {
        const t = text.trim();
        if (!t) return;
        await onCapture(t);
        setText('');
        inputRef.current?.focus();
    };

    return (
        <div class="pl-capture">
            <input
                ref={inputRef}
                placeholder="Capture a TODO… (try '@tomorrow', '@fri', or '#tag')"
                value={text}
                onInput={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === 'Enter') submit();
                    if (e.key === 'Escape') setText('');
                }}
                disabled={working}
            />
            <button class="pl-btn" onClick={submit} disabled={working || !text.trim()}>
                {working ? '…' : '+ Add'}
            </button>
        </div>
    );
}

function FilterDropdown({ allTasks, filters, onChange, overrides }) {
    const [open, setOpen] = useState(false);
    const wrapRef = useRef(null);
    const [panelPos, setPanelPos] = useState(null);

    // Close on outside click
    useEffect(() => {
        if (!open) return;
        const handler = (e) => {
            if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [open]);

    // Compute panel position whenever it opens.
    useEffect(() => {
        if (!open) {
            setPanelPos(null);
            return;
        }
        if (!wrapRef.current) return;
        const btn = wrapRef.current.querySelector('button');
        if (!btn) return;
        const r = btn.getBoundingClientRect();
        setPanelPos({
            top:   r.bottom + 4,                          // 4px below the trigger
            right: Math.max(8, window.innerWidth - r.right), // align panel right edge to button right edge
        });
    }, [open]);

    // Compute kinds and tags that actually exist
    const kindCounts = useMemo(() => {
        const c = {};
        for (const t of allTasks) c[t.kind] = (c[t.kind] || 0) + 1;
        return c;
    }, [allTasks]);
    const presentKinds = KIND_KEYS.filter(k => kindCounts[k] > 0);

    const allTags = useMemo(() => {
        const s = new Set();
        for (const t of allTasks) for (const tag of t.tags) s.add(tag);
        return Array.from(s).sort();
    }, [allTasks]);

    const toggleKind = (kind) => {
        const kinds = new Set(filters.kinds);
        if (kinds.has(kind)) kinds.delete(kind);
        else kinds.add(kind);
        onChange({ ...filters, kinds });
    };
    const toggleTag = (tag) => {
        const tags = new Set(filters.tags);
        if (tags.has(tag)) tags.delete(tag);
        else tags.add(tag);
        onChange({ ...filters, tags });
    };
    const clearAll = () => onChange({ ...filters, kinds: new Set(), tags: new Set() });
    const toggleTagMode = () => {
        const next = filters.tagMode === 'OR' ? 'AND' : 'OR';
        onChange({ ...filters, tagMode: next });
    };

    const activeCount = filters.kinds.size + filters.tags.size;
    const tagMode = filters.tagMode === 'OR' ? 'OR' : 'AND';

    return (
        <div class="pl-filter-wrap" ref={wrapRef}>
            <button class="pl-btn muted" onClick={() => setOpen(o => !o)}>
                Filter{activeCount > 0 && <span class="pl-filter-badge">{activeCount}</span>}
            </button>
            {open && (
                <div
                    class="pl-filter-panel"
                    style={panelPos ? { top: `${panelPos.top}px`, right: `${panelPos.right}px` } : { visibility: 'hidden' }}
                >
                    {presentKinds.length > 0 && (
                        <>
                            <h5>Kinds</h5>
                            {presentKinds.map(k => (
                                <label class="pl-filter-row" key={k}>
                                    <input
                                        type="checkbox"
                                        checked={filters.kinds.has(k)}
                                        onChange={() => toggleKind(k)}
                                    />
                                    <span style={{ color: getKindColor(k, overrides), fontWeight: 700 }}>
                                        {k}
                                    </span>
                                    <span style={{ color: 'var(--muted-text-color, #999)', marginLeft: 'auto' }}>
                                        {kindCounts[k]}
                                    </span>
                                </label>
                            ))}
                        </>
                    )}
                    {allTags.length > 0 && (
                        <>
                            <h5 style={{ display: 'flex', alignItems: 'center' }}>
                                <span>Tags</span>
                                <button
                                    class="pl-tagmode-btn"
                                    onClick={toggleTagMode}
                                    title={tagMode === 'AND'
                                        ? 'AND: a task must have all selected tags. Click to switch to OR.'
                                        : 'OR: a task must have any selected tag. Click to switch to AND.'}
                                >
                                    {tagMode}
                                </button>
                            </h5>
                            <div style={{ maxHeight: '160px', overflowY: 'auto' }}>
                                {allTags.map(tag => (
                                    <label class="pl-filter-row" key={tag}>
                                        <input
                                            type="checkbox"
                                            checked={filters.tags.has(tag)}
                                            onChange={() => toggleTag(tag)}
                                        />
                                        #{tag}
                                    </label>
                                ))}
                            </div>
                        </>
                    )}
                    {activeCount > 0 && (
                        <button class="pl-btn muted"
                                style={{ marginTop: '8px', width: '100%' }}
                                onClick={clearAll}>
                            Clear filters
                        </button>
                    )}
                </div>
            )}
        </div>
    );
}


/* ── CONFIG PANEL — scope (include/exclude subtrees) ───────────── */

function ConfigPanel({ config, onChange }) {
    const [dragOver, setDragOver] = useState(false);
    const subtrees = config.subtrees || [];

    const setMode = (mode) => onChange({ ...config, mode });

    const addSubtrees = (items) => {
        const existing = new Set(subtrees.map(s => s.noteId));
        const merged = [...subtrees];
        for (const item of items) {
            if (!existing.has(item.noteId)) {
                merged.push(item);
                existing.add(item.noteId);
            }
        }
        if (merged.length !== subtrees.length) {
            onChange({ ...config, subtrees: merged });
        }
    };

    const removeSubtree = (noteId) => {
        onChange({ ...config, subtrees: subtrees.filter(s => s.noteId !== noteId) });
    };

    const onDragOver = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!dragOver) setDragOver(true);
    };
    const onDragLeave = (e) => {
        e.preventDefault();
        setDragOver(false);
    };
    const onDrop = (e) => {
        e.preventDefault();
        e.stopPropagation();
        setDragOver(false);
        const items = parseDragPayload(e.dataTransfer);
        if (items.length) addSubtrees(items);
    };

    return (
        <div class="pl-config-panel">
            <div class="pl-config-row">
                <span class="pl-config-label">Scope</span>
                <div class="pl-mode-toggle">
                    <button
                        class={`pl-mode-btn${config.mode === 'exclude' ? ' active' : ''}`}
                        onClick={() => setMode('exclude')}
                        title="Scan everything except these subtrees"
                    >Exclude</button>
                    <button
                        class={`pl-mode-btn${config.mode === 'include' ? ' active' : ''}`}
                        onClick={() => setMode('include')}
                        title="Scan only these subtrees"
                    >Include</button>
                </div>
            </div>

            <div
                class={`pl-dropzone${dragOver ? ' over' : ''}`}
                onDragOver={onDragOver}
                onDragEnter={onDragOver}
                onDragLeave={onDragLeave}
                onDrop={onDrop}
            >
                {dragOver
                    ? 'Drop to add subtree(s)'
                    : 'Drag notes from the tree here to add'}
            </div>

            {subtrees.length > 0 ? (
                <div class="pl-chips">
                    {subtrees.map(s => (
                        <span class="pl-chip" key={s.noteId}>
                            <span class="pl-chip-title" title={s.noteId}>📁 {s.title}</span>
                            <span
                                class="pl-chip-x"
                                onClick={() => removeSubtree(s.noteId)}
                                title="Remove"
                            >×</span>
                        </span>
                    ))}
                </div>
            ) : (
                <div class="pl-config-hint">
                    {config.mode === 'include'
                        ? '⚠ No subtrees selected — Include mode scans nothing. Drag at least one subtree above.'
                        : 'Empty list: full-tree scan.'}
                </div>
            )}
        </div>
    );
}


/* ── ROOT COMPONENT ────────────────────────────────────────────── */

function PlannerApp() {
    const [allTasks,    setAllTasks]      = useState([]);
    const [plannerData, setPlannerData]   = useState({});
    const [weekOffset,  setWeekOffset]    = useState(0);
    const [dayOffset,   setDayOffset]     = useState(0);
    const [viewMode,    setViewMode]      = useState(VIEW_MODES.WEEK);
    const [backlogWidth, setBacklogWidth] = useState(BACKLOG_WIDTH_DEFAULT);
    const [loading,     setLoading]       = useState(true);
    const [error,       setError]         = useState(null);
    const [capturing,   setCapturing]     = useState(false);
    const [colorOverrides, setColorOverrides] = useState({});
    const [themeOverrides, setThemeOverrides] = useState({});
    const [scanArchived, setScanArchived] = useState(SCAN_ARCHIVED_DEFAULT);

    // Scope config (#plannerConfig) — loaded on mount, saved on change (debounced).
    // Drives include/exclude subtree filtering at scan time.
    const [config, setConfig] = useState(DEFAULT_PLANNER_CONFIG);
    const [configNoteId, setConfigNoteId] = useState(null);
    const [stateNoteId,  setStateNoteId]  = useState(null);  // for scan exclusion
    const [configLoaded, setConfigLoaded] = useState(false);
    const [showConfig, setShowConfig] = useState(false);
    const [pendingClear, setPendingClear] = useState(null);
    const [pendingCompact, setPendingCompact] = useState(null);  // { removed, data } | null
    const [compacting, setCompacting] = useState(false);
    const configSaveDebounceRef = useRef(null);
    const configReloadDebounceRef = useRef(null);
    const skipFirstConfigSaveRef = useRef(true);  // skip the state-from-load save

    // Filters: persisted in plannerData._filters as { kinds: [], tags: [] }
    const [filters, setFilters] = useState({ kinds: new Set(), tags: new Set(), tagMode: 'AND' });

    const dragState = useRef({ id: null, insertBeforeId: null, dragMoved: false });
    const [insertMarker, setInsertMarker] = useState({ col: null, beforeId: null });
    const [isResizing,   setIsResizing]   = useState(false);

    // Resolved theme: defaults merged with label-based overrides.
    const theme = useMemo(() => resolveTheme(themeOverrides), [themeOverrides]);

    // Inject CSS whenever the resolved theme changes (and once on mount).
    useEffect(() => { injectStyle(buildStyle(theme)); }, [theme]);

    /* Schedule a fetched task per its @date suffix if not already planned.
       Returns updated plannerData or the same reference if no changes. */
    const applyDateSuffixes = useCallback((tasks, currentData) => {
        const updates = {};
        let changed = false;
        for (const t of tasks) {
            if (currentData[t.id]) continue;
            if (t.isoDate) {
                updates[t.id] = t.isoDate;
                changed = true;
            }
        }
        return changed ? { ...currentData, ...updates } : currentData;
    }, []);

    /* Initial load. The #plannerdata and #plannerConfig notes are auto-created
       here on first run (idempotent on every later load). */
    useEffect(() => {
        (async () => {
            try {
                const parentId = api.startNote ? api.startNote.noteId : 'root';
                const ensured = await ensurePlannerNote(parentId);
                setStateNoteId(ensured.noteId);
                const ensuredCfg = await ensurePlannerConfig(parentId);

                const { config: loadedCfg, configNoteId: cfgId } = await loadPlannerConfig();
                setConfigNoteId(cfgId || ensuredCfg.noteId || null);

                const loaded = await loadPlannerData();
                const data = loaded.data || {};

                const isValidMode = (m) => [VIEW_MODES.WEEK, VIEW_MODES.WORK, VIEW_MODES.DAY].includes(m);
                const initialViewMode = isValidMode(data._viewMode) ? data._viewMode : VIEW_MODES.WEEK;
                data._viewMode = initialViewMode;  // normalise so it round-trips cleanly

                setConfig(loadedCfg);
                setConfigLoaded(true);
                setViewMode(initialViewMode);
                // weekOffset/dayOffset aren't persisted — always open on today.

                if (data._filters) {
                    setFilters({
                        kinds:   new Set(data._filters.kinds || []),
                        tags:    new Set(data._filters.tags  || []),
                        tagMode: data._filters.tagMode === 'OR' ? 'OR' : 'AND',
                    });
                }
                const persistedWidth = data._backlogWidth;
                if (typeof persistedWidth === 'number' &&
                    persistedWidth >= BACKLOG_WIDTH_MIN &&
                    persistedWidth <= BACKLOG_WIDTH_MAX) {
                    setBacklogWidth(persistedWidth);
                } else if (loaded.labelWidth) {
                    setBacklogWidth(loaded.labelWidth);
                }
                setColorOverrides(loaded.colorOverrides);
                setThemeOverrides(loaded.themeOverrides);
                setScanArchived(loaded.scanArchived !== false);

                // Notes the scan must never pick up: host JSX + state + config.
                const sysIds = [];
                if (api.startNote)   sysIds.push(api.startNote.noteId);
                if (api.currentNote) sysIds.push(api.currentNote.noteId);
                sysIds.push(ensured.noteId);
                if (cfgId) sysIds.push(cfgId);
                else if (ensuredCfg.noteId) sysIds.push(ensuredCfg.noteId);

                // Include mode with no subtrees scans nothing — skip the scan.
                const includeEmpty = loadedCfg.mode === 'include'
                    && (!loadedCfg.subtrees || loadedCfg.subtrees.length === 0);

                let tasks = [];
                if (!includeEmpty) {
                    tasks = await fetchAllTasks({
                        scanArchived: loaded.scanArchived !== false,
                        config: loadedCfg,
                        systemNoteIds: [...new Set(sysIds)],
                    });
                }
                setAllTasks(tasks);
                setPlannerData(applyDateSuffixes(tasks, data));
            } catch (err) {
                console.error(err);
                setError(String(err.message || err));
            } finally {
                setLoading(false);
            }
        })();
    }, []);

    /* Persist plannerData on change (skipping initial load).
       Each persist effect has its own skip-on-mount flag. */
    const skipFirstSave = useRef(true);
    useEffect(() => {
        if (skipFirstSave.current) { skipFirstSave.current = false; return; }
        savePlannerData(plannerData).catch(err => console.error('save:', err));
    }, [plannerData]);

    /* Persist filters into plannerData when they change */
    const skipFirstFilterSync = useRef(true);
    useEffect(() => {
        if (skipFirstFilterSync.current) { skipFirstFilterSync.current = false; return; }
        setPlannerData(prev => ({
            ...prev,
            _filters: {
                kinds:   Array.from(filters.kinds),
                tags:    Array.from(filters.tags),
                tagMode: filters.tagMode || 'AND',
            },
        }));
    }, [filters]);

    /* Persist view mode into #plannerdata (next to _filters); the write
       triggers the savePlannerData effect above. */
    const skipFirstViewSync = useRef(true);
    useEffect(() => {
        if (skipFirstViewSync.current) { skipFirstViewSync.current = false; return; }
        setPlannerData(prev => (prev._viewMode === viewMode ? prev : { ...prev, _viewMode: viewMode }));
    }, [viewMode]);

    /* Notes the planner must never scan (this JSX note + state + config). */
    const systemNoteIds = useMemo(() => {
        const ids = [];
        if (api.startNote)   ids.push(api.startNote.noteId);
        if (api.currentNote) ids.push(api.currentNote.noteId);
        if (stateNoteId)  ids.push(stateNoteId);
        if (configNoteId) ids.push(configNoteId);
        return [...new Set(ids)];
    }, [stateNoteId, configNoteId]);

    /* Include mode with no subtrees would scan nothing — skip the scan
       and surface a hint in the config panel instead. */
    const includeEmpty = config.mode === 'include'
        && (!config.subtrees || config.subtrees.length === 0);

    const scopeConfigKey = useMemo(() => JSON.stringify({
        mode: config.mode,
        subtrees: (config.subtrees || []).map(s => s.noteId),
    }), [config.mode, config.subtrees]);

    /* Full rescan (⟳ button). Honors current scope config and system exclusions. */
    const reload = useCallback(async () => {
        try {
            if (includeEmpty) {
                setAllTasks([]);   // nothing to scan; preserve JSON state
                return;
            }
            const tasks = await fetchAllTasks({ scanArchived, config, systemNoteIds });
            setAllTasks(tasks);
            setPlannerData(prev => applyDateSuffixes(tasks, prev));
        } catch (err) {
            console.error('reload:', err);
            setError(String(err.message || err));
        }
    }, [applyDateSuffixes, scanArchived, config, systemNoteIds, includeEmpty]);

    /* Persist scope config on change (debounced). The note exists by now. */
    useEffect(() => {
        if (!configLoaded) return;
        if (skipFirstConfigSaveRef.current) {
            skipFirstConfigSaveRef.current = false;
            return;
        }
        clearTimeout(configSaveDebounceRef.current);
        configSaveDebounceRef.current = setTimeout(async () => {
            try {
                await savePlannerConfig(config);
            } catch (err) {
                console.error('Config save failed:', err);
                setError(String(err.message || err));
            }
        }, 400);
        return () => clearTimeout(configSaveDebounceRef.current);
    }, [config, configLoaded]);

    /* Auto-rescan when scope config changes (debounced), so the user doesn't
       have to press ⟳. */
    const skipFirstConfigReloadRef = useRef(true);
    useEffect(() => {
        if (!configLoaded) return;
        if (skipFirstConfigReloadRef.current) {
            skipFirstConfigReloadRef.current = false;
            return;
        }
        clearTimeout(configReloadDebounceRef.current);
        configReloadDebounceRef.current = setTimeout(() => {
            reload();
        }, 500);
        return () => clearTimeout(configReloadDebounceRef.current);
    // eslint-disable-next-line — reload uses the latest config; only scope changes rescan.
    }, [scopeConfigKey, configLoaded]);

    /* Single-note rescan after mark-done/capture. Replaces that note's tasks
       with freshly-scanned ones, keeping per-kind indices accurate. */
    const reloadNote = useCallback(async (noteId) => {
        try {
            const fresh = await fetchTasksForNote(noteId, { scanArchived });
            setAllTasks(prev => {
                const others = prev.filter(t => t.noteId !== noteId);
                return [...others, ...fresh];
            });
            setPlannerData(prev => applyDateSuffixes(fresh, prev));
        } catch (err) {
            console.error('reloadNote:', err);
            await reload();   // fall back to a full reload
        }
    }, [applyDateSuffixes, scanArchived, reload]);

    /* Mark done: optimistic remove + per-note re-fetch to refresh kind indices. */
    const markDone = useCallback(async (task) => {
        // Recurring tasks don't get marked DONE: completion advances the due
        // date along the cadence grid (see nextRecurDate), relocates the card,
        // and leaves the source line intact so it recurs. Only #plannerdata
        // changes — no note write, no re-scan.
        if (task.interval) {
            const todayIso = toLocalIsoDate(todayBase());
            setPlannerData(prev => {
                let next = { ...prev };
                const oldDay = next[task.id];
                const newDate = nextRecurDate(oldDay, task.interval, todayIso);
                if (oldDay && oldDay !== newDate && next._order && next._order[oldDay]) {
                    next._order = {
                        ...next._order,
                        [oldDay]: next._order[oldDay].filter(id => id !== task.id),
                    };
                }
                next[task.id] = newDate;                       // advance + relocate
                next = withOrderUpdate(next, newDate, task.id, null, allTasks);
                if (next._progress && task.id in next._progress) {  // fresh cycle
                    const nextProgress = { ...next._progress };
                    delete nextProgress[task.id];
                    next._progress = nextProgress;
                }
                return next;
            });
            return;
        }

        // One-off: remove optimistically, then write DONE and re-scan the note.
        setAllTasks(prev => prev.filter(t => t.id !== task.id));
        setPlannerData(prev => {
            const next = { ...prev };
            const oldDay = next[task.id];
            delete next[task.id];
            if (oldDay && next._order && next._order[oldDay]) {
                next._order = {
                    ...next._order,
                    [oldDay]: next._order[oldDay].filter(id => id !== task.id),
                };
            }
            if (next._progress && task.id in next._progress) {
                const nextProgress = { ...next._progress };
                delete nextProgress[task.id];
                next._progress = nextProgress;
            }
            return next;
        });

        try {
            await markTaskDone(task, theme.colorDoneText);
            // Re-scan only the source note to refresh its task indices.
            await reloadNote(task.noteId);
        } catch (err) {
            console.error('markDone:', err);
            alert(`Mark done failed: ${err.message || err}`);
            await reload();
        }
    }, [reload, reloadNote, theme, allTasks]);

    /* Dismiss an overdue badge: clear the stored schedule so the task drops
       back to the backlog as unscheduled. */
    const dismissOverdue = useCallback((task) => {
        setPlannerData(prev => {
            const oldDay = prev[task.id];
            if (!oldDay) return prev;   // nothing to dismiss
            const next = { ...prev };
            delete next[task.id];
            if (next._order && next._order[oldDay]) {
                next._order = {
                    ...next._order,
                    [oldDay]: next._order[oldDay].filter(id => id !== task.id),
                };
            }
            return next;
        });
    }, []);

    const capture = useCallback(async (rawText) => {
        setCapturing(true);
        try {
            const dailyNote = await appendTodoToToday(rawText);
            // Re-scan only today's daily note for the newly-added task.
            if (dailyNote && dailyNote.noteId) {
                await reloadNote(dailyNote.noteId);
            } else {
                await reload();   // shouldn't happen, but fall back
            }
        } catch (err) {
            console.error('capture:', err);
            alert(`Capture failed: ${err.message || err}`);
        } finally {
            setCapturing(false);
        }
    }, [reload, reloadNote]);

    /* Set a task's progress (0/25/50/75) in _progress, keyed by task id;
       0 removes the key. Completion is the separate ✓ button (markDone). */
    const setProgress = useCallback((task, value) => {
        const v = Math.max(0, Math.min(75, Math.round(value)));
        setPlannerData(prev => {
            const cur = prev._progress || {};
            const nextProgress = { ...cur };
            if (v === 0) delete nextProgress[task.id];
            else nextProgress[task.id] = v;
            return { ...prev, _progress: nextProgress };
        });
    }, []);

    /* Drag */
    const onCardDragStart = useCallback((task, e) => {
        dragState.current.id = task.id;
        dragState.current.dragMoved = true;
        e.dataTransfer.effectAllowed = 'move';
        setTimeout(() => {
            const el = e.target.closest('.pl-task');
            if (el) el.classList.add('dragging');
        }, 0);
    }, []);

    const onCardDragEnd = useCallback((e) => {
        const el = e.target.closest('.pl-task');
        if (el) el.classList.remove('dragging');
        setInsertMarker({ col: null, beforeId: null });
        dragState.current.id = null;
        dragState.current.insertBeforeId = null;
        setTimeout(() => { dragState.current.dragMoved = false; }, 50);
    }, []);

    const onZoneDragOver = useCallback((col, e) => {
        e.preventDefault();
        const zone = e.currentTarget;
        zone.classList.add('drag-over');
        if (col === 'backlog') {
            setInsertMarker({ col: null, beforeId: null });
            return;
        }
        const cards = Array.from(zone.querySelectorAll('.pl-task:not(.dragging)'));
        let beforeId = '__end__';
        for (const card of cards) {
            const rect = card.getBoundingClientRect();
            if (e.clientY < rect.top + rect.height / 2) {
                beforeId = card.dataset.taskId;
                break;
            }
        }
        dragState.current.insertBeforeId = beforeId;
        setInsertMarker({ col, beforeId });
    }, []);

    const onZoneDragLeave = useCallback((e) => {
        const zone = e.currentTarget;
        if (!zone.contains(e.relatedTarget)) {
            zone.classList.remove('drag-over');
            setInsertMarker({ col: null, beforeId: null });
        }
    }, []);

    const onZoneDrop = useCallback((col, e) => {
        e.preventDefault();
        const zone = e.currentTarget;
        zone.classList.remove('drag-over');
        const id = dragState.current.id;
        if (!id) return;

        setPlannerData(prev => {
            let next = { ...prev };
            if (col === 'backlog') {
                const oldDay = next[id];
                delete next[id];
                if (oldDay && next._order && next._order[oldDay]) {
                    next._order = {
                        ...next._order,
                        [oldDay]: next._order[oldDay].filter(x => x !== id),
                    };
                }
            } else {
                const oldDay = next[id];
                if (oldDay && oldDay !== col && next._order && next._order[oldDay]) {
                    next._order = {
                        ...next._order,
                        [oldDay]: next._order[oldDay].filter(x => x !== id),
                    };
                }
                next[id] = col;
                const insertBefore = dragState.current.insertBeforeId === '__end__'
                    ? null
                    : dragState.current.insertBeforeId;
                next = withOrderUpdate(next, col, id, insertBefore, allTasks);
            }
            return next;
        });
        setInsertMarker({ col: null, beforeId: null });
    }, [allTasks]);

    /* Resize */
    const backlogWidthRef = useRef(backlogWidth);
    useEffect(() => { backlogWidthRef.current = backlogWidth; }, [backlogWidth]);

    const onResizeStart = useCallback((e) => {
        e.preventDefault();
        e.stopPropagation();
        const startX = e.clientX;
        const startWidth = backlogWidth;
        setIsResizing(true);
        document.body.classList.add('pl-resizing');

        const onMove = (ev) => {
            let w = startWidth + (ev.clientX - startX);
            if (w < BACKLOG_WIDTH_MIN) w = BACKLOG_WIDTH_MIN;
            if (w > BACKLOG_WIDTH_MAX) w = BACKLOG_WIDTH_MAX;
            setBacklogWidth(w);
        };
        const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            setIsResizing(false);
            document.body.classList.remove('pl-resizing');
            setPlannerData(prev => ({ ...prev, _backlogWidth: Math.round(backlogWidthRef.current) }));
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    }, [backlogWidth]);

    /* Open the source note: split panel by default; new tab on
       Ctrl/Cmd/Shift/middle-click. Falls back to activateNote. */
    const onCardClick = useCallback((task, e) => {
        if (dragState.current.dragMoved) return;
        const wantsNewTab = e && (e.ctrlKey || e.metaKey || e.shiftKey || e.button === 1);
        try {
            if (wantsNewTab) {
                api.openTabWithNote(task.noteId, true);
            } else {
                api.openSplitWithNote(task.noteId, true);
            }
        } catch (err) {
            console.error('open failed, falling back:', err);
            activateNote(task.noteId);
        }
    }, []);

    const requestClearVisible = useCallback((e, visibleKeys, scopeLabel) => {
        if (e) {
            e.preventDefault();
            e.stopPropagation();
        }
        setPendingClear({
            keys: Array.from(visibleKeys),
            scopeLabel,
        });
    }, []);

    const confirmClearVisible = useCallback(() => {
        if (!pendingClear) return;
        const keys = new Set(pendingClear.keys);
        setPlannerData(prev => {
            const next = { ...prev };
            for (const t of allTasks) {
                if (keys.has(next[t.id])) delete next[t.id];
            }
            return next;
        });
        setPendingClear(null);
    }, [allTasks, pendingClear]);

    const cancelClearVisible = useCallback(() => {
        setPendingClear(null);
    }, []);

    /* Compact #plannerdata: full scan of every note (ignoring scope, including
       archived), then drop entries for tasks that truly no longer exist. Opens
       a confirm dialog with the count; nothing is written until confirmed. */
    const requestCompact = useCallback(async () => {
        setCompacting(true);
        try {
            const [liveTasks, sets] = await Promise.all([
                fetchAllTasks({ scanArchived: true, config: { mode: 'exclude', subtrees: [] }, systemNoteIds }),
                fetchNoteIdSets(),
            ]);
            const { data, removed } = compactPlannerData(plannerData, {
                liveIds: new Set(liveTasks.map(t => t.id)),
                readableNoteIds: sets.readableNoteIds,
                existingNoteIds: sets.existingNoteIds,
            });
            setPendingCompact({ removed, data });
        } catch (err) {
            console.error('compact:', err);
            alert(`Compact failed: ${err.message || err}`);
        } finally {
            setCompacting(false);
        }
    }, [plannerData, systemNoteIds]);

    const confirmCompact = useCallback(() => {
        if (pendingCompact && pendingCompact.data) setPlannerData(pendingCompact.data);
        setPendingCompact(null);
    }, [pendingCompact]);

    const cancelCompact = useCallback(() => setPendingCompact(null), []);

    /* Derived */
    const mobile = useMobile();
    const weekCols = useMemo(() => getWeekCols(weekOffset), [weekOffset]);
    const dayCol = useMemo(() => getDayCol(dayOffset), [dayOffset]);
    const visibleDateCols = useMemo(() => {
        if (viewMode === VIEW_MODES.DAY) return [dayCol];
        if (viewMode === VIEW_MODES.WORK) return weekCols.slice(0, 5);
        return weekCols;
    }, [viewMode, weekCols, dayCol]);
    const wkLabel  = useMemo(() => weekLabel(visibleDateCols), [visibleDateCols]);
    const visibleKeys = useMemo(() => new Set(visibleDateCols.map(c => c.key)), [visibleDateCols]);
    const isCurrentRange = viewMode === VIEW_MODES.DAY ? dayOffset === 0 : weekOffset === 0;
    const clearScopeLabel = viewMode === VIEW_MODES.DAY
        ? 'day'
        : (viewMode === VIEW_MODES.WORK ? 'workweek' : 'week');

    const filteredTasks = useMemo(
        () => applyFilters(allTasks, filters),
        [allTasks, filters]
    );

    const total   = filteredTasks.length;
    const planned = filteredTasks.filter(t => visibleKeys.has(plannerData[t.id])).length;
    // Recomputed every render — cheap, and keeps overdue accurate if the
    // planner is left open across midnight.
    const todayIso = toLocalIsoDate(todayBase());
    const backlog = getBacklog(filteredTasks, plannerData, todayIso);
    const overdueCount = backlog.reduce((n, t) => n + (t.isOverdue ? 1 : 0), 0);
    const unplannedCount = backlog.length - overdueCount;
    const subtreeCount = (config.subtrees || []).length;

    // Backlog header text: "5 unplanned · 2 overdue" or just "5 unplanned"
    const backlogLabel = overdueCount > 0
        ? `${unplannedCount} unplanned · ${overdueCount} overdue`
        : `${unplannedCount} unplanned`;

    const allCols = [
        { key: 'backlog', label: 'Backlog', dateStr: backlogLabel, isToday: false, isBacklog: true },
        ...visibleDateCols.map(c => ({ ...c, isBacklog: false })),
    ];

    const moveDateRange = useCallback((delta) => {
        if (viewMode === VIEW_MODES.DAY) setDayOffset(d => d + delta);
        else setWeekOffset(w => w + delta);
    }, [viewMode]);

    const jumpToToday = useCallback(() => {
        setWeekOffset(0);
        setDayOffset(0);
    }, []);

    if (loading && allTasks.length === 0) {
        return <div style={{ padding: '24px', color: theme.textMuted }}>Loading…</div>;
    }
    if (error) {
        return <div style={{ padding: '24px', color: '#c34' }}>✗ {error}</div>;
    }

    return (
        <div class="pl-root">
            <div class="pl-header">
                <span style={{ fontSize: '18px', fontWeight: 700 }}>Planner</span>
                <button
                    class="pl-btn icon"
                    onClick={() => moveDateRange(-1)}
                    title={viewMode === VIEW_MODES.DAY ? 'Previous day' : 'Previous week'}
                >‹</button>
                <span style={{ fontSize: '16px', color: theme.textMuted, whiteSpace: 'nowrap' }}>
                    {wkLabel}
                </span>
                <button
                    class="pl-btn icon"
                    onClick={() => moveDateRange(1)}
                    title={viewMode === VIEW_MODES.DAY ? 'Next day' : 'Next week'}
                >›</button>
                <div class="pl-view-toggle" title="Choose planner date columns">
                    <button
                        class={`pl-view-btn${viewMode === VIEW_MODES.WEEK ? ' active' : ''}`}
                        onClick={() => setViewMode(VIEW_MODES.WEEK)}
                        title="Show Monday to Sunday"
                    >Week</button>
                    <button
                        class={`pl-view-btn${viewMode === VIEW_MODES.WORK ? ' active' : ''}`}
                        onClick={() => setViewMode(VIEW_MODES.WORK)}
                        title="Show Monday to Friday"
                    >Work</button>
                    <button
                        class={`pl-view-btn${viewMode === VIEW_MODES.DAY ? ' active' : ''}`}
                        onClick={() => setViewMode(VIEW_MODES.DAY)}
                        title="Show one day"
                    >Day</button>
                </div>
                {!isCurrentRange && (
                    <button class="pl-btn muted" onClick={jumpToToday}>today</button>
                )}
                <span style={{ fontSize: '14px', color: theme.textMuted, marginLeft: 'auto' }}>
                    {planned}/{total} planned
                </span>
                <button
                    class="pl-btn muted"
                    onClick={(e) => requestClearVisible(e, visibleKeys, clearScopeLabel)}
                    title={`Clear this ${clearScopeLabel}`}
                >↺</button>
                <button
                    class="pl-btn muted"
                    onClick={reload}
                    disabled={includeEmpty}
                    title={includeEmpty
                        ? 'Include mode is empty — add a subtree to scan'
                        : 'Reload tasks'}
                >⟳</button>
                <button
                    class={`pl-btn muted${showConfig ? ' active' : ''}`}
                    onClick={() => setShowConfig(s => !s)}
                    title="Configure scope (include/exclude subtrees)"
                >
                    ⚙
                    {subtreeCount > 0 && (
                        <span class="pl-badge">
                            {config.mode === 'include' ? '+' : '−'}{subtreeCount}
                        </span>
                    )}
                </button>
                <button
                    class="pl-btn muted pl-icon-btn"
                    onClick={requestCompact}
                    disabled={compacting}
                    title="Tidy up: remove planner entries whose source task no longer exists (your notes and tasks are not touched)"
                    aria-label="Compact planner state"
                >
                    <svg viewBox="0 0 24 24" width="15" height="15" fill="none"
                         stroke="currentColor" stroke-width="0.8"
                         stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                          <path d="m 20.621623,2.0298933 -6.901428,6.901423 -0.884242,-0.884249 v -0.0213 l -0.0213,-0.0213 c -0.442115,-0.393937 -1.019032,-0.582649 -1.574381,-0.582649 -0.55535,0 -1.091829,0.207611 -1.5096857,0.625439 l -0.107826,0.08626 -0.345049,0.345089 -0.237212,0.19412 -6.297549,4.8957007 -0.603873,0.49603 7.440596,7.440602 0.4960357,-0.603876 4.87413,-6.254417 0.0213,0.0213 0.690146,-0.690143 h 0.0213 l 0.0213,-0.0213 c 0.787198,-0.886938 0.792591,-2.248348 -0.04313,-3.084072 l -0.948949,-0.9489397 6.901423,-6.901423 z m -9.381621,6.772016 c 0.212997,-0.0057 0.447514,0.06742 0.625437,0.215641 0.0081,0.0057 0.01322,0.01615 0.0213,0.0213 l 2.803703,2.8037017 c 0.258796,0.258796 0.283064,0.808763 0,1.164617 -0.01084,0.01328 -0.01084,0.02953 -0.0213,0.04314 l -0.215693,0.194122 -3.989885,-3.9898847 0.237212,-0.237212 c 0.132099,-0.132096 0.326214,-0.210255 0.539175,-0.215642 z m -1.8331947,1.3371547 4.0977227,4.09772 -4.0545867,5.176064 -0.992082,-0.992079 1.488121,-1.552815 -0.99208,-0.948951 -1.466552,1.531259 -0.905813,-0.905815 2.674304,-2.695869 -0.970513,-0.970518 -2.695872,2.674309 -1.358715,-1.35872 z" />
                    </svg>
                </button>
                <FilterDropdown
                    allTasks={allTasks}
                    filters={filters}
                    onChange={setFilters}
                    overrides={colorOverrides}
                />
            </div>

            {pendingClear && (
                <div
                    class="pl-confirm-overlay"
                    onClick={cancelClearVisible}
                    onMouseDown={(e) => e.stopPropagation()}
                >
                    <div class="pl-confirm-dialog" onClick={(e) => e.stopPropagation()}>
                        <div class="pl-confirm-title">Clear this {pendingClear.scopeLabel}?</div>
                        <div class="pl-confirm-body">
                            This removes the visible planning assignments only. The tasks stay in their source notes and unplanned tasks are not deleted.
                        </div>
                        <div class="pl-confirm-actions">
                            <button class="pl-btn muted" onClick={cancelClearVisible}>Cancel</button>
                            <button class="pl-btn danger" onClick={confirmClearVisible}>Clear</button>
                        </div>
                    </div>
                </div>
            )}

            {pendingCompact && (
                <div
                    class="pl-confirm-overlay"
                    onClick={cancelCompact}
                    onMouseDown={(e) => e.stopPropagation()}
                >
                    <div class="pl-confirm-dialog" onClick={(e) => e.stopPropagation()}>
                        {pendingCompact.removed > 0 ? (
                            <>
                                <div class="pl-confirm-title">
                                    Remove {pendingCompact.removed} orphaned {pendingCompact.removed === 1 ? 'entry' : 'entries'}?
                                </div>
                                <div class="pl-confirm-body">
                                    These are planner entries whose source task no longer exists (line deleted or edited). Tasks in protected or unreadable notes are kept. Source notes are not changed.
                                </div>
                                <div class="pl-confirm-actions">
                                    <button class="pl-btn muted" onClick={cancelCompact}>Cancel</button>
                                    <button class="pl-btn danger" onClick={confirmCompact}>Remove</button>
                                </div>
                            </>
                        ) : (
                            <>
                                <div class="pl-confirm-title">Nothing to compact</div>
                                <div class="pl-confirm-body">No orphaned entries were found.</div>
                                <div class="pl-confirm-actions">
                                    <button class="pl-btn muted" onClick={cancelCompact}>Close</button>
                                </div>
                            </>
                        )}
                    </div>
                </div>
            )}

            {showConfig && (
                <ConfigPanel
                    config={config}
                    onChange={setConfig}
                />
            )}

            <CapturePanel onCapture={capture} working={capturing} />

            <div class="pl-board">
                {allCols.map(col => {
                    const tasks = col.isBacklog
                        ? backlog
                        : getDayTasks(filteredTasks, plannerData, col.key);

                    let widthStyle;
                    if (col.isBacklog) {
                        widthStyle = mobile
                            ? { width: '200px', flex: '0 0 auto' }
                            : { width: `${backlogWidth}px`, flex: `0 0 ${backlogWidth}px` };
                    } else {
                        widthStyle = mobile
                            ? { width: '130px', flex: '0 0 auto' }
                            : { flex: '1 1 0', minWidth: viewMode === VIEW_MODES.DAY ? '260px' : '120px' };
                    }

                    const marker = insertMarker.col === col.key ? insertMarker.beforeId : null;

                    return (
                        <Column
                            key={col.key}
                            col={col}
                            tasks={tasks}
                            mobile={mobile}
                            isResizing={col.isBacklog && isResizing}
                            widthStyle={widthStyle}
                            overrides={colorOverrides}
                            progressMap={plannerData._progress}
                            insertMarkerBeforeId={marker}
                            onCardClick={onCardClick}
                            onCardMarkDone={markDone}
                            onCardSetProgress={setProgress}
                            onCardDismissOverdue={dismissOverdue}
                            onCardDragStart={onCardDragStart}
                            onCardDragEnd={onCardDragEnd}
                            onDragOver={(e) => onZoneDragOver(col.key, e)}
                            onDragLeave={onZoneDragLeave}
                            onDrop={(e) => onZoneDrop(col.key, e)}
                            onResizeStart={onResizeStart}
                        />
                    );
                })}
            </div>
        </div>
    );
}

function useMobile() {
    const [mobile, setMobile] = useState(() => window.innerWidth < 700);
    useEffect(() => {
        let t = null;
        const onResize = () => {
            clearTimeout(t);
            t = setTimeout(() => setMobile(window.innerWidth < 700), 150);
        };
        window.addEventListener('resize', onResize);
        return () => { window.removeEventListener('resize', onResize); clearTimeout(t); };
    }, []);
    return mobile;
}

export default PlannerApp;
