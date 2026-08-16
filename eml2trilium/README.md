# Import EML

A [Trilium Notes](https://triliumnotes.org/) frontend script that imports `.eml`
files (saved email messages) into your notes. It is the file-based companion to
the [Send to Trilium](../thunderbird2trilium/README.md) Thunderbird add-on:
emails you import from a file end up looking the same as emails sent straight
from Thunderbird.

> Disclaimer: Created with help of Claude.ai

## What it does

Pick one or more `.eml` files and each becomes a note **under the note you are
currently viewing**, containing:

- the email subject as the note title;
- sender, recipients and CC recipients;
- the sent date and Message-ID;
- the message body;
- the original `.eml` file, kept as a child note.

```text
(your active note)
└── Project proposal
    └── Project proposal.eml
```

## Requirements

- A TriliumNext installation.

## Setup

1. Create a new note of type **JS frontend**.
2. Open [`eml2trilium.js`](eml2trilium.js), copy its full contents into the note,
   and save.
3. Open the **Launch Bar** configuration, add a new **Script** launcher, point it
   at the note you just created, and give it a name such as `Import EML`.

## Importing an email

1. Open the note you want the email(s) placed under.
2. Click the **Import EML** launcher.
3. Choose one or more `.eml` files. A message confirms how many were imported.

To get an `.eml` file: most mail clients can save or export a message as `.eml`
(in Thunderbird, right-click a message → **Save As**).

## Current limitations

This first version keeps things deliberately simple. The message body is imported
as text; the original `.eml` child note always preserves the complete, unmodified
email. The following are planned for later versions:

- the body imported with its original formatting (sanitized HTML) and inline
  images;
- attachments imported as their own child notes;
- duplicate detection, so re-importing an email (or importing one already saved
  from Thunderbird) does not create a second copy;
- optionally placing the email under the daily note for its sent date, and adding
  a searchable `#emailDate` label.

## License

Released under the GNU General Public License v3.0. See the [LICENSE](../LICENSE)
file for the full text.
