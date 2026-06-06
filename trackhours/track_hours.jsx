/**
 * Hours Tracker — TriliumNext (Preact)
 *
 * Tracks hours worked per project against planned hours.
 * Per project: total available hours, planned hours/week, number of weeks.
 * Per week: entry of hours worked per project.
 * Shows: remaining hours, required hours/week for the remaining weeks.
 *
 * INSTALLATION
 *   1. Create the code note: type = "JSX", paste this whole file into it.
 *   2. Create a note of type = "Render Note", title of your choice.
 *   3. On the Render Note, add the label: #renderNote = <noteId of the JSX note>.
 *      (The label lives on the Render Note and points TO the code note — the
 *      code note itself needs no label.)
 *   4. Data is saved automatically in a child note (under the code note) with
 *      label #hourdata (JSON), created on first load.
 *
 * ARCHITECTURE
 *   - Render note widget; `api` is Trilium's FrontendScriptApi.
 *   - One JSON note labelled #hourdata stores projects + entered weeks. On
 *     startup the data note is resolved DETERMINISTICALLY: if exactly one note
 *     carries the label it is used; if none, one is created; if two or more,
 *     the tracker refuses to load and shows a banner listing them, rather than
 *     letting getNoteWithLabel silently pick one (which risks writing to the
 *     wrong note). The resolved noteId is cached for the session so every save
 *     targets the same note.
 *   - Read-only backend work uses runOnBackend with a SYNCHRONOUS callback
 *     (the API now rejects async callbacks here). Backend work that awaits, 
 *     creating the data note, note.save(), uses
 *     runAsyncOnBackendWithManualTransactionHandling instead.
 *   - Preact via "trilium:preact".
 */

import { useEffect, useState, useCallback, useMemo, useRef } from "trilium:preact";
import { runOnBackend, runAsyncOnBackendWithManualTransactionHandling } from "trilium:api";

/* ── CONSTANTS ──────────────────────────────────────────────────── */

// The note that stores all tracker data is found globally by this label.
const DATA_LABEL = "hourdata";

/**
 * A week cell — weeks[weekKey][projectId] — is an array of hour entries for one
 * project in one week, e.g. [2, 3, 1.5]. sumCell totals them.
 */
function sumCell(cell) {
    return Array.isArray(cell)
        ? cell.reduce((acc, n) => acc + (Number(n) || 0), 0)
        : 0;
}

/**
 * Coerce any parsed value into the guaranteed shape { projects: [], weeks: {} }.
 * The data note is seeded with "{}" on creation, and a user could hand-edit it,
 * so projects/weeks may be missing or the wrong type. Without this, code like
 * `for (const p of data.projects)` throws "data.projects is not iterable".
 */
function normalizeData(d) {
    const obj = (d && typeof d === "object") ? d : {};
    const holidays = Array.isArray(obj.holidays)
        ? [...new Set(obj.holidays.filter(k => typeof k === "string"))]
        : [];
    return {
        projects: Array.isArray(obj.projects)
            ? obj.projects.map(p => ({ code: "", color: "", startWeek: "", endWeek: "", archived: false, ...p }))
            : [],
        weeks: (obj.weeks && typeof obj.weeks === "object" && !Array.isArray(obj.weeks))
            ? obj.weeks
            : {},
        // Global, de-duplicated array of "YYYY-Www" weeks the user is not working
        // at all. Excluded from working-week counts. Old files without it load
        // fine. Note: legacy `totalWeeks` on projects is ignored — working weeks
        // are now derived from start/end minus holidays.
        holidays,
    };
}

/* ── BACKEND HELPERS ────────────────────────────────────────────── */

/**
 * Find every note carrying the data label, de-duplicated by noteId. Runs on the
 * backend with a SYNCHRONOUS callback (the read API is sync). Returns an array
 * of { noteId, title } so the frontend can detect the "more than one data note"
 * situation and act deterministically rather than letting getNoteWithLabel
 * silently pick one.
 */
async function findDataNotes() {
    return await runOnBackend((label) => {
        // Prefer the plural getNotesWithLabel; fall back to a label search, then
        // to the singular getNoteWithLabel, depending on what this Trilium
        // version exposes. Each path yields an array of note objects.
        let notes;
        if (typeof api.getNotesWithLabel === "function") {
            notes = api.getNotesWithLabel(label) || [];
        } else if (typeof api.searchForNotes === "function") {
            notes = api.searchForNotes(`#${label}`) || [];
        } else {
            const one = api.getNoteWithLabel ? api.getNoteWithLabel(label) : null;
            notes = one ? [one] : [];
        }

        const byId = {};
        for (const note of notes) {
            if (note && note.noteId && !byId[note.noteId]) {
                byId[note.noteId] = {
                    noteId: note.noteId,
                    title: (typeof note.title === "string" ? note.title : note.noteId),
                };
            }
        }
        return Object.values(byId);
    }, [DATA_LABEL]);
}

/**
 * Resolve the single data note to use, deterministically.
 *
 * Returns one of:
 *   { status: "ok",        noteId }                      — exactly one found
 *   { status: "created",   noteId }                      — none found, created
 *   { status: "duplicate", candidates: [{noteId,title}] }— two or more found
 *   { status: "error",     message }                     — backend failure
 *
 * Creating a new note awaits createNewNote / note.save(), so that branch uses
 * the async transaction handler.
 */
async function resolveDataNote(parentNoteId) {
    let found;
    try {
        found = await findDataNotes();
    } catch (e) {
        return { status: "error", message: String(e && e.message || e) };
    }

    if (found.length > 1) {
        return { status: "duplicate", candidates: found };
    }

    if (found.length === 1) {
        return { status: "ok", noteId: found[0].noteId };
    }

    // None found → create one.
    try {
        const noteId = await runAsyncOnBackendWithManualTransactionHandling(
            async (parentId, label) => {
                const created = await api.createNewNote({
                    parentNoteId: parentId,
                    title: "Hours Tracker Data",
                    type: "code",
                    mime: "application/json",
                    content: "{}",
                });
                const note = created.note;
                await note.setLabel(label, "");
                await note.setLabel("hidePromotedAttributes", "");
                await note.setLabel("iconClass", "bx bx-time");
                return note.noteId;
            },
            [parentNoteId, DATA_LABEL]
        );
        return { status: "created", noteId };
    } catch (e) {
        return { status: "error", message: String(e && e.message || e) };
    }
}

/**
 * Load data from a specific data note by its noteId (resolved once at startup,
 * so saves and reads always target the same note even if a duplicate appears
 * mid-session). Returns { projects: [], weeks: {} } if the note is empty.
 */
async function loadData(noteId) {
    return await runOnBackend((id) => {
        const note = api.getNote ? api.getNote(id) : null;
        if (!note) return { projects: [], weeks: {} };
        try {
            const raw = note.getContent();
            return raw ? JSON.parse(raw) : { projects: [], weeks: {} };
        } catch (_) {
            return { projects: [], weeks: {} };
        }
    }, [noteId]);
}

/**
 * Save data to the resolved data note (by noteId). Uses the async transaction
 * handler because note.save() is awaited.
 */
async function saveData(noteId, data) {
    const json = JSON.stringify(data, null, 2);
    return await runAsyncOnBackendWithManualTransactionHandling(
        async (id, jsonStr) => {
            const note = api.getNote ? api.getNote(id) : null;
            if (!note) throw new Error("Hours Tracker data note not found");
            note.setContent(jsonStr);
            await note.save();
            return note.noteId;
        },
        [noteId, json]
    );
}

/* ── WEEK / RANGE HELPERS ───────────────────────────────────────── */

/**
 * Compare two "YYYY-Www" keys chronologically.
 * Returns negative if a < b, 0 if equal, positive if a > b.
 * Malformed keys sort last.
 */
function compareWeekKeys(a, b) {
    const pa = parseWeekKey(a);
    const pb = parseWeekKey(b);
    if (!pa && !pb) return 0;
    if (!pa) return 1;
    if (!pb) return -1;
    return isoWeekStartDate(pa.year, pa.week) - isoWeekStartDate(pb.year, pb.week);
}

/**
 * Step a "YYYY-Www" key forward (or back) by n weeks, returning a new key.
 * The year component must come from the ISO-week-owning year (the year that
 * contains the Thursday of that week), not the calendar year of the Monday —
 * otherwise weeks straddling Jan 1 get the wrong year (e.g. 2024-W52 + 1 would
 * wrongly read as 2024-W01 instead of 2025-W01).
 */
function addWeeks(key, n) {
    const p = parseWeekKey(key);
    if (!p) return key;
    const d = isoWeekStartDate(p.year, p.week);
    d.setDate(d.getDate() + n * 7);
    return `${getISOWeekYear(d)}-W${String(getISOWeek(d)).padStart(2, "0")}`;
}

/**
 * The ISO-week-numbering year for a date: the year containing that week's
 * Thursday. Differs from getFullYear() only in the few days around New Year.
 */
function getISOWeekYear(date) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + 4 - (d.getDay() || 7));
    return d.getFullYear();
}

/**
 * Is `weekKey` within a project's writable range?
 *   - Must be on or after startWeek (start is required).
 *   - If endWeek is set, must be on or before it.
 *   - If endWeek is blank, the project is open-ended: any week from start on.
 */
function isWeekWritable(project, weekKey) {
    if (!parseWeekKey(weekKey)) return false;
    const start = (project.startWeek || "").trim();
    if (!start || !parseWeekKey(start)) return false;
    if (compareWeekKeys(weekKey, start) < 0) return false;
    const end = (project.endWeek || "").trim();
    if (end && parseWeekKey(end) && compareWeekKeys(weekKey, end) > 0) return false;
    return true;
}

/**
 * Enumerate every "YYYY-Www" key from `startKey` to `endKey` inclusive.
 * Returns [] if either bound is malformed or end < start. Used to give charts
 * a continuous x-axis (so gap weeks with no entry still show as a flat step
 * rather than collapsing the timeline).
 */
function weekRange(startKey, endKey) {
    const s = parseWeekKey(startKey);
    const e = parseWeekKey(endKey);
    if (!s || !e) return [];
    if (compareWeekKeys(startKey, endKey) > 0) return [];
    const out = [];
    let cur = `${s.year}-W${String(s.week).padStart(2, "0")}`;
    // Guard against runaway loops on absurd ranges (~10 years of weeks).
    for (let i = 0; i < 520; i++) {
        out.push(cur);
        if (compareWeekKeys(cur, endKey) >= 0) break;
        cur = addWeeks(cur, 1);
    }
    return out;
}

/**
 * A short, human axis label for a "YYYY-Www" key: the ISO week number plus the
 * Monday's "MMM DD", e.g. "W12 · Mar 24". Falls back to the raw key.
 */
function shortWeekLabel(key) {
    const p = parseWeekKey(key);
    if (!p) return key;
    const monday = isoWeekStartDate(p.year, p.week);
    const mon = monday.toLocaleDateString("en-US", { month: "short", day: "2-digit" });
    return `W${String(p.week).padStart(2, "0")} · ${mon}`;
}

/* ── CALCULATION HELPERS ────────────────────────────────────────── */

/**
 * ISO week number for a date (Monday = start of week).
 */
function getISOWeek(date) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + 4 - (d.getDay() || 7));
    const yearStart = new Date(d.getFullYear(), 0, 1);
    return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

/**
 * Current year + week number as a "YYYY-WW" string.
 */
function currentWeekKey() {
    const now = new Date();
    const week = getISOWeek(now);
    return `${now.getFullYear()}-W${String(week).padStart(2, "0")}`;
}

/**
 * The Monday (00:00) of a given ISO year + week number.
 */
function isoWeekStartDate(year, week) {
    // Jan 4th is always in ISO week 1.
    const jan4 = new Date(year, 0, 4);
    const jan4Day = jan4.getDay() || 7; // Mon=1..Sun=7
    const week1Monday = new Date(jan4);
    week1Monday.setDate(jan4.getDate() - (jan4Day - 1));
    const monday = new Date(week1Monday);
    monday.setDate(week1Monday.getDate() + (week - 1) * 7);
    monday.setHours(0, 0, 0, 0);
    return monday;
}

/**
 * Parse a "YYYY-Www" key into { year, week } (or null if malformed).
 */
function parseWeekKey(key) {
    const m = /^(\d{4})-W(\d{1,2})$/.exec((key || "").trim());
    if (!m) return null;
    return { year: parseInt(m[1], 10), week: parseInt(m[2], 10) };
}

/**
 * Count working weeks in the inclusive span [startKey, endKey]: calendar weeks
 * in the span minus any marked as global holidays. 0 if empty/malformed.
 * `holidaySet` is a Set of "YYYY-Www" keys.
 */
function countWorkingWeeks(startKey, endKey, holidaySet) {
    const span = weekRange(startKey, endKey);
    if (span.length === 0) return 0;
    let n = 0;
    for (const wk of span) if (!holidaySet.has(wk)) n += 1;
    return n;
}

/**
 * The value of the calendar-even planned line at week `atKey`: fraction of
 * working weeks elapsed (start → atKey) over total working weeks, times budget.
 * Holiday-aware; clamped to [0, totalHours]. Mirrors the burn-up chart's line.
 */
function plannedLineValueAt(project, atKey, holidaySet, totalWorkingWeeks, totalHours) {
    if (!parseWeekKey(project.startWeek) || !parseWeekKey(atKey) || totalWorkingWeeks <= 0) return 0;
    if (compareWeekKeys(atKey, project.startWeek) < 0) return 0;
    const end = project.endWeek;
    const upto = (parseWeekKey(end) && compareWeekKeys(atKey, end) > 0) ? end : atKey;
    const elapsedWorking = countWorkingWeeks(project.startWeek, upto, holidaySet);
    return Math.min(1, elapsedWorking / totalWorkingWeeks) * totalHours;
}

/**
 * Compare a from-here required pace to the planned baseline and return
 * "ahead" | "ontrack" | "behind". A 12% band around the baseline is on track.
 */
function pacingStatus(needed, planned) {
    if (planned <= 0 || needed <= 0) return "ontrack";
    const ratio = needed / planned;
    if (ratio > 1.12) return "behind";
    if (ratio < 0.88) return "ahead";
    return "ontrack";
}

/**
 * Calculate statistics per project — holiday-aware and CALENDAR-based.
 *
 * The schedule follows the calendar (start → end), not which weeks were logged.
 * Global holidays (weeks the user marked as non-working) are excluded from the
 * working-week counts, so a holiday is neither time you fell behind nor capacity
 * you have left. The honest signal is forward-looking:
 *   plannedPerWeek = totalHours / totalWorkingWeeks            (baseline)
 *   neededPerWeek  = remainingHours / remainingWorkingWeeks    (from here on)
 * neededPerWeek > plannedPerWeek ⇒ behind; < ⇒ ahead; ≈ ⇒ on track.
 * Holiday weeks remain fully writable; logged hours always reduce the budget.
 */
function calcProjectStats(project, weeks, holidaySet) {
    const { id, totalHours, startWeek, endWeek } = project;
    const hol = holidaySet || new Set();

    // Total working weeks across the whole span (calendar − holidays).
    const totalWorkingWeeks = (parseWeekKey(startWeek) && parseWeekKey(endWeek))
        ? countWorkingWeeks(startWeek, endWeek, hol)
        : 0;

    // Planned hours/week is derived: budget spread over the working weeks.
    const plannedPerWeek = totalWorkingWeeks > 0 ? totalHours / totalWorkingWeeks : 0;

    // Hours worked and (for display only) how many weeks have an entry. Only
    // positive hours contribute to madeHours.
    let madeHours = 0;
    let weeksEntered = 0;
    for (const [, weekData] of Object.entries(weeks)) {
        const cell = weekData[id];
        if (!Array.isArray(cell) || cell.length === 0) continue;
        weeksEntered += 1;
        const h = sumCell(cell);
        if (h > 0) madeHours += h;
    }

    const remainingHours = Math.max(0, totalHours - madeHours);

    // Remaining WORKING weeks: from the current week (or project start, if it
    // hasn't begun) through the end, minus future holidays. Current in-progress
    // week counts as available. 0 once the project has ended.
    const cur = currentWeekKey();
    let remainingWorkingWeeks = 0;
    if (parseWeekKey(endWeek)) {
        const from = (parseWeekKey(startWeek) && compareWeekKeys(startWeek, cur) > 0)
            ? startWeek
            : cur;
        if (compareWeekKeys(from, endWeek) <= 0) {
            remainingWorkingWeeks = countWorkingWeeks(from, endWeek, hol);
        }
    }

    // From-here required pace.
    const neededPerWeek = remainingWorkingWeeks > 0
        ? remainingHours / remainingWorkingWeeks
        : 0;

    // Cumulative gap at "now": hours done minus where the calendar-even plan
    // line sits at the current week (mirrors the burn-up chart's planned line).
    const plannedAtNow = plannedLineValueAt(project, cur, hol, totalWorkingWeeks, totalHours);
    const cumulativeGap = madeHours - plannedAtNow;

    const pct = totalHours > 0 ? Math.min(100, (madeHours / totalHours) * 100) : 0;

    return {
        madeHours,
        plannedPerWeek,
        neededPerWeek,
        remainingHours,
        remainingWorkingWeeks,
        totalWorkingWeeks,
        plannedAtNow,
        cumulativeGap,
        pct,
        weeksEntered,
        paceStatus: pacingStatus(neededPerWeek, plannedPerWeek),
    };
}

/* ── SUBCOMPONENTS ──────────────────────────────────────────────── */

/* Charts readout: cumulative hours above/below the planned line at "now" —
   matches the vertical gap the eye sees between actual and planned lines. */
function GapLabel({ gap, style }) {
    const onPlan = Math.abs(gap) < 0.5;
    const color = onPlan
        ? "var(--muted-text-color,#888)"
        : (gap > 0 ? "var(--color-text-success,#2e7d32)" : "var(--color-text-danger,#c62828)");
    const text = onPlan ? "≈ on plan" : `${gap > 0 ? "+" : ""}${gap.toFixed(1)}h vs plan`;
    return <span style={{ ...styles.meta, color, ...(style || {}) }} title="Cumulative hours above/below the planned line at the current week">{text}</span>;
}

function ProgressBar({ pct }) {
    return (
        <div style={styles.progressTrack}>
            <div style={{ ...styles.progressFill, width: `${Math.round(pct)}%` }} />
        </div>
    );
}

function ProjectCard({ project, stats, onEdit }) {
    const { name, code, totalHours } = project;
    const { remainingHours, neededPerWeek, plannedPerWeek, remainingWorkingWeeks, totalWorkingWeeks, pct, paceStatus } = stats;
    const neededHigh = paceStatus === "behind";

    const cardStyle = project.color
        ? { ...styles.card, borderTop: `3px solid ${project.color}` }
        : styles.card;

    return (
        <div style={cardStyle}>
            <div style={styles.cardHeader}>
                <span style={styles.projectName}>{name}{code ? ` (${code})` : ""}</span>
                <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                    <button style={styles.iconBtn} onClick={onEdit} title="Edit project">✎</button>
                </div>
            </div>

            <ProgressBar pct={pct} />

            <div style={styles.statsGrid}>
                <StatCell label="Total budget" value={`${totalHours}h`} />
                <StatCell label="Remaining budget" value={`${remainingHours.toFixed(1)}h`} highlight={remainingHours < 0} />
                <StatCell label="Planned/week" value={`${plannedPerWeek.toFixed(1)}h`} />
                <StatCell label="Needed/week" value={`${neededPerWeek.toFixed(1)}h`} highlight={neededHigh} />
                <StatCell label="Working weeks left" value={`${remainingWorkingWeeks}`} highlight={remainingWorkingWeeks === 0 && remainingHours > 0} />
            </div>

            <div style={styles.metaRow}>
                <span style={styles.meta}>
                    Plan: {totalHours}h ÷ {totalWorkingWeeks} working wks = {plannedPerWeek.toFixed(1)}h/wk · need {neededPerWeek.toFixed(1)}h/wk from here
                </span>
                <span style={styles.meta}>{Math.round(pct)}% done</span>
            </div>
        </div>
    );
}

function StatCell({ label, value, highlight }) {
    return (
        <div style={styles.statCell}>
            <div style={styles.statLabel}>{label}</div>
            <div style={{ ...styles.statValue, color: highlight ? "var(--color-text-danger,#c62828)" : "var(--main-text-color,#333)" }}>{value}</div>
        </div>
    );
}

/* One week row for a single project. Holds multiple hour entries that are
   summed into a week total. `cell` is the stored array (may be undefined).
   `active` subtly highlights the currently selected week. */
function WeekEntry({ weekKey, cell, active, onSave, onClear, onCancel }) {
    // Local editable list of strings (so partial typing like "1." is allowed).
    const [entries, setEntries] = useState(() => {
        const arr = Array.isArray(cell) ? cell : [];
        return arr.length ? arr.map(n => String(n)) : [""];
    });
    const [saving, setSaving] = useState(false);
    const [justSaved, setJustSaved] = useState(false);

    const total = entries.reduce((acc, s) => {
        const v = parseFloat(s);
        return acc + (isNaN(v) ? 0 : v);
    }, 0);

    const setEntry = (i, val) => { setJustSaved(false); setEntries(es => es.map((e, idx) => idx === i ? val : e)); };
    const addEntry = () => { setJustSaved(false); setEntries(es => [...es, ""]); };
    const removeEntry = (i) => { setJustSaved(false); setEntries(es => es.length > 1 ? es.filter((_, idx) => idx !== i) : [""]); };

    const handleSave = async () => {
        setSaving(true);
        const parsed = entries
            .map(s => parseFloat(s))
            .filter(v => !isNaN(v) && v >= 0);
        try {
            await onSave(weekKey, parsed);
            setJustSaved(true);
            setTimeout(() => setJustSaved(false), 2500);
        } finally {
            setSaving(false);
        }
    };

    const rowStyle = active
        ? { ...styles.weekRow, ...styles.weekRowActive }
        : styles.weekRow;

    return (
        <div style={rowStyle}>
            <div style={styles.weekLabel}>
                {weekKey}{active && <span style={styles.activeTag}> · selected</span>}
                <div style={styles.weekTotal}>{total.toFixed(1)}h total</div>
            </div>
            <div style={styles.weekInputs}>
                {entries.map((val, i) => (
                    <div key={i} style={styles.entryChip}>
                        <input
                            type="number"
                            min="0"
                            step="0.5"
                            value={val}
                            style={{ ...styles.input, width: "70px" }}
                            placeholder="0"
                            onChange={e => setEntry(i, e.target.value)}
                        />
                        <button
                            style={styles.entryRemove}
                            onClick={() => removeEntry(i)}
                            title="Remove this entry"
                        >−</button>
                    </div>
                ))}
                <button style={styles.btnSecondary} onClick={addEntry} title="Add another entry">+ entry</button>
            </div>
            <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                <button style={styles.btnPrimary} onClick={handleSave} disabled={saving}>
                    {saving ? "Saving…" : "Save"}
                </button>
                {onCancel && (
                    <button style={styles.btnSecondary} onClick={onCancel} disabled={saving} title="Discard changes and close">
                        Cancel
                    </button>
                )}
                {justSaved && <span style={styles.savedTag}>✓ Saved</span>}
                <button style={{ ...styles.iconBtn, color: "var(--color-text-danger,#c62828)" }} onClick={() => onClear(weekKey)} title="Clear this week">✕</button>
            </div>
        </div>
    );
}

function ProjectForm({ initial, holidays, onSave, onCancel }) {
    const blank = { name: "", code: "", color: "", totalHours: "", startWeek: "", endWeek: "" };
    const [form, setForm] = useState(initial || blank);
    const [error, setError] = useState("");

    const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

    // Live preview of the derived planned hours/week: budget over the working
    // weeks of the span (calendar weeks start→end minus global holidays).
    const previewTotal = parseFloat(form.totalHours);
    const holSet = useMemo(() => new Set(holidays || []), [holidays]);
    const workingWeeks = (parseWeekKey(form.startWeek) && parseWeekKey(form.endWeek))
        ? countWorkingWeeks(form.startWeek, form.endWeek, holSet)
        : null;
    const previewPpw = (!isNaN(previewTotal) && workingWeeks && workingWeeks > 0)
        ? (previewTotal / workingWeeks)
        : null;

    const handleSave = () => {
        if (!form.name.trim()) return setError("Name is required");
        const total = parseFloat(form.totalHours);
        if (isNaN(total) || total <= 0) return setError("Total hours must be > 0");
        const startWeek = form.startWeek.trim();
        const endWeek = form.endWeek.trim();
        if (!startWeek) return setError("Start week is required");
        if (!parseWeekKey(startWeek)) return setError("Start week must look like 2025-W22");
        if (!endWeek) return setError("End week is required");
        if (!parseWeekKey(endWeek)) return setError("End week must look like 2025-W47");
        const s = isoWeekStartDate(parseWeekKey(startWeek).year, parseWeekKey(startWeek).week);
        const e = isoWeekStartDate(parseWeekKey(endWeek).year, parseWeekKey(endWeek).week);
        if (e < s) return setError("End week must not be before start week");
        setError("");
        onSave({
            id: initial?.id || `proj_${Date.now()}`,
            name: form.name.trim(),
            code: form.code.trim(),
            color: form.color || "",
            totalHours: total,
            startWeek,
            endWeek,
            archived: initial?.archived || false,
        });
    };

    return (
        <div style={styles.formBox}>
            <div style={styles.formTitle}>{initial ? "Edit project" : "New project"}</div>
            {error && <div style={styles.errorMsg}>{error}</div>}
            <div style={styles.formGrid}>
                <label style={styles.formLabel}>Name</label>
                <input style={styles.input} value={form.name} onChange={e => set("name", e.target.value)} placeholder="Project name" />

                <label style={styles.formLabel}>Project code (optional)</label>
                <input style={styles.input} value={form.code} onChange={e => set("code", e.target.value)} placeholder="e.g. ACME-2025" />

                <label style={styles.formLabel}>Color (optional)</label>
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <input
                        type="color"
                        value={form.color || "#888888"}
                        onChange={e => set("color", e.target.value)}
                        style={{ width: "40px", height: "28px", padding: "0", border: "0.5px solid var(--main-border-color,#d0d0d0)", borderRadius: "4px", cursor: "pointer" }}
                        title="Pick a color band for this project"
                    />
                    {form.color
                        ? <button type="button" style={styles.btnSecondary} onClick={() => set("color", "")}>None</button>
                        : <span style={styles.meta}>No color (default)</span>}
                </div>

                <label style={styles.formLabel}>Total available hours</label>
                <input style={styles.input} type="number" min="1" step="1" value={form.totalHours} onChange={e => set("totalHours", e.target.value)} placeholder="e.g. 200" />

                <label style={styles.formLabel}>Start week (required)</label>
                <div style={styles.weekPickField}>
                    <button type="button" style={styles.stepBtn} title="Previous week"
                        onClick={() => set("startWeek", parseWeekKey(form.startWeek) ? addWeeks(form.startWeek, -1) : currentWeekKey())}>‹</button>
                    <input
                        type="week"
                        style={{ ...styles.input, width: "150px" }}
                        value={parseWeekKey(form.startWeek) ? form.startWeek : ""}
                        onChange={e => set("startWeek", e.target.value)}
                    />
                    <button type="button" style={styles.stepBtn} title="Next week"
                        onClick={() => set("startWeek", parseWeekKey(form.startWeek) ? addWeeks(form.startWeek, 1) : currentWeekKey())}>›</button>
                    <button type="button" style={styles.btnSecondary} title="This week"
                        onClick={() => set("startWeek", currentWeekKey())}>Today</button>
                </div>

                <label style={styles.formLabel}>End week (required)</label>
                <div style={styles.weekPickField}>
                    <button type="button" style={styles.stepBtn} title="Previous week"
                        onClick={() => set("endWeek", parseWeekKey(form.endWeek) ? addWeeks(form.endWeek, -1) : (form.startWeek || currentWeekKey()))}>‹</button>
                    <input
                        type="week"
                        style={{ ...styles.input, width: "150px" }}
                        value={parseWeekKey(form.endWeek) ? form.endWeek : ""}
                        onChange={e => set("endWeek", e.target.value)}
                    />
                    <button type="button" style={styles.stepBtn} title="Next week"
                        onClick={() => set("endWeek", parseWeekKey(form.endWeek) ? addWeeks(form.endWeek, 1) : (form.startWeek || currentWeekKey()))}>›</button>
                </div>

                <label style={styles.formLabel}>Planned/week</label>
                <span style={{ ...styles.meta, paddingTop: "5px" }}>
                    {previewPpw !== null
                        ? `${previewPpw.toFixed(1)}h/week over ${workingWeeks} working weeks (holidays excluded)`
                        : "— enter hours, start and end week"}
                </span>
            </div>
            <div style={{ display: "flex", gap: "8px", marginTop: "12px" }}>
                <button style={styles.btnPrimary} onClick={handleSave}>Save</button>
                <button style={styles.btnSecondary} onClick={onCancel}>Cancel</button>
            </div>
        </div>
    );
}

/* ── CHARTS ─────────────────────────────────────────────────────── */

/* A stable fallback palette for projects that have no color set. Indexed by
   the project's position so colors stay put across renders. */
const CHART_PALETTE = [
    "#5b8def", "#e0823d", "#5aab61", "#c0504d", "#8064a2",
    "#4bacc6", "#d99694", "#9bbb59", "#a5a5a5", "#f1c40f",
];

function projectColor(project, index) {
    return (project && project.color) || CHART_PALETTE[index % CHART_PALETTE.length];
}

/* Cumulative burn-up for one project: actual cumulative line, sloped planned
   line (start 0 → budget at the planned end), and a flat budget ceiling.
   Two sizes: compact (small multiple) and default (single selected). */
function BurnUpChart({ project, index, weeks, compact }) {
    const data = useMemo(() => buildBurnUp(project, weeks), [project, weeks]);
    const color = projectColor(project, index);

    if (!data) {
        return <div style={styles.emptyState}>{project.name}: set a start week to chart progress.</div>;
    }
    const { axis, actual, actualEndIdx, planned, budget } = data;

    // The last drawn cumulative value (current week), for scaling and the marker.
    const lastActual = actualEndIdx >= 0 ? (actual[actualEndIdx] || 0) : 0;

    const W = compact ? 340 : 1000;
    const H = compact ? 180 : 300;
    const padL = 44, padR = 14, padT = 16, padB = compact ? 34 : 46;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;
    const { max: yMax, ticks } = niceScale(Math.max(budget, lastActual, 1), compact ? 3 : 4);
    const n = axis.length;
    const x = i => padL + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
    const y = v => padT + plotH - (v / yMax) * plotH;

    // Width-aware x-label thinning: each rotated label needs ~minGap px. Show
    // every week when they fit, otherwise thin them to avoid overlap.
    const minGap = 26;
    const fit = Math.max(1, Math.floor(plotW / minGap));
    const labelStep = Math.max(1, Math.ceil(n / fit));

    // Build a path, skipping null entries (the future, undrawn portion). Starts
    // a fresh subpath after any gap so the line simply stops at the last point.
    const linePath = arr => {
        let d = "";
        let pen = false;
        arr.forEach((v, i) => {
            if (v == null) { pen = false; return; }
            d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)} `;
            pen = true;
        });
        return d.trim();
    };

    return (
        <div style={styles.chartScroll}>
            <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: "block" }} role="img">
                {ticks.map(t => (
                    <g key={t}>
                        <line x1={padL} y1={y(t)} x2={W - padR} y2={y(t)} stroke="var(--main-border-color,#e2e2e2)" strokeWidth="0.5" />
                        <text x={padL - 6} y={y(t) + 3} textAnchor="end" style={styles.chartTickText}>{t}</text>
                    </g>
                ))}
                {/* budget ceiling */}
                <line x1={padL} y1={y(budget)} x2={W - padR} y2={y(budget)} stroke="var(--color-text-danger,#c0504d)" strokeWidth="1" strokeDasharray="2 3" opacity="0.8" />
                <text x={W - padR} y={y(budget) - 4} textAnchor="end" style={styles.chartTickText}>budget {budget}h</text>
                {/* planned (ideal) line — spans the full axis */}
                <path d={linePath(planned)} fill="none" stroke="var(--muted-text-color,#999)" strokeWidth="1.25" strokeDasharray="4 4" />
                {/* "now" guideline: where the actual line stops while the axis continues */}
                {actualEndIdx >= 0 && actualEndIdx < n - 1 && (
                    <line x1={x(actualEndIdx)} y1={padT} x2={x(actualEndIdx)} y2={padT + plotH} stroke="var(--muted-text-color,#bbb)" strokeWidth="0.5" strokeDasharray="2 2" opacity="0.7" />
                )}
                {/* actual cumulative line — only up to the current week */}
                <path d={linePath(actual)} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" />
                {/* end-of-actual point (at the current week) */}
                {actualEndIdx >= 0 && (
                    <circle cx={x(actualEndIdx)} cy={y(lastActual)} r="3" fill={color}>
                        <title>{`${shortWeekLabel(axis[actualEndIdx])}: ${lastActual.toFixed(1)}h cumulative`}</title>
                    </circle>
                )}
                {/* x labels */}
                {axis.map((lab, i) => (
                    i % labelStep === 0 || i === n - 1 ? (
                        <text
                            key={i}
                            x={x(i)}
                            y={H - padB + 16}
                            textAnchor="end"
                            transform={`rotate(-40 ${x(i)} ${H - padB + 16})`}
                            style={styles.chartTickText}
                        >{shortWeekLabel(lab)}</text>
                    ) : null
                ))}
                <line x1={padL} y1={padT + plotH} x2={W - padR} y2={padT + plotH} stroke="var(--muted-text-color,#999)" strokeWidth="0.5" />
            </svg>
        </div>
    );
}

/* Compute the cumulative series for a burn-up chart.
   - axis: continuous weeks from startWeek to the later of (planned end, last
     entered week, current week).
   - actual: running cumulative worked hours, but only up to and including the
     current week — the line should not project into the future. Positions past
     the current week are null so the drawing code can stop the line there.
   - actualEndIdx: index of the last drawn actual point (the current week, or
     the last axis week if the project's whole range is already in the past).
   - planned: the ideal even spend (0 at start → budget at the planned end week,
     flat afterwards) — spans the FULL axis as a reference.
   - budget: total available hours.
   Returns null if the project has no valid start week. */
function buildBurnUp(project, weeks) {
    if (!parseWeekKey(project.startWeek)) return null;
    const start = project.startWeek;

    // The planned end week: the project's end (now always present).
    const plannedEnd = parseWeekKey(project.endWeek) ? project.endWeek : start;

    // Axis extends to the latest of planned end / last entered week / current.
    const enteredForProj = Object.keys(weeks).filter(wk => {
        const cell = weeks[wk]?.[project.id];
        return Array.isArray(cell) && cell.length > 0 && parseWeekKey(wk);
    });
    let axisEnd = plannedEnd;
    for (const wk of enteredForProj) if (compareWeekKeys(wk, axisEnd) > 0) axisEnd = wk;
    const cur = currentWeekKey();
    if (compareWeekKeys(cur, start) >= 0 && compareWeekKeys(cur, axisEnd) > 0) axisEnd = cur;

    const axis = weekRange(start, axisEnd);
    if (axis.length === 0) return null;

    // Where the actual line should stop: the current week's position on the
    // axis. If "now" is before the start, nothing is drawn (idx -1 → 0 length);
    // if "now" is past the axis end, the line runs the whole axis.
    let actualEndIdx;
    if (compareWeekKeys(cur, start) < 0) {
        actualEndIdx = -1;
    } else {
        const ci = axis.indexOf(cur);
        actualEndIdx = ci >= 0 ? ci : axis.length - 1;
    }

    // Actual running cumulative, only up to the current week. Beyond it, null
    // so the rendered line ends rather than flat-lining into the future.
    let run = 0;
    const actual = axis.map((wk, i) => {
        if (i > actualEndIdx) return null;
        const cell = weeks[wk]?.[project.id];
        if (Array.isArray(cell)) run += sumCell(cell);
        return run;
    });

    // Planned even spend up to plannedEnd, then flat at budget. Spans full axis.
    const budget = project.totalHours || 0;
    const plannedSpanIdx = Math.max(1, axis.indexOf(plannedEnd) >= 0 ? axis.indexOf(plannedEnd) : axis.length - 1);
    const planned = axis.map((wk, i) => {
        if (i >= plannedSpanIdx) return budget;
        return (i / plannedSpanIdx) * budget;
    });

    return { axis, actual, actualEndIdx, planned, budget };
}

/* Choose a "nice" axis scale for a max data value: returns { max, ticks }
   where ticks are evenly spaced, clean (integer or .5) numbers from 0..max, and
   max hugs the value rather than jumping to the next power-of-ten bracket.
   e.g. 107 → max 120 ticks [0,30,60,90,120]; 38 → 40; 7 → 8. */
function niceScale(v, targetTicks) {
    if (!(v > 0)) return { max: 1, ticks: [0, 0.5, 1] };
    const tickN = targetTicks || 4;
    // Candidate "nice" step sizes across magnitudes.
    const pow = Math.pow(10, Math.floor(Math.log10(v / tickN)));
    const stepCands = [1, 2, 2.5, 5, 10, 20, 25, 50].map(m => m * pow);
    let best = null;
    for (const step of stepCands) {
        const max = Math.ceil(v / step) * step;
        const n = Math.round(max / step);
        // Want roughly tickN intervals and small headroom.
        if (n < 2 || n > 10) continue;
        const headroom = max / v - 1;
        const score = Math.abs(n - tickN) + headroom * 2;
        if (best === null || score < best.score) best = { step, max, n, score };
    }
    if (!best) {
        const step = stepCands[stepCands.length - 1];
        const max = Math.ceil(v / step) * step;
        best = { step, max, n: Math.round(max / step) };
    }
    const ticks = [];
    for (let i = 0; i <= best.n; i++) ticks.push(roundFloat(best.step * i));
    return { max: roundFloat(best.max), ticks };
}

/* Trim binary float noise (e.g. 119.99999999 → 120). */
function roundFloat(x) {
    return Math.round(x * 1e6) / 1e6;
}

/* The Charts tab body: burn-up(s) for the selected projects, shown big for one
   and as small multiples for several. */
function ChartsTab({ data, stats }) {
    const active = data.projects.filter(p => !p.archived);
    // Selection of project ids to show in the burn-up section. Default: all
    // active. Stored as a Set in state held by the parent-less local hook.
    const [selected, setSelected] = useState(() => new Set(active.map(p => p.id)));

    // Keep the selection in sync if projects are added/removed/archived.
    useEffect(() => {
        setSelected(prev => {
            const valid = new Set(active.map(p => p.id));
            const next = new Set([...prev].filter(id => valid.has(id)));
            // If nothing valid remains selected, default back to all active.
            return next.size === 0 ? valid : next;
        });
        // eslint-disable-next-line
    }, [data.projects]);

    const toggle = id => setSelected(prev => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id); else next.add(id);
        return next.size === 0 ? new Set(active.map(p => p.id)) : next;
    });

    const chosen = active.filter(p => selected.has(p.id));
    const compact = chosen.length > 1;

    if (active.length === 0) {
        return <div style={styles.emptyState}>No active projects to chart. Add one via <strong>Projects</strong>.</div>;
    }

    return (
        <div>
            {/* Burn-up section with a project multi-select */}
            <div style={styles.chartCard}>
                <div style={styles.chartHeader}>
                    <span style={styles.chartTitle}>Cumulative hours vs. plan</span>
                    <span style={styles.meta}>{compact ? "small multiples" : "actual vs. planned vs. budget"}</span>
                </div>

                <div style={styles.chartLegend}>
                    <span style={styles.legendItem}><span style={{ ...styles.legendSwatch, background: "var(--muted-text-color,#999)" }} />planned</span>
                    <span style={styles.legendItem}><span style={{ ...styles.legendSwatch, background: "var(--color-text-danger,#c0504d)" }} />budget</span>
                    <span style={styles.legendItem}><span style={{ ...styles.legendSwatch, background: "var(--active-item-background-color,#5b8def)" }} />actual (cumulative)</span>
                </div>

                {/* Project toggles */}
                <div style={styles.chartChips}>
                    {active.map((p, i) => {
                        const on = selected.has(p.id);
                        const c = projectColor(p, i);
                        return (
                            <button
                                key={p.id}
                                onClick={() => toggle(p.id)}
                                style={{
                                    ...styles.chartChip,
                                    borderColor: on ? c : "var(--main-border-color,#d0d0d0)",
                                    background: on ? `${c}22` : "transparent",
                                    opacity: on ? 1 : 0.55,
                                }}
                                title={on ? "Click to hide" : "Click to show"}
                            >
                                <span style={{ ...styles.legendSwatch, background: c }} />
                                {p.name}{p.code ? ` (${p.code})` : ""}
                            </button>
                        );
                    })}
                </div>

                {chosen.length === 0 ? (
                    <div style={styles.emptyState}>Select at least one project above.</div>
                ) : compact ? (
                    <div style={styles.smallMultiples}>
                        {chosen.map((p) => {
                            const gi = active.findIndex(a => a.id === p.id);
                            const s = stats[p.id];
                            return (
                                <div key={p.id} style={styles.smChartBox}>
                                    <div style={styles.smChartTitle}>
                                        <span style={{ ...styles.legendSwatch, background: projectColor(p, gi) }} />
                                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                            {p.name}{p.code ? ` (${p.code})` : ""}
                                        </span>
                                        {s && <GapLabel gap={s.cumulativeGap} style={{ marginLeft: "auto" }} />}
                                    </div>
                                    <BurnUpChart project={p} index={gi} weeks={data.weeks} compact />
                                </div>
                            );
                        })}
                    </div>
                ) : (
                    <div>
                        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "2px" }}>
                            {stats[chosen[0].id] && <GapLabel gap={stats[chosen[0].id].cumulativeGap} />}
                        </div>
                        <BurnUpChart project={chosen[0]} index={active.findIndex(a => a.id === chosen[0].id)} weeks={data.weeks} compact={false} />
                    </div>
                )}
            </div>
        </div>
    );
}

/* ── CALENDAR (holiday marking) ─────────────────────────────────── */

/* The ISO week of a date (the year that owns it via its Thursday). */
function isoWeekOf(date) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + 4 - (d.getDay() || 7));
    return { year: d.getFullYear(), week: getISOWeek(d) };
}

/* Build the months of a calendar year, each holding the ISO weeks whose
   Thursday falls in that month. A week thus appears in exactly one month, and
   weeks around year boundaries land in the correct month (and may carry an
   adjacent ISO year, e.g. 2026-W01 shown under January even if its Monday is
   in Dec). Returns [{ name, weeks: ["YYYY-Www", ...] }, ...] of length 12. */
function monthsOfYear(year) {
    const months = Array.from({ length: 12 }, (_, m) => ({
        name: new Date(year, m, 1).toLocaleDateString("en-US", { month: "long" }),
        weeks: [],
    }));
    const seen = new Set();
    // Walk every Monday from a little before Jan to a little after Dec, placing
    // each week by its Thursday's month if that Thursday is in `year`. Start
    // aligned to a Monday so the Monday→Thursday (+3) offset is correct.
    let d = new Date(year, 0, 1);
    d.setDate(d.getDate() - ((d.getDay() || 7) - 1)); // back up to Monday
    d.setDate(d.getDate() - 7);                        // and one week earlier
    for (let i = 0; i < 60; i++) {
        const thu = new Date(d);
        thu.setDate(thu.getDate() + 3); // Monday→Thursday
        if (thu.getFullYear() === year) {
            const iso = isoWeekOf(d);
            const key = `${iso.year}-W${String(iso.week).padStart(2, "0")}`;
            if (!seen.has(key)) {
                seen.add(key);
                months[thu.getMonth()].weeks.push(key);
            }
        }
        d.setDate(d.getDate() + 7);
    }
    return months;
}

/* Calendar tab: a plain year grid (months → ISO weeks). Click a week to toggle
   it as a global holiday. Every week of every year is freely markable; a year
   selector moves between years. No project shading (holidays are global). */
function CalendarTab({ holidays, onToggle }) {
    const [year, setYear] = useState(() => parseWeekKey(currentWeekKey())?.year || new Date().getFullYear());
    const holSet = useMemo(() => new Set(holidays || []), [holidays]);
    const months = useMemo(() => monthsOfYear(year), [year]);
    const today = currentWeekKey();
    const holidayCountThisYear = months.reduce(
        (acc, m) => acc + m.weeks.filter(w => holSet.has(w)).length, 0
    );

    return (
        <div>
            <div style={styles.calHeader}>
                <button style={styles.stepBtn} onClick={() => setYear(y => y - 1)} title="Previous year">‹</button>
                <span style={styles.calYear}>{year}</span>
                <button style={styles.stepBtn} onClick={() => setYear(y => y + 1)} title="Next year">›</button>
                <button style={styles.btnSecondary} onClick={() => setYear(parseWeekKey(currentWeekKey()).year)} title="Jump to this year">This year</button>
                <span style={{ ...styles.meta, marginLeft: "auto" }}>
                    {holidayCountThisYear} holiday week{holidayCountThisYear === 1 ? "" : "s"} marked in {year}
                </span>
            </div>
            <div style={styles.meta}>
                Click a week to mark it as a holiday (a week you are not working at all). Holidays are global across all projects and reduce each project's working weeks. You can still log hours in a holiday week.
            </div>
            <div style={styles.calMonths}>
                {months.map(m => (
                    <div key={m.name} style={styles.calMonth}>
                        <div style={styles.calMonthName}>{m.name}</div>
                        <div style={styles.calWeeks}>
                            {m.weeks.map(wk => {
                                const isHol = holSet.has(wk);
                                const isNow = wk === today;
                                const wkNum = parseWeekKey(wk)?.week;
                                return (
                                    <button
                                        key={wk}
                                        onClick={() => onToggle(wk)}
                                        title={`${wk}${isHol ? " · holiday (click to unmark)" : " · click to mark holiday"}`}
                                        style={{
                                            ...styles.calWeekCell,
                                            ...(isHol ? styles.calWeekHoliday : {}),
                                            ...(isNow ? styles.calWeekNow : {}),
                                        }}
                                    >
                                        W{String(wkNum).padStart(2, "0")}
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}

/* ── MAIN APP ───────────────────────────────────────────────────── */

function UrenTracker() {
    const [data, setData] = useState(null);        // { projects, weeks }
    const [loading, setLoading] = useState(true);
    const [tab, setTab] = useState("charts");    // "charts" | "overview" | "entry" | "projects"
    const [editProject, setEditProject] = useState(null); // null | project object
    const [showNewProject, setShowNewProject] = useState(false);
    const [selectedWeekKey, setSelectedWeekKey] = useState(currentWeekKey()); // Entry tab
    const [entryProjectId, setEntryProjectId] = useState(null); // Entry tab: project opened for editing (null = overview)
    const [csvStatus, setCsvStatus] = useState("");                   // CSV export feedback
    const [csvText, setCsvText] = useState("");                       // CSV inline fallback
    // Blocking startup problem: "duplicate" (>1 data note) or "error".
    // { status, candidates?, message? } | null
    const [dataError, setDataError] = useState(null);

    /* The resolved data note's id lives in a ref so every save targets the same
       note for the whole session — even saves fired from inside setData updaters
       that don't re-read component state. */
    const dataNoteIdRef = useRef(null);

    /* Save helper used everywhere: a no-op if the note isn't resolved (e.g. we
       stopped on a duplicate/error banner), so stray saves can't write to the
       wrong place. */
    const writeData = useCallback(async (newData) => {
        const id = dataNoteIdRef.current;
        if (!id) return;
        await saveData(id, newData);
    }, []);

    /* Resolve the single data note on startup, then load it. If two or more
       notes carry the label we stop and show a banner rather than guessing
       which one is authoritative (which would risk writing to the wrong note
       and losing data). */
    useEffect(() => {
        const parentId = api.startNote ? api.startNote.noteId : "root";
        resolveDataNote(parentId)
            .then(res => {
                if (res.status === "duplicate") {
                    setDataError(res);
                    setLoading(false);
                    return null;
                }
                if (res.status === "error") {
                    setDataError(res);
                    setLoading(false);
                    return null;
                }
                dataNoteIdRef.current = res.noteId;
                return loadData(res.noteId).then(d => {
                    setData(normalizeData(d));
                    setLoading(false);
                });
            })
            .catch(err => {
                console.error("Hours Tracker: init failed", err);
                setDataError({ status: "error", message: String(err && err.message || err) });
                setLoading(false);
            });
    }, []);

    /* Persist data on every change */
    const persist = useCallback(async (newData) => {
        setData(newData);
        await writeData(newData);
    }, [writeData]);

    /* ── Project management ── */
    const handleSaveProject = useCallback(async (project) => {
        setData(prev => {
            const projects = prev.projects.some(p => p.id === project.id)
                ? prev.projects.map(p => p.id === project.id ? project : p)
                : [...prev.projects, project];
            const newData = { ...prev, projects };
            writeData(newData);
            return newData;
        });
        setEditProject(null);
        setShowNewProject(false);
    }, [writeData]);

    const handleArchiveProject = useCallback(async (id, archived) => {
        setData(prev => {
            const newData = {
                ...prev,
                projects: prev.projects.map(p => p.id === id ? { ...p, archived } : p),
            };
            writeData(newData);
            return newData;
        });
    }, [writeData]);

    const handleCleanup = useCallback(async () => {
        setData(prev => {
            const archivedIds = new Set(prev.projects.filter(p => p.archived).map(p => p.id));
            if (archivedIds.size === 0) return prev;
            if (!confirm(`Permanently remove ${archivedIds.size} archived project(s) and all their hour records? This cannot be undone.`)) return prev;

            const projects = prev.projects.filter(p => !archivedIds.has(p.id));

            // Strip archived projects out of every week, dropping now-empty weeks.
            const weeks = {};
            for (const [wk, weekData] of Object.entries(prev.weeks)) {
                const kept = {};
                for (const [pid, cell] of Object.entries(weekData)) {
                    if (!archivedIds.has(pid)) kept[pid] = cell;
                }
                if (Object.keys(kept).length > 0) weeks[wk] = kept;
            }

            const newData = { ...prev, projects, weeks };
            writeData(newData);
            return newData;
        });
    }, [writeData]);

    /* Export all hour records as CSV. The project column holds the project
       NAME (not its id), plus a separate project code column. One row per
       (week, project) with summed hours.

       In a Trilium render note the widget runs inside the app, where a plain
       anchor-download can be silently swallowed. We try the Blob + anchor
       route first and fall back to opening the CSV as a data URI in a new tab,
       and surface the outcome via csvStatus so the button gives feedback. */
    const handleExportCsv = useCallback(async () => {
        const byId = {};
        for (const p of data.projects) byId[p.id] = p;

        const esc = (v) => {
            const s = String(v ?? "");
            return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        };

        const rows = [["Week", "Project", "Code", "Hours"]];
        for (const wk of Object.keys(data.weeks).sort()) {
            const weekData = data.weeks[wk] || {};
            for (const pid of Object.keys(weekData)) {
                const cell = weekData[pid];
                if (!Array.isArray(cell) || cell.length === 0) continue; // no entry
                const hours = sumCell(cell); // may be a deliberate 0
                const p = byId[pid];
                rows.push([wk, p ? p.name : pid, p ? (p.code || "") : "", hours]);
            }
        }

        if (rows.length === 1) {
            setCsvStatus("Nothing to export yet");
            setTimeout(() => setCsvStatus(""), 2500);
            return;
        }

        const csv = rows.map(r => r.map(esc).join(",")).join("\r\n");
        const filename = `hours_export_${currentWeekKey()}.csv`;
        const payload = "\uFEFF" + csv;

        const clear = () => setTimeout(() => setCsvStatus(""), 5000);
        const blob = new Blob([payload], { type: "text/csv;charset=utf-8;" });

        // 1) Real "Save as…" dialog where supported (Chrome / Trilium desktop).
        if (typeof window.showSaveFilePicker === "function") {
            try {
                const handle = await window.showSaveFilePicker({
                    suggestedName: filename,
                    types: [{ description: "CSV file", accept: { "text/csv": [".csv"] } }],
                });
                const writable = await handle.createWritable();
                await writable.write(blob);
                await writable.close();
                setCsvStatus(`✓ Saved as ${handle.name}`);
                clear();
                return;
            } catch (err) {
                if (err && err.name === "AbortError") { setCsvStatus(""); return; } // user cancelled
                console.warn("Hours Tracker: save picker failed, falling back", err);
            }
        }

        // 2) Anchor download. The widget runs inside a sandboxed iframe, so a
        //    click on an anchor in THIS document can be swallowed. Attaching the
        //    anchor to the TOP-LEVEL document (when same-origin) makes the
        //    browser treat it as a normal user download → Downloads folder.
        const url = URL.createObjectURL(blob);
        let topDoc = document;
        try { if (window.top && window.top.document) topDoc = window.top.document; } catch (_) { /* cross-origin */ }
        try {
            const a = topDoc.createElement("a");
            a.href = url;
            a.download = filename;
            a.rel = "noopener";
            a.style.display = "none";
            topDoc.body.appendChild(a);
            a.click();
            topDoc.body.removeChild(a);
            setCsvStatus(`✓ Saved "${filename}" to your Downloads folder`);
            setTimeout(() => URL.revokeObjectURL(url), 4000);
            clear();
            return;
        } catch (err) {
            console.warn("Hours Tracker: anchor download failed", err);
        }

        // 3) Open the file in a new top-level tab; the browser shows/saves it.
        try {
            const win = window.open(url, "_blank");
            if (win) {
                setCsvStatus("✓ Opened in a new tab — use your browser's Save");
                setTimeout(() => URL.revokeObjectURL(url), 60000);
                clear();
                return;
            }
        } catch (err) {
            console.warn("Hours Tracker: open-in-tab failed", err);
        }
        URL.revokeObjectURL(url);

        // 4) Guaranteed escape hatch: show the CSV on screen to copy.
        setCsvText(payload);
        setCsvStatus("Couldn't write a file here — copy the text below");
    }, [data]);

    /* ── Weekly hours entry (per project, per week) ── */

    /* Save the list of hour entries for one project in one week.
       `hours` is an array of numbers, e.g. [2, 3, 1.5]. An empty array clears
       the cell. Other projects' cells in the same week are left untouched. */
    const handleSaveCell = useCallback(async (weekKey, projectId, hours) => {
        // Build the next data object from the latest state, persist it, and only
        // resolve once the backend save has completed (so the caller's "Saved"
        // feedback reflects a real write). We compute newData synchronously
        // inside the updater, stash it, then await saveData outside.
        let toSave = null;
        setData(prev => {
            const week = { ...(prev.weeks[weekKey] || {}) };
            if (hours.length === 0) {
                delete week[projectId];
            } else {
                week[projectId] = hours;
            }
            // Drop a fully-empty week object to keep the JSON tidy, matching the
            // existing clear-cell behaviour.
            const weeks = { ...prev.weeks, [weekKey]: week };
            if (Object.keys(week).length === 0) delete weeks[weekKey];
            toSave = { ...prev, weeks };
            return toSave;
        });
        if (toSave) await writeData(toSave);
    }, [writeData]);

    /* Remove a project's entry for a given week (used by the per-week delete
       button in the Entry list). Leaves the week itself intact for others. */
    const handleClearCell = useCallback(async (weekKey, projectId) => {
        if (!confirm(`Clear hours for this project in ${weekKey}?`)) return;
        setData(prev => {
            const week = { ...(prev.weeks[weekKey] || {}) };
            delete week[projectId];
            const weeks = { ...prev.weeks, [weekKey]: week };
            // Drop the week entirely if no project has data left in it.
            if (Object.keys(week).length === 0) delete weeks[weekKey];
            const newData = { ...prev, weeks };
            writeData(newData);
            return newData;
        });
    }, [writeData]);

    /* Toggle a week's global holiday flag (Calendar tab). Holidays are a flat,
       de-duplicated array of week keys; they affect working-week counts but not
       whether hours can be logged. */
    const toggleHoliday = useCallback((weekKey) => {
        setData(prev => {
            const set = new Set(prev.holidays || []);
            if (set.has(weekKey)) set.delete(weekKey); else set.add(weekKey);
            const newData = { ...prev, holidays: [...set].sort(compareWeekKeys) };
            writeData(newData);
            return newData;
        });
    }, [writeData]);

    /* ── Calculations ── */
    const holidaySet = useMemo(
        () => new Set((data && data.holidays) || []),
        [data]
    );

    const stats = useMemo(() => {
        if (!data) return {};
        const result = {};
        for (const p of data.projects) {
            result[p.id] = calcProjectStats(p, data.weeks, holidaySet);
        }
        return result;
    }, [data, holidaySet]);

    /* Rolled-up totals across all projects */
    const totals = useMemo(() => {
        if (!data) return null;
        let totalMade = 0, totalBudget = 0, totalRemaining = 0;
        for (const p of data.projects) {
            if (p.archived) continue;
            const s = stats[p.id];
            totalMade += s.madeHours;
            totalBudget += p.totalHours;
            totalRemaining += s.remainingHours;
        }
        return { totalMade, totalBudget, totalRemaining };
    }, [data, stats]);

    /* ── Entry tab: overview-first flow ──
       The Entry tab opens straight to the all-projects overview for the
       selected week. Each project row has an Edit button that opens that
       single project's week-entry editor inline (entryProjectId), mirroring
       the edit-in-place principle used on the Projects tab. Saving returns to
       the overview. */

    // Active projects that can be written to in the currently-selected week.
    const projectsForWeek = useMemo(() => {
        if (!data) return [];
        return data.projects.filter(p => !p.archived && isWeekWritable(p, selectedWeekKey));
    }, [data, selectedWeekKey]);

    /* If the project currently open for editing stops being valid (e.g. the
       week was stepped to one outside its range, or it was removed), drop back
       to the overview rather than showing an empty editor. */
    useEffect(() => {
        if (!data || entryProjectId == null) return;
        const proj = data.projects.find(p => p.id === entryProjectId);
        if (!proj || !isWeekWritable(proj, selectedWeekKey)) {
            setEntryProjectId(null);
        }
    }, [data, entryProjectId, selectedWeekKey]);

    /* Weeks shown for the project being edited: every week that already has an
       entry, PLUS the selected week (always included so it can be filled in
       even when it doesn't exist yet — this is the auto-create). Newest first. */
    const rowsForSelected = useMemo(() => {
        if (!data || entryProjectId == null) return [];
        const withEntries = Object.keys(data.weeks).filter(wk => {
            const cell = data.weeks[wk]?.[entryProjectId];
            return Array.isArray(cell) && cell.length > 0;
        });
        const set = new Set(withEntries);
        if (isWeekWritable(data.projects.find(p => p.id === entryProjectId) || {}, selectedWeekKey)) {
            set.add(selectedWeekKey);
        }
        return [...set].sort(compareWeekKeys).reverse();
    }, [data, entryProjectId, selectedWeekKey]);

    /* All-projects summary for the selected week. Shows every project that is
       writable in the selected week, PLUS any project that already has an entry
       that week (e.g. archived or out-of-range historical entries). Projects
       with no entry yet are flagged (empty: true) so the UI can mark them
       subtly — turning this into a "what still needs filling in" check.
       Filled rows (incl. deliberate 0) come first by hours desc, empty last. */
    const weekSummary = useMemo(() => {
        if (!data) return { rows: [], total: 0, missing: 0 };
        const weekData = data.weeks[selectedWeekKey] || {};
        const byId = {};
        for (const p of data.projects) byId[p.id] = p;

        // Project ids to consider: writable this week ∪ already-has-an-entry.
        const ids = new Set();
        for (const p of data.projects) {
            if (isWeekWritable(p, selectedWeekKey)) ids.add(p.id);
        }
        for (const pid of Object.keys(weekData)) {
            const cell = weekData[pid];
            if (Array.isArray(cell) && cell.length > 0) ids.add(pid);
        }

        const rows = [];
        let total = 0;
        let missing = 0;
        for (const pid of ids) {
            const p = byId[pid];
            const cell = weekData[pid];
            const hasEntry = Array.isArray(cell) && cell.length > 0;
            const hours = hasEntry ? sumCell(cell) : 0; // hours may be a deliberate 0
            if (hasEntry) total += hours; else missing += 1;
            // Needed/week for the remaining weeks — the same figure shown on the
            // Overview tab — surfaced here so the Entry overview hints at the
            // target alongside what's actually been logged. Only meaningful for
            // known (non-deleted) projects.
            const neededPerWeek = (p && stats[pid]) ? stats[pid].neededPerWeek : 0;
            rows.push({
                id: pid,
                name: p ? p.name : pid,
                code: p ? (p.code || "") : "",
                color: p ? (p.color || "") : "",
                archived: p ? !!p.archived : false,
                writable: p ? isWeekWritable(p, selectedWeekKey) : false,
                empty: !hasEntry,
                hours,
                neededPerWeek,
            });
        }
        // Filled first (by hours desc), then empty (alphabetical).
        rows.sort((a, b) => {
            if (a.empty !== b.empty) return a.empty ? 1 : -1;
            if (a.empty) return a.name.localeCompare(b.name);
            return b.hours - a.hours;
        });
        return { rows, total, missing };
    }, [data, selectedWeekKey, stats]);

    if (loading) return <div style={styles.loading}>Loading…</div>;

    /* Startup couldn't resolve a single data note. Don't render the tracker —
       any write could go to the wrong note — show a clear, actionable message
       instead. */
    if (dataError) {
        return (
            <div style={styles.root}>
                <div style={styles.header}>
                    <span style={styles.appTitle}>Hours Tracker</span>
                </div>
                {dataError.status === "duplicate" ? (
                    <div style={styles.errorBox}>
                        <div style={styles.errorBoxTitle}>Multiple data notes found</div>
                        <p style={styles.errorBoxText}>
                            The tracker needs exactly one note labelled <code>#hourdata</code>,
                            but it found {dataError.candidates.length}. To avoid writing to the
                            wrong note and losing data, it won't load until only one remains.
                            Open these notes and delete or relabel all but the one you want to
                            keep:
                        </p>
                        <ul style={styles.errorBoxList}>
                            {dataError.candidates.map(c => (
                                <li key={c.noteId} style={styles.errorBoxItem}>
                                    <span style={{ fontWeight: "500" }}>{c.title}</span>{" "}
                                    <span style={styles.meta}>· noteId </span>
                                    <code>{c.noteId}</code>
                                </li>
                            ))}
                        </ul>
                        <p style={styles.errorBoxText}>
                            Then reload this note. (Tip: if one of these is an empty note the
                            tracker created automatically, that's usually the one to remove.)
                        </p>
                    </div>
                ) : (
                    <div style={styles.errorBox}>
                        <div style={styles.errorBoxTitle}>Couldn't open the data note</div>
                        <p style={styles.errorBoxText}>
                            Something went wrong reading or creating the tracker's data note.
                            Reloading often resolves it. Details:
                        </p>
                        <pre style={styles.errorBoxPre}>{dataError.message || "unknown error"}</pre>
                    </div>
                )}
            </div>
        );
    }

    const tabLabels = { charts: "Charts", overview: "Overview", entry: "Entry", calendar: "Calendar", projects: "Projects" };

    return (
        <div style={styles.root}>
            <h2 style={styles.srOnly}>Hours tracker — overview of worked and planned hours per project</h2>

            {/* ── Header ── */}
            <div style={styles.header}>
                <span style={styles.appTitle}>Hours Tracker</span>
                <div style={styles.tabs}>
                    {["charts", "overview", "entry", "projects", "calendar"].map(t => (
                        <button
                            key={t}
                            style={tab === t ? styles.tabActive : styles.tab}
                            onClick={() => setTab(t)}
                            title={tabLabels[t]}
                            aria-label={tabLabels[t]}
                        >
                            {t === "calendar" ? (
                                /* Inline calendar glyph (no icon-font dependency) */
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                                    stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
                                    style={styles.tabIcon}>
                                    <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
                                    <line x1="16" y1="2" x2="16" y2="6"></line>
                                    <line x1="8" y1="2" x2="8" y2="6"></line>
                                    <line x1="3" y1="10" x2="21" y2="10"></line>
                                </svg>
                            ) : tabLabels[t]}
                        </button>
                    ))}
                </div>
            </div>

            {/* ── Tab: Overview ── */}
            {tab === "overview" && (
                <div>
                    {/* Totals summary */}
                    {totals && data.projects.length > 0 && (
                        <div style={styles.summaryBar}>
                            <SummaryCell label="Total budget" value={`${totals.totalBudget}h`} />
                            <SummaryCell label="Worked so far" value={`${totals.totalMade.toFixed(1)}h`} />
                            <SummaryCell label="Remaining budget" value={`${totals.totalRemaining.toFixed(1)}h`} />
                        </div>
                    )}

                    {data.projects.filter(p => !p.archived).length === 0 ? (
                        <div style={styles.emptyState}>
                            No active projects. Go to <strong>Projects</strong> to get started.
                        </div>
                    ) : (
                        <div style={styles.cardList}>
                            {data.projects.filter(p => !p.archived).map(p => (
                                <ProjectCard
                                    key={p.id}
                                    project={p}
                                    stats={stats[p.id]}
                                    onEdit={() => { setEditProject(p); setTab("projects"); }}
                                />
                            ))}
                        </div>
                    )}
                </div>
            )}

            {/* ── Tab: Entry ── */}
            {tab === "entry" && (
                <div>
                    {data.projects.length === 0 ? (
                        <div style={styles.emptyState}>Add projects first via the <strong>Projects</strong> tab.</div>
                    ) : (
                        <>
                            {/* Picker bar — week selection. When a single project
                                is open for editing, a Back control returns to the
                                overview. */}
                            <div style={styles.pickerBar}>
                                <div style={styles.pickerGroup}>
                                    <span style={styles.pickerLabel}>Week</span>
                                    <button
                                        style={styles.stepBtn}
                                        title="Previous week"
                                        onClick={() => setSelectedWeekKey(wk => addWeeks(wk, -1))}
                                    >‹</button>
                                    <input
                                        type="week"
                                        style={{ ...styles.input, width: "150px" }}
                                        value={selectedWeekKey}
                                        onChange={e => { if (e.target.value) setSelectedWeekKey(e.target.value); }}
                                    />
                                    <button
                                        style={styles.stepBtn}
                                        title="Next week"
                                        onClick={() => setSelectedWeekKey(wk => addWeeks(wk, 1))}
                                    >›</button>
                                    <button
                                        style={styles.btnSecondary}
                                        title="Jump to the current week"
                                        onClick={() => setSelectedWeekKey(currentWeekKey())}
                                    >Today</button>
                                </div>

                                {entryProjectId != null && (
                                    <>
                                        <div style={styles.pickerDivider} />
                                        <div style={styles.pickerGroup}>
                                            <button
                                                style={styles.btnSecondary}
                                                title="Back to the week overview"
                                                onClick={() => setEntryProjectId(null)}
                                            >‹ Overview</button>
                                        </div>
                                    </>
                                )}
                            </div>

                            {/* Default view: all-projects overview for the selected
                                week. Each writable project has an Edit button that
                                opens its hour editor inline. */}
                            {entryProjectId == null && (
                                weekSummary.rows.length === 0 ? (
                                    <div style={styles.emptyState}>No projects are open for {selectedWeekKey}.</div>
                                ) : (
                                    <div style={styles.card}>
                                        <div style={styles.cardHeader}>
                                            <span style={styles.projectName}>All projects · {selectedWeekKey}</span>
                                            <span style={styles.badge("var(--more-accented-background-color,#eef0ee)", "var(--main-text-color,#333)")}>
                                                {weekSummary.total.toFixed(1)}h total
                                            </span>
                                        </div>
                                        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                                            {weekSummary.rows.map(r => (
                                                <div
                                                    key={r.id}
                                                    style={r.empty ? { ...styles.summaryRow, ...styles.summaryRowEmpty } : styles.summaryRow}
                                                >
                                                    <span style={{ display: "flex", alignItems: "center", gap: "8px", minWidth: 0 }}>
                                                        {r.color && (
                                                            <span style={{ display: "inline-block", width: "10px", height: "10px", borderRadius: "2px", background: r.color, opacity: r.empty ? 0.4 : 1, flex: "0 0 auto" }} />
                                                        )}
                                                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                                            {r.name}{r.code ? ` (${r.code})` : ""}
                                                            {r.archived && <span style={styles.meta}> · archived</span>}
                                                        </span>
                                                    </span>
                                                    <span style={{ display: "flex", alignItems: "center", gap: "10px", flex: "0 0 auto" }}>
                                                        {r.empty ? (
                                                            <span style={styles.notFilledTag}>not filled in</span>
                                                        ) : (
                                                            <span style={{ display: "flex", alignItems: "baseline", gap: "6px", whiteSpace: "nowrap" }}>
                                                                <span style={{ fontWeight: "500" }}>{r.hours.toFixed(1)}h</span>
                                                                {r.neededPerWeek > 0 && (
                                                                    <span style={styles.neededHint} title="Needed per week for the remaining weeks (from Overview)">
                                                                        / {r.neededPerWeek.toFixed(1)}h needed
                                                                    </span>
                                                                )}
                                                            </span>
                                                        )}
                                                        {r.empty && r.neededPerWeek > 0 && (
                                                            <span style={styles.neededHint} title="Needed per week for the remaining weeks (from Overview)">
                                                                {r.neededPerWeek.toFixed(1)}h needed
                                                            </span>
                                                        )}
                                                        {r.writable && (
                                                            <button
                                                                style={styles.iconBtn}
                                                                title="Edit hours for this project"
                                                                onClick={() => setEntryProjectId(r.id)}
                                                            >✎</button>
                                                        )}
                                                    </span>
                                                </div>
                                            ))}
                                        </div>
                                        <div style={{ ...styles.meta, marginTop: "8px" }}>
                                            {weekSummary.missing > 0
                                                ? `${weekSummary.missing} project${weekSummary.missing === 1 ? "" : "s"} not filled in yet. `
                                                : "All open projects filled in. "}
                                            Use the ✎ button to edit a project's hours.
                                        </div>
                                    </div>
                                )
                            )}

                            {/* Inline editor for one project. Saving the selected
                                week's row returns to the overview. */}
                            {entryProjectId != null && (() => {
                                const proj = data.projects.find(p => p.id === entryProjectId);
                                const rows = rowsForSelected;
                                return (
                                    <div>
                                        <div style={{ ...styles.cardHeader, marginBottom: "10px" }}>
                                            <span style={styles.projectName}>
                                                {proj ? proj.name : entryProjectId}{proj && proj.code ? ` (${proj.code})` : ""}
                                            </span>
                                            {proj && stats[proj.id] && stats[proj.id].remainingWorkingWeeks > 0 && (
                                                <span style={styles.meta} title="Pace required from now to finish the budget, over the remaining working weeks (holidays excluded)">
                                                    need {stats[proj.id].neededPerWeek.toFixed(1)}h/wk from here · {stats[proj.id].remainingWorkingWeeks} working wks left
                                                </span>
                                            )}
                                        </div>
                                        {rows.length === 0 ? (
                                            <div style={styles.emptyState}>No writable weeks for this project.</div>
                                        ) : (
                                            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                                                {rows.map(wk => (
                                                    <WeekEntry
                                                        key={`${entryProjectId}:${wk}`}
                                                        weekKey={wk}
                                                        cell={data.weeks[wk]?.[entryProjectId]}
                                                        active={wk === selectedWeekKey}
                                                        onSave={async (weekKey, hours) => {
                                                            await handleSaveCell(weekKey, entryProjectId, hours);
                                                            // Saving the selected week closes the editor and
                                                            // returns to the overview (Projects-tab principle).
                                                            if (weekKey === selectedWeekKey) setEntryProjectId(null);
                                                        }}
                                                        onClear={(weekKey) => handleClearCell(weekKey, entryProjectId)}
                                                        onCancel={wk === selectedWeekKey ? () => setEntryProjectId(null) : undefined}
                                                    />
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                );
                            })()}
                        </>
                    )}
                </div>
            )}

            {/* ── Tab: Charts ── */}
            {tab === "charts" && (
                <ChartsTab data={data} stats={stats} />
            )}

            {/* ── Tab: Calendar ── */}
            {tab === "calendar" && (
                <CalendarTab holidays={data.holidays} onToggle={toggleHoliday} />
            )}

            {/* ── Tab: Projects ── */}
            {tab === "projects" && (
                <div>
                    {editProject && (
                        <ProjectForm
                            initial={editProject}
                            holidays={data.holidays}
                            onSave={handleSaveProject}
                            onCancel={() => setEditProject(null)}
                        />
                    )}
                    {showNewProject && !editProject && (
                        <ProjectForm
                            holidays={data.holidays}
                            onSave={handleSaveProject}
                            onCancel={() => setShowNewProject(false)}
                        />
                    )}
                    {!editProject && !showNewProject && (
                        <div style={{ display: "flex", gap: "8px", marginBottom: "12px", flexWrap: "wrap" }}>
                            <button style={styles.btnPrimary} onClick={() => setShowNewProject(true)}>
                                + New project
                            </button>
                            <button
                                style={{
                                    ...styles.btnSecondary,
                                    color: "var(--main-text-color, #333)",
                                    opacity: Object.keys(data.weeks).length ? 1 : 0.5,
                                }}
                                disabled={Object.keys(data.weeks).length === 0}
                                onClick={handleExportCsv}
                                title="Download all hour records as a CSV file"
                            >
                                Export CSV
                            </button>
                            {csvStatus && <span style={{ ...styles.savedTag, alignSelf: "center" }}>{csvStatus}</span>}
                            <button
                                style={{
                                    ...styles.btnSecondary,
                                    color: "var(--color-text-danger,#c62828)",
                                    opacity: data.projects.some(p => p.archived) ? 1 : 0.5,
                                }}
                                disabled={!data.projects.some(p => p.archived)}
                                onClick={handleCleanup}
                                title="Permanently remove all archived projects and their hour records"
                            >
                                Clean up archived
                            </button>
                        </div>
                    )}
                    {csvText && (
                        <div style={styles.formBox}>
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
                                <span style={styles.formTitle}>CSV (copy &amp; paste into a file)</span>
                                <div style={{ display: "flex", gap: "6px" }}>
                                    <button
                                        style={styles.btnPrimary}
                                        onClick={() => {
                                            try {
                                                navigator.clipboard.writeText(csvText);
                                                setCsvStatus("✓ Copied to clipboard");
                                                setTimeout(() => setCsvStatus(""), 2500);
                                            } catch (e) {
                                                setCsvStatus("Select the text and copy manually");
                                            }
                                        }}
                                    >Copy</button>
                                    <button style={styles.btnSecondary} onClick={() => setCsvText("")}>Close</button>
                                </div>
                            </div>
                            <textarea
                                readOnly
                                value={csvText}
                                onFocus={e => e.target.select()}
                                style={{ ...styles.input, width: "100%", minHeight: "160px", fontFamily: "monospace", fontSize: "12px" }}
                            />
                        </div>
                    )}
                    {data.projects.length === 0 && !showNewProject && (
                        <div style={styles.emptyState}>No projects yet.</div>
                    )}
                    <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginTop: "8px" }}>
                        {data.projects.map(p => (
                            <div
                                key={p.id}
                                style={{ ...styles.projectListRow, opacity: p.archived ? 0.55 : 1 }}
                            >
                                <div>
                                    {p.color && (
                                        <span style={{ display: "inline-block", width: "10px", height: "10px", borderRadius: "2px", background: p.color, marginRight: "6px", verticalAlign: "middle" }} />
                                    )}
                                    <span style={styles.projectName}>{p.name}{p.code ? ` (${p.code})` : ""}</span>
                                    {p.archived && <span style={styles.meta}> · archived</span>}
                                    <span style={styles.meta}> — {p.totalHours}h budget · {p.startWeek || "?"}→{p.endWeek || "?"} · {stats[p.id] ? `${stats[p.id].totalWorkingWeeks} working wks · ${stats[p.id].plannedPerWeek.toFixed(1)}h/wk` : ""}</span>
                                </div>
                                <div style={{ display: "flex", gap: "6px" }}>
                                    <button style={styles.iconBtn} onClick={() => setEditProject(p)} title="Edit project">✎</button>
                                    <button
                                        style={styles.iconBtn}
                                        onClick={() => handleArchiveProject(p.id, !p.archived)}
                                        title={p.archived ? "Unarchive project" : "Archive project"}
                                    >
                                        {p.archived ? "↩" : "🗄"}
                                    </button>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}

function SummaryCell({ label, value, highlight, positive }) {
    const color = highlight
        ? "var(--color-text-danger,#c62828)"
        : positive
            ? "var(--color-text-success,#2e7d32)"
            : "var(--main-text-color,#333)";
    return (
        <div style={styles.summaryCell}>
            <div style={styles.statLabel}>{label}</div>
            <div style={{ ...styles.statValue, fontSize: "18px", color }}>{value}</div>
        </div>
    );
}

/* ── STYLES ─────────────────────────────────────────────────────── */

const styles = {
    srOnly: {
        position: "absolute",
        width: "1px",
        height: "1px",
        padding: "0",
        margin: "-1px",
        overflow: "hidden",
        clip: "rect(0,0,0,0)",
        whiteSpace: "nowrap",
        border: "0",
    },
    root: {
        fontFamily: "var(--font-sans, sans-serif)",
        color: "var(--main-text-color, #333)",
        padding: "0 1.25rem 2rem",
        maxWidth: "1200px",
    },
    loading: {
        padding: "2rem",
        color: "var(--muted-text-color, #888)",
    },
    header: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        marginBottom: "16px",
        paddingBottom: "10px",
        borderBottom: "0.5px solid var(--main-border-color, #d0d0d0)",
        flexWrap: "wrap",
        gap: "8px",
    },
    appTitle: {
        fontSize: "16px",
        fontWeight: "500",
    },
    tabs: {
        display: "flex",
        gap: "4px",
        alignItems: "center",
    },
    tab: {
        background: "transparent",
        border: "0.5px solid var(--main-border-color, #d0d0d0)",
        borderRadius: "6px",
        padding: "4px 12px",
        fontSize: "13px",
        cursor: "pointer",
        color: "var(--muted-text-color, #666)",
    },
    tabActive: {
        background: "var(--active-item-background-color, #444)",
        border: "0.5px solid transparent",
        borderRadius: "6px",
        padding: "4px 12px",
        fontSize: "13px",
        cursor: "pointer",
        color: "var(--active-item-text-color, #fff)",
    },
    tabIcon: {
        display: "block",
        margin: "1px 0",
    },
    summaryBar: {
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
        gap: "10px",
        marginBottom: "16px",
        padding: "12px",
        background: "var(--accented-background-color, #fafafa)",
        borderRadius: "8px",
        border: "0.5px solid var(--main-border-color, #d0d0d0)",
    },
    summaryCell: {
        display: "flex",
        flexDirection: "column",
        gap: "2px",
    },
    card: {
        background: "var(--more-accented-background-color, #f3f3f3)",
        border: "0.5px solid var(--main-border-color, #d0d0d0)",
        borderRadius: "8px",
        padding: "12px 14px",
    },
    cardList: {
        display: "flex",
        flexDirection: "column",
        gap: "10px",
    },
    cardHeader: {
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        marginBottom: "8px",
        flexWrap: "wrap",
        gap: "6px",
    },
    projectName: {
        fontWeight: "500",
        fontSize: "14px",
    },
    statsGrid: {
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(100px, 1fr))",
        gap: "8px",
        margin: "10px 0 8px",
    },
    statCell: {
        background: "var(--main-background-color, #fff)",
        border: "0.5px solid var(--main-border-color, #d0d0d0)",
        borderRadius: "6px",
        padding: "6px 8px",
    },
    statLabel: {
        fontSize: "11px",
        color: "var(--muted-text-color, #888)",
        marginBottom: "2px",
    },
    statValue: {
        fontSize: "14px",
        fontWeight: "500",
    },
    metaRow: {
        display: "flex",
        justifyContent: "space-between",
        flexWrap: "wrap",
        gap: "4px",
    },
    meta: {
        fontSize: "11px",
        color: "var(--muted-text-color, #888)",
    },
    progressTrack: {
        height: "4px",
        background: "var(--main-border-color, #d0d0d0)",
        borderRadius: "2px",
        overflow: "hidden",
        marginBottom: "8px",
    },
    progressFill: {
        height: "100%",
        background: "#79a574",
        borderRadius: "2px",
        transition: "width 0.3s",
    },
    badge: (bg, color) => ({
        background: bg,
        color: color,
        fontSize: "11px",
        padding: "2px 8px",
        borderRadius: "4px",
        fontWeight: "500",
        whiteSpace: "nowrap",
    }),
    weekRow: {
        display: "flex",
        alignItems: "flex-start",
        gap: "10px",
        padding: "10px 12px",
        background: "var(--accented-background-color, #fafafa)",
        border: "0.5px solid var(--main-border-color, #d0d0d0)",
        borderRadius: "8px",
        flexWrap: "wrap",
    },
    weekRowActive: {
        background: "var(--more-accented-background-color, #f0f4f0)",
        borderColor: "#79a574",
        boxShadow: "inset 3px 0 0 #79a574",
    },
    activeTag: {
        fontSize: "11px",
        fontWeight: "400",
        color: "#79a574",
    },
    savedTag: {
        fontSize: "12px",
        color: "var(--color-text-success, #2e7d32)",
        whiteSpace: "nowrap",
    },
    weekLabel: {
        fontWeight: "500",
        fontSize: "13px",
        minWidth: "90px",
        paddingTop: "6px",
    },
    weekTotal: {
        fontSize: "11px",
        fontWeight: "400",
        color: "var(--muted-text-color, #888)",
        marginTop: "2px",
    },
    weekInputs: {
        display: "flex",
        gap: "6px",
        flexWrap: "wrap",
        alignItems: "center",
        flex: "1",
    },
    entryChip: {
        display: "flex",
        alignItems: "center",
        gap: "2px",
    },
    entryRemove: {
        background: "transparent",
        border: "0.5px solid var(--main-border-color, #d0d0d0)",
        borderRadius: "4px",
        cursor: "pointer",
        fontSize: "14px",
        lineHeight: "1",
        color: "var(--muted-text-color, #888)",
        padding: "2px 6px",
    },
    weekInput: {
        display: "flex",
        flexDirection: "column",
        gap: "2px",
    },
    weekInputLabel: {
        fontSize: "11px",
        color: "var(--muted-text-color, #888)",
    },
    addWeekRow: {
        display: "flex",
        gap: "8px",
        alignItems: "center",
        marginBottom: "14px",
        flexWrap: "wrap",
    },
    formBox: {
        background: "var(--accented-background-color, #fafafa)",
        border: "0.5px solid var(--main-border-color, #d0d0d0)",
        borderRadius: "8px",
        padding: "14px",
        marginBottom: "14px",
    },
    pickerBar: {
        display: "flex",
        alignItems: "center",
        flexWrap: "wrap",
        gap: "10px 18px",
        padding: "10px 14px",
        marginBottom: "16px",
        background: "var(--more-accented-background-color, #eef0ee)",
        border: "0.5px solid var(--main-border-color, #d0d0d0)",
        borderRadius: "8px",
        boxShadow: "inset 3px 0 0 var(--muted-text-color, #b8b8b8)",
    },
    pickerGroup: {
        display: "flex",
        alignItems: "center",
        gap: "6px",
        flexWrap: "wrap",
    },
    pickerLabel: {
        fontSize: "11px",
        fontWeight: "600",
        textTransform: "uppercase",
        letterSpacing: "0.04em",
        color: "var(--muted-text-color, #888)",
    },
    pickerDivider: {
        width: "0.5px",
        alignSelf: "stretch",
        minHeight: "24px",
        background: "var(--main-border-color, #d0d0d0)",
    },
    stepBtn: {
        background: "transparent",
        color: "var(--muted-text-color, #666)",
        border: "0.5px solid var(--main-border-color, #d0d0d0)",
        borderRadius: "5px",
        padding: "3px 9px",
        fontSize: "15px",
        lineHeight: "1",
        cursor: "pointer",
    },
    weekPickField: {
        display: "flex",
        alignItems: "center",
        gap: "6px",
        flexWrap: "wrap",
    },
    formTitle: {
        fontWeight: "500",
        fontSize: "14px",
        marginBottom: "10px",
    },
    formGrid: {
        display: "grid",
        gridTemplateColumns: "160px 1fr",
        gap: "6px 10px",
        alignItems: "center",
    },
    formLabel: {
        fontSize: "13px",
        color: "var(--muted-text-color, #666)",
    },
    input: {
        background: "var(--main-background-color, #fff)",
        border: "0.5px solid var(--main-border-color, #d0d0d0)",
        borderRadius: "5px",
        padding: "4px 8px",
        fontSize: "13px",
        color: "var(--main-text-color, #333)",
        width: "100%",
        boxSizing: "border-box",
    },
    btnPrimary: {
        background: "var(--active-item-background-color, #444)",
        color: "var(--active-item-text-color, #fff)",
        border: "none",
        borderRadius: "5px",
        padding: "5px 12px",
        fontSize: "13px",
        cursor: "pointer",
        whiteSpace: "nowrap",
    },
    btnSecondary: {
        background: "transparent",
        color: "var(--muted-text-color, #666)",
        border: "0.5px solid var(--main-border-color, #d0d0d0)",
        borderRadius: "5px",
        padding: "5px 12px",
        fontSize: "13px",
        cursor: "pointer",
    },
    iconBtn: {
        background: "transparent",
        border: "none",
        cursor: "pointer",
        fontSize: "14px",
        color: "var(--muted-text-color, #888)",
        padding: "2px 4px",
    },
    errorMsg: {
        color: "var(--color-text-danger,#c62828)",
        fontSize: "12px",
        marginBottom: "8px",
    },
    errorBox: {
        background: "var(--accented-background-color, #fafafa)",
        border: "0.5px solid var(--color-text-danger, #c62828)",
        borderLeft: "3px solid var(--color-text-danger, #c62828)",
        borderRadius: "8px",
        padding: "16px 18px",
        marginTop: "8px",
        color: "var(--main-text-color, #333)",
    },
    errorBoxTitle: {
        fontWeight: "600",
        fontSize: "15px",
        color: "var(--color-text-danger, #c62828)",
        marginBottom: "8px",
    },
    errorBoxText: {
        fontSize: "13px",
        lineHeight: "1.5",
        margin: "0 0 10px",
        color: "var(--main-text-color, #333)",
    },
    errorBoxList: {
        margin: "0 0 10px",
        paddingLeft: "18px",
        display: "flex",
        flexDirection: "column",
        gap: "4px",
    },
    errorBoxItem: {
        fontSize: "13px",
        lineHeight: "1.4",
        color: "var(--main-text-color, #333)",
    },
    errorBoxPre: {
        background: "var(--main-background-color, #fff)",
        border: "0.5px solid var(--main-border-color, #d0d0d0)",
        borderRadius: "5px",
        padding: "8px 10px",
        fontSize: "12px",
        color: "var(--main-text-color, #333)",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        margin: "0",
    },
    emptyState: {
        color: "var(--muted-text-color, #888)",
        fontSize: "13px",
        padding: "1.5rem 0",
    },
    summaryRow: {
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: "10px",
        padding: "7px 10px",
        background: "var(--main-background-color, #fff)",
        border: "0.5px solid var(--main-border-color, #d0d0d0)",
        borderRadius: "6px",
        fontSize: "13px",
    },
    summaryRowEmpty: {
        background: "var(--accented-background-color, #f0f0f0)",
        borderStyle: "dashed",
        color: "var(--muted-text-color, #999)",
    },
    notFilledTag: {
        fontSize: "11px",
        fontStyle: "italic",
        color: "var(--muted-text-color, #999)",
        whiteSpace: "nowrap",
    },
    neededHint: {
        fontSize: "11px",
        fontWeight: "400",
        color: "var(--muted-text-color, #999)",
        whiteSpace: "nowrap",
    },
    projectListRow: {
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        padding: "8px 10px",
        background: "var(--accented-background-color, #fafafa)",
        border: "0.5px solid var(--main-border-color, #d0d0d0)",
        borderRadius: "6px",
        flexWrap: "wrap",
        gap: "6px",
    },
    /* ── Charts ── */
    chartCard: {
        background: "var(--accented-background-color, #fafafa)",
        border: "0.5px solid var(--main-border-color, #d0d0d0)",
        borderRadius: "8px",
        padding: "14px",
        marginBottom: "16px",
    },
    chartHeader: {
        display: "flex",
        alignItems: "baseline",
        justifyContent: "space-between",
        gap: "10px",
        marginBottom: "10px",
        flexWrap: "wrap",
    },
    chartTitle: {
        fontWeight: "500",
        fontSize: "14px",
    },
    chartScroll: {
        width: "100%",
        overflowX: "auto",
    },
    chartTickText: {
        fontSize: "10px",
        fill: "var(--muted-text-color, #888)",
        fontFamily: "var(--font-sans, sans-serif)",
    },
    chartLegend: {
        display: "flex",
        gap: "14px",
        flexWrap: "wrap",
        marginBottom: "10px",
    },
    legendItem: {
        display: "flex",
        alignItems: "center",
        gap: "5px",
        fontSize: "11px",
        color: "var(--muted-text-color, #888)",
    },
    legendSwatch: {
        display: "inline-block",
        width: "10px",
        height: "10px",
        borderRadius: "2px",
        flex: "0 0 auto",
    },
    chartChips: {
        display: "flex",
        flexWrap: "wrap",
        gap: "6px",
        marginBottom: "12px",
    },
    chartChip: {
        display: "flex",
        alignItems: "center",
        gap: "6px",
        border: "0.5px solid var(--main-border-color, #d0d0d0)",
        borderRadius: "999px",
        padding: "3px 10px",
        fontSize: "12px",
        color: "var(--main-text-color, #333)",
        cursor: "pointer",
        background: "transparent",
    },
    smallMultiples: {
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
        gap: "12px",
    },
    smChartBox: {
        background: "var(--main-background-color, #fff)",
        border: "0.5px solid var(--main-border-color, #d0d0d0)",
        borderRadius: "6px",
        padding: "8px 10px",
    },
    smChartTitle: {
        display: "flex",
        alignItems: "center",
        gap: "6px",
        fontSize: "12px",
        fontWeight: "500",
        marginBottom: "4px",
    },
    calHeader: {
        display: "flex",
        alignItems: "center",
        gap: "8px",
        marginBottom: "8px",
        flexWrap: "wrap",
    },
    calYear: {
        fontSize: "18px",
        fontWeight: "600",
        minWidth: "60px",
        textAlign: "center",
    },
    calMonths: {
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
        gap: "12px",
        marginTop: "12px",
    },
    calMonth: {
        background: "var(--accented-background-color, #fafafa)",
        border: "0.5px solid var(--main-border-color, #d0d0d0)",
        borderRadius: "8px",
        padding: "10px 12px",
    },
    calMonthName: {
        fontWeight: "500",
        fontSize: "13px",
        marginBottom: "8px",
    },
    calWeeks: {
        display: "flex",
        flexWrap: "wrap",
        gap: "5px",
    },
    calWeekCell: {
        minWidth: "42px",
        padding: "5px 6px",
        fontSize: "11px",
        borderRadius: "5px",
        border: "0.5px solid var(--main-border-color, #d0d0d0)",
        background: "var(--main-background-color, #fff)",
        color: "var(--main-text-color, #333)",
        cursor: "pointer",
        textAlign: "center",
    },
    calWeekHoliday: {
        background: "var(--color-text-danger, #c62828)",
        borderColor: "var(--color-text-danger, #c62828)",
        color: "#fff",
        fontWeight: "500",
    },
    calWeekNow: {
        outline: "2px solid var(--active-item-background-color, #5b8def)",
        outlineOffset: "1px",
    },
};

export default UrenTracker;
