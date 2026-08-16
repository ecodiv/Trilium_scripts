/**
 * eml2trilium — import .eml files into the active Trilium note.  (Phase 1 MVP)
 *
 * Companion to the "Send to Trilium" Thunderbird add-on. It produces the same
 * kind of note — subject as title, a From/To/CC/Sent/Message-ID header block,
 * the message body, and the original .eml preserved as a child file note — so an
 * email lands the same way whether it came straight from Thunderbird or from a
 * stored .eml file on disk.
 *
 * DELIVERY (this is a Trilium frontend script, NOT a browser add-on)
 *   1. Create a code note, type "JS frontend", and paste this whole file in.
 *   2. In the Launch Bar configuration add a launcher of type "Script" that
 *      points at this note; label it e.g. "Import EML". Clicking it opens a file
 *      picker and imports the chosen .eml file(s) into whatever note is active.
 *   A Launch Bar Script launcher is used (rather than a tree right-click item)
 *   because extending Trilium's note context menu is not part of the supported
 *   script API; a launcher command is stable across versions.
 *
 * SCOPE — Phase 1 (this file):
 *   - Parse each .eml: headers + best text/plain (or, failing that, text/html
 *     reduced to text) body.
 *   - Create a child text note under the CURRENTLY ACTIVE note.
 *   - Attach the untouched original .eml as a child file note.
 *
 * NOT yet implemented (Phase 2/3), by design:
 *   - Sanitized HTML body with original formatting + inline (cid:) images.
 *   - Extracting attachments into their own child notes.
 *   - Duplicate detection via an emailImportKey label (cross-detects Thunderbird
 *     imports).
 *   - Optional clone under the sent-date daily note + #emailDate label.
 *
 * BACKEND API NOTE
 *   Note creation targets the current TriliumNext backend script API
 *   (api.createNewNote, run via runAsyncOnBackendWithManualTransactionHandling).
 *   If your Trilium version exposes different names, only createNotes() below
 *   needs adjusting — the parser and formatting are host-independent.
 */

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
 * and per-part charset decoding. It is deliberately small; the full-fidelity
 * HTML/attachment handling arrives in Phase 2 (likely via a vendored parser).
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

function htmlToText(html) {
  const doc = new DOMParser().parseFromString(String(html || ""), "text/html");
  return (doc.body.textContent || "").replace(/[ \t]+\n/g, "\n").trim();
}

// Phase 1 renders a plain-text body: prefer the text/plain part; if only HTML
// exists, reduce it to text (safe, no raw HTML injected). Phase 2 will keep the
// formatted, sanitized HTML instead.
function selectBodyText(root) {
  const leaves = collectLeaves(root, []);
  const plain = leaves.find(leaf => leaf.contentType === "text/plain" && isBodyLeaf(leaf));
  if (plain) return decodeBytes(decodeLeafBytes(plain), plain.charset);

  const html = leaves.find(leaf => leaf.contentType === "text/html" && isBodyLeaf(leaf));
  if (html) return htmlToText(decodeBytes(decodeLeafBytes(html), html.charset));

  return "";
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
    bodyText: selectBodyText(parsePart(head, body)),
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Note assembly + creation
 * ────────────────────────────────────────────────────────────────────────── */

// Same header-block + <hr> + body layout the Thunderbird add-on produces.
function buildNoteContent(eml, bodyHtml) {
  const sent = eml.dateHeader ? new Date(eml.dateHeader) : null;
  const sentStr = sent && !Number.isNaN(sent.getTime())
    ? sent.toLocaleString()
    : (eml.dateHeader || "");

  return `
    <p>
      <strong>From:</strong> ${escapeHtml(eml.from)}<br>
      <strong>To:</strong> ${escapeHtml(eml.to)}<br>
      ${eml.cc ? `<strong>CC:</strong> ${escapeHtml(eml.cc)}<br>` : ""}
      <strong>Sent:</strong> ${escapeHtml(sentStr)}<br>
      <strong>Message-ID:</strong> ${escapeHtml(eml.messageId)}
    </p>
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

// Create the email note plus its preserved .eml child on the backend. The raw
// message is passed as base64 (runOnBackend serialises arguments as JSON, so
// binary cannot be handed over directly) and rebuilt into a Buffer server-side.
async function createNotes({ parentNoteId, title, content, emlBase64, emlFilename }) {
  return api.runAsyncOnBackendWithManualTransactionHandling(async (params) => {
    const emailNote = await api.createNewNote({
      parentNoteId: params.parentNoteId,
      title: params.title,
      type: "text",
      mime: "text/html",
      content: params.content,
    });

    await api.createNewNote({
      parentNoteId: emailNote.note.noteId,
      title: params.emlFilename,
      type: "file",
      mime: "message/rfc822",
      content: Buffer.from(params.emlBase64, "base64"),
    });

    return emailNote.note.noteId;
  }, [{ parentNoteId, title, content, emlBase64, emlFilename }]);
}

/* ────────────────────────────────────────────────────────────────────────────
 * UI flow
 * ────────────────────────────────────────────────────────────────────────── */

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

async function importFile(file, parentNoteId) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const eml = parseEml(bytes);

  const title = eml.subject || file.name.replace(/\.eml$/i, "") || "(no subject)";
  const content = buildNoteContent(eml, textToHtml(eml.bodyText));

  await createNotes({
    parentNoteId,
    title,
    content,
    emlBase64: bytesToBase64(bytes),
    emlFilename: `${safeFilename(title)}.eml`,
  });
}

async function run() {
  const activeNote = api.getActiveContextNote();
  if (!activeNote) {
    api.showError("Open the note you want the email(s) imported into, then run Import EML again.");
    return;
  }

  const files = await pickEmlFiles();
  if (!files.length) {
    return;
  }

  let imported = 0;
  let failed = 0;
  const errors = [];

  for (const file of files) {
    try {
      await importFile(file, activeNote.noteId);
      imported += 1;
    } catch (error) {
      failed += 1;
      errors.push(`${file.name}: ${error.message}`);
      console.error("eml2trilium: failed to import", file.name, error);
    }
  }

  api.showMessage(`Imported ${imported} email${imported === 1 ? "" : "s"}${failed ? `, ${failed} failed` : ""}.`);
  if (failed) {
    api.showError(errors[0]);
  }
}

run();
