'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';

interface ThreadRow {
  id: string;
  author_kind: string;
  author_name: string;
  body: string;
  created_at: string;
}

function authorColor(kind: string): string {
  switch (kind) {
    case 'user':
      return '#6ee787';
    case 'agent':
      return '#4f8cff';
    case 'system':
      return '#8a8f99';
    default:
      return '#c5c8d0';
  }
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('sv-SE', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Conversation panel on /tasks/:id. Lists report_threads rows
 * in chronological order and gives the operator a textarea to
 * post a new message. Optimistic: adds the reply to the list
 * immediately on successful POST, then refreshes the server
 * component so other metadata stays fresh.
 */
export function ThreadPanel({
  taskId,
  initialThreads,
}: {
  taskId: string;
  initialThreads: ThreadRow[];
}): React.ReactElement {
  const router = useRouter();
  const [threads, setThreads] = useState<ThreadRow[]>(initialThreads);
  const [draft, setDraft] = useState('');
  const [phase, setPhase] = useState<'idle' | 'sending' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  const send = useCallback(async () => {
    const body = draft.trim();
    if (body.length === 0) {
      setErrorMsg('Write something first');
      setPhase('error');
      return;
    }
    setPhase('sending');
    setErrorMsg('');
    try {
      const res = await fetch(`/api/tasks/${taskId}/thread`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text.slice(0, 200));
      }
      // Optimistic append so the textarea clears and the new
      // message shows instantly. Refresh in the background so
      // the server-rendered parent sees it too.
      setThreads((prev) => [
        ...prev,
        {
          id: `tmp-${Date.now()}`,
          author_kind: 'user',
          author_name: 'you',
          body,
          created_at: new Date().toISOString(),
        },
      ]);
      setDraft('');
      setPhase('idle');
      router.refresh();
    } catch (err) {
      setPhase('error');
      setErrorMsg((err as Error).message || 'send failed');
    }
  }, [taskId, draft, router]);

  return (
    <div className="card" style={{ padding: 14 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {threads.length === 0 && (
          <div style={{ color: '#6b7280', fontSize: 12, fontStyle: 'italic' }}>
            No messages yet. Start the conversation below.
          </div>
        )}
        {threads.map((t) => (
          <div
            key={t.id}
            style={{
              padding: 10,
              background: '#0f1117',
              border: '1px solid #2a2f3a',
              borderRadius: 4,
              borderLeft: `3px solid ${authorColor(t.author_kind)}`,
            }}
          >
            <div
              style={{
                fontSize: 11,
                color: '#8a8f99',
                marginBottom: 4,
                display: 'flex',
                justifyContent: 'space-between',
              }}
            >
              <span style={{ color: authorColor(t.author_kind), fontWeight: 600 }}>
                {t.author_name}{' '}
                <span style={{ color: '#6b7280', fontWeight: 400 }}>
                  ({t.author_kind})
                </span>
              </span>
              <span>{formatDate(t.created_at)}</span>
            </div>
            <div
              style={{
                fontSize: 13,
                color: '#c5c8d0',
                whiteSpace: 'pre-wrap',
                lineHeight: 1.5,
              }}
            >
              {t.body}
            </div>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 12 }}>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              void send();
            }
          }}
          rows={4}
          placeholder="Write a reply… (Cmd/Ctrl+Enter to send)"
          style={{
            width: '100%',
            background: '#0f1117',
            color: '#c5c8d0',
            border: '1px solid #2a2f3a',
            borderRadius: 4,
            padding: 8,
            fontSize: 13,
            fontFamily: 'inherit',
            resize: 'vertical',
          }}
          disabled={phase === 'sending'}
        />
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginTop: 8,
          }}
        >
          {errorMsg ? (
            <span style={{ color: '#ff8080', fontSize: 11 }}>{errorMsg}</span>
          ) : (
            <span style={{ color: '#6b7280', fontSize: 11 }}>
              {draft.length} / 10000
            </span>
          )}
          <button
            type="button"
            onClick={send}
            disabled={phase === 'sending' || draft.trim().length === 0}
            style={{
              background: '#4f8cff',
              color: '#fff',
              border: 'none',
              borderRadius: 4,
              padding: '6px 14px',
              fontSize: 12,
              fontWeight: 600,
              cursor: phase === 'sending' ? 'not-allowed' : 'pointer',
            }}
          >
            {phase === 'sending' ? 'Sending…' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  );
}
