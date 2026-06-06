# Trilium hours tracker

<!--ts-->
## Table of Contents

* [What is it](#what-is-it)
* [Get it to work](#get-it-to-work)
  * [Requirements](#requirements)
  * [Setup](#setup)
  * [First test](#first-test)
* [Using it](#using-it)
  * [Overview tab](#overview-tab)
  * [Entry tab](#entry-tab)
  * [Projects tab](#projects-tab)
  * [Charts tab](#charts-tab)
  * [Calendar](#calendar)
  * [Progress bar](#progress-bar)
  * [Schedule model](#schedule-model)
  * [Planned vs needed hours per week](#planned-vs-needed-hours-per-week)
* [Data storage](#data-storage)
  * [The data note](#the-data-note)
  * [Data safety](#data-safety)
  * [State note](#state-note)
  * [Recovery](#recovery)
* [Trouble shooting](#trouble-shooting)
  * [Symptom: Initialization error or tracker stuck on Loading...](#symptom-initialization-error-or-tracker-stuck-on-loading)
  * [Symptom: more than one data note](#symptom-more-than-one-data-note)
  * [Symptom: hours appear to be lost after editing a week](#symptom-hours-appear-to-be-lost-after-editing-a-week)
  * [Ultimate option](#ultimate-option)
* [Limitations](#limitations)

<!--te-->

## What is it

Hours Tracker is a project-hours widget for [Trilium Notes](https://triliumnotes.org/), the powerful and flexible app for note-taking and organizing a personal knowledge base. It lets you define projects that run over a fixed span of calendar weeks with a total hour budget, then log the hours you actually work each week.

For each project it shows: how many hours you have worked, how many remain, the hours per week you planned (the budget spread evenly over the working weeks), and the hours per week you actually need over the weeks still ahead of you to finish on budget. When what you need per week is higher than what you planned, it is highlighted in red, so a project that is running behind stands out at a glance.

The schedule follows the calendar. A project has a start week and an end week, and the weeks in between are its working weeks. Weeks you are not working at all, such as holidays, can be marked on a shared calendar and are excluded from every project's working-week count, so the plan stays honest without manual adjustment. Burn-up charts show the same picture visually: your actual cumulative hours against the evenly spread plan line.

## Get it to work

### Requirements

The tracker expects:

1. one JSX note containing `track_hours.jsx`
2. one Render note that points to the JSX note through a `#renderNote` label set to the JSX note's `noteId`

The data note is created automatically on first load as a child of the JSX note. You do not need to create it manually.

### Setup

The Hours Tracker is a **Render Note** that runs inside Trilium as a regular note view. Its data is stored in a small JSON child note that the widget creates itself.

To set up the tracker, copy the contents of `track_hours.jsx` into a new note in Trilium:

1. **Options → Code Notes → enable "JSX"**.
2. Create a note of type **Code**, set the language to **JSX**, and paste the file contents into it.
3. Create a note of type **Render Note** anywhere in your tree.
4. On the Render Note, add a label `#renderNote` with the value set to the `noteId` of the JSX note. (The label lives on the Render Note and points *to* the code note; the code note itself needs no label.)
5. Open the Render Note to run the tracker.
6. On first load the tracker auto-creates one helper note as a child of the JSX note, titled `Hours Tracker Data`, carrying a `#hourdata` label. It is a JSON note that holds all information about the projects and entered weekly hours.

> [!TIP]
> For better organisation, you may want to place the JSX note under a parent note such as `Tools`, `Plugins`, or `Addons`.

### First test

After setup, try this small test:

1. Open the tracker and go to the **Projects** tab.
2. Click **+ New project** and fill in a name, a total hour budget (e.g. `40`), and select a start week (e.g. `2026-W22`), and an end week (e.g. `2026-W25`).
3. Switch to the **Entry** tab and set the week to `2026-W22`. The project appears in the week overview; click its ✎ button to open the hour editor.
4. Enter some hours and click **Save**.
5. Switch to the **Overview** tab and confirm that the project card shows the hours you entered and an updated remaining budget.

This confirms that project management, hour entry, saving, and calculation all work.

## Using it

The tracker has four labelled tabs, **Charts**, **Overview**, **Entry** and **Projects**, plus a calendar icon at the right of the tab row for marking non-working weeks.

### Overview tab

The Overview tab is the main dashboard. It shows one card per active (non-archived) project, plus a summary bar across the top.

The **summary bar** shows totals across all active projects: total hour budget, hours worked so far, and total remaining budget.

Each **project card** shows:

| Field | Meaning |
| --- | --- |
| Total budget | The total hours you have available for this project. |
| Remaining budget | Budget minus hours worked so far. |
| Planned/week | Budget ÷ total working weeks. The even rate across the whole span. |
| Needed/week | Remaining budget ÷ remaining working weeks. The hours per week required from the current week onward. Highlighted in red when it is higher than planned/week, i.e. when you are behind. |
| Working weeks left | Working weeks from the current week through the end week, holidays excluded. Highlighted in red when it reaches zero while budget remains. |

A color band appears at the top of the card when a color has been set for the project.

A thin progress bar below the project name shows the percentage of the total budget that has been worked. The percentage is also shown in the bottom-right corner of the card. A line beneath the stats restates the plan in words, for example `80h ÷ 8 working wks = 10.0h/wk · need 12.0h/wk from here`.

The ✎ button opens the project edit form in the Projects tab.

### Charts tab

The Charts tab provides a more visual overview of the status of your projects. It shows a **burn-up** chart per project: a cumulative line of the hours you have actually logged, drawn against a straight planned line that spreads the budget evenly across the working weeks. Where the actual line sits above the planned line you are ahead; below it, behind. A readout gives the cumulative gap in hours at the current week.

By defaul, the tab shows all project in a grid. Chips above the chart let you choose which projects to include or exclude. If you only one, it is shown large with more detail. 

### Entry tab

The Entry tab is where you log hours worked. It opens **overview-first**: you pick a week, and it shows every project open that week, with each project's hours opened for editing one at a time.

The **picker bar** at the top holds the week selector. Use the ‹ and › buttons to step one week back or forward, or type directly in the week input. The **Today** button jumps the selector to the current ISO week.

Below the picker, the **week overview** lists every active project whose start–end range includes the selected week. Each row shows the project name (and code), the hours logged so far, and a needed/week hint; projects with no entry yet are marked **not filled in**. A footer line counts how many projects still need filling in. If no project is open for the selected week, the overview says so. This is the at-a-glance view of what the week still needs.

To enter or change hours, click the ✎ button on a project's row. This opens that project's inline editor, and a **‹ Overview** button appears in the picker bar to return. The editor shows every week in the project's writable range that already has an entry, plus the selected week (always included so it can be filled in even if it has no entry yet), newest first, with the selected week highlighted.

Each week row lets you enter one or more hour values. Use **+ entry** to add another value in the same week (useful for logging separate sessions). The total for the week is shown below the week key.

Click **Save** to write the entries to the data note; saving the selected week returns you to the overview. **Cancel** discards changes and closes the editor. The ✕ button clears all hours for that project in that week (after confirmation).

> [!NOTE]
> Hours are stored per project per week as an array of numbers (e.g. `[2, 3, 1.5]`). All values in the array are summed to give the week total. Saving an empty set of entries removes that week from the stored data for that project.

### Projects tab

The Projects tab lists all projects and lets you create, edit, archive, and delete them.

Click **+ New project** to open the project form. Fill in:

| Field | Description |
| --- | --- |
| Name | A display name for the project. Required. |
| Project code | A short code shown alongside the name on cards and in the Entry overview, e.g. `ACME-2025`. Optional. |
| Color | A color band shown at the top of the project card. Optional. Click the color swatch to pick, or click **None** to remove it. |
| Total available hours | The total hour budget. Must be > 0. |
| Start week | The first ISO week of the project. Required. Only weeks on or after the start week are open for logging. |
| End week | The last ISO week of the project. Required. Together with the start week it defines the working-week span. |
| Planned/week | Computed automatically: total hours ÷ working weeks in the span. Shown as a live preview while you type. |

Both week fields use a native week picker. The end week must not be before the start week; the form refuses to save if it is.

Click **Save** to add or update the project. The planned/week value is always derived; it is never stored separately.

To edit an existing project, click the ✎ button on its card in the Overview tab, or in the project list. To archive a project, click the 🗄 button in the project list; archived projects are hidden from the Overview tab and from the Entry tab's week overview. Click ↩ to unarchive. Archived projects and all their hour records can be permanently removed with the **Clean up archived** button.

The **Export CSV** button downloads all hour records as a CSV file with columns Week, Project, Code, and Hours (one row per project per week, hours summed). The button is disabled when there are no records to export. In some Trilium environments the file-save dialog is unavailable; if so, the widget opens the CSV in a new tab or shows it on screen for manual copying.

### Calendar

The calendar icon at the right of the tab row opens a year grid of ISO weeks. Click a week to mark it as a **holiday**, a week you are not working at all. Holidays are global across every project and are excluded from each project's working-week count, so a holiday is neither time you fell behind nor capacity you have left.

Holiday weeks remain fully writable; if you do log hours in a holiday week, those hours still count against the budget. Use the ‹ and › buttons to change year, or **This year** to jump back. A count of holiday weeks for the displayed year is shown.

### Progress bar

Each project card has a thin bar below the project name. It fills proportionally to `hours worked / total budget`, capped at 100%. The percentage is also shown as plain text in the bottom right of the card.

The bar is purely visual. It updates automatically whenever you save new hours.

### Schedule model

The tracker uses a **calendar** model. A project runs from its start week to its end week, and the working weeks are the calendar weeks in that span minus any marked as global holidays. This means:

- The plan is anchored to real dates, not to which weeks you happened to log. The planned hours per week is the budget spread evenly over the working weeks of the span.
- The required hours per week looks forward from the current week: remaining budget divided by the working weeks still ahead of you, holidays excluded. As real weeks pass, the weeks left shrink and the needed figure adjusts on its own.
- Holiday weeks drop out of the counts on both sides, so a week off neither counts against you nor frees up capacity you do not have.
- Logging the same week twice replaces the previous entries for that week; it does not double-count.

If a project spans 20 weeks but you take two off, mark those two as holidays and the plan adjusts around them. You never have to correct the budget by hand.

> [!NOTE]
> The current week, and therefore the weeks left and the needed hours per week, is read from today's date at the moment the tracker loads. Reload the widget to refresh it.

### Planned vs needed hours per week

Two hours-per-week figures describe a project:

| Figure | How it is computed | What it tells you |
| --- | --- | --- |
| **Planned/week** | Total budget ÷ total working weeks in the span. | The even rate you set out to keep. |
| **Needed/week** | Remaining budget ÷ remaining working weeks. | The hours per week required from now on to finish on budget. |

When needed/week is higher than planned/week you are behind, and the needed/week figure on the card turns red. When it is lower you are ahead. The Charts tab shows the same comparison as the gap between the actual and planned lines.

## Data storage

### The data note

The tracker stores all its data in a single child note of the JSX note: a JSON code note labelled `#hourdata` and titled `Hours Tracker Data`. This note is created automatically on first load and does not need to be set up manually.

You do not normally need to edit this note. Its content is a JSON object with the keys `projects`, `weeks`, and `holidays`.

### Data safety

The tracker never modifies any note other than its own `#hourdata` child note. No source notes are touched. Deleting the `#hourdata` note resets all tracker state (projects, hour entries, and holidays) but nothing else in your database.

### State note

The `#hourdata` note's content is a JSON document storing:

| State item | Example |
| --- | --- |
| Projects list | `projects: [{ id, name, code, color, totalHours, startWeek, endWeek, archived }]` |
| Hours per project per week | `weeks: { "2026-W22": { "proj_123": [2, 3, 1.5] } }` |
| Global holiday weeks | `holidays: ["2026-W31", "2026-W32"]` |

A populated file looks roughly like this:

```
{
  "projects": [
    { "id": "proj_1748000000000", "name": "Website redesign", "code": "WEB-26",
      "color": "#4a90d9", "totalHours": 80,
      "startWeek": "2026-W20", "endWeek": "2026-W28", "archived": false },
    { "id": "proj_1748000000001", "name": "Client report", "code": "",
      "color": "", "totalHours": 20,
      "startWeek": "2026-W22", "endWeek": "2026-W25", "archived": false }
  ],
  "weeks": {
    "2026-W22": {
      "proj_1748000000000": [3, 2],
      "proj_1748000000001": [1.5]
    },
    "2026-W23": {
      "proj_1748000000000": [4]
    }
  },
  "holidays": ["2026-W31"]
}
```

The `projects` array is the source of truth for budgets and spans. The `weeks` object maps week keys to per-project arrays of hour entries. The `holidays` array lists weeks excluded from every project's working-week count. The file is written automatically every time you save an entry, add or edit a project, clear a week, or toggle a holiday.

> [!IMPORTANT]
> Project IDs are generated from `Date.now()` at creation time. Deleting a project and recreating it with the same name produces a new ID. Any week entries stored under the old ID are not deleted automatically, but they will no longer be associated with the new project. Use the **Ultimate option** below if you want a fully clean slate.

### Recovery

If the tracker will not load, or the data looks wrong, the cause is usually something in `#hourdata`. Start with the least destructive fix.

## Trouble shooting

### Symptom: Initialization error or tracker stuck on Loading...

Open the `#hourdata` note and inspect its content. If it is not valid JSON, the tracker will fail to initialize. Common causes are:

1. trailing commas or missing brackets after hand-editing
2. an aborted save if Trilium crashed mid-write

**Fix:** replace the entire content with a minimal valid state and reload:

```
{ "projects": [], "weeks": {}, "holidays": [] }
```

This gives the tracker a clean slate with no projects, hour entries, or holidays. Nothing in your other notes is affected.

### Symptom: more than one data note

If more than one note carries the `#hourdata` label, the tracker refuses to load and shows a banner listing the candidates rather than guessing which one to write to. This is deliberate: it avoids silently saving into the wrong note.

**Fix:** decide which note is the real one, remove the `#hourdata` label from (or delete) the others, and reload. The tracker will then resolve the single remaining note.

### Symptom: hours appear to be lost after editing a week

Hour entries are keyed by project ID, not by name, so renaming a project keeps its hours intact. The risk is deletion: if you deleted a project, its entries are still in the `weeks` object but are no longer associated with any project.

You can recover them by hand-editing `#hourdata`: find the old project ID in the `weeks` keys and re-add a project entry with that same ID to the `projects` array. If that is too complex, see the **Ultimate option** below.

### Ultimate option

If something is deeply wrong, you can delete the `#hourdata` note entirely and let the tracker recreate it on the next load. The new note will be empty (`{ "projects": [], "weeks": {}, "holidays": [] }`). No notes outside the tracker are at risk.

## Limitations

| Limitation | What to do |
| --- | --- |
| There is no weekly calendar view of entries. | The tracker is project-centric. Use the Entry tab's week overview to see all projects' status for a given week. |
| Week keys must be entered manually when typing in the week field in the Entry tab. | Use the ‹/› step buttons or the native week picker to avoid typing. |
| The current week, weeks left, and needed hours per week are not live. | They are calculated once when the tracker loads. Reload the widget to refresh them. |
| Archiving a project does not remove its week entries from the JSON. | Use **Clean up archived** in the Projects tab to permanently remove archived projects and all their hour records. |
| There is no real-time sync. | Data is written on every save action. If you have two tracker views open simultaneously, the second save will overwrite the first. |
| CSV export may fall back to a new browser tab. | In some Trilium environments the file-save dialog is unavailable. If so, the widget opens the CSV in a new tab or shows it on screen for manual copying. |
