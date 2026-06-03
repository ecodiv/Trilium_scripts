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
  * [Progress bar](#progress-bar)
  * [Status badges](#status-badges)
  * [Schedule model](#schedule-model)
  * [Deadline weeks](#deadline-weeks)
* [Data storage](#data-storage)
  * [Urendata](#urendata)
  * [Data safety](#data-safety)
  * [State note](#state-note)
  * [Recovery](#recovery)
* [Trouble shooting](#trouble-shooting)
  * [Symptom: Initialization error or tracker stuck on Loading...](#symptom-initialization-error-or-tracker-stuck-on-loading)
  * [Symptom: hours appear to be lost after editing a week](#symptom-hours-appear-to-be-lost-after-editing-a-week)
  * [Ultimate option](#ultimate-option)
* [Limitations](#limitations)

<!--te-->

## What is it

Hours Tracker is a project-hours widget for [Trilium Notes](https://triliumnotes.org/), the powerful and flexible app for note-taking and organizing a personal knowledge base. It lets you define projects with a total hour budget and a planned number of working weeks, then log the hours you actually work each week.

For each project it shows: how many hours you have worked, how many remain, whether you are ahead or behind your planned pace, and how many hours per week you need to put in over the remaining weeks to finish on budget.

The tracker works on the "working weeks" model: you enter hours week by week, and only the weeks where you actually log hours count against your schedule. A holiday or sick week simply goes unlogged and is not counted, so the plan stays realistic without any manual adjustment. You can optionally set an end week on a project to cap the remaining weeks by a real calendar deadline.

The tool was created with use of AI, and tested on TriliumNext.

## Get it to work

### Requirements

The tracker expects:

1. one JSX note containing `track_hours.jsx`
2. one Render note with `~renderNote` pointing to the JSX note

The data note (`#urendata`) is created automatically on first load as a child of the JSX note. You do not need to create it manually.

### Setup

The Hours Tracker is a **Render Note** that runs inside Trilium as a regular note view. Its data is stored in a small JSON child note that the widget creates itself.

To set up the tracker, copy the contents of `track_hours.jsx` into a new note in Trilium:

1. **Options → Code Notes → enable "JSX"**
2. Create a note of type **Code**, set the language to **JSX**, and paste the file contents into it.
3. Create a note of type **Render** anywhere in your tree.
4. Add a relation `~renderNote` from the Render note to the JSX note.
5. Open the Render note to run the tracker.
6. On first load the tracker will auto-create one helper note as a child of the JSX note:
   - `Hours Tracker Data` (`#urendata`) — JSON state: projects and entered weekly hours.

> [!TIP]
> For better organisation, you may want to place the JSX note under a parent note such as `Tools`, `Plugins`, or `Addons`.

### First test

After setup, try this small test:

1. Open the tracker and go to the **Projects** tab.
2. Click **+ New project** and fill in a name, a total hour budget (e.g. `40`), and a number of working weeks (e.g. `4`).
3. Switch to the **Entry** tab and add a week (e.g. `2026-W22`).
4. Enter some hours and click **Save**.
5. Switch to the **Overview** tab and confirm that the project card shows the hours you entered and an updated remaining budget.

This confirms that project management, hour entry, saving, and calculation all work.

## Using it

### Overview tab

The Overview tab is the main dashboard. It shows one card per project plus a summary bar across the top.

The **summary bar** shows totals across all projects: total hour budget, total remaining hours, and the cumulative difference between hours worked and hours planned so far. A negative difference is highlighted in red.

Each **project card** shows:

| Field | Meaning |
| --- | --- |
| Total budget | The total hours you have available for this project. |
| Remaining budget | Budget minus hours worked so far. |
| Planned/week | Budget ÷ total weeks. The pace you need to keep if all weeks are equal. |
| Needed/week | Remaining hours ÷ remaining weeks. Highlighted if it is more than 20% above the original planned/week. |
| Weeks left | Remaining working weeks (total weeks minus weeks with entries). Relabels to **Weeks left (deadline)** and highlights in red when the calendar deadline is the binding constraint. |

A thin progress bar below the project name shows the percentage of the total budget that has been worked. The percentage is also shown in the bottom-right corner of the card.

The ✎ button opens the project edit form (in the Projects tab). The ✕ button deletes the project after confirmation.

### Entry tab

The Entry tab is where you log hours worked.

**Select a project** using the dropdown at the top of the tab.

**Add a week** by typing a week key in `YYYY-Www` format (e.g. `2026-W22`) and clicking **+ Add week**. The current ISO week is pre-filled. Multiple weeks can be open at the same time.

Each week row lets you enter one or more hour values for that project in that week. Use **+ entry** to add another value in the same week (useful if you want to log individual sessions separately). The total for the week is shown below the week key.

Click **Save** to write the entries to the data note. Click ✕ to clear all hours for that project in that week.

> [!NOTE]
> Hours are stored per project per week as an array of numbers (e.g. `[2, 3, 1.5]`). All values in the array are summed to give the week total. Saving an empty set of entries removes that week from the stored data for that project.

### Projects tab

The Projects tab lists all projects and lets you create, edit, or delete them.

Click **+ New project** to open the project form. Fill in:

| Field | Description |
| --- | --- |
| Name | A display name for the project. Required. |
| Total available hours | The total hour budget. Must be > 0. |
| Total number of (working) weeks | How many working weeks the project spans. Must be > 0. |
| Start week (optional) | The first ISO week of the project, e.g. `2026-W22`. Stored on the project but not used in calculations. |
| End week (optional) | The last ISO week of the project, e.g. `2026-W47`. When set, caps the remaining weeks by the real calendar deadline. See [Deadline weeks](#deadline-weeks). |
| Planned/week | Computed automatically: total hours ÷ weeks. Shown as a live preview while you type. |

End week must not be before start week. Both fields accept `YYYY-Www` format only; any other value is rejected on save.

Click **Save** to add or update the project. The planned/week value is always derived; it is never stored separately.

To edit an existing project, click the ✎ button on its card in the Overview tab, or directly in the project list. To delete, click ✕ and confirm.

### Progress bar

Each project card has a thin green bar below the project name. It fills proportionally to `hours worked / total budget`, capped at 100%. The percentage is also shown as plain text in the bottom right of the card.

The bar is purely visual. It updates automatically whenever you save new hours.

### Status badges

Each project card carries a coloured badge in its header:

| Badge | Meaning |
| --- | --- |
| **On schedule** (green) | Difference between hours worked and hours planned so far is less than 0.5h. |
| **+Xh ahead** (green) | You have worked more hours than planned for the weeks logged so far. |
| **−Xh behind** (red) | You have worked fewer hours than planned for the weeks logged so far. |

The difference is calculated as `hours worked − (weeks entered × planned hours per week)`.

### Schedule model

The tracker uses a **working weeks** model rather than a calendar model. A week is only counted if you have logged at least one hour for a project in that week. This means:

- A holiday or sick week that goes unlogged does not count as a "passed" week. The remaining weeks and required pace are recalculated from the weeks you actually worked.
- There is no concept of "the current week" in the schedule. The tracker never assumes you are in any particular week; it only knows what you have told it.
- Logging the same week twice (saving and then saving again) replaces the previous entries for that week; it does not double-count.

This model is intentionally simple. If a project spans 20 weeks but you take two weeks off, you do not need to adjust the plan. Just keep logging, and the pace will self-correct.

### Deadline weeks

When a project has an **End week** set, the tracker introduces a second constraint on the remaining weeks alongside the working-weeks count:

- **Unspent weeks**: the number of planned working weeks that have not yet had any hours logged (totalWeeks − weeksEntered).
- **Calendar weeks left**: real ISO weeks from the current week up to and including the end week. The current (in-progress) week counts as 1.

The remaining weeks used for all calculations is `min(unspentWeeks, calendarWeeksLeft)`. When the calendar deadline arrives before the unspent plan weeks run out, the required hours/week rises to fit the remaining budget into the fewer real weeks left.

The "Weeks left" cell on the project card shows which constraint is active:

| Label | Meaning |
| --- | --- |
| **Weeks left** | The unspent working-weeks count is the binding constraint, or no end week is set. |
| **Weeks left (deadline)** (red) | The calendar deadline is closer than the remaining plan weeks. The required pace is driven by the deadline. |

Projects without an end week are not affected by the deadline logic — it is only active when an end week is set.

> [!NOTE]
> Calendar weeks left is calculated from today's date at the moment the tracker loads. It is not recalculated until you reload the widget.

## Data storage

### Urendata

The tracker stores all its data in a single child note of the JSX note: a JSON code note labelled `#urendata` and titled `Hours Tracker Data`. This note is created automatically on first load and does not need to be set up manually.

You do not normally need to edit this note. Its content is a JSON object with two keys: `projects` and `weeks`.

### Data safety

The tracker never modifies any note other than its own `#urendata` child note. No source notes are touched. Deleting the `#urendata` note resets all tracker state (projects and hour entries) but nothing else in your database.

### State note

The `#urendata` note's content is a JSON document storing:

| State item | Example |
| --- | --- |
| Projects list | `projects: [{ id, name, totalHours, totalWeeks, startWeek, endWeek }]` |
| Hours per project per week | `weeks: { "2026-W22": { "proj_123": [2, 3, 1.5] } }` |

A populated file looks roughly like this:

```
{
  "projects": [
    { "id": "proj_1748000000000", "name": "Website redesign", "totalHours": 80, "totalWeeks": 8,
      "startWeek": "2026-W20", "endWeek": "2026-W28" },
    { "id": "proj_1748000000001", "name": "Client report", "totalHours": 20, "totalWeeks": 4,
      "startWeek": "", "endWeek": "" }
  ],
  "weeks": {
    "2026-W22": {
      "proj_1748000000000": [3, 2],
      "proj_1748000000001": [1.5]
    },
    "2026-W23": {
      "proj_1748000000000": [4]
    }
  }
}
```

The `projects` array is the source of truth for budgets and plans. The `weeks` object maps week keys to per-project arrays of hour entries. The file is written automatically every time you save an entry, add or edit a project, or clear a week.

> [!IMPORTANT]
> Project IDs are generated from `Date.now()` at creation time. Deleting a project and recreating it with the same name produces a new ID. Any week entries stored under the old ID are not deleted automatically, but they will no longer be associated with the new project. Use the **Ultimate option** below if you want a fully clean slate.

### Recovery

If the tracker will not load, or the data looks wrong, the cause is usually something in `#urendata`. Start with the least destructive fix.

## Trouble shooting

### Symptom: Initialization error or tracker stuck on Loading...

Open the `#urendata` note and inspect its content. If it is not valid JSON, the tracker will fail to initialize. Common causes are:

1. trailing commas or missing brackets after hand-editing
2. an aborted save if Trilium crashed mid-write

**Fix:** replace the entire content with a minimal valid state and reload:

```
{ "projects": [], "weeks": {} }
```

This gives the tracker a clean slate with no projects and no hour entries. Nothing in your other notes is affected.

### Symptom: hours appear to be lost after editing a week

This can happen if you edited the project name while hours were already stored, then deleted the old project and added a new one. Hour entries are keyed by project ID, not by name. Renaming does not change the ID, so hours are safe during a rename.

If you deleted the project, the entries are still in the `weeks` object but are no longer associated with any project. You can recover them by hand-editing `#urendata`: find the old project ID in the `weeks` keys and re-add a project entry with that same ID to the `projects` array.

If that is too complex, see the **Ultimate option** below.

### Ultimate option

If something is deeply wrong, you can delete the `#urendata` note entirely and let the tracker recreate it on the next load. The new note will be empty (`{ "projects": [], "weeks": {} }`). No notes outside the tracker are at risk.

## Limitations

| Limitation | What to do |
| --- | --- |
| There is no weekly calendar view. | The tracker is project-centric, not date-centric. Use the Entry tab to browse by project. |
| Week keys must be entered manually. | Type the week in `YYYY-Www` format. The current week is pre-filled; adjust as needed. |
| Calendar weeks left is not live. | It is calculated once when the tracker loads. Reload the widget to refresh it. |
| Deleting a project does not remove its week entries from the JSON. | These orphan entries are harmless (they never appear on screen) but slowly grow the data note. Reset with the **Ultimate option** if tidiness matters. |
| There is no real-time sync. | Data is written on every save action. If you have two tracker views open simultaneously, the second save will overwrite the first. |
| No export. | To extract your data, open the `#urendata` note and copy the JSON content. |
