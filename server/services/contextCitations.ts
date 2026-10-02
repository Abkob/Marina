/** Only entities actually included in the selected context count as sources. */
export function citationsForContext<T extends { entity_id: string }>(data: unknown, candidates: T[]): T[] {
  const ids = new Set<string>();
  function visit(value: unknown) {
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if ((key === 'id' || key === 'entity_id' || key.endsWith('_id')) && typeof item === 'string') ids.add(item);
      else if (key.endsWith('_ids') && Array.isArray(item)) for (const id of item) { if (typeof id === 'string') ids.add(id); }
      else if (typeof item === 'object') visit(item);
    }
  }
  visit(data);
  return candidates.filter(citation => ids.has(citation.entity_id));
}
