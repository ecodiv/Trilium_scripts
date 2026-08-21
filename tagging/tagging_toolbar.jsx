/**
 * tagging_toolbar — a quick-tag panel for the current note.
 *
 * Lives in the right sidebar as a "Tags" panel (next to the built-in Attributes
 * tab). Shows the tags already applied to the note plus an Add-tag button that
 * opens the tags available for it; clicking one adds or removes it. Tags are real
 * notes, and applying one creates a ~tag relation to that note — so a tag keeps
 * all its Trilium powers (backlinks, search by ~tag.title, saved searches, a
 * calendar/board grouped by it). It can also sit at the bottom of the note pane
 * instead (see #tagPlacement in OPTIONS).
 *
 * Author: Paulo van Breugel
 * Disclaimer: Claude.ai was used to modernise this script. It is a Preact/JSX
 * rewrite of TheBig-O's Tagging Widget (https://github.com/TheBig-O/Tagging_Widget);
 * the original README is kept as README.upstream.md.
 *
 * DELIVERY (Trilium custom widget)
 *   1. Create a code note, type "JSX", and paste this whole file in. Save.
 *   2. Add the label #widget to this note so Trilium mounts it.
 *   3. Reload Trilium (Ctrl+R).
 *   A "Tags" panel appears in the right sidebar on every note that is "taggable"
 *   (see ACTIVATION). No note IDs to copy, no code constants to edit.
 *
 * ACTIVATION — which notes get the toolbar
 *   A note is taggable when it carries the activation label (default
 *   #TaggingTemplate) and is not #archived. The usual way to apply that in bulk
 *   is a template: make a template note that has #TaggingTemplate, then point a
 *   note's ~template relation at it. The label is inheritable-friendly, so a
 *   whole subtree can be made taggable at once. Change the label name with
 *   #tagActivationLabel on THIS widget note (see OPTIONS).
 *
 * TAG SETS — which tags a note is offered (routing)
 *   Tags live as child notes of a "tag container". A container is any note
 *   carrying the label #tagContainer:
 *
 *     • Default set — a note with a bare #tagContainer (or #tagContainer=default).
 *       Used everywhere unless a named set overrides it. One container, zero
 *       config: this covers most notebooks.
 *
 *     • Named sets — a note with #tagContainer=work, #tagContainer=personal, …
 *       A note is routed to a named set when it has (or inherits) #tagSet=work.
 *       Put an *inheritable* #tagSet=work on a subtree root and every note under
 *       it offers the Work tags — Trilium resolves the inheritance, so there is
 *       no hierarchy walking here and the same set can be reused by any number of
 *       unrelated subtrees. Drop the label to fall back to the default set.
 *
 *   This single rule replaces the upstream widget's three lookup modes (direct
 *   ID / search-with-root / full upward search) and needs no note IDs.
 *
 * STYLING TAGS — labels on each individual tag note (all optional)
 *   #iconClass=bx bx-briefcase   a Boxicons class shown before the tag
 *   #badgeBackground=#348cbb     badge background colour
 *   #badgeColor=#ffffff          badge text colour
 *
 * OPTIONS — labels on THIS widget note (all optional; defaults in parentheses)
 *   #tagPlacement=bottom         put the toolbar at the bottom of the note pane
 *                                instead of the right sidebar               ("right")
 *   #tagActivationLabel=<name>   label that marks a note taggable ("TaggingTemplate")
 *   #tagContainerId=<noteId>     force the default set to a specific container note,
 *                                skipping the #tagContainer search (fast escape hatch;
 *                                only affects the default set, not named sets)   ("")
 *   #tagShowApplied=false        hide the applied-tags strip, show only the button (true)
 *
 * BACKEND API NOTE
 *   Reading tags, adding/removing the ~tag relation and creating the starter
 *   container all run on the backend via runAsyncOnBackendWithManualTransaction-
 *   Handling; those callbacks are self-contained (they close over nothing from
 *   module scope), as backend callbacks require. Routing (#tagSet) is read on the
 *   frontend from the note's own resolved attributes, so it costs no round-trip.
 */

import {
  useState,
  useEffect,
  useCallback,
  useRef,
  defineWidget,
  useNoteContext,
  RightPanelWidget,
} from "trilium:preact";
import { runAsyncOnBackendWithManualTransactionHandling } from "trilium:api";

/* ── Options ──────────────────────────────────────────────────────────────── */

const DEFAULT_OPTIONS = {
  placement: "right",                 // "right" sidebar panel, or "bottom" note bar
  activationLabel: "TaggingTemplate", // label that makes a note taggable
  containerId: "",                    // force the default set's container (note ID)
  showApplied: true,                  // show the applied-tags strip
};

// Read the widget's own options from labels on this note (api.startNote).
function readOptions() {
  const note = api.startNote || api.currentNote || null;
  const label = (name) => (note && note.getLabelValue ? note.getLabelValue(name) : null);
  const showApplied = label("tagShowApplied");
  return {
    placement: label("tagPlacement") === "bottom" ? "bottom" : DEFAULT_OPTIONS.placement,
    activationLabel: label("tagActivationLabel") || DEFAULT_OPTIONS.activationLabel,
    containerId: label("tagContainerId") || DEFAULT_OPTIONS.containerId,
    showApplied: showApplied == null ? DEFAULT_OPTIONS.showApplied : showApplied !== "false",
  };
}

/* ── Colour safety ────────────────────────────────────────────────────────── */

// Tag colours come from the user's own notes and are only ever assigned to DOM
// style properties (which the browser silently drops when invalid), so the risk
// is low — but validate anyway and reject url()/expression() smuggling.
const NAMED_COLORS = new Set([
  "transparent", "black", "white", "silver", "gray", "grey", "red", "green",
  "blue", "yellow", "orange", "purple", "pink", "brown", "cyan", "magenta",
  "teal", "navy", "maroon", "olive", "lime", "aqua", "gold", "coral", "crimson",
  "indigo", "violet", "salmon", "tomato", "turquoise", "khaki", "plum", "orchid",
  "steelblue", "royalblue", "skyblue", "seagreen", "forestgreen", "firebrick",
  "goldenrod", "dodgerblue", "slategray", "slategrey", "rebeccapurple",
]);

function safeColor(value, fallback) {
  const s = String(value == null ? "" : value).trim();
  if (!s) return fallback;
  if (/^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(s)) return s;
  if (/^[a-zA-Z]+$/.test(s) && NAMED_COLORS.has(s.toLowerCase())) return s;
  if (/^(?:rgb|rgba|hsl|hsla)\([0-9.,%/\s]+\)$/.test(s)) return s;
  if (/^var\(\s*--[\w-]+\s*(?:,\s*[^;()]+)?\)$/.test(s)) return s;
  return fallback;
}

// A Boxicons class is a space-separated list of `bx…` tokens; drop anything else
// so the value can be dropped straight into className.
function safeIconClass(value) {
  return String(value || "")
    .split(/\s+/)
    .filter((tok) => /^bx[\w-]*$/.test(tok))
    .join(" ");
}

/* ── Backend: load / mutate tags ──────────────────────────────────────────── */

// One round-trip: resolve the container for `setName`, then return its child
// tags and the tags already applied to `noteId`. `containerId` (optional) forces
// the default set only. Self-contained for the backend.
function loadTagData(noteId, setName, containerId) {
  return runAsyncOnBackendWithManualTransactionHandling(
    async (noteId, setName, containerId) => {
      const note = await api.getNote(noteId);
      if (!note) return { container: null, available: [], applied: [] };

      const wanted = (setName || "default").toLowerCase();

      // Resolve the tag container.
      let container = null;
      if (containerId && wanted === "default") {
        container = await api.getNote(containerId);
      }
      if (!container) {
        const candidates = api.searchForNotes("#tagContainer");
        for (const candidate of candidates) {
          const val = (candidate.getLabelValue("tagContainer") || "").trim().toLowerCase();
          if (val === wanted || (wanted === "default" && val === "")) {
            container = candidate;
            break;
          }
        }
      }

      const describe = (n) => ({
        noteId: n.noteId,
        title: n.title,
        iconClass: n.getLabelValue("iconClass") || "",
        badgeBackground: n.getLabelValue("badgeBackground") || "",
        badgeColor: n.getLabelValue("badgeColor") || "",
      });

      let available = [];
      if (container) {
        const children = await container.getChildNotes();
        available = children.map(describe);
      }

      const applied = note
        .getRelations("tag")
        .map((rel) => (rel.targetNote ? describe(rel.targetNote) : null))
        .filter(Boolean);

      return {
        container: container ? { noteId: container.noteId, title: container.title } : null,
        available,
        applied,
      };
    },
    [noteId, setName, containerId]
  );
}

// Add or remove the ~tag relation from `noteId` to `tagId`.
function toggleTagRelation(noteId, tagId, hasTag) {
  return runAsyncOnBackendWithManualTransactionHandling(
    async (noteId, tagId, hasTag) => {
      const note = await api.getNote(noteId);
      if (!note) return;
      if (hasTag) note.removeRelation("tag", tagId);
      else note.addRelation("tag", tagId);
      await note.save();
    },
    [noteId, tagId, hasTag]
  );
}

// Create a starter "Tags" container (with #tagContainer) and a few example tags
// under `parentNoteId` — offered from the empty state so a fresh install works
// with one click. Returns the new container's id/title.
function createStarterTags(parentNoteId) {
  return runAsyncOnBackendWithManualTransactionHandling(
    async (parentNoteId) => {
      const created = await api.createNewNote({
        parentNoteId,
        title: "Tags",
        type: "text",
        mime: "text/html",
        content: "<p>Available tags for the tagging toolbar. Each child note is one tag.</p>",
      });
      const container = created.note;
      container.setLabel("tagContainer");

      const examples = [
        { title: "Important", icon: "bx bx-star", bg: "#c0392b", fg: "#ffffff" },
        { title: "Follow-up", icon: "bx bx-time-five", bg: "#e67e22", fg: "#ffffff" },
        { title: "Idea", icon: "bx bx-bulb", bg: "#348cbb", fg: "#ffffff" },
      ];
      for (const ex of examples) {
        const tag = await api.createNewNote({
          parentNoteId: container.noteId,
          title: ex.title,
          type: "text",
          mime: "text/html",
          content: "",
        });
        tag.note.setLabel("iconClass", ex.icon);
        tag.note.setLabel("badgeBackground", ex.bg);
        tag.note.setLabel("badgeColor", ex.fg);
      }

      return { noteId: container.noteId, title: container.title };
    },
    [parentNoteId]
  );
}

/* ── Presentation ─────────────────────────────────────────────────────────── */

const THEME = {
  border: "var(--main-border-color, #d0d0d0)",
  text: "var(--main-text-color, #333)",
  muted: "var(--muted-text-color, #888)",
  menuBg: "var(--main-background-color, #fff)",
  hover: "var(--hover-item-background-color, #eee)",
  badgeBg: "var(--more-accented-background-color, #eaeaea)",
};

// A single tag badge (icon + title), used both in the dropdown and the applied
// strip. `background`/`color` are the tag's own styling labels. Pass `onClick`
// to make it interactive (the applied strip uses it to remove a tag).
function TagBadge({ tag, onClick, title }) {
  const icon = safeIconClass(tag.iconClass);
  return (
    <span
      onClick={onClick}
      title={title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "4px",
        padding: "1px 8px",
        borderRadius: "10px",
        fontSize: "0.85em",
        whiteSpace: "nowrap",
        cursor: onClick ? "pointer" : "default",
        background: safeColor(tag.badgeBackground, THEME.badgeBg),
        color: safeColor(tag.badgeColor, THEME.text),
      }}
    >
      {icon ? <i class={icon} /> : null}
      {tag.title}
    </span>
  );
}

// The list of available tags — shown only once a container exists (the
// no-container empty state lives in the panel body instead). In the sidebar it is
// `inline`: it flows within the panel, which then grows/scrolls, because an
// absolute overlay would be clipped by the card and left only a sliver tall. In
// the bottom bar it floats as an overlay, `dropUp` opening it upward.
function TagMenu({ dropUp, inline, container, available, appliedIds, busy, onToggle }) {
  const style = inline
    ? {
        width: "100%",
        marginTop: "6px",
        maxHeight: "50vh",
        overflowY: "auto",
        padding: "4px",
        background: THEME.menuBg,
        border: `1px solid ${THEME.border}`,
        borderRadius: "6px",
      }
    : {
        position: "absolute",
        left: 0,
        minWidth: "180px",
        maxHeight: "320px",
        overflowY: "auto",
        padding: "4px",
        background: THEME.menuBg,
        border: `1px solid ${THEME.border}`,
        borderRadius: "6px",
        boxShadow: "0 6px 20px rgba(0,0,0,0.25)",
        zIndex: 9999,
        ...(dropUp
          ? { bottom: "100%", marginBottom: "6px" }
          : { top: "100%", marginTop: "6px" }),
      };

  if (available.length === 0) {
    return (
      <div style={style}>
        <div style={{ padding: "8px", fontSize: "0.85em", color: THEME.muted }}>
          “{container.title}” has no tags yet. Add child notes to it.
        </div>
      </div>
    );
  }

  return (
    <div style={style}>
      {available.map((tag) => {
        const active = appliedIds.has(tag.noteId);
        return (
          <div
            key={tag.noteId}
            onClick={() => onToggle(tag)}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "8px",
              padding: "4px 8px",
              borderRadius: "4px",
              cursor: busy ? "default" : "pointer",
              opacity: busy ? 0.6 : 1,
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = THEME.hover)}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
          >
            <TagBadge tag={tag} />
            {active ? <i class="bx bx-check" style={{ color: THEME.muted }} /> : null}
          </div>
        );
      })}
    </div>
  );
}

// Read once at load: placement decides the mount point (fixed at registration),
// and the other options are per-install constants.
const OPTIONS = readOptions();
const VERTICAL = OPTIONS.placement === "right"; // sidebar = vertical, bottom = horizontal

function TaggingToolbar() {
  const { note } = useNoteContext() || {};

  const [data, setData] = useState(null); // { container, available, applied }
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const rootRef = useRef(null);

  const enabled =
    !!note && note.hasLabel(OPTIONS.activationLabel) && !note.hasLabel("archived");

  // Routing: read the (possibly inherited) #tagSet on the current note. Trilium
  // resolves inheritance, so this needs no backend call and no ancestor walk.
  const setName = (enabled && note.getLabelValue("tagSet")) || "default";

  const reload = useCallback(() => {
    if (!enabled) {
      setData(null);
      return;
    }
    const noteId = note.noteId;
    loadTagData(noteId, setName, OPTIONS.containerId).then((result) => {
      // Ignore a result that arrived after the user switched notes.
      if (note.noteId === noteId) setData(result);
    });
  }, [enabled, note && note.noteId, setName]);

  useEffect(() => {
    reload();
  }, [reload]);

  // Close the dropdown on an outside click.
  useEffect(() => {
    if (!open) return undefined;
    const onDocClick = (event) => {
      if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false);
    };
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, [open]);

  const appliedIds = new Set((data?.applied || []).map((tag) => tag.noteId));

  const onToggle = async (tag) => {
    if (busy) return;
    setBusy(true);
    try {
      await toggleTagRelation(note.noteId, tag.noteId, appliedIds.has(tag.noteId));
      await reload();
    } catch (error) {
      console.error("tagging_toolbar: failed to toggle tag", error);
      api.showError && api.showError(`Could not update tag: ${error.message}`);
    } finally {
      setBusy(false);
    }
  };

  const onCreateStarter = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const parentId = (api.startNote && api.startNote.noteId) || note.noteId;
      await createStarterTags(parentId);
      await reload();
      api.showMessage && api.showMessage('Created a "Tags" container with example tags.');
    } catch (error) {
      console.error("tagging_toolbar: failed to create starter tags", error);
      api.showError && api.showError(`Could not create starter tags: ${error.message}`);
    } finally {
      setBusy(false);
    }
  };

  if (!enabled) return null;

  const available = data?.available || [];
  const applied = data?.applied || [];
  const loaded = data !== null;
  const hasContainer = !!data?.container;

  // No container yet: say so right in the panel (not hidden behind a dropdown),
  // and offer one-click setup for the default set. Only shown once loaded, so it
  // doesn't flash before the first lookup returns.
  const emptyState = (
    <div style={{ fontSize: "0.85em", color: THEME.muted }}>
      <div style={{ marginBottom: "8px" }}>
        {setName === "default"
          ? "No tag list found yet. Create one below, or add the #tagContainer label to a note that holds your tags."
          : `No tag list found for set “${setName}”. Add #tagContainer=${setName} to the note that should hold this set.`}
      </div>
      {setName === "default" ? (
        <button
          type="button"
          class="btn btn-sm btn-primary"
          disabled={busy}
          onClick={onCreateStarter}
          style={{ cursor: "pointer" }}
        >
          Create starter tags
        </button>
      ) : null}
    </div>
  );

  // Add-tag button + its dropdown. The menu opens upward for the bottom bar and
  // downward for the sidebar panel (which has room below it).
  const trigger = (
    <div style={{ position: "relative", display: VERTICAL ? "block" : "inline-block" }}>
      <button
        type="button"
        title="Add or remove tags"
        class={VERTICAL ? "btn btn-sm" : "bx bx-tag"}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
        style={
          VERTICAL
            ? { cursor: "pointer", display: "inline-flex", alignItems: "center", gap: "4px" }
            : {
                background: "transparent",
                border: "none",
                color: "inherit",
                cursor: "pointer",
                fontSize: "1.3em",
                lineHeight: 1,
                padding: "4px",
              }
        }
      >
        {VERTICAL ? (
          <>
            <i class="bx bx-tag" /> Add tag
          </>
        ) : null}
      </button>

      {open ? (
        <TagMenu
          dropUp={!VERTICAL}
          inline={VERTICAL}
          container={data?.container}
          available={available}
          appliedIds={appliedIds}
          busy={busy}
          onToggle={onToggle}
        />
      ) : null}
    </div>
  );

  // Applied tags — click a badge to remove it.
  const appliedStrip = OPTIONS.showApplied ? (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: "5px",
        ...(VERTICAL ? { marginTop: "8px" } : { flex: 1 }),
      }}
    >
      {applied.length === 0 ? (
        <span style={{ color: THEME.muted, fontSize: "0.85em" }}>No tags</span>
      ) : (
        applied.map((tag) => (
          <TagBadge
            key={tag.noteId}
            tag={tag}
            title="Remove tag"
            onClick={() => onToggle(tag)}
          />
        ))
      )}
    </div>
  ) : null;

  // Once loaded with no container, the panel is just the setup prompt; otherwise
  // it's the Add-tag button and the applied tags.
  const body =
    loaded && !hasContainer ? (
      emptyState
    ) : (
      <>
        {trigger}
        {appliedStrip}
      </>
    );

  // Sidebar: a titled, collapsible "Tags" card (RightPanelWidget), stacked
  // vertically. Bottom: the classic horizontal bar under the note.
  if (VERTICAL) {
    return (
      <RightPanelWidget id="tagging-toolbar" title="Tags">
        <div ref={rootRef}>{body}</div>
      </RightPanelWidget>
    );
  }

  return (
    <div
      ref={rootRef}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "10px",
        padding: "8px 12px",
        borderTop: `1px solid ${THEME.border}`,
        color: THEME.text,
        position: "relative",
      }}
    >
      {body}
    </div>
  );
}

/* ── Registration ─────────────────────────────────────────────────────────── */

export default defineWidget({
  parent: VERTICAL ? "right-pane" : "center-pane",
  position: 90,
  render: () => <TaggingToolbar />,
});
