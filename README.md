# Amina OS

**A local-first research and project operating system for turning unstructured notes into goals, evidence, schedules, and reviewable AI-assisted actions.**

Amina OS (formerly Marina OS) explores a practical question: how can an assistant help organize complex research without becoming the source of truth? The application keeps goals, tasks, notes, resources, calendar events, and relationships in a structured database; AI features retrieve that context and propose actions that remain visible and confirmable.

> This is an active research-grade application, not a hosted service. Use synthetic or disposable data while evaluating it.

## What it includes

- Hierarchical goals, tasks, milestones, dependencies, time estimates, and critical-path views
- Brain-dump and journal capture with structured extraction and a durable ingestion pipeline
- Weekly scheduling, recurrence, drag-and-drop planning, and velocity-aware projections
- Resource profiles with citations, activity logs, co-citation context, and goal coverage
- A typed graph of relationships among goals, tasks, notes, resources, events, and topics
- Retrieval-assisted planning with explicit proposals instead of silent database mutations
- Local model support through Ollama, configurable embedding providers, and fallback behavior
- Backup, recovery, migration, stress, integration, and UI test coverage

## Design principles

1. **Structured data is authoritative.** Generated summaries never replace the underlying records.
2. **Actions are reviewable.** AI suggestions are presented as proposals that can be accepted, edited, or rejected.
3. **Context has boundaries.** Retrieval, sanitization, and validation constrain what reaches a model.
4. **Recovery is a feature.** Journal outboxes, database backups, migrations, and integrity checks are part of the architecture.
5. **Local-first is preferred.** The application can use local inference and keeps operational data outside Git.

## Architecture

| Layer | Main technologies |
|---|---|
| Interface | React 19, TypeScript, Vite, Tailwind CSS, Zustand, TanStack Query |
| API | Express, Zod, typed route and query modules |
| Data | PostgreSQL, pgvector, graph edges, HNSW vector search |
| AI | Ollama-compatible reasoning models and configurable embeddings |
| Quality | Vitest, Playwright, integration, recovery, and stress scenarios |

```text
capture / goals / resources / schedule
                 |
                 v
        typed API and validation
                 |
                 v
 PostgreSQL truth + graph + vector index
                 |
                 v
 retrieval -> bounded context -> proposed action
```

## Current application

The current interface uses the Marina name and includes phone planning, routines, Google Tasks and Calendar sync, and persistent thought notes. Unfinished notes carry forward until **Finish** is selected; completed notes remain crossed out on their completion day.

See [application and deployment guidance](docs/application-guide.md) for the current setup, migrations, mobile workflows, backups, and private Vercel hosting. Apply the additive `server/migrations/025-note-completion.sql` migration before using the new note completion API.

## Local setup

### Prerequisites

- Node.js 24
- PostgreSQL with the `vector` extension
- Optional: Ollama or another compatible model endpoint

### Run

```bash
git clone https://github.com/Abkob/Marina.git
cd Marina
npm install
cp .env.example .env
```

Create a PostgreSQL database, apply `server/schema.sql`, then set `DATABASE_URL` in `.env`.

```bash
npm run dev
```

The Vite interface runs on `http://localhost:3000`; the API starts alongside it.

## Verification

```bash
npm run lint
npm test
npm run test:integration
npm run test:e2e
```

Some integration and end-to-end scenarios require PostgreSQL and the configured model services. Unit tests use controlled fixtures.

## Repository map

```text
src/                  React application, query hooks, state, and UI tests
server/               Express API, schema, retrieval, migrations, and services
server/__tests__/     Integration, ingestion, retrieval, and recovery scenarios
e2e/                  Browser-level workflows
BACKEND_SPEC.md       Backend capability and data-model specification
TASK_SPEC.md          Product behavior and unit-test plan
RESOURCE_PROFILE_PAGE.md
                      Evidence-centric resource profile specification
```

## Data and security

- Real databases, uploads, environment files, logs, model artifacts, and backup dumps do not belong in source control.
- Never commit API keys or production connection strings. Start from `.env.example`.
- Treat imported notes and attachments as untrusted input.
- Review migrations and backup/restore operations against disposable data first.

## Status

Amina is an evolving personal research system. The repository is useful as an architectural and implementation study; interfaces and schemas may change as the retrieval, planning, and evidence workflows are evaluated.

## Research context

The project supports my broader work in biomedical signal processing, research software, and literature-to-experiment workflows. See my [GitHub profile](https://github.com/Abkob) and [ORCID record](https://orcid.org/0009-0007-3870-4619).
