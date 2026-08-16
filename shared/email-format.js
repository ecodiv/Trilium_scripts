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
 * SHARING NOTE (loose coupling by design)
 *   Neither host can `import` this file at runtime: a Trilium note is a single
 *   self-contained blob, and a WebExtension can only load files inside its own
 *   package (this file sits one level above it). So each side carries its own
 *   copy of the functions it needs; this file is the canonical reference to diff
 *   against when either copy changes. When you edit a function here, update the
 *   copies in eml2trilium.jsx and thunderbird2trilium/background.js to match.
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

/* ────────────────────────────────────────────────────────────────────────────
 * HTML sanitization — keeps a fixed tag/attribute allowlist, drops
 * scripts/styles, keeps embedded (cid:) images, and replaces stripped images
 * with a neutral placeholder. Needs a DOMParser (present in both a WebExtension
 * and the Trilium frontend).
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
export function sanitizeUrl(value, allowRemote) {
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
export function resolveImageSrc(value, allowRemoteImages, cidImages) {
  const url = String(value || "").trim();

  const cidMatch = /^cid:(.+)$/i.exec(url);
  if (cidMatch) {
    const key = cidMatch[1].replace(/^<|>$/g, "").trim().toLowerCase();
    return cidImages.get(key) || null;
  }

  return sanitizeUrl(url, allowRemoteImages);
}

export function sanitizeHtml(html, { allowRemoteImages = false, cidImages = new Map() } = {}) {
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
 * Duplicate-detection key. The key is the SHA-256 of the Message-ID (normalised
 * to lowercase, without angle brackets), or of the raw message bytes when the
 * Message-ID is absent. Both hosts must derive it identically for cross-path
 * duplicate detection to work. Needs Web Crypto (crypto.subtle).
 * ────────────────────────────────────────────────────────────────────────── */

export async function sha256Hex(value) {
  const data = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function deriveImportKey(messageId, rawBytes) {
  return messageId
    ? sha256Hex(`message-id:${messageId.toLowerCase()}`)
    : sha256Hex(rawBytes);
}
