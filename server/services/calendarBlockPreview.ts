import { z } from 'zod';
import { ActionParamsSchemas } from './actionValidation.js';
import { expandSeries, type SeriesParams, type SeriesBlock } from './planLayout.js';
import { calendarPlanSchema } from '../../shared/calendarPlanContract.js';

/** Keep the single-series contract working while allowing one card for several activities. */
const singleSeriesSchema = ActionParamsSchemas.create_block_series as z.ZodType<SeriesParams>;
export const calendarBlockPreviewSchema = z.union([
  singleSeriesSchema,
  z.object({ series: z.array(singleSeriesSchema).min(1).max(10) }).strict(),
]).superRefine((input, ctx) => {
  const series = calendarBlockSeries(input);
  for (const item of series) {
    const duration = item.end_hour - item.start_hour;
    if (item.end_date < item.start_date || duration < 0.25 || duration > 12) {
      ctx.addIssue({ code: 'custom', message: 'Each activity needs ordered dates and a duration from 15 minutes to 12 hours.' });
    }
  }
  const from = series.map(item => item.start_date).sort()[0];
  const to = series.map(item => item.end_date).sort().at(-1)!;
  if (Date.parse(to) - Date.parse(from) > 119 * 86_400_000) {
    ctx.addIssue({ code: 'custom', message: 'Keep all activities within one date window of at most 120 days.' });
  }
  if (series.flatMap(expandSeries).length > 200) {
    ctx.addIssue({ code: 'custom', message: 'Preview at most 200 calendar blocks so the entire card can be applied together.' });
  }
});

export type CalendarBlockPreviewParams = SeriesParams | { series: SeriesParams[] };
export function calendarBlockSeries(input: CalendarBlockPreviewParams): SeriesParams[] {
  return 'series' in input ? input.series : [input];
}

type CalendarPreview = z.infer<typeof calendarPlanSchema>;
const titleKey = (title: string) => title.trim().replace(/\s+/g, ' ').toLowerCase();
const blockKey = (block: SeriesBlock) => JSON.stringify([titleKey(block.title), block.date, block.start_hour, block.duration_hours, block.task_id ?? null]);

/** Repeated calculations and already-saved context must not create duplicate events. */
export function calendarBlockOccurrences(series: SeriesParams[], busy: CalendarPreview['busy']) {
  const candidates = [...new Map(series.flatMap(expandSeries).map(block => [blockKey(block), block])).values()]
    .sort((a, b) => a.date.localeCompare(b.date) || a.start_hour - b.start_hour);
  const existing = new Set(busy.map(block => blockKey(block)));
  const alreadyScheduled = candidates.filter(block => !block.task_id && existing.has(blockKey(block)));
  const blocks = candidates.filter(block => block.task_id || !existing.has(blockKey(block)));
  return { blocks, already_scheduled: alreadyScheduled };
}

/** Separate model calls must not silently replace earlier activities in the same reply. */
export function combineCalendarSeriesPreviews(previews: unknown[]): CalendarPreview {
  const plans = previews.map(value => calendarPlanSchema.parse(value));
  const first = plans[0];
  if (!first || plans.some(plan => plan.kind !== 'series' || plan.status !== 'pending' || Object.keys(plan.adjustments ?? {}).length)) {
    throw new Error('Only new calendar block previews can be combined.');
  }
  const blocks = [...new Map(plans.flatMap(plan => plan.blocks).map(block => [blockKey(block), block])).values()];
  if (blocks.length > 200) throw new Error('Preview at most 200 calendar blocks together.');
  const busy = [...new Map(plans.flatMap(plan => plan.busy).map(block => [JSON.stringify(block), block])).values()];
  return calendarPlanSchema.parse({
    ...first,
    from: plans.map(plan => plan.from).sort()[0],
    to: plans.map(plan => plan.to).sort().at(-1),
    work_start: Math.min(...plans.map(plan => plan.work_start)),
    work_end: Math.max(...plans.map(plan => plan.work_end)),
    blocks, busy,
  });
}

/** Report overlaps as evidence; fixed times stay exactly as requested. */
export function calendarBlockOverlaps(blocks: CalendarPreview['blocks'], busy: CalendarPreview['busy']) {
  const overlaps: Array<{ title: string; overlaps_with: string; date: string; start_hour: number; end_hour: number }> = [];
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index];
    for (const other of [...busy, ...blocks.slice(index + 1)]) {
      if (block.date !== other.date) continue;
      const start = Math.max(block.start_hour, other.start_hour);
      const end = Math.min(block.start_hour + block.duration_hours, other.start_hour + other.duration_hours);
      if (end > start) overlaps.push({ title: block.title, overlaps_with: other.title, date: block.date, start_hour: start, end_hour: end });
    }
  }
  return { overlap_count: overlaps.length, overlaps: overlaps.slice(0, 30), overlaps_omitted: Math.max(0, overlaps.length - 30) };
}
