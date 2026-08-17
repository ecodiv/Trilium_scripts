## <img width="50" src="logo.svg" /> ICS2Trilium widget

A [Trilium Notes](https://triliumnotes.org/) launch-bar widget that imports
`.ics` calendar files (meeting invitations and events) into your **journal**.
Each event becomes a searchable note under the day note for its start date, with
the meeting details and the calendar's native date/time labels so it shows up in
a calendar view.

> Disclaimer: Created with help of Claude.ai

## What it does

Pick one or more `.ics` files. Every event (`VEVENT`) they contain becomes a
note placed under the day note (journal) for the event's start date, containing:

- The event title (`SUMMARY`) as the note title;
- A *When / Location / Join / Status* summary block;
- An **Organizer** section;
- An **Attendees** section (with each person's response status);
- A **Description** section.

Online-meeting join links (Microsoft Teams, Google Meet, or a plain `URL`) are
pulled out as a clickable **Join** line, and any links or email addresses inside
the description are made clickable — with long URLs shown by a short label — so
the note stays compact instead of becoming a wall of text.

```text
Journal
└── 2026
    └── 08 - August
        └── 2026-08-17 - Monday
            └── Project sync
```

Each event note also gets the calendar labels `#startDate`, `#endDate`,
`#startTime` and `#endTime`, so a
[calendar view](https://docs.triliumnotes.org/) shows it as an event. All-day
events get date labels only (no time), and a multi-day event's end date is
stored inclusively.

## Requirements

A TriliumNext installation.

## Setup

To set the import script up, follow the steps below:

1. Create a new note of type **JSX**.
2. Open [`ics2trilium.jsx`](ics2trilium.jsx), copy its full contents into the
   note, and save. Do **not** add a `#widget` label.
3. Open the **Global menu → Configure launchbar**. Right click on the *Visible
   Launchers* section, choose **Add a custom widget**, and set its **widget**
   field to the note you just created.
4. Reload Trilium (`Ctrl+R`).

A calendar button appears in the launch bar.

## Importing an event

Click the calendar button in the launch bar. A small dialog opens with two ways
to import:

- **Paste iCalendar text** — paste the event's `.ics` text into the box and click
  **Import**. When your browser allows it and the clipboard already holds
  calendar text, the box is filled in for you automatically, so you can just
  click **Import** (or press `Ctrl`/`Cmd`+`Enter`).
- **Choose a file** — click **Choose .ics file…** to pick one or more `.ics`
  files instead.

A message then confirms how many events were imported and how many duplicates
were skipped.

Pasting is handy when a mail client can only *copy* a single event to the
clipboard but cannot export it as a file. For example, in Thunderbird you can
copy the raw invitation text and paste it here directly, without first saving it
as an `.ics` file.

To get an `.ics` file (for the file route): most mail and calendar clients can
save or export a meeting invitation as `.ics`. They are also often included as an
attachment on an invitation email.

## Labels

Each imported event note gets:

| Label | Value |
| --- | --- |
| `#calendar_invite` | (present) — marks the note as an imported invitation |
| `#meeting` | (present) — marks the note as a meeting |
| `#startDate` | event start date, `YYYY-MM-DD` |
| `#endDate` | event end date, `YYYY-MM-DD` (inclusive) |
| `#startTime` | event start time, `HH:MM` (omitted for all-day events) |
| `#endTime` | event end time, `HH:MM` (omitted for all-day events) |
| `#calendarUid` | the event's `UID`, when present |
| `#calendarImportKey` | duplicate-detection key (see below) |

So you can find all imported invitations with a search such as
`#calendar_invite` or `#meeting`.

## Options

Configure the importer by adding labels to the **JSX note itself** (the note the
launcher points at). Both are optional; the defaults are shown in bold.

| Label | Values | Effect |
| --- | --- | --- |
| `#icsIconClass` | Boxicons class (**`bx bx-calendar-event`**) | Tree icon given to each imported event note. |
| `#icsColor` | CSS color (**empty**) | Add a `#color` label so imported events stand out in the note tree. |

For example, to colour imported invitations orange, add `#icsColor=orange` to the
JSX note and reload Trilium.

## Duplicate detection

Each imported note gets a `#calendarImportKey` label — the SHA-256 of the event's
`UID` (or of its title and start when it has none). Before creating a note the
widget checks for an existing note with the same key, so re-importing the same
invitation does not create a second copy; instead the existing note's labels are
refreshed and it is (re)linked into the journal.

## Notes on time zones

- UTC times (ending in `Z`) are converted to your local time.
- Times carrying a `TZID` or with no zone are stored as written (the event's own
  local wall-clock time), since the widget does not bundle a time-zone database.

## License

Released under the GNU General Public License v3.0. See the [LICENSE](../LICENSE)
file for the full text.
