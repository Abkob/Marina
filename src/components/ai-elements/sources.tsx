// Adapted from Vercel AI Elements (Apache-2.0), commit 6a9d5b1822ffb10bba4bd97175f01edd7d8651cd.
// Uses Radix directly; keeps touch targets and Marina styling. See LICENSE.ai-elements.
import * as Collapsible from '@radix-ui/react-collapsible';
import { ChevronDown } from 'lucide-react';
import type { ComponentProps } from 'react';
export const Sources = Collapsible.Root;
export const SourcesContent = Collapsible.Content;
export function SourcesTrigger({ children, count, ...props }: ComponentProps<typeof Collapsible.Trigger> & { count: number }) {
  return <Collapsible.Trigger className="flex min-h-11 items-center gap-2 rounded-lg text-xs text-slate-500 focus-visible:outline-2 focus-visible:outline-indigo-400" {...props}>
    {children ?? <span>{count} sources</span>}<ChevronDown size={13} aria-hidden="true" />
  </Collapsible.Trigger>;
}
