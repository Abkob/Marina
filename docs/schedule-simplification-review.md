# Schedule page simplification

Research and implementation: 29 September 2026.

The problem was competing entry points: two toolbars, an automatically opened task drawer, seven empty “add task” controls, capacity badges, AI actions, and report accordions. The previous Month tab displayed a workload report instead of a calendar. The redesign makes date navigation and the calendar the default workspace, with planning and reports opened deliberately.

## Sources and decisions

Official workflow documentation was reviewed for five calendar products alongside usability guidance. These are documented patterns, not claims that every competitor was tested in a signed-in account. See the [earlier interaction review](calendar-interaction-review.md) for the public builder and screenshots previously inspected.

| Source | Relevant observation | Application in Marina |
| --- | --- | --- |
| [Sunsama Today View](https://help.sunsama.com/docs/usage-guides/today-view/) | A focused day workspace reduces surrounding navigation and brings tasks alongside the calendar. | Let the calendar occupy the screen by default; reveal tasks alongside it through Plan. |
| [Google Calendar views](https://support.google.com/calendar/answer/6110849?co=GENIE.Platform%3DDesktop&hl=en-GB) | Date navigation and a view selector form a consistent calendar control area. | One toolbar with Day/Week/Month, previous/next, and a date jump under the heading. |
| [Notion Calendar settings](https://www.notion.com/help/notion-calendar-settings) | View density and all-day visibility are adjustable; mobile settings are reached from a menu. | Hide the empty all-day row and use a compact phone day view, while retaining expanded controls as a preference. |
| [Akiflow mobile](https://product.akiflow.com/en/help/articles/3431876-mobile-app) | The calendar is the primary phone workspace, with creation and date selection close to it and other tools in a menu. | Add opens the editor directly. Task scheduling, task creation, repeats and display options share one options sheet. |
| [Morgen due date versus do date](https://www.morgen.so/guides/due-date-vs-do-date) | Scheduled work and due dates have different meanings; duplicating scheduled tasks increases visual load. | Preserve due markers and task links; avoid showing an all-day task again when it already has a timed block that day. |
| [Nielsen Norman Group: progressive disclosure](https://www.nngroup.com/articles/progressive-disclosure/) | Show frequent actions first and make specialized tools available on demand through a clear entry point. | One Plan drawer contains tasks, repeats, suggestions and drafts. Its selector also opens full-size reports. |
| [Nielsen Norman Group: complex applications](https://www.nngroup.com/articles/usability-heuristics-complex-applications/) | Redundant controls compete for attention and make useful actions harder to identify. | Remove repeated add controls, persistent capacity badges, report accordions and duplicate event/task titles. |

## Result

- Desktop starts with a single toolbar and full-width calendar. Plan stays closed until requested. Its tools use one shared drawer; workload, time breakdown, feasibility and timeline open as reports. Weekly and 35-day workload reporting remain available.
- Day uses one full-width time column and the correct weekday's working hours. Month displays actual dated blocks, meetings, repeats, scheduled tasks and due indicators across a Monday-first six-week grid. Opening a date switches to Day. Month navigation clamps correctly across short months and year boundaries.
- Empty all-day rows disappear. Dragging a task exposes the row so dropping on a day remains available. Existing deadline/task chips still expand, and dated tasks remain available in Plan.
- Phone starts compact unless the user already chose expanded controls. The date heading opens the calendar picker, arrows and swipes navigate days, and Add opens the existing typed Start/End editor immediately. Secondary tools and help move into options. Controls retain accessible names, focus states and 44px touch targets.
- Drawing, moving, resizing, Undo, task links, work timers and cloud saves continue through the existing implementations. This change requires no database migration or production data rewrite.

## Verification

Component tests cover month/day/week navigation, leap-year boundaries, month event/date opening, linked-task deduplication, compact phone preferences, task tool access and direct creation. Existing tests cover both resize edges, gesture cancellation, failed/slow saves, task completion, phone editing, routines, workload and time reporting. Browser review uses the real Schedule components with an isolated local API fixture at desktop, tablet and 320px/390px phone widths. Production verification checks the deployed commit, frontend assets, health and authentication protection; the private live calendar requires a signed-in session for visual testing.
