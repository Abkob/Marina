import { FormEvent, useEffect, useState } from 'react';

type AuthStatus = { required: boolean; configured: boolean; authenticated: boolean };

export function AuthGate({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    try {
      const response = await fetch('/api/auth/status', { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) throw new Error('Unable to check authentication');
      setStatus(await response.json() as AuthStatus);
    } catch {
      setStatus({ required: true, configured: false, authenticated: false });
      setError('The server is unavailable or authentication is not configured.');
    }
  };

  useEffect(() => { void refresh(); }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? 'Sign-in failed');
      }
      setPassword('');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  };

  if (!status) {
    return <div className="flex min-h-screen items-center justify-center bg-[#f8f8fb] text-sm text-gray-400">Checking secure session…</div>;
  }
  if (!status.required || status.authenticated) return <>{children}</>;

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#f8f8fb] px-4">
      <form onSubmit={submit} className="w-full max-w-sm rounded-3xl border border-gray-200 bg-white p-8 shadow-xl shadow-indigo-100/40">
        <p className="font-mono text-xs font-bold uppercase tracking-[0.24em] text-[#4648d4]">Marina</p>
        <h1 className="mt-3 text-2xl font-black text-gray-900">Private workspace</h1>
        <p className="mt-2 text-sm leading-6 text-gray-500">
          {status.configured ? 'Enter your deployment password to continue.' : 'Authentication is not configured on the server. Add the required environment variables before using this deployment.'}
        </p>
        {status.configured && (
          <>
            <label className="mt-6 block text-xs font-bold uppercase tracking-wider text-gray-500" htmlFor="marina-password">Password</label>
            <input id="marina-password" type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} className="mt-2 w-full rounded-xl border border-gray-200 px-4 py-3 outline-none focus:border-[#4648d4] focus:ring-2 focus:ring-indigo-100" required autoFocus />
            <button type="submit" disabled={busy} className="mt-4 w-full rounded-xl bg-[#4648d4] px-4 py-3 text-sm font-bold text-white disabled:opacity-50">{busy ? 'Signing in…' : 'Sign in'}</button>
          </>
        )}
        {error && <p role="alert" className="mt-4 text-sm text-red-600">{error}</p>}
      </form>
    </main>
  );
}
