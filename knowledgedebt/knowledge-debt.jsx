/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║         Knowledge Debt — TriliumNext (Preact)               ║
 * ║                                                             ║
 * ║   Orphans │ Stubs │ Empty │ Old TODOs │ Abandoned          ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 * Health dashboard for your PKM. Detects:
 *   • Orphans    — notes with no inbound internal links
 *   • Stubs      — content between 1–250 chars (drafts never developed)
 *   • Empty      — null content or empty paragraph
 *   • Old TODOs  — note with a *todo* label, unmodified > 30 days
 *   • Abandoned  — no children, no modification > 90 days
 *
 * SETUP:
 *   1. Options → Code Notes → enable "JSX"
 *   2. Create a new code note, language: JSX
 *   3. Paste this code into it
 *   4. In your Render note, set ~renderNote → this JSX note
 *
 * v1: read-only dashboard.
 * v2 (planned): per-subtree exclusion config via a #kdConfig note.
 */

import { useEffect, useState, useCallback, useMemo, useRef } from "trilium:preact";
import {
    runOnBackend,
    runAsyncOnBackendWithManualTransactionHandling,  // unused in v1, wired for v2
    activateNote,
} from "trilium:api";

/* ═══════════════════════════════════════════════════════════════
   CONSTANTS — tabs, columns, type whitelist
══════════════════════════════════════════════════════════════════ */

const TABS = [
    { key: 'orphans',   label: 'Orphans',     color: '#d97070', icon: '🔴' },
    { key: 'stubs',     label: 'Stubs',       color: '#c9984a', icon: '🟠' },
    { key: 'empty',     label: 'Empty',       color: '#9b7ec8', icon: '🟣' },
    { key: 'todos',     label: 'Old TODOs',   color: '#6b95c4', icon: '🔵' },
    { key: 'abandoned', label: 'Abandoned',   color: '#68a87c', icon: '🟢' },
];

/* Column definitions per tab. Each column has:
     label  — header text
     field  — note property used for sorting
     kind   — 'string' | 'number' | 'date' — picks the right comparator
   Add a column here and the table/sort logic picks it up automatically. */
const COL_TITLE    = { label: 'Note',          field: 'title',         kind: 'string' };
const COL_TYPE     = { label: 'Type',          field: 'type',          kind: 'string' };
const COL_MODIFIED = { label: 'Last modified', field: 'dateModified',  kind: 'date'   };
const COL_SIZE     = { label: 'Size',          field: 'contentLen',    kind: 'number' };
const COL_LABEL    = { label: 'Label',         field: 'todoLabel',     kind: 'string' };

const COLS = {
    orphans:   [COL_TITLE, COL_TYPE,  COL_MODIFIED],
    stubs:     [COL_TITLE, COL_TYPE,  COL_MODIFIED, COL_SIZE],
    empty:     [COL_TITLE, COL_TYPE,  COL_MODIFIED],
    todos:     [COL_TITLE, COL_LABEL, COL_MODIFIED],
    abandoned: [COL_TITLE, COL_TYPE,  COL_MODIFIED],
};

/* Generic comparator that respects column kind and direction. */
function makeComparator(field, kind, dir) {
    const sign = dir === 'desc' ? -1 : 1;
    const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
    return (a, b) => {
        const va = a[field];
        const vb = b[field];
        // null/undefined sort to the bottom regardless of direction
        if (va == null && vb == null) return 0;
        if (va == null) return 1;
        if (vb == null) return -1;
        if (kind === 'number') return sign * ((+va) - (+vb));
        if (kind === 'date')   return sign * (String(va).localeCompare(String(vb)));
        return sign * collator.compare(String(va), String(vb));
    };
}

/* Note types considered "user content". Trilium's internal notes
   (doc, launcher, search, book, webView, ...) are excluded. */
const USER_TYPES = ['text', 'code'];

const STUB_MIN = 1;
const STUB_MAX = 250;
const TODO_DAYS = 30;
const ABANDONED_DAYS = 90;

/* Pagination — rows shown per page in the table.
   The backend fetches everything; pagination is purely client-side
   so page navigation is instant and search filters the full set. */
const PAGE_SIZE = 100;

/* Hard ceilings on per-category result size. Generous — protects against
   pathological databases without truncating any realistic case. */
const MAX_RESULTS = {
    orphans:   5000,
    stubs:     2000,
    empty:     2000,
    todos:     2000,
    abandoned: 2000,
};

/* ═══════════════════════════════════════════════════════════════
   HELPERS
══════════════════════════════════════════════════════════════════ */

function daysSince(dateStr) {
    if (!dateStr) return null;
    return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86_400_000);
}

function daysLabel(dateStr) {
    const d = daysSince(dateStr);
    if (d === null) return '—';
    if (d === 0) return 'today';
    if (d === 1) return 'yesterday';
    return `${d} days ago`;
}

function nowTimeStr() {
    return new Date().toLocaleTimeString();
}

/* Open a note: split-pane by default, new tab on modifier/middle-click. */
function openNote(noteId, e) {
    const wantsNewTab = e && (e.ctrlKey || e.metaKey || e.shiftKey || e.button === 1);
    try {
        if (wantsNewTab) api.openTabWithNote(noteId, true);
        else             api.openSplitWithNote(noteId, true);
    } catch (err) {
        console.error('openNote: falling back to activateNote', err);
        try { activateNote(noteId); } catch (e2) { console.error(e2); }
    }
}

/* ═══════════════════════════════════════════════════════════════
   BACKEND SCAN
══════════════════════════════════════════════════════════════════ */

async function runScan(config, systemNoteIds) {
    return await runOnBackend((userTypes, stubMin, stubMax, todoDays, abandonedDays,
                                MAX_ORPHANS, MAX_STUBS, MAX_EMPTY, MAX_TODOS, MAX_ABANDONED,
                                cfgMode, cfgSubtreeRoots, sysNoteIds) => {

        /* Execute SQL safely; on error return fallback (default: []). */
        function safe(sql, fallback) {
            try { return api.sql.getRows(sql); }
            catch (e) { return fallback !== undefined ? fallback : []; }
        }

        /* Quote a JS array of strings into a SQL IN-list. */
        function sqlList(arr) {
            return arr.map(v => "'" + String(v).replace(/'/g, "''") + "'").join(',');
        }

        /* Discover which tables exist in this TriliumNext version. */
        const tableNames = new Set(
            api.sql.getRows("SELECT name FROM sqlite_master WHERE type='table'").map(r => r.name)
        );
        const tables = [...tableNames].sort();

        /* ── Subtree expansion ──────────────────────────────────────
           Given a list of root noteIds, walk the branches table to find
           every descendant. Returns a Set of all expanded noteIds
           (including the roots themselves). */
        function expandSubtrees(rootIds) {
            const expanded = new Set();
            if (!rootIds || !rootIds.length) return expanded;

            let frontier = rootIds.filter(id => id);
            for (const id of frontier) expanded.add(id);

            // Iterative BFS through the branches table.
            // Bounded to 50 levels deep as a sanity cap.
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

        /* ── Common filters ─────────────────────────────────────── */

        // System root notes — these and everything underneath should be skipped.
        // TriliumNext convention: internal noteIds start with underscore.
        // Combine an explicit root list with a LIKE '\_%' guard to be safe.
        const NOT_SYSTEM = `(
            n.noteId NOT LIKE '\\_%' ESCAPE '\\'
            AND n.noteId NOT IN ('root')
        )`;

        // User-content type whitelist
        const TYPE_WHITELIST = `n.type IN (${sqlList(userTypes)})`;

        // Exclude notes with the #archived label (not yet inheritance-aware)
        const NOT_ARCHIVED = `n.noteId NOT IN (
            SELECT noteId FROM attributes
            WHERE name = 'archived' AND isDeleted = 0
        )`;

        // Has no children (used for stubs/empty/abandoned)
        const NO_CHILDREN = `n.noteId NOT IN (
            SELECT DISTINCT parentNoteId FROM branches WHERE isDeleted = 0
        )`;

        // Always exclude infrastructure notes (config note, dashboard note, JSX note).
        // Hardcoded — invisible to user, survives config resets.
        const NOT_INFRASTRUCTURE = sysNoteIds && sysNoteIds.length
            ? `n.noteId NOT IN (${sqlList(sysNoteIds)})`
            : '1=1';

        // Apply user config: include/exclude subtrees from #kdConfig
        const expandedSubtrees = expandSubtrees(cfgSubtreeRoots);
        const expandedArr = [...expandedSubtrees];
        let CONFIG_SCOPE = '1=1';
        if (expandedArr.length) {
            const list = sqlList(expandedArr);
            CONFIG_SCOPE = cfgMode === 'include'
                ? `n.noteId IN (${list})`
                : `n.noteId NOT IN (${list})`;
        }

        const BASE_FILTER = `
            n.isDeleted = 0
            AND n.isProtected = 0
            AND ${NOT_SYSTEM}
            AND ${TYPE_WHITELIST}
            AND ${NOT_ARCHIVED}
            AND ${NOT_INFRASTRUCTURE}
            AND ${CONFIG_SCOPE}
        `;

        /* ── ① Orphans ──────────────────────────────────────────── */
        /* A note is an orphan if NOTHING points to it. We consider three
           kinds of incoming references:
             a) Inline links — any <a href="#root/.../<id>">, including both
                  auto-titled (with class="reference-link") and custom-titled
                  links (which Trilium emits without the class). Both forms
                  are scanned from note content via regex.
             b) Relation attributes — ~someRelation=<id>
                  queried from the attributes table
             c) (optional, schema-dependent) a dedicated link table
                  not present in current TriliumNext versions
           Union of all referenced noteIds = the "reached" set.
           Orphans = user-content notes whose noteId is not in that set.

           Content prefilter: GLOB on '*href="#root*' so we only fetch and
           regex-scan notes that actually contain a Trilium link. This
           matches both reference-link and custom-title forms. */
        const referenced = new Set();

        // (a) Inline links from note content (both reference-link and custom-title).
        //     Protected notes are skipped: their content is encrypted and not
        //     readable by background scripts, so the GLOB never matches anyway.
        const linkCandidates = safe(`
            SELECT b.content
            FROM notes n
            JOIN blobs b ON b.blobId = n.blobId
            WHERE n.isDeleted = 0
              AND n.isProtected = 0
              AND n.type IN ('text','code')
              AND b.content GLOB '*href="#root*'
        `, []);
        // Match href="#root/.../<noteId>" or href="#root/<noteId>" (root-level)
        const LINK_RE = /href="#root\/(?:[^"\/]+\/)*([a-zA-Z0-9_]+)"/g;
        for (const row of linkCandidates) {
            if (!row.content) continue;
            let m;
            LINK_RE.lastIndex = 0;
            while ((m = LINK_RE.exec(row.content)) !== null) {
                referenced.add(m[1]);
            }
        }
        const inlineRefCount = referenced.size;

        // (b) Relation-attribute targets
        const relationRows = safe(`
            SELECT DISTINCT value FROM attributes
            WHERE type = 'relation' AND isDeleted = 0 AND value != ''
        `, []);
        for (const r of relationRows) {
            if (r.value) referenced.add(r.value);
        }

        // (c) Dedicated link table, if the schema has one (future-proofing)
        const linksTable = ['note_links','links','internal_links','note_link']
            .find(t => tableNames.has(t));
        if (linksTable) {
            const cols = api.sql.getRows(`PRAGMA table_info(${linksTable})`).map(r => r.name);
            const targetCol = cols.includes('targetNoteId') ? 'targetNoteId'
                            : cols.includes('noteId_to')   ? 'noteId_to'
                            : cols.includes('targetId')    ? 'targetId'
                            : null;
            const deletedWhere = cols.includes('isDeleted') ? 'WHERE isDeleted = 0' : '';
            if (targetCol) {
                const rows = safe(
                    `SELECT DISTINCT ${targetCol} AS v FROM ${linksTable} ${deletedWhere}`,
                    []
                );
                for (const r of rows) {
                    if (r.v) referenced.add(r.v);
                }
            }
        }

        // Build excluded list from the referenced set as a SQL IN-list.
        // SQLite IN-list limit is typically ~32766 — we have at most thousands.
        const referencedArr = [...referenced];
        const excludedClause = referencedArr.length
            ? `AND n.noteId NOT IN (${sqlList(referencedArr)})`
            : '';

        const orphans = safe(`
            SELECT n.noteId, n.title, n.type, n.dateModified
            FROM notes n
            WHERE ${BASE_FILTER}
              ${excludedClause}
            ORDER BY n.dateModified ASC LIMIT ${MAX_ORPHANS}
        `, []);

        /* ── ② Stubs: 1–250 chars, no children ─────────────────── */
        const stubs = safe(`
            SELECT n.noteId, n.title, n.type, n.dateModified,
                   LENGTH(b.content) AS contentLen
            FROM notes n
            JOIN blobs b ON n.blobId = b.blobId
            WHERE ${BASE_FILTER}
              AND ${NO_CHILDREN}
              AND LENGTH(b.content) BETWEEN ${stubMin} AND ${stubMax}
            ORDER BY LENGTH(b.content) ASC
            LIMIT ${MAX_STUBS}
        `);

        /* ── ③ Empty: null/whitespace/empty-paragraph content, no children ── */
        const empty = safe(`
            SELECT n.noteId, n.title, n.type, n.dateModified
            FROM notes n
            LEFT JOIN blobs b ON n.blobId = b.blobId
            WHERE ${BASE_FILTER}
              AND ${NO_CHILDREN}
              AND (
                  b.content IS NULL
                  OR TRIM(b.content) = ''
                  OR b.content = '<p></p>'
                  OR b.content = '<p><br></p>'
                  OR b.content = '<p><br class="ProseMirror-trailingBreak"></p>'
              )
            ORDER BY n.dateModified DESC
            LIMIT ${MAX_EMPTY}
        `);

        /* ── ④ Old TODOs: label LIKE '%todo%', unmodified > N days ── */
        const todos = safe(`
            SELECT DISTINCT n.noteId, n.title, n.type, n.dateModified,
                            a.name AS todoLabel
            FROM notes n
            JOIN attributes a ON n.noteId = a.noteId AND a.isDeleted = 0
            WHERE ${BASE_FILTER}
              AND LOWER(a.name) LIKE '%todo%'
              AND CAST((julianday('now') - julianday(n.dateModified)) AS INTEGER) > ${todoDays}
            ORDER BY n.dateModified ASC
            LIMIT ${MAX_TODOS}
        `);

        /* ── ⑤ Abandoned: no children, unmodified > N days ─────── */
        const abandoned = safe(`
            SELECT n.noteId, n.title, n.type, n.dateModified
            FROM notes n
            WHERE ${BASE_FILTER}
              AND ${NO_CHILDREN}
              AND CAST((julianday('now') - julianday(n.dateModified)) AS INTEGER) > ${abandonedDays}
            ORDER BY n.dateModified ASC
            LIMIT ${MAX_ABANDONED}
        `);

        return {
            results: { orphans, stubs, empty, todos, abandoned },
            debug: {
                tables,
                inlineRefCount,
                totalReferenced: referenced.size,
                subtreesExpanded: expandedArr.length,
            },
        };
    }, [
        USER_TYPES, STUB_MIN, STUB_MAX, TODO_DAYS, ABANDONED_DAYS,
        MAX_RESULTS.orphans, MAX_RESULTS.stubs, MAX_RESULTS.empty,
        MAX_RESULTS.todos,   MAX_RESULTS.abandoned,
        (config && config.mode) || 'exclude',
        (config && config.subtrees ? config.subtrees.map(s => s.noteId) : []),
        systemNoteIds || [],
    ]);
}

/* ═══════════════════════════════════════════════════════════════
   CONFIG NOTE — load, save, auto-create
══════════════════════════════════════════════════════════════════ */

const CONFIG_LABEL = 'kdConfig';
const DEFAULT_CONFIG = { mode: 'exclude', subtrees: [] };

/* Load config. Returns { config, configNoteId } where configNoteId
   may be null if the note hasn't been created yet. */
async function loadConfig() {
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
        } catch (_) { /* corrupt JSON → use defaults */ }
        return { config: cfg, configNoteId: note.noteId };
    }, [CONFIG_LABEL, DEFAULT_CONFIG]);
}

/* Save config. If the note doesn't exist, create it as a child of parentNoteId
   with the right labels. Returns the (possibly new) noteId. */
async function saveConfig(config, parentNoteId) {
    const json = JSON.stringify(config, null, 2);
    return await runAsyncOnBackendWithManualTransactionHandling(
        async (jsonStr, parentId, label) => {
            let note = api.getNoteWithLabel(label);
            if (!note) {
                const created = await api.createTextNote(
                    parentId,
                    'Knowledge Debt — Config',
                    jsonStr
                );
                note = created.note;
                await note.setLabel(label, '');
                await note.setLabel('hidePromotedAttributes', '');
                await note.setLabel('iconClass', 'bx bx-cog');
            } else {
                note.setContent(jsonStr);
                await note.save();
            }
            return note.noteId;
        },
        [json, parentNoteId, CONFIG_LABEL]
    );
}

/* ═══════════════════════════════════════════════════════════════
   CSS
══════════════════════════════════════════════════════════════════ */

const CSS = `
.kd-root {
    display: flex; flex-direction: column; height: 100%; overflow: hidden;
    font-family: var(--detail-font-family, "Segoe UI", sans-serif);
    font-size: 13px;
    color: var(--main-text-color);
    background: var(--main-background-color);
}

.kd-header {
    display: flex; align-items: center; gap: 10px;
    padding: 10px 16px; flex-shrink: 0;
    border-bottom: 1px solid var(--main-border-color);
}
.kd-title { flex: 1; font-size: 14px; }
.kd-title strong { margin-left: 4px; }

.kd-search {
    padding: 4px 8px; border-radius: 4px; font-size: 12px;
    background: var(--accented-background-color);
    color: var(--main-text-color);
    border: 1px solid var(--main-border-color);
    width: 220px;
}

.kd-btn {
    padding: 6px 16px; cursor: pointer; border-radius: 4px;
    font-size: 12px; font-weight: 500;
    background: var(--accented-background-color);
    color: var(--main-text-color);
    border: 1px solid var(--main-border-color);
}
.kd-btn:hover { opacity: 0.85; }
.kd-btn:disabled { opacity: 0.5; cursor: wait; }

.kd-stats {
    display: grid; grid-template-columns: repeat(5, 1fr);
    gap: 8px; padding: 12px 16px; flex-shrink: 0;
}
.kd-stat-card {
    text-align: center; padding: 10px 4px; border-radius: 5px;
    background: var(--accented-background-color);
    border-top: 3px solid var(--kd-card-color, #888);
    cursor: pointer; transition: opacity 0.15s, box-shadow 0.15s;
}
.kd-stat-card:hover { opacity: 0.85; }
.kd-stat-card.active { box-shadow: 0 0 0 2px var(--main-border-color); }
.kd-stat-num {
    font-size: 24px; font-weight: 700;
    color: var(--kd-card-color, var(--main-text-color));
}
.kd-stat-label {
    font-size: 10px; color: var(--muted-text-color); margin-top: 3px;
}

.kd-table-wrap {
    flex: 1; overflow-y: auto; padding: 0 16px 8px;
}
.kd-table { width: 100%; border-collapse: collapse; }
.kd-th {
    text-align: left; padding: 6px 8px; font-size: 11px;
    color: var(--muted-text-color); font-weight: 600;
    border-bottom: 2px solid var(--main-border-color);
}
.kd-th-sortable {
    cursor: pointer; user-select: none;
}
.kd-th-sortable:hover {
    color: var(--main-text-color);
}
.kd-th-sortable.active {
    color: var(--main-text-color);
}
.kd-row { border-bottom: 1px solid var(--main-border-color); }
.kd-row:hover { background: var(--accented-background-color); }
.kd-td {
    padding: 5px 8px; font-size: 12px;
}
.kd-td-muted {
    padding: 5px 8px; font-size: 11px; color: var(--muted-text-color);
    white-space: nowrap;
}
.kd-td-accent {
    padding: 5px 8px; font-size: 11px; font-variant-numeric: tabular-nums;
    color: var(--kd-accent-color, var(--main-text-color));
}
.kd-link {
    color: var(--main-text-color); cursor: pointer;
    text-decoration: none; font-weight: 500;
}
.kd-link:hover { text-decoration: underline; }

.kd-empty {
    padding: 24px; text-align: center; color: var(--muted-text-color);
}

.kd-pagination {
    display: flex; align-items: center; justify-content: center;
    gap: 12px; padding: 8px 16px; flex-shrink: 0;
    border-top: 1px solid var(--main-border-color);
}
.kd-page-info {
    font-size: 12px; color: var(--muted-text-color);
    font-variant-numeric: tabular-nums;
}

/* Config panel */
.kd-config-panel {
    padding: 12px 16px;
    background: var(--accented-background-color);
    border-bottom: 1px solid var(--main-border-color);
    flex-shrink: 0;
}
.kd-config-row {
    display: flex; align-items: center; gap: 12px;
    margin-bottom: 10px; flex-wrap: wrap;
}
.kd-config-label {
    font-size: 11px; font-weight: 600; text-transform: uppercase;
    color: var(--muted-text-color); letter-spacing: 0.05em;
}
.kd-mode-toggle {
    display: inline-flex; border: 1px solid var(--main-border-color);
    border-radius: 4px; overflow: hidden;
}
.kd-mode-btn {
    padding: 4px 12px; font-size: 12px; cursor: pointer;
    background: transparent; border: none;
    color: var(--muted-text-color);
}
.kd-mode-btn.active {
    background: var(--main-text-color);
    color: var(--main-background-color);
    font-weight: 600;
}

.kd-dropzone {
    border: 2px dashed var(--main-border-color);
    border-radius: 6px; padding: 12px;
    text-align: center; font-size: 12px;
    color: var(--muted-text-color);
    transition: background 0.15s, border-color 0.15s;
}
.kd-dropzone.over {
    background: rgba(137, 180, 250, 0.10);
    border-color: #89b4fa;
    color: var(--main-text-color);
}

.kd-chips {
    display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px;
}
.kd-chip {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 3px 6px 3px 10px;
    background: var(--main-background-color);
    border: 1px solid var(--main-border-color);
    border-radius: 12px; font-size: 12px;
}
.kd-chip-title { max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kd-chip-x {
    cursor: pointer; padding: 0 4px; border-radius: 50%;
    color: var(--muted-text-color); font-weight: 700;
}
.kd-chip-x:hover { color: #d97070; background: rgba(217,112,112,0.1); }

.kd-config-hint {
    font-size: 11px; color: var(--muted-text-color);
    font-style: italic; margin-top: 6px;
}

.kd-badge {
    display: inline-block; min-width: 16px; height: 16px;
    padding: 0 4px; border-radius: 8px; font-size: 10px;
    line-height: 16px; text-align: center; background: #89b4fa;
    color: #fff; margin-left: 4px; font-weight: 700;
}

.kd-log {
    padding: 6px 16px; font-size: 11px; max-height: 64px;
    overflow-y: auto; font-family: monospace; flex-shrink: 0;
    border-top: 1px solid var(--main-border-color);
    color: var(--muted-text-color);
}
.kd-log-line { margin-bottom: 1px; }
.kd-log-ok   { color: #68a87c; }
.kd-log-warn { color: #c9984a; }
.kd-log-err  { color: #d97070; }
`;

function injectStyle() {
    let el = document.getElementById('kd-preact-styles');
    if (!el) {
        el = document.createElement('style');
        el.id = 'kd-preact-styles';
        document.head.appendChild(el);
    }
    if (el.textContent !== CSS) el.textContent = CSS;
}

/* ═══════════════════════════════════════════════════════════════
   COMPONENTS
══════════════════════════════════════════════════════════════════ */

function StatsBar({ data, activeTab, onSelect, maxResults }) {
    return (
        <div class="kd-stats">
            {TABS.map(({ key, label, color, icon }) => {
                const count = data[key] ? data[key].length : 0;
                const atLimit = maxResults && count >= maxResults[key];
                const isActive = key === activeTab;
                return (
                    <div
                        key={key}
                        class={`kd-stat-card${isActive ? ' active' : ''}`}
                        style={{ '--kd-card-color': color }}
                        onClick={() => onSelect(key)}
                    >
                        <div class="kd-stat-num">
                            {count}{atLimit ? '+' : ''}
                        </div>
                        <div class="kd-stat-label">{icon} {label}</div>
                    </div>
                );
            })}
        </div>
    );
}

function Row({ note, tab, accentColor }) {
    const titleCell = (
        <td class="kd-td">
            <a class="kd-link" onClick={(e) => openNote(note.noteId, e)}>
                {note.title || '(untitled)'}
            </a>
        </td>
    );
    const modifiedCell = (
        <td class="kd-td-muted">{daysLabel(note.dateModified)}</td>
    );

    if (tab === 'stubs') {
        return (
            <tr class="kd-row">
                {titleCell}
                <td class="kd-td-muted">{note.type || '—'}</td>
                {modifiedCell}
                <td class="kd-td-accent" style={{ '--kd-accent-color': accentColor }}>
                    {note.contentLen} chars
                </td>
            </tr>
        );
    }
    if (tab === 'todos') {
        return (
            <tr class="kd-row">
                {titleCell}
                <td class="kd-td-accent" style={{ '--kd-accent-color': accentColor }}>
                    #{note.todoLabel || 'todo'}
                </td>
                {modifiedCell}
            </tr>
        );
    }
    return (
        <tr class="kd-row">
            {titleCell}
            <td class="kd-td-muted">{note.type || '—'}</td>
            {modifiedCell}
        </tr>
    );
}

function SortableHeaders({ cols, sort, onSort }) {
    return (
        <tr>
            {cols.map(c => {
                const isSorted = sort && sort.field === c.field;
                const arrow = isSorted ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '';
                return (
                    <th
                        key={c.field}
                        class={`kd-th kd-th-sortable${isSorted ? ' active' : ''}`}
                        onClick={() => onSort(c)}
                        title="Click to sort"
                    >
                        {c.label}{arrow}
                    </th>
                );
            })}
        </tr>
    );
}

function DebtTable({ tab, items, scanning, accentColor, sort, onSort }) {
    const cols = COLS[tab] || [COL_TITLE];

    if (!items.length) {
        return (
            <table class="kd-table">
                <thead>
                    <SortableHeaders cols={cols} sort={sort} onSort={onSort} />
                </thead>
                <tbody>
                    <tr>
                        <td class="kd-empty" colSpan={cols.length}>
                            {scanning ? 'Scanning…' : 'No notes found here 👌'}
                        </td>
                    </tr>
                </tbody>
            </table>
        );
    }

    return (
        <table class="kd-table">
            <thead>
                <SortableHeaders cols={cols} sort={sort} onSort={onSort} />
            </thead>
            <tbody>
                {items.map(n => (
                    <Row key={n.noteId} note={n} tab={tab} accentColor={accentColor} />
                ))}
            </tbody>
        </table>
    );
}

function Pagination({ page, pageCount, total, onPrev, onNext }) {
    if (pageCount <= 1) return null;
    const start = page * PAGE_SIZE + 1;
    const end   = Math.min((page + 1) * PAGE_SIZE, total);
    return (
        <div class="kd-pagination">
            <button
                class="kd-btn"
                onClick={onPrev}
                disabled={page === 0}
                title="Previous page"
            >‹ Prev</button>
            <span class="kd-page-info">
                {start}–{end} of {total} · page {page + 1}/{pageCount}
            </span>
            <button
                class="kd-btn"
                onClick={onNext}
                disabled={page >= pageCount - 1}
                title="Next page"
            >Next ›</button>
        </div>
    );
}

function LogPanel({ entries }) {
    return (
        <div class="kd-log">
            {entries.map((e, i) => (
                <div key={i} class={`kd-log-line kd-log-${e.type}`}>
                    [{e.time}] {e.msg}
                </div>
            ))}
        </div>
    );
}

/* ═══════════════════════════════════════════════════════════════
   CONFIG PANEL
══════════════════════════════════════════════════════════════════ */

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
        <div class="kd-config-panel">
            <div class="kd-config-row">
                <span class="kd-config-label">Mode</span>
                <div class="kd-mode-toggle">
                    <button
                        class={`kd-mode-btn${config.mode === 'exclude' ? ' active' : ''}`}
                        onClick={() => setMode('exclude')}
                        title="Scan everything except these subtrees"
                    >Exclude</button>
                    <button
                        class={`kd-mode-btn${config.mode === 'include' ? ' active' : ''}`}
                        onClick={() => setMode('include')}
                        title="Scan only these subtrees"
                    >Include</button>
                </div>
            </div>

            <div
                class={`kd-dropzone${dragOver ? ' over' : ''}`}
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
                <div class="kd-chips">
                    {subtrees.map(s => (
                        <span class="kd-chip" key={s.noteId}>
                            <span class="kd-chip-title" title={s.noteId}>📁 {s.title}</span>
                            <span
                                class="kd-chip-x"
                                onClick={() => removeSubtree(s.noteId)}
                                title="Remove"
                            >×</span>
                        </span>
                    ))}
                </div>
            ) : (
                <div class="kd-config-hint">
                    {config.mode === 'include'
                        ? '⚠ No subtrees selected — Include mode scans nothing. Drag at least one subtree above.'
                        : 'Empty list: full-tree scan.'}
                </div>
            )}
        </div>
    );
}

/* ═══════════════════════════════════════════════════════════════
   ROOT
══════════════════════════════════════════════════════════════════ */

function KnowledgeDebtApp() {
    const [data, setData] = useState({
        orphans: [], stubs: [], empty: [], todos: [], abandoned: [],
    });
    const [activeTab, setActiveTab] = useState('orphans');
    const [search, setSearch] = useState('');
    const [scanning, setScanning] = useState(false);
    const [hasScanned, setHasScanned] = useState(false);
    const [page, setPage] = useState(0);
    const [log, setLog] = useState([
        { time: nowTimeStr(), msg: 'Ready. Click "▶ Scan" to analyze your knowledge base.', type: 'info' },
    ]);

    // Sort state: per-tab object { field, dir }. Defaults to dateModified ASC,
    // matching the ORDER BY in the SQL queries so initial view is consistent.
    // For stubs, default to size ASC (which is also what the SQL returns).
    const [sortByTab, setSortByTab] = useState({
        orphans:   { field: 'dateModified', dir: 'asc' },
        stubs:     { field: 'contentLen',   dir: 'asc' },
        empty:     { field: 'dateModified', dir: 'desc' },
        todos:     { field: 'dateModified', dir: 'asc' },
        abandoned: { field: 'dateModified', dir: 'asc' },
    });

    // Config state — loaded on mount, saved on change (debounced)
    const [config, setConfig] = useState(DEFAULT_CONFIG);
    const [configNoteId, setConfigNoteId] = useState(null);
    const [configLoaded, setConfigLoaded] = useState(false);
    const [showConfig, setShowConfig] = useState(false);
    const saveDebounceRef = useRef(null);
    const skipNextSaveRef = useRef(true);  // skip the initial state-from-load save

    // Debounced search input (smooths re-renders if any tab ever grows large)
    const [searchInput, setSearchInput] = useState('');
    const searchDebounceRef = useRef(null);

    const addLog = useCallback((msg, type = 'info') => {
        setLog(prev => [...prev, { time: nowTimeStr(), msg, type }]);
    }, []);

    useEffect(() => {
        injectStyle();
    }, []);

    // Load config once on mount
    useEffect(() => {
        (async () => {
            try {
                const { config: loaded, configNoteId: id } = await loadConfig();
                setConfig(loaded);
                setConfigNoteId(id);
                setConfigLoaded(true);
                if (id) {
                    addLog(`Config loaded: ${loaded.mode} mode, ${loaded.subtrees.length} subtree(s).`);
                }
            } catch (err) {
                console.error('Config load failed:', err);
                addLog('Config load failed: ' + err.message, 'err');
                setConfigLoaded(true);  // proceed with defaults
            }
        })();
    // eslint-disable-next-line — intentional empty deps; addLog is stable
    }, []);

    // Persist config on change (debounced, skipped on initial load).
    // The config note is auto-created as a child of the dashboard note on first save.
    useEffect(() => {
        if (!configLoaded) return;
        if (skipNextSaveRef.current) { skipNextSaveRef.current = false; return; }
        clearTimeout(saveDebounceRef.current);
        saveDebounceRef.current = setTimeout(async () => {
            try {
                // api.startNote is the Render note that triggered this script
                const parentId = (typeof api !== 'undefined' && api.startNote)
                    ? api.startNote.noteId
                    : 'root';
                const noteId = await saveConfig(config, parentId);
                if (!configNoteId && noteId) {
                    setConfigNoteId(noteId);
                    addLog('Config note created as child of dashboard.', 'ok');
                }
            } catch (err) {
                console.error('Config save failed:', err);
                addLog('Config save failed: ' + err.message, 'err');
            }
        }, 400);
        return () => clearTimeout(saveDebounceRef.current);
    // eslint-disable-next-line
    }, [config, configLoaded]);

    useEffect(() => {
        clearTimeout(searchDebounceRef.current);
        searchDebounceRef.current = setTimeout(() => setSearch(searchInput), 120);
        return () => clearTimeout(searchDebounceRef.current);
    }, [searchInput]);

    // Reset to first page when tab or search changes
    useEffect(() => { setPage(0); }, [activeTab, search]);

    const selectTab = useCallback((tab) => { setActiveTab(tab); }, []);

    // Notes the dashboard should never analyze (itself + its JSX + its config)
    const systemNoteIds = useMemo(() => {
        const ids = [];
        if (typeof api !== 'undefined' && api.startNote) ids.push(api.startNote.noteId);
        if (typeof api !== 'undefined' && api.currentNote) ids.push(api.currentNote.noteId);
        if (configNoteId) ids.push(configNoteId);
        return [...new Set(ids)];
    }, [configNoteId]);

    // Include mode with no subtrees would scan nothing — disable scan with a hint
    const includeEmpty = config.mode === 'include' && (!config.subtrees || config.subtrees.length === 0);
    const scanDisabled = scanning || includeEmpty;

    const onScan = useCallback(async () => {
        if (scanning || includeEmpty) return;
        setScanning(true);
        addLog('Starting analysis…');
        try {
            const result = await runScan(config, systemNoteIds);
            setData(result.results);
            setHasScanned(true);

            if (result.debug && result.debug.tables && result.debug.tables.length) {
                addLog('DB tables: ' + result.debug.tables.join(', '));
            }

            const total = Object.values(result.results)
                .reduce((sum, arr) => sum + arr.length, 0);
            if (total === 0) {
                addLog('Healthy base — no debt items found.', 'ok');
            } else {
                addLog(`${total} debt items found.`, 'warn');
            }
        } catch (err) {
            console.error(err);
            addLog('Error: ' + err.message, 'err');
        } finally {
            setScanning(false);
        }
    }, [scanning, includeEmpty, config, systemNoteIds, addLog]);

    /* Derived: filtered items for the active tab */
    const filteredItems = useMemo(() => {
        const items = data[activeTab] || [];
        if (!search) return items;
        const q = search.toLowerCase();
        return items.filter(n => (n.title || '').toLowerCase().includes(q));
    }, [data, activeTab, search]);

    /* Apply sort (after filtering, before pagination) */
    const activeSort = sortByTab[activeTab];
    const sortedItems = useMemo(() => {
        if (!activeSort) return filteredItems;
        const cols = COLS[activeTab] || [];
        const col = cols.find(c => c.field === activeSort.field);
        if (!col) return filteredItems;
        const cmp = makeComparator(col.field, col.kind, activeSort.dir);
        // slice() to avoid mutating the underlying array
        return filteredItems.slice().sort(cmp);
    }, [filteredItems, activeTab, activeSort]);

    /* Click handler: same column toggles direction, new column resets to ASC */
    const onSort = useCallback((col) => {
        setSortByTab(prev => {
            const cur = prev[activeTab];
            const dir = (cur && cur.field === col.field && cur.dir === 'asc') ? 'desc' : 'asc';
            return { ...prev, [activeTab]: { field: col.field, dir } };
        });
        setPage(0);
    }, [activeTab]);

    const pageCount = Math.max(1, Math.ceil(sortedItems.length / PAGE_SIZE));
    const pageItems = useMemo(
        () => sortedItems.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE),
        [sortedItems, page]
    );

    const activeColor = useMemo(
        () => TABS.find(t => t.key === activeTab)?.color || 'var(--main-text-color)',
        [activeTab]
    );

    const subtreeCount = (config.subtrees || []).length;

    return (
        <div class="kd-root">
            <div class="kd-header">
                <span class="kd-title">🩺 <strong>Knowledge Debt</strong></span>
                {hasScanned && (
                    <input
                        type="text"
                        class="kd-search"
                        placeholder="🔍 filter by title…"
                        value={searchInput}
                        onInput={(e) => setSearchInput(e.target.value)}
                    />
                )}
                <button
                    class={`kd-btn${showConfig ? ' active' : ''}`}
                    onClick={() => setShowConfig(s => !s)}
                    title="Configure include/exclude scope"
                >
                    ⚙ Config
                    {subtreeCount > 0 && (
                        <span class="kd-badge">{config.mode === 'include' ? '+' : '−'}{subtreeCount}</span>
                    )}
                </button>
                <button
                    class="kd-btn"
                    onClick={onScan}
                    disabled={scanDisabled}
                    title={includeEmpty
                        ? 'Include mode is empty — add a subtree to scan'
                        : 'Run scan'}
                >
                    {scanning ? '…' : '▶ Scan'}
                </button>
            </div>

            {showConfig && (
                <ConfigPanel config={config} onChange={setConfig} />
            )}

            {hasScanned && (
                <StatsBar data={data} activeTab={activeTab} onSelect={selectTab} maxResults={MAX_RESULTS} />
            )}

            <div class="kd-table-wrap">
                {hasScanned && (
                    <DebtTable
                        tab={activeTab}
                        items={pageItems}
                        scanning={scanning}
                        accentColor={activeColor}
                        sort={activeSort}
                        onSort={onSort}
                    />
                )}
            </div>

            {hasScanned && sortedItems.length > 0 && (
                <Pagination
                    page={page}
                    pageCount={pageCount}
                    total={sortedItems.length}
                    onPrev={() => setPage(p => Math.max(0, p - 1))}
                    onNext={() => setPage(p => Math.min(pageCount - 1, p + 1))}
                />
            )}

            <LogPanel entries={log} />
        </div>
    );
}

export default KnowledgeDebtApp;
