/**
 * ics2trilium — import .ics calendar files into your Trilium journal.
 *
 * Each VEVENT in a .ics file becomes a text note placed under the day note for
 * the event's start date (the journal). The note carries the meeting details in
 * clearly separated sections (Organizer / Attendees / Description) and the
 * calendar's native date/time labels so a calendar view shows it as an event.
 *
 * Author: Paulo van Breugel
 * Disclaimer: Claude.ai was used to create this script
 *
 * DELIVERY (Trilium launch-bar widget)
 *   1. Create a code note, type "JSX", and paste this whole file in.
 *   2. Global menu -> "Configure launchbar". Right click on the Visible Launchers
 *      section and choose "Add a custom widget", and set its "widget" field to
 *      this note.
 *   3. Reload Trilium (Ctrl+R). A calendar button appears in the launch bar;
 *      clicking it opens a chooser to paste iCalendar text or pick .ics file(s),
 *      importing each event into your journal.
 *
 * SCOPE
 *   - Source the calendar from pasted text (handy when a client can only copy an
 *     event to the clipboard, not export it) or from .ics file(s).
 *   - Parse each .ics (RFC 5545): line unfolding, property parameters, TEXT
 *     escaping, one note per VEVENT (VALARM sub-components are ignored). Pasted
 *     text may be a bare VEVENT body without the VCALENDAR/VEVENT wrapper.
 *   - Dates: VALUE=DATE all-day events, floating/TZID local times (literal
 *     wall-clock), and UTC ("...Z") times converted to local. DTEND derived from
 *     DURATION when absent; the exclusive all-day DTEND is made inclusive.
 *   - Note title = SUMMARY; body = a When/Location/Join block followed by
 *     Organizer, Attendees and Description sections under their own headers. The
 *     online-meeting join link (Teams/Meet/URL) is pulled out as a clickable
 *     "Join" line, and URLs/emails in the description are linkified (long ones
 *     shown by a short label) so the note stays compact.
 *   - Placement: the note is created under the day note (journal) for its start
 *     date. When there is no usable start date it falls back to the active note.
 *   - Labels: #calendar_invite and #meeting, plus the calendar #startDate /
 *     #endDate / #startTime / #endTime labels, and an optional #color.
 *   - Duplicate detection via a #calendarImportKey label (SHA-256 of the event
 *     UID, or of the summary + start when it has none), so re-importing the same
 *     invitation is recognised instead of creating a second copy.
 *
 * OPTIONS -- set as labels on THIS note (the same note the launcher points at).
 * All optional; defaults in parentheses:
 *   #icsIconClass=<boxicons class>   imported note icon   (bx bx-calendar-event)
 *   #icsColor=<css color>            #color label for the note tree        ("")
 *
 * BACKEND API NOTE
 *   Note creation/search targets the current TriliumNext backend script API
 *   (api.createNewNote, api.searchForNotes, api.getDayNote, note.setLabel -- run
 *   via runAsyncOnBackendWithManualTransactionHandling). Parsing happens on the
 *   frontend; only createCalendarNote() touches the DB.
 */

import { defineLauncherWidget, useActiveNoteContext } from "trilium:preact";
import { runAsyncOnBackendWithManualTransactionHandling } from "trilium:api";

// Label names written on imported calendar notes. Underscores (not hyphens):
// Trilium sanitizes attribute names, replacing "-" with "_".
const LABELS = {
  importKey: "calendarImportKey",
  uid: "calendarUid",
  invite: "calendar_invite",
  meeting: "meeting",
};

// Defaults for the user-configurable options (see the OPTIONS block in the file
// header). Overridden per-install by labels on this widget's own note.
const DEFAULT_OPTIONS = {
  iconClass: "bx bx-calendar-event", // Boxicons class shown as the note's tree icon
  color: "",                         // #color label (CSS color); "" = none
};

/* ────────────────────────────────────────────────────────────────────────────
 * Small helpers
 * ────────────────────────────────────────────────────────────────────────── */

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

const pad2 = (n) => String(n).padStart(2, "0");

// TEXT-value rendering: a multi-line description becomes paragraphs, with single
// newlines kept as <br> and bare URLs / emails turned into clickable links.
function textToHtml(text) {
  if (!text || !text.trim()) {
    return "<p><em>(empty)</em></p>";
  }
  return text
    .split(/\n\s*\n/)
    .map((paragraph) => `<p>${linkifyInline(paragraph)}</p>`)
    .join("\n");
}

// Shorten a URL for display; the full address stays in the href, so a long
// invite link does not blow up the note body.
function shortenUrl(url) {
  if (url.length <= 45) return url;
  try {
    return `${new URL(url).host}/…`;
  } catch (error) {
    return url.slice(0, 42) + "…";
  }
}

// Escape a run of text and turn bare http(s) URLs and email addresses into
// clickable links (long URLs shown by a short label), keeping single newlines as
// <br>.
function linkifyInline(text) {
  const pattern = /(https?:\/\/[^\s<>"]+)|([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
  const escapeRun = (run) => escapeHtml(run).replace(/\n/g, "<br>");

  let out = "";
  let last = 0;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    out += escapeRun(text.slice(last, match.index));
    if (match[1]) {
      // Trailing sentence punctuation is not part of the link.
      const url = match[1].replace(/[.,;:!?)]+$/, "");
      out += `<a href="${escapeHtml(url)}">${escapeHtml(shortenUrl(url))}</a>`;
      last = match.index + url.length;
    } else {
      out += `<a href="mailto:${escapeHtml(match[2])}">${escapeHtml(match[2])}</a>`;
      last = match.index + match[2].length;
    }
  }
  out += escapeRun(text.slice(last));
  return out;
}

/* ────────────────────────────────────────────────────────────────────────────
 * ICS (iCalendar / RFC 5545) parsing
 * ────────────────────────────────────────────────────────────────────────── */

// Unfold: a CRLF (or LF) followed by a single space or tab continues the
// previous line; remove the break and that one whitespace character.
function unfold(text) {
  return String(text || "").replace(/\r?\n[ \t]/g, "");
}

// Un-escape a TEXT value: \n / \N -> newline, and \\ \, \; -> the literal char.
function unescapeText(value) {
  return String(value || "").replace(/\\([nN\\;,])/g, (match, ch) =>
    ch === "n" || ch === "N" ? "\n" : ch
  );
}

// Split "NAME;PARAM=VALUE;PARAM2=\"quoted\":value" into { name, params, value }.
// A ":" or ";" inside a double-quoted parameter value is not a delimiter -- e.g.
// DESCRIPTION;ALTREP="data:text/html,...":text carries a colon inside the quotes,
// so a naive indexOf would split in the wrong place. Both the name/value colon
// and the parameter ";" separators are therefore found outside quotes only.
function parseLine(line) {
  let inQuotes = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === ":" && !inQuotes) { colon = i; break; }
  }
  if (colon < 0) return {};

  const left = line.slice(0, colon);
  const value = line.slice(colon + 1);

  const segments = splitOutsideQuotes(left, ";");
  const name = segments.shift().trim().toUpperCase();
  const params = {};
  for (const segment of segments) {
    const eq = segment.indexOf("=");
    if (eq < 0) continue;
    const key = segment.slice(0, eq).trim().toUpperCase();
    params[key] = segment.slice(eq + 1).trim().replace(/^"|"$/g, "");
  }
  return { name, params, value };
}

// Split on a single-character separator, ignoring separators inside double quotes.
function splitOutsideQuotes(text, separator) {
  const parts = [];
  let current = "";
  let inQuotes = false;
  for (const ch of String(text)) {
    if (ch === '"') { inQuotes = !inQuotes; current += ch; }
    else if (ch === separator && !inQuotes) { parts.push(current); current = ""; }
    else current += ch;
  }
  parts.push(current);
  return parts;
}

// ORGANIZER / ATTENDEE: the value is a CAL-ADDRESS ("mailto:name@host"); the
// display name and participation status live in parameters.
function parsePerson(value, params) {
  return {
    cn: params.CN || "",
    email: String(value || "").replace(/^mailto:/i, "").trim(),
    partstat: params.PARTSTAT || "",
    role: params.ROLE || "",
  };
}

// Parse a DTSTART/DTEND value into { date:"YYYY-MM-DD", time:"HH:MM"|null,
// isDate, dateObj }. UTC values (trailing "Z") are converted to local wall-clock;
// floating and TZID values keep their literal components (no timezone library is
// available, so the event's own local time is used as written).
function parseIcsDate(value, params) {
  const raw = String(value || "").trim();
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(raw);
  if (!match) return null;

  const [, y, mo, d, hh, mi, ss, z] = match;
  const isDate = (params.VALUE || "").toUpperCase() === "DATE" || hh === undefined;

  if (isDate) {
    return {
      date: `${y}-${mo}-${d}`,
      time: null,
      isDate: true,
      dateObj: new Date(+y, +mo - 1, +d, 12), // noon avoids DST edge shifts
    };
  }

  if (z === "Z") {
    const dt = new Date(Date.UTC(+y, +mo - 1, +d, +hh, +mi, +(ss || 0)));
    return {
      date: `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`,
      time: `${pad2(dt.getHours())}:${pad2(dt.getMinutes())}`,
      isDate: false,
      dateObj: dt,
    };
  }

  return {
    date: `${y}-${mo}-${d}`,
    time: `${hh}:${mi}`,
    isDate: false,
    dateObj: new Date(+y, +mo - 1, +d, +hh, +mi, +(ss || 0)),
  };
}

// ISO 8601 duration ("PT1H30M", "P1D", "-PT15M") -> milliseconds, or null.
function parseDuration(value) {
  const match = /^([+-]?)P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(
    String(value || "").trim()
  );
  if (!match) return null;
  const sign = match[1] === "-" ? -1 : 1;
  const [, , w, d, h, m, s] = match;
  const weeks = +(w || 0), days = +(d || 0), hours = +(h || 0), mins = +(m || 0), secs = +(s || 0);
  return sign * ((((weeks * 7 + days) * 24 + hours) * 60 + mins) * 60 + secs) * 1000;
}

// Split a whole .ics into its VEVENTs, each { summary, description, location,
// uid, status, start, end, duration, organizer, attendees:[] }, and fill in
// missing DTENDs. VALARM sub-components are skipped. Pasted clipboard text that
// is only a bare VEVENT body (no BEGIN/END markers) is wrapped and retried, so
// copying just the event lines still works.
function parseEvents(text) {
  let events = extractEvents(text);
  if (
    !events.length &&
    !/BEGIN:VEVENT/i.test(text) &&
    /^\s*(SUMMARY|DTSTART|UID|DESCRIPTION)[;:]/im.test(text)
  ) {
    events = extractEvents(`BEGIN:VEVENT\r\n${text}\r\nEND:VEVENT`);
  }
  for (const event of events) resolveEnd(event);
  return events;
}

function extractEvents(text) {
  const lines = unfold(text).split(/\r?\n/);
  const events = [];
  let current = null;
  let inAlarm = false;

  for (const line of lines) {
    const upper = line.toUpperCase();

    if (upper === "BEGIN:VEVENT") {
      current = { attendees: [] };
      inAlarm = false;
      continue;
    }
    if (upper === "END:VEVENT") {
      if (current) events.push(current);
      current = null;
      continue;
    }
    if (!current) continue;
    if (upper === "BEGIN:VALARM") { inAlarm = true; continue; }
    if (upper === "END:VALARM") { inAlarm = false; continue; }
    if (inAlarm) continue;

    const { name, params, value } = parseLine(line);
    if (!name) continue;

    switch (name) {
      case "SUMMARY": current.summary = unescapeText(value); break;
      case "DESCRIPTION": current.description = unescapeText(value); break;
      case "LOCATION": current.location = unescapeText(value); break;
      case "UID": current.uid = value.trim(); break;
      case "STATUS": current.status = value.trim(); break;
      case "DTSTART": current.start = parseIcsDate(value, params); break;
      case "DTEND": current.end = parseIcsDate(value, params); break;
      case "DURATION": current.duration = value.trim(); break;
      case "ORGANIZER": current.organizer = parsePerson(value, params); break;
      case "ATTENDEE": current.attendees.push(parsePerson(value, params)); break;
      // Online-meeting join link, pulled out so it becomes a clickable line
      // instead of a long URL buried in the description.
      case "X-MICROSOFT-SKYPETEAMSMEETINGURL":
        current.meetingUrl = value.trim();
        if (!current.provider) current.provider = "teams";
        break;
      case "X-GOOGLE-CONFERENCE":
        if (!current.meetingUrl) current.meetingUrl = value.trim();
        break;
      case "URL":
        if (!current.meetingUrl) current.meetingUrl = value.trim();
        break;
      case "X-ONLINE-MEETING-PROVIDER": current.provider = value.trim(); break;
      default: break;
    }
  }

  return events;
}

// Fill in a missing DTEND from DURATION so end date/time labels can be derived.
function resolveEnd(event) {
  if (event.end || !event.start || !event.duration) return;
  const ms = parseDuration(event.duration);
  if (ms == null) return;
  const endObj = new Date(event.start.dateObj.getTime() + ms);
  event.end = event.start.isDate
    ? {
        date: `${endObj.getFullYear()}-${pad2(endObj.getMonth() + 1)}-${pad2(endObj.getDate())}`,
        time: null,
        isDate: true,
        dateObj: endObj,
      }
    : {
        date: `${endObj.getFullYear()}-${pad2(endObj.getMonth() + 1)}-${pad2(endObj.getDate())}`,
        time: `${pad2(endObj.getHours())}:${pad2(endObj.getMinutes())}`,
        isDate: false,
        dateObj: endObj,
      };
}

// One day earlier, as "YYYY-MM-DD" -- for turning an exclusive all-day DTEND into
// an inclusive end date.
function previousDay(dateStr) {
  const [y, mo, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, mo - 1, d, 12);
  dt.setDate(dt.getDate() - 1);
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Calendar labels (startDate/endDate/startTime/endTime) derived from an event
 * ────────────────────────────────────────────────────────────────────────── */

function eventLabels(event) {
  const start = event.start;
  const end = event.end;
  const startDate = start ? start.date : null;

  let endDate = startDate;
  if (end) {
    // An all-day DTEND is exclusive (the day after the event); make it inclusive.
    if (start && start.isDate && end.isDate) {
      const inclusive = previousDay(end.date);
      endDate = inclusive < startDate ? startDate : inclusive;
    } else {
      endDate = end.date;
    }
  }

  return {
    startDate,
    endDate,
    startTime: start && !start.isDate ? start.time : null,
    endTime: end && !end.isDate ? end.time : null,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Human-readable formatting for the note body
 * ────────────────────────────────────────────────────────────────────────── */

function fmtDate(dt) {
  return dt.toLocaleDateString(undefined, {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function sameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

// A friendly "When:" line covering all-day / timed / multi-day cases.
function formatWhen(event) {
  const s = event.start;
  if (!s) return "";
  const sDate = s.dateObj;

  if (s.isDate) {
    // All-day: DTEND is exclusive, so the last shown day is DTEND minus one.
    let last = null;
    if (event.end) {
      last = new Date(event.end.dateObj.getTime());
      last.setDate(last.getDate() - 1);
    }
    if (!last || sameDay(sDate, last)) return `${fmtDate(sDate)} (all day)`;
    return `${fmtDate(sDate)} – ${fmtDate(last)} (all day)`;
  }

  if (!event.end || !event.end.time) return `${fmtDate(sDate)}, ${s.time}`;

  const eDate = event.end.dateObj;
  if (sameDay(sDate, eDate)) return `${fmtDate(sDate)}, ${s.time} – ${event.end.time}`;
  return `${fmtDate(sDate)}, ${s.time} – ${fmtDate(eDate)}, ${event.end.time}`;
}

function formatPerson(person) {
  if (person.cn && person.email) return `${person.cn} <${person.email}>`;
  return person.cn || person.email || "";
}

function titleCase(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function partstatLabel(value) {
  const map = {
    ACCEPTED: "Accepted",
    DECLINED: "Declined",
    TENTATIVE: "Tentative",
    "NEEDS-ACTION": "No response",
    DELEGATED: "Delegated",
  };
  return map[String(value || "").toUpperCase()] || titleCase(value);
}

// A friendly name for the online-meeting provider, from its property or URL.
function meetingProviderName(event) {
  const url = event.meetingUrl || "";
  const provider = (event.provider || "").toLowerCase();
  if (provider.includes("teams") || /teams\.(microsoft|live)\.com/i.test(url)) return "Microsoft Teams meeting";
  if (/zoom\.us/i.test(url)) return "Zoom meeting";
  if (/meet\.google\.com/i.test(url)) return "Google Meet";
  if (/webex\.com/i.test(url)) return "Webex meeting";
  return "online meeting";
}

// Body layout: a When/Location/Join/Status block, then Organizer, Attendees and
// Description each under their own <h2> header.
function buildEventContent(event) {
  const parts = [];

  const summary = [];
  const when = formatWhen(event);
  if (when) summary.push(`<strong>When:</strong> ${escapeHtml(when)}`);
  if (event.location) summary.push(`<strong>Location:</strong> ${escapeHtml(event.location)}`);
  if (event.meetingUrl) {
    const label = `Join ${meetingProviderName(event)}`;
    summary.push(`<strong>Join:</strong> <a href="${escapeHtml(event.meetingUrl)}">${escapeHtml(label)}</a>`);
  }
  if (event.status) summary.push(`<strong>Status:</strong> ${escapeHtml(titleCase(event.status))}`);
  if (summary.length) parts.push(`<p>${summary.join("<br>")}</p>`);

  if (event.organizer && (event.organizer.cn || event.organizer.email)) {
    parts.push("<h2>Organizer</h2>");
    parts.push(`<p>${escapeHtml(formatPerson(event.organizer))}</p>`);
  }

  if (event.attendees.length) {
    parts.push("<h2>Attendees</h2>");
    const items = event.attendees
      .map((attendee) => {
        const name = escapeHtml(formatPerson(attendee));
        const status = attendee.partstat ? ` — ${escapeHtml(partstatLabel(attendee.partstat))}` : "";
        return `<li>${name}${status}</li>`;
      })
      .join("\n");
    parts.push(`<ul>${items}</ul>`);
  }

  if (event.description && event.description.trim()) {
    parts.push("<h2>Description</h2>");
    parts.push(textToHtml(event.description.trim()));
  }

  return parts.join("\n");
}

/* ────────────────────────────────────────────────────────────────────────────
 * Import key (duplicate detection)
 * ────────────────────────────────────────────────────────────────────────── */

async function sha256Hex(value) {
  const data = new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function deriveImportKey(event, labels) {
  if (event.uid) return sha256Hex(`uid:${event.uid.toLowerCase()}`);
  // No UID: fall back to a stable fingerprint of the event's identity.
  return sha256Hex(`event:${event.summary || ""}|${labels.startDate || ""}|${labels.startTime || ""}`);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Note creation (backend)
 * ────────────────────────────────────────────────────────────────────────── */

// Create the calendar note under the journal day note for its start date, set
// its labels, and return the result -- after checking for an existing import
// with the same key. The callback is self-contained (it closes over nothing from
// module scope), as backend callbacks require.
async function createCalendarNote(payload) {
  return runAsyncOnBackendWithManualTransactionHandling(async (p) => {
    const dayNote = p.startDate ? api.getDayNote(p.startDate) : null;
    const parentNoteId = (dayNote && dayNote.noteId) || p.fallbackParentId;

    const applyEventLabels = (note) => {
      note.setLabel(p.labels.invite);
      note.setLabel(p.labels.meeting);
      if (p.startDate) note.setLabel("startDate", p.startDate);
      if (p.endDate) note.setLabel("endDate", p.endDate);
      if (p.startTime) note.setLabel("startTime", p.startTime);
      if (p.endTime) note.setLabel("endTime", p.endTime);
      note.setLabel("iconClass", p.iconClass);
      if (p.uid) note.setLabel(p.labels.uid, p.uid);
      note.setLabel(p.labels.importKey, p.importKey);
      if (p.color) note.setLabel("color", p.color);
    };

    const existing = api.searchForNotes(`#${p.labels.importKey}="${p.importKey}"`);
    if (existing && existing.length) {
      const note = existing[0];
      // Re-apply so enabling color (or re-importing after edits) updates the note,
      // and make sure it is present in the journal for its start date.
      applyEventLabels(note);
      if (dayNote) api.ensureNoteIsPresentInParent(note.noteId, dayNote.noteId);
      return { status: "duplicate", noteId: note.noteId, title: note.title };
    }

    const created = await api.createNewNote({
      parentNoteId,
      title: p.title,
      type: "text",
      mime: "text/html",
      content: p.content,
    });
    applyEventLabels(created.note);

    return { status: "imported", noteId: created.note.noteId, title: p.title };
  }, [payload]);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Import flow
 * ────────────────────────────────────────────────────────────────────────── */

// Read the user-configurable options from labels on this widget's own note
// (api.startNote), falling back to DEFAULT_OPTIONS.
function readOptions() {
  const note = api.startNote || api.currentNote || null;
  const label = (name) => (note && note.getLabelValue ? note.getLabelValue(name) : null);
  return {
    iconClass: label("icsIconClass") || DEFAULT_OPTIONS.iconClass,
    color: label("icsColor") || DEFAULT_OPTIONS.color,
  };
}

function pickIcsFiles() {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".ics,text/calendar";
    input.multiple = true;
    input.addEventListener("change", () => resolve(Array.from(input.files || [])));
    input.click();
  });
}

// True when a blob of text looks like iCalendar data, so pasted/clipboard
// content is only auto-used when it is actually a calendar.
function looksLikeIcs(text) {
  return /BEGIN:VEVENT|BEGIN:VCALENDAR/i.test(String(text || ""));
}

// The import chooser: a small modal offering a paste box (pre-filled from the
// clipboard when the browser allows it and the clipboard holds calendar data)
// and a "Choose .ics file" button. Resolves to { source:"text", text } when the
// user imports pasted text, { source:"file" } when they pick the file route, or
// null when they cancel.
function openImportDialog() {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.style.cssText =
      "position:fixed;inset:0;z-index:100000;display:flex;align-items:center;" +
      "justify-content:center;background:rgba(0,0,0,0.4);";

    const box = document.createElement("div");
    box.style.cssText =
      "background:var(--main-background-color,#fff);color:var(--main-text-color,#000);" +
      "border:1px solid var(--main-border-color,#ccc);border-radius:6px;padding:16px;" +
      "width:min(560px,92vw);box-shadow:0 8px 30px rgba(0,0,0,0.35);font-size:0.95em;";

    const title = document.createElement("div");
    title.textContent = "Import calendar event(s)";
    title.style.cssText = "font-weight:600;margin-bottom:6px;";

    const hint = document.createElement("div");
    hint.textContent = "Paste iCalendar (.ics) text below, or choose a file.";
    hint.style.cssText = "opacity:0.8;margin-bottom:8px;";

    const textarea = document.createElement("textarea");
    textarea.placeholder = "BEGIN:VCALENDAR\n…\nEND:VCALENDAR";
    textarea.style.cssText =
      "width:100%;height:180px;box-sizing:border-box;resize:vertical;" +
      "font-family:monospace;font-size:0.85em;padding:8px;" +
      "background:var(--input-background-color,#fff);color:inherit;" +
      "border:1px solid var(--main-border-color,#ccc);border-radius:4px;";

    const buttons = document.createElement("div");
    buttons.style.cssText = "display:flex;gap:8px;justify-content:flex-end;margin-top:12px;";

    // Use Trilium's own button classes so text/background contrast follows the
    // active theme (hand-picked colors were unreadable on some themes).
    const mkButton = (label, primary) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.className = "btn btn-sm " + (primary ? "btn-primary" : "btn-secondary");
      b.style.cursor = "pointer";
      return b;
    };

    const fileBtn = mkButton("Choose .ics file…", false);
    const cancelBtn = mkButton("Cancel", false);
    const importBtn = mkButton("Import", true);
    buttons.append(fileBtn, cancelBtn, importBtn);

    box.append(title, hint, textarea, buttons);
    overlay.append(box);
    document.body.append(overlay);
    textarea.focus();

    // Best-effort clipboard pre-fill; ignored when blocked or not calendar data.
    if (navigator.clipboard && navigator.clipboard.readText) {
      navigator.clipboard
        .readText()
        .then((text) => {
          if (text && !textarea.value && looksLikeIcs(text)) textarea.value = text;
        })
        .catch(() => {});
    }

    let settled = false;
    const close = (result) => {
      if (settled) return;
      settled = true;
      document.removeEventListener("keydown", onKey, true);
      overlay.remove();
      resolve(result);
    };
    const onKey = (event) => {
      if (event.key === "Escape") { event.preventDefault(); close(null); }
      else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        close({ source: "text", text: textarea.value });
      }
    };

    document.addEventListener("keydown", onKey, true);
    overlay.addEventListener("mousedown", (event) => { if (event.target === overlay) close(null); });
    cancelBtn.addEventListener("click", () => close(null));
    fileBtn.addEventListener("click", () => close({ source: "file" }));
    importBtn.addEventListener("click", () => close({ source: "text", text: textarea.value }));
  });
}

// Import every VEVENT found in one blob of iCalendar text; returns per-event
// results. fallbackTitle is used for events without a SUMMARY.
async function importText(text, fallbackParentId, options, fallbackTitle) {
  const events = parseEvents(text);
  const results = [];

  for (const event of events) {
    const labels = eventLabels(event);
    const title = (event.summary || "").trim() || fallbackTitle || "(no title)";
    const content = buildEventContent(event);
    const importKey = await deriveImportKey(event, labels);

    const result = await createCalendarNote({
      fallbackParentId,
      title,
      content,
      importKey,
      uid: event.uid || "",
      labels: LABELS,
      iconClass: options.iconClass,
      color: options.color,
      startDate: labels.startDate,
      endDate: labels.endDate,
      startTime: labels.startTime,
      endTime: labels.endTime,
    });
    results.push(result);
  }

  return results;
}

// Accumulate per-event results into a tally, tracking sources with no events.
function tallyResults(tally, results) {
  if (!results.length) {
    tally.empty += 1;
    return;
  }
  for (const result of results) {
    if (result.status === "duplicate") tally.duplicates += 1;
    else tally.imported += 1;
  }
}

function reportTally(tally) {
  if (!tally.imported && !tally.duplicates && !tally.failed && tally.empty) {
    api.showMessage("No calendar events found.");
    return;
  }
  const parts = [`${tally.imported} event${tally.imported === 1 ? "" : "s"} imported into the journal`];
  if (tally.duplicates) parts.push(`${tally.duplicates} duplicate${tally.duplicates === 1 ? "" : "s"} skipped`);
  if (tally.empty) parts.push(`${tally.empty} with no events`);
  if (tally.failed) parts.push(`${tally.failed} failed`);
  api.showMessage(parts.join(", ") + ".");
  if (tally.failed && tally.errors.length) api.showError(tally.errors[0]);
}

async function importIcs() {
  const activeNote = api.getActiveContextNote();
  const fallbackParentId = activeNote ? activeNote.noteId : null;
  const options = readOptions();

  const choice = await openImportDialog();
  if (!choice) return;

  const tally = { imported: 0, duplicates: 0, empty: 0, failed: 0, errors: [] };

  if (choice.source === "text") {
    if (!choice.text || !choice.text.trim()) {
      api.showMessage("Nothing to import — the pasted text was empty.");
      return;
    }
    try {
      tallyResults(tally, await importText(choice.text, fallbackParentId, options, "(no title)"));
    } catch (error) {
      tally.failed += 1;
      tally.errors.push(error.message);
      console.error("ics2trilium: failed to import pasted text", error);
    }
    reportTally(tally);
    return;
  }

  // choice.source === "file"
  const files = await pickIcsFiles();
  if (!files.length) return;

  for (const file of files) {
    try {
      const text = new TextDecoder("utf-8").decode(new Uint8Array(await file.arrayBuffer()));
      tallyResults(tally, await importText(text, fallbackParentId, options, file.name.replace(/\.ics$/i, "")));
    } catch (error) {
      tally.failed += 1;
      tally.errors.push(`${file.name}: ${error.message}`);
      console.error("ics2trilium: failed to import", file.name, error);
    }
  }
  reportTally(tally);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Launch-bar widget — a calendar button that imports .ics files into the
 * journal. Register via Global menu → Configure launchbar → Add a custom widget,
 * pointing its "widget" field at this note (no #widget label).
 * ────────────────────────────────────────────────────────────────────────── */

export default defineLauncherWidget({
  render: () => {
    // The active note only affects the fallback parent (used when an event has no
    // date); the button is always available because imports go to the journal.
    useActiveNoteContext();

    return (
      <button
        type="button"
        class="bx bx-calendar-event"
        title="Import a calendar event into your journal (paste .ics text or choose a file)"
        onClick={() => importIcs()}
        style={{
          background: "transparent",
          border: "none",
          color: "inherit",
          cursor: "pointer",
          fontSize: "1.3em",
          padding: "10px",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      />
    );
  },
});
