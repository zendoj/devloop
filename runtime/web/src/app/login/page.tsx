'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

type Stage =
  | { kind: 'password' }
  | { kind: 'pending_2fa'; challenge: string; email: string };

export default function LoginPage(): React.ReactElement {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>({ kind: 'password' });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handlePassword(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email, password }),
      });
      if (res.status === 401) {
        setError('Invalid email or password.');
        return;
      }
      if (!res.ok) {
        setError(`Login failed (${res.status}).`);
        return;
      }
      const body = (await res.json()) as
        | { status: 'ok' }
        | { status: 'pending_2fa'; challenge: string };
      if (body.status === 'pending_2fa') {
        setStage({ kind: 'pending_2fa', challenge: body.challenge, email });
        setPassword('');
        return;
      }
      router.replace('/');
      router.refresh();
    } catch (err) {
      setError(`Network error: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function handle2fa(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (stage.kind !== 'pending_2fa') return;
    setError(null);
    setBusy(true);
    try {
      const res = await fetch('/auth/2fa/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ challenge: stage.challenge, code }),
      });
      if (res.status === 401) {
        setError('Invalid 2FA code.');
        setCode('');
        return;
      }
      if (!res.ok && res.status !== 204) {
        setError(`2FA verification failed (${res.status}).`);
        return;
      }
      router.replace('/');
      router.refresh();
    } catch (err) {
      setError(`Network error: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="center">
      <div className="card">
        <h1 className="brand">DevLoop</h1>
        <p className="tagline">
          {stage.kind === 'password'
            ? 'Sign in to continue'
            : 'Enter the code from your authenticator'}
        </p>

        {stage.kind === 'password' ? (
          <form onSubmit={handlePassword} autoComplete="on">
            <div className="field">
              <label className="label" htmlFor="email">
                Email
              </label>
              <input
                id="email"
                className="input"
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={busy}
              />
            </div>
            <div className="field">
              <label className="label" htmlFor="password">
                Password
              </label>
              <input
                id="password"
                className="input"
                type="password"
                autoComplete="current-password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={busy}
              />
            </div>
            <button type="submit" className="button" disabled={busy}>
              {busy ? 'Signing in...' : 'Sign in'}
            </button>
            {error !== null && <div className="error">{error}</div>}
          </form>
        ) : (
          <form onSubmit={handle2fa} autoComplete="off">
            <div className="field">
              <label className="label" htmlFor="code">
                6-digit code for {stage.email}
              </label>
              <input
                id="code"
                className="input code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                required
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, ''))}
                disabled={busy}
                autoFocus
              />
            </div>
            <button type="submit" className="button" disabled={busy || code.length !== 6}>
              {busy ? 'Verifying...' : 'Verify'}
            </button>
            {error !== null && <div className="error">{error}</div>}
            <div className="hint">
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  setStage({ kind: 'password' });
                  setCode('');
                  setError(null);
                }}
              >
                Back to sign in
              </a>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
