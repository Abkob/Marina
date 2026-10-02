import { scopeKey, type ResourceScope } from '../../shared/resourceScope.js';
/** A context change starts a fresh model context, while the visible transcript stays intact. */
export function historyInScope<T extends { metadata_json: string | null }>(rows: T[], scope: ResourceScope = {}): T[] {
  let start = rows.length;
  for (let i = rows.length - 1; i >= 0; i--) {
    try {
      const saved = rows[i].metadata_json ? JSON.parse(rows[i].metadata_json!) : {};
      if (scopeKey(saved.resource_scope ?? {}) !== scopeKey(scope)) break;
      start = i;
    } catch { break; }
  }
  return rows.slice(start);
}
