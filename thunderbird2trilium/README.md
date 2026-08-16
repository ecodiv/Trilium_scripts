# <img width="50" src="logo.svg" > Send to Trilium

A Thunderbird MailExtension that imports selected email messages into
[Trilium Notes](https://github.com/TriliumNext/Notes) through ETAPI. It creates
a searchable note per email, optionally preserves attachments and the original
message, links the note to its daily note, and skips duplicates.

> Disclaimer: Created with help of Claud.ai

## Features

- Thunderbird toolbar action and message-list context menu.
- Searchable Trilium text note with sender, recipients, sent date, Message-ID
  and message body.
- Message body imported as plain text, or as sanitized HTML that keeps the
  original formatting. You can choose whether remote/external images are kept or
  stripped. 
- Encrypted messages (PGP/MIME, S/MIME) are detected and skipped rather than
  imported as unreadable notes.
- Optional attachment import as child file notes.
- Optional preservation of the complete original RFC-822 message as a child
  `.eml` file.
- Duplicate detection using a SHA-256 import key derived from the Message-ID
  (or the raw message when the Message-ID is absent).
- Configurable date handling: clone the note beneath the matching Trilium daily
  note, add calendar labels (`#startDate`/`#startTime`) so it shows as a calendar
  event, both, or neither.
- Optionally give imported notes a color in the tree.
- Settings page for URL, ETAPI token, destination Note ID and behavior.

> The way emails are imported is compatible with those imported using the
> [eml2Trilium](https://github.com/ecodiv/Trilium_scripts/tree/main/eml2trilium)
> addon. That means that if you have imported an email using the eml2trilium
> widget, and then try to import the same with this addon, it will be detected
> as a duplicate. This is handy if you cannot run Thunderbird on all your
> computers.

## Requirements

- Thunderbird 128 or newer.
- A local TriliumNext Desktop instance, running while emails are imported.
- A Trilium ETAPI token.
- A destination note in Trilium under which imported emails will be placed.

> This build connects to a **local** Trilium instance only (`localhost` or
> `127.0.0.1`).

## Setup

### 1. Configure Trilium

**Create an ETAPI token**

1. In Trilium, open **Options**.
2. Go to **ETAPI**.
3. Create a new ETAPI token and copy it.

Keep the token private — it grants applications access to your Trilium instance.

**Create an email archive note**

Create a note that will be the parent for imported emails, for example one
called `Emails`. Open the note's information/properties and copy its
**Note ID** (the add-on needs the Note ID, not the title).

### 2. Install the add-on

Either install the packaged extension, or load it temporarily for testing.

**Install from file**

Use Thunderbird's **Install Add-on From File** command and select the packaged
extension. A Thunderbird add-on package is simply a ZIP archive of this folder's
files; rename it to `.xpi` if Thunderbird's file picker requires that extension.

**Load temporarily (for development/testing)**

1. In Thunderbird, open **Add-ons and Themes → Extensions**.
2. Open the gear menu and choose **Debug Add-ons**.
3. Choose **Load Temporary Add-on** and select `manifest.json` from this folder.

### 3. Configure the add-on

Open the settings for **Send to Trilium** from the Add-ons and Themes page.

For a normal local TriliumNext Desktop installation, enter:

```text
Trilium URL:                 http://localhost:37840
ETAPI token:                 <your ETAPI token>
Destination parent Note ID:  <the Note ID of your Emails note>
```

Click **Save and test connection**. A successful connection confirms Thunderbird
can reach Trilium and that the destination note exists. If `localhost` does not
work, try `http://127.0.0.1:37840`.

## Importing an email

Import from either the message view or the message list: select or open one or
more emails, then choose **Send to Trilium** (from the toolbar action or the
right-click menu).

The add-on creates a Trilium note titled with the email subject, containing:

- sender, recipients and CC recipients;
- sent date and Message-ID;
- the message body;
- the attachment names.

### Message body and images

The body is imported either as plain text or, if you choose one of the
**Original formatting (sanitized HTML)** modes, with its layout preserved. All
HTML modes remove scripts and keep the email's embedded (inline) images — just
as a mail client shows inline images even when external content is blocked. You
then choose how remote/external images are handled:

- **Embedded images only** — remote images (including tracking pixels) are
  stripped for privacy and each is replaced by a small placeholder, so the
  layout stays intact.
- **Allow remote images** — remote images are also kept and shown, which means
  remote content may load when you open the note.

### Attachments and the original message

Depending on the settings, attachments are imported as child notes, and the
complete original email can be stored as a child `.eml` file preserving the
original MIME message:

```text
Emails
└── Project proposal
    ├── proposal.pdf
    ├── budget.xlsx
    └── Project proposal.eml
```

The email note itself gets an `#email` label and an envelope icon
(`#iconClass=bx bx-envelope`). Each attachment child gets an `#email_attachment`
label and the preserved original message gets `#file_type=eml`, so you can find
them with a search.

### Encrypted messages

Encrypted emails (PGP/MIME or S/MIME) are skipped instead of being imported as
unreadable notes. The completion summary reports how many were skipped.

## Date handling

The add-on can associate the email with the date on which it was sent. Available
options:

- **Daily note clone + calendar**
- **Daily note clone only**
- **Calendar only**
- **Neither**

### Daily note clone

When enabled, the imported email is also shown underneath the corresponding
Trilium daily note:

```text
Daily Notes
└── 2026-08-15
    └── Project proposal
```

This is a **Trilium clone**, not a separate copy: the note under `Emails` and
the note under the daily note are the same note shown in two places. The date is
taken from the message's sent date and converted to `YYYY-MM-DD` in the
computer's local timezone; ETAPI obtains or creates the day note and adds a
branch for the email beneath it.

### Calendar

When enabled, the note receives the calendar's native labels for the day and
time the email was sent:

```text
#startDate=2026-08-15
#startTime=13:22
```

A Trilium calendar view then shows the email as an event at that moment. There
is no `#endTime` (an email has no duration), so the calendar renders it as its
default-length block. These labels are also useful for Trilium searches, tables
and scripts.

## Note color

The settings page has an optional **Note color** field. Enter a CSS color (for
example `#3788d8` or `teal`) and imported emails get a `#color` label so they
stand out in the note tree. Leave it blank for no color.

## Duplicate detection

Each imported note gets an `emailImportKey` label. For messages with a
Message-ID, the key is the SHA-256 of the normalized Message-ID; if the
Message-ID is absent, it is the SHA-256 of the raw RFC-822 message.

Before creating a note, the add-on searches for an existing note with the same
key. If one is found it does **not** create a second note or duplicate
attachments — this prevents accidental duplicates when **Send to Trilium** is
used twice on the same message. It does re-apply the configured date behavior,
so enabling daily-note clones later can place an already-imported email beneath
the correct day.

## Recommended settings

For normal use:

```text
Import attachments:        enabled
Preserve original .eml:    enabled
Date handling:             Daily note clone + calendar
```

This gives you a central searchable email archive, access from the relevant
daily note, searchable date metadata, the original attachments, a complete
archival `.eml` copy, and duplicate protection.

## Troubleshooting

**`401 NOT_AUTHENTICATED`** — Trilium is reachable but the request is not
authenticated. Check that the correct ETAPI token is entered in the settings.

**`NetworkError when attempting to fetch resource`** — verify Trilium Desktop is
running. Open `http://localhost:37840/etapi/app-info` in your browser; a
`401 NOT_AUTHENTICATED` response is actually useful here, since it confirms the
ETAPI server is reachable. If necessary, try `http://127.0.0.1:37840`.

**Emails are not appearing where expected** — check that the **Destination
parent Note ID** points to the intended note. The add-on needs the Note ID, not
the note title.

## Notes for developers

**Host permissions.** Firefox/Thunderbird WebExtension match patterns do not
include port numbers. Version 0.2.0 incorrectly requested a pattern such as
`http://localhost:37840/*`. Version 0.2.2 requests `http://localhost/*` (and
`http://127.0.0.1/*`) while continuing to connect to the configured URL, for
example `http://localhost:37840`.

**Typical workflow**

```text
Receive email in Thunderbird
        ↓
Select "Send to Trilium"
        ↓
Email is stored under "Emails"
        ↓
Attachments and original .eml are preserved
        ↓
Same note appears under the corresponding daily note
        ↓
#startDate / #startTime place it on the calendar and provide date metadata
```

## License

Released under the GNU General Public License v3.0. See the [LICENSE](LICENSE)
file for the full text.
