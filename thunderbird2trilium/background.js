// NOTE: the pure formatting/sanitizing/hashing helpers below (escapeHtml,
// textToHtml, safeFilename, dateToLocalIso, sanitizeHtml and its helpers,
// sha256Hex, and the import-key derivation) are mirrored in
// ../shared/email-format.js, the canonical copy shared with the eml2trilium
// Trilium widget. Neither host can import that file at runtime, so keep these in
// sync with it by hand when changing them.

const DEFAULT_SETTINGS = {
  triliumUrl: "",
  etapiToken: "",
  parentNoteId: "",
  importAttachments: true,
  preserveEml: true,
  bodyFormat: "plain",
  dateMode: "both",
  dateLabel: "emailDate"
};

async function getSettings() {
  const settings = await messenger.storage.local.get(DEFAULT_SETTINGS);
  settings.triliumUrl = normalizeBaseUrl(settings.triliumUrl);

  if (!settings.triliumUrl || !settings.etapiToken || !settings.parentNoteId) {
    throw new Error("Configure the Trilium URL, ETAPI token and destination Note ID in the extension settings first.");
  }

  return settings;
}

function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

async function triliumRequest(settings, path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("Authorization", settings.etapiToken);

  let body = options.body;
  if (Object.prototype.hasOwnProperty.call(options, "json")) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(options.json);
  }

  const response = await fetch(`${settings.triliumUrl}/etapi${path}`, {
    ...options,
    headers,
    body
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Trilium error ${response.status}: ${text || response.statusText}`);
  }

  if (response.status === 204) {
    return null;
  }

  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return response.json();
  }

  return response.text();
}

async function createNote(settings, { parentNoteId, title, type = "text", mime, content = "" }) {
  const json = {
    parentNoteId,
    title,
    type,
    content
  };

  if (mime) {
    json.mime = mime;
  }

  return triliumRequest(settings, "/create-note", {
    method: "POST",
    json
  });
}

async function uploadBinaryContent(settings, noteId, file) {
  const bytes = await file.arrayBuffer();

  return triliumRequest(settings, `/notes/${encodeURIComponent(noteId)}/content`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Transfer-Encoding": "binary"
    },
    body: bytes
  });
}

async function createFileNote(settings, parentNoteId, title, mime, file) {
  const created = await createNote(settings, {
    parentNoteId,
    title,
    type: "file",
    mime: mime || "application/octet-stream",
    content: ""
  });

  const noteId = created.note.noteId;
  await uploadBinaryContent(settings, noteId, file);
  return noteId;
}

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

function dateToLocalIso(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error("The email has no valid sent date.");
  }

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

const ENCRYPTED_CONTENT_TYPES = [
  "multipart/encrypted",
  "application/pgp-encrypted",
  "application/pkcs7-mime",
  "application/x-pkcs7-mime"
];

function partIsEncrypted(part) {
  const contentType = (part.contentType || "").toLowerCase();
  if (ENCRYPTED_CONTENT_TYPES.some(type => contentType.startsWith(type))) {
    return true;
  }
  return (part.parts || []).some(partIsEncrypted);
}

async function isEncryptedMessage(messageId) {
  // Inspect the raw MIME structure without decrypting so encrypted parts stay
  // visible as such. Covers PGP/MIME and S/MIME; inline-PGP is not detected.
  const full = await messenger.messages.getFull(messageId, { decrypt: false });
  return partIsEncrypted(full);
}

async function getReadableBody(messageId) {
  const parts = await messenger.messages.listInlineTextParts(messageId);

  const plainText = parts
    .filter(part => part.contentType?.toLowerCase().startsWith("text/plain"))
    .map(part => part.content)
    .join("\n\n")
    .trim();

  if (plainText) {
    return plainText;
  }

  const htmlParts = parts.filter(part => part.contentType?.toLowerCase().startsWith("text/html"));
  if (!htmlParts.length) {
    return "";
  }

  const converted = [];
  for (const part of htmlParts) {
    converted.push(
      await messenger.messengerUtilities.convertToPlainText(part.content, { flowed: false })
    );
  }

  return converted.join("\n\n");
}

// Tags kept during HTML sanitization; everything else is unwrapped (children
// preserved) or, for the dangerous set below, removed with its subtree.
const ALLOWED_HTML_TAGS = new Set([
  "a", "abbr", "b", "blockquote", "br", "caption", "cite", "code", "col",
  "colgroup", "dd", "div", "dl", "dt", "em", "figcaption", "figure", "h1", "h2",
  "h3", "h4", "h5", "h6", "hr", "i", "img", "li", "mark", "ol", "p", "pre", "q",
  "s", "small", "span", "strong", "sub", "sup", "table", "tbody", "td", "tfoot",
  "th", "thead", "tr", "u", "ul"
]);

const DROP_HTML_TAGS = new Set([
  "script", "style", "iframe", "object", "embed", "form", "input", "button",
  "select", "textarea", "link", "meta", "base", "title", "head", "svg", "math"
]);

const ALLOWED_HTML_ATTRS = {
  a: ["href", "title"],
  img: ["src", "alt", "title", "width", "height"],
  td: ["colspan", "rowspan"],
  th: ["colspan", "rowspan"],
  col: ["span"],
  colgroup: ["span"]
};

// Fixed-size inline placeholder shown where a remote image was removed. Being a
// data: URI it never triggers a network request, and dropping alt/width/height
// avoids the narrow column of vertically-wrapped alt text that a tiny broken
// image would otherwise produce.
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

async function attachmentToDataUrl(messageId, attachment) {
  const file = await messenger.messages.getAttachmentFile(messageId, attachment.partName);
  const bytes = new Uint8Array(await file.arrayBuffer());

  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + chunkSize));
  }

  const type = attachment.contentType || file.type || "application/octet-stream";
  return `data:${type};base64,${btoa(binary)}`;
}

// Maps inline-image Content-IDs to data: URIs so cid: references can be embedded
// directly in the imported note.
async function buildInlineImageMap(messageId) {
  const map = new Map();

  let attachments;
  try {
    attachments = await messenger.messages.listAttachments(messageId);
  } catch (error) {
    console.error("Could not list attachments for inline images:", error);
    return map;
  }

  for (const attachment of attachments) {
    if (!attachment.contentId) {
      continue;
    }

    const key = attachment.contentId.replace(/^<|>$/g, "").trim().toLowerCase();
    if (!key) {
      continue;
    }

    try {
      map.set(key, await attachmentToDataUrl(messageId, attachment));
    } catch (error) {
      console.error("Could not inline image:", attachment.name, error);
    }
  }

  return map;
}

async function getReadableHtmlBody(messageId, options = {}) {
  const allowRemoteImages = options.allowRemoteImages === true;

  const parts = await messenger.messages.listInlineTextParts(messageId);

  const htmlParts = parts.filter(part => part.contentType?.toLowerCase().startsWith("text/html"));
  if (htmlParts.length) {
    // Embedded (cid:) images are kept in both HTML modes, mirroring how a mail
    // client shows inline images even when remote content is blocked. The modes
    // differ only in whether remote/external images are also kept.
    const cidImages = await buildInlineImageMap(messageId);
    const sanitized = htmlParts
      .map(part => sanitizeHtml(part.content, { allowRemoteImages, cidImages }))
      .filter(Boolean)
      .join("\n<hr>\n");

    if (sanitized) {
      return sanitized;
    }
  }

  // No usable HTML part: fall back to the plaintext-derived rendering.
  return textToHtml(await getReadableBody(messageId));
}

async function getRawMessageFile(messageId, subject) {
  const raw = await messenger.messages.getRaw(messageId, {
    data_format: "File",
    decrypt: false
  });

  if (raw instanceof File) {
    return raw;
  }

  return new File(
    [raw],
    `${safeFilename(subject)}.eml`,
    { type: "message/rfc822" }
  );
}

async function sha256Hex(value) {
  let data;

  if (typeof value === "string") {
    data = new TextEncoder().encode(value);
  } else if (value instanceof ArrayBuffer) {
    data = value;
  } else if (ArrayBuffer.isView(value)) {
    data = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
  } else {
    throw new TypeError("Unsupported SHA-256 input.");
  }

  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

async function findExistingImport(settings, importKey) {
  const params = new URLSearchParams({
    search: `#emailImportKey = '${importKey}'`,
    fastSearch: "true",
    includeArchivedNotes: "true",
    limit: "1"
  });

  const result = await triliumRequest(settings, `/notes?${params.toString()}`);
  return result.results?.[0] || null;
}

async function ensureLabel(settings, noteId, name, value, position = 10) {
  const note = await triliumRequest(settings, `/notes/${encodeURIComponent(noteId)}`);
  const ownLabels = (note.attributes || []).filter(attribute =>
    attribute.noteId === noteId &&
    attribute.type === "label" &&
    attribute.name === name
  );

  const exact = ownLabels.find(attribute => attribute.value === String(value));
  if (exact) {
    return exact;
  }

  if (ownLabels.length) {
    const existing = ownLabels[0];
    return triliumRequest(settings, `/attributes/${encodeURIComponent(existing.attributeId)}`, {
      method: "PATCH",
      json: {
        value: String(value)
      }
    });
  }

  return triliumRequest(settings, "/attributes", {
    method: "POST",
    json: {
      noteId,
      type: "label",
      name,
      value: String(value),
      position,
      isInheritable: false
    }
  });
}

async function cloneIntoDailyNote(settings, noteId, isoDate) {
  const dayNote = await triliumRequest(settings, `/calendar/days/${encodeURIComponent(isoDate)}`);

  // Avoid creating a second branch when the note is already cloned under this
  // day note (e.g. re-importing an existing message with daily-note mode on).
  const note = await triliumRequest(settings, `/notes/${encodeURIComponent(noteId)}`);
  if ((note.parentNoteIds || []).includes(dayNote.noteId)) {
    return dayNote.noteId;
  }

  await triliumRequest(settings, "/branches", {
    method: "POST",
    json: {
      noteId,
      parentNoteId: dayNote.noteId,
      notePosition: 1000000,
      isExpanded: false
    }
  });

  return dayNote.noteId;
}

async function applyDateBehavior(settings, noteId, isoDate) {
  if (settings.dateMode === "attribute" || settings.dateMode === "both") {
    await ensureLabel(settings, noteId, settings.dateLabel || "emailDate", isoDate, 20);
  }

  if (settings.dateMode === "daily" || settings.dateMode === "both") {
    await cloneIntoDailyNote(settings, noteId, isoDate);
  }
}

async function importMessage(message, settings) {
  const subject = message.subject || "(no subject)";

  if (await isEncryptedMessage(message.id)) {
    return { status: "encrypted", title: subject };
  }

  const messageId = String(message.headerMessageId || "").trim();
  const isoDate = dateToLocalIso(message.date);

  let rawFile = null;
  let importKey;

  if (messageId) {
    importKey = await sha256Hex(`message-id:${messageId.toLowerCase()}`);
  } else {
    rawFile = await getRawMessageFile(message.id, subject);
    importKey = await sha256Hex(await rawFile.arrayBuffer());
  }

  const duplicate = await findExistingImport(settings, importKey);
  if (duplicate) {
    await applyDateBehavior(settings, duplicate.noteId, isoDate);
    return {
      status: "duplicate",
      noteId: duplicate.noteId,
      title: duplicate.title || subject
    };
  }

  const wantsHtml = settings.bodyFormat === "html" || settings.bodyFormat === "html-images";
  const [bodyHtml, attachments] = await Promise.all([
    wantsHtml
      ? getReadableHtmlBody(message.id, { allowRemoteImages: settings.bodyFormat === "html-images" })
      : getReadableBody(message.id).then(textToHtml),
    messenger.messages.listAttachments(message.id)
  ]);

  const recipients = message.recipients?.join(", ") || "";
  const cc = message.ccList?.join(", ") || "";
  const sentDate = message.date ? new Date(message.date).toLocaleString() : "";

  const attachmentDescription = attachments.length
    ? `<p><strong>Attachments:</strong> ${attachments
        .map(attachment => escapeHtml(attachment.name || "attachment"))
        .join(", ")}</p>`
    : "";

  const content = `
    <p>
      <strong>From:</strong> ${escapeHtml(message.author || "")}<br>
      <strong>To:</strong> ${escapeHtml(recipients)}<br>
      ${cc ? `<strong>CC:</strong> ${escapeHtml(cc)}<br>` : ""}
      <strong>Sent:</strong> ${escapeHtml(sentDate)}<br>
      <strong>Message-ID:</strong> ${escapeHtml(messageId)}
    </p>
    ${attachmentDescription}
    <hr>
    ${bodyHtml}
  `;

  const created = await createNote(settings, {
    parentNoteId: settings.parentNoteId,
    title: subject,
    type: "text",
    content
  });

  const emailNoteId = created.note.noteId;

  await ensureLabel(settings, emailNoteId, "email", "", 1);
  await ensureLabel(settings, emailNoteId, "emailImportKey", importKey, 10);
  await ensureLabel(settings, emailNoteId, "iconClass", "bx bx-envelope", 5);
  if (messageId) {
    await ensureLabel(settings, emailNoteId, "emailMessageId", messageId, 15);
  }
  await applyDateBehavior(settings, emailNoteId, isoDate);

  if (settings.importAttachments) {
    for (const attachment of attachments) {
      try {
        const file = await messenger.messages.getAttachmentFile(message.id, attachment.partName);
        const attachmentNoteId = await createFileNote(
          settings,
          emailNoteId,
          attachment.name || file.name || "attachment",
          attachment.contentType || file.type || "application/octet-stream",
          file
        );
        await ensureLabel(settings, attachmentNoteId, "email_attachment", "", 10);
      } catch (error) {
        console.error("Could not import attachment:", attachment.name, error);
      }
    }
  }

  if (settings.preserveEml) {
    if (!rawFile) {
      rawFile = await getRawMessageFile(message.id, subject);
    }

    const emlNoteId = await createFileNote(
      settings,
      emailNoteId,
      `${safeFilename(subject)}.eml`,
      "message/rfc822",
      rawFile
    );
    await ensureLabel(settings, emlNoteId, "file_type", "eml", 10);
  }

  return {
    status: "imported",
    noteId: emailNoteId,
    title: subject
  };
}

async function* iterateMessageList(list) {
  let page = list;

  while (page) {
    for (const message of page.messages) {
      yield message;
    }

    if (!page.id) {
      break;
    }

    page = await messenger.messages.continueList(page.id);
  }
}

async function notify(title, message) {
  try {
    await messenger.notifications.create({
      type: "basic",
      title,
      message
    });
  } catch (error) {
    console.log(`${title}: ${message}`, error);
  }
}

async function importMessageList(list) {
  let imported = 0;
  let duplicates = 0;
  let encrypted = 0;
  let failed = 0;
  const errors = [];

  let settings;
  try {
    settings = await getSettings();
  } catch (error) {
    await notify("Send to Trilium", error.message);
    return;
  }

  for await (const message of iterateMessageList(list)) {
    try {
      const result = await importMessage(message, settings);
      if (result.status === "duplicate") {
        duplicates += 1;
      } else if (result.status === "encrypted") {
        encrypted += 1;
      } else {
        imported += 1;
      }
    } catch (error) {
      console.error("Import failed for message", message.id, error);
      failed += 1;
      errors.push(error.message);
    }
  }

  const summary = [
    `${imported} imported`,
    `${duplicates} duplicate${duplicates === 1 ? "" : "s"} skipped`
  ];

  if (encrypted) {
    summary.push(`${encrypted} encrypted skipped`);
  }

  if (failed) {
    summary.push(`${failed} failed`);
  }

  await notify(
    "Send to Trilium",
    failed && errors.length
      ? `${summary.join(", ")}. ${errors[0]}`
      : summary.join(", ") + "."
  );
}

async function setupMenu() {
  await messenger.menus.removeAll();
  messenger.menus.create({
    id: "send-to-trilium",
    title: "Send to Trilium",
    contexts: ["message_list"]
  });
}

messenger.menus.onClicked.addListener(async info => {
  if (info.menuItemId === "send-to-trilium" && info.selectedMessages) {
    await importMessageList(info.selectedMessages);
  }
});

messenger.action.onClicked.addListener(async tab => {
  try {
    const displayed = await messenger.messageDisplay.getDisplayedMessages(tab.id);
    if (displayed.messages.length) {
      await importMessageList(displayed);
    } else {
      await notify("Send to Trilium", "No displayed email to import.");
    }
  } catch (error) {
    console.error(error);
    await notify("Send to Trilium", `Could not read the displayed email: ${error.message}`);
  }
});

messenger.runtime.onInstalled.addListener(() => {
  setupMenu().catch(console.error);
});

messenger.runtime.onStartup.addListener(() => {
  setupMenu().catch(console.error);
});

setupMenu().catch(console.error);
