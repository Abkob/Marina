# Repeating time

Research and implementation: 29 September 2026.

Routines are repeating allocations of time: duration × sessions per week, with either selected weekdays or a flexible weekly frequency. The editor accepts `45 min`, `1h 30m` and `1.5h`, uses typed clock times, and keeps the weekly total visible beside Save. Optional goal, starting date and notes are disclosed separately. The overview shows actual logged hours, planned hours and completed sessions together; reaching a target no longer hides the routine.

## References and decisions

Official public guides were read for the repeat model and desktop/mobile workflows. This research did not involve signed-in use of these products. The preceding [calendar review](calendar-interaction-review.md) also records the reference screenshots and public builder interactions already studied.

| Source | Pattern used in Marina |
| --- | --- |
| [Sunsama recurring tasks](https://help.sunsama.com/docs/usage-guides/tasks/recurring-tasks/) | Separate repeat frequency from preferred timing. Keep previous occurrences when changing a series. |
| [Reclaim 2.0 FAQ](https://help.reclaim.ai/en/articles/15280604-reclaim-2-0-faq) | Put duration, frequency and timing first. Reclaim has additional conflict automation; Marina does not claim to reproduce that automation. |
| [Reclaim 1.0 habit settings](https://help.reclaim.ai/en/articles/4129152-habits-overview-auto-schedule-flexible-time-for-your-routines) | Treat availability, duration and ideal time as separate decisions. This guide explicitly describes the older product, so it is a design reference rather than a statement about the current interface. |
| [Morgen manual time blocking](https://www.morgen.so/guides/manually-time-block-in-morgen) | Use duration and direct time placement; on a phone, provide a tap-based equivalent. Its guide notes a mobile recurrence limitation; Marina exposes the same repeat settings on both sizes. |
| [Google Calendar repeating events on iOS](https://support.google.com/calendar/answer/37115?co=GENIE.Platform%3DiOS&hl=en-419) | Make the scope of a repeat edit explicit and keep past occurrences intact. |

## Behavior and boundaries

- New UI-created routines use minutes, never pages/problems/count targets. Existing count-based routines and their entries remain readable. Editing one schedules its conversion to minutes for following weeks.
- Flexible repeats reserve the remaining weekly sessions on eligible days, prioritizing work already started and then earlier days. Skipping a day frees its unused reservation. They do not automatically avoid time collisions.
- One planned session per eligible day; frequency is 1–7 per week. No monthly rules, multiple daily occurrences or automatic minimum/maximum-duration optimization are implied.
- Timer sessions add actual minutes and complete minute targets when reached. Finish only changes the session status; it does not fabricate logged hours. Undo/skip retains actual work. Future sessions can be skipped but cannot be finished or timed in advance.
- Repeat edits take effect on a selected Monday from next week onward. `schedule_history` stores the previous schedule with a date boundary, keeping the routine ID, earlier days, budgets, entries and work sessions intact. Replacing a pending change preserves the schedule before that boundary. The edit replaces the plan from that boundary forward, including later pending changes.
- Updates lock the routine row and require its last-seen `updated_at` value; conflicting device edits receive a visible error. A timer finishing after an edit uses the schedule for its original date.
- Stop repeating preserves recorded history. Stopped routines can be shown in the overview; no resume action retroactively reactivates old dates.
- Desktop calendar routine blocks open repeat editing. On phones, routine details expose the same editor as a bottom sheet. Secondary actions sit behind an accessible options button. Save and the weekly total remain visible while the form scrolls.

## Validation

Tests cover typed duration/time input, frequency limits, midnight bounds, future skip versus completion, preserved logged hours, historical weekly budgets, schedule-mode changes, stale writes, replacement of pending changes, and finishing an older timer. The actual UI was checked in an isolated local fixture at desktop, 390px and 320px phone widths, including create/edit flows and horizontal overflow. These are browser viewport checks, not a claim of physical-device Safari testing.

Production rollout requires a fresh verified private cloud backup and a local recovery copy before applying the additive `027-routine-schedules.sql` migration. No existing routine is automatically converted and no production sample data is inserted.
