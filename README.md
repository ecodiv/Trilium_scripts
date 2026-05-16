# Trilium weekly task planner

<!--ts-->
## Table of Contents

* [What is it](#what-is-it)
* [Get it to work](#get-it-to-work)
  * [Requirements](#requirements)
  * [Setup](#setup)
  * [First test](#first-test)
* [Using it](#using-it)
  * [Daily flow](#daily-flow)
  * [How tasks work](#how-tasks-work)
  * [The day card](#the-day-card)
  * [Progress](#progress)
  * [Backlog](#backlog)
  * [Scheduling by drag & drop](#scheduling-by-drag-drop)
  * [Scheduling by @date](#scheduling-by-date)
  * [Quick capture](#quick-capture)
  * [Tags](#tags)
  * [Filtering](#filtering)
  * [Header controls](#header-controls)
* [Configuration](#configuration)
  * [Available settings](#available-settings)
  * [Data safety](#data-safety)
  * [State note](#state-note)
  * [Recovery](#recovery)
* [Trouble shooting](#trouble-shooting)
  * [Symptom: Initialization error or planner stuck on Loading...](#symptom-initialization-error-or-planner-stuck-on-loading)
  * [Symptom: planner loads but tasks are not in the right days](#symptom-planner-loads-but-tasks-are-not-in-the-right-days)
  * [Symptom: colour override setting has no effect](#symptom-colour-override-setting-has-no-effect)
  * [Symptom: archived notes appear but you want to exclude them](#symptom-archived-notes-appear-but-you-want-to-exclude-them)
  * [Ultimate option](#ultimate-option)
* [Limitations](#limitations)

<!--te-->

## What is it

Task Planner is a weekly planner for [Trilium Notes](https://triliumnotes.org/), the powerfull and flexible app for note-taking and organizing a personal knowledge base. It finds task lines written directly inside your notes and shows them on a planning board.

Type e.g., `TODO buy milk` anywhere in a daily note, meeting note, or project note. The task appears in the planner. Drag it to a day column to schedule it. Mark it done from the planner, and the original source line is greyed out in place.

The planner supports four task types: `TODO`, `IDEA`, `CHECK`, and `TOREAD`. You can schedule tasks by dragging them, or by adding date tokens such as `@today`, `@tomorrow`, `@fri`, or `@2026-05-20`.

![](images/overview.png)

_Figure 1. Overview: the planner with Backlog and seven day columns. It is full-width on the desktop. On mobile (window narrower than 700px), all columns are fixed-width and the board scroll_

This tool builds on the [weekly planner](https://github.com/orgs/TriliumNext/discussions/9676) tool by [ricolandia](https://github.com/ricolandia), adopting the main principles, but with some tweaks to accomodate specific needs. The weekly planner in turn was inspired by the [Task-hub tool](https://github.com/ZangXincz/TriliumNext-Task-Hub) by [ZangXincz](https://github.com/ZangXincz). The tool was created with use of AI, and tested on Linux and Windows with TriliumNext 0.102.0 and 0.103.0.

## Get it to work

### Requirements

The planner expects:

1.  one JSX note containing `planner.jsx`
2.  one JSON note labelled `#plannerdata`
3.  one Render note with `~renderNote` pointing to the JSX note

The planner scans all text notes in the whole Trilium database. Archived notes are scanned by default as well. You can change this behaviour by adding the label `#wp_scan_archived=false` to the `#plannerdata` note. After adding the note, do `F5` or `Ctrl-Shift-R` to refresh the screen.

### Setup

The weekly planner is a **Render Note** that runs inside Trilium as a regular note view. Its state and configuration are stored in a small JSON note that you create once. The underlying code is stored in a JSX note.

To set up the weekly planner, download `WeeklyPlanner.zip` and import it into Trilium. The imported notes behave like a custom plugin. The import contains three files:

1.  `planner.jsx`, the code that runs the planner
2.  `planner_data.json`, the state note

For better organisation, you may want to import everything inside a parent note such as `Tools`, `Plugins`, or `Addons`.

After importing:

1.  Open the imported `planner_data.json` note.
2.  Open its attributes.
3.  Add the label `#plannerdata`.
4.  Create a note of type **Render** anywhere in your tree.
5.  Add a relation `~renderNote` from the Render note to the imported `planner.jsx` note.
6.  Open the Render note to run the planner.

### First test

After setup, try this small test:

1.  Open any text note.
2.  Add a line starting with `TODO test planner`.
3.  Open the planner.
4.  Confirm that the task appears in Backlog.
5.  Drag it to a day column.
6.  Click `✓` and confirm that the source line is greyed out.

This confirms that scanning, scheduling, saving, and completion all work.

## Using it

### Daily flow

One way to use the weekly planner:

1.  **Capture as you go.** Type `TODO ...` while you are in a meeting, project document, or daily note. Do not think about where it goes. The planner will find it.
2.  **Use** `**@today**`**,** `**@tomorrow**`**, or** `**@fri**` for things that already have a date in mind. Skip dates for everything else.
3.  **Open the planner once a day.** Drag Backlog items into days based on what you actually want to do.
4.  **During the day**, mark items done by clicking the `✓` on each card. Greyed source lines show what you have completed.
5.  **Click a card** when you want to work on the task. The side panel opens the source note alongside the planner, so you can update it in context.
6.  **At the end of the week**, click `↺` if the current week's plan was speculative and you want a clean slate. Unplanned tasks stay in Backlog.

### How tasks work

The planner scans every text note in the whole Trilium database for lines that start with one of four prefixes:

| Prefix | Meaning | Default colour |
| --- | --- | --- |
| `TODO` | Actionable task | orange |
| `IDEA` | Captured thought | blue |
| `CHECK` | To verify or review | green |
| `TOREAD` | Reading queue | purple |

Prefixes are case-sensitive and must be followed by a space. They must appear at the start of a paragraph, at the start of a list item, or after a `<br>`. Anything else, such as `My TODO list:` in prose, is ignored.

Archived notes are included in the scan by default. To exclude archived notes, add the label `#wp_scan_archived=false` to the `#plannerdata` note.

> [!WARNING] A task's planned day is linked to its generated task ID. Editing the first 48 characters of a task can make the planner treat it as a new task, so the planned day may be lost.

### The day card

Each task is rendered as a small card showing the kind chip in its colour, the task text, the `@date` suffix in light grey if one exists, any `#tags` as grey pills, and the source note title below.

![](images/day_card.png)

_Figure 2: Task cards with ✓ button visible on hover, kind chip, date suffix and tag pil_

The `✓` button in the top-right corner is the mark-done action. On desktop it appears on hover. On touch devices it is always visible. Clicking it removes the task from the planner. The line stays in your source note, greyed out, as a record of completion. You can also set progress, see below.

> [!NOTE] Done items are not cleaned up automatically. Delete them manually when you want a tidy source note.

Clicking anywhere else on the card opens the source note. The default action opens it in a **side panel** alongside your current view. To open the source note as a new tab, use `Ctrl-click`, `Cmd-click` or `middle-click`.

### Progress

Each card has a thin progress bar along its bottom edge. Click the bar to advance progress in 25% steps: 0 → 25 → 50 → 75 → 0. The bar is purely a visual way to track progress. The ✓ button is the only way to mark a task done. This will marked the task as done, greyed in its source note, and removed from the planner.

Progress is stored only in the `#plannerdata` JSON, under the `_progress` key. The source note is never modified for partial progress — only the final completion at 100% writes back to the source. Progress survives reloads and is preserved when dragging cards between days.

> [!NOTE]
> The progress bar sits at the very bottom edge of the card (about 5 pixels tall). If you start a drag from there, you'll click the bar instead. Drag from the body of the card to avoid this.

### Backlog

Tasks without a planned date live in the Backlog column. Drag a task from a day column back to Backlog to unschedule it. Clearing all planning for the currently visible week will also return scheduled tasks to the backlog column.

![](images/clear_week.svg)

_Figure 4. Clear the selected week_

### Scheduling by drag & drop

On the desktop, drag a card between Backlog and any day column. A blue line shows where the card will land. Drop position is preserved within a day. The planner remembers card order per day, not just which day a task belongs to.

On mobile, tapping a card opens the source note. Scheduling by drag is supported, but can be fiddly on small screens. For mobile use, the most reliable method is to add an `@date` suffix such as `@today`, `@fri`, or `@2026-05-20`.

### Scheduling by @date

Append `@date` anywhere in the task text to auto-schedule:

```
TODO call the dentist @tomorrow
IDEA new pricing model @fri
CHECK Q3 invoices @2026-05-20
TOREAD Hofstadter essay @sat
```

Recognised tokens are `@today`, `@tomorrow`, `@mon` through `@sun`, and any ISO date in the form `@YYYY-MM-DD`. Unrecognised tokens stay in the text and do not schedule the task.

### Quick capture

The input bar above the board appends a new task to **today's daily note**, creating that note if it does not exist. By default the kind is `TODO`, but if you type a known prefix, that prefix is respected.

Press Enter or click the `add` button to save the card. The board reloads automatically, and `@date` suffixes are applied immediately.

### Tags

Add `#tag-name` anywhere in a task text to tag it:

```
TODO call mom #personal
TODO deploy staging #work #urgent
```

Tags display as small grey pills on the card and feed the filter dropdown. Tags must start with a letter and can include letters, digits, underscores, and hyphens. Tags stay in the source note and do not move.

### Filtering

You can filter the tasks on the type of task and on their tags. 

![](images/filter.png)

_Figure 5. Filter dropdown showing kind checkboxes and tag list._

Click the **Filter** button in the top-right of the planner header. The dropdown shows:

| Filter type | Behaviour |
| --- | --- |
| Kinds | Checkboxes for each prefix type that has at least one task. Toggle them to hide or show task kinds. |
| Tags | Checkboxes for every tag found across all tasks. Multiple selected tags are combined with AND, so a task must have all selected tags to show. |

If no kinds are selected, all kinds show. If no tags are selected, tag filtering is off. The active filter count appears as a small blue badge on the Filter button. **Clear filters** resets both kind and tag filters.

Filters persist across reloads and are stored in the `#plannerdata` JSON.

### Header controls

From left to right:

| Control | Action |
| --- | --- |
| **‹** | Previous week |
| **›** | Next week |
| **today** | Jump to the current week. Only visible when you are not already viewing the current week. |
| **N/M planned** | N tasks scheduled this week out of M total tasks |
| **Filter** | Open the filter dropdown |
| **↺** | Clear all planning for the currently visible week. The planner asks for confirmation first. |
| **⟳** | Re-scan all notes for tasks |

Use the reload button after you have edited tasks in source notes to get those into the weekly planner (this does not happen automatically)

## Configuration

The weekly planner uses the `planner_data.json` note to store which tasks are scheduled to which days, the order of cards within a day, the backlog width, and your active filters.

You do not normally need to edit this note's content. To change a setting, edit the **attributes (labels)** of the `#plannerdata` note. After changing a label, refresh the planner with `Shift + Ctrl + R`, the `⟳` button, or a page reload.

### Available settings

All settings are labels you add to the `#plannerdata` note. They all share the `wp_` prefix to keep them grouped in the attributes pane.

| Setting | Description |
| --- | --- |
| `#wp_scan_archived=false` | Excludes archived notes from the scan. By default, archived notes are scanned. Accepted false-y values: `false`, `no`, `0`, `off`. |
| `#wp_backlog_width=<pixels>` | Sets the default width of the Backlog column on desktop. Example: `#wp_backlog_width=320`. Range: 150 to 600. Without this label, the default is 260px. |
| `#wp_todo=<colour>` | Overrides the `TODO` chip colour. Accepts any CSS colour, such as `#ed7a2a`, `red`, `rgb(120,60,200)`, or `hsl(20 80% 60%)`. Default: orange. |
| `#wp_idea=<colour>` | Overrides the `IDEA` chip colour. Default: blue. |
| `#wp_check=<colour>` | Overrides the `CHECK` chip colour. Default: green. |
| `#wp_toread=<colour>` | Overrides the `TOREAD` chip colour. Default: purple. |
| `#wp_bg_task=<colour>` | Background colour of task cards. Default: `#f3f3f3`. |
| `#wp_bg_panel=<colour>` | Background colour of the day and Backlog columns. Default: `#fafafa`. |
| `#wp_color_done_text=<colour>` | Colour applied to the grey-out span around finished `DONE` lines in source notes. Default: `#cfcfcf`. |
| `#wp_color_done_btn=<colour>` | Colour of the green `✓` mark-done button on cards. Default: `#79a574`. |
| `#wp_color_date_tag=<colour>` | Colour of the inline `@date` token shown on cards. Default: `#a8a8a8`. |
|`#wp_color_progress=<colour>` | Color of the progress bar. Default: `#79a574` |

The user can also set the Backlog width interactively by dragging the right edge of the Backlog column. The dragged value is saved into the `#plannerdata` JSON and takes precedence over `#wp_backlog_width` until the saved value is cleared.

If something goes wrong and the JSON content becomes corrupted, the [Recovery](#recovery) section explains how to edit or reset it safely.

### Data safety

The planner does not move task text into the JSON state note. Your tasks remain in their original notes. The `#plannerdata` note stores only scheduling, ordering, backlog width, and filters.

The planner modifies source notes when you mark a task done. It also writes to today's daily note when you use quick capture.

### State note

The `#plannerdata` note's content is a JSON document storing:

| State item | Example |
| --- | --- |
| Scheduled day per task | `taskId` to ISO date |
| Within-day ordering | `_order: { ISO-date: [taskIds...] }` |
| Saved backlog width | `_backlogWidth: pixels` |
| Saved filters | `_filters: { kinds, tags }` |

A populated file looks roughly like this:

```
{
  "abc123::TODO::call_the_dentist": "2026-05-15",
  "abc123::TODO::buy_milk": "2026-05-15",
  "def456::IDEA::new_pricing_model": "2026-05-17",
  "_order": {
    "2026-05-15": [
      "abc123::TODO::buy_milk",
      "abc123::TODO::call_the_dentist"
    ]
  },
  "_backlogWidth": 320,
  "_filters": { "kinds": [], "tags": ["work"] }
}
```

Keys that start with `_` are planner metadata. All other keys are task IDs mapping to ISO dates. The file is written automatically every time you drag a card, mark a task done, change filters, or resize the backlog. You do not normally need to edit it, but you can if needed. See [Recovery](#recovery) for safe ways to do that.

> [!IMPORTANT]
> Tasks are identified by a hash derived from `noteId`, kind, and the first 48 characters of text. Editing a task's text can invalidate its ID, so its scheduled day is forgotten. If you need to edit a task without losing its day, edit after the first 48 characters where possible. If the task becomes unscheduled, drag the card back to the correct column afterwards. The new ID will be scheduled correctly.

### Recovery

If the planner will not load, or shows odd behaviour after a Trilium upgrade, the cause is often something in `#plannerdata`. Start with the least destructive fix.

## Trouble shooting

### Symptom: Initialization error or planner stuck on Loading...

Open the `#plannerdata` note and look at its content. If it is not valid JSON, the planner's red error banner should show the parsing error. Common causes are:

1.  trailing commas, smart quotes, or missing brackets after hand-editing
2.  an aborted save, which is rare but possible if Trilium crashed mid-write

**Fix:** replace the entire content with a minimal valid state and reload:

```
{}
```

This empty object gives the planner no scheduled tasks, the default backlog width, and no filters. All source notes and source tasks are untouched. Only day assignments and ordering are lost.

### Symptom: planner loads but tasks are not in the right days

This can happen if some task IDs changed, usually because you edited the first 48 characters of task text. It can also happen after imports, migrations, or timezone-related changes. In these cases the source notes are still correct. Only the planner's mapping is wrong.

**Fix:** drag the affected cards to where they should be. The new state saves immediately.

If many cards are wrong, you can wipe only the scheduling portion of the state. Edit `#plannerdata` content to remove everything except metadata:

```
{
  "_backlogWidth": 320,
  "_filters": { "kinds": [], "tags": [] }
}Filter dropdown showing kind checkboxes and tag list image widget
```

All tasks become unscheduled and return to Backlog. Your backlog width and filter configuration are preserved.

### Symptom: colour override setting has no effect

Check these points:

1.  The label name is exact, for example `wp_todo`, using lowercase letters and underscores. All settings use the `wp_` prefix.
2.  The value parses as a CSS colour. Try `#ff0000` first. If that works, the original colour string was the problem.
3.  You reloaded the planner with the `⟳` button, `F5`, or `Shift + Ctrl + R` after changing the setting.

### Symptom: archived notes appear but you want to exclude them

Archived notes are scanned by default. To exclude them, add the label `#wp_scan_archived=false` to the `#plannerdata` note and reload the planner.

### Ultimate option

If something is deeply wrong, you can delete the `#plannerdata` note entirely and create a fresh one with the `#plannerdata` label and an empty body. The planner will treat it as a first-time setup. No source-note data is at risk, because `#plannerdata` only holds planner state and never holds task content.

## Limitations

| Limitation | What to do |
| --- | --- |
| Task IDs are not permanent. | Editing the first 48 characters of a task's text in its source note changes its ID, so its planned day mapping is lost. Drag it back where you want it. |
| Done items accumulate. | Greyed lines stay in source notes. There is no automatic cleanup. Delete them manually when you want a tidy source. |
| There is no real-time sync. | Edit tasks in source notes, then click `⟳` to reload the planner. |
| Mobile drag is awkward. | Touch drag works, but is not ideal on small screens. Prefer the `@date` suffix on mobile. |
| Duplicate task text may be confusing. | Avoid putting identical task lines with the same prefix in the same note unless the planner version you use explicitly handles duplicates. |
