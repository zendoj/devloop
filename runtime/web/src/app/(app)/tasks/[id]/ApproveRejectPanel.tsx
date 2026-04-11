'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';

interface UploadedFile {
  name: string;
  size: number;
  content_base64: string;
}

export function ApproveRejectPanel({
  taskId,
}: {
  taskId: string;
}): React.ReactElement {
  const router = useRouter();
  const [phase, setPhase] = useState<'idle' | 'approving' | 'rejecting' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [showReject, setShowReject] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [files, setFiles] = useState<UploadedFile[]>([]);

  const approve = useCallback(async () => {
    setPhase('approving');
    setErrorMsg('');
    try {
      const res = await fetch(`/api/tasks/${taskId}/approve`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text.slice(0, 200));
      }
      router.refresh();
    } catch (err) {
      setPhase('error');
      setErrorMsg((err as Error).message || 'approve failed');
    }
  }, [taskId, router]);

  const onFilesPicked = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files ?? []);
    const encoded: UploadedFile[] = [];
    for (const f of picked.slice(0, 5)) {
      if (f.size > 1_000_000) {
        setErrorMsg(`${f.name} is too large (${f.size} bytes > 1 MB cap)`);
        return;
      }
      const buf = await f.arrayBuffer();
      const base64 = btoa(
        new Uint8Array(buf).reduce((s, b) => s + String.fromCharCode(b), ''),
      );
      encoded.push({ name: f.name, size: f.size, content_base64: base64 });
    }
    setFiles(encoded);
    setErrorMsg('');
  }, []);

  const reject = useCallback(async () => {
    if (feedback.trim().length === 0) {
      setErrorMsg('Feedback text required');
      setPhase('error');
      return;
    }
    setPhase('rejecting');
    setErrorMsg('');
    try {
      const res = await fetch(`/api/tasks/${taskId}/reject`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          feedback,
          files: files.map((f) => ({ name: f.name, content_base64: f.content_base64 })),
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text.slice(0, 200));
      }
      router.refresh();
    } catch (err) {
      setPhase('error');
      setErrorMsg((err as Error).message || 'reject failed');
    }
  }, [taskId, feedback, files, router]);

  if (!showReject) {
    return (
      <div>
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button
            type="button"
            onClick={approve}
            disabled={phase === 'approving'}
            style={{
              background: '#4caf50',
              color: '#fff',
              border: 'none',
              padding: '8px 16px',
              borderRadius: 4,
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            {phase === 'approving' ? 'Approving…' : '✓ Approved — works'}
          </button>
          <button
            type="button"
            onClick={() => setShowReject(true)}
            style={{
              background: 'transparent',
              color: '#ff8080',
              border: '1px solid #5a2a2a',
              padding: '8px 16px',
              borderRadius: 4,
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            ✗ Not working
          </button>
        </div>
        {errorMsg && <div style={{ color: '#ff8080', marginTop: 8, fontSize: 12 }}>{errorMsg}</div>}
      </div>
    );
  }

  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ fontSize: 13, marginBottom: 6 }}>
        Describe what doesn&apos;t work. Attach screenshots, logs, or any
        other files (max 5 files, 1 MB each).
      </div>
      <textarea
        value={feedback}
        onChange={(e) => setFeedback(e.target.value)}
        rows={6}
        placeholder="What happens? What did you expect? Steps to reproduce?"
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
        disabled={phase === 'rejecting'}
      />
      <div style={{ marginTop: 8 }}>
        <input
          type="file"
          multiple
          onChange={onFilesPicked}
          style={{ fontSize: 12 }}
          disabled={phase === 'rejecting'}
        />
        {files.length > 0 && (
          <div style={{ color: '#8a8f99', fontSize: 11, marginTop: 4 }}>
            {files.length} file(s) staged: {files.map((f) => f.name).join(', ')}
          </div>
        )}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <button
          type="button"
          onClick={reject}
          disabled={phase === 'rejecting'}
          style={{
            background: '#c22',
            color: '#fff',
            border: 'none',
            padding: '8px 16px',
            borderRadius: 4,
            fontSize: 13,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          {phase === 'rejecting' ? 'Submitting…' : 'Submit rejection + start new loop'}
        </button>
        <button
          type="button"
          onClick={() => {
            setShowReject(false);
            setFeedback('');
            setFiles([]);
            setErrorMsg('');
            setPhase('idle');
          }}
          style={{
            background: 'transparent',
            color: '#c5c8d0',
            border: '1px solid #2a2f3a',
            padding: '8px 16px',
            borderRadius: 4,
            fontSize: 13,
            cursor: 'pointer',
          }}
        >
          Cancel
        </button>
      </div>
      {errorMsg && <div style={{ color: '#ff8080', marginTop: 8, fontSize: 12 }}>{errorMsg}</div>}
    </div>
  );
}
