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
 * DELIVERY (widget, plain JS — no JSX)
 *   1. Create a code note of type "JS frontend" and paste this whole file in.
 *   2. Add the label #widget to that note.
 *   3. Reload Trilium (Ctrl+R). On first load a "CV" tree with example content
 *      and three templates is created under this script note (see "First-run
 *      setup"). Open that note: it shows a "Build CV…" button at the top.
 *
 * DATA MODEL (labels; names use underscores, Trilium turns "-" into "_")
 *   #cvRoot                      root of the CV subtree (first match is used)
 *       #cvOutputDir=<folder>    optional: Save buttons write here directly
 *                                (backend file system, "~" = home) instead of
 *                                opening a save dialog
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
 *   text variants: child notes of a profile/section/entry labelled
 *       #cvTranslation=<lang> and/or #cvFocus=<name> override that note's labels
 *       and (non-empty) body; picked by the variant's "lang" and "focus".
 *   #cvLang=<lang> on the root   language of the base text (default "en")
 *   #cvVariant                   JSON code note describing one output (see
 *                                README for the full spec)
 *   #cvTemplate=<name>           CSS code note; #cvExtends=<other> puts it on top
 *                                of another template's CSS
 *   #pubType=<zotero type>       publication type (journalArticle, book, …) used
 *                                by "groups" in a variant
 *   #zoteroId=<citation key>     set by the Zotero import; marks a note as
 *                                imported (see "Zotero CSL-JSON import")
 *   #cvSort=date                 on a section: newest first by default
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

// Publication types (#pubType on entries) as used by Zotero, in Zotero's order,
// with plural headings for grouped publication lists. Values on notes may also
// be written as "journal article", "journal_article", etc.
const PUB_TYPES = {
  book: { en: "Books", nl: "Boeken" },
  bookSection: { en: "Book sections", nl: "Boekhoofdstukken" },
  computerProgram: { en: "Software", nl: "Software" },
  journalArticle: { en: "Journal articles", nl: "Tijdschriftartikelen" },
  conferencePaper: { en: "Conference papers", nl: "Conferentiebijdragen" },
  document: { en: "Documents", nl: "Documenten" },
  map: { en: "Maps", nl: "Kaarten" },
  presentation: { en: "Presentations", nl: "Presentaties" },
  report: { en: "Reports", nl: "Rapporten" },
  videoRecording: { en: "Video recordings", nl: "Video-opnamen" },
  webpage: { en: "Web pages", nl: "Webpagina's" },
  dataset: { en: "Datasets", nl: "Datasets" },
  thesis: { en: "Theses", nl: "Scripties en proefschriften" },
  magazineArticle: { en: "Magazine articles", nl: "Tijdschriftartikelen (populair)" },
  newspaperArticle: { en: "Newspaper articles", nl: "Krantenartikelen" },
  blogPost: { en: "Blog posts", nl: "Blogberichten" },
  preprint: { en: "Preprints", nl: "Preprints" },
  manuscript: { en: "Manuscripts", nl: "Manuscripten" },
};
const PUB_TYPE_IDS = Object.keys(PUB_TYPES);
const normPubType = (v) => {
  const k = String(v || "").replace(/[\s_-]+/g, "").toLowerCase();
  return PUB_TYPE_IDS.find((id) => id.toLowerCase() === k) || (k ? k : null);
};

/* ────────────────────────────────────────────────────────────────────────────
 * Backend access
 * ────────────────────────────────────────────────────────────────────────── */

// Read the whole CV subtree into plain records keyed by noteId. Image notes are
// returned as base64; generated #cvOutput notes are listed but not read.
async function loadCvTree() {
  return api.runAsyncOnBackendWithManualTransactionHandling(async () => {
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
  return api.runAsyncOnBackendWithManualTransactionHandling(async (vid, outs) => {
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
    if (child.nodeType === 3) { out += child.nodeValue.replace(/\s+/g, " ").replace(/([*`[\]\\])/g, "\\$1"); continue; }
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
// Backslash escapes (\* \[ \] \` \\) are kept literal via private-use placeholders.
const MD_ESC = { "*": "\uE000", "[": "\uE001", "]": "\uE002", "`": "\uE003", "\\": "\uE004" };
const MD_UNESC = Object.fromEntries(Object.entries(MD_ESC).map(([k, v]) => [v, k]));

function mdInlineToHtml(md) {
  let s = escapeHtml(String(md ?? "").replace(/\\([*`[\]\\])/g, (m, c) => MD_ESC[c]));
  s = s.replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (m, text, url) => `<a href="${url}">${text}</a>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  return s.replace(/[\uE000-\uE004]/g, (c) => MD_UNESC[c]);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Model building
 * ────────────────────────────────────────────────────────────────────────── */

// Text variants. Any profile, section or entry note may have child notes that
// hold alternative text for it:
//   #cvTranslation=<lang>                   same text in another language
//   #cvFocus=<name>                         different wording/emphasis
//   #cvFocus=<name> #cvTranslation=<lang>   that emphasis in another language
// ctx = { lang, baseLang, focus: [names in priority order], warn(msg) }.
// Resolution: labels and body are layered base -> plain translation for lang ->
// best focus child. The focus child is the first of ctx.focus that exists in
// lang, else in baseLang (with a warning). Labels override one by one; a body
// only replaces the one below it when it is non-empty.
const isTextVariant = (rec) => hasLabel(rec, "cvTranslation") || hasLabel(rec, "cvFocus");

function localized(db, rec, ctx) {
  const labels = {};
  const multi = {};
  let blocks = bodyBlocks(rec);
  const layer = (src, replaceMulti) => {
    const seen = new Set();
    for (const l of src.labels) {
      if (l.name === "cvTranslation" || l.name === "cvFocus") continue;
      labels[l.name] = l.value;
      if (replaceMulti && !seen.has(l.name)) { multi[l.name] = []; seen.add(l.name); }
      (multi[l.name] = multi[l.name] || []).push(l.value);
    }
    const b = bodyBlocks(src);
    if (b.paragraphs.length || b.items.length) blocks = b;
  };
  for (const l of rec.labels) {
    labels[l.name] = l.value;
    (multi[l.name] = multi[l.name] || []).push(l.value);
  }

  const kids = rec.children.map((id) => db[id]).filter((c) => c && isTextVariant(c));
  const langOf = (c) => label(c, "cvTranslation") || ctx.baseLang;
  const focusOf = (c) => label(c, "cvFocus") || null;

  if (ctx.lang !== ctx.baseLang) {
    const tr = kids.find((c) => !focusOf(c) && langOf(c) === ctx.lang);
    if (tr) layer(tr, true);
  }
  for (const f of ctx.focus) {
    const hit = kids.find((c) => focusOf(c) === f && langOf(c) === ctx.lang) ||
      kids.find((c) => focusOf(c) === f && langOf(c) === ctx.baseLang);
    if (hit) {
      if (langOf(hit) !== ctx.lang) ctx.warn(`"${rec.title}": focus "${f}" has no ${ctx.lang} text; using ${ctx.baseLang}.`);
      layer(hit, true);
      break;
    }
  }
  return { labels, multi, blocks, title: rec.title };
}

const yearOf = (value) => {
  if (!value) return null;
  if (/^present$/i.test(value)) return new Date().getFullYear();
  const m = String(value).match(/(\d{4})/);
  return m ? Number(m[1]) : null;
};

function buildEntry(db, rec, type, ctx) {
  const { labels, blocks } = localized(db, rec, ctx);
  const e = {
    id: rec.noteId,
    cvId: labels.cvId || null,
    type,
    title: rec.title,
    tags: splitList(labels.tags),
    pubType: normPubType(labels.pubType),
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

// A title in a variant may be a string or an object keyed by language.
const pickTitle = (t, lang) => (t && typeof t === "object" ? t[lang] || t.en || Object.values(t)[0] : t);

// Split a section's entries into subsections by #pubType.
//   groups = "by_type"  -> one group per type present, Zotero order
//   groups = [ { title, types: [...] | "*", since, until, max, sort }, ... ]
// "*" collects entries not claimed by an earlier group. Each entry lands in the
// first group that claims it; entries matched by no group are left out.
function groupEntries(entries, groups, spec, lang, warnings, key) {
  const heading = (t) => (PUB_TYPES[t] ? PUB_TYPES[t][lang] || PUB_TYPES[t].en : t || "Other");
  let defs = groups;
  if (groups === "by_type") {
    const present = new Set(entries.map((e) => e.pubType || ""));
    defs = [...PUB_TYPE_IDS, ...[...present].filter((t) => !PUB_TYPES[t])]
      .filter((t) => present.has(t))
      .map((t) => ({ title: heading(t), types: [t || ""] }));
  }
  if (!Array.isArray(defs)) { warnings.push(`Section "${key}": "groups" must be "by_type" or a list.`); return null; }
  const claimed = new Set();
  const out = [];
  for (const g of defs) {
    const types = g.types === "*" ? null : (Array.isArray(g.types) ? g.types : [g.types]).map(normPubType);
    for (const t of types || []) if (t && !PUB_TYPES[t]) warnings.push(`Section "${key}": unknown publication type "${t}".`);
    let list = entries.filter((e) => !claimed.has(e.id) && (types === null || types.includes(e.pubType || "")));
    list.forEach((e) => claimed.add(e.id));
    list = list.filter((e) => entryAllowed(e, spec, g));
    if (g.sort === "date") list.sort((a, b) => sortKey(b).localeCompare(sortKey(a)));
    if (g.max) list = list.slice(0, Number(g.max));
    const title = pickTitle(g.title, lang) || (types && types.length === 1 ? heading(types[0]) : "");
    if (list.length) out.push({ title, entries: list });
  }
  const unplaced = entries.filter((e) => !claimed.has(e.id)).length;
  if (unplaced) warnings.push(`Section "${key}": ${unplaced} entr${unplaced === 1 ? "y" : "ies"} not in any group (add a group with "types": "*" to include them).`);
  return out;
}

// Build the output-neutral CV model for one variant spec.
function buildModel(tree, spec) {
  const db = tree.notes;
  const lang = spec.lang || "en";
  const loc = LOCALES[lang] || LOCALES.en;
  const warnings = [];
  const all = Object.values(db);
  const rootRec = db[tree.rootId];
  const asList = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]).map(String);
  const ctxFor = (focus) => ({
    lang,
    baseLang: (rootRec && label(rootRec, "cvLang")) || "en",
    focus: asList(focus),
    warn: (m) => { if (!warnings.includes(m)) warnings.push(m); },
  });
  const ctx = ctxFor(spec.focus);

  const profileRec = all.find((r) => hasLabel(r, "cvProfile"));
  if (!profileRec) warnings.push("No #cvProfile note found.");
  const profile = profileRec ? localized(db, profileRec, spec.profile_focus != null ? ctxFor(spec.profile_focus) : ctx) : { labels: {}, multi: {}, blocks: { paragraphs: [], items: [] } };

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
      return { key, slot, kind: "profile", title: pickTitle(sec.title, lang) || loc.profile, type: "text", intro: [], entries: person.summary.map((p, i) => ({ id: `profile-${i}`, type: "text", paragraphs: [p], highlights: [], fields: {}, tags: [] })) };
    }
    if (key === "contact") return { key, slot, kind: "contact", title: pickTitle(sec.title, lang) || loc.contact, type: "contact", intro: [], entries: [] };
    const rec = sectionsByKey[key];
    if (!rec) { warnings.push(`Section "${key}" not found (no #cvSection with #cvKey=${key}).`); return null; }
    const sctx = sec.focus != null ? ctxFor(sec.focus) : ctx;
    const l = localized(db, rec, sctx);
    const type = l.labels.entryType || "normal";
    let entries = rec.children
      .map((id) => db[id])
      .filter((c) => c && !isTextVariant(c) && !hasLabel(c, "cvOutput") && !hasLabel(c, "cvDisabled"))
      .map((c) => buildEntry(db, c, type, sctx))
      .filter((e) => entryAllowed(e, spec, sec));
    if ((sec.sort || l.labels.cvSort) === "date") entries.sort((a, b) => sortKey(b).localeCompare(sortKey(a)));
    if (sec.max) entries = entries.slice(0, Number(sec.max));
    const groups = sec.groups ? groupEntries(entries, sec.groups, spec, lang, warnings, key) : null;
    if (groups) entries = groups.flatMap((g) => g.entries);
    return {
      key, slot, kind: "entries", type,
      title: pickTitle(sec.title, lang) || l.labels[`cvTitle_${lang}`] || rec.title,
      jsonResume: l.labels.jsonResume || null,
      intro: sec.intro === false ? [] : l.blocks.paragraphs,
      entries,
      groups,
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
// Brand glyphs (filled, 24×24) from Simple Icons, CC0-1.0 (LinkedIn taken from
// simple-icons 9.x; later releases dropped it at LinkedIn's request).
const BRAND_ICONS = {
  linkedin: "M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z",
  github: "M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12",
  gitlab: "m23.6004 9.5927-.0337-.0862L20.3.9814a.851.851 0 0 0-.3362-.405.8748.8748 0 0 0-.9997.0539.8748.8748 0 0 0-.29.4399l-2.2055 6.748H7.5375l-2.2057-6.748a.8573.8573 0 0 0-.29-.4412.8748.8748 0 0 0-.9997-.0537.8585.8585 0 0 0-.3362.4049L.4332 9.5015l-.0325.0862a6.0657 6.0657 0 0 0 2.0119 7.0105l.0113.0087.03.0213 4.976 3.7264 2.462 1.8633 1.4995 1.1321a1.0085 1.0085 0 0 0 1.2197 0l1.4995-1.1321 2.4619-1.8633 5.006-3.7489.0125-.01a6.0682 6.0682 0 0 0 2.0094-7.003z",
  orcid: "M12 0C5.372 0 0 5.372 0 12s5.372 12 12 12 12-5.372 12-12S18.628 0 12 0zM7.369 4.378c.525 0 .947.431.947.947s-.422.947-.947.947a.95.95 0 0 1-.947-.947c0-.525.422-.947.947-.947zm-.722 3.038h1.444v10.041H6.647V7.416zm3.562 0h3.9c3.712 0 5.344 2.653 5.344 5.025 0 2.578-2.016 5.025-5.325 5.025h-3.919V7.416zm1.444 1.303v7.444h2.297c3.272 0 4.022-2.484 4.022-3.722 0-2.016-1.284-3.722-4.097-3.722h-2.222z",
  researchgate: "M19.586 0c-.818 0-1.508.19-2.073.565-.563.377-.97.936-1.213 1.68a3.193 3.193 0 0 0-.112.437 8.365 8.365 0 0 0-.078.53 9 9 0 0 0-.05.727c-.01.282-.013.621-.013 1.016a31.121 31.123 0 0 0 .014 1.017 9 9 0 0 0 .05.727 7.946 7.946 0 0 0 .077.53h-.005a3.334 3.334 0 0 0 .113.438c.245.743.65 1.303 1.214 1.68.565.376 1.256.564 2.075.564.8 0 1.536-.213 2.105-.603.57-.39.94-.916 1.175-1.65.076-.235.135-.558.177-.93a10.9 10.9 0 0 0 .043-1.207v-.82c0-.095-.047-.142-.14-.142h-3.064c-.094 0-.14.047-.14.141v.956c0 .094.046.14.14.14h1.666c.056 0 .084.03.084.086 0 .36 0 .62-.036.865-.038.244-.1.447-.147.606-.108.385-.348.664-.638.876-.29.212-.738.35-1.227.35-.545 0-.901-.15-1.21-.353-.306-.203-.517-.454-.67-.915a3.136 3.136 0 0 1-.147-.762 17.366 17.367 0 0 1-.034-.656c-.01-.26-.014-.572-.014-.939a26.401 26.403 0 0 1 .014-.938 15.821 15.822 0 0 1 .035-.656 3.19 3.19 0 0 1 .148-.76 1.89 1.89 0 0 1 .742-1.01c.344-.244.593-.352 1.137-.352.508 0 .815.096 1.144.303.33.207.528.492.764.925.047.094.111.118.198.07l1.044-.43c.075-.048.09-.115.042-.199a3.549 3.549 0 0 0-.466-.742 3 3 0 0 0-.679-.607 3.313 3.313 0 0 0-.903-.41A4.068 4.068 0 0 0 19.586 0zM8.217 5.836c-1.69 0-3.036.086-4.297.086-1.146 0-2.291 0-3.007-.029v.831l1.088.2c.744.144 1.174.488 1.174 2.264v11.288c0 1.777-.43 2.12-1.174 2.263l-1.088.2v.832c.773-.029 2.12-.086 3.465-.086 1.29 0 2.951.057 3.667.086v-.831l-1.49-.2c-.773-.115-1.174-.487-1.174-2.264v-4.784c.688.057 1.29.057 2.206.057 1.748 3.123 3.41 5.472 4.355 6.56.86 1.032 2.177 1.691 3.839 1.691.487 0 1.003-.086 1.318-.23v-.744c-1.031 0-2.063-.716-2.808-1.518-1.26-1.376-2.95-3.582-4.355-6.074 2.32-.545 4.04-2.722 4.04-4.9 0-3.208-2.492-4.698-5.758-4.698zm-.515 1.29c2.406 0 3.839 1.26 3.839 3.552 0 2.263-1.547 3.782-4.097 3.782-.974 0-1.404-.03-2.063-.086v-7.19c.66-.059 1.547-.059 2.32-.059z",
  googlescholar: "M5.242 13.769L0 9.5 12 0l12 9.5-5.242 4.269C17.548 11.249 14.978 9.5 12 9.5c-2.977 0-5.548 1.748-6.758 4.269zM12 10a7 7 0 1 0 0 14 7 7 0 0 0 0-14z",
};
const icon = (name) =>
  BRAND_ICONS[name]
    ? `<svg class="ic brand" viewBox="0 0 24 24" aria-hidden="true"><path d="${BRAND_ICONS[name]}"/></svg>`
    : `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ICONS.link}</svg>`;

const mdP = (text, cls = "") => `<p${cls ? ` class="${cls}"` : ""}>${mdInlineToHtml(text)}</p>`;
const mdUl = (items) => (items.length ? `<ul>${items.map((i) => `<li>${mdInlineToHtml(i)}</li>`).join("")}</ul>` : "");

function renderContact(person) {
  const rows = [];
  const row = (ic, text, url) =>
    rows.push(`<li>${icon(ic)}${url ? `<a href="${escapeHtml(url)}">${escapeHtml(text)}</a>` : escapeHtml(text)}</li>`);
  if (person.location) row("location", person.location);
  if (person.phone) row("phone", person.phone, `tel:${person.phone.replace(/\s+/g, "")}`);
  if (person.email) row("email", person.email, `mailto:${person.email}`);
  for (const l of person.links) row(ICONS[l.icon] || BRAND_ICONS[l.icon] ? l.icon : "globe", l.text, l.url);
  for (const s of person.social) row(s.key, s.username, s.url);
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

// Wrap occurrences of the variant's "highlight" strings (e.g. your own name in
// author lists) in <strong>, in text only (never inside tags/attributes).
function highlightHtml(html, terms) {
  if (!terms || !terms.length) return html;
  const re = new RegExp(
    [...terms].sort((a, b) => b.length - a.length).map((t) => escapeHtml(t).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
    "g",
  );
  return html.split(/(<[^>]+>)/).map((part) => (part.startsWith("<") ? part : part.replace(re, "<strong>$&</strong>"))).join("");
}

function renderSection(sec, model) {
  const loc = model.loc;
  let inner;
  if (sec.kind === "contact") inner = renderContact(model.person);
  else {
    const render = sec.slot === "sidebar" ? renderEntrySide : renderEntryMain;
    const list = (entries) => {
      const items = entries.map((e) => render(e, loc)).join("");
      return sec.type === "bullet" ? `<ul class="bullets">${items}</ul>` : items;
    };
    const body = sec.groups
      ? sec.groups.map((g) => `<div class="cv-group">${g.title ? `<h3>${escapeHtml(g.title)}</h3>` : ""}${list(g.entries)}</div>`).join("")
      : list(sec.entries);
    inner = sec.intro.map((p) => mdP(p, "intro")).join("") + highlightHtml(body, model.spec.highlight);
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
    // Intro paragraphs and group headings become text entries, which RenderCV
    // only allows in sections made of text entries. Other section types get
    // one RenderCV section per group instead ("Title – Group").
    const textual = sec.type === "text" || sec.kind === "profile";
    const splitGroups = sec.groups && (!textual || rcv.groups === "sections");
    if (splitGroups) {
      if (textual && sec.intro.length) sections[sec.title] = [...sec.intro];
      for (const g of sec.groups) sections[g.title ? `${sec.title} – ${g.title}` : sec.title] = g.entries.map(rcvEntry);
      continue;
    }
    const body = sec.groups
      ? sec.groups.flatMap((g) => [...(g.title ? [`**${g.title}**`] : []), ...g.entries.map(rcvEntry)])
      : sec.entries.map(rcvEntry);
    const usable = textual ? [...sec.intro, ...body] : body;
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
  const settings = { ...(rcv.settings || {}) };
  if (spec.highlight && spec.highlight.length && !settings.bold_keywords) settings.bold_keywords = spec.highlight;
  if (Object.keys(settings).length) doc.settings = settings;
  return `# Generated by cv-builder (Trilium) — edit the CV notes, not this file.\n${toYaml(doc)}\n`;
}

/* ────────────────────────────────────────────────────────────────────────────
 * JSON Resume output
 * ────────────────────────────────────────────────────────────────────────── */

const mdPlain = (md) => String(md || "")
  .replace(/\\([*`[\]\\])/g, (m, c) => MD_ESC[c])
  .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*`]/g, "")
  .replace(/[\uE000-\uE004]/g, (c) => MD_UNESC[c]);
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
      return { name: f.pubTitle || text, publisher: f.publisher, releaseDate: f.date || (e.year ? String(e.year) : undefined), url: f.url, summary: f.pubTitle ? text : undefined };
    case "certificates":
      return { name: f.name || e.title, issuer: e.summary ? mdPlain(e.summary) : undefined, date: start };
    case "awards":
      return { title: f.name || e.title, date: start, summary: text };
    case "skills":
      return e.type === "oneline" ? { name: f.name || e.title, keywords: text.split(/,\s*/) } : { name: text };
    case "interests":
    case "languages":
      return kind === "languages" ? { language: f.name || text, fluency: f.level || (f.name ? text : undefined) } : { name: text };
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
 * Zotero CSL-JSON import
 *
 * Zotero: right-click a library/collection -> Export -> "CSL JSON". Each item
 * becomes (or updates) a publication note under the #cvKey=publications
 * section. Items are matched on the CSL "id" (the citation key), stored as
 * #zoteroId. On re-import: matched notes get new title/body/import labels;
 * labels the importer doesn't own (#tags, #cvDisabled, …) and child notes
 * (translations, focus variants) are kept; imported notes whose key is no
 * longer in the file are deleted; non-imported notes are deleted only when the
 * user ticks the option in the confirm dialog.
 * Citations are formatted APA-like here (no citeproc available offline).
 * ────────────────────────────────────────────────────────────────────────── */

// CSL item type -> Zotero item type (#pubType).
const CSL_TYPES = {
  book: "book", chapter: "bookSection", software: "computerProgram", "article-journal": "journalArticle",
  "paper-conference": "conferencePaper", document: "document", map: "map", speech: "presentation",
  report: "report", motion_picture: "videoRecording", broadcast: "videoRecording", webpage: "webpage",
  dataset: "dataset", thesis: "thesis", "article-magazine": "magazineArticle",
  "article-newspaper": "newspaperArticle", "post-weblog": "blogPost", post: "blogPost", article: "preprint",
  manuscript: "manuscript",
};

// Labels written by the importer; on re-import these are reset, all others kept.
const IMPORT_LABELS = ["zoteroId", "pubType", "cslType", "year", "date", "url", "pubTitle", "publisher"];

const MONTHS_EN = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function cslDateParts(d) {
  const parts = d && d["date-parts"] && d["date-parts"][0];
  if (!parts || !parts.length || !parts[0]) return null;
  return parts.map((x) => Number(x));
}

// "Vries, J. de" (dropping particle) / "de Vries, J." (non-dropping) per CSL rules.
function cslName(n) {
  if (n.literal) return n.literal;
  // "J-P.B." -> "J.-P. B.": split after dots too, then initial per hyphen part.
  const initials = String(n.given || "")
    .replace(/\./g, ". ").split(/\s+/).filter(Boolean)
    .map((w) => (/^\p{L}\.$/u.test(w) ? w : w.split("-").map((x) => (x ? x[0] + "." : "")).join("-")))
    .join(" ");
  const family = [n["non-dropping-particle"], n.family].filter(Boolean).join(" ");
  const tail = [initials, n["dropping-particle"]].filter(Boolean).join(" ");
  return tail ? `${family}, ${tail}` : family;
}

function cslNames(list) {
  const names = (list || []).map(cslName).filter(Boolean);
  if (names.length <= 1) return names.join("");
  if (names.length > 20) return `${names.slice(0, 19).join(", ")}, … ${names[names.length - 1]}`;
  return `${names.slice(0, -1).join(", ")}, & ${names[names.length - 1]}`;
}

// Escape characters that the markdown-ish inline parser would treat as markup.
const mdText = (t) => String(t || "").replace(/([*`[\]])/g, "\\$1").trim();

function cslCitation(it) {
  const type = it.type;
  const parts = cslDateParts(it.issued);
  const withDay = ["speech", "webpage", "post-weblog", "article-newspaper", "article-magazine", "motion_picture", "broadcast"].includes(type);
  const date = !parts ? "n.d." : withDay && parts.length >= 2
    ? `${parts[0]}, ${MONTHS_EN[parts[1] - 1]}${parts[2] ? " " + parts[2] : ""}`
    : String(parts[0]);
  const creators = it.author && it.author.length ? it.author : it.director || it.editor || [];
  const authorStr = cslNames(creators) + (!it.author && it.editor && !it.director ? " (Ed.)" : "");
  const title = mdText(it.title).replace(/\.$/, "");
  const italicTitle = !["article-journal", "chapter", "paper-conference", "article-magazine", "article-newspaper", "entry-encyclopedia", "entry-dictionary"].includes(type);

  const bracket = {
    software: it.medium || "Computer software", speech: it.genre || "Presentation", dataset: "Data set",
    map: it.genre || "Map", motion_picture: "Video", thesis: [it.genre, "thesis"].filter(Boolean).join(" "),
  }[type];
  const extras = [
    it.version ? `Version ${it.version}` : null,
    it.edition && Number(it.edition) > 1 ? `${it.edition} ed.` : null,
    type === "report" && (it["collection-title"] || it.genre || it.number)
      ? [it["collection-title"], it.number || it.genre].filter(Boolean).join(" ") : null,
    type === "book" && it.volume ? `Vol. ${it.volume}` : null,
  ].filter(Boolean);
  let titlePart = italicTitle ? `*${title}*` : title;
  if (extras.length) titlePart += ` (${extras.map(mdText).join("; ")})`;
  if (bracket) titlePart += ` [${mdText(bracket)}]`;

  let source = "";
  const container = mdText(it["container-title"]);
  const publisher = mdText(it.publisher);
  if (type === "article-journal" || type === "article-magazine" || type === "article-newspaper") {
    source = [container ? `*${container}*` : "", it.volume ? `*${mdText(it.volume)}*${it.issue ? `(${mdText(it.issue)})` : ""}` : "", mdText(it.page)]
      .filter(Boolean).join(", ");
  } else if (type === "chapter" || (type === "paper-conference" && container)) {
    const eds = it.editor && it.editor.length ? `${cslNames(it.editor).replace(/^(.*)$/, "$1")} (Ed${it.editor.length > 1 ? "s" : ""}.), ` : "";
    source = `In ${eds}${container ? `*${container}*` : ""}${it.page ? ` (pp. ${mdText(it.page)})` : ""}${publisher ? `. ${publisher}` : ""}`;
  } else if (type === "paper-conference" || type === "speech") {
    source = [mdText(it["event-title"]), mdText(it["event-place"] || it["publisher-place"])].filter(Boolean).join(", ");
  } else if (type === "thesis") {
    titlePart = titlePart.replace(/\]$/, publisher ? `, ${publisher}]` : "]");
  } else if (type === "webpage") {
    source = container;
  } else {
    source = publisher;
  }

  const link = it.DOI ? `https://doi.org/${String(it.DOI).replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")}` : it.URL || "";
  const linkText = link.length > 70 ? `${link.replace(/^https?:\/\//, "").split("/")[0]}/…` : link;
  const head = authorStr ? `${authorStr} (${date}). ${titlePart}.` : `${titlePart}. (${date}).`;
  return [head, source ? `${source.replace(/\.$/, "")}.` : "", link ? `[${linkText}](${link})` : ""].filter(Boolean).join(" ");
}

// CSL-JSON (array or {items:[…]}) -> items for syncPublications().
function cslToItems(json) {
  const list = Array.isArray(json) ? json : json && Array.isArray(json.items) ? json.items : null;
  if (!list) throw new Error("Not a CSL-JSON file (expected a list of items).");
  return list.filter((it) => it && it.id != null).map((it) => {
    const parts = cslDateParts(it.issued);
    const year = parts ? String(parts[0]) : "";
    const iso = parts ? parts.slice(0, 3).map((x, i) => (i ? String(x).padStart(2, "0") : String(x))).join("-") : "";
    const shortTitle = String(it["title-short"] || it.title || "(untitled)");
    const citation = cslCitation(it);
    return {
      key: String(it.id),
      title: `${shortTitle.length > 80 ? shortTitle.slice(0, 77) + "…" : shortTitle}${year ? ` (${year})` : ""}`,
      content: `<p>${mdInlineToHtml(citation)}</p>`,
      labels: {
        zoteroId: String(it.id),
        pubType: CSL_TYPES[it.type] || it.type,
        cslType: it.type,
        year,
        date: iso,
        url: it.DOI ? `https://doi.org/${String(it.DOI).replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")}` : it.URL || "",
        pubTitle: it.title || "",
        publisher: it.publisher || it["container-title"] || "",
      },
    };
  });
}

// Backend: compare (dryRun) or apply the import to the publications section.
async function syncPublications(payload) {
  return api.runAsyncOnBackendWithManualTransactionHandling(async (p) => {
    const sec = api.searchForNotes("#cvSection #cvKey=publications")[0];
    if (!sec) return { error: "No publications section (#cvSection #cvKey=publications) found." };
    const isVariantText = (c) => c.hasLabel("cvTranslation") || c.hasLabel("cvFocus");
    const kids = sec.getChildNotes().filter((c) => !isVariantText(c));
    const byKey = new Map(kids.filter((c) => c.hasLabel("zoteroId")).map((c) => [c.getLabelValue("zoteroId"), c]));
    const incoming = new Set(p.items.map((i) => i.key));
    const manual = kids.filter((c) => !c.hasLabel("zoteroId"));
    const stale = [...byKey.entries()].filter(([k]) => !incoming.has(k)).map(([, c]) => c);
    const counts = {
      added: p.items.filter((i) => !byKey.has(i.key)).length,
      updated: p.items.filter((i) => byKey.has(i.key)).length,
      removed: stale.length,
      manual: manual.length,
      section: sec.title,
    };
    if (p.dryRun) return counts;

    for (const it of p.items) {
      let note = byKey.get(it.key);
      if (note) {
        if (note.title !== it.title) { note.title = it.title; note.save(); }
        note.setContent(it.content);
      } else {
        note = (await api.createNewNote({ parentNoteId: sec.noteId, title: it.title, type: "text", content: it.content })).note;
        note.setLabel("iconClass", "bx bx-book-content");
      }
      for (const name of p.importLabels) {
        const v = it.labels[name];
        if (v == null || v === "") { if (note.hasLabel(name)) note.removeLabel(name); }
        else note.setLabel(name, String(v));
      }
    }
    for (const c of stale) c.deleteNote();
    if (p.removeManual) for (const c of manual) c.deleteNote();
    sec.setLabel("cvSort", "date");
    return { ...counts, manualRemoved: p.removeManual ? manual.length : 0 };
  }, [payload]);
}

function pickJsonFile() {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.addEventListener("change", () => resolve((input.files || [])[0] || null));
    input.click();
  });
}

// Modal summary of a dry run; resolves to { removeManual } or null (cancel).
function confirmImport(counts, fileName) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;inset:0;z-index:100001;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.4);";
    const box = document.createElement("div");
    box.style.cssText = "background:var(--main-background-color,#fff);color:var(--main-text-color,#000);border:1px solid var(--main-border-color,#ccc);" +
      "border-radius:6px;padding:16px;width:min(480px,92vw);box-shadow:0 8px 30px rgba(0,0,0,0.35);";
    box.innerHTML = `<div style="font-weight:600;margin-bottom:8px;">Import ${escapeHtml(fileName)} into "${escapeHtml(counts.section)}"</div>
      <ul style="margin:0 0 10px;padding-left:18px;">
        <li>${counts.added} new</li><li>${counts.updated} updated (your own labels and child notes are kept)</li>
        <li>${counts.removed} removed (no longer in the export)</li></ul>
      ${counts.manual ? `<label style="display:flex;gap:6px;align-items:flex-start;"><input type="checkbox" checked>
        <span>Also remove the ${counts.manual} publication${counts.manual === 1 ? "" : "s"} not imported from Zotero, so the section matches the export.</span></label>` : ""}
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px;">
        <button type="button" class="btn btn-sm btn-secondary" data-act="cancel">Cancel</button>
        <button type="button" class="btn btn-sm btn-primary" data-act="ok">Import</button></div>`;
    overlay.append(box);
    document.body.append(overlay);
    const done = (result) => { overlay.remove(); resolve(result); };
    box.querySelector('[data-act="cancel"]').addEventListener("click", () => done(null));
    box.querySelector('[data-act="ok"]').addEventListener("click", () => {
      const cb = box.querySelector('input[type="checkbox"]');
      done({ removeManual: !!(cb && cb.checked) });
    });
  });
}

async function importZotero() {
  const file = await pickJsonFile();
  if (!file) return false;
  let items;
  try {
    items = cslToItems(JSON.parse(await file.text()));
  } catch (error) {
    api.showError(`Import failed: ${error.message}`);
    return false;
  }
  const dupes = items.length - new Set(items.map((i) => i.key)).size;
  if (dupes) { api.showError(`Import failed: ${dupes} duplicate item id(s) in ${file.name}.`); return false; }
  const counts = await syncPublications({ items, dryRun: true, importLabels: IMPORT_LABELS });
  if (counts.error) { api.showError(counts.error); return false; }
  const choice = await confirmImport(counts, file.name);
  if (!choice) return false;
  const result = await syncPublications({ items, dryRun: false, removeManual: choice.removeManual, importLabels: IMPORT_LABELS });
  if (result.error) { api.showError(result.error); return false; }
  api.showMessage(`Zotero import: ${result.added} new, ${result.updated} updated, ${result.removed + (result.manualRemoved || 0)} removed.`);
  return true;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Build pipeline (pure: tree + variant id -> outputs)
 * ────────────────────────────────────────────────────────────────────────── */

function listVariants(tree) {
  return Object.values(tree.notes).filter((r) => hasLabel(r, "cvVariant")).map((r) => ({ id: r.noteId, title: r.title }));
}

// CSS for a template note (#cvTemplate=<name>). #cvExtends=<other> on the note
// prepends the other template's CSS (chains allowed, cycles stopped).
function templateCss(tree, name, seen = new Set()) {
  if (seen.has(name)) return "";
  seen.add(name);
  const rec = Object.values(tree.notes).find((r) => label(r, "cvTemplate") === name);
  if (!rec) return null;
  const parent = label(rec, "cvExtends");
  const base = parent ? templateCss(tree, parent, seen) || "" : "";
  return base + "\n" + (rec.content || "");
}

// Used only when no template note is found, so the preview stays readable.
const FALLBACK_CSS = "body{font-family:sans-serif;max-width:210mm;margin:8mm auto;padding:0 10mm}" +
  ".cv-bg{display:none}.cv{display:grid;grid-template-columns:1fr 2fr;gap:8mm}.when{font-weight:bold}";

function buildVariant(tree, variantId) {
  const rec = tree.notes[variantId];
  let spec;
  try {
    spec = JSON.parse(rec.content || "{}");
  } catch (error) {
    throw new Error(`Variant "${rec.title}" is not valid JSON: ${error.message}`);
  }
  const model = buildModel(tree, spec);
  const templateName = spec.template || "modern";
  let css = templateCss(tree, templateName);
  if (css == null) {
    model.warnings.push(`No template note with #cvTemplate=${templateName}; using a plain fallback style. Run cv-seed.js again to add the "modern" template.`);
    css = FALLBACK_CSS;
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

// Write a file into a folder on the machine running the Trilium backend (the
// same machine for the desktop app). Used when the CV root has #cvOutputDir.
// Relies on Node's require being reachable from backend scripts.
async function writeFileOnBackend(dir, filename, content) {
  return api.runAsyncOnBackendWithManualTransactionHandling(async (d, f, c) => {
    const req = typeof require === "function" ? require : null;
    if (!req) throw new Error("Node 'require' is not available to backend scripts here.");
    const fs = req("fs");
    const path = req("path");
    const target = d.replace(/^~(?=$|[\\/])/, req("os").homedir());
    fs.mkdirSync(target, { recursive: true });
    const full = path.join(target, f);
    fs.writeFileSync(full, c, "utf8");
    return full;
  }, [dir, filename, content]);
}

// Save a generated file. Order: fixed folder (#cvOutputDir on the CV root) ->
// native Save dialog (File System Access API, works in Trilium desktop) ->
// tell the user to use "Store as notes". <a download> is not used: Trilium
// desktop ignores it. showSaveFilePicker must be called synchronously from the
// click handler (user activation), so callers must not await before calling.
function saveFile(filename, content, mime, outputDir) {
  if (outputDir) {
    writeFileOnBackend(outputDir, filename, content)
      .then((full) => api.showMessage(`Saved ${full}`))
      .catch((error) => api.showError(`Saving to ${outputDir} failed: ${error.message}`));
    return;
  }
  if (typeof window.showSaveFilePicker !== "function") {
    api.showError("This Trilium build has no save dialog. Use \"Store as notes\" and export the note, or set #cvOutputDir on the CV root note.");
    return;
  }
  const ext = filename.slice(filename.lastIndexOf("."));
  window.showSaveFilePicker({ suggestedName: filename, types: [{ description: ext.slice(1).toUpperCase(), accept: { [mime]: [ext] } }] })
    .then(async (handle) => {
      const writable = await handle.createWritable();
      await writable.write(new Blob([content], { type: mime }));
      await writable.close();
      api.showMessage(`Saved ${handle.name}`);
    })
    .catch((error) => {
      if (error && error.name === "AbortError") return; // dialog cancelled
      api.showError(`Saving failed: ${error.message}. Set #cvOutputDir on the CV root note to save to a fixed folder instead.`);
    });
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
  const importBtn = mkButton("Import Zotero…", false);
  importBtn.title = "Import a Zotero CSL-JSON export into the publications section (replaces earlier imports)";
  const printBtn = mkButton("Print / PDF", true);
  const htmlBtn = mkButton("Save HTML", false);
  const yamlBtn = mkButton("Save RenderCV YAML", false);
  const jsonBtn = mkButton("Save JSON Resume", false);
  const storeBtn = mkButton("Store as notes", false);
  const closeBtn = mkButton("Close", false);
  storeBtn.title = "Write the HTML / YAML / JSON as child notes of the variant";
  const spacer = document.createElement("span");
  spacer.style.flex = "1";
  bar.append(titleEl, select, reloadBtn, importBtn, spacer, printBtn, htmlBtn, yamlBtn, jsonBtn, storeBtn, closeBtn);

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
  const reload = async () => {
    try {
      const fresh = await loadCvTree();
      if (fresh.error) throw new Error(fresh.error);
      tree = fresh;
      rebuild();
    } catch (error) {
      api.showError(error.message);
    }
  };
  reloadBtn.addEventListener("click", reload);
  importBtn.addEventListener("click", async () => {
    try {
      if (await importZotero()) await reload();
    } catch (error) {
      api.showError(`Import failed: ${error.message}`);
    }
  });
  printBtn.addEventListener("click", () => { if (current) frame.contentWindow.print(); });
  const outputDir = () => label(tree.notes[tree.rootId], "cvOutputDir") || null;
  htmlBtn.addEventListener("click", () => { if (current) saveFile(`${current.base}.html`, current.html, "text/html", outputDir()); });
  yamlBtn.addEventListener("click", () => { if (current) saveFile(`${current.base}.yaml`, current.yaml, "text/yaml", outputDir()); });
  jsonBtn.addEventListener("click", () => { if (current) saveFile(`${current.base}.json`, current.json, "application/json", outputDir()); });
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
 * Widget: a "Build CV" button at the top of the CV note (#cvRoot) itself.
 * note-detail-pane widgets must be exported as a class with a static
 * parentWidget getter; Trilium ignores them when exported as an instance.
 * ────────────────────────────────────────────────────────────────────────── */

/* ────────────────────────────────────────────────────────────────────────────
 * First-run setup
 *
 * When the widget loads and no #cvRoot note exists, a generic CV tree with
 * placeholder content is created as a child of this script note (move it
 * anywhere; everything is found by label). The script note then gets
 * #cvSetupDone so a deleted tree is not recreated; remove that label to get a
 * fresh tree. When a #cvRoot exists, only missing template notes are added;
 * existing notes are never changed.
 * ────────────────────────────────────────────────────────────────────────── */

const SETUP_TEMPLATES = {
  modern: `/* "modern" CV template for cv-builder.
   Layout: coloured sidebar (--main), accent headings (--accent), A4 print.
   Variables can be overridden per variant via "style" (main, accent, font,
   sidebar_width).
   Print: cv-builder wraps the page in a table whose repeated <thead>/<tfoot>
   spacers (.page-gap) give each printed page a top/bottom margin while
   @page margin stays 0, so the fixed sidebar band (.cv-bg) runs edge to edge.
   Don't switch to @page margins: that leaves white gaps in the band. */
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
.ic.brand{fill:currentColor;stroke:none;width:3.6mm;height:3.6mm}
.cv-sidebar .ic.brand{fill:#a9d8bb}
.bullets{padding-left:4mm}
h3{font-size:10pt;font-weight:700;color:var(--main);margin:3.5mm 0 2mm;break-after:avoid;page-break-after:avoid}
.cv-sidebar h3{color:#fff}
@page{size:A4;margin:0}
@media print{html{background:none}body{margin:0;min-height:0}.cv-bg{position:fixed}}
@media screen{body{box-shadow:0 2px 12px rgba(0,0,0,.25);margin:8mm auto}}
`,
  design: `/* "design" CV template for cv-builder.
   Light, editorial layout: sidebar on the right on a warm tint, a large serif
   name with an accent block bleeding off the left edge, a vertical timeline for
   dated entries, and bullet sections (e.g. soft skills) shown as chips.
   Variables (overridable per variant via "style"): --main (text/headings),
   --accent, --font (body), --sidebar-width.
   Print: same table spacer technique as "modern" (@page margin 0, the
   .page-gap rows give each page its top/bottom margin, .cv-bg is fixed so the
   tint runs edge to edge); don't switch to @page margins. */
:root{--main:#1d1d1f;--accent:#e4572e;--font:'Inter';--sidebar-width:31%;--text:#1d1d1f;--muted:#6b6b70;
  --tint:#f5f0ea;--line:#ddd5cc;--display:'Playfair Display','DM Serif Display','Libre Baskerville',Georgia,serif;--gap:14mm}
*{box-sizing:border-box}
html{background:#d9d6d2}
body{margin:0 auto;width:210mm;min-height:297mm;background:#fff;color:var(--text);
  font-family:var(--font),'Helvetica Neue',Arial,sans-serif;font-size:9.3pt;line-height:1.45;position:relative;
  -webkit-print-color-adjust:exact;print-color-adjust:exact}
.cv-bg{position:absolute;top:0;bottom:0;right:0;width:var(--sidebar-width);background:var(--tint)}
.no-sidebar .cv-bg{display:none}
.cv-page{border-collapse:collapse;width:100%;position:relative}
.cv-page td{padding:0;vertical-align:top}
.page-gap{height:var(--gap)}
.cv{display:grid;grid-template-columns:1fr var(--sidebar-width)}
.no-sidebar .cv{grid-template-columns:1fr}
.cv-sidebar{order:2;padding:0 8mm 0 7mm}
.cv-main{order:1;padding:0 9mm 0 14mm}
.no-sidebar .cv-main{padding:0 18mm}

/* Header */
.cv-header{position:relative;margin-bottom:7mm;padding-top:1mm}
.cv-header::before{content:"";position:absolute;left:-14mm;top:1mm;width:8mm;height:21mm;background:var(--accent)}
.cv-header h1{margin:0;font-family:var(--display);font-size:34pt;font-weight:700;line-height:1.02;letter-spacing:-.5px;color:var(--main)}
.cv-header .headline{margin-top:3mm;font-size:8.5pt;font-weight:600;letter-spacing:3px;text-transform:uppercase;color:var(--accent)}
/* Greyscale first, then the accent offset shadow, so the shadow keeps its colour
   (a box-shadow would be greyed out by the filter too). */
.photo{display:block;width:calc(100% - 3mm);aspect-ratio:1/1;object-fit:cover;margin:0 0 9mm;filter:grayscale(100%) drop-shadow(3mm 3mm 0 var(--accent))}

/* Headings */
h2{display:flex;align-items:center;gap:3mm;margin:7mm 0 3.5mm;font-size:8.5pt;font-weight:700;letter-spacing:2.5px;
  text-transform:uppercase;color:var(--main);break-after:avoid;page-break-after:avoid}
h2::before{content:"";flex:none;width:6mm;height:2px;background:var(--accent)}
.cv-main section:first-of-type h2{margin-top:2mm}
h3{margin:4.5mm 0 2mm;font-size:9pt;font-weight:700;color:var(--accent);break-after:avoid;page-break-after:avoid}

a{color:inherit;text-decoration:none}
.cv-main a{color:var(--accent)}
p{margin:0 0 1.5mm}
ul{margin:1mm 0 0;padding-left:4mm}
li{margin-bottom:.8mm}
li::marker{color:var(--accent)}

/* Entries: timeline for dated entries in the main column */
.entry{break-inside:avoid;page-break-inside:avoid;margin-bottom:4mm}
.cv-main .entry.experience,.cv-main .entry.education,.cv-main .entry.normal{display:grid;grid-template-columns:23mm 1fr;column-gap:5mm;margin-bottom:0}
.cv-main .entry .what{position:relative;border-left:1px solid var(--line);padding:0 0 4.5mm 5mm}
.cv-main .entry .what::before{content:"";position:absolute;left:-1.35mm;top:1.1mm;width:2.2mm;height:2.2mm;border-radius:50%;background:#fff;border:1.5px solid var(--accent)}
.cv-main .no-dates .entry{display:block;margin-bottom:3.5mm}
.cv-main .no-dates .what{border-left:0;padding:0}
.cv-main .no-dates .what::before,.no-dates .when{display:none}
.when{padding-top:.2mm;font-size:8pt;font-weight:600;color:var(--muted);text-align:right;font-variant-numeric:tabular-nums}
.head{font-size:10pt;font-weight:700}
.sub{margin-bottom:1.2mm;font-size:8.5pt;font-weight:500;color:var(--accent)}
.cv-sidebar .entry{margin-bottom:3.2mm;font-size:8.6pt}
.cv-sidebar .head{font-size:8.8pt}
.cv-sidebar .sub{color:var(--muted);font-weight:400}
.cv-main .entry.text p{padding-left:5mm;text-indent:-5mm}
.cv-main .s-profile .entry.text p{padding-left:0;text-indent:0;font-size:10.5pt;line-height:1.55;color:#3a3a3e}
.intro{color:var(--muted);font-style:italic}

/* Contact */
.contact{list-style:none;padding:0;margin:0}
.contact li{display:flex;align-items:center;gap:2.5mm;margin-bottom:1.8mm;font-size:8.6pt;word-break:break-word}
.ic{width:3.8mm;height:3.8mm;flex:none;fill:none;stroke:var(--accent);stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.ic.brand{fill:var(--accent);stroke:none;width:3.4mm;height:3.4mm}

/* Bullet sections as chips */
.bullets{display:flex;flex-wrap:wrap;gap:1.5mm;list-style:none;padding:0;margin:0}
.bullets li{margin:0;padding:.5mm 2.6mm;border:1px solid var(--accent);border-radius:999px;font-size:8pt;line-height:1.4}

@page{size:A4;margin:0}
@media print{html{background:none}body{margin:0;min-height:0}.cv-bg{position:fixed}}
@media screen{body{box-shadow:0 2px 16px rgba(0,0,0,.2);margin:8mm auto}}
`,
  business: `/* "business" CV template for cv-builder.
   Conservative corporate layout: navy accent, pale grey sidebar on the left
   with a thin rule, name above a full-width rule, dates right-aligned next to
   each position, upright (non-italic) company names, passport-style photo.
   Variables (overridable per variant via "style"): --main (navy), --accent,
   --font, --sidebar-width.
   Print: same table spacer technique as "modern" (@page margin 0, .page-gap
   rows give each page its margins, .cv-bg is fixed); don't switch to @page
   margins. */
:root{--main:#1f3a5f;--accent:#1f3a5f;--font:'Source Sans 3';--sidebar-width:30%;--text:#222;--muted:#5f6b7a;
  --rule:#c9d1db;--tint:#f2f4f7;--gap:13mm}
*{box-sizing:border-box}
html{background:#e6e9ee}
body{margin:0 auto;width:210mm;min-height:297mm;background:#fff;color:var(--text);
  font-family:var(--font),'Calibri','Carlito','Segoe UI',Arial,sans-serif;font-size:9.6pt;line-height:1.4;position:relative;
  -webkit-print-color-adjust:exact;print-color-adjust:exact}
.cv-bg{position:absolute;top:0;bottom:0;left:0;width:var(--sidebar-width);background:var(--tint);border-right:1px solid var(--rule)}
.no-sidebar .cv-bg{display:none}
.cv-page{border-collapse:collapse;width:100%;position:relative}
.cv-page td{padding:0;vertical-align:top}
.page-gap{height:var(--gap)}
.cv{display:grid;grid-template-columns:var(--sidebar-width) 1fr}
.no-sidebar .cv{grid-template-columns:1fr}
.cv-sidebar{padding:0 6mm 0 9mm}
.cv-main{padding:0 12mm 0 8mm}
.no-sidebar .cv-main{padding:0 16mm}

/* Header */
.cv-header{border-bottom:2px solid var(--main);padding-bottom:3mm;margin-bottom:1mm}
.cv-header h1{margin:0;font-size:23pt;font-weight:700;letter-spacing:.2px;color:var(--main)}
.cv-header .headline{margin-top:.8mm;font-size:11pt;color:var(--muted)}
.photo{display:block;width:30mm;height:37mm;object-fit:cover;margin:0 0 5mm;border:1px solid var(--rule)}

/* Headings */
h2{margin:5.5mm 0 2.5mm;padding-bottom:.8mm;border-bottom:1px solid var(--rule);font-size:10pt;font-weight:700;
  letter-spacing:1px;text-transform:uppercase;color:var(--main);break-after:avoid;page-break-after:avoid}
.cv-sidebar h2{font-size:9pt}
h3{margin:3mm 0 1.5mm;font-size:9.6pt;font-weight:700;color:var(--text);break-after:avoid;page-break-after:avoid}

a{color:inherit;text-decoration:none}
.cv-main a{color:var(--main)}
p{margin:0 0 1.4mm}
ul{margin:.8mm 0 0;padding-left:4.5mm}
li{margin-bottom:.6mm}
li::marker{color:var(--main)}

/* Entries: position left, dates right */
.entry{break-inside:avoid;page-break-inside:avoid;margin-bottom:3.2mm}
.cv-main .entry.experience,.cv-main .entry.education,.cv-main .entry.normal{display:grid;grid-template-columns:1fr 24mm;column-gap:4mm}
.cv-main .entry .what{grid-column:1;grid-row:1}
.cv-main .entry .when{grid-column:2;grid-row:1;text-align:right;white-space:nowrap}
.cv-main .no-dates .entry{display:block}
.no-dates .when{display:none}
.when{font-size:9pt;color:var(--muted)}
.head{font-weight:700}
.sub{margin-bottom:1mm;font-size:9.2pt;color:var(--main)}
.cv-sidebar .entry{margin-bottom:2.6mm;font-size:8.9pt}
.cv-sidebar .sub{color:var(--muted)}
.cv-main .entry.text p{padding-left:5mm;text-indent:-5mm}
.cv-main .s-profile .entry.text p{padding-left:0;text-indent:0}
.intro{color:var(--muted)}

/* Contact */
.contact{list-style:none;padding:0;margin:0}
.contact li{display:flex;align-items:center;gap:2.4mm;margin-bottom:1.5mm;font-size:8.9pt;word-break:break-word}
.ic{width:3.8mm;height:3.8mm;flex:none;fill:none;stroke:var(--main);stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.ic.brand{fill:var(--main);stroke:none;width:3.4mm;height:3.4mm}
.bullets{padding-left:4mm}

@page{size:A4;margin:0}
@media print{html{background:none}body{margin:0;min-height:0}.cv-bg{position:fixed}}
@media screen{body{box-shadow:0 2px 12px rgba(0,0,0,.2);margin:8mm auto}}
`,
};

// Placeholder content. Each section shows the labels its entry type uses.
const SETUP_TREE = {
  rootHtml:
    "<p>Single source for your CV variants. Click <strong>Build CV…</strong> above to preview and export a variant.</p>" +
    "<ul><li><strong>Profile</strong>: name, contact labels and your profile text. Child notes with <code>#cvTranslation</code> or <code>#cvFocus</code> hold alternative texts.</li>" +
    "<li><strong>Sections</strong>: one note per section, one child note per entry. The labels on the example entries show which fields each type uses.</li>" +
    "<li><strong>Variants</strong>: JSON notes choosing sections, order, filters, language and template.</li>" +
    "<li><strong>Templates</strong>: CSS notes for the HTML look.</li></ul>" +
    "<p>Replace the example content with your own. Publications can be imported from Zotero (CSL JSON) with <strong>Import Zotero…</strong> in the builder.</p>",
  profile: {
    labels: { name: "Your Name", headline: "Your job title", location: "City, Country", email: "you@example.com", github: "your-github-name", linkedin: "your-linkedin-name" },
    links: ["example.com | https://example.com | globe"],
    body: ["A short profile: who you are, what you do and what you are looking for. Two to four sentences work best."],
    variants: [
      { title: "Profile (nl)", translation: "nl", labels: { headline: "Je functietitel" }, body: ["Een kort profiel: wie je bent, wat je doet en wat je zoekt."] },
      { title: "Profile (research focus)", focus: "research", body: ["The same profile with the emphasis on research, used by variants with \"focus\": [\"research\"]."] },
    ],
  },
  sections: [
    { key: "experience", title: "Experience", nl: "Werkervaring", entryType: "experience", jsonResume: "work", entries: [
      { title: "Current position — Organisation", position: "Current position", company: "Organisation", location: "City, Country", start: "2022-01", end: "present", tags: "example",
        items: ["Main responsibility or achievement", "Another responsibility or achievement"] },
      { title: "Previous position — Other organisation", position: "Previous position", company: "Other organisation", location: "City, Country", start: "2018", end: "2021",
        body: ["A one-line summary of the role."], items: ["Key result"] },
    ] },
    { key: "education", title: "Education", nl: "Opleiding", entryType: "education", jsonResume: "education", entries: [
      { title: "MSc — University", degree: "MSc", area: "Field of study", title_long: "Master of Science in Field of study", institution: "University", start: "2014", end: "2016",
        body: ["Thesis or specialisation."] },
    ] },
    { key: "publications", title: "Publications", nl: "Publicaties", entryType: "text", jsonResume: "publications", sort: "date",
      intro: ["Optional intro text, e.g. a link to your full publication list."], entries: [
      { title: "Example article (2024)", pubType: "journalArticle", year: "2024",
        body: ["Lastname, A., & Your Name (2024). Title of the article. *Journal Name*, *12*(3), 45-67. [https://doi.org/10.0000/example](https://doi.org/10.0000/example)"] },
    ] },
    { key: "courses", title: "Courses", nl: "Cursussen", entryType: "normal", jsonResume: "certificates", entries: [
      { title: "Course name", name: "Course name", date: "2020", body: ["Organiser"] },
    ] },
    { key: "skills", title: "Skills", nl: "Vaardigheden", entryType: "text", jsonResume: "skills", entries: [
      { title: "Skill 1", body: ["A sentence describing a skill."] },
      { title: "Skill 2", body: ["Another skill."] },
    ] },
    { key: "languages", title: "Languages", nl: "Talen", entryType: "oneline", jsonResume: "languages", entries: [
      { title: "English", name: "English", body: ["Fluent"] },
    ] },
    { key: "interests", title: "Interests", nl: "Interesses", entryType: "bullet", jsonResume: "interests", entries: [
      { title: "Interest 1", body: ["Interest 1"] },
      { title: "Interest 2", body: ["Interest 2"] },
    ] },
  ],
  variants: [
    { title: "Full CV (EN)", spec: {
      lang: "en", template: "modern", highlight: ["Your Name"],
      main: ["profile", "experience", { section: "publications", groups: "by_type" }],
      sidebar: ["contact", "education", "courses", "skills", "languages", "interests"],
      rendercv: { design: { theme: "classic" } } } },
    { title: "Short CV (NL, business)", spec: {
      lang: "nl", template: "business", highlight: ["Your Name"],
      main: ["profile", { section: "experience", since: 2018 }, { section: "publications", max: 5, intro: false }],
      sidebar: ["contact", "education", "skills", "languages"],
      rendercv: { design: { theme: "moderncv" } } } },
    { title: "Research CV (EN, design)", spec: {
      lang: "en", template: "design", focus: ["research"], highlight: ["Your Name"],
      main: ["profile", "experience", { section: "publications", groups: [
        { title: "Peer-reviewed", types: ["journalArticle", "conferencePaper", "bookSection"] },
        { title: "Other", types: "*" }] }],
      sidebar: ["contact", "education", "skills", "languages", "interests"] } },
  ],
};

// Backend: create the tree (first run) or add missing templates. Self-contained:
// everything it needs comes in through `p`.
async function ensureSetup(scriptNoteId) {
  return api.runAsyncOnBackendWithManualTransactionHandling(async (p) => {
    const esc = (t) => String(t ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
    const md = (t) => esc(t)
      .replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>')
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
    const body = (paras = [], items = []) =>
      paras.map((x) => `<p>${md(x)}</p>`).join("") + (items.length ? `<ul>${items.map((i) => `<li>${md(i)}</li>`).join("")}</ul>` : "");
    const textNote = async (parentNoteId, title, content, icon) => {
      const { note } = await api.createNewNote({ parentNoteId, title, type: "text", content: content || "" });
      if (icon) note.setLabel("iconClass", icon);
      return note;
    };
    const ensureTemplates = async (root) => {
      let folder = root.getChildNotes().find((c) => c.hasLabel("cvTemplates") || c.title === "Templates");
      if (!folder) {
        folder = await textNote(root.noteId, "Templates",
          "<p>CSS code notes labelled <code>#cvTemplate=&lt;name&gt;</code>, chosen by a variant with <code>\"template\": \"&lt;name&gt;\"</code>. Add <code>#cvExtends=&lt;other&gt;</code> to build on another template.</p>",
          "bx bx-palette");
      }
      folder.setLabel("cvTemplates");
      const added = [];
      for (const [name, css] of Object.entries(p.templates)) {
        if (api.searchForNotes(`#cvTemplate=${name}`).length) continue;
        const { note } = await api.createNewNote({ parentNoteId: folder.noteId, title: `${name}.css`, type: "code", mime: "text/css", content: css });
        note.setLabel("cvTemplate", name);
        added.push(name);
      }
      return added;
    };

    const existing = api.searchForNotes("#cvRoot");
    if (existing.length) {
      const added = await ensureTemplates(existing[0]);
      return { status: added.length ? "templates" : "ok", added };
    }
    const script = api.getNote(p.scriptNoteId);
    if (!script || script.hasLabel("cvSetupDone")) return { status: "skipped" };

    const t = p.tree;
    const root = await textNote(script.noteId, "CV", t.rootHtml, "bx bx-id-card");
    root.setLabel("cvRoot");
    root.setLabel("cvLang", "en");

    const pr = t.profile;
    const profile = await textNote(root.noteId, "Profile", body(pr.body), "bx bx-user");
    profile.setLabel("cvProfile");
    for (const [k, v] of Object.entries(pr.labels)) profile.setLabel(k, v);
    for (const l of pr.links) profile.addLabel("link", l);
    for (const v of pr.variants) {
      const child = await textNote(profile.noteId, v.title, body(v.body), "bx bx-transfer-alt");
      if (v.translation) child.setLabel("cvTranslation", v.translation);
      if (v.focus) child.setLabel("cvFocus", v.focus);
      for (const [k, val] of Object.entries(v.labels || {})) child.setLabel(k, val);
    }

    const entryLabels = ["pubType", "position", "company", "institution", "degree", "area", "name", "location", "start", "end", "date", "year", "tags"];
    const sections = await textNote(root.noteId, "Sections", "", "bx bx-list-ul");
    for (const s of t.sections) {
      const sec = await textNote(sections.noteId, s.title, body(s.intro || []), "bx bx-folder");
      sec.setLabel("cvSection");
      sec.setLabel("cvKey", s.key);
      sec.setLabel("entryType", s.entryType);
      if (s.jsonResume) sec.setLabel("jsonResume", s.jsonResume);
      if (s.nl) sec.setLabel("cvTitle_nl", s.nl);
      if (s.sort) sec.setLabel("cvSort", s.sort);
      for (const e of s.entries) {
        const entry = await textNote(sec.noteId, e.title, body(e.body || [], e.items || []), "bx bx-file");
        for (const k of entryLabels) if (e[k] != null && e[k] !== "") entry.setLabel(k, e[k]);
        if (e.title_long) entry.setLabel("title", e.title_long);
      }
    }

    const variants = await textNote(root.noteId, "Variants", "", "bx bx-copy-alt");
    for (const v of t.variants) {
      const { note } = await api.createNewNote({ parentNoteId: variants.noteId, title: v.title, type: "code", mime: "application/json", content: JSON.stringify(v.spec, null, 2) });
      note.setLabel("cvVariant");
    }
    await ensureTemplates(root);
    script.setLabel("cvSetupDone");
    return { status: "created", rootId: root.noteId };
  }, [{ scriptNoteId, tree: SETUP_TREE, templates: SETUP_TEMPLATES }]);
}

// Runs once per frontend load (module scope of the #widget note).
async function autoSetup() {
  const script = api.startNote || api.currentNote;
  if (!script) return;
  try {
    const result = await ensureSetup(script.noteId);
    if (result.status === "created") {
      api.showMessage("CV builder: created a CV tree with example content under this script note. Open the note \"CV\" to start; you can move it anywhere.");
    } else if (result.status === "templates") {
      api.showMessage(`CV builder: added template note(s): ${result.added.join(", ")}.`);
    }
  } catch (error) {
    console.error("cv-builder setup:", error);
    api.showError(`CV builder setup failed: ${error.message}`);
  }
}

autoSetup();

// Open the builder once at a time and surface any error as a Trilium toast,
// so a failure is visible instead of looking like a dead button.
let builderOpen = false;
async function runBuilder() {
  if (builderOpen) return;
  builderOpen = true;
  try {
    await openBuilder();
  } catch (error) {
    console.error("cv-builder:", error);
    api.showError(`CV builder failed: ${error && error.message ? error.message : error}`);
  } finally {
    builderOpen = false;
  }
}

class CvBuilderWidget extends api.NoteContextAwareWidget {
  static get parentWidget() { return "note-detail-pane"; }
  get parentWidget() { return "note-detail-pane"; }
  get position() { return 1; }

  isEnabled() {
    return super.isEnabled() && !!this.note && this.note.hasLabel("cvRoot");
  }

  doRender() {
    this.$widget = $(`<div class="cv-builder-widget">
      <button type="button" class="btn btn-sm btn-primary" title="Preview, print / PDF, RenderCV YAML, JSON Resume">
        <span class="bx bx-id-card"></span> Build CV…
      </button>
    </div>`);
    // The note detail area can be layered over this widget (or sit in a
    // container with pointer-events:none); lift the widget above it so the
    // button receives clicks.
    this.cssBlock(`.cv-builder-widget { position: relative; z-index: 50; pointer-events: auto; padding: 8px 12px 0; }
      .cv-builder-widget button { position: relative; z-index: 51; pointer-events: auto; cursor: pointer;
        display: inline-flex; align-items: center; gap: 4px; }`);
    // Native listener on the button itself (not delegated through jQuery), so a
    // Trilium handler that stops propagation higher up can't swallow it.
    this.$widget.find("button")[0].addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      runBuilder();
    });
    return this.$widget;
  }

  async refreshWithNote() {}
}

module.exports = CvBuilderWidget;
