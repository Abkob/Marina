export class ApiError extends Error {
  constructor(public readonly status: number, message: string, public readonly data?: unknown) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Called after every SUCCESSFUL non-GET request with (method, url).
 *  App.tsx registers a listener that invalidates the react-query caches the
 *  mutated endpoint affects — so no page can forget to invalidate and go
 *  stale ("I have to refresh to see my change"). */
type MutationListener = (method: string, url: string) => void;
let mutationListener: MutationListener | null = null;
export function setMutationListener(fn: MutationListener | null) {
  mutationListener = fn;
}

/** Typed fetch wrapper: throws ApiError on non-2xx responses. */
export async function apiFetch<T = unknown>(
  url: string,
  options?: RequestInit,
): Promise<T> {
  const res = await fetch(url, options);
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    let message: string;
    let data: unknown;
    try { data = JSON.parse(text); message = (data as { error?: string } | null)?.error ?? text; }
    catch { message = text; }
    throw new ApiError(res.status, message, data);
  }
  const method = (options?.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && mutationListener) {
    try { mutationListener(method, url); } catch { /* invalidation must never break the request */ }
  }
  // 204 No Content — return empty object
  if (res.status === 204) return {} as T;
  return res.json() as Promise<T>;
}

/** POST helper with JSON body. */
export function apiPost<T = unknown>(url: string, body: unknown): Promise<T> {
  return apiFetch<T>(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** PUT helper with JSON body. */
export function apiPut<T = unknown>(url: string, body: unknown): Promise<T> {
  return apiFetch<T>(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** PATCH helper with JSON body. */
export function apiPatch<T = unknown>(url: string, body: unknown): Promise<T> {
  return apiFetch<T>(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** DELETE helper. */
export function apiDelete<T = unknown>(url: string): Promise<T> {
  return apiFetch<T>(url, { method: 'DELETE' });
}
