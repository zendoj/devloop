/**
 * Deploy activity panel — shown on the task detail page.
 *
 * Walks the task through the pipeline visually:
 *   Coding → AI review → Building → Restarting → Ready
 *
 * For each deploy desired_state row attached to the task, shows
 * the apply status, a live timer while applying, and an
 * expandable log (host-agent apply script output including git
 * checkout, npm build, pm2 restart, health probe).
 *
 * Pure server component — the parent /tasks/:id page is a
 * server component and re-renders every few seconds thanks to
 * TaskDetailAutoRefresh, so we just render the current state
 * off the server-fetched data.
 */

interface DeployActivityRow {
  id: string;
  action: string;
  issued_at: string;
  apply_started_at: string | null;
  applied_at: string | null;
  applied_status: string | null;
  applied_log_excerpt: string | null;
  deploy_sha: string;
  slot: 'deploy' | 'rollback' | 'other';
}

const STAGES: Array<{ key: string; label: string }> = [
  { key: 'queued_for_lock', label: 'Queued' },
  { key: 'assigned', label: 'Planning' },
  { key: 'in_progress', label: 'Coding' },
  { key: 'review', label: 'AI review' },
  { key: 'approved', label: 'Deploying' },
  { key: 'deploying', label: 'Deploying' },
  { key: 'merged', label: 'Deploying' },
  { key: 'verifying', label: 'Building + restarting' },
  { key: 'ready_for_test', label: 'Ready for test' },
  { key: 'accepted', label: 'Accepted' },
];

const TERMINAL = new Set([
  'accepted',
  'verified',
  'failed',
  'blocked',
  'cancelled',
  'rolled_back',
  'rollback_failed',
]);

function stageIndex(status: string): number {
  const idx = STAGES.findIndex((s) => s.key === status);
  return idx >= 0 ? idx : -1;
}

function humanDuration(startIso: string, endIso: string | null): string {
  const end = endIso ? new Date(endIso).getTime() : Date.now();
  const ms = end - new Date(startIso).getTime();
  if (ms < 0) return '—';
  if (ms < 1000) return '<1s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

function statusColor(status: string | null): string {
  switch (status) {
    case 'success':
      return '#6ee787';
    case 'failed':
    case 'timed_out':
      return '#ff8080';
    case null:
      return '#ffcc66';
    default:
      return '#8a8f99';
  }
}

function statusLabel(status: string | null): string {
  if (status === null) return 'applying…';
  return status;
}

export function DeployActivity({
  taskStatus,
  deployActivity,
}: {
  taskStatus: string;
  deployActivity: DeployActivityRow[];
}): React.ReactElement {
  const currentIdx = stageIndex(taskStatus);
  const isTerminal = TERMINAL.has(taskStatus);

  return (
    <div className="card" style={{ padding: 14 }}>
      <div
        style={{
          display: 'flex',
          gap: 6,
          alignItems: 'center',
          marginBottom: 14,
          flexWrap: 'wrap',
        }}
      >
        {STAGES.filter((s, i, arr) => arr.findIndex((x) => x.label === s.label) === i).map(
          (stage, i, filteredStages) => {
            const reached = stageIndex(taskStatus) >= STAGES.findIndex((s) => s.label === stage.label);
            const isCurrent = STAGES[currentIdx]?.label === stage.label;
            const color = reached ? (isCurrent && !isTerminal ? '#ffcc66' : '#6ee787') : '#3a4050';
            return (
              <div
                key={stage.key}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                <div
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: 5,
                    background: color,
                    boxShadow: isCurrent && !isTerminal ? `0 0 8px ${color}` : 'none',
                    animation: isCurrent && !isTerminal ? 'devloop-pulse 1.2s ease-in-out infinite' : 'none',
                  }}
                />
                <span
                  style={{
                    fontSize: 11,
                    color: reached ? '#c5c8d0' : '#6b7280',
                    fontWeight: isCurrent ? 600 : 400,
                  }}
                >
                  {stage.label}
                </span>
                {i < filteredStages.length - 1 && (
                  <span style={{ color: '#3a4050', marginLeft: 2 }}>›</span>
                )}
              </div>
            );
          },
        )}
      </div>

      {deployActivity.length === 0 ? (
        <div style={{ color: '#8a8f99', fontSize: 12, fontStyle: 'italic' }}>
          No deploy rows yet — the pipeline hasn&apos;t signed a desired_state for this task.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {deployActivity.map((row) => {
            const color = statusColor(row.applied_status);
            const duration =
              row.apply_started_at
                ? humanDuration(row.apply_started_at, row.applied_at)
                : null;
            return (
              <div
                key={row.id}
                style={{
                  borderLeft: `3px solid ${color}`,
                  paddingLeft: 10,
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: 4,
                  }}
                >
                  <div style={{ fontSize: 12, fontWeight: 600 }}>
                    {row.action === 'rollback' ? '↩ Rollback' : '▲ Deploy'}{' '}
                    <span style={{ color: '#8a8f99', fontWeight: 400, fontFamily: 'ui-monospace, monospace' }}>
                      {row.deploy_sha.slice(0, 7)}
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: 8, fontSize: 11, color: '#8a8f99' }}>
                    <span style={{ color }}>{statusLabel(row.applied_status)}</span>
                    {duration && <span>· {duration}</span>}
                  </div>
                </div>
                {row.applied_log_excerpt && (
                  <details style={{ marginTop: 6 }}>
                    <summary
                      style={{
                        fontSize: 11,
                        color: '#8a8f99',
                        cursor: 'pointer',
                        userSelect: 'none',
                      }}
                    >
                      View apply log ({row.applied_log_excerpt.length} chars)
                    </summary>
                    <pre
                      style={{
                        fontSize: 10,
                        color: '#c5c8d0',
                        background: '#0f1117',
                        padding: 8,
                        borderRadius: 4,
                        marginTop: 6,
                        maxHeight: 300,
                        overflow: 'auto',
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                      }}
                    >
                      {row.applied_log_excerpt}
                    </pre>
                  </details>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
