import { test, expect } from '@playwright/test';
import { EvaluationRecorder } from '../server/services/evaluationTrace';
import { planningFixtures, fixtureId } from '../audits/planning/fixtures';

for (const failed of [false, true]) test(`P00.2-F01/P00.3-F04 ${failed ? 'provider failure' : 'evidence answer'} remains usable on this viewport`, async ({ page, isMobile }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const id = fixtureId(900); const fixture = planningFixtures[1];
  const trace = new EvaluationRecorder({ runId: fixtureId(901), configuration: { provider: 'synthetic' } });
  trace.record({ phase: 'context', status: 'completed', duration_ms: 25 });
  if (failed) trace.record({ phase: 'interpretation', status: 'failed', failure: 'provider_timeout', duration_ms: 1000 });
  else trace.tool('read_document', { resource_id: fixture.resources[0].id, passages: fixture.evidence }, 50);
  trace.storage('saved');
  const runtime = { total_ms: 1050, primary_model: 'synthetic', fallback_model: null, model_calls: [], evaluation_trace: trace.snapshot() };
  const messages = [{ id: fixtureId(902), role: 'assistant', content: failed ? 'The model timed out. Please try again.' : '**Selected evidence**\n\n1. Compare *modular arithmetic* and logical statements.\n2. The remaining effort is still unknown.',
    created_at: new Date().toISOString(), metadata: { runtime, citations: failed ? [] : [{ entity_type: 'resource', entity_id: fixture.resources[0].id,
      title: fixture.resources[0].title, excerpt: fixture.evidence[0].excerpt, excerpt_kind: 'text', page_start: 94, page_end: 94,
      matched_via: ['fixture read'], source_tool: 'read_document', source_url: `/api/resources/blob/${fixture.resources[0].id}` }] } }];
  await page.addInitScript(({ id }) => { localStorage.setItem('marina-os-ui-v1', JSON.stringify({ version: 0, state: { currentTab: 'Copilot', copilotActiveSessionId: id, copilotMessages: [] } })); }, { id });
  await page.route(`**/api/ai/sessions/${id}/messages`, route => route.fulfill({ json: messages }));
  const openChat = async () => {
    if (isMobile) {
      await page.getByRole('button', { name: 'Open all pages' }).click();
      await page.getByRole('button', { name: 'Open Copilot', exact: true }).click();
    }
  };
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await openChat();
  const details = page.getByRole('button', { name: /Response details/ });
  await expect(details).toBeVisible(); await details.scrollIntoViewIfNeeded();
  if (isMobile) await details.tap(); else { await details.focus(); await page.keyboard.press('Enter'); }
  await expect(page.getByRole('region', { name: 'Response phases' })).toBeVisible();
  if (failed) await expect(page.getByText(/The model timed out/).last()).toBeVisible();
  else {
    await expect(page.getByRole('article', { name: 'Source: Synthetic Introduction to Algebra' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open Synthetic Introduction to Algebra, page 94' })).toHaveAttribute('href', `/api/resources/blob/${fixture.resources[0].id}#page=94`);
    await expect(page.locator('.copilot-message-list em')).toHaveText('modular arithmetic');
  }
  const identifiers = page.getByText('Diagnostic identifiers'); await identifiers.scrollIntoViewIfNeeded();
  const box = await identifiers.boundingBox(); expect(box!.height).toBeGreaterThanOrEqual(44);
  if (isMobile) await identifiers.tap(); else { await identifiers.focus(); await page.keyboard.press('Enter'); }
  await expect(page.getByText(`Request: ${trace.snapshot().request_id}`)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.screenshot({ path: `tmp/planning-baseline/${info.project.name}-${failed ? 'failure' : 'answer'}.png`, fullPage: true });
  await page.reload({ waitUntil: 'domcontentloaded' }); await openChat(); await expect(details).toBeVisible();
  expect(errors).toEqual([]);
});

test('P01.1 malformed schedule can reload using keyboard or touch', async ({ page, isMobile }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const id = fixtureId(910); let requests = 0; let recovered = false;
  const validPlan = { from: '2026-10-06', to: '2026-10-06', work_start: 9, work_end: 12, days: [], busy: [], blocks: [], unplaced: [], scheduler: { status: 'incomplete', gap_minutes: 0, unestimated_count: 1, overflow_count: 0 } };
  await page.addInitScript(({ id }) => { localStorage.setItem('marina-os-ui-v1', JSON.stringify({ version: 0, state: { currentTab: 'Copilot', copilotActiveSessionId: id, copilotMessages: [] } })); }, { id });
  await page.route(`**/api/ai/sessions/${id}/messages`, route => { requests++; return route.fulfill({ json: [{ id: fixtureId(911), role: 'assistant', content: 'Schedule preview', created_at: new Date().toISOString(), metadata: { plan: recovered ? validPlan : { blocks: null } } }] }); });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  if (isMobile) { await page.getByRole('button', { name: 'Open all pages' }).click(); await page.getByRole('button', { name: 'Open Copilot', exact: true }).click(); }
  await expect(page.getByRole('alert')).toContainText('could not be read');
  const retry = page.getByRole('button', { name: 'Reload conversation' }); await retry.scrollIntoViewIfNeeded();
  const box = await retry.boundingBox(); expect(box!.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: `tmp/planning-baseline/${info.project.name}-invalid-preview.png`, fullPage: true });
  recovered = true;
  if (isMobile) await retry.tap(); else { await retry.focus(); await page.keyboard.press('Enter'); }
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Apply 0 blocks' })).toBeDisabled();
  expect(requests).toBeGreaterThanOrEqual(2); expect(errors).toEqual([]);
});
