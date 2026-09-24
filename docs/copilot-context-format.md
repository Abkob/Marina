# Compact context for Marina

Marina sends JSON facts to the model when it requests them. The task overview is an adjacency graph: each task has its own ID and explicit goal, parent, milestone and blocker links. Priority, estimates, remaining work, deadlines and scheduled placements stay separate. There is no synthetic “importance weight” that replaces these facts or decides what the user meant.

Repeated records use tables with column names once. Constant fields move to `defaults`, which applies to every row. All values remain unchanged; null never becomes zero. For example:

```json
{
  "graph": {
    "tasks": {
      "$table": {
        "columns": ["id", "title", "parent_task_id", "remaining_minutes", "blocker_ids"],
        "defaults": {"goal_id": "research", "due_date": "2026-10-02"},
        "rows": [
          ["draft", "Draft", null, 180, []],
          ["analysis", "Analysis", "draft", 90, ["experiment"]],
          ["experiment", "Experiment", "draft", null, []]
        ]
      }
    }
  },
  "capacity": {
    "date": "2026-09-25",
    "raw_capacity_minutes": 480,
    "reserved_buffer_minutes": 72,
    "fixed_commitment_minutes": 60,
    "available_after_fixed_minutes": 348
  }
}
```

This is an illustrative fixture, not the user's data. Parent rollups and child work must not be added together. Blocker IDs indicate prerequisite tasks; they are not evidence that the user wants those tasks changed.

## What is sent

- `workspace_context` accepts explicit sections: tasks, capacity, attention, details, journal, resources. The model chooses them. Default reads include tasks, capacity and attention; search defaults to tasks and details.
- `find_tasks` finds IDs through literal title/description search and pages active tasks by ID, including tasks beyond the 200-task overview. `task_details` reads exact records and their children, reporting missing IDs and child limits. Archive filtering includes ancestors.
- Capacity carries preferences, buffer, fixed commitments, daily overrides, schedule totals and coverage. Direct due/target/hard dates remain distinct from derived deadlines and scheduled time.
- Journal summaries and library references are optional sections. Existing note, resource and retrieval limits remain explicit. This is **not** a claim that every document or every historical record fits in one prompt. Research passages are fetched separately.
- Repeated identical sections within one turn refer to the first observation. Earlier observations remain in the prompt. Changed values are sent again; mutable facts are never cached across turns.
- Generated compact parameter signatures replace verbose JSON Schema in the prompt. The original strict Zod schemas still validate tools and mutation proposals. Date format replaces Zod's repeated leap-year regex in model-facing documentation only.
- Preview cards retain the original payload for display/application. Only their model-facing representation is encoded. Saved card facts and proposal review facts use the same lossless tables.

No extra model call summarizes/compresses the facts. Original user and assistant messages stay intact within the existing whole-turn history budget. No keyword classifier or deterministic intent router was added.

## Limits and measurements

The raw privacy/archive checks run before encoding, so table columns cannot hide forbidden fields. A raw read has a 500,000-character ceiling; encoded observations have a 50,000-character per-result and 70,000-character per-turn ceiling. Oversized results fail explicitly so the model can request narrower sections/pages. They are not silently summarized or truncated by the codec. Existing source query limits are still reported.

`conversation.context_usage` records raw and sent observation characters. NVIDIA model traces now include actual input/output tokens when the provider returns usage; missing usage stays absent. These are diagnostics, not a dollar-cost estimate. Reasoning/output tokens and repeated model rounds also affect total consumption.

On September 24, 2026, the synthetic benchmark of 120 tasks, four goals and 14 capacity days preserved every JSON fact and reduced context from 62,291 to 18,288 characters (70.6%). Live Nemotron 3 Super calls, including the decoding guide, used **21,464 versus 9,260 input tokens: 56.9% fewer**. Both returned the correct tested parent, blocker, null estimate, free capacity and timezone. This is one controlled fixture, not a guaranteed saving on every conversation.

Reproduce locally:

```sh
node --env-file=.env --import tsx scripts/benchmark-copilot-context.ts --live
```

The script sends synthetic facts only and writes the report to `tmp/copilot-context-benchmark-live.json`. Without `--live`, it checks lossless round-tripping and character counts without calling a model.

This approach follows the primary-source guidance on [retrieving context as needed](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) and [designing concise tool responses](https://www.anthropic.com/engineering/writing-tools-for-agents). Those principles informed the design; the savings above are Marina's own measurements, not vendor claims.
