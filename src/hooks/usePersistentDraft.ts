import { useState, type SetStateAction } from 'react';

/** Save text only; files and submitted entries are never stored in this draft. */
export function usePersistentDraft(key: string) {
  const read = (draftKey: string) => { try { return window.localStorage.getItem(`marina-draft:${draftKey}`) ?? ''; } catch { return ''; } };
  const [state, setState] = useState(() => ({ key, text: read(key) }));
  const current = state.key === key ? state.text : read(key);
  if (state.key !== key) setState({ key, text: current });
  const setText = (update: SetStateAction<string>) => {
    const text = typeof update === 'function' ? update(current) : update;
    setState({ key, text });
    try { if (text) window.localStorage.setItem(`marina-draft:${key}`, text); else window.localStorage.removeItem(`marina-draft:${key}`); } catch { /* Keep the in-memory draft if storage is unavailable. */ }
  };
  return [current, setText] as const;
}
