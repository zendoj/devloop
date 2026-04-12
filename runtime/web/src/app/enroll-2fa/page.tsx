'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * First-login 2FA enrollment page.
 *
 * Routed to by (app)/layout.tsx when /auth/me returns
 * must_enroll_2fa=true. Calls /auth/2fa/enroll on mount to get
 * the fresh secret + QR PNG, then asks the user to scan and
 * paste the first TOTP code. On success calls /auth/2fa/confirm
 * and redirects to /.
 *
 * Deliberate UX constraint per operator request: NO explanatory
 * text, NO links to authenticator apps, NO recovery codes. Just
 * the QR and the secret. The reporter already knows what to do.
 */

type Stage =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; qrPngBase64: string; secret: string };

export default function Enroll2faPage(): React.ReactElement {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>({ kind: 'loading' });
  const [code, setCode] = useState('');
  const [confirmErr, setConfirmErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/auth/2fa/enroll', {
          method: 'POST',
          credentials: 'include',
        });
        if (res.status === 401) {
          router.replace('/login');
          return;
        }
        if (!res.ok) {
          if (cancelled) return;
          setStage({ kind: 'error', message: `enroll failed (${res.status})` });
          return;
        }
        const body = (await res.json()) as {
          secret: string;
          otpauth_uri: string;
          qr_png_base64: string;
        };
        if (cancelled) return;
        setStage({
          kind: 'ready',
          qrPngBase64: body.qr_png_base64,
          secret: body.secret,
        });
      } catch (err) {
        if (cancelled) return;
        setStage({
          kind: 'error',
          message: `network error: ${(err as Error).message}`,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  async function handleConfirm(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setConfirmErr(null);
    setBusy(true);
    try {
      const res = await fetch('/auth/2fa/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ code }),
      });
      if (res.status === 401) {
        setConfirmErr('Invalid code.');
        setCode('');
        return;
      }
      if (!res.ok && res.status !== 204) {
        setConfirmErr(`Confirm failed (${res.status}).`);
        return;
      }
      router.replace('/');
      router.refresh();
    } catch (err) {
      setConfirmErr(`Network error: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="center">
      <div className="auth-card">
        <h1 className="brand">DevLoop</h1>
        <p className="tagline">Scan the code</p>

        {stage.kind === 'loading' && (
          <div style={{ padding: 20, color: '#8a8f99', fontSize: 12 }}>
            Generating…
          </div>
        )}

        {stage.kind === 'error' && (
          <div className="error" style={{ marginTop: 12 }}>
            {stage.message}
          </div>
        )}

        {stage.kind === 'ready' && (
          <>
            <div
              style={{
                display: 'flex',
                justifyContent: 'center',
                padding: '16px 0',
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`data:image/png;base64,${stage.qrPngBase64}`}
                alt="2FA QR"
                style={{
                  width: 220,
                  height: 220,
                  imageRendering: 'pixelated',
                  background: '#ffffff',
                  padding: 8,
                  borderRadius: 4,
                }}
              />
            </div>
            <div
              style={{
                textAlign: 'center',
                fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
                fontSize: 14,
                letterSpacing: 1,
                color: '#ffffff',
                userSelect: 'all',
                margin: '8px 0 16px',
                wordBreak: 'break-all',
              }}
            >
              {stage.secret}
            </div>

            <form onSubmit={handleConfirm} autoComplete="off">
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={6}
                value={code}
                onChange={(e) =>
                  setCode(e.target.value.replace(/\D/g, '').slice(0, 6))
                }
                placeholder="000000"
                style={{
                  display: 'block',
                  width: '100%',
                  padding: '10px 12px',
                  background: '#0f1117',
                  color: '#ffffff',
                  border: '1px solid #3a4050',
                  borderRadius: 4,
                  fontSize: 18,
                  letterSpacing: 6,
                  textAlign: 'center',
                  fontFamily: 'ui-monospace, monospace',
                  outline: 'none',
                  boxSizing: 'border-box',
                  marginBottom: 12,
                }}
                autoFocus
                disabled={busy}
              />
              {confirmErr && (
                <div className="error" style={{ marginBottom: 10 }}>
                  {confirmErr}
                </div>
              )}
              <button
                type="submit"
                className="primary"
                disabled={busy || code.length !== 6}
                style={{ width: '100%' }}
              >
                {busy ? 'Verifying…' : 'Verify'}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
