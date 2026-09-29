# Calendar interaction review

Research and code audit: 27 September 2026.

## Recommendation

Make the calendar itself the main editing surface. Create, place and resize a block where it will live; show a small contextual editor only for information the calendar cannot supply. Keep a collapsible task tray on desktop and one compact bottom sheet on mobile. Replacing the time picker alone would leave the larger interruption problem unresolved.

Implemented on 29 September 2026: the calendar now has a compact workspace, direct task drops with Undo, drawing to create, resizing from either edge, Start/End text inputs, a nonblocking editor with a live draft outline, and a collapsible phone sheet. Task links and event fields save in one database transaction. Existing agenda/month/timeline views and planning tools remain available. The comparison below records the research that informed the implementation.

## What was actually studied

I interacted with Morgen's public Schedule Builder, including its empty-slot creation dialog and time menu. I read the products' official workflow guides and visually inspected the official Sunsama session-popout image, Akiflow desktop slot images and mobile calendar image. I did not test signed-in Sunsama, Akiflow or the full Morgen application; documentation and screenshots cannot establish how their current apps behave under slow saves or every touch gesture.

| Reference | Useful pattern | Decision for Marina |
| --- | --- | --- |
| [Sunsama: working sessions](https://help.sunsama.com/docs/usage-guides/timeboxing/timeboxing-how-to-timebox/) | A small calendar popout beside a task lets sessions remain spatial. A task can have several sessions. Removing a session leaves the task intact. | Use a compact session surface for timing and keep the goal/task relationship intact. In the inspected image, the selected time, block range and task estimate are visible together. Keep these quantities explicitly labelled in Marina. |
| [Morgen: manual time blocking](https://www.morgen.so/guides/manually-time-block-in-morgen) | Drop a task into a calendar; its estimate supplies the initial length. Resize from an edge. Scheduled tasks can remain visible in the task list. | Schedule a linked task directly, with Undo. Keep already scheduled tasks discoverable so another work session is easy to add. |
| [Morgen: public Schedule Builder](https://www.morgen.so/schedule-builder) | Clear time grid with a compact navigation rail. Its creation dialog contains title, type, colour, day and time/duration controls; opening Start reveals a scrolling list. | Borrow the clear canvas. A large multi-choice form and long quarter-hour menu would preserve the user's current friction, so do not copy that creation flow. This observation concerns the public builder, not the full product. |
| [Akiflow: Time Slots](https://product.akiflow.com/help/articles/3089241-time-slots) | A calendar block can contain several tasks and show their count/progress. Tasks can have more planned time than the container holds. | Preserve Marina's multiple task links. Show the block's duration separately from linked task estimates; never silently stretch a block just because its tasks exceed it. In the inspected guide, a two-hour slot contains three hours of tasks, illustrating why labels matter. |
| [Akiflow: mobile](https://product.akiflow.com/en/help/articles/3431876-mobile-app) | Calendar-first phone layout; a draft can be moved, resized and minimized to inspect the schedule. Basic draft details survive type changes. | Use a collapsible bottom sheet with the selected block still visible. The inspected phone screenshot has a single-day canvas and quiet date/navigation controls; use that hierarchy, with fewer persistent controls for Marina. |

These are interaction references, not a proposal to copy another product's styling. Use Marina's existing typography and restrained colours. Automated rearrangement of other blocks should remain an explicit action, not a side effect of a manual resize.

## Current friction and the immediate correction

The desktop resize handle's pointer-up event bubbled into the block's open-editor handler. The resize handler cleared its gesture first, so the parent interpreted the release as a click and opened the original event while its save was in progress. A regression test reproduced both callbacks firing on one resize.

The fix isolates resize release/movement, requires a real block gesture before opening the editor, avoids saves for unchanged edge taps, and cancels interrupted pointer gestures. Mobile edge handles now resize immediately instead of requiring a hold; the body retains hold-to-move so ordinary scrolling remains usable. Pointer taps on the handles do not open the editor; keyboard/assistive activation retains access to precise editing. Existing mobile save feedback, failure recovery and Undo remain available.

The redesign replaces the former 92-choice start menu and separate duration list with typed Start/End fields. Task drops now save directly, while an empty-slot selection opens the compact editor. Desktop gestures retain their new placement until saving finishes and restore the original on failure. A selected draft remains visible on the calendar when its editor is minimized.

## Proposed interaction contract

| Intent | Desktop | Phone | Completion |
| --- | --- | --- | --- |
| Extend or shorten | Drag either edge; show live start, end and length next to the block. | Drag a small edge grip with a comfortable touch area. | Release saves once, keeps the new placement visible and offers Undo. No editor opens. |
| Move | Drag the block body to a new time/day. | Hold the body, then drag; ordinary vertical gestures scroll. | Preserve length and task links. Save once on release. |
| Create at a known time | Draw empty time; a small anchored title field appears. | Hold and draw empty time, or tap once for the default length; show a compact sheet. | Enter title and save. Drawn start/end are authoritative. |
| Schedule an existing task | Drop from the task tray straight onto the calendar. | Choose Schedule on the task, then tap a visible time in the day. | Use its estimate as an initial length only when no range was explicitly drawn. One linked block, then Undo. |
| Change exact times | Select block, edit Start and End in the compact inspector. | Tap block, edit the same two fields in its sheet. | Accept `14:30` or `2:30pm`, validate visibly, and derive duration immediately. |
| Open full details | Explicit Details action from selection, or Enter. | Expand the same sheet. | Show description, type, linked tasks, lock and advanced actions without losing the draft. |

Use 15-minute snapping with exact typed times available. Keep a few optional duration shortcuts beside the time fields. Changing Start moves the whole block while preserving its length; changing End changes length. Reject an end before the start with an inline explanation; do not silently roll it into tomorrow. Overnight support would need a separate model decision.

One click should select a block and reveal modest local actions; it should not immediately interrupt the calendar with a full form. Do not require double-click, hover or dragging to reach an essential action. Every drag operation also needs an explicit time/date editing route, consistent with [WCAG's dragging-movement guidance](https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html).

## Layout and mobile behaviour

Desktop: compact date navigation above the time grid, optional task tray on the left, one contextual inspector at the selected block. Collapse the tray when width is constrained. Keep focus, buffer, review and admin available in expanded details rather than asking for a category before every placement.

Phone: one-day timeline with a slim date strip and optional date picker. Use one bottom sheet that can collapse while preserving title, links and time range. Keep the selected block visible above the sheet. Open the keyboard only when text entry is intended. Avoid stacked dialogs and permanent banks of duration buttons. Keep secondary actions visually small while retaining at least 44px touch targets and clear keyboard focus.

## Existing features to preserve

- Goal hierarchy, task links (including multiple tasks per block), repeated work sessions, meetings, routines, deadlines, locks and existing calendar views.
- Cloud saves, visible save failures, and the same running work timer across devices. Use the existing cloud records; changing the interface does not justify replacing production data or changing the schema.
- Time analytics: credit elapsed calendar time as the event happens; future time remains planned. Attribute linked time to its task/goal and unlinked time to Miscellaneous. Preserve existing overlap and work-log deduplication rules. Resizing a plan must not mark its task finished or invent a work log.
- Remove-from-calendar and finish-task remain distinct actions. Completed task/note history stays available, with the discreet Finish treatment the user requested.
- If a later implementation requires production data/schema changes, first create and verify a current private cloud backup and keep a local recovery copy when practical.

## Acceptance checks for the broader redesign

These are targets for the next implementation, not measured competitor benchmarks.

1. Resize: one drag, one save, zero editor popups. Updated times remain visible during a slow save; failure restores the old placement and explains the failure.
2. Create: one range gesture, one title entry and one save. Linking a task never overwrites an explicitly drawn range.
3. Schedule an existing task: one desktop drop without an intermediate form. Undo removes that session without deleting the task.
4. Selection, editing and resizing remain distinct after pointer release, cancellation, Escape, multi-touch and loss of focus.
5. Check 320px and 390px phone widths, touch scrolling, selected blocks near screen edges, virtual keyboard appearance and sheet collapse. No horizontal page overflow or hover-only controls.
6. Keyboard and assistive users can edit every placement without dragging. Exact input errors are announced beside the fields.
7. Test save failure and slow responses locally. After deployment, check the served build; authenticated end-to-end save checks require the user's authorized session or a dedicated test record, never edits to their real schedule solely for testing.
