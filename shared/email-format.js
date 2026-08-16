/**
 * email-format.js — shared, environment-agnostic helpers for turning an email
 * into a Trilium note.
 *
 * This is the single source of truth for the pure formatting/label logic used
 * by BOTH import paths so that an email lands the same way regardless of where
 * it came from:
 *
 *   - thunderbird2trilium  (WebExtension, runs inside Thunderbird)
 *   - eml2trilium          (Trilium frontend script, imports .eml files)
 *
 * These functions are intentionally free of any environment API (no messenger.*,
 * no Trilium api.*, no fetch): they only transform strings/dates. Keep them that
 * way so both hosts can reuse them.
 *
 * SHARING NOTE
 *   A Trilium note is a single self-contained blob and cannot `import` a sibling
 *   repo file, so eml2trilium.js carries an inlined copy of the helpers it needs
 *   under a banner that points back here. This file is the canonical definition;
 *   when you change a helper here, update the mirrored copy. The (still pending)
 *   refactor of thunderbird2trilium/background.js to import from this file will
 *   remove that side's duplication.
 */

// Label names written on imported email notes. Kept here so both paths agree,
// which is what lets duplicate detection recognise an email across import paths.
export const LABELS = {
  importKey: "emailImportKey",
  messageId: "emailMessageId",
  date: "emailDate",
};

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function textToHtml(text) {
  if (!text || !text.trim()) {
    return "<p><em>No readable message body.</em></p>";
  }

  return text
    .split(/\r?\n\r?\n/)
    .map(paragraph => `<p>${escapeHtml(paragraph).replace(/\r?\n/g, "<br>")}</p>`)
    .join("\n");
}

export function safeFilename(name) {
  return String(name || "email")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 150) || "email";
}

export function dateToLocalIso(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error("The email has no valid sent date.");
  }

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
