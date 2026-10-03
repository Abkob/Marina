import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { assertBoundedPayload, effortLabel, effortSchema, planningContextSchema, planningEvidenceSchema, planningMinutesSchema, readPlanningContext, referenceKey } from '../../shared/planningContracts';
import { readCalendarPreview, readCalendarOptions } from '../../shared/calendarPlanContract';
import { validateModelActions } from '../../server/services/actionValidation';
import { runCopilotConversation } from '../../server/services/copilotConversation';

const context = () => ({ version: 1, root: { kind: 'task', id: 't' }, references: [], work_items: [{ reference: { kind: 'work_item', id: 'temporary-1' }, task: { kind: 'task', id: 't' }, title: 'Read the chapter', effort: { state: 'unknown', minutes: null }, evidence: [] }] });
const preview = () => ({ from: '2026-10-06', to: '2026-10-06', work_start: 9, work_end: 12, days: [], busy: [], blocks: [], unplaced: [], scheduler: { status: 'impossible', gap_minutes: -60, unestimated_count: 1, overflow_count: 0 } });

describe('P01.1 planning wire contracts', () => {
  it('keeps unknown effort separate from a measured zero and a genuine range', () => {
    expect(readPlanningContext(context()).ok).toBe(true);
    expect(effortLabel(effortSchema.parse({ state: 'unknown', minutes: null }))).toBe('Not estimated');
    expect(effortLabel(effortSchema.parse({ state: 'known', minutes: 0, basis: 'measured' }))).toBe('0 min');
    expect(effortLabel(effortSchema.parse({ state: 'range', low: 10, central: 30, high: 60 }))).toBe('10–60 min');
    expect(effortSchema.safeParse({ state: 'known', minutes: null, basis: 'estimate' }).success).toBe(false);
    expect(effortSchema.safeParse({ state: 'unknown', minutes: 0 }).success).toBe(false);
  });
  it.each([NaN, Infinity, -Infinity, -1, 525601, null, '60'])('rejects invalid minutes %s', minutes => {
    expect(planningMinutesSchema.safeParse(minutes).success).toBe(false);
  });
  it.each([[40, 30, 60], [10, 70, 60]])('rejects reversed effort range %j', (low, central, high) => {
    expect(effortSchema.safeParse({ state: 'range', low, central, high }).success).toBe(false);
  });
  it.each(['unknown', 'partial', 'stale', 'current'])('retains explicit %s evidence state', state => {
    expect(planningEvidenceSchema.parse({ resource: { kind: 'resource', id: 'r' }, state, generation: 1, pages: { from: 94, to: 96 } }).state).toBe(state);
  });
  it('rejects current evidence without a generation, reversed pages and wrong kinds', () => {
    const evidence = { resource: { kind: 'resource', id: 'r' }, state: 'current', generation: 1, pages: { from: 94, to: 96 } };
    for (const change of [{ generation: null }, { pages: { from: 96, to: 94 } }, { resource: { kind: 'task', id: 'r' } }]) expect(planningEvidenceSchema.safeParse({ ...evidence, ...change }).success).toBe(false);
    for (const kind of ['resource', 'work_item', 'unknown']) expect(readPlanningContext({ ...context(), root: { kind, id: 't' } }).ok).toBe(false);
    expect(readPlanningContext({ ...context(), work_items: [{ ...context().work_items[0], task: { kind: 'resource', id: 'r' } }] }).ok).toBe(false);
  });
  it('rejects duplicate temporary IDs but preserves same-string identities in different tables', () => {
    const value = context(); value.work_items.push(structuredClone(value.work_items[0]));
    expect(readPlanningContext(value).ok).toBe(false);
    const references = [{ kind: 'task', id: 'same' }, { kind: 'resource', id: 'same' }];
    expect(planningContextSchema.safeParse({ ...context(), references }).success).toBe(true);
    expect(referenceKey(references[0])).not.toBe(referenceKey(references[1]));
    expect(planningContextSchema.safeParse({ ...context(), references: [references[0], references[0]] }).success).toBe(false);
  });
  it.each(['unknown_action', 'constructor', '__proto__', 'toString'])('rejects unsupported action %s without throwing', type => {
    expect(validateModelActions([{ type, params: {} }])[0].rejected_reason).toBeTruthy();
  });
  it('preserves signed capacity gaps but rejects null effort and invalid windows', () => {
    expect(readCalendarPreview(preview()).ok).toBe(true);
    for (const change of [{ from: '2026-02-30' }, { to: '2026-10-05' }, { to: '9999-12-31' }, { work_end: 8 }, { unplaced: [{ task_id: 't', title: 'Work', minutes: null }] }]) expect(readCalendarPreview({ ...preview(), ...change }).ok).toBe(false);
    expect(readCalendarOptions({ kind: 'plan_options', title: 'Options', summary: '', options: [{ ...preview(), option_id: 'a', name: 'A', description: '' }] }).ok).toBe(true);
    expect(readCalendarOptions({ options: [{ blocks: null }] }).ok).toBe(false);
  });
});

describe('P01.1 bounded parsing before retrieval', () => {
  it('rejects 10,000 references without inspecting their contents', () => {
    const refs = Array.from({ length: 10000 }, (_, i) => ({ kind: 'resource', id: `r${i}` }));
    const read = vi.fn(); Object.defineProperty(refs, '0', { get: read });
    expect(() => assertBoundedPayload({ references: refs })).toThrow('too many'); expect(read).not.toHaveBeenCalled();
  });
  it('checks UTF-8 bytes including escaped control characters', () => {
    expect(() => assertBoundedPayload('😀'.repeat(70000))).toThrow('size');
    expect(() => assertBoundedPayload('\u0000'.repeat(45000))).toThrow('size');
    expect(readPlanningContext({ ...context(), work_items: [{ ...context().work_items[0], title: '学'.repeat(501) }] }).ok).toBe(false);
  });
  it('fuzzes excessive depths without recursive stack overflow', () => {
    for (let depth = 17; depth <= 200; depth += 7) {
      let value: unknown = null; for (let i = 0; i < depth; i++) value = { child: value };
      expect(() => assertBoundedPayload(value)).toThrow('structural');
    }
    const circular: any = {}; circular.self = circular;
    expect(() => assertBoundedPayload(circular)).toThrow('cycles');
    expect(() => assertBoundedPayload({ a: Array.from({ length: 1000 }, () => Array(11).fill(null)) })).toThrow('structural');
  });
  it('rejects oversized model tool arguments before any tool can execute', async () => {
    const execute = vi.fn();
    const complete = vi.fn().mockResolvedValue(JSON.stringify({ tool_calls: [{ id: 'read', name: 'read', arguments: { refs: Array(10000).fill('t') } }] }));
    await expect(runCopilotConversation({ turns: [{ role: 'user', content: 'Read these tasks' }], clock: { today: '2026-10-06', time: '09:00', timezone: 'UTC' }, complete,
      tools: { read: { description: 'Synthetic read', parameters: z.object({ refs: z.array(z.string()) }), execute } } })).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled(); expect(complete).toHaveBeenCalledTimes(2);
  });
});
