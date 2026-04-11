'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

interface Props {
  reportId: string;
}

export default function ThreadForm({ reportId }: Props): React.ReactElement {
  const router = useRouter();
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/reports/${reportId}/threads`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => null)) as
          | { message?: string | string[] }
          | null;
        const msg =
          b?.message === undefined
            ? `Failed (${res.status})`
            : Array.isArray(b.message)
              ? b.message.join(', ')
              : b.message;
        setError(msg);
        return;
      }
      setBody('');
      router.refresh();
    } catch (err) {
      setError(`Network error: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="form"
      style={{ marginTop: 14, maxWidth: 'none' }}
    >
      <div className="field">
        <label className="label" htmlFor="thread-body">
          Add comment
        </label>
        <textarea
          id="thread-body"
          className="textarea"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={3}
          disabled={busy}
          placeholder="Add a comment or update…"
        />
      </div>
      {error !== null && <div className="form-error">{error}</div>}
      <div className="form-actions">
        <button
          type="submit"
          className="btn btn-primary"
          disabled={busy || body.trim().length === 0}
        >
          {busy ? 'Posting…' : 'Post comment'}
        </button>
      </div>
    </form>
  );
}
