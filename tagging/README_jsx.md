# Tagging Toolbar widget

A [Trilium Notes](https://triliumnotes.org/) widget that adds a **Tags** panel to the right sidebar (next to the built-in *Attributes* tab). Click **Add tag** to apply or remove tags from a predefined list; the tags already on the note are listed below, and clicking one removes it. Prefer it at the bottom of the note instead? See [Widget options](#widget-options).

> Disclaimer: This is a Preact/JSX rewrite of [TheBig-O's Tagging Widget](https://github.com/TheBig-O/Tagging_Widget), created with the help of Claude.ai. 

Tags are ordinary notes, and applying one creates a `~tag` relation to that note. So a tag keeps all its Trilium powers: click it to see everything tagged with it, search `~tag.title = "Important"`, put it in a saved search, or group a calendar/board by it.

## What it does

- An **Add tag** button opens a dropdown of the tags available for the current note.
- Clicking a tag **adds** it (or **removes** it if already applied).
- The **applied tags** are listed in the panel, styled with their own icon and colours; click one to remove it.

The panel lives in the right sidebar and can be collapsed like any other sidebar section. It appears only on taggable notes, so the sidebar stays clean elsewhere.

## Requirements

A TriliumNext installation (the JSX/Preact widget API was added in v0.101.0).

## Setup

1. Create a new note of type **JSX**.
2. Open [`tagging_toolbar.jsx`](tagging_toolbar.jsx), copy its full contents into the note, and save.
3. Add the label **`#widget`** to this note.
4. Reload Trilium (`Ctrl+R`).

That's it — there are no note IDs to copy and no code to edit.

### What you'll see after setup

Nothing appears until you open a **taggable** note (see the next section) and the **right sidebar** is shown — toggle it if it's hidden. On a taggable note a collapsible **Tags** section then appears in that sidebar, alongside the built-in *Attributes* / *Table of contents* sections. The panel is created and updated automatically per note; you don't add it to notes yourself.

Until any tags exist, that panel shows a short message and a **Create starter tags** button — so the first time you'll typically notice the panel is on the template note itself (that note carries the activation label, so it is taggable too). Clicking the button creates the tag list as a child of the widget/script note (so if the script lives in your *Templates* area, that's where the new `Tags` note lands). Nothing here is a system note — everything it makes is an ordinary note you can move, rename or delete.

## Deciding which notes get the toolbar

The panel appears on any note that carries the label **`#TaggingTemplate`** (and is not `#archived`). The tidiest way to apply that to many notes is a template:

1. Create a template note and give it `#TaggingTemplate`.
2. On any note that should be taggable, add a `~template` relation pointing at it.

Because the label can be inherited, putting it on a subtree root makes every note below it taggable at once.

> Prefer a different label? Add `#tagActivationLabel=YourLabel` to the widget note.

## Deciding which tags a note is offered

Tags live as **child notes of a "tag container"**. A container is any note that carries the label **`#tagContainer`**.

### One tag set for everything (the simple case)

Give one note the label `#tagContainer` and add your tags as child notes. Every taggable note is offered that set. Nothing else to configure.

```text
📂 My Notebook
├── 🏷️ Tags                (#tagContainer)
│   ├── #️⃣ Important
│   ├── #️⃣ Follow-up
│   └── #️⃣ Idea
└── 📂 Work
    └── 🗒️ Q1 Report        ← offered: Important, Follow-up, Idea
```

**Nothing set up yet?** On a fresh install the Tags panel shows a short message and a **Create starter tags** button. Click it and the widget creates a `Tags` container (labelled `#tagContainer`) with a few example tags as children, right next to the script note — so you can start tagging immediately and rename/replace the examples later.

### Different tag sets for different areas

Give each container a **name**: `#tagContainer=work`, `#tagContainer=personal`, … Then route a note (or a whole subtree) to a set with an **inheritable** `#tagSet=work` label on the area's top note.

```text
📂 My Notebook
├── 🏷️ Work Tags            (#tagContainer=work)
│   ├── #️⃣ Project-A
│   └── #️⃣ Meeting
├── 🏷️ Personal Tags        (#tagContainer=personal)
│   ├── #️⃣ Family
│   └── #️⃣ Hobby
├── 📂 Work                 (#tagSet=work, inheritable)
│   └── 🗒️ Q3 Planning       ← offered: Project-A, Meeting
└── 📂 Personal             (#tagSet=personal, inheritable)
    └── 🗒️ Holiday ideas     ← offered: Family, Hobby
```

A note with no `#tagSet` (or one set to `default`) uses the plain `#tagContainer` set. The same named set can be reused by any number of unrelated subtrees — just point their `#tagSet` at the same name.

> This one rule replaces the upstream widget's three lookup modes (direct ID / search-with-root / full upward search), and needs no note IDs. If you really do want to pin the default set to one specific note (skipping the search), add `#tagContainerId=<noteId>` to the widget note.

## Styling your tags

Add these labels to an individual **tag note** to change how its badge looks (all optional):

| Label              | Effect                        | Example                     |
| ------------------ | ----------------------------- | --------------------------- |
| `#iconClass`       | Icon before the tag           | `#iconClass=bx bx-briefcase`|
| `#badgeBackground` | Badge background colour        | `#badgeBackground=#348cbb`  |
| `#badgeColor`      | Badge text colour              | `#badgeColor=#ffffff`       |

## Widget options

Set these as labels on the **widget note** (all optional):

| Label                 | Default            | Effect                                             |
| --------------------- | ------------------ | -------------------------------------------------- |
| `#tagPlacement`       | `right`            | Set to `bottom` for a bar under the note instead of the sidebar panel |
| `#tagActivationLabel` | `TaggingTemplate`  | Label that marks a note taggable                   |
| `#tagContainerId`     | *(unset)*          | Pin the default set to a specific container note   |
| `#tagShowApplied`     | `true`             | Set to `false` to show only the button, no strip   |
