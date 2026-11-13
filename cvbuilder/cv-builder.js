/**
 * cv-builder — build CV variants from a single CV subtree in Trilium.
 *
 * All CV content lives once in a subtree (root note labelled #cvRoot): a profile
 * note, section notes holding entry notes, and variant notes that select, filter
 * and order sections. For a chosen variant the widget builds:
 *   - an HTML CV (live preview, print / save as PDF, save as .html);
 *   - a RenderCV YAML file (render with `rendercv render <file>.yaml`);
 *   - a JSON Resume file (for JSON Resume themes / tools; lossy, see below).
 *
 * Author: Paulo van Breugel
 * Disclaimer: Claude.ai was used to create this script
 *
 * DELIVERY (Trilium launch-bar widget)
 *   1. Create a code note, type "JSX", and paste this whole file in.
 *   2. Global menu -> "Configure launchbar". Right click on the Visible Launchers
 *      section, choose "Add a custom widget", and set its "widget" field to this
 *      note.
 *   3. Reload Trilium (Ctrl+R). A CV button appears in the launch bar.
 *
 * DATA MODEL (labels; names use underscores, Trilium turns "-" into "_")
 *   #cvRoot                      root of the CV subtree (first match is used)
 *   #cvProfile                   profile note; body = profile/summary text
 *       #name #headline #location #email #phone
 *       #link="text | url | icon"   (multi-valued; icon = globe|link|code|…)
 *       #github=<user> #linkedin=<user> #orcid=<id> #researchgate=<name>
 *       ~photo -> image note
 *   #cvSection #cvKey=<key>      section; note title = section title
 *       #entryType=experience|education|normal|text|bullet|oneline
 *       #cvTitle_<lang>=<title>  translated section title
 *       #jsonResume=work|education|projects|publications|skills|…
 *       body = optional intro text shown above the entries
 *   entry notes (children of a section, in tree order)
 *       experience: #position #company #location #start #end | #date
 *       education:  #degree #area #institution #location #start #end, #title
 *                   (#title = long form shown in HTML, e.g. "Doctor of …")
 *       normal:     #name #location #start #end | #date
 *       oneline:    #name (label), body = details
 *       text/bullet: body only
 *       all: #tags=a,b  #year  #cvId=<stable id used by variants>
 *       body: paragraphs -> summary, list items -> highlights
 *   translations: a child note of a profile/section/entry with #cvTranslation=nl
 *       overrides that note's labels and (non-empty) body for lang "nl".
 *   #cvVariant                   JSON code note describing one output (see
 *                                README for the full spec)
 *   #cvTemplate=<name>           CSS code note; #cvExtends=modern appends it to
 *                                the built-in "modern" CSS instead of replacing it
 *   #cvOutput=<kind>             generated output note (written by this widget,
 *                                not read back)
 *   Dates: "YYYY", "YYYY-MM" or "YYYY-MM-DD"; #end=present for ongoing.
 *
 * GOTCHAS
 *   - RenderCV requires every entry in one section to have the same type; the
 *     section's #entryType decides, entries do not set their own type.
 *   - RenderCV validates phone numbers, URLs and dates strictly; build errors
 *     there show up when running rendercv, not in this widget.
 *   - JSON Resume has a fixed set of keys; sections without a #jsonResume
 *     mapping are skipped there, and themes decide section order.
 *   - Backend callbacks must be self-contained (no closure over module scope).
 */

import { defineLauncherWidget } from "trilium:preact";
import { runAsyncOnBackendWithManualTransactionHandling } from "trilium:api";

/* ────────────────────────────────────────────────────────────────────────────
 * Locale data (extend to add a language)
 * ────────────────────────────────────────────────────────────────────────── */

const LOCALES = {
  en: {
    rendercv: "english",
    present: "Present",
    months: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
    profile: "Profile",
    contact: "Contact",
  },
  nl: {
    rendercv: "dutch",
    present: "heden",
    months: ["jan", "feb", "mrt", "apr", "mei", "jun", "jul", "aug", "sep", "okt", "nov", "dec"],
    profile: "Profiel",
    contact: "Contact",
  },
};

// RenderCV social network names (exact spelling required by RenderCV) per
// profile label, plus the URL used for HTML / JSON Resume.
const SOCIAL = {
  github: { network: "GitHub", url: (u) => `https://github.com/${u}` },
  gitlab: { network: "GitLab", url: (u) => `https://gitlab.com/${u}` },
  linkedin: { network: "LinkedIn", url: (u) => `https://www.linkedin.com/in/${u}` },
  orcid: { network: "ORCID", url: (u) => `https://orcid.org/${u}` },
  researchgate: { network: "ResearchGate", url: (u) => `https://www.researchgate.net/profile/${u}` },
  googlescholar: { network: "Google Scholar", url: (u) => `https://scholar.google.com/citations?user=${u}` },
};

/* ────────────────────────────────────────────────────────────────────────────
 * Backend access
 * ────────────────────────────────────────────────────────────────────────── */

// Read the whole CV subtree into plain records keyed by noteId. Image notes are
// returned as base64; generated #cvOutput notes are listed but not read.
async function loadCvTree() {
  return runAsyncOnBackendWithManualTransactionHandling(async () => {
    const roots = api.searchForNotes("#cvRoot");
    if (!roots || !roots.length) return { error: "No note with the #cvRoot label found." };
    const root = roots[0];
    const notes = {};

    const visit = (note) => {
      if (notes[note.noteId]) return;
      const attrs = note.getOwnedAttributes();
      const rec = {
        noteId: note.noteId,
        title: note.title,
        type: note.type,
        mime: note.mime,
        labels: attrs.filter((a) => a.type === "label").map((a) => ({ name: a.name, value: a.value })),
        relations: attrs.filter((a) => a.type === "relation").map((a) => ({ name: a.name, target: a.value })),
        children: [],
        content: "",
      };
      notes[note.noteId] = rec;
      if (rec.labels.some((l) => l.name === "cvOutput")) return;

      let content = null;
      try { content = note.getContent(); } catch (e) { content = null; }
      if (note.type === "image") {
        rec.content = content ? Buffer.from(content).toString("base64") : "";
      } else if (content != null) {
        rec.content = typeof content === "string" ? content : Buffer.from(content).toString("utf8");
      }
      for (const child of note.getChildNotes()) {
        rec.children.push(child.noteId);
        visit(child);
      }
    };
    visit(root);

    // Relation targets outside the subtree (e.g. a photo stored elsewhere).
    for (const rec of Object.values(notes)) {
      for (const rel of rec.relations) {
        if (notes[rel.target]) continue;
        const target = api.getNote(rel.target);
        if (target) visit(target);
      }
    }
    return { rootId: root.noteId, notes };
  }, []);
}

// Create or update the generated output notes (one per kind) under the variant.
async function storeOutputs(variantNoteId, outputs) {
  return runAsyncOnBackendWithManualTransactionHandling(async (vid, outs) => {
    const variant = api.getNote(vid);
    if (!variant) return 0;
    for (const o of outs) {
      const existing = variant.getChildNotes().find((c) => c.getLabelValue("cvOutput") === o.kind);
      if (existing) {
        existing.setContent(o.content);
      } else {
        const created = await api.createNewNote({
          parentNoteId: vid, title: o.title, type: "code", mime: o.mime, content: o.content,
        });
        created.note.setLabel("cvOutput", o.kind);
      }
    }
    return outs.length;
  }, [variantNoteId, outputs]);
}

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

const splitList = (value) =>
  String(value || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

const label = (rec, name) => {
  const l = rec && rec.labels.find((x) => x.name === name);
  return l ? l.value : undefined;
};
const labelsAll = (rec, name) => (rec ? rec.labels.filter((x) => x.name === name).map((x) => x.value) : []);
const hasLabel = (rec, name) => !!(rec && rec.labels.some((x) => x.name === name));

/* ────────────────────────────────────────────────────────────────────────────
 * Body parsing: note content -> { paragraphs[], items[] } as inline markdown
 * ────────────────────────────────────────────────────────────────────────── */

const isMarkdownNote = (rec) =>
  rec.type === "markdown" || /markdown/i.test(rec.mime || "") || (rec.type === "code" && /md/.test(rec.mime || ""));

// Inline HTML -> inline markdown (links, bold, italic, code). Other tags keep
// their text only.
function inlineToMd(node) {
  let out = "";
  for (const child of node.childNodes) {
    if (child.nodeType === 3) { out += child.nodeValue.replace(/\s+/g, " "); continue; }
    if (child.nodeType !== 1) continue;
    const tag = child.tagName.toLowerCase();
    const inner = inlineToMd(child);
    if (tag === "a") out += `[${inner}](${child.getAttribute("href") || ""})`;
    else if (tag === "strong" || tag === "b") out += inner.trim() ? `**${inner}**` : inner;
    else if (tag === "em" || tag === "i") out += inner.trim() ? `*${inner}*` : inner;
    else if (tag === "code") out += `\`${inner}\``;
    else if (tag === "br") out += " ";
    else out += inner;
  }
  return out;
}

function htmlToBlocks(html) {
  const blocks = { paragraphs: [], items: [] };
  if (!html || !html.trim()) return blocks;
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
  const walk = (parent) => {
    for (const el of parent.children) {
      const tag = el.tagName.toLowerCase();
      if (tag === "ul" || tag === "ol") {
        for (const li of el.children) {
          if (li.tagName.toLowerCase() !== "li") continue;
          const text = inlineToMd(li).trim();
          if (text) blocks.items.push(text);
        }
      } else if (tag === "div" || tag === "section" || tag === "blockquote") {
        walk(el);
      } else {
        const text = inlineToMd(el).trim();
        if (text) blocks.paragraphs.push(text);
      }
    }
  };
  walk(doc.body.firstElementChild);
  return blocks;
}

function markdownToBlocks(md) {
  const blocks = { paragraphs: [], items: [] };
  let para = [];
  const flush = () => { if (para.length) blocks.paragraphs.push(para.join(" ").trim()); para = []; };
  for (const raw of String(md || "").split(/\r?\n/)) {
    const line = raw.trim();
    const item = line.match(/^(?:[-*+]|\d+[.)])\s+(.*)$/);
    if (!line) flush();
    else if (item) { flush(); blocks.items.push(item[1].trim()); }
    else para.push(line.replace(/^#+\s*/, ""));
  }
  flush();
  return blocks;
}

const bodyBlocks = (rec) =>
  rec ? (isMarkdownNote(rec) ? markdownToBlocks(rec.content) : htmlToBlocks(rec.content)) : { paragraphs: [], items: [] };

// Inline markdown -> HTML (escape first, then links, bold, italic, code).
function mdInlineToHtml(md) {
  let s = escapeHtml(md);
  s = s.replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (m, text, url) => `<a href="${url}">${text}</a>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  return s;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Model building
 * ────────────────────────────────────────────────────────────────────────── */

// Labels + body of a record for a language: a child with #cvTranslation=<lang>
// overrides individual labels and, when non-empty, the body.
function localized(db, rec, lang) {
  const labels = {};
  const multi = {};
  for (const l of rec.labels) {
    labels[l.name] = l.value;
    (multi[l.name] = multi[l.name] || []).push(l.value);
  }
  let blocks = bodyBlocks(rec);
  const tr = rec.children.map((id) => db[id]).find((c) => c && label(c, "cvTranslation") === lang);
  if (tr) {
    for (const l of tr.labels) if (l.name !== "cvTranslation") labels[l.name] = l.value;
    const trBlocks = bodyBlocks(tr);
    if (trBlocks.paragraphs.length || trBlocks.items.length) blocks = trBlocks;
  }
  return { labels, multi, blocks, title: rec.title };
}

const yearOf = (value) => {
  if (!value) return null;
  if (/^present$/i.test(value)) return new Date().getFullYear();
  const m = String(value).match(/(\d{4})/);
  return m ? Number(m[1]) : null;
};

function buildEntry(db, rec, type, lang) {
  const { labels, blocks } = localized(db, rec, lang);
  const e = {
    id: rec.noteId,
    cvId: labels.cvId || null,
    type,
    title: rec.title,
    tags: splitList(labels.tags),
    start: labels.start || null,
    end: labels.end || null,
    date: labels.date || null,
    fields: labels,
    summary: blocks.paragraphs.join(" ") || null,
    paragraphs: blocks.paragraphs,
    highlights: blocks.items,
  };
  e.year = yearOf(labels.year) || yearOf(e.end) || yearOf(e.date) || yearOf(e.start);
  return e;
}

// Normalise one section reference from the variant spec.
const sectionSpec = (ref) => (typeof ref === "string" ? { section: ref } : { ...ref });

function entryAllowed(e, spec, sec) {
  const hide = (spec.hide || []).map(String);
  if (hide.includes(e.id) || (e.cvId && hide.includes(e.cvId))) return false;
  const include = (sec.include_tags || spec.include_tags || []).map((t) => t.toLowerCase());
  const exclude = (sec.exclude_tags || spec.exclude_tags || []).map((t) => t.toLowerCase());
  if (exclude.some((t) => e.tags.includes(t))) return false;
  // Untagged entries pass an include filter unless the variant sets strict_tags.
  if (include.length && !include.some((t) => e.tags.includes(t))) {
    if (e.tags.length || spec.strict_tags) return false;
  }
  if (sec.since && e.year != null && e.year < Number(sec.since)) return false;
  if (sec.until && e.year != null && e.year > Number(sec.until)) return false;
  return true;
}

const sortKey = (e) => {
  const end = /^present$/i.test(e.end || "") ? "9999" : e.end || e.date || e.start || String(e.year || "");
  return `${end}|${e.start || ""}`;
};

// Build the output-neutral CV model for one variant spec.
function buildModel(tree, spec) {
  const db = tree.notes;
  const lang = spec.lang || "en";
  const loc = LOCALES[lang] || LOCALES.en;
  const warnings = [];
  const all = Object.values(db);

  const profileRec = all.find((r) => hasLabel(r, "cvProfile"));
  if (!profileRec) warnings.push("No #cvProfile note found.");
  const profile = profileRec ? localized(db, profileRec, lang) : { labels: {}, multi: {}, blocks: { paragraphs: [], items: [] } };

  const person = {
    name: profile.labels.name || (profileRec && profileRec.title) || "",
    headline: spec.headline || profile.labels.headline || "",
    location: profile.labels.location || "",
    email: profile.labels.email || "",
    phone: profile.labels.phone || "",
    links: (profile.multi.link || []).map((v) => {
      const [text, url, icon] = v.split("|").map((s) => s.trim());
      return { text, url: url || text, icon: icon || "globe" };
    }),
    social: Object.keys(SOCIAL)
      .filter((k) => profile.labels[k])
      .map((k) => ({ key: k, network: SOCIAL[k].network, username: profile.labels[k], url: SOCIAL[k].url(profile.labels[k]) })),
    summary: profile.blocks.paragraphs,
    photo: null,
  };
  const photoRel = profileRec && profileRec.relations.find((r) => r.name === "photo");
  if (photoRel && db[photoRel.target] && spec.photo !== false) {
    const img = db[photoRel.target];
    person.photo = { dataUrl: `data:${img.mime || "image/png"};base64,${img.content}`, filename: img.title };
  }

  const sectionsByKey = {};
  for (const r of all) if (hasLabel(r, "cvSection")) sectionsByKey[label(r, "cvKey") || r.title] = r;

  const resolve = (ref, slot) => {
    const sec = sectionSpec(ref);
    const key = sec.section;
    if (key === "profile") {
      return { key, slot, kind: "profile", title: sec.title || loc.profile, type: "text", intro: [], entries: person.summary.map((p, i) => ({ id: `profile-${i}`, type: "text", paragraphs: [p], highlights: [], fields: {}, tags: [] })) };
    }
    if (key === "contact") return { key, slot, kind: "contact", title: sec.title || loc.contact, type: "contact", intro: [], entries: [] };
    const rec = sectionsByKey[key];
    if (!rec) { warnings.push(`Section "${key}" not found (no #cvSection with #cvKey=${key}).`); return null; }
    const l = localized(db, rec, lang);
    const type = l.labels.entryType || "normal";
    let entries = rec.children
      .map((id) => db[id])
      .filter((c) => c && !hasLabel(c, "cvTranslation") && !hasLabel(c, "cvOutput") && !hasLabel(c, "cvDisabled"))
      .map((c) => buildEntry(db, c, type, lang))
      .filter((e) => entryAllowed(e, spec, sec));
    if (sec.sort === "date") entries.sort((a, b) => sortKey(b).localeCompare(sortKey(a)));
    if (sec.max) entries = entries.slice(0, Number(sec.max));
    return {
      key, slot, kind: "entries", type,
      title: sec.title || l.labels[`cvTitle_${lang}`] || rec.title,
      jsonResume: l.labels.jsonResume || null,
      intro: sec.intro === false ? [] : l.blocks.paragraphs,
      entries,
    };
  };

  const sections = [
    ...(spec.main || []).map((r) => resolve(r, "main")),
    ...(spec.sidebar || []).map((r) => resolve(r, "sidebar")),
  ].filter(Boolean);

  return { lang, loc, person, sections, warnings, spec };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Date formatting (HTML)
 * ────────────────────────────────────────────────────────────────────────── */

function fmtDate(value, loc) {
  if (!value) return "";
  if (/^present$/i.test(value)) return loc.present;
  const m = String(value).match(/^(\d{4})(?:-(\d{2}))?/);
  if (!m) return String(value);
  return m[2] ? `${loc.months[Number(m[2]) - 1]} ${m[1]}` : m[1];
}

function dateRange(e, loc) {
  if (e.date) return e.date;
  if (!e.start && !e.end) return "";
  if (e.start && (!e.end || e.end === e.start)) return fmtDate(e.start, loc);
  return `${fmtDate(e.start, loc)} – ${fmtDate(e.end, loc)}`;
}

/* ────────────────────────────────────────────────────────────────────────────
 * HTML output
 * ────────────────────────────────────────────────────────────────────────── */

// Minimal generic icons (24×24, stroke-based) drawn for this widget; no icon
// font is loaded so the HTML stays usable offline.
const ICONS = {
  location: '<path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
  phone: '<path d="M5 3h4l2 5-2.5 1.5a11 11 0 0 0 6 6L16 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 5a2 2 0 0 1 2-2z"/>',
  email: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  code: '<path d="M8 7l-5 5 5 5M16 7l5 5-5 5"/>',
  person: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
};
const SOCIAL_ICON = { github: "code", gitlab: "code", linkedin: "person", orcid: "link", researchgate: "link", googlescholar: "link" };
const icon = (name) =>
  `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ICONS.link}</svg>`;

const mdP = (text, cls = "") => `<p${cls ? ` class="${cls}"` : ""}>${mdInlineToHtml(text)}</p>`;
const mdUl = (items) => (items.length ? `<ul>${items.map((i) => `<li>${mdInlineToHtml(i)}</li>`).join("")}</ul>` : "");

function renderContact(person) {
  const rows = [];
  const row = (ic, text, url) =>
    rows.push(`<li>${icon(ic)}${url ? `<a href="${escapeHtml(url)}">${escapeHtml(text)}</a>` : escapeHtml(text)}</li>`);
  if (person.location) row("location", person.location);
  if (person.phone) row("phone", person.phone, `tel:${person.phone.replace(/\s+/g, "")}`);
  if (person.email) row("email", person.email, `mailto:${person.email}`);
  for (const l of person.links) row(ICONS[l.icon] ? l.icon : "globe", l.text, l.url);
  for (const s of person.social) row(SOCIAL_ICON[s.key] || "link", s.username, s.url);
  return `<ul class="contact">${rows.join("")}</ul>`;
}

function renderEntryMain(e, loc) {
  const f = e.fields;
  const when = dateRange(e, loc);
  const body = (e.summary ? mdP(e.summary, "summary") : "") + mdUl(e.highlights);
  switch (e.type) {
    case "experience":
    case "normal": {
      const head = e.type === "experience" ? f.position || e.title : f.name || e.title;
      const sub = [e.type === "experience" ? f.company : null, f.location].filter(Boolean).map(escapeHtml).join(" · ");
      return `<div class="entry ${e.type}"><div class="when">${escapeHtml(when)}</div><div class="what">` +
        `<div class="head">${mdInlineToHtml(head)}</div>${sub ? `<div class="sub">${sub}</div>` : ""}${body}</div></div>`;
    }
    case "education": {
      const head = f.title || [f.degree, f.area].filter(Boolean).join(" in ") || e.title;
      const sub = [f.institution, f.location].filter(Boolean).map(escapeHtml).join(" · ");
      return `<div class="entry education"><div class="when">${escapeHtml(when)}</div><div class="what">` +
        `<div class="head">${mdInlineToHtml(head)}</div>${sub ? `<div class="sub">${sub}</div>` : ""}${body}</div></div>`;
    }
    case "oneline":
      return `<div class="entry oneline"><span class="head">${mdInlineToHtml(f.name || e.title)}:</span> ${mdInlineToHtml(e.paragraphs.join(" "))}</div>`;
    case "bullet":
      return `<li class="entry bullet">${mdInlineToHtml([...e.paragraphs, ...e.highlights].join(" "))}</li>`;
    default:
      return `<div class="entry text">${e.paragraphs.map((p) => mdP(p)).join("")}${mdUl(e.highlights)}</div>`;
  }
}

// Compact layout for the sidebar: no date column, date shown inline.
function renderEntrySide(e, loc) {
  const f = e.fields;
  const when = dateRange(e, loc);
  const body = (e.summary ? mdP(e.summary, "summary") : "") + mdUl(e.highlights);
  switch (e.type) {
    case "education": {
      const head = f.title || [f.degree, f.area].filter(Boolean).join(" in ") || e.title;
      return `<div class="entry education"><div class="head">${mdInlineToHtml(head)}</div>` +
        `<div class="sub">${escapeHtml([f.institution, when].filter(Boolean).join(" · "))}</div>${body}</div>`;
    }
    case "experience":
    case "normal": {
      const head = e.type === "experience" ? f.position || e.title : f.name || e.title;
      const sub = [e.type === "experience" ? f.company : null, f.location, when].filter(Boolean).join(" · ");
      return `<div class="entry ${e.type}"><div class="head">${mdInlineToHtml(head)}</div>` +
        `${sub ? `<div class="sub">${escapeHtml(sub)}</div>` : ""}${body}</div>`;
    }
    default:
      return renderEntryMain(e, loc);
  }
}

function renderSection(sec, model) {
  const loc = model.loc;
  let inner;
  if (sec.kind === "contact") inner = renderContact(model.person);
  else {
    const render = sec.slot === "sidebar" ? renderEntrySide : renderEntryMain;
    const items = sec.entries.map((e) => render(e, loc)).join("");
    inner = sec.intro.map((p) => mdP(p, "intro")).join("") + (sec.type === "bullet" ? `<ul class="bullets">${items}</ul>` : items);
  }
  // Sections where no entry has a date drop the date column (see .no-dates CSS).
  const noDates = sec.kind === "entries" && !sec.entries.some((e) => dateRange(e, loc));
  return `<section class="cv-section s-${escapeHtml(sec.key)} t-${escapeHtml(sec.type)}${noDates ? " no-dates" : ""}"><h2>${escapeHtml(sec.title)}</h2>${inner}</section>`;
}

function renderHtml(model, css) {
  const { person, spec } = model;
  const style = spec.style || {};
  const vars = [
    style.main && `--main:${style.main}`,
    style.accent && `--accent:${style.accent}`,
    style.font && `--font:'${style.font}'`,
    style.sidebar_width && `--sidebar-width:${style.sidebar_width}`,
  ].filter(Boolean).join(";");
  const side = model.sections.filter((s) => s.slot === "sidebar");
  const main = model.sections.filter((s) => s.slot === "main");
  const photo = person.photo ? `<img class="photo" src="${person.photo.dataUrl}" alt="">` : "";
  const header = `<header class="cv-header"><h1>${escapeHtml(person.name)}</h1>` +
    (person.headline ? `<div class="headline">${escapeHtml(person.headline)}</div>` : "") + `</header>`;

  return `<!DOCTYPE html>
<html lang="${escapeHtml(model.lang)}"><head><meta charset="utf-8">
<title>${escapeHtml(person.name)} – CV</title>
<style>${css}</style>
<style>:root{${vars}}</style>
</head><body class="${side.length ? "has-sidebar" : "no-sidebar"}">
<div class="cv-bg"></div>
<table class="cv-page"><thead><tr><td><div class="page-gap"></div></td></tr></thead>
<tfoot><tr><td><div class="page-gap"></div></td></tr></tfoot>
<tbody><tr><td><div class="cv">
${side.length ? `<aside class="cv-sidebar">${photo}${side.map((s) => renderSection(s, model)).join("\n")}</aside>` : ""}
<main class="cv-main">${side.length ? "" : photo}${header}${main.map((s) => renderSection(s, model)).join("\n")}</main>
</div></td></tr></tbody></table>
</body></html>`;
}

// Built-in "modern" template: coloured sidebar, accent headings, A4 print.
// The repeated <thead>/<tfoot> spacers in renderHtml give every printed page a
// top/bottom margin while @page margin stays 0 so the fixed sidebar band runs
// edge to edge; don't switch to @page margins, that leaves white gaps in the band.
const MODERN_CSS = `
:root{--main:#274232;--accent:#157F3F;--font:'Lato';--sidebar-width:34%;--text:#222;--muted:#666;--gap:12mm}
*{box-sizing:border-box}
html{background:#e9ecef}
body{margin:0 auto;width:210mm;min-height:297mm;background:#fff;color:var(--text);
  font-family:var(--font),'Helvetica Neue',Arial,sans-serif;font-size:9.5pt;line-height:1.4;position:relative;
  -webkit-print-color-adjust:exact;print-color-adjust:exact}
.cv-bg{position:absolute;top:0;bottom:0;left:0;width:var(--sidebar-width);background:var(--main)}
.no-sidebar .cv-bg{display:none}
.cv-page{border-collapse:collapse;width:100%;position:relative}
.cv-page td{padding:0;vertical-align:top}
.page-gap{height:var(--gap)}
.cv{display:grid;grid-template-columns:var(--sidebar-width) 1fr}
.no-sidebar .cv{grid-template-columns:1fr}
.cv-sidebar{color:#f2f5f3;padding:0 7mm}
.cv-main{padding:0 10mm 0 8mm}
.no-sidebar .cv-main{padding:0 16mm}
.photo{display:block;width:38mm;height:38mm;object-fit:cover;border-radius:50%;margin:0 auto 6mm;border:3px solid rgba(255,255,255,.6)}
.cv-header h1{margin:0;font-size:24pt;font-weight:300;color:var(--main);letter-spacing:.5px}
.cv-header .headline{font-size:11pt;color:var(--accent);margin:1mm 0 4mm;text-transform:uppercase;letter-spacing:1.5px}
h2{font-size:12pt;font-weight:700;color:var(--accent);margin:5mm 0 2.5mm;padding-bottom:1mm;
  border-bottom:1px solid #ccd5cf;break-after:avoid;page-break-after:avoid}
.cv-sidebar h2{color:#fff;border-bottom-color:rgba(255,255,255,.35);font-size:11pt}
a{color:inherit;text-decoration:none}
.cv-main a{color:var(--accent)}
p{margin:0 0 1.5mm}
ul{margin:1mm 0 0;padding-left:4.5mm}
li{margin-bottom:.8mm}
.entry{break-inside:avoid;page-break-inside:avoid;margin-bottom:3mm}
.cv-main .entry.experience,.cv-main .entry.education,.cv-main .entry.normal{display:grid;grid-template-columns:24mm 1fr;column-gap:4mm}
.cv-main .no-dates .entry{display:block}
.no-dates .when{display:none}
.when{color:var(--accent);font-size:8.5pt;font-weight:700;padding-top:.5mm}
.head{font-weight:700}
.sub{color:var(--muted);font-style:italic;font-size:8.8pt;margin-bottom:1mm}
.cv-sidebar .sub{color:rgba(255,255,255,.75)}
.cv-sidebar .entry{margin-bottom:2.5mm;font-size:8.8pt}
.cv-main .entry.text p{padding-left:5mm;text-indent:-5mm}
.cv-main .s-profile .entry.text p{padding-left:0;text-indent:0}
.cv-main .intro,.cv-main .s-profile p{font-style:normal}
.intro{color:var(--muted);font-style:italic}
.cv-sidebar .intro{color:rgba(255,255,255,.8)}
.contact{list-style:none;padding:0;margin:0}
.contact li{display:flex;align-items:center;gap:2.5mm;margin-bottom:1.6mm;word-break:break-word}
.ic{width:4mm;height:4mm;flex:none;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.cv-sidebar .ic{stroke:#a9d8bb}
.bullets{padding-left:4mm}
@page{size:A4;margin:0}
@media print{html{background:none}body{margin:0;min-height:0}.cv-bg{position:fixed}}
@media screen{body{box-shadow:0 2px 12px rgba(0,0,0,.25);margin:8mm auto}}
`;

/* ────────────────────────────────────────────────────────────────────────────
 * RenderCV YAML output
 * ────────────────────────────────────────────────────────────────────────── */

// Tiny YAML emitter: block mappings/sequences, scalars as JSON strings (valid
// YAML double-quoted scalars). null/undefined/empty values are dropped.
function toYaml(value, indent = 0) {
  const pad = " ".repeat(indent);
  const scalar = (v) => (typeof v === "number" || typeof v === "boolean" ? String(v) : JSON.stringify(String(v)));
  const key = (k) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ? k : JSON.stringify(k));
  const empty = (v) => v == null || v === "" || (Array.isArray(v) && !v.length);
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (item && typeof item === "object") {
        const body = toYaml(item, indent + 2).replace(/^\s+/, "");
        return `${pad}- ${body}`;
      }
      return `${pad}- ${scalar(item)}`;
    }).join("\n");
  }
  if (value && typeof value === "object") {
    return Object.entries(value).filter(([, v]) => !empty(v)).map(([k, v]) => {
      if (v && typeof v === "object") {
        if (!Array.isArray(v) && !Object.values(v).some((x) => !empty(x))) return null;
        return `${pad}${key(k)}:\n${toYaml(v, indent + 2)}`;
      }
      return `${pad}${key(k)}: ${scalar(v)}`;
    }).filter(Boolean).join("\n");
  }
  return pad + scalar(value);
}

function rcvDates(e) {
  if (e.date) return { date: e.date };
  if (e.start && (!e.end || e.end === e.start)) return { date: e.start };
  return { start_date: e.start || undefined, end_date: e.end ? e.end.toLowerCase() : undefined };
}

function rcvEntry(e) {
  const f = e.fields;
  const summary = e.summary || undefined;
  const highlights = e.highlights.length ? e.highlights : undefined;
  switch (e.type) {
    case "experience":
      // RenderCV requires both company and position (empty values are dropped
      // by toYaml). Without a company the position takes the company slot and
      // the location moves into the position line.
      if (!f.company) {
        return { company: f.position || e.title, position: f.location || "-", ...rcvDates(e), summary, highlights };
      }
      return { company: f.company, position: f.position || e.title, location: f.location, ...rcvDates(e), summary, highlights };
    case "education":
      return { institution: f.institution || e.title, area: f.area || f.title || e.title, degree: f.degree, location: f.location, ...rcvDates(e), summary, highlights };
    case "normal":
      return { name: f.name || e.title, location: f.location, ...rcvDates(e), summary, highlights };
    case "oneline":
      return { label: f.name || e.title, details: e.paragraphs.join(" ") || e.highlights.join(", ") };
    case "bullet":
      return { bullet: [...e.paragraphs, ...e.highlights].join(" ") };
    default:
      return [...e.paragraphs, ...e.highlights.map((h) => `- ${h}`)].join("\n");
  }
}

function renderRenderCv(model) {
  const { person, spec, loc } = model;
  const rcv = spec.rendercv || {};
  const sections = {};
  for (const sec of model.sections) {
    if (sec.kind === "contact") continue; // contact goes into the header
    const items = [...sec.intro, ...sec.entries.map(rcvEntry)];
    // An intro paragraph is a text entry; it can only share a section with text entries.
    const usable = sec.type === "text" || sec.kind === "profile" ? items : sec.entries.map(rcvEntry);
    if (usable.length) sections[sec.title] = usable;
  }
  const doc = {
    cv: {
      name: person.name,
      headline: person.headline,
      location: person.location,
      email: person.email,
      phone: person.phone,
      photo: person.photo && rcv.photo !== false ? rcv.photo || person.photo.filename : undefined,
      social_networks: person.social.map((s) => ({ network: s.network, username: s.username })),
      custom_connections: person.links.map((l) => ({ fontawesome_icon: l.icon, placeholder: l.text, url: l.url })),
      sections,
    },
    design: rcv.design || { theme: "classic" },
    locale: { language: loc.rendercv, ...(rcv.locale || {}) },
  };
  if (rcv.settings) doc.settings = rcv.settings;
  return `# Generated by cv-builder (Trilium) — edit the CV notes, not this file.\n${toYaml(doc)}\n`;
}

/* ────────────────────────────────────────────────────────────────────────────
 * JSON Resume output
 * ────────────────────────────────────────────────────────────────────────── */

const mdPlain = (md) => String(md || "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*`]/g, "");
const jrDate = (v) => (v && !/^present$/i.test(v) ? String(v) : undefined);

function jrEntry(kind, e) {
  const f = e.fields;
  const text = mdPlain([...e.paragraphs, ...e.highlights].join(" "));
  const start = jrDate(e.start || e.date);
  const end = e.end && /^present$/i.test(e.end) ? undefined : jrDate(e.end);
  switch (kind) {
    case "work":
    case "volunteer":
      return { name: f.company || f.position || e.title, organization: f.company, position: f.position || e.title, location: f.location, startDate: start, endDate: end, summary: e.summary ? mdPlain(e.summary) : undefined, highlights: e.highlights.map(mdPlain) };
    case "education":
      return { institution: f.institution, area: f.area, studyType: f.title || f.degree, startDate: start, endDate: end, courses: e.highlights.map(mdPlain) };
    case "projects":
      return { name: f.company || f.name || e.title, roles: f.position ? [f.position] : undefined, description: e.summary ? mdPlain(e.summary) : undefined, highlights: e.highlights.map(mdPlain), startDate: start, endDate: end, url: f.url };
    case "publications":
      return { name: text, releaseDate: e.year ? String(e.year) : undefined, url: f.url || f.doi };
    case "certificates":
      return { name: f.name || e.title, issuer: e.summary ? mdPlain(e.summary) : undefined, date: start };
    case "awards":
      return { title: f.name || e.title, date: start, summary: text };
    case "skills":
      return e.type === "oneline" ? { name: f.name || e.title, keywords: text.split(/,\s*/) } : { name: text };
    case "interests":
    case "languages":
      return kind === "languages" ? { language: f.name || text, fluency: f.level } : { name: text };
    default:
      return null;
  }
}

function renderJsonResume(model) {
  const { person } = model;
  const out = {
    $schema: "https://raw.githubusercontent.com/jsonresume/resume-schema/v1.0.0/schema.json",
    basics: {
      name: person.name,
      label: person.headline,
      email: person.email,
      phone: person.phone,
      url: person.links[0] ? person.links[0].url : undefined,
      summary: person.summary.map(mdPlain).join("\n\n") || undefined,
      location: person.location ? { city: person.location } : undefined,
      image: person.photo ? person.photo.filename : undefined,
      profiles: [
        ...person.social.map((s) => ({ network: s.network, username: s.username, url: s.url })),
        ...person.links.slice(1).map((l) => ({ network: l.text, url: l.url })),
      ],
    },
  };
  const skipped = [];
  for (const sec of model.sections) {
    if (sec.kind !== "entries") continue;
    if (!sec.jsonResume) { skipped.push(sec.key); continue; }
    const list = (out[sec.jsonResume] = out[sec.jsonResume] || []);
    for (const e of sec.entries) {
      const item = jrEntry(sec.jsonResume, e);
      if (item) list.push(item);
    }
  }
  out.meta = { generator: "cv-builder (Trilium)", lastModified: new Date().toISOString().slice(0, 19) };
  return { json: JSON.stringify(out, (k, v) => (Array.isArray(v) && !v.length ? undefined : v), 2), skipped };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Build pipeline (pure: tree + variant id -> outputs)
 * ────────────────────────────────────────────────────────────────────────── */

function listVariants(tree) {
  return Object.values(tree.notes).filter((r) => hasLabel(r, "cvVariant")).map((r) => ({ id: r.noteId, title: r.title }));
}

function templateCss(tree, name) {
  if (!name || name === "modern") return MODERN_CSS;
  const rec = Object.values(tree.notes).find((r) => label(r, "cvTemplate") === name);
  if (!rec) return null;
  return label(rec, "cvExtends") === "modern" ? MODERN_CSS + "\n" + rec.content : rec.content;
}

function buildVariant(tree, variantId) {
  const rec = tree.notes[variantId];
  let spec;
  try {
    spec = JSON.parse(rec.content || "{}");
  } catch (error) {
    throw new Error(`Variant "${rec.title}" is not valid JSON: ${error.message}`);
  }
  const model = buildModel(tree, spec);
  let css = templateCss(tree, spec.template);
  if (css == null) {
    model.warnings.push(`Template "${spec.template}" not found; using built-in "modern".`);
    css = MODERN_CSS;
  }
  const html = renderHtml(model, css);
  const yaml = renderRenderCv(model);
  const jr = renderJsonResume(model);
  if (jr.skipped.length) model.warnings.push(`JSON Resume: no #jsonResume mapping for ${jr.skipped.join(", ")} (skipped).`);
  const base = (spec.filename || `${model.person.name}_CV_${rec.title}`).replace(/[^\w.-]+/g, "_");
  return { model, html, yaml, json: jr.json, base, title: rec.title };
}

/* ────────────────────────────────────────────────────────────────────────────
 * UI: dialog with variant picker, preview and export buttons
 * ────────────────────────────────────────────────────────────────────────── */

function download(filename, content, mime) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function openBuilder() {
  let tree;
  try {
    tree = await loadCvTree();
  } catch (error) {
    api.showError(`cv-builder: could not read the CV tree: ${error.message}`);
    return;
  }
  if (tree.error) { api.showError(tree.error); return; }
  const variants = listVariants(tree);
  if (!variants.length) { api.showError("No variant notes (#cvVariant) found under the CV root."); return; }

  const overlay = document.createElement("div");
  overlay.style.cssText =
    "position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.4);";
  const box = document.createElement("div");
  box.style.cssText =
    "background:var(--main-background-color,#fff);color:var(--main-text-color,#000);" +
    "border:1px solid var(--main-border-color,#ccc);border-radius:6px;padding:14px;" +
    "width:min(1100px,96vw);height:92vh;display:flex;flex-direction:column;gap:10px;" +
    "box-shadow:0 8px 30px rgba(0,0,0,0.35);font-size:0.95em;";

  const bar = document.createElement("div");
  bar.style.cssText = "display:flex;gap:8px;align-items:center;flex-wrap:wrap;";
  const titleEl = document.createElement("strong");
  titleEl.textContent = "Build CV";
  const select = document.createElement("select");
  select.className = "form-control form-control-sm";
  select.style.cssText = "width:auto;min-width:220px;";
  for (const v of variants) {
    const o = document.createElement("option");
    o.value = v.id;
    o.textContent = v.title;
    select.append(o);
  }
  const mkButton = (text, primary) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = text;
    b.className = "btn btn-sm " + (primary ? "btn-primary" : "btn-secondary");
    return b;
  };
  const reloadBtn = mkButton("Reload notes", false);
  const printBtn = mkButton("Print / PDF", true);
  const htmlBtn = mkButton("Save HTML", false);
  const yamlBtn = mkButton("Save RenderCV YAML", false);
  const jsonBtn = mkButton("Save JSON Resume", false);
  const storeBtn = mkButton("Store as notes", false);
  const closeBtn = mkButton("Close", false);
  storeBtn.title = "Write the HTML / YAML / JSON as child notes of the variant";
  const spacer = document.createElement("span");
  spacer.style.flex = "1";
  bar.append(titleEl, select, reloadBtn, spacer, printBtn, htmlBtn, yamlBtn, jsonBtn, storeBtn, closeBtn);

  const warn = document.createElement("div");
  warn.style.cssText = "font-size:0.85em;color:var(--muted-text-color,#a60);white-space:pre-line;";
  const frame = document.createElement("iframe");
  frame.style.cssText = "flex:1;width:100%;border:1px solid var(--main-border-color,#ccc);border-radius:4px;background:#e9ecef;";

  box.append(bar, warn, frame);
  overlay.append(box);
  document.body.append(overlay);

  let current = null;
  const rebuild = () => {
    try {
      current = buildVariant(tree, select.value);
      frame.srcdoc = current.html;
      warn.textContent = current.model.warnings.join("\n");
    } catch (error) {
      current = null;
      frame.srcdoc = "";
      warn.textContent = error.message;
    }
  };
  rebuild();

  const close = () => {
    document.removeEventListener("keydown", onKey, true);
    overlay.remove();
  };
  const onKey = (event) => { if (event.key === "Escape") { event.preventDefault(); close(); } };
  document.addEventListener("keydown", onKey, true);

  select.addEventListener("change", rebuild);
  closeBtn.addEventListener("click", close);
  reloadBtn.addEventListener("click", async () => {
    try {
      const fresh = await loadCvTree();
      if (fresh.error) throw new Error(fresh.error);
      tree = fresh;
      rebuild();
    } catch (error) {
      api.showError(error.message);
    }
  });
  printBtn.addEventListener("click", () => { if (current) frame.contentWindow.print(); });
  htmlBtn.addEventListener("click", () => { if (current) download(`${current.base}.html`, current.html, "text/html"); });
  yamlBtn.addEventListener("click", () => { if (current) download(`${current.base}.yaml`, current.yaml, "text/yaml"); });
  jsonBtn.addEventListener("click", () => { if (current) download(`${current.base}.json`, current.json, "application/json"); });
  storeBtn.addEventListener("click", async () => {
    if (!current) return;
    try {
      await storeOutputs(select.value, [
        { kind: "html", title: `${current.title}.html`, mime: "text/html", content: current.html },
        { kind: "yaml", title: `${current.title}.yaml`, mime: "text/x-yaml", content: current.yaml },
        { kind: "jsonresume", title: `${current.title}.json`, mime: "application/json", content: current.json },
      ]);
      api.showMessage(`Stored outputs under "${current.title}".`);
    } catch (error) {
      api.showError(`Storing outputs failed: ${error.message}`);
    }
  });
}

/* ────────────────────────────────────────────────────────────────────────────
 * Launch-bar widget
 * ────────────────────────────────────────────────────────────────────────── */

export default defineLauncherWidget({
  render: () => (
    <button
      type="button"
      class="bx bx-id-card"
      title="Build a CV variant (HTML / PDF / RenderCV / JSON Resume)"
      onClick={() => openBuilder()}
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
  ),
});
