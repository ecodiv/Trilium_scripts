# Import EML

A [Trilium Notes](https://triliumnotes.org/) launch-bar widget that imports
`.eml` files (saved email messages) into your notes. Each email becomes a
searchable note under the note you are viewing, with its attachments and the
original message preserved, and re-importing the same email is recognised as a
duplicate rather than stored twice.

> Disclaimer: Created with help of Claude.ai

## What it does

Pick one or more `.eml` files and each becomes a note **under the note you are
currently viewing**, containing:

- the email subject as the note title;
- sender, recipients and CC recipients;
- the sent date and Message-ID;
- the message body with its original formatting and embedded images;
- each attachment as a child note;
- the original `.eml` file, kept as a child note.

```text
(your active note)
└── Project proposal
    ├── proposal.pdf
    ├── budget.xlsx
    └── Project proposal.eml
```

The body is imported as sanitized HTML: scripts are removed and embedded (inline)
images are kept, while remote/external images are stripped for privacy.

> The way emails are imported is compatible with those imported using the
> [Thunderbird2Trilium](https://github.com/ecodiv/Trilium_scripts/tree/main/thunderbird2trilium)
> addon. That means that if you have imported an email using the Thunderbird
> addon, and then try to import the same with this widget, it will be detected
> as a duplicate. This is handy if you cannot run Thunderbird on all your
> computers.


## Requirements

- A TriliumNext installation.

## Setup

1. Create a new note of type **JSX**.
2. Open [`eml2trilium.jsx`](eml2trilium.jsx), copy its full contents into the
   note, and save. Do **not** add a `#widget` label.
3. Open the **Global menu → Configure launchbar**. Right click on the *Visible
   Launchers* sectionn, choose **Add a custom widget**, and set its **widget**
   field to the note you just created.
4. Reload Trilium (`Ctrl+R`).

An envelope button appears in the launch bar. 

## Importing an email

1. Open the note you want the email(s) placed under.
2. Click the envelope button in the launch bar.
3. Choose one or more `.eml` files. A message confirms how many were imported and
   how many duplicates were skipped.

To get an `.eml` file: most mail clients can save or export a message as `.eml`
(usually via a **Save As** or **Export** command on the message).

## Options

Configure the importer by adding labels to the **JSX note itself** (the note the
launcher points at). All are optional; the defaults are shown in bold.

| Label | Values | Effect |
| --- | --- | --- |
| `#emlBodyFormat` | **`html`** / `html-images` / `plain` | How the message body is imported. |
| `#emlImportAttachments` | **`true`** / `false` | Import attachments as child notes. |
| `#emlPreserveEml` | **`true`** / `false` | Keep the original `.eml` as a child note. |
| `#emlDateMode` | **`both`** / `calendar` / `daily` / `none` | Link the note to the date it was sent (see below). |
| `#emlIconClass` | Boxicons class (**`bx bx-envelope`**) | Tree icon given to each imported email note. |
| `#emlColor` | CSS color (**empty**) | Add a `#color` label so imported emails stand out in the note tree. |

Body format:

- **`html`** — sanitized HTML keeping the original formatting; embedded (inline)
  images are shown, remote/external images are stripped for privacy.
- `html-images` — same, but remote/external images are also kept and loaded.
- `plain` — the message text only, no formatting or images.

Date handling (`#emlDateMode`):

- `daily` — clone the note under the [day note](https://docs.triliumnotes.org/)
  for the date the email was sent.
- `calendar` — add the calendar's native `#startDate` and `#startTime` labels
  (the day and time the email was sent) so a
  [calendar view](https://docs.triliumnotes.org/) shows it as an event. There is
  no `#endTime`, as an email has no duration.
- **`both`** — clone under the day note *and* add the calendar labels.
- `none` — do neither.

For example, to import bodies as plain text and skip attachments, add
`#emlBodyFormat=plain` and `#emlImportAttachments=false` to the JSX note, then
reload Trilium.

Each imported email note gets an `#email` label; its child attachments each get
an `#email_attachment` label, and the preserved original message gets
`#file_type=eml`, so you can find them with a search. 

If you are using the [weekplanner]() widget, the `#email` label will be picked
up by the widget, and imported emails will appear in the *backlog* column of the
planner dashboard.

## Duplicate detection

Each imported note gets an `#emailImportKey` label — the SHA-256 of the email's
Message-ID (or of the raw message when it has none). Before creating a note the
widget checks for an existing note with the same key, so re-importing the same
email does not create a second copy.

## License

Released under the GNU General Public License v3.0. See the [LICENSE](../LICENSE)
file for the full text.
