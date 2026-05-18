/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║          Task Planner — TriliumNext (Preact)                ║
 * ║                                                             ║
 * ║   Backlog │ Mon │ Tue │ Wed │ Thu │ Fri │ Sat │ Sun         ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 * Collects line-prefixed tasks from all text notes:
 *   • TODO   <text>   — actionable task     (orange)
 *   • IDEA   <text>   — captured thought    (blue)
 *   • CHECK  <text>   — to verify / review  (green)
 *   • TOREAD <text>   — reading queue       (purple)
 *   • DEFER <text>   — Follow up later       (teal)
 *
 * Prefixes are case-sensitive, must be at the start of a line/block,
 * and must be followed by a space. Mark-done wraps the line in
 * `<span style="color:#cfcfcf">DONE …</span>` in the source note,
 * so completed items remain visible but greyed in their source note.
 *
 * INTERACTIONS:
 *   click card             →  open source note in side panel
 *   Ctrl/Cmd-click card    →  open source note in new tab
 *   shift-click / mid-click →  open source note in new tab
 *   ✓ on card (hover)      →  mark done (greys the line in source note)
 *   drag card              →  schedule for a day (desktop)
 *   + new TODO             →  appends a TODO line to today's daily note
 *                             (creating it if it doesn't exist)
 *   @date suffix           →  auto-schedules. accepts: @YYYY-MM-DD, @today,
 *                             @tomorrow, @mon..@sun
 *   #tag suffix            →  filterable. Multiple tags allowed.
 *
 * SETUP:
 *   1. Options → Code Notes → enable "JSX"
 *   2. Create a new code note, language: JSX
 *   3. Paste this code into it
 *   4. In your Render note, set ~renderNote → this JSX note
 *   5. The #plannerdata note (stores state) is auto-created as a child of
 *      this JSX note on first load — no manual setup needed.
 *      Optional labels (all on the #plannerdata note):
 *        #wp_backlog_width=320       default backlog column width (px)
 *        #wp_scan_archived=false     skip archived notes (default: true)
 *        Kind colors:
 *          #wp_todo=#ed7a2a          override TODO chip color
 *          #wp_idea=#348cbb          override IDEA chip color
 *          #wp_check=#42ae2e         override CHECK chip color
 *          #wp_toread=#9d4edd        override TOREAD chip color
 *          #wp_defer=#008080         override DEFER chip color
 *        Theme (any CSS color string):
 *          #wp_bg_task=#f3f3f3          task card background
 *          #wp_bg_panel=#fafafa         column / panel background
 *          #wp_color_done_text=#cfcfcf  grey of marked-done lines in source
 *          #wp_color_done_btn=#79a574   mark-done ✓ button color
 *          #wp_color_date_tag=#a8a8a8   inline @date token color
 *          #wp_color_progress=#79a574   progress-bar fill
 */

import { useEffect, useRef, useState, useCallback, useMemo } from "trilium:preact";
import { runOnBackend, runAsyncOnBackendWithManualTransactionHandling, activateNote } from "trilium:api";

/* ═══════════════════════════════════════════════════════════════
   CONSTANTS — kinds, colors, dimensions
══════════════════════════════════════════════════════════════════ */

const KINDS = {
    TODO:   { label: 'TODO',   color: '#ed7a2a' },
    IDEA:   { label: 'IDEA',   color: '#348cbb' },
    CHECK:  { label: 'CHECK',  color: '#42ae2e' },
    TOREAD: { label: 'TOREAD', color: '#9d4edd' },
    DEFER:  { label: 'DEFER',  color: '#589393' },
};
const KIND_KEYS = Object.keys(KINDS);
const KIND_RE_SOURCE = `(?:${KIND_KEYS.join('|')})`;

/* Color overrides come from labels on the #plannerdata note:
   #wp_todo, #wp_idea, #wp_check, #wp_toread.*/
function getKindColor(kind, overrides) {
    if (overrides && overrides[kind]) return overrides[kind];
    return KINDS[kind]?.color || '#666';
}

/* Theme defaults — each can be overridden per install via a label on the
   #plannerdata note. The label names use the wp_ prefix (e.g. #wp_bg_task). */
const THEME_DEFAULTS = {
    bgTask:         '#f3f3f3',  // task card background
    bgPanel:        '#fafafa',  // column / panel background
    colorDoneText:  '#cfcfcf',  // grey of marked-done lines in source
    colorDoneBtn:   '#79a574',  // mark-done button color
    colorDateTag:   '#a8a8a8',  // inline @date token color
    colorProgress:  '#79a574',  // progress-bar fill (matches done button by default)
};

function resolveTheme(overrides) {
    return { ...THEME_DEFAULTS, ...(overrides || {}) };
}

const BACKLOG_WIDTH_DEFAULT = 260;
const BACKLOG_WIDTH_MIN     = 150;
const BACKLOG_WIDTH_MAX     = 600;

/* Whether to scan archived notes by default.
   Overridden per install by adding label #wp_scan_archived=false on the
   #plannerdata note. Accepted false-y values: false, no, 0, off. */
const SCAN_ARCHIVED_DEFAULT = true;

const WEEKDAY_ALIASES = {
    mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 0,
};

/* ═══════════════════════════════════════════════════════════════
   PARSING HELPERS — @date suffix and #tag extraction
══════════════════════════════════════════════════════════════════ */

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

/* ═══════════════════════════════════════════════════════════════
   BACKEND HELPERS
══════════════════════════════════════════════════════════════════ */

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
            const v = note.getLabelValue && note.getLabelValue(name);
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

        // Theme overrides — any CSS color string. Missing label → use built-in.
        //   #wp_bg_task            task card background
        //   #wp_bg_panel           column / panel background
        //   #wp_color_done_text    grey of marked-done lines in source
        //   #wp_color_done_btn     mark-done button color
        //   #wp_color_date_tag     inline @date token color
        //   #wp_color_progress     progress-bar fill
        const themeLabelMap = {
            bgTask:         'wp_bg_task',
            bgPanel:        'wp_bg_panel',
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

        // Note content holds the JSON planner state
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
   child of parentNoteId (the JSX note that hosts this script) with the
   required #plannerdata label */
async function ensurePlannerNote(parentNoteId) {
    return await runAsyncOnBackendWithManualTransactionHandling(
        async (parentId) => {
            let note = api.getNoteWithLabel('plannerdata');
            if (note) return { created: false, noteId: note.noteId };

            const created = await api.createTextNote(
                parentId,
                'Planner — State',
                '{}'
            );
            note = created.note;
            await note.setLabel('plannerdata', '');
            await note.setLabel('hidePromotedAttributes', '');
            await note.setLabel('iconClass', 'bx bx-calendar');
            return { created: true, noteId: note.noteId };
        },
        [parentNoteId]
    );
}

/* Build the GLOB filter for the SQL prefilter.
   Case-sensitive (matches the case-sensitive prefix rule).
   Returns: "b.content GLOB '*TODO *' OR b.content GLOB '*IDEA *' OR ..." */
function buildPrefixGlobClause() {
    return KIND_KEYS.map(k => `b.content GLOB '*${k} *'`).join(' OR ');
}

/* Scan all text notes for prefixed lines.*/
async function fetchAllTasks({ scanArchived = SCAN_ARCHIVED_DEFAULT } = {}) {
    const kindRe = KIND_RE_SOURCE;
    const prefixClause = buildPrefixGlobClause();

    const groups = await runOnBackend((kindReSource, includeArchived, prefixGlobClause) => {
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

        // Fast path: SQL prefilter via JOIN on blobs.
        // Returns only notes whose content matches at least one prefix.
        let rows;
        try {
            rows = api.sql.getRows(
                "SELECT n.noteId, n.title FROM notes n " +
                "JOIN blobs b ON b.blobId = n.blobId " +
                "WHERE n.isDeleted = 0 AND n.isProtected = 0 AND n.type = 'text' AND (" + prefixGlobClause + ") " +
                "ORDER BY n.title COLLATE NOCASE"
            );
        } catch (err) {
            // Fallback for unexpected schema differences: plain SELECT,
            rows = api.sql.getRows(
                "SELECT noteId, title FROM notes " +
                "WHERE isDeleted = 0 AND isProtected = 0 AND type = 'text' " +
                "ORDER BY title COLLATE NOCASE"
            );
        }

        const result = [];
        for (const row of rows) {
            const note = api.getNote(row.noteId);
            if (!note) continue;
            if (!includeArchived && note.hasLabel && note.hasLabel('archived')) continue;
            const content = note.getContent();
            if (!content) continue;
            const tasks = scanContent(content);
            if (tasks.length) {
                result.push({ noteId: row.noteId, title: row.title || '(no title)', tasks });
            }
        }
        return result;
    }, [kindRe, scanArchived, prefixClause]);

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
        if (!includeArchived && note.hasLabel && note.hasLabel('archived')) return [];
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

/* Flatten {noteId, title, tasks:[...]} groups */
function flattenGroups(groups) {
    const all = [];
    for (const g of groups) {
        for (const t of g.tasks) {
            const meta = parseTaskMeta(t.text);
            const id = `${g.noteId}::${t.kind}::${t.text.replace(/\s+/g, '_').slice(0, 48)}`;
            all.push({
                id,
                kind:         t.kind,
                text:         t.text,
                tags:         meta.tags,
                isoDate:      meta.isoDate,
                indexForKind: t.indexForKind,
                noteId:       g.noteId,
                noteTitle:    g.title,
            });
        }
    }
    return all;
}

/* Mark done: wrap the line in a grey span and replace prefix with DONE. */
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

/* Append a new task to today's daily note.
   If the typed text starts with a known kind followed by a space, use that
   kind verbatim. Otherwise default to TODO. */
async function appendTodoToToday(text) {
    const prefixRe = new RegExp(`^(${KIND_RE_SOURCE})\\s+(.+)$`);
    const m = text.match(prefixRe);
    const kind = m ? m[1] : 'TODO';
    const body = m ? m[2] : text;
    const lineText = `${kind} ${body}`;

    return await runOnBackend((line) => {
        const note = api.getTodayNote();
        if (!note) throw new Error("Couldn't get or create today's daily note");
        const current = note.getContent() || '';
        note.setContent(current + `<p>${line}</p>`);
        return { noteId: note.noteId, title: note.title };
    }, [lineText]);
}

/* ═══════════════════════════════════════════════════════════════
   DATE HELPERS
══════════════════════════════════════════════════════════════════ */

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
    const d0 = new Date(cols[0].key + 'T12:00:00');
    const d1 = new Date(cols[6].key + 'T12:00:00');
    if (d0.getMonth() === d1.getMonth())
        return `${d0.getDate()}–${d1.getDate()} ${months[d0.getMonth()]} ${d0.getFullYear()}`;
    return `${d0.getDate()} ${months[d0.getMonth()]} – ${d1.getDate()} ${months[d1.getMonth()]} ${d1.getFullYear()}`;
}

/* ═══════════════════════════════════════════════════════════════
   ORDER + FILTER HELPERS
══════════════════════════════════════════════════════════════════ */

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

function getBacklog(allTasks, plannerData) {
    return allTasks.filter(t => !plannerData[t.id]);
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

/* ═══════════════════════════════════════════════════════════════
   CSS — light theme, kind colors
══════════════════════════════════════════════════════════════════ */

/* Builds the planner's CSS for a given resolved theme. */
function buildStyle(theme) {
    return `
.pl-root { display:flex; flex-direction:column; height:100%; overflow:hidden;
           font-family: var(--detail-font-family,"Segoe UI",sans-serif);
           font-size:14px; color:#333; background:#fff; }

.pl-header { display:flex; align-items:center; gap:7px; padding:10px 16px;
             flex-shrink:0; border-bottom:1px solid #d0d0d0;
             flex-wrap:wrap; background:#fff; }

.pl-board { display:flex; gap:10px; overflow-x:auto;
            padding:0 16px 20px; flex:1; align-items:flex-start;
            -webkit-overflow-scrolling:touch; }

.pl-col { flex-shrink:0; display:flex; flex-direction:column; border-radius:8px;
          border:1px solid #d0d0d0;
          background:${theme.bgPanel};
          max-height:calc(100vh - 240px); position:relative; }
.pl-col.today { border-color:#89b4fa; border-width:2px; }

.pl-col-head { padding:10px 12px 8px; border-bottom:1px solid #d8d8d8;
               flex-shrink:0; }
.pl-col-label { font-size:14px; font-weight:700; text-transform:uppercase;
                letter-spacing:.08em; color:#666; }
.pl-col.today .pl-col-label { color:#5a7fb8; }
.pl-col-sub { font-size:13px; color:#888; margin-top:2px; }

.pl-tasks { padding:8px; display:flex; flex-direction:column; gap:6px;
            overflow-y:auto; flex:1; min-height:64px; }
.pl-task { background:${theme.bgTask}; border-radius:5px;
           padding:7px 10px; font-size:15px; line-height:1.4; cursor:pointer;
           border:1.5px solid transparent; transition:border-color .1s, opacity .15s;
           user-select:none; color:#222; }
.pl-task:hover { border-color:#a8a8a8; }
.pl-task.dragging { opacity:.35; cursor:grabbing; }
.pl-task[draggable="true"] { cursor:grab; }
.pl-task-note { font-size:12px; color:#888; margin-top:3px;
                overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.pl-task-kind { display:inline-block; font-size:10px; font-weight:700;
                padding:1px 5px; border-radius:3px; margin-right:5px;
                vertical-align:middle; letter-spacing:.05em; color:#fff; }
.pl-task-date { color:${theme.colorDateTag}; }

.pl-drop { display:none; height:40px; border:2px dashed #b8b8b8;
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

.pl-btn { background:#fff; border:1px solid #c8c8c8; border-radius:5px;
          color:#333; font-size:14px; padding:3px 10px;
          cursor:pointer; line-height:1.4; }
.pl-btn:hover { background:#eee; }
.pl-btn.icon { font-size:19px; width:28px; height:26px; padding:0; }
.pl-btn.muted { color:#666; }
.pl-btn:disabled { opacity:.5; cursor:not-allowed; }

.pl-capture { display:flex; gap:6px; padding:8px 16px; flex-shrink:0;
              border-bottom:1px solid #d8d8d8; background:#fff; }
.pl-capture input { flex:1; background:#fff;
                    border:1px solid #c8c8c8; border-radius:5px;
                    color:#333; font-size:14px; padding:6px 10px;
                    font-family:inherit; }
.pl-capture input:focus { outline:1px solid #89b4fa; }

/* Filter dropdown. Uses position:fixed so it escapes any clipping ancestor
   (the planner root has overflow:hidden, which would otherwise crop it).
   Position is set at open time from the trigger button's bounding rect. */
.pl-filter-wrap { position:relative; }
.pl-filter-panel { position:fixed; z-index:9998;
                   background:#fff; border:1px solid #c8c8c8; border-radius:6px;
                   box-shadow:0 4px 12px rgba(0,0,0,.12);
                   padding:10px 12px; min-width:200px; max-width:240px;
                   max-height:80vh; overflow-y:auto; }
.pl-filter-panel h5 { margin:0 0 4px; font-size:12px;
                      text-transform:uppercase; letter-spacing:.05em;
                      color:#666; font-weight:700; }
.pl-filter-panel h5:not(:first-child) { margin-top:10px; }
.pl-filter-row { display:flex; align-items:center; gap:6px;
                 padding:3px 0; cursor:pointer; user-select:none;
                 font-size:13px; }
.pl-filter-row input { margin:0; }
.pl-filter-badge { display:inline-block; min-width:16px; height:16px;
                   padding:0 4px; border-radius:8px; font-size:10px;
                   line-height:16px; text-align:center; background:#89b4fa;
                   color:#fff; margin-left:4px; font-weight:700; }

/* Done button on each card (shown on hover, always visible on mobile) */
.pl-task { position:relative; }
.pl-task-done-btn {
    position:absolute; top:5px; right:5px;
    width:18px; height:18px;
    border:1.5px solid #999; border-radius:50%;
    background:#fff; color:#79a574;
    font-size:12px; font-weight:700; line-height:1;
    display:flex; align-items:center; justify-content:center;
    cursor:pointer; opacity:0;
    transition:opacity .12s, background .12s, border-color .12s;
}
.pl-task:hover .pl-task-done-btn { opacity:1; }
.pl-task-done-btn:hover {
    background:${theme.colorDoneBtn}; border-color:${theme.colorDoneBtn}; color:#fff;
}
.pl-task-done-btn.working { opacity:1; background:#eee; cursor:wait; }
/* Always visible on touch devices (no hover) */
@media (hover: none) {
    .pl-task-done-btn { opacity:.7; }
}

/* Progress bar at the bottom edge of the task card.
   Click on the bar cycles 0 → 25 → 50 → 75 → 100 → 0.
   Reaching 100 calls markDone via the cycle handler. */
.pl-task-progress {
    position:absolute; left:0; right:0; bottom:0;
    height:5px; border-radius:0 0 5px 5px;
    background:rgba(0,0,0,.06);
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
    font-size:10px; color:#666;
    background:#fff; padding:0 4px; border-radius:3px;
    pointer-events:none; opacity:0;
    transition:opacity .15s;
}
.pl-task-progress:hover .pl-task-progress-label { opacity:1; }
/* Add bottom padding so card content doesn't sit under the bar */
.pl-task { padding-bottom:9px; }
`;
}

/* Inject the planner CSS into the page <head>. Called when the theme is
   first known, and again whenever it changes. Replaces the existing
   <style> tag's content rather than appending a new one. */
function injectStyle(css) {
    let el = document.getElementById('pl-preact-styles');
    if (!el) {
        el = document.createElement('style');
        el.id = 'pl-preact-styles';
        document.head.appendChild(el);
    }
    if (el.textContent !== css) el.textContent = css;
}

/* ═══════════════════════════════════════════════════════════════
   COMPONENTS
══════════════════════════════════════════════════════════════════ */

function KindChip({ kind, overrides }) {
    const k = KINDS[kind];
    if (!k) return null;
    const color = getKindColor(kind, overrides);
    return (
        <span class="pl-task-kind" style={{ background: color }}>
            {k.label}
        </span>
    );
}

/* Render task text inline, with @tokens and #tags styled as light-grey spans.
   Walks the text once and emits a styled span per match of either pattern.
   Both use the same .pl-task-date CSS rule so they share the muted look. */
function renderTaskText(text) {
    const parts = [];
    // Match @word or #word at start-of-text or after whitespace.
    // \S+ for @date; [A-Za-z][\w-]* for #tag (matches the parseTaskMeta rule).
    const re = /(^|\s)(@\S+|#[A-Za-z][\w-]*)/g;
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

function TaskCard({ task, progress, overrides, draggable, onClick, onMarkDone, onSetProgress, onDragStart, onDragEnd }) {
    const [working, setWorking] = useState(false);

    const handleDone = async (e) => {
        e.stopPropagation();
        if (working) return;
        setWorking(true);
        try { await onMarkDone(task); }
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
                <KindChip kind={task.kind} overrides={overrides} />
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
    onCardClick, onCardMarkDone, onCardSetProgress, onCardDragStart, onCardDragEnd,
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
                                    <span style={{ color: '#999', marginLeft: 'auto' }}>
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
                                    onClick={toggleTagMode}
                                    title={tagMode === 'AND'
                                        ? 'AND: a task must have all selected tags. Click to switch to OR.'
                                        : 'OR: a task must have any selected tag. Click to switch to AND.'}
                                    style={{
                                        marginLeft: 'auto',
                                        padding: '1px 6px',
                                        fontSize: '10px',
                                        fontWeight: 700,
                                        border: '1px solid #d8d8d8',
                                        background: '#fff',
                                        color: '#666',
                                        borderRadius: '3px',
                                        cursor: 'pointer',
                                        letterSpacing: '.05em',
                                    }}
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


/* ═══════════════════════════════════════════════════════════════
   ROOT COMPONENT
══════════════════════════════════════════════════════════════════ */

function PlannerApp() {
    const [allTasks,    setAllTasks]      = useState([]);
    const [plannerData, setPlannerData]   = useState({});
    const [weekOffset,  setWeekOffset]    = useState(0);
    const [backlogWidth, setBacklogWidth] = useState(BACKLOG_WIDTH_DEFAULT);
    const [loading,     setLoading]       = useState(true);
    const [error,       setError]         = useState(null);
    const [capturing,   setCapturing]     = useState(false);
    const [colorOverrides, setColorOverrides] = useState({});
    const [themeOverrides, setThemeOverrides] = useState({});
    const [scanArchived, setScanArchived] = useState(SCAN_ARCHIVED_DEFAULT);

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

    /* Initial load. The #plannerdata state note is auto-created here on
       first run as a child of this JSX note, so the user never needs to
       set it up manually. ensurePlannerNote is idempotent — a no-op on
       every subsequent load. */
    useEffect(() => {
        (async () => {
            try {
                const parentId = (typeof api !== 'undefined' && api.startNote)
                    ? api.startNote.noteId
                    : 'root';
                const ensured = await ensurePlannerNote(parentId);
                if (ensured && ensured.created) {
                    console.log('Created #plannerdata note as child of dashboard.');
                }

                const loaded = await loadPlannerData();
                const data = loaded.data || {};

                // Apply persisted UI state from data
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
                if (loaded.colorOverrides) setColorOverrides(loaded.colorOverrides);
                if (loaded.themeOverrides) setThemeOverrides(loaded.themeOverrides);
                setScanArchived(loaded.scanArchived !== false);

                // Fetch tasks, apply @date auto-scheduling, then set both at once
                const tasks = await fetchAllTasks({ scanArchived: loaded.scanArchived !== false });
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

    /* Full reload, used by the ⟳ button. Covers every case
       (note deleted, kind changed, multiple notes edited). */
    const reload = useCallback(async () => {
        try {
            const tasks = await fetchAllTasks({ scanArchived });
            setAllTasks(tasks);
            setPlannerData(prev => applyDateSuffixes(tasks, prev));
        } catch (err) {
            console.error('reload:', err);
            setError(String(err.message || err));
        }
    }, [applyDateSuffixes, scanArchived]);

    /* Single-note reload — used after mark-done and capture, 
       Replaces all tasks belonging to that note with the freshly-scanned ones,
       which is what keeps per-kind indices accurate after a mark-done. */
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
            // Fall back to a full reload on error
            await reload();
        }
    }, [applyDateSuffixes, scanArchived, reload]);

    /* Mark done: optimistic UI (remove immediately) + per-note re-fetch (correct indices) */
    const markDone = useCallback(async (task) => {
        // Optimistic: remove from local state
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
    }, [reload, reloadNote, theme]);

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

    /* Set a task's progress (0/25/50/75). 100 is handled separately via markDone.
       Stored in plannerData._progress under the task ID. Setting 0 removes the
       key to keep the map clean. */
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

    /* Card click: opens the source note.
       - default: opens in a side panel (lighter, reversible)
       - Ctrl/Cmd-click: opens in a new tab
       - middle-click: also opens in a new tab (browser convention)
       - shift-click: also opens in a new tab
       Falls back to activateNote if the relevant api method isn't available. */
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

    const clearWeek = useCallback((weekKeys) => {
        if (!confirm(`Clear planning for this week?`)) return;
        setPlannerData(prev => {
            const next = { ...prev };
            for (const t of allTasks) {
                if (weekKeys.has(next[t.id])) delete next[t.id];
            }
            return next;
        });
    }, [allTasks]);

    /* Derived */
    const mobile = useMobile();
    const weekCols = useMemo(() => getWeekCols(weekOffset), [weekOffset]);
    const wkLabel  = useMemo(() => weekLabel(weekCols), [weekCols]);
    const weekKeys = useMemo(() => new Set(weekCols.map(c => c.key)), [weekCols]);
    const isCurrentWeek = weekOffset === 0;

    const filteredTasks = useMemo(
        () => applyFilters(allTasks, filters),
        [allTasks, filters]
    );

    const total   = filteredTasks.length;
    const planned = filteredTasks.filter(t => weekKeys.has(plannerData[t.id])).length;
    const backlog = getBacklog(filteredTasks, plannerData);

    const allCols = [
        { key: 'backlog', label: 'Backlog', dateStr: `${backlog.length} unplanned`, isToday: false, isBacklog: true },
        ...weekCols.map(c => ({ ...c, isBacklog: false })),
    ];

    if (loading && allTasks.length === 0) {
        return <div style={{ padding: '24px', color: '#888' }}>Loading…</div>;
    }
    if (error) {
        return <div style={{ padding: '24px', color: '#c34' }}>✗ {error}</div>;
    }

    return (
        <div class="pl-root">
            <div class="pl-header">
                <span style={{ fontSize: '18px', fontWeight: 700 }}>Planner</span>
                <button class="pl-btn icon" onClick={() => setWeekOffset(w => w - 1)} title="Previous week">‹</button>
                <span style={{ fontSize: '16px', color: '#666', whiteSpace: 'nowrap' }}>
                    {wkLabel}
                </span>
                <button class="pl-btn icon" onClick={() => setWeekOffset(w => w + 1)} title="Next week">›</button>
                {!isCurrentWeek && (
                    <button class="pl-btn muted" onClick={() => setWeekOffset(0)}>today</button>
                )}
                <span style={{ fontSize: '14px', color: '#666', marginLeft: 'auto' }}>
                    {planned}/{total} planned
                </span>
                <button class="pl-btn muted" onClick={() => clearWeek(weekKeys)} title="Clear this week">↺</button>
                <button class="pl-btn muted" onClick={reload} title="Reload tasks">⟳</button>
                <FilterDropdown
                    allTasks={allTasks}
                    filters={filters}
                    onChange={setFilters}
                    overrides={colorOverrides}
                />
            </div>

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
                            : { flex: '1 1 0', minWidth: '120px' };
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
