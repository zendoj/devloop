'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

interface CreatedProject {
  id: string;
  slug: string;
  host_token: string;
  deploy_token: string;
}

export default function NewProjectForm(): React.ReactElement {
  const router = useRouter();
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [hostBaseUrl, setHostBaseUrl] = useState('https://');
  const [githubOwner, setGithubOwner] = useState('');
  const [githubRepo, setGithubRepo] = useState('');
  const [githubInstallId, setGithubInstallId] = useState('');
  const [githubBranch, setGithubBranch] = useState('main');

  const [created, setCreated] = useState<CreatedProject | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug,
          name,
          host_base_url: hostBaseUrl,
          github_app_install_id: Number(githubInstallId),
          github_owner: githubOwner,
          github_repo: githubRepo,
          github_default_branch: githubBranch,
        }),
      });
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
      const body = (await res.json()) as CreatedProject;
      setCreated(body);
    } catch (err) {
      setError(`Network error: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  if (created) {
    return (
      <div>
        <div
          className="panel"
          style={{
            borderColor: 'var(--success)',
            boxShadow: '0 0 0 1px rgba(82,199,138,0.15)',
          }}
        >
          <h2 className="panel-title" style={{ color: 'var(--success)' }}>
            ✓ Project registered
          </h2>
          <p className="panel-body">
            The host and deploy tokens below are shown <strong>once</strong>.
            Copy them into your host agent config now — they cannot be
            retrieved later.
          </p>

          <dl className="kv-list" style={{ marginTop: 14 }}>
            <dt>Slug</dt>
            <dd className="mono">{created.slug}</dd>
            <dt>Project ID</dt>
            <dd className="mono">{created.id}</dd>
          </dl>

          <div style={{ marginTop: 18 }}>
            <label className="label">Host token</label>
            <pre className="token-box">{created.host_token}</pre>
          </div>
          <div style={{ marginTop: 12 }}>
            <label className="label">Deploy token</label>
            <pre className="token-box">{created.deploy_token}</pre>
          </div>
        </div>

        <div className="form-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              router.replace(`/projects/${created.slug}`);
              router.refresh();
            }}
          >
            Open project
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              router.replace(
                `/reports/new?project=${encodeURIComponent(created.slug)}`,
              );
              router.refresh();
            }}
          >
            File a bug against this project
          </button>
        </div>
      </div>
    );
  }

  return (
    <form className="form" onSubmit={handleSubmit}>
      <div className="field">
        <label className="label" htmlFor="slug">
          Slug
          <span className="label-hint">lowercase, digits, hyphens</span>
        </label>
        <input
          id="slug"
          className="input mono"
          type="text"
          value={slug}
          onChange={(e) => setSlug(e.target.value.toLowerCase())}
          pattern="[a-z0-9][a-z0-9-]*"
          minLength={2}
          maxLength={64}
          required
          disabled={busy}
          autoFocus
          placeholder="dev-energicrm"
        />
      </div>

      <div className="field">
        <label className="label" htmlFor="name">
          Name
        </label>
        <input
          id="name"
          className="input"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={255}
          required
          disabled={busy}
          placeholder="Dev Energicrm"
        />
      </div>

      <div className="field">
        <label className="label" htmlFor="host_base_url">
          Host base URL
          <span className="label-hint">https://…</span>
        </label>
        <input
          id="host_base_url"
          className="input mono"
          type="url"
          value={hostBaseUrl}
          onChange={(e) => setHostBaseUrl(e.target.value)}
          maxLength={512}
          required
          disabled={busy}
          placeholder="https://dev.energicrm.airpipe.ai"
        />
      </div>

      <div className="field">
        <label className="label" htmlFor="github_owner">
          GitHub owner / repo
        </label>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            id="github_owner"
            className="input mono"
            type="text"
            value={githubOwner}
            onChange={(e) => setGithubOwner(e.target.value)}
            maxLength={128}
            required
            disabled={busy}
            placeholder="zendoj"
            style={{ flex: 1 }}
          />
          <span style={{ color: 'var(--fg-muted)' }}>/</span>
          <input
            className="input mono"
            type="text"
            value={githubRepo}
            onChange={(e) => setGithubRepo(e.target.value)}
            maxLength={128}
            required
            disabled={busy}
            placeholder="energicrm"
            style={{ flex: 1 }}
          />
        </div>
      </div>

      <div className="field">
        <label className="label" htmlFor="github_branch">
          Default branch
        </label>
        <input
          id="github_branch"
          className="input mono"
          type="text"
          value={githubBranch}
          onChange={(e) => setGithubBranch(e.target.value)}
          maxLength={128}
          required
          disabled={busy}
          placeholder="main"
        />
      </div>

      <div className="field">
        <label className="label" htmlFor="github_install_id">
          GitHub App install ID
          <span className="label-hint">integer &gt; 0</span>
        </label>
        <input
          id="github_install_id"
          className="input mono"
          type="number"
          min={1}
          value={githubInstallId}
          onChange={(e) => setGithubInstallId(e.target.value)}
          required
          disabled={busy}
          placeholder="12345"
        />
      </div>

      {error !== null && <div className="form-error">{error}</div>}

      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? 'Registering…' : 'Register project'}
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
