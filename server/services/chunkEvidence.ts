export function chunkEvidence(value: unknown) {
  try {
    const metadata = typeof value === 'string' ? JSON.parse(value) : value;
    const kind = ['text','ocr','visual','structure'].includes(metadata?.evidence_kind) ? metadata.evidence_kind as 'text'|'ocr'|'visual'|'structure' : 'text';
    return { evidence_kind: kind, heading: typeof metadata?.heading === 'string' ? metadata.heading : null,
      model: typeof metadata?.model === 'string' ? metadata.model : undefined, generation: typeof metadata?.generation === 'number' ? metadata.generation : undefined };
  } catch { return { evidence_kind: 'text' as const, heading: null }; }
}
