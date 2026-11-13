## CV builder

A [Trilium Notes](https://triliumnotes.org/) widget that builds
curriculum vitae variants from **one CV subtree**. You keep every position,
degree, course and publication once, as notes with labels. *Variant* notes then
choose which sections appear, in which order, in the main column or the sidebar,
and which entries they include (by tag, year or maximum count).

For each variant you get:

- an **HTML CV** with a live preview, **Print / PDF**, and **Save HTML**;
- a **[RenderCV](https://github.com/rendercv/rendercv) YAML** file, for
  typeset PDF output via Typst (`rendercv render file.yaml`);
- a **[JSON Resume](https://jsonresume.org/)** file, for JSON Resume themes and
  tools.

> Disclaimer: Created with help of Claude.ai

## Setup

1. **Create the CV tree.** Create a code note of type *JS backend*, paste
   [`cv-seed.js`](cv-seed.js) into it, and click *Execute*. A `CV` tree is
   created next to the script note, filled with example content. Replace that
   content with your own; the structure is what matters. On an existing CV tree,
   the script only adds the default `modern` template note if it is missing, so
   it is safe to run again.
2. **Install the widget.** Create a code note of type *JS frontend*, paste
   [`cv-builder.js`](cv-builder.js) into it, and add the label `#widget`.
   Reload Trilium (`Ctrl+R`).
3. **(Optional) Add a photo.** Add an image note and add a `~photo` relation from
   the *Profile* note to it.

Open the `CV` note (the one labelled `#cvRoot`). A **Build CV…** button appears
at the top of the note. Click it, pick a variant, and export. Other notes don't
show the button.

## Structure

```text
CV                         #cvRoot
├── Profile                #cvProfile  #name #headline #location #email #phone
│                          #link="text | url | icon" (repeatable) #github #linkedin #orcid
│                          ~photo   body = profile text
├── Sections
│   ├── Experience         #cvSection #cvKey=experience #entryType=experience
│   │   │                  #jsonResume=work #cvTitle_nl=Werkervaring
│   │   ├── <entry>        #position #company #location #start #end #tags #cvId
│   │   │   └── nl         #cvTranslation=nl and/or #cvFocus=<name> (text variants)
│   │   └── …
│   └── …
├── Variants
│   ├── Academic EN (full) #cvVariant (JSON code note)
│   ├── Academic EN (design)
│   └── …
└── Templates              #cvTemplates
    ├── modern.css         #cvTemplate=modern (CSS code note, editable)
    ├── design.css         #cvTemplate=design
    └── business.css       #cvTemplate=business
```

### Entry types

The section's `#entryType` sets the type for all of its entries. RenderCV
requires every entry in a section to have the same type.

| `#entryType` | Labels on entries | Body |
| --- | --- | --- |
| `experience` | `#position #company #location #start #end` or `#date` | paragraphs → summary, bullet list → highlights |
| `education` | `#degree #area #institution #location #start #end`, `#title` (long form shown in HTML) | same |
| `normal` | `#name #location #start #end` or `#date` | same |
| `oneline` | `#name` | the details |
| `text` | `#pubType` for publications (see below) | free text (citations, skill sentences) |
| `bullet` | — | one bullet |

Labels that apply to every entry type: `#tags=a,b` (for filtering), `#year`
(the year used for filtering; otherwise taken from the end, date or start
label), `#cvId` (a stable name you can use under `hide`), and `#cvDisabled`
(excludes the entry from every variant).

### Publications

All publications live in one section (`#cvKey=publications`). Each entry has a
`#pubType` label with a Zotero item type: `book`, `bookSection`,
`computerProgram`, `journalArticle`, `conferencePaper`, `document`, `map`,
`presentation`, `report`, `videoRecording`, `webpage`, `dataset` or `thesis`
(plus a few rarer types). Forms like `journal article` also work. The
[Zotero import](#importing-from-zotero) sets these labels for you.

A variant decides how publications are grouped into subsections with
`"groups"` on the section:

```json
{ "section": "publications", "groups": "by_type" }
```

gives one subsection per type, in Zotero's order, with headings in the
variant's language (for example "Journal articles" / "Tijdschriftartikelen").
To combine types into your own subsections, list them:

```json
{
  "section": "publications",
  "since": 2015,
  "groups": [
    { "title": "Peer-reviewed", "types": ["journalArticle", "conferencePaper"], "since": 2018 },
    { "title": { "en": "Books and chapters", "nl": "Boeken en hoofdstukken" }, "types": ["book", "bookSection"] },
    { "title": "Teaching material and software", "types": ["document", "computerProgram"], "max": 5 },
    { "title": "Other", "types": "*" }
  ]
}
```

- Each publication goes into the first group whose `types` match it.
  `"types": "*"` collects everything not matched by an earlier group.
  Publications that match no group are left out, and the builder warns about
  them.
- A group can have its own `since`, `until`, `max`, `sort` and tag filters. These
  apply after the section-level ones.
- `title` can be a plain string or one string per language. If a group has a
  single type and no title, the type's heading is used.
- In RenderCV, group titles become bold lines within one section. Set
  `"rendercv": { "groups": "sections" }` to get one RenderCV section per group
  instead ("Publications – Peer-reviewed").

### Importing from Zotero

In Zotero, right-click your library or a collection, choose **Export…**, and pick
the **CSL JSON** format. Then click **Import Zotero…** in the CV builder and
choose the file. The builder first shows a summary of what will change, then
asks you to confirm.

- **New and updated items.** Each Zotero item becomes a note in the
  publications section, matched on its citation key (`#zoteroId`). On a
  re-import, existing notes get the new title, citation and import labels.
- **What you add is kept.** Labels the importer doesn't manage (such as
  `#tags`, `#cvDisabled` or `#cvId`) and child notes (translations, focus
  variants) stay in place across re-imports.
- **Removed items.** Imported notes whose item is no longer in the export are
  deleted (Trilium keeps deleted notes recoverable for a while).
- **Hand-made entries.** Publications you didn't import are removed only if you
  tick the option in the confirm dialog (ticked by default), so the section then
  matches the export exactly.

The importer writes these labels: `#zoteroId`, `#pubType` (Zotero item type),
`#cslType`, `#year`, `#date`, `#url` (DOI link when available), `#pubTitle` and
`#publisher`. It also sets `#cvSort=date` on the section, so publications are
listed newest first. Citations are formatted in an APA-like style by the builder
itself; to change a citation, edit the item in Zotero and import again.

If you change an item's citation key in Zotero (for example in Better BibTeX),
the next import treats it as a new item and removes the old note.

To put your own name in bold in author lists, list the spellings that appear in
your library under `"highlight"` in the variant. RenderCV gets the same list as
`bold_keywords`.

```json
"highlight": ["van Breugel, P.", "Breugel, P. van", "Van Breugel, P."]
```

### Dates

Dates are `YYYY`, `YYYY-MM` or `YYYY-MM-DD`. Use `#end=present` for ongoing
positions. Entries are listed in tree order, so drag notes to reorder them, or
set `"sort": "date"` on the section in a variant.

Note bodies can be Trilium text notes or markdown notes. Paragraphs, bullet
lists, links, bold and italic are carried over to all outputs.

### Text variants: languages and focus

Any profile, section or entry note can have child notes with alternative text:

| Child note labels | Use |
| --- | --- |
| `#cvTranslation=nl` | the same text in Dutch |
| `#cvFocus=teaching` | a different wording or emphasis (in the base language) |
| `#cvFocus=teaching` `#cvTranslation=nl` | that emphasis in Dutch |

A text variant child can hold its own labels (for example a different
`#headline` or `#position`) as well as its own body. Anything it leaves out comes
from the note above it. A variant chooses text with `"lang"` and `"focus"`:

```text
Profile                      base text (language: #cvLang on the root, default en)
├── Profile (nl)             #cvTranslation=nl  #headline="Senior docent-onderzoeker"
├── Teaching                 #cvFocus=teaching  #headline="Lecturer in geodata science"
├── Teaching (nl)            #cvFocus=teaching  #cvTranslation=nl
└── Research                 #cvFocus=research
```

How the text for a note is picked, given `"lang": "nl", "focus": ["teaching", "research"]`:

1. Start from the base note.
2. Apply the plain `nl` translation, if there is one.
3. Apply the first focus in the list that exists in `nl`. If a focus exists only
   in the base language, that version is used and the builder shows a warning.
   Without a matching focus, the result of step 2 is used.

Labels are overridden one at a time; a body only replaces the one below it when
it is not empty. So `Teaching (nl)` above can contain just the text, and it still
gets the Dutch headline from `Profile (nl)`.

`"focus"` applies to every note in the variant: the profile, section intros
and entries. A list sets an order of preference: the first focus a note has a
version for is used, otherwise its normal text. To give one part of the CV a
different emphasis, override `focus` there:

- `"profile_focus"` applies to the profile note only (text and headline). For
  example, `"focus": ["teaching"]` with `"profile_focus": ["research"]` gives a
  research-oriented profile above teaching-oriented job descriptions.
- `"focus"` on a single section in `main` or `sidebar`, such as
  `{ "section": "experience", "focus": ["research"] }`, applies to that
  section's intro and entries only. Section titles can also use a `#cvTitle_nl` label. The `present` word,
month names and the RenderCV locale come from `lang`; English and Dutch are
included, and other languages can be added in `LOCALES`.

## Variant spec

A variant is a JSON code note labelled `#cvVariant`:

```json
{
  "lang": "nl",
  "focus": ["teaching"],
  "profile_focus": ["research"],
  "template": "modern",
  "headline": "Optional headline override",
  "style": { "main": "#274232", "accent": "#157F3F", "font": "Lato", "sidebar_width": "34%" },
  "include_tags": ["geo", "teaching"],
  "exclude_tags": [],
  "strict_tags": false,
  "hide": ["consultant-2015"],
  "highlight": ["van Breugel, P.", "Breugel, P. van"],
  "main": [
    "profile",
    { "section": "experience", "since": 2004, "sort": "date" },
    { "section": "publications", "since": 2018, "intro": false, "groups": "by_type" }
  ],
  "sidebar": ["contact", "degrees", { "section": "short_courses", "max": 4 }, "skills"],
  "photo": true,
  "filename": "CV_PvB_geo_nl",
  "rendercv": { "design": { "theme": "moderncv" }, "locale": {}, "photo": "profiel.png" }
}
```

- `main` and `sidebar` list section keys (`#cvKey`), in display order. `profile`
  and `contact` are built-in sections that read from the Profile note. If
  `sidebar` is left out, you get a single-column layout.
- Tag filters: entries without tags always pass `include_tags` unless
  `strict_tags` is `true`. You can also set `include_tags` and `exclude_tags` on a
  single section.
- Per-section options: `since`, `until`, `max`, `sort` (`"date"`), `title`
  (a string, or one string per language), `focus`, `groups` (see
  [Publications](#publications)), and `intro` (`false` hides the section note's
  intro text), plus tag filters.
- RenderCV puts all sections in one column (main, then sidebar) and shows contact
  details in its header. `rendercv.design` is passed to RenderCV unchanged; see
  the [RenderCV docs](https://docs.rendercv.com/) for themes and options.

## Templates

The HTML look comes from CSS code notes under *Templates*, each labelled
`#cvTemplate=<name>`. A variant picks one with `"template": "<name>"`; the
default is `modern`. The seed script creates three:

| Template | Look |
| --- | --- |
| `modern` | Dark green sidebar on the left, accent-coloured headings; modelled on the Quarto `modern2-cv` layout. |
| `design` | Light editorial layout: warm-tinted sidebar on the right, large serif name with an accent block, timeline for dated entries, bullet sections (soft skills) as chips, greyscale photo with an accent offset. |
| `business` | Conservative corporate layout: navy accent, pale grey sidebar on the left, name above a full-width rule, dates aligned right, passport-style photo. |

Edit them in Trilium; the changes show up the next time you open the builder
(or click **Reload notes**). Running `cv-seed.js` again adds any of these
templates that are missing and never overwrites existing ones. The seeded
variants *Academic EN (design)* and *Academic EN (business)* show the same
content in the two newer templates.

A variant's `style` (`main`, `accent`, `font`, `sidebar_width`) overrides the
template's own colours. Leave it out to get the template's defaults. The fonts
(Playfair Display and Inter for `design`, Source Sans 3 for `business`) are
used when installed; otherwise similar system fonts are used.

To make a variation without copying everything, create a new template note with
`#cvTemplate=compact` and `#cvExtends=modern`. It then only needs the rules that
differ. Colours, font and sidebar width can also be set per variant via `style`,
without a new template.

The HTML uses stable classes for styling: `cv-sidebar`, `cv-main`,
`cv-section s-<key> t-<type>`, `cv-group` (with an `h3` per group), `entry <type>`,
`when`, `head`, `sub` and `no-dates` (sections without dates).

## Outputs

- **Print / PDF** opens the system print dialog for the preview. Choose *Save as
  PDF* or *Print to file*. If nothing happens, use **Save HTML** and print the
  file from a browser with background graphics enabled.
- **Save HTML / YAML / JSON** opens a save dialog. To skip the dialog and always
  write to the same folder, add `#cvOutputDir=~/Documents/CV` (or any path) to
  the CV root note. **Store as notes** writes all three files as child notes of
  the variant (`#cvOutputDir` is not needed for that), labelled
  `#cvOutput=html|yaml|jsonresume`.
- **RenderCV:** put the photo file (named after the image note, or as set in
  `rendercv.photo`) next to the YAML file and run `rendercv render <file>.yaml`.
  Typst downloads its packages (such as the icon font) the first time, so the
  first render needs an internet connection; after that it works offline.
- **JSON Resume** has fixed keys, so only sections with a `#jsonResume` label
  are exported, and themes set their own section order.

## License

Released under the GNU General Public License v3.0. See the [LICENSE](../LICENSE)
file for the full text.