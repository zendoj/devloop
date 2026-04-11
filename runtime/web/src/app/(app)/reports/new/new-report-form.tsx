'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

interface ProjectOption {
  id: string;
  slug: string;
  name: string;
}

interface Props {
  projects: ProjectOption[];
  preselectedId: string;
}

export default function NewReportForm({
  projects,
  preselectedId,
}: Props): React.ReactElement {
  const router = useRouter();
  const [projectId, setProjectId] = useState(preselectedId);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch('/api/reports', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: projectId,
          title,
          description,
        }),
      });
      if (res.status === 401) {
        setError('Session expired. Please sign in again.');
        return;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { message?: string | string[] }
          | null;
        const msg =
          body?.message === undefined
            ? `Create failed (${res.status})`
            : Array.isArray(body.message)
              ? body.message.join(', ')
              : body.message;
        setError(msg);
        return;
      }
      const body = (await res.json()) as { report_id: string };
      router.replace(`/reports/${body.report_id}`);
      router.refresh();
    } catch (err) {
      setError(`Network error: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="form" onSubmit={handleSubmit}>
      <div className="field">
        <label className="label" htmlFor="project">
          Project
        </label>
        <select
          id="project"
          className="select"
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
          disabled={busy}
          required
        >
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} ({p.slug})
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label className="label" htmlFor="title">
          Title
          <span className="label-hint">max 200 chars</span>
        </label>
        <input
          id="title"
          className="input"
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={200}
          required
          disabled={busy}
          autoFocus
          placeholder="e.g. Login page shows a blank screen on mobile"
        />
      </div>

      <div className="field">
        <label className="label" htmlFor="description">
          Description
          <span className="label-hint">repro steps, expected vs actual</span>
        </label>
        <textarea
          id="description"
          className="textarea"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={50_000}
          required
          disabled={busy}
          placeholder={`Steps to reproduce:
1. …
2. …

Expected: …
Actual: …`}
        />
      </div>

      {error !== null && <div className="form-error">{error}</div>}

      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? 'Filing…' : 'File report'}
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          disabled={busy}
          onClick={() => router.back()}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
