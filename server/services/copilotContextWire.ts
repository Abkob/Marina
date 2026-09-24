/** Lossless JSON tables: repeat field names and constant values once, not per row.
 * No estimates, IDs, dates, prose or relationships are summarized or rounded.
 */
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const record = (value: Json): value is Record<string, Json> => value !== null && typeof value === 'object' && !Array.isArray(value);

export const CONTEXT_WIRE_GUIDE = `Data encoding: {"$table":{"columns":["id","title"],"rows":[["t1","Draft"]],"defaults":{"status":"todo"}}} means an array of records: each row maps positionally to columns, plus defaults on EVERY row. Values and real IDs are unchanged; null is unknown/unset, never zero. A $literal wrapper escapes an ordinary object. {"same_as":{"call_id":"r1","field":"capacity"}} reuses that exact earlier observation field, still in this conversation. Graph links are goal_id, parent_task_id, milestone_id and blocker_ids (prerequisites blocking this task). Priority, remaining_minutes and deadlines are separate facts, not one score. Rollup parents must not be added to their children's work totals. Coverage/limits describe partial reads; retrieve more before claiming completeness.`;

export function packContext(input: unknown): Json {
  // Match JSON wire semantics (Dates, undefined) before transforming.
  const visit = (value: Json): Json => {
    if (Array.isArray(value)) {
      const plain = value.map(visit);
      if (value.length < 3 || !value.every(record)) return plain;
      const keys = Object.keys(value[0]);
      if (!keys.length || !value.every(row => Object.keys(row).length === keys.length && keys.every(key => Object.hasOwn(row, key)))) return plain;
      const constants = keys.filter(key => value.every(row => JSON.stringify(row[key]) === JSON.stringify(value[0][key])));
      const columns = keys.filter(key => !constants.includes(key));
      const table: Json = { $table: {
        columns,
        ...(constants.length ? { defaults: Object.fromEntries(constants.map(key => [key, visit(value[0][key])])) } : {}),
        rows: value.map(row => columns.map(key => visit(row[key]))),
      } };
      // Avoid inflating tiny or irregular results with a schema wrapper.
      return JSON.stringify(table).length + 32 < JSON.stringify(plain).length ? table : plain;
    }
    if (!record(value)) return value;
    const result = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, visit(item)]));
    return Object.hasOwn(value, '$table') || Object.hasOwn(value, '$literal') ? { $literal: result } : result;
  };
  return visit(JSON.parse(JSON.stringify(input)) as Json);
}

/** Reference decoder used for preservation checks and diagnostics, not another LLM call. */
export function unpackContext(value: Json): Json {
  if (Array.isArray(value)) return value.map(unpackContext);
  if (!record(value)) return value;
  if (record(value.$literal ?? null)) return Object.fromEntries(Object.entries(value.$literal as Record<string, Json>).map(([key, item]) => [key, unpackContext(item)]));
  if (record(value.$table ?? null)) {
    const table = value.$table as { columns: string[]; defaults?: Record<string, Json>; rows: Json[][] };
    const defaults = unpackContext(table.defaults ?? {}) as Record<string, Json>;
    return table.rows.map(row => ({ ...defaults, ...Object.fromEntries(table.columns.map((key, i) => [key, unpackContext(row[i])])) }));
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, unpackContext(item)]));
}

/** One request only: exact repeated sections refer to their first observation.
 * Prior observations remain in history. No cross-turn cache of mutable facts.
 */
export class ContextObservations {
  private sections = new Map<string, { call_id: string; field: string }>();
  rawChars = 0;
  sentChars = 0;

  encode(callId: string, data: unknown): Json {
    const packed = packContext(data);
    const additions = new Map<string, { call_id: string; field: string }>();
    if (record(packed)) for (const [field, value] of Object.entries(packed)) {
      const signature = JSON.stringify(value);
      if (signature.length < 300) continue;
      const previous = this.sections.get(signature);
      if (previous) packed[field] = { same_as: previous };
      else additions.set(signature, { call_id: callId, field });
    }
    const size = JSON.stringify(packed).length;
    if (size >= 50_000 || this.sentChars + size > 70_000) throw new Error('Context budget reached. Request fewer workspace sections or a smaller task page. Earlier observations remain available.');
    for (const [key, value] of additions) this.sections.set(key, value);
    this.rawChars += JSON.stringify(data).length;
    this.sentChars += size;
    return packed;
  }
}
