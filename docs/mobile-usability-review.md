# Phone usability review — September 24, 2026

The review used an isolated browser preview with sample records at 375 × 812 (iPhone 13 mini). No real workspace records were modified. All main destinations and the goal, task, and resource detail screens rendered without page-width overflow or clipped controls in this preview.

| Page | Changes and review |
| --- | --- |
| Schedule | Smaller header/navigation, visible Expand/Compact control, remembered Day/Agenda preference. Reviewed both views; also checked 320 × 568 and 844 × 390 layouts. |
| Goals | Compact summary, phone search, clear New action; database atlas stays on desktop. Goal creation offers current and upcoming quarters. |
| Goal detail | Tasks precede secondary panels; planning, progress, milestones, and connections collapse and remember their state. Task links have visible Open labels. |
| Task detail | Multiline title editor, accessible completion/child-task controls, collapsed calendar, clearer task-note wording. |
| Work | Less duplicated heading space, task-specific saved drafts, collapsed time logs. |
| Capture | Multiline phone input, visible Save note action, retained drafts. Editing waits for successful save before closing and shows an inline error on failure. |
| Journal | Corrected light-background contrast, saved text/date drafts, phone-sized filters. |
| Resources | Compact counts and filters. Detail titles wrap; reading activity and connections collapse. |
| Topics | Shorter introduction, optional explanation, consistent Find suggestions wording. |
| Connections | Board is the mobile starting view; secondary filters are tucked behind Filters. |
| Timeline | Reviewed date-grouped task list and link back to daily schedule. |
| Copilot | Smaller toolbar, readable starting prompts and composer; secondary panels remain accessible. |
| Settings | Phone preferences first; other sections collapse and remember their state. Verified changing the preferred view updates Schedule. |
| Usage | Compact two-column metrics and optional database detail. |
| Diagnostics | Individual tools start collapsed on phones. |

Shared changes include remembered tab details, URL history for Back/Forward and refresh, less crowded navigation, iPhone sheet scroll locking, and confirmation dialogs that wait for completion and support retry after failure.

Validation: 573 tests passed; typecheck, production build, serverless entry check, and Vercel preflight passed. Added regressions for navigation, draft recovery, nested sheet scroll locking, failed note saves, and confirmation retries. Rechecked typecheck/build after the final label and CSS polish.

This was a browser viewport review, not a physical iPhone/Safari test. The preview's offline flag prevented network-dependent calendar actions; gesture and event-composer behavior remain covered by the existing tests. Real Google synchronization and AI responses were outside the fixture-based review.
