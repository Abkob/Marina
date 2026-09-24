# Marina conversation architecture

Context transport now uses lossless JSON tables, explicit task relationships, selectable workspace sections and paginated task reads. See [context format and measurements](copilot-context-format.md).

The Copilot now uses one conversation model with a bounded set of typed, read-only tools. The latest user message reaches that model unchanged, with both user and assistant history and compact historical card facts. Nemotron remains the configured default.

## What was removed

- Keyword-based conversational replies and schedule/day/overdue shortcuts.
- The separate schedule intent classifier and regex semantic request contract.
- Pre-model due-date writes.
- Follow-up message rewriting, guessed task-ID substitution, injected planning actions, and replacement of model explanations with canned plan prose.
- The legacy `/api/orchestrator/interpret` classifier endpoint now returns HTTP 410.

## How a turn works

1. Load the user's timezone and recent complete conversation exchanges.
2. Let the model answer directly, ask one clarification, or request structured tools.
3. Validate tool arguments and return observations. Tools read current task details, calendar ranges, workspace context, or saved research; preview tools calculate proposed calendars without applying them.
4. Let the model explain those observations in its own words. Requested previews attach their calculated cards, including partial plans; the model can explicitly withdraw a superseded preview. Other read tools appear as cards only when selected. Clarifications cannot carry mutation proposals, but a follow-up about improving a preview does not erase that preview.
5. Validate action schemas and reject ungrounded entity references. A focused model review checks concrete record changes against the original two-sided conversation, including targets, dates, scope and corrections. It asks a natural clarification if the proposal requires an assumption, and corrects claims that pending changes were already applied. It does not veto read-only previews or resolve their capacity conflicts. This is not an intent router: it cannot add actions or select a workflow. Only reviewed valid record changes are stored as pending proposals; the existing Apply controls perform changes.

Scheduling arithmetic, archive filtering, schema checks, ID validation, and capacity calculations remain deterministic. They operate on explicit structured arguments, rather than deciding what a sentence means. A scoped plan includes only the requested tasks and descendants. Missing tasks cause an error instead of broadening the plan to unrelated work.

The transport is provider-compatible JSON with Zod validation, not native provider function calling. Calls share a three-minute deadline, three tool rounds, bounded observations, duplicate-read caching, one protocol repair attempt, and one retry for transient provider overload per model step. Provider or tool failures remain visible; they do not trigger a canned interpretation. Nemotron uses its provider's recommended sampling settings rather than a forced low temperature; see the [NVIDIA model card](https://build.nvidia.com/nvidia/nemotron-3-super-120b-a12b/modelcard).

## Why this approach

The prompt requests JSON and the server validates it locally, without forcing provider-side JSON decoding on reasoning calls. Live evaluations exposed malformed payloads under constrained decoding. This is a transport choice, not an interpretation rule: user wording remains untouched.

| Approach | Tradeoff |
| --- | --- |
| Single answer with all workspace data embedded | Simple but increases prompt size and can hide omissions in a large context. |
| Keyword or separate classifier routing | Fast for rigid commands, but a mistaken label constrains the answer before the conversation model understands the exchange. Removed from chat. |
| One conversation model choosing typed tools | Chosen: preserves conversational context and obtains fresh facts only when needed. More than one provider call is sometimes necessary. |
| Native provider tool calling | A possible transport improvement after provider-specific evaluation; it does not by itself solve intent errors. |
| Multiple specialized agents | Adds coordination and latency; unnecessary for the current workspace operations. |

This follows the preference for simple model-and-tool systems in [Anthropic's Building effective agents](https://www.anthropic.com/engineering/building-effective-agents), and the emphasis on clear tool contracts and evaluation in [Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents).

## Validation

Unit tests exercise conversation preservation, corrections reaching the model unchanged, card selection, clarification behavior, unknown IDs, malformed tools, duplicate reads, provider failures, bounded loops, timezone handling, archive filtering and task scope.

`scripts/eval-copilot.ts` runs the real configured provider against synthetic data. Its cases cover casual typos, explanation versus planning, stopping an earlier workflow, ambiguous references, reading tomorrow's schedule, a narrow plan, correcting a deadline, and moving deadlines without moving calendar events. Reports are saved under `tmp/copilot-eval*.json`. No production workspace records are read or changed by that evaluation. Model evaluation is a sample of behavior, not a guarantee that every future request will be interpreted correctly.

The final application check passed 591 tests, TypeScript, the production build and serverless checks. Live evaluation also covers read-only inspection, a resolved follow-up and comparison without mutation. The last eleven-case run exposed one preview being withheld by the proposal reviewer; narrowing that reviewer to record changes fixed it, and the focused live rerun preserved the requested partial preview. Provider overloads occurred during evaluation and can still exhaust the bounded retry. Generative replies can still contain wording errors or unnecessary questions; schema validation and proposal review do not prove perfect natural-language understanding.
