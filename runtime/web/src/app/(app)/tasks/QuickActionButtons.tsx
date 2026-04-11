'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Inline approve / "not working" buttons on the /tasks list row.
 * Approve fires a POST immediately (no confirmation — it's a
 * two-click escape if you misclicked: the detail page shows the
 * verdict right after). "Not working" redirects to the detail
 * page because a real rejection needs feedback text + optionally
 * attached files, and that's more than an inline-row UI can
 * sensibly fit.
 */
export function QuickActionButtons({
  taskId,
}: {
  taskId: string;
}): React.ReactElement {
  const router = useRouter();
  const [phase, setPhase] = useState<'idle' | 'approving' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  const approve = useCallback(async () => {
    setPhase('approving');
    setErrorMsg('');
    try {
      const res = await fetch(`/api/tasks/${taskId}/approve`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(body.slice(0, 120));
      }
      router.refresh();
    } catch (err) {
      setPhase('error');
      setErrorMsg((err as Error).message || 'approve failed');
    }
  }, [taskId, router]);

  return (
    <div style={{ display: 'flex', gap: 4 }}>
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          void approve();
        }}
        disabled={phase === 'approving'}
        title="Approve — works"
        style={{
          background: '#2f5f2f',
          color: '#d4ead4',
          border: '1px solid #4a7a4a',
          borderRadius: 3,
          padding: '4px 8px',
          fontSize: 11,
          fontWeight: 600,
          cursor: 'pointer',
        }}
      >
        {phase === 'approving' ? '…' : '✓ Approve'}
      </button>
      <a
        href={`/tasks/${taskId}`}
        onClick={(e) => e.stopPropagation()}
        title="Reject with feedback"
        style={{
          background: 'transparent',
          color: '#e88080',
          border: '1px solid #5a2a2a',
          borderRadius: 3,
          padding: '4px 8px',
          fontSize: 11,
          fontWeight: 600,
          textDecoration: 'none',
          display: 'inline-block',
        }}
      >
        ✗ Reject
      </a>
      {errorMsg && (
        <span
          style={{
            color: '#ff8080',
            fontSize: 10,
            marginLeft: 6,
            alignSelf: 'center',
          }}
        >
          {errorMsg}
        </span>
      )}
    </div>
  );
}
