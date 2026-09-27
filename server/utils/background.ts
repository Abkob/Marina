import { waitUntil } from '@vercel/functions';
import { isVercelRuntime } from '../runtime.js';

export function runInBackground<T>(work: Promise<T>, label: string): Promise<void> {
  const handled = work.then(() => undefined).catch((err) => {
    console.error(`[background] ${label}:`, err);
  });
  if (isVercelRuntime) waitUntil(handled);
  return handled;
}
