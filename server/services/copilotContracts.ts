import { z } from 'zod';

// Compact, generated signatures keep runtime Zod validation authoritative.
// Unlike manually maintained examples, constraints cannot silently drift.
export const CONTRACT_GUIDE = 'Parameter notation: field? is optional; | means alternatives; Array<T> means a JSON array. All objects reject unknown fields. Constraints in [...] apply literally; format="date" is a valid YYYY-MM-DD calendar date. Supply JSON values, never this notation.';

export function compactSchema(schema: z.ZodType): string {
  const describe = (node: Record<string, any>): string => {
    const { $schema: _schema, additionalProperties, ...rest } = node;
    if (node.anyOf || node.oneOf) return (node.anyOf ?? node.oneOf).map(describe).join('|');
    if ('const' in node) return JSON.stringify(node.const);
    if (node.enum) return node.enum.map((value: unknown) => JSON.stringify(value)).join('|');
    let type: string;
    if (node.type === 'object') {
      const required = new Set(node.required ?? []);
      type = `{${Object.entries(node.properties ?? {}).map(([key, value]) => `${key}${required.has(key) ? '' : '?'}:${describe(value as Record<string, any>)}`).join(',')}}`;
      if (additionalProperties && typeof additionalProperties === 'object') type += ` & Record<string,${describe(additionalProperties)}>`;
    } else if (node.type === 'array') type = `Array<${describe(node.items ?? {})}>`;
    else type = Array.isArray(node.type) ? node.type.join('|') : node.type ?? 'unknown';
    // Zod repeats a long leap-year regex for every date. The standard date
    // format conveys the same constraint; Zod still enforces the full regex.
    const metadata = Object.entries(rest).filter(([key]) => !['type', 'properties', 'required', 'items'].includes(key)
      && !(key === 'pattern' && node.format === 'date'));
    return type + (metadata.length ? `[${metadata.map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(',')}]` : '');
  };
  return describe(z.toJSONSchema(schema, { unrepresentable: 'any' }));
}
