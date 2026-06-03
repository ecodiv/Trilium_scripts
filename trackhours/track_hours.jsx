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
 *      label #urendata (JSON), created on first load.
 *
 * ARCHITECTURE
 *   - Render note widget; `api` is Trilium's FrontendScriptApi.
 *   - One JSON child note (#urendata) stores projects + entered weeks.
 *   - Read-only backend work uses runOnBackend with a SYNCHRONOUS callback
 *     (the API now rejects async callbacks here). Backend work that awaits —
 *     creating the data note, note.save() — uses
 *     runAsyncOnBackendWithManualTransactionHandling instead.
 *   - Preact (not React) via "trilium:preact".
 */

import { useEffect, useState, useCallback, useMemo } from "trilium:preact";
import { runOnBackend, runAsyncOnBackendWithManualTransactionHandling } from "trilium:api";

/* ── CONSTANTS ──────────────────────────────────────────────────── */

const DATA_LABEL = "urendata";

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
    return {
        projects: Array.isArray(obj.projects) ? obj.projects : [],
        weeks: (obj.weeks && typeof obj.weeks === "object" && !Array.isArray(obj.weeks))
            ? obj.weeks
            : {},
    };
}

/* ── BACKEND HELPERS ────────────────────────────────────────────── */

/**
 * Load data from the #urendata child note.
 * Returns { projects: [], weeks: {} } if the note does not exist yet.
 */
async function loadData() {
    // Read-only → synchronous runOnBackend callback. The backend `api` read
    // methods are synchronous, so the callback must NOT be async: runOnBackend
    // now requires a sync function. The data note is found globally by its
    // label (not by walking currentNote's children, which isn't reliable in a
    // render-note widget on the backend).
    return await runOnBackend((label) => {
        const note = api.getNoteWithLabel(label);
        if (!note) return { projects: [], weeks: {} };
        try {
            const raw = note.getContent();
            return raw ? JSON.parse(raw) : { projects: [], weeks: {} };
        } catch (_) {
            return { projects: [], weeks: {} };
        }
    }, [DATA_LABEL]);
}

/**
 * Ensure the #urendata note exists. Created as a JSON code note under
 * parentNoteId (passed from the frontend via api.startNote) on first run.
 * Idempotent; returns the noteId.
 *
 * Note creation awaits api.createNewNote(...) / note.save(), so this MUST use
 * runAsyncOnBackendWithManualTransactionHandling — not the plain (synchronous)
 * runOnBackend, which would never resolve the awaited work (the "stuck on
 * Loading…" symptom).
 */
async function ensureDataNote(parentNoteId) {
    return await runAsyncOnBackendWithManualTransactionHandling(
        async (parentId, label) => {
            let note = api.getNoteWithLabel(label);
            if (note) return note.noteId;

            const created = await api.createNewNote({
                parentNoteId: parentId,
                title: "Hours Tracker Data",
                type: "code",
                mime: "application/json",
                content: "{}",
            });
            note = created.note;
            await note.setLabel(label, "");
            await note.setLabel("hidePromotedAttributes", "");
            await note.setLabel("iconClass", "bx bx-time");
            return note.noteId;
        },
        [parentNoteId, DATA_LABEL]
    );
}

/**
 * Save data to the #urendata note. The note is guaranteed to exist by the
 * time this runs (ensureDataNote is called on mount). Uses the async
 * transaction handler because note.save() is awaited.
 */
async function saveData(data) {
    const json = JSON.stringify(data, null, 2);
    return await runAsyncOnBackendWithManualTransactionHandling(
        async (label, jsonStr) => {
            const note = api.getNoteWithLabel(label);
            if (!note) throw new Error("#urendata note not found");
            note.setContent(jsonStr);
            await note.save();
            return note.noteId;
        },
        [DATA_LABEL, json]
    );
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
 * Calculate statistics per project.
 *
 * "Elapsed" weeks are driven by the weeks the user has actually entered data
 * for (not by the calendar). This is the holiday-friendly "working weeks"
 * model: a holiday is simply a week with no entry, so it never counts against
 * the schedule, and remaining weeks = totalWeeks - weeksEntered.
 */
function calcProjectStats(project, weeks) {
    const { id, totalHours, totalWeeks } = project;

    // Planned hours/week is derived, not stored: the budget spread evenly over
    // the planned (working) weeks.
    const plannedPerWeek = totalWeeks > 0 ? totalHours / totalWeeks : 0;

    // Total hours worked, and how many distinct weeks have an entry for this
    // project (a week counts as "worked" only if its summed hours are > 0).
    let madeHours = 0;
    let weeksEntered = 0;
    for (const [, weekData] of Object.entries(weeks)) {
        const h = sumCell(weekData[id]);
        if (h > 0) {
            madeHours += h;
            weeksEntered += 1;
        }
    }

    // Working weeks elapsed = weeks logged so far, capped at the plan length.
    const effectivePassed = Math.min(weeksEntered, totalWeeks);

    // Planned hours for the weeks worked so far
    const plannedSoFar = effectivePassed * plannedPerWeek;

    // Difference: positive = ahead of schedule, negative = behind
    const delta = madeHours - plannedSoFar;

    // Remaining working weeks
    const remainingWeeks = Math.max(0, totalWeeks - effectivePassed);

    // Remaining hours (total budget minus worked)
    const remainingHours = Math.max(0, totalHours - madeHours);

    // Required hours/week for the remaining working weeks
    const neededPerWeek = remainingWeeks > 0
        ? remainingHours / remainingWeeks
        : 0;

    // Progress percentage
    const pct = totalHours > 0 ? Math.min(100, (madeHours / totalHours) * 100) : 0;

    return {
        madeHours,
        plannedPerWeek,
        plannedSoFar,
        delta,
        remainingWeeks,
        remainingHours,
        neededPerWeek,
        pct,
        effectivePassed,
        weeksEntered,
    };
}

/* ── SUBCOMPONENTS ──────────────────────────────────────────────── */

function StatusBadge({ delta }) {
    if (Math.abs(delta) < 0.5) {
        return <span style={styles.badge("var(--color-background-success,#e6f4ea)", "var(--color-text-success,#2e7d32)")}>On schedule</span>;
    }
    if (delta > 0) {
        return <span style={styles.badge("var(--color-background-success,#e6f4ea)", "var(--color-text-success,#2e7d32)")}>+{delta.toFixed(1)}h ahead</span>;
    }
    return <span style={styles.badge("var(--color-background-danger,#fdecea)", "var(--color-text-danger,#c62828)")}>{delta.toFixed(1)}h behind</span>;
}

function ProgressBar({ pct }) {
    return (
        <div style={styles.progressTrack}>
            <div style={{ ...styles.progressFill, width: `${Math.round(pct)}%` }} />
        </div>
    );
}

function ProjectCard({ project, stats, onEdit, onDelete }) {
    const { name, totalHours, totalWeeks } = project;
    const { madeHours, delta, remainingWeeks, remainingHours, neededPerWeek, plannedPerWeek, pct } = stats;

    return (
        <div style={styles.card}>
            <div style={styles.cardHeader}>
                <span style={styles.projectName}>{name}</span>
                <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                    <StatusBadge delta={delta} />
                    <button style={styles.iconBtn} onClick={onEdit} title="Edit project">✎</button>
                    <button style={{ ...styles.iconBtn, color: "var(--color-text-danger,#c62828)" }} onClick={onDelete} title="Delete project">✕</button>
                </div>
            </div>

            <ProgressBar pct={pct} />

            <div style={styles.statsGrid}>
                <StatCell label="Total budget" value={`${totalHours}h`} />
                <StatCell label="Remaining budget" value={`${remainingHours.toFixed(1)}h`} highlight={remainingHours < 0} />
                <StatCell label="Planned/week" value={`${plannedPerWeek.toFixed(1)}h`} />
                <StatCell label="Needed/week" value={`${neededPerWeek.toFixed(1)}h`} highlight={neededPerWeek > plannedPerWeek * 1.2} />
                <StatCell label="Weeks left" value={`${remainingWeeks}`} />
            </div>

            <div style={styles.metaRow}>
                <span style={styles.meta}>Plan: {totalHours}h ÷ {totalWeeks} weeks = {plannedPerWeek.toFixed(1)}h/week</span>
                <span style={styles.meta}>{Math.round(pct)}% done</span>
            </div>
        </div>
    );
}

function StatCell({ label, value, highlight }) {
    return (
        <div style={styles.statCell}>
            <div style={styles.statLabel}>{label}</div>
            <div style={{ ...styles.statValue, color: highlight ? "var(--color-text-danger,#c62828)" : "var(--color-text-primary,#333)" }}>{value}</div>
        </div>
    );
}

/* One week row for a single project. Holds multiple hour entries that are
   summed into a week total. `cell` is the stored array (may be undefined). */
function WeekEntry({ weekKey, cell, onSave, onClear }) {
    // Local editable list of strings (so partial typing like "1." is allowed).
    const [entries, setEntries] = useState(() => {
        const arr = Array.isArray(cell) ? cell : [];
        return arr.length ? arr.map(n => String(n)) : [""];
    });
    const [saving, setSaving] = useState(false);

    const total = entries.reduce((acc, s) => {
        const v = parseFloat(s);
        return acc + (isNaN(v) ? 0 : v);
    }, 0);

    const setEntry = (i, val) => setEntries(es => es.map((e, idx) => idx === i ? val : e));
    const addEntry = () => setEntries(es => [...es, ""]);
    const removeEntry = (i) => setEntries(es => es.length > 1 ? es.filter((_, idx) => idx !== i) : [""]);

    const handleSave = async () => {
        setSaving(true);
        const parsed = entries
            .map(s => parseFloat(s))
            .filter(v => !isNaN(v) && v >= 0);
        await onSave(weekKey, parsed);
        setSaving(false);
    };

    return (
        <div style={styles.weekRow}>
            <div style={styles.weekLabel}>
                {weekKey}
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
            <div style={{ display: "flex", gap: "6px" }}>
                <button style={styles.btnPrimary} onClick={handleSave} disabled={saving}>
                    {saving ? "…" : "Save"}
                </button>
                <button style={{ ...styles.iconBtn, color: "var(--color-text-danger,#c62828)" }} onClick={() => onClear(weekKey)} title="Clear this week">✕</button>
            </div>
        </div>
    );
}

function ProjectForm({ initial, onSave, onCancel }) {
    const blank = { name: "", totalHours: "", totalWeeks: "" };
    const [form, setForm] = useState(initial || blank);
    const [error, setError] = useState("");

    const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

    // Live preview of the derived planned hours/week.
    const previewTotal = parseFloat(form.totalHours);
    const previewWeeks = parseInt(form.totalWeeks);
    const previewPpw = (!isNaN(previewTotal) && !isNaN(previewWeeks) && previewWeeks > 0)
        ? (previewTotal / previewWeeks)
        : null;

    const handleSave = () => {
        if (!form.name.trim()) return setError("Name is required");
        const total = parseFloat(form.totalHours);
        const weeks = parseInt(form.totalWeeks);
        if (isNaN(total) || total <= 0) return setError("Total hours must be > 0");
        if (isNaN(weeks) || weeks <= 0) return setError("Number of weeks must be > 0");
        setError("");
        onSave({
            id: initial?.id || `proj_${Date.now()}`,
            name: form.name.trim(),
            totalHours: total,
            totalWeeks: weeks,
        });
    };

    return (
        <div style={styles.formBox}>
            <div style={styles.formTitle}>{initial ? "Edit project" : "New project"}</div>
            {error && <div style={styles.errorMsg}>{error}</div>}
            <div style={styles.formGrid}>
                <label style={styles.formLabel}>Name</label>
                <input style={styles.input} value={form.name} onChange={e => set("name", e.target.value)} placeholder="Project name" />

                <label style={styles.formLabel}>Total available hours</label>
                <input style={styles.input} type="number" min="1" step="1" value={form.totalHours} onChange={e => set("totalHours", e.target.value)} placeholder="e.g. 200" />

                <label style={styles.formLabel}>Total number of (working) weeks</label>
                <input style={styles.input} type="number" min="1" step="1" value={form.totalWeeks} onChange={e => set("totalWeeks", e.target.value)} placeholder="e.g. 25" />

                <label style={styles.formLabel}>Planned/week</label>
                <span style={{ ...styles.meta, paddingTop: "5px" }}>
                    {previewPpw !== null ? `${previewPpw.toFixed(1)}h/week (computed)` : "— enter hours and weeks"}
                </span>
            </div>
            <div style={{ display: "flex", gap: "8px", marginTop: "12px" }}>
                <button style={styles.btnPrimary} onClick={handleSave}>Save</button>
                <button style={styles.btnSecondary} onClick={onCancel}>Cancel</button>
            </div>
        </div>
    );
}

/* ── MAIN APP ───────────────────────────────────────────────────── */

function UrenTracker() {
    const [data, setData] = useState(null);        // { projects, weeks }
    const [loading, setLoading] = useState(true);
    const [tab, setTab] = useState("overview");    // "overview" | "entry" | "projects"
    const [editProject, setEditProject] = useState(null); // null | project object
    const [showNewProject, setShowNewProject] = useState(false);
    const [newWeekKey, setNewWeekKey] = useState(currentWeekKey());
    const [selectedProjectId, setSelectedProjectId] = useState(null); // Entry tab
    const [pendingWeeks, setPendingWeeks] = useState([]); // Entry: added-but-unsaved week keys

    /* Load data on startup. Ensure the data note exists first (created under
       the code note via api.startNote, mirroring the planner), then load. */
    useEffect(() => {
        const parentId = api.startNote ? api.startNote.noteId : "root";
        ensureDataNote(parentId)
            .then(() => loadData())
            .then(d => {
                setData(normalizeData(d));
                setLoading(false);
            })
            .catch(err => {
                console.error("Hours Tracker: init failed", err);
                setData(normalizeData(null));
                setLoading(false);
            });
    }, []);

    /* Persist data on every change */
    const persist = useCallback(async (newData) => {
        setData(newData);
        await saveData(newData);
    }, []);

    /* ── Project management ── */
    const handleSaveProject = useCallback(async (project) => {
        setData(prev => {
            const projects = prev.projects.some(p => p.id === project.id)
                ? prev.projects.map(p => p.id === project.id ? project : p)
                : [...prev.projects, project];
            const newData = { ...prev, projects };
            saveData(newData);
            return newData;
        });
        setEditProject(null);
        setShowNewProject(false);
    }, []);

    const handleDeleteProject = useCallback(async (id) => {
        if (!confirm("Delete project? Hours entered for this project remain stored in the data.")) return;
        setData(prev => {
            const newData = { ...prev, projects: prev.projects.filter(p => p.id !== id) };
            saveData(newData);
            return newData;
        });
    }, []);

    /* ── Weekly hours entry (per project, per week) ── */

    /* Save the list of hour entries for one project in one week.
       `hours` is an array of numbers, e.g. [2, 3, 1.5]. An empty array clears
       the cell. Other projects' cells in the same week are left untouched. */
    const handleSaveCell = useCallback(async (weekKey, projectId, hours) => {
        setData(prev => {
            const week = { ...(prev.weeks[weekKey] || {}) };
            if (hours.length === 0) {
                delete week[projectId];
            } else {
                week[projectId] = hours;
            }
            const newData = { ...prev, weeks: { ...prev.weeks, [weekKey]: week } };
            saveData(newData);
            return newData;
        });
    }, []);

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
            saveData(newData);
            return newData;
        });
    }, []);

    /* ── Calculations ── */
    const stats = useMemo(() => {
        if (!data) return {};
        const result = {};
        for (const p of data.projects) {
            result[p.id] = calcProjectStats(p, data.weeks);
        }
        return result;
    }, [data]);

    /* Rolled-up totals across all projects */
    const totals = useMemo(() => {
        if (!data) return null;
        let totalMade = 0, totalPlanned = 0, totalBudget = 0, totalRemaining = 0;
        for (const p of data.projects) {
            const s = stats[p.id];
            totalMade += s.madeHours;
            totalPlanned += s.plannedSoFar;
            totalBudget += p.totalHours;
            totalRemaining += s.remainingHours;
        }
        return { totalMade, totalPlanned, totalBudget, totalRemaining, delta: totalMade - totalPlanned };
    }, [data, stats]);

    /* Sorted week keys (all weeks, newest first) */
    const sortedWeeks = useMemo(() => {
        if (!data) return [];
        return Object.keys(data.weeks).sort().reverse();
    }, [data]);

    /* Default the Entry-tab project selection to the first project once loaded
       (or when the current selection no longer exists). */
    useEffect(() => {
        if (!data || data.projects.length === 0) return;
        const stillExists = data.projects.some(p => p.id === selectedProjectId);
        if (!stillExists) setSelectedProjectId(data.projects[0].id);
    }, [data, selectedProjectId]);

    /* Weeks that already have an entry for the selected project (newest first). */
    const weeksForSelected = useMemo(() => {
        if (!data || !selectedProjectId) return [];
        return sortedWeeks.filter(wk => {
            const cell = data.weeks[wk]?.[selectedProjectId];
            return Array.isArray(cell) && cell.length > 0;
        });
    }, [data, selectedProjectId, sortedWeeks]);

    if (loading) return <div style={styles.loading}>Loading…</div>;

    const tabLabels = { overview: "Overview", entry: "Entry", projects: "Projects" };

    return (
        <div style={styles.root}>
            <h2 style={styles.srOnly}>Hours tracker — overview of worked and planned hours per project</h2>

            {/* ── Header ── */}
            <div style={styles.header}>
                <span style={styles.appTitle}>Hours Tracker</span>
                <div style={styles.tabs}>
                    {["overview", "entry", "projects"].map(t => (
                        <button key={t} style={tab === t ? styles.tabActive : styles.tab} onClick={() => setTab(t)}>
                            {tabLabels[t]}
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
                            <SummaryCell label="Remaining budget" value={`${totals.totalRemaining.toFixed(1)}h`} />
                            <SummaryCell
                                label="Difference"
                                value={`${totals.delta >= 0 ? "+" : ""}${totals.delta.toFixed(1)}h`}
                                highlight={totals.delta < -1}
                                positive={totals.delta >= 0}
                            />
                        </div>
                    )}

                    {data.projects.length === 0 ? (
                        <div style={styles.emptyState}>
                            No projects yet. Go to <strong>Projects</strong> to get started.
                        </div>
                    ) : (
                        <div style={styles.cardList}>
                            {data.projects.map(p => (
                                <ProjectCard
                                    key={p.id}
                                    project={p}
                                    stats={stats[p.id]}
                                    onEdit={() => { setEditProject(p); setTab("projects"); }}
                                    onDelete={() => handleDeleteProject(p.id)}
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
                            {/* Project selector */}
                            <div style={styles.addWeekRow}>
                                <label style={styles.formLabel}>Project</label>
                                <select
                                    style={{ ...styles.input, width: "auto", minWidth: "180px" }}
                                    value={selectedProjectId || ""}
                                    onChange={e => { setSelectedProjectId(e.target.value); setPendingWeeks([]); }}
                                >
                                    {data.projects.map(p => (
                                        <option key={p.id} value={p.id}>{p.name}</option>
                                    ))}
                                </select>
                            </div>

                            {/* Add a week (for the selected project) */}
                            <div style={styles.addWeekRow}>
                                <input
                                    style={{ ...styles.input, width: "130px" }}
                                    value={newWeekKey}
                                    onChange={e => setNewWeekKey(e.target.value)}
                                    placeholder="2025-W22"
                                />
                                <button
                                    style={styles.btnPrimary}
                                    onClick={() => {
                                        const key = newWeekKey.trim();
                                        if (key) setPendingWeeks(p => p.includes(key) ? p : [...p, key]);
                                    }}
                                >+ Add week</button>
                                <span style={styles.meta}>Format: YYYY-Www (e.g. 2025-W22)</span>
                            </div>

                            {/* Weeks for the selected project: pending (not yet
                                saved) first, then those already entered. */}
                            {(() => {
                                const saved = weeksForSelected;
                                const pending = pendingWeeks.filter(wk => !saved.includes(wk));
                                const rows = [...pending, ...saved];
                                if (rows.length === 0) {
                                    return <div style={styles.emptyState}>No weeks for this project yet. Add a week above.</div>;
                                }
                                return (
                                    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                                        {rows.map(wk => (
                                            <WeekEntry
                                                key={`${selectedProjectId}:${wk}`}
                                                weekKey={wk}
                                                cell={data.weeks[wk]?.[selectedProjectId]}
                                                onSave={(weekKey, hours) => {
                                                    handleSaveCell(weekKey, selectedProjectId, hours);
                                                    setPendingWeeks(p => p.filter(x => x !== weekKey));
                                                }}
                                                onClear={(weekKey) => {
                                                    handleClearCell(weekKey, selectedProjectId);
                                                    setPendingWeeks(p => p.filter(x => x !== weekKey));
                                                }}
                                            />
                                        ))}
                                    </div>
                                );
                            })()}
                        </>
                    )}
                </div>
            )}

            {/* ── Tab: Projects ── */}
            {tab === "projects" && (
                <div>
                    {editProject && (
                        <ProjectForm
                            initial={editProject}
                            onSave={handleSaveProject}
                            onCancel={() => setEditProject(null)}
                        />
                    )}
                    {showNewProject && !editProject && (
                        <ProjectForm
                            onSave={handleSaveProject}
                            onCancel={() => setShowNewProject(false)}
                        />
                    )}
                    {!editProject && !showNewProject && (
                        <button style={{ ...styles.btnPrimary, marginBottom: "12px" }} onClick={() => setShowNewProject(true)}>
                            + New project
                        </button>
                    )}
                    {data.projects.length === 0 && !showNewProject && (
                        <div style={styles.emptyState}>No projects yet.</div>
                    )}
                    <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginTop: "8px" }}>
                        {data.projects.map(p => (
                            <div key={p.id} style={styles.projectListRow}>
                                <div>
                                    <span style={styles.projectName}>{p.name}</span>
                                    <span style={styles.meta}> — {p.totalHours}h budget · {p.totalWeeks} weeks · {(p.totalWeeks > 0 ? (p.totalHours / p.totalWeeks) : 0).toFixed(1)}h/week</span>
                                </div>
                                <div style={{ display: "flex", gap: "6px" }}>
                                    <button style={styles.iconBtn} onClick={() => setEditProject(p)}>✎</button>
                                    <button style={{ ...styles.iconBtn, color: "var(--color-text-danger,#c62828)" }} onClick={() => handleDeleteProject(p.id)}>✕</button>
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
            : "var(--color-text-primary,#333)";
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
        padding: "0 0 2rem",
        maxWidth: "900px",
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
    emptyState: {
        color: "var(--muted-text-color, #888)",
        fontSize: "13px",
        padding: "1.5rem 0",
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
};

export default UrenTracker;
