/**
 * Browser E2E — core user workflows against the production frontend + backend.
 * The API server uses the guarded DATABASE_URL_TEST (see playwright.config.ts);
 * the live database is never touched.
 *
 * Deterministic by construction: the topic-suggestion test seeds a graph edge
 * (+0.25) and a title/alias match (+0.20) so the candidate score meets the
 * 0.45 suggestion threshold without depending on embeddings.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';

const API = 'http://127.0.0.1:3001';

// Unique per run so re-runs never collide with archived topics / leftovers.
const RUN = `e2e${Date.now().toString(36)}`;

async function apiJson<T>(request: APIRequestContext, method: 'get' | 'post' | 'patch' | 'delete', url: string, data?: unknown): Promise<T> {
  const res = await request[method](`${API}${url}`, data !== undefined ? { data } : undefined);
  if (!res.ok()) throw new Error(`${method.toUpperCase()} ${url} → ${res.status()}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

test.describe('App shell', () => {
  test('loads with sidebar navigation and live header', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Topics', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Schedule', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Copilot AI', exact: true })).toBeVisible();
    // Header search input is the real global search, not decoration
    await expect(page.getByPlaceholder('Search everything…')).toBeVisible();
  });
});

test.describe('Topic suggestion workflow', () => {
  const topicName = `${RUN} atlas research`;
  // The task title CONTAINS the topic name so the alias lane (+0.20) fires;
  // with the graph edge (+0.25) that exactly meets the 0.45 threshold.
  const taskTitle = `${topicName} prototype evaluation`;
  let goalId: string;
  let taskId: string;
  let topicId: string;

  test.beforeAll(async ({ request }) => {
    // Seed: goal (member-to-be) + task whose TITLE contains the topic name
    // (alias lane) + an edge goal→task (graph lane).
    ({ id: goalId } = await apiJson<{ id: string }>(request, 'post', '/api/goals', {
      title: `${RUN} atlas umbrella goal`, description: '', category: 'Test', status: 'Safe',
    }));
    ({ id: taskId } = await apiJson<{ id: string }>(request, 'post', '/api/tasks', {
      goal_id: goalId, title: taskTitle, status: 'todo', priority: 'medium',
    }));
    await apiJson(request, 'post', '/api/edges', {
      source_id: goalId, source_type: 'goal',
      target_id: taskId, target_type: 'task',
      relationship: 'contains', metadata: null,
    });
  });

  test.afterAll(async ({ request }) => {
    if (topicId) await apiJson(request, 'patch', `/api/topics/${topicId}`, { status: 'archived' }).catch(() => {});
    if (taskId) await request.delete(`${API}/api/tasks/${taskId}`);
    if (goalId) await request.delete(`${API}/api/goals/${goalId}`);
  });

  test('create topic → add member → generate → explainable suggestion → accept', async ({ page, request }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Topics', exact: true }).click();

    // Create the topic through the real UI
    await page.getByPlaceholder('New topic name…').fill(topicName);
    await page.getByPlaceholder('New topic name…').press('Enter');
    await expect(page.getByText(topicName)).toBeVisible();

    // Manual membership is the authoritative signal the generator builds on
    const topics = await apiJson<Array<{ id: string; name: string }>>(request, 'get', '/api/topics');
    topicId = topics.find(t => t.name === topicName)!.id;
    await apiJson(request, 'post', `/api/topics/${topicId}/members`, { entity_type: 'goal', entity_id: goalId });

    // Generate candidates — graph(0.25) + alias(0.20) = 0.45 meets the threshold
    await page.getByRole('button', { name: 'Find topic membership candidates' }).click();
    const suggestionCard = page.getByTestId('topic-suggestion').filter({ hasText: taskTitle }).first();
    await expect(suggestionCard).toBeVisible({ timeout: 15_000 });
    // Evidence is explainable, not a bare score
    await expect(suggestionCard.getByText(/graph neighbor|alias match/i).first()).toBeVisible();

    // Accept → becomes canonical membership
    await suggestionCard.getByTitle('Accept').click();
    await expect(page.getByText('Added to topic.')).toBeVisible();

    const members = await apiJson<Array<{ entity_id: string; status: string; source: string }>>(
      request, 'get', `/api/topics/${topicId}/members?status=accepted`,
    );
    const accepted = members.find(m => m.entity_id === taskId);
    expect(accepted).toBeTruthy();
    expect(accepted!.source).toBe('ai_accepted');
  });
});

test.describe('Schedule propose → preview → apply workflow', () => {
  const taskTitle = `${RUN} schedule me`;
  let goalId: string;
  let taskId: string;

  test.beforeAll(async ({ request }) => {
    const due = new Date(Date.now() + 4 * 86400_000).toISOString().slice(0, 10);
    ({ id: goalId } = await apiJson<{ id: string }>(request, 'post', '/api/goals', {
      title: `${RUN} schedule goal`, description: '', category: 'Test', status: 'Safe',
    }));
    ({ id: taskId } = await apiJson<{ id: string }>(request, 'post', '/api/tasks', {
      goal_id: goalId, title: taskTitle, status: 'todo', priority: 'high',
      estimated_minutes: 90, due_date: due,
    }));
  });

  test.afterAll(async ({ request }) => {
    if (taskId) await request.delete(`${API}/api/tasks/${taskId}`);
    if (goalId) await request.delete(`${API}/api/goals/${goalId}`);
  });

  test('Plan my week creates a reviewable proposal; applying sets start_date', async ({ page, request }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Schedule', exact: true }).click();

    // Preview must not mutate: task has no start_date before any confirmation
    const before = await apiJson<{ start_date: string | null }>(request, 'get', `/api/tasks/${taskId}`);
    expect(before.start_date ?? null).toBeNull();

    await page.getByRole('button', { name: /Plan assist/ }).click();
    const proposalCard = page.getByTestId('schedule-proposal').filter({ hasText: taskTitle }).first();
    await expect(proposalCard).toBeVisible({ timeout: 15_000 });
    // Before/after diff is shown to the user
    await expect(proposalCard.getByText(/Mon|Tue|Wed|Thu|Fri|Sat|Sun/)).toBeVisible();

    // Still no mutation until the user confirms
    const mid = await apiJson<{ start_date: string | null }>(request, 'get', `/api/tasks/${taskId}`);
    expect(mid.start_date ?? null).toBeNull();

    await proposalCard.getByTitle('Apply').click();
    await expect(page.getByText(/Scheduled for \d{4}-\d{2}-\d{2}\./)).toBeVisible();

    // Canonical DB change happened via the transactional proposal path
    await expect.poll(async () => {
      const after = await apiJson<{ start_date: string | null }>(request, 'get', `/api/tasks/${taskId}`);
      return after.start_date;
    }).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

test.describe('Testing workbench page', () => {
  test('benches load and run against real endpoints', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Testing' }).click();
    await expect(page.getByRole('heading', { name: 'Testing' })).toBeVisible();

    // System bench reflects real readiness
    await expect(page.getByText('db: connected')).toBeVisible({ timeout: 15_000 });

    // Search bench returns real output (results or an honest empty state)
    await page.getByPlaceholder('e.g. UI widget style guide').fill(`${RUN} nonexistent zxq`);
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(page.getByText(/No results\.|vector search degraded|^\d\.\d{3}/).first()).toBeVisible({ timeout: 15_000 });

    // Scheduler bench runs the deterministic scheduler and reports honestly
    await page.getByRole('button', { name: 'Run scheduler & propose' }).click();
    await expect(page.getByText(/status feasible|status tight|status risky|status impossible/i).first()).toBeVisible({ timeout: 15_000 });
  });
});

test.describe('Global search', () => {
  test('header search returns an honest dropdown for a seeded title', async ({ page, request }) => {
    const { id: goalId } = await apiJson<{ id: string }>(request, 'post', '/api/goals', {
      title: `${RUN} searchable quasar goal`, description: 'e2e search target', category: 'Test', status: 'Safe',
    });
    try {
      await page.goto('/');
      const box = page.getByPlaceholder('Search everything…');
      await box.fill(`${RUN} searchable quasar`);
      // Dropdown must appear with either real results or an explicit no-match/degraded state
      const dropdown = page.locator('div.absolute.top-9');
      await expect(dropdown).toBeVisible({ timeout: 10_000 });
      await expect(dropdown.getByText(/quasar|No matches|keyword matches only/i).first()).toBeVisible({ timeout: 10_000 });
    } finally {
      await request.delete(`${API}/api/goals/${goalId}`);
    }
  });
});
