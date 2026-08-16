/**
 * eml2trilium — import .eml files into the active Trilium note.
 *
 * It copies the content of an eml into a text note, subject as title, 
 * a From/To/CC/Sent/Message-ID header block, the sanitized message body 
 * (with inline images), attachments as child notes, and the original .eml 
 * preserved as a child file note.
 * 
 * Author: Paulo van Breugel
 * Disclaimer: Claud.ai was used to create this script
 *
 * DELIVERY (Trilium launch-bar widget)
 *   1. Create a code note, type "JSX", and paste this whole file in.
 *   2. Global menu → "Configure launchbar". Right click on the Visible Launchers
 *      section and choose choose "Add a custom widget", and set its "widget"
 *      field to this note.
 *   3. Reload Trilium (Ctrl+R). An envelope button appears in the launch bar;
 *      clicking it imports the chosen .eml file(s) into the currently active
 *      note.
 *
 * SCOPE 
 *   - Parse each .eml (folded headers, RFC 2047, nested multipart, base64 /
 *     quoted-printable / 7-8bit, per-part charset).
 *   - Body imported as plain text, or sanitized HTML preserving formatting with
 *     embedded (cid:) images inlined, optionally keeping remote images too.
 *   - Attachments imported as child file notes; original .eml preserved as a
 *     child file note.
 *   - Duplicate detection via an #emailImportKey label (SHA-256 of the
 *     Message-ID, or of the raw message when absent), so re-importing the same
 *     email is recognised as a duplicate instead of creating a second copy.
 *   - Optionally link the note to the date it was sent: clone it under that
 *     day's note and/or add #startDate/#startTime calendar labels.
 *
 * OPTIONS — set as labels on THIS note (the same note the launcher points at).
 * All optional; defaults in parentheses:
 *   #emlBodyFormat=plain|html|html-images   how the body is imported  (html)
 *       plain        = message text only
 *       html         = sanitized HTML, embedded images kept, remote stripped
 *       html-images  = sanitized HTML, remote/external images also kept
 *   #emlImportAttachments=true|false         import attachments as children (true)
 *   #emlPreserveEml=true|false               keep the original .eml child   (true)
 *   #emlDateMode=daily|calendar|both|none    link to the sent date        (both)
 *       daily     = clone the note under that day's note
 *       calendar  = add #startDate + #startTime so a calendar view shows it as
 *                   an event (no #endTime; an email has no duration)
 *       both      = clone under the day note AND add the calendar labels
 *       none      = do neither
 *   #emlIconClass=<boxicons class>            imported note icon  (bx bx-envelope)
 *   #emlColor=<css color>                 #color label for the note tree     ("")
 *
 * BACKEND API NOTE
 *   Note creation/search targets the current TriliumNext backend script API
 *   (api.createNewNote, api.searchForNotes, note.setLabel — run via
 *   runAsyncOnBackendWithManualTransactionHandling). Parsing/sanitizing happen
 *   on the frontend (they need the DOM); only createEmailNote() touches the DB.
 */

import { defineLauncherWidget, useActiveNoteContext } from "trilium:preact";
import { runAsyncOnBackendWithManualTransactionHandling } from "trilium:api";

// Label names written on imported email notes — kept in sync with the LABELS
// export in shared/email-format.js.
const LABELS = { importKey: "emailImportKey", messageId: "emailMessageId" };

// Labels added to the child notes an import creates. Underscores (not hyphens):
// Trilium sanitizes attribute names, replacing "-" with "_".
const CHILD_LABELS = { attachment: "email_attachment", emlFileType: "file_type" };

// Defaults for the user-configurable options (see the OPTIONS block in the file
// header). Overridden per-install by labels on this widget's own note.
const DEFAULT_OPTIONS = {
  bodyFormat: "html",       // "plain" | "html" | "html-images"
  importAttachments: true,
  preserveEml: true,
  dateMode: "both",        // "daily" | "calendar" | "both" | "none"
  iconClass: "bx bx-envelope",   // Boxicons class shown as the note's tree icon
  color: "",               // #color label (CSS color) for the note tree; "" = none
};

/* ────────────────────────────────────────────────────────────────────────────
 * Shared formatting helpers — mirror of shared/email-format.js.
 * A Trilium note cannot import a sibling repo file, so these are inlined. Keep
 * them byte-identical to the canonical copy in shared/email-format.js.
 * ────────────────────────────────────────────────────────────────────────── */

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function textToHtml(text) {
  if (!text || !text.trim()) {
    return "<p><em>No readable message body.</em></p>";
  }

  return text
    .split(/\r?\n\r?\n/)
    .map(paragraph => `<p>${escapeHtml(paragraph).replace(/\r?\n/g, "<br>")}</p>`)
    .join("\n");
}

function safeFilename(name) {
  return String(name || "email")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 150) || "email";
}

/* ────────────────────────────────────────────────────────────────────────────
 * Minimal MIME parser.
 * Covers the common real-world cases: folded headers, RFC 2047 encoded words,
 * nested multipart/*, base64 / quoted-printable / 7bit-8bit transfer encodings,
 * and per-part charset decoding.
 * ────────────────────────────────────────────────────────────────────────── */

function base64ToBytes(b64) {
  const clean = String(b64 || "").replace(/[^A-Za-z0-9+/=]/g, "");
  const binary = atob(clean);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

// Quoted-printable → bytes. Handles soft line breaks (a trailing "=" before a
// newline) and "=XX" hex escapes.
function qpToBytes(text) {
  const out = [];
  const str = String(text || "");
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (c === "=") {
      if (str[i + 1] === "\r" && str[i + 2] === "\n") { i += 2; continue; }
      if (str[i + 1] === "\n") { i += 1; continue; }
      const hex = str.substr(i + 1, 2);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        out.push(parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    out.push(c.charCodeAt(0) & 0xff);
  }
  return new Uint8Array(out);
}

function decodeBytes(bytes, charset) {
  try {
    return new TextDecoder(charset || "utf-8").decode(bytes);
  } catch (error) {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

// Decode RFC 2047 encoded words (=?charset?B/Q?text?=) found in header values.
function decodeRfc2047(value) {
  let str = String(value || "");
  if (!str.includes("=?")) {
    return str;
  }

  // Whitespace between adjacent encoded words is not significant; collapse it so
  // multi-chunk words rejoin without a stray space.
  str = str.replace(/\?=[ \t]*\r?\n?[ \t]*=\?/g, "?==?");

  return str.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (match, charset, enc, text) => {
    try {
      const bytes = enc.toUpperCase() === "B"
        ? base64ToBytes(text)
        : qpToBytes(text.replace(/_/g, " "));
      return decodeBytes(bytes, charset);
    } catch (error) {
      return match;
    }
  });
}

function splitHeaderBody(text) {
  const match = text.match(/\r?\n\r?\n/);
  if (!match) {
    return { head: text, body: "" };
  }
  return { head: text.slice(0, match.index), body: text.slice(match.index + match[0].length) };
}

function parseHeaders(head) {
  // Unfold: a line beginning with whitespace continues the previous header.
  const unfolded = String(head || "").replace(/\r?\n[ \t]+/g, " ");
  const list = [];
  for (const line of unfolded.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    list.push({ name: line.slice(0, idx).trim().toLowerCase(), value: line.slice(idx + 1).trim() });
  }
  return {
    get(name) {
      const found = list.find(header => header.name === name.toLowerCase());
      return found ? found.value : "";
    },
  };
}

// Split "type/subtype; k=v; k2=\"v2\"" into { value, params }.
function parseParams(value) {
  const segments = String(value || "").split(";");
  const main = segments.shift().trim().toLowerCase();
  const params = {};
  for (const segment of segments) {
    const idx = segment.indexOf("=");
    if (idx < 0) continue;
    const key = segment.slice(0, idx).trim().toLowerCase();
    params[key] = segment.slice(idx + 1).trim().replace(/^"|"$/g, "");
  }
  return { value: main, params };
}

function splitMultipart(body, boundary) {
  if (!boundary) return [];
  const marker = "--" + boundary;
  const chunks = String(body || "").split(marker);
  const segments = [];
  // chunks[0] is the preamble; a chunk starting with "--" is the closing marker.
  for (let i = 1; i < chunks.length; i++) {
    let chunk = chunks[i];
    if (chunk.startsWith("--")) break;
    segments.push(chunk.replace(/^\r?\n/, "").replace(/\r?\n$/, ""));
  }
  return segments;
}

function parsePart(head, body) {
  const headers = parseHeaders(head);
  const contentType = parseParams(headers.get("content-type") || "text/plain");
  const disposition = parseParams(headers.get("content-disposition") || "");

  if (contentType.value.startsWith("multipart/")) {
    const children = splitMultipart(body, contentType.params.boundary).map(segment => {
      const { head: partHead, body: partBody } = splitHeaderBody(segment);
      return parsePart(partHead, partBody);
    });
    return { multipart: true, children };
  }

  return {
    leaf: true,
    contentType: contentType.value,
    charset: contentType.params.charset || "utf-8",
    cte: (headers.get("content-transfer-encoding") || "7bit").toLowerCase(),
    filename: disposition.params.filename || contentType.params.name || "",
    disposition: disposition.value || "",
    contentId: (headers.get("content-id") || "").replace(/^<|>$/g, "").trim(),
    rawBody: body,
  };
}

function decodeLeafBytes(part) {
  if (part.cte === "base64") return base64ToBytes(part.rawBody);
  if (part.cte === "quoted-printable") return qpToBytes(part.rawBody);
  // 7bit / 8bit / binary: rawBody is the original bytes decoded as latin1.
  const out = new Uint8Array(part.rawBody.length);
  for (let i = 0; i < part.rawBody.length; i++) {
    out[i] = part.rawBody.charCodeAt(i) & 0xff;
  }
  return out;
}

function collectLeaves(node, acc) {
  if (!node) return acc;
  if (node.leaf) acc.push(node);
  else if (node.children) for (const child of node.children) collectLeaves(child, acc);
  return acc;
}

// A leaf is body text (not an attachment) when it is not explicitly attached and
// carries no filename.
function isBodyLeaf(leaf) {
  return leaf.disposition !== "attachment" && !leaf.filename;
}

/* ────────────────────────────────────────────────────────────────────────────
 * HTML sanitization — mirror of shared/email-format.js. Keeps a fixed
 * tag/attribute allowlist, drops scripts/styles, keeps embedded (cid:) images,
 * and replaces stripped images with a neutral placeholder.
 * ────────────────────────────────────────────────────────────────────────── */

const ALLOWED_HTML_TAGS = new Set([
  "a", "abbr", "b", "blockquote", "br", "caption", "cite", "code", "col",
  "colgroup", "dd", "div", "dl", "dt", "em", "figcaption", "figure", "h1", "h2",
  "h3", "h4", "h5", "h6", "hr", "i", "img", "li", "mark", "ol", "p", "pre", "q",
  "s", "small", "span", "strong", "sub", "sup", "table", "tbody", "td", "tfoot",
  "th", "thead", "tr", "u", "ul",
]);

const DROP_HTML_TAGS = new Set([
  "script", "style", "iframe", "object", "embed", "form", "input", "button",
  "select", "textarea", "link", "meta", "base", "title", "head", "svg", "math",
]);

const ALLOWED_HTML_ATTRS = {
  a: ["href", "title"],
  img: ["src", "alt", "title", "width", "height"],
  td: ["colspan", "rowspan"],
  th: ["colspan", "rowspan"],
  col: ["span"],
  colgroup: ["span"],
};

const PLACEHOLDER_IMAGE =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" ' +
      'fill="none" stroke="#999999" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/>' +
      '<path d="M21 15l-5-5L5 21"/></svg>'
  );

// Returns a safe URL or null. Inline data: images are always kept (no network);
// http(s)/mailto/cid are kept only when allowRemote is true.
function sanitizeUrl(value, allowRemote) {
  const url = String(value || "").trim();

  if (/^data:image\//i.test(url)) {
    return url;
  }
  if (/^\s*(javascript:|data:|vbscript:)/i.test(url)) {
    return null;
  }
  if (/^(https?:|mailto:|cid:)/i.test(url)) {
    return allowRemote ? url : null;
  }

  // Protocol-relative, relative, or unknown scheme: treat as remote/unsafe.
  return null;
}

function replaceWithImagePlaceholder(element) {
  element.setAttribute("src", PLACEHOLDER_IMAGE);
  element.setAttribute("title", "Remote image removed");
  element.removeAttribute("alt");
  element.removeAttribute("width");
  element.removeAttribute("height");
}

// Resolves an <img> src. cid: references (inline images embedded in the mail)
// are looked up in cidImages and returned as data: URIs, because Trilium cannot
// resolve cid: on its own. Everything else follows the remote-image policy.
function resolveImageSrc(value, allowRemoteImages, cidImages) {
  const url = String(value || "").trim();

  const cidMatch = /^cid:(.+)$/i.exec(url);
  if (cidMatch) {
    const key = cidMatch[1].replace(/^<|>$/g, "").trim().toLowerCase();
    return cidImages.get(key) || null;
  }

  return sanitizeUrl(url, allowRemoteImages);
}

function sanitizeHtml(html, { allowRemoteImages = false, cidImages = new Map() } = {}) {
  const doc = new DOMParser().parseFromString(String(html || ""), "text/html");

  for (const element of Array.from(doc.body.querySelectorAll("*"))) {
    const tag = element.tagName.toLowerCase();

    if (DROP_HTML_TAGS.has(tag)) {
      element.remove();
      continue;
    }

    if (!ALLOWED_HTML_TAGS.has(tag)) {
      element.replaceWith(...element.childNodes);
      continue;
    }

    const allowed = ALLOWED_HTML_ATTRS[tag] || [];
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();

      if (name.startsWith("on") || !allowed.includes(name)) {
        element.removeAttribute(attribute.name);
        continue;
      }

      if (name === "href") {
        const safe = sanitizeUrl(attribute.value, true);
        if (safe) {
          element.setAttribute(name, safe);
        } else {
          element.removeAttribute(name);
        }
      } else if (name === "src") {
        const safe = resolveImageSrc(attribute.value, allowRemoteImages, cidImages);
        if (safe) {
          element.setAttribute(name, safe);
        } else {
          element.removeAttribute(name);
        }
      }
    }

    // An image whose src was dropped becomes a neutral placeholder rather than a
    // broken icon with vertically-wrapped alt text.
    if (tag === "img" && !element.getAttribute("src")) {
      replaceWithImagePlaceholder(element);
    }
  }

  return doc.body.innerHTML.trim();
}

/* ────────────────────────────────────────────────────────────────────────────
 * Body / attachments / inline images derived from the parsed MIME tree.
 * ────────────────────────────────────────────────────────────────────────── */

// Content-ID → data: URI, so cid: references in the HTML body resolve to the
// embedded image bytes.
function buildCidMap(root) {
  const map = new Map();
  for (const leaf of collectLeaves(root, [])) {
    if (!leaf.contentId) continue;
    const mime = leaf.contentType || "application/octet-stream";
    map.set(leaf.contentId.toLowerCase(), `data:${mime};base64,${bytesToBase64(decodeLeafBytes(leaf))}`);
  }
  return map;
}

function htmlToText(html) {
  const doc = new DOMParser().parseFromString(String(html || ""), "text/html");
  return (doc.body.textContent || "").replace(/[ \t]+\n/g, "\n").trim();
}

// Plain-text rendering: prefer the text/plain part; if only HTML exists, reduce
// it to text. Used for the "plain" body format.
function selectBodyText(root) {
  const leaves = collectLeaves(root, []);
  const plain = leaves.find(leaf => leaf.contentType === "text/plain" && isBodyLeaf(leaf));
  if (plain) return decodeBytes(decodeLeafBytes(plain), plain.charset);

  const html = leaves.find(leaf => leaf.contentType === "text/html" && isBodyLeaf(leaf));
  if (html) return htmlToText(decodeBytes(decodeLeafBytes(html), html.charset));

  return "";
}

// Prefer the HTML body (sanitized, with inline images); fall back to the plain
// text part rendered as HTML.
function buildBodyHtml(root, { allowRemoteImages, cidImages }) {
  const leaves = collectLeaves(root, []);

  const htmlLeaves = leaves.filter(leaf => leaf.contentType === "text/html" && isBodyLeaf(leaf));
  if (htmlLeaves.length) {
    const sanitized = htmlLeaves
      .map(leaf => sanitizeHtml(decodeBytes(decodeLeafBytes(leaf), leaf.charset), { allowRemoteImages, cidImages }))
      .filter(Boolean)
      .join("\n<hr>\n");
    if (sanitized) return sanitized;
  }

  const plain = leaves.find(leaf => leaf.contentType === "text/plain" && isBodyLeaf(leaf));
  return textToHtml(plain ? decodeBytes(decodeLeafBytes(plain), plain.charset) : "");
}

// Dispatch on the configured body format. cidImages is only needed for HTML.
function buildBody(root, bodyFormat, cidImages) {
  if (bodyFormat === "plain") {
    return textToHtml(selectBodyText(root));
  }
  return buildBodyHtml(root, { allowRemoteImages: bodyFormat === "html-images", cidImages });
}

// Every non-body leaf that names a file or is explicitly attached. Inline images
// with a filename are included too (they also appear inline via cid:).
function collectAttachments(root) {
  return collectLeaves(root, [])
    .filter(leaf => (leaf.filename || leaf.disposition === "attachment") && !isBodyLeaf(leaf))
    .map(leaf => ({
      title: safeFilename(decodeRfc2047(leaf.filename) || "attachment"),
      mime: leaf.contentType || "application/octet-stream",
      base64: bytesToBase64(decodeLeafBytes(leaf)),
    }));
}

function parseEml(bytes) {
  // latin1 preserves every byte 1:1 so structure parsing is lossless; each leaf
  // is re-decoded with its own charset afterwards.
  const raw = new TextDecoder("latin1").decode(bytes);
  const { head, body } = splitHeaderBody(raw);
  const headers = parseHeaders(head);

  return {
    subject: decodeRfc2047(headers.get("subject")),
    from: decodeRfc2047(headers.get("from")),
    to: decodeRfc2047(headers.get("to")),
    cc: decodeRfc2047(headers.get("cc")),
    dateHeader: headers.get("date"),
    messageId: (headers.get("message-id") || "").replace(/^<|>$/g, "").trim(),
    root: parsePart(head, body),
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Import key (duplicate detection) — same derivation as shared/email-format.js.
 * ────────────────────────────────────────────────────────────────────────── */

async function sha256Hex(value) {
  const data = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

async function deriveImportKey(messageId, bytes) {
  return messageId
    ? sha256Hex(`message-id:${messageId.toLowerCase()}`)
    : sha256Hex(bytes);
}

// The sent date as a local YYYY-MM-DD string (for the day-note clone and the
// #startDate label), or null when the email has no valid Date header. Mirrors
// dateToLocalIso in shared/email-format.js but returns null instead of throwing.
function emailIsoDate(dateHeader) {
  const date = dateHeader ? new Date(dateHeader) : null;
  if (!date || Number.isNaN(date.getTime())) return null;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// Local wall-clock "HH:MM" (24-hour) for the sent time, used for the calendar
// #startTime label. Returns null when the Date header is missing or invalid.
// Mirror of localTimeHm in shared/email-format.js.
function emailLocalTime(dateHeader) {
  const date = dateHeader ? new Date(dateHeader) : null;
  if (!date || Number.isNaN(date.getTime())) return null;
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Note assembly + creation
 * ────────────────────────────────────────────────────────────────────────── */

// Header-block + attachments line + <hr> + body layout.
function buildNoteContent(eml, bodyHtml, attachmentNames) {
  const sent = eml.dateHeader ? new Date(eml.dateHeader) : null;
  const sentStr = sent && !Number.isNaN(sent.getTime())
    ? sent.toLocaleString()
    : (eml.dateHeader || "");

  const attachmentsHtml = attachmentNames.length
    ? `<p><strong>Attachments:</strong> ${attachmentNames.map(escapeHtml).join(", ")}</p>`
    : "";

  return `
    <p>
      <strong>From:</strong> ${escapeHtml(eml.from)}<br>
      <strong>To:</strong> ${escapeHtml(eml.to)}<br>
      ${eml.cc ? `<strong>CC:</strong> ${escapeHtml(eml.cc)}<br>` : ""}
      <strong>Sent:</strong> ${escapeHtml(sentStr)}<br>
      <strong>Message-ID:</strong> ${escapeHtml(eml.messageId)}
    </p>
    ${attachmentsHtml}
    <hr>
    ${bodyHtml}
  `;
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

// Create the email note, its labels, attachment children and preserved .eml on
// the backend — after checking for an existing import with the same key. Binary
// payloads are passed as base64 (backend arguments are serialised as JSON) and
// rebuilt into Buffers server-side. The callback is self-contained (it closes
// over nothing from module scope), as backend callbacks require.
async function createEmailNote(payload) {
  return runAsyncOnBackendWithManualTransactionHandling(async (p) => {
    // Link the note to the date it was sent. "calendar" adds the calendar's
    // native #startDate / #startTime labels (day + sent time; no #endTime, an
    // email has no duration) so a calendar view shows it as an event. "daily"
    // clones the note under the matching day note.
    const applyDateBehavior = (targetNote) => {
      if (!p.isoDate || !targetNote) return;
      if (p.dateMode === "calendar" || p.dateMode === "both") {
        targetNote.setLabel("startDate", p.isoDate);
        if (p.startTime) targetNote.setLabel("startTime", p.startTime);
      }
      if (p.dateMode === "daily" || p.dateMode === "both") {
        const dayNote = api.getDayNote(p.isoDate);
        if (dayNote) {
          api.ensureNoteIsPresentInParent(targetNote.noteId, dayNote.noteId);
        }
      }
    };

    const applyColor = (targetNote) => {
      if (p.color && targetNote) targetNote.setLabel("color", p.color);
    };

    const existing = api.searchForNotes(`#${p.labels.importKey}="${p.importKey}"`);
    if (existing && existing.length) {
      // Re-apply the date/color behavior so enabling these options later still
      // updates an already-imported email.
      applyDateBehavior(existing[0]);
      applyColor(existing[0]);
      return { status: "duplicate", noteId: existing[0].noteId, title: existing[0].title };
    }

    const created = await api.createNewNote({
      parentNoteId: p.parentNoteId,
      title: p.title,
      type: "text",
      mime: "text/html",
      content: p.content,
    });
    const note = created.note;

    note.setLabel("email");
    note.setLabel(p.labels.importKey, p.importKey);
    note.setLabel("iconClass", p.iconClass);
    if (p.messageId) {
      note.setLabel(p.labels.messageId, p.messageId);
    }

    for (const attachment of p.attachments) {
      const child = await api.createNewNote({
        parentNoteId: note.noteId,
        title: attachment.title,
        type: "file",
        mime: attachment.mime,
        content: Buffer.from(attachment.base64, "base64"),
      });
      child.note.setLabel(p.childLabels.attachment);
    }

    if (p.emlBase64) {
      const emlNote = await api.createNewNote({
        parentNoteId: note.noteId,
        title: p.emlFilename,
        type: "file",
        mime: "message/rfc822",
        content: Buffer.from(p.emlBase64, "base64"),
      });
      emlNote.note.setLabel(p.childLabels.emlFileType, "eml");
    }

    applyDateBehavior(note);
    applyColor(note);

    return { status: "imported", noteId: note.noteId, title: p.title };
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

  const oneOf = (name, choices, fallback) => {
    const value = String(label(name) || "").toLowerCase();
    return choices.includes(value) ? value : fallback;
  };

  const bool = (name, fallback) => {
    const value = label(name);
    return value === null || value === undefined || value === ""
      ? fallback
      : !/^(false|no|0|off)$/i.test(String(value).trim());
  };

  return {
    bodyFormat: oneOf("emlBodyFormat", ["plain", "html", "html-images"], DEFAULT_OPTIONS.bodyFormat),
    importAttachments: bool("emlImportAttachments", DEFAULT_OPTIONS.importAttachments),
    preserveEml: bool("emlPreserveEml", DEFAULT_OPTIONS.preserveEml),
    dateMode: oneOf("emlDateMode", ["daily", "calendar", "both", "none"], DEFAULT_OPTIONS.dateMode),
    iconClass: label("emlIconClass") || DEFAULT_OPTIONS.iconClass,
    color: label("emlColor") || DEFAULT_OPTIONS.color,
  };
}

function pickEmlFiles() {
  return new Promise(resolve => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".eml,message/rfc822";
    input.multiple = true;
    input.addEventListener("change", () => resolve(Array.from(input.files || [])));
    input.click();
  });
}

async function importFile(file, parentNoteId, options) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const eml = parseEml(bytes);

  const title = eml.subject || file.name.replace(/\.eml$/i, "") || "(no subject)";
  const cidImages = options.bodyFormat === "plain" ? new Map() : buildCidMap(eml.root);
  const bodyHtml = buildBody(eml.root, options.bodyFormat, cidImages);
  const attachments = collectAttachments(eml.root);
  // Attachment names are always listed in the body; only the child notes are
  // gated by the importAttachments option.
  const content = buildNoteContent(eml, bodyHtml, attachments.map(attachment => attachment.title));
  const importKey = await deriveImportKey(eml.messageId, bytes);

  return createEmailNote({
    parentNoteId,
    title,
    content,
    importKey,
    messageId: eml.messageId,
    labels: LABELS,
    childLabels: CHILD_LABELS,
    iconClass: options.iconClass,
    attachments: options.importAttachments ? attachments : [],
    emlBase64: options.preserveEml ? bytesToBase64(bytes) : "",
    emlFilename: `${safeFilename(title)}.eml`,
    dateMode: options.dateMode,
    isoDate: emailIsoDate(eml.dateHeader),
    color: options.color,
    startTime: emailLocalTime(eml.dateHeader),
  });
}

async function importEmlFiles() {
  const activeNote = api.getActiveContextNote();
  if (!activeNote) {
    api.showError("Open the note you want the email(s) imported into, then click the button again.");
    return;
  }

  const options = readOptions();

  const files = await pickEmlFiles();
  if (!files.length) {
    return;
  }

  let imported = 0;
  let duplicates = 0;
  let failed = 0;
  const errors = [];

  for (const file of files) {
    try {
      const result = await importFile(file, activeNote.noteId, options);
      if (result.status === "duplicate") {
        duplicates += 1;
      } else {
        imported += 1;
      }
    } catch (error) {
      failed += 1;
      errors.push(`${file.name}: ${error.message}`);
      console.error("eml2trilium: failed to import", file.name, error);
    }
  }

  const summary = [`${imported} imported into "${activeNote.title}"`];
  if (duplicates) summary.push(`${duplicates} duplicate${duplicates === 1 ? "" : "s"} skipped`);
  if (failed) summary.push(`${failed} failed`);
  api.showMessage(summary.join(", ") + ".");
  if (failed) {
    api.showError(errors[0]);
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Launch-bar widget — an envelope button that imports .eml files into the
 * currently active note. Register via Global menu → Configure launchbar → Add a
 * custom widget, pointing its "widget" field at this note (no #widget label).
 * ────────────────────────────────────────────────────────────────────────── */

export default defineLauncherWidget({
  render: () => {
    const { note } = useActiveNoteContext();
    const disabled = !note;

    return (
      <button
        type="button"
        class="bx bx-envelope"
        title={disabled ? "Open a note first, then import .eml file(s)" : "Import .eml file(s) into this note"}
        disabled={disabled}
        onClick={() => importEmlFiles()}
        style={{
          background: "transparent",
          border: "none",
          color: "inherit",
          cursor: disabled ? "default" : "pointer",
          fontSize: "1.3em",
          padding: "10px",
          opacity: disabled ? 0.4 : 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      />
    );
  },
});
