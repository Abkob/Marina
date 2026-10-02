function safeHref(value: string): string | null {
  if (/^\/api\/resources\/blob\/[\w-]+(?:#page=\d+)?$/.test(value)) return value;
  if (!/^https?:\/\//i.test(value) || /[\s<>\\]/.test(value)) return null;
  try {
    const url = new URL(value);
    return url.username || url.password ? null : url.href;
  } catch { return null; }
}

/** Small inert formatter for chat prose: never interpret HTML or executable URLs. */
export function CopilotInlineText({ text }: { text: string }) {
  return <>{text.split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]\n]+\]\([^\s)]+\))/g).map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={index} className="font-semibold text-slate-900">{part.slice(2, -2)}</strong>;
    if (part.startsWith('`') && part.endsWith('`')) return <code key={index} className="bg-slate-50 px-1 py-0.5 rounded text-[11px] font-mono text-indigo-700">{part.slice(1, -1)}</code>;
    const link = /^\[([^\]\n]+)\]\(([^\s)]+)\)$/.exec(part);
    const href = link ? safeHref(link[2]) : null;
    if (link && href) return <a key={index} href={href} target="_blank" rel="noopener noreferrer" className="rounded-sm text-indigo-700 underline decoration-indigo-300 underline-offset-2 break-words focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400">{link[1]}</a>;
    return part;
  })}</>;
}
