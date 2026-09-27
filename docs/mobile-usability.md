# Phone usability pass — September 24, 2026

The iPhone 13 mini layout exposed too many controls before its content. The schedule repeated its title, date navigation, refresh/install actions and view switch. Goal cards consumed nearly a full screen, and task rows exposed editing tools on every item. Journal filters and its full editor appeared before any entries.

## Design references

- [Things: features](https://culturedcode.com/things/features/) — clear task hierarchy, optional details revealed when needed, and a consistent creation action.
- [Day One: Today view](https://dayoneapp.com/guides/tips-and-tutorials/today-view/) — organize the experience around the day and make writing a clear entry point.

These informed the interaction changes below; Marina keeps its existing scheduling, task and journal models.

## Changes

- Schedule: one date bar; month navigation in a date sheet; Agenda/Day, compact controls, refresh, installation and native routines in Schedule options. The add sheet also reaches native routines even when none exist. Saved view and compact preferences, date swipes, hold/drag/resize and undo continue to use the existing implementations.
- Goals: native status selector and compact progress rows. Archive/delete actions move into a menu. Task groups and subtasks expose title, completion, disclosure and contextual actions; editing is on the task page. Dependency locks continue to restrict completion and starting a blocked step. Deadlines, meetings and secondary planning information are disclosures.
- Work: task picking in a sheet, optional metadata and timer notes collapsed, primary focus action prominent, fewer nested panels around writing.
- Journal: a readable chronological list using the user's own text, a writing sheet with a persistent draft, and a separate filter sheet. Date and text filters now combine. Completed processing status and deletion controls are deferred until opening an entry.
- More: grouped navigation rows replace a grid of cards.
- Task context: show the immediate parent first, then the goal, in schedule tasks, linked blocks, Work, task picking, project timeline and search. Long goals cannot hide the distinguishing parent first. Use known titles; never fall back to IDs. Standalone search results now open Work.

## Verification

Browser checks use the actual app at 375 × 812 with disposable local fixtures, including duplicate-style task names and parent relationships. Writing was also checked at 375 × 470 to simulate the space remaining above a keyboard: editor, date and save controls stayed within the viewport. Closing and reopening preserved the draft; saving returned to the journal list.

Regression coverage includes saved calendar preferences, navigation and date swipes, event touch targets, task completion/moves, native routine discovery, duplicate task names in search, linked block context, journal drafts and failed saves, and combined date/text filtering. Full `npm run check` covers types, the unit suite, the production build and serverless/Vercel preflight.

These are browser viewport checks, not a physical-device Safari test. No live task, event or journal data was changed for visual QA.
