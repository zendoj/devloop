import { cookies } from 'next/headers';
import Link from 'next/link';
import { apiFetchServer } from '@/lib/api';
import { ApproveRejectPanel } from './ApproveRejectPanel';
import { ThreadPanel } from './ThreadPanel';

export const dynamic = 'force-dynamic';

interface TaskDetail {
  id: string;
  display_id: string;
  project_id: string;
  project_slug: string;
  github_owner: string;
  github_repo: string;
  report_id: string;
  report_title: string;
  report_body: string;
  module: string;
  risk_tier: string;
  status: string;
  branch_name: string | null;
  plan: string | null;
  approved_base_sha: string | null;
  approved_head_sha: string | null;
  review_decision: string | null;
  review_score: number | null;
  review_model_used: string | null;
  review_notes_md: string | null;
  audit_status: string | null;
  audit_notes_md: string | null;
  github_pr_number: number | null;
  merged_commit_sha: string | null;
  retry_count: number;
  lease_version: number;
  created_at: string;
  completed_at: string | null;
  human_approved_at: string | null;
  failure_reason: string | null;
  feedback?: Array<{
    id: number;
    attempt_number: number;
    feedback_text: string;
    files: Array<{ name: string; size: number; content: string }>;
    reported_at: string;
  }>;
  threads?: Array<{
    id: string;
    author_kind: string;
    author_name: string;
    body: string;
    created_at: string;
  }>;
  attachments?: Array<{
    id: number;
    name: string;
    mime_type: string;
    size: number;
    content_base64: string;
    created_at: string;
  }>;
}

async function fetchTask(id: string): Promise<TaskDetail | null> {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  const res = await apiFetchServer(`/api/tasks/${id}`, {
    method: 'GET',
    cookieHeader: cookieHeader.length > 0 ? cookieHeader : null,
  });
  if (!res.ok) return null;
  return (await res.json()) as TaskDetail;
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('sv-SE', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function statusPill(status: string): { cls: string; label: string } {
  switch (status) {
    case 'ready_for_test':
      return { cls: 'status-warn', label: 'READY FOR TEST' };
    case 'accepted':
    case 'verified':
      return { cls: 'status-ok', label: status.toUpperCase() };
    case 'failed':
    case 'blocked':
    case 'rollback_failed':
      return { cls: 'status-bad', label: status.toUpperCase() };
    default:
      return { cls: 'status-pending', label: status };
  }
}

export default async function TaskDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<React.ReactElement> {
  const { id } = await params;
  const task = await fetchTask(id);

  if (!task) {
    return (
      <div className="page">
        <div className="page-header">
          <h1>Task not found</h1>
          <p className="page-sub">
            <Link href="/tasks">← Back to task list</Link>
          </p>
        </div>
      </div>
    );
  }

  const pill = statusPill(task.status);
  const canActOnTask = task.status === 'ready_for_test';
  const ghCompareUrl =
    task.approved_base_sha && task.approved_head_sha
      ? `https://github.com/${task.github_owner}/${task.github_repo}/compare/${task.approved_base_sha}...${task.approved_head_sha}`
      : null;
  const ghPrUrl = task.github_pr_number
    ? `https://github.com/${task.github_owner}/${task.github_repo}/pull/${task.github_pr_number}`
    : null;

  return (
    <div className="page">
      <div className="page-header">
        <h1>
          {task.display_id}{' '}
          <span className={`status-pill ${pill.cls}`} style={{ fontSize: 12, marginLeft: 8, verticalAlign: 'middle' }}>
            {pill.label}
          </span>
        </h1>
        <p className="page-sub">
          <Link href="/tasks">← back</Link> · {task.project_slug} · {task.module} ·{' '}
          {task.risk_tier} · created {formatDate(task.created_at)}
        </p>
      </div>

      <section style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>{task.report_title}</h2>
        <div
          className="card"
          style={{
            padding: 12,
            whiteSpace: 'pre-wrap',
            fontSize: 13,
            lineHeight: 1.5,
            color: '#c5c8d0',
          }}
        >
          {task.report_body}
        </div>
      </section>

      {canActOnTask && (
        <section style={{ marginBottom: 24 }}>
          <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>
            Acceptance test
          </h2>
          <div className="card" style={{ padding: 14 }}>
            <p style={{ fontSize: 13, color: '#c5c8d0', marginTop: 0 }}>
              The pipeline finished and the change is deployed to the CRM. Please
              test the fix in the running application and decide:
            </p>
            <ApproveRejectPanel taskId={task.id} />
          </div>
        </section>
      )}

      <section style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>Pipeline output</h2>
        <div className="card" style={{ padding: 14, fontSize: 13 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '180px 1fr', rowGap: 6 }}>
            <div style={{ color: '#8a8f99' }}>Status</div>
            <div>{task.status}</div>

            <div style={{ color: '#8a8f99' }}>Branch</div>
            <div style={{ fontFamily: 'ui-monospace, monospace' }}>
              {task.branch_name ?? '—'}
            </div>

            <div style={{ color: '#8a8f99' }}>Base → Head</div>
            <div style={{ fontFamily: 'ui-monospace, monospace' }}>
              {task.approved_base_sha?.slice(0, 7) ?? '—'} ..{' '}
              {task.approved_head_sha?.slice(0, 7) ?? '—'}{' '}
              {ghCompareUrl && (
                <a href={ghCompareUrl} target="_blank" rel="noreferrer" style={{ marginLeft: 8 }}>
                  view diff on GitHub ↗
                </a>
              )}
            </div>

            <div style={{ color: '#8a8f99' }}>GitHub PR</div>
            <div>
              {ghPrUrl ? (
                <a href={ghPrUrl} target="_blank" rel="noreferrer">
                  #{task.github_pr_number}
                </a>
              ) : (
                '—'
              )}
            </div>

            <div style={{ color: '#8a8f99' }}>Merged SHA</div>
            <div style={{ fontFamily: 'ui-monospace, monospace' }}>
              {task.merged_commit_sha?.slice(0, 12) ?? '—'}
            </div>

            <div style={{ color: '#8a8f99' }}>Reviewer</div>
            <div>
              {task.review_decision ? (
                <>
                  {task.review_decision} · score {task.review_score ?? '—'} ·{' '}
                  {task.review_model_used ?? '—'}
                </>
              ) : (
                '—'
              )}
            </div>

            <div style={{ color: '#8a8f99' }}>Auditor</div>
            <div>{task.audit_status ?? '—'}</div>

            <div style={{ color: '#8a8f99' }}>Retries (human)</div>
            <div>{task.retry_count}</div>

            {task.failure_reason && (
              <>
                <div style={{ color: '#8a8f99' }}>Failure reason</div>
                <div style={{ color: '#ff8080' }}>{task.failure_reason}</div>
              </>
            )}
          </div>
        </div>
      </section>

      {task.plan && (
        <section style={{ marginBottom: 24 }}>
          <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>
            Planner output
          </h2>
          <pre
            className="card"
            style={{
              padding: 12,
              fontSize: 12,
              whiteSpace: 'pre-wrap',
              color: '#c5c8d0',
            }}
          >
            {task.plan}
          </pre>
        </section>
      )}

      {task.review_notes_md && (
        <section style={{ marginBottom: 24 }}>
          <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>
            Reviewer notes
          </h2>
          <pre
            className="card"
            style={{
              padding: 12,
              fontSize: 12,
              whiteSpace: 'pre-wrap',
              color: '#c5c8d0',
            }}
          >
            {task.review_notes_md}
          </pre>
        </section>
      )}

      {task.audit_notes_md && (
        <section style={{ marginBottom: 24 }}>
          <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>
            Security auditor notes
          </h2>
          <pre
            className="card"
            style={{
              padding: 12,
              fontSize: 12,
              whiteSpace: 'pre-wrap',
              color: task.audit_status === 'blocking' ? '#ff8080' : '#c5c8d0',
            }}
          >
            {task.audit_notes_md}
          </pre>
        </section>
      )}

      {task.attachments && task.attachments.length > 0 && (
        <section style={{ marginBottom: 24 }}>
          <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>
            Bug-report attachments ({task.attachments.length})
          </h2>
          <div
            className="card"
            style={{
              padding: 14,
              display: 'flex',
              flexDirection: 'column',
              gap: 14,
            }}
          >
            {task.attachments.map((a) => renderAttachment(a))}
          </div>
        </section>
      )}

      <section style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>
          Conversation
        </h2>
        <ThreadPanel
          taskId={task.id}
          initialThreads={task.threads ?? []}
        />
      </section>

      {task.feedback && task.feedback.length > 0 && (
        <section style={{ marginBottom: 24 }}>
          <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>
            Human rejection history
          </h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {task.feedback.map((f) => (
              <div key={f.id} className="card" style={{ padding: 12, fontSize: 13 }}>
                <div style={{ color: '#8a8f99', fontSize: 11, marginBottom: 4 }}>
                  Attempt {f.attempt_number} · {formatDate(f.reported_at)}
                </div>
                <div style={{ whiteSpace: 'pre-wrap', color: '#c5c8d0' }}>
                  {f.feedback_text}
                </div>
                {f.files.length > 0 && (
                  <div style={{ marginTop: 8, color: '#8a8f99', fontSize: 11 }}>
                    Attached files:{' '}
                    {f.files.map((file) => `${file.name} (${file.size}B)`).join(', ')}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

/**
 * Safely decode a base64 string to UTF-8 text without using
 * Node's Buffer. atob + TextDecoder works in both server and
 * client environments. Wraps in try/catch so one bad attachment
 * doesn't crash the whole page.
 */
function decodeBase64Utf8(b64: string): string {
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    return '[decode error — binary data]';
  }
}

function renderAttachment(a: {
  id: number;
  name: string;
  mime_type: string;
  size: number;
  content_base64: string;
}): React.ReactElement {
  const isImage = a.mime_type.startsWith('image/');
  const isText =
    a.mime_type.startsWith('text/') || a.mime_type === 'application/json';

  let body: React.ReactNode;
  if (isImage) {
    // eslint-disable-next-line @next/next/no-img-element
    body = (
      <img
        src={`data:${a.mime_type};base64,${a.content_base64}`}
        alt={a.name}
        style={{
          maxWidth: '100%',
          maxHeight: 320,
          borderRadius: 4,
          border: '1px solid #2a2f3a',
        }}
      />
    );
  } else if (isText) {
    const text = decodeBase64Utf8(a.content_base64).slice(0, 8000);
    body = (
      <pre
        style={{
          fontSize: 11,
          color: '#c5c8d0',
          background: '#0f1117',
          padding: 8,
          borderRadius: 4,
          maxHeight: 240,
          overflow: 'auto',
          whiteSpace: 'pre-wrap',
          margin: 0,
        }}
      >
        {text || '(empty)'}
      </pre>
    );
  } else {
    body = (
      <div style={{ color: '#6b7280', fontSize: 12 }}>
        (binary — {a.size} bytes)
      </div>
    );
  }

  return (
    <div key={a.id} style={{ fontSize: 12 }}>
      <div style={{ color: '#c5c8d0', marginBottom: 4 }}>
        <code>{a.name}</code>{' '}
        <span style={{ color: '#8a8f99' }}>
          {a.mime_type} · {a.size}B
        </span>
      </div>
      {body}
    </div>
  );
}
