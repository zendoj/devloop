'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Sticky files panel that lives at the bottom of the sidebar.
 *
 * Shows a scrollable list of files stored under
 * /var/lib/devloop/files/ on the DevLoop server. For each file:
 *   - name + size + relative time
 *   - 📋 copy absolute path to clipboard
 *   - ⬇ download (direct GET to /api/files/:name)
 *   - ✗ delete (DELETE /api/files/:name)
 *
 * An upload affordance at the top: click or drag-drop. Files
 * are base64-encoded client-side and POSTed to /api/files as
 * JSON so we don't need @fastify/multipart on the server.
 * 50 MB cap per file (matches FilesService.MAX_FILE_BYTES).
 *
 * Polls every 10s when the panel is open so uploads made from
 * another browser tab also show up.
 */

interface StoredFile {
  name: string;
  size: number;
  mtime: string;
  abs_path: string;
}

const POLL_MS = 10_000;
const MAX_BYTES = 500 * 1024 * 1024;

function formatSize(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

function relTime(iso: string): string {
  const delta = Date.now() - new Date(iso).getTime();
  const s = Math.floor(delta / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// Multipart upload (NOT base64 JSON) is used to support up to
// 500 MB uploads. Base64 would produce a ~670 MB string in
// memory on the browser side and crash the tab before the POST
// even leaves the client.

export default function FilesPanel(): React.ReactElement {
  const [files, setFiles] = useState<StoredFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [copiedPath, setCopiedPath] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/files', { credentials: 'include' });
      if (!res.ok) return;
      const body = (await res.json()) as { items: StoredFile[] };
      setFiles(body.items);
    } catch {
      // silent — polling will retry
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  const handleUpload = useCallback(
    async (fileList: FileList | File[]) => {
      const arr = Array.from(fileList);
      if (arr.length === 0) return;
      setUploading(true);
      setErrorMsg('');
      try {
        for (const f of arr) {
          if (f.size > MAX_BYTES) {
            throw new Error(
              `${f.name} too large (${formatSize(f.size)} > 500MB)`,
            );
          }
          const form = new FormData();
          form.append('file', f, f.name);
          const res = await fetch('/api/files', {
            method: 'POST',
            credentials: 'include',
            body: form,
          });
          if (!res.ok) {
            const text = await res.text();
            throw new Error(text.slice(0, 150));
          }
        }
        await refresh();
      } catch (err) {
        setErrorMsg((err as Error).message);
      } finally {
        setUploading(false);
      }
    },
    [refresh],
  );

  const onFilePick = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (!e.target.files || e.target.files.length === 0) return;
      void handleUpload(e.target.files);
      // clear so the same file can be re-uploaded later
      e.target.value = '';
    },
    [handleUpload],
  );

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragging(false);
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        void handleUpload(e.dataTransfer.files);
      }
    },
    [handleUpload],
  );

  const onCopyPath = useCallback(async (absPath: string) => {
    try {
      await navigator.clipboard.writeText(absPath);
      setCopiedPath(absPath);
      setTimeout(() => setCopiedPath(null), 1500);
    } catch {
      setErrorMsg('clipboard write blocked');
    }
  }, []);

  const onDelete = useCallback(
    async (name: string) => {
      if (!window.confirm(`Delete ${name}?`)) return;
      try {
        const res = await fetch(`/api/files/${encodeURIComponent(name)}`, {
          method: 'DELETE',
          credentials: 'include',
        });
        if (!res.ok) {
          const text = await res.text();
          throw new Error(text.slice(0, 150));
        }
        await refresh();
      } catch (err) {
        setErrorMsg((err as Error).message);
      }
    },
    [refresh],
  );

  return (
    <div className="sidebar-files">
      <div className="sidebar-files-header">
        <span>Files</span>
        <span className="sidebar-files-count">{files.length}</span>
      </div>

      <div
        className={`sidebar-files-drop ${dragging ? 'sidebar-files-drop-active' : ''}`}
        onClick={() => fileInputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        {uploading ? 'Uploading…' : dragging ? 'Drop to upload' : '+ Upload (click or drop)'}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          onChange={onFilePick}
          style={{ display: 'none' }}
        />
      </div>

      {errorMsg && <div className="sidebar-files-error">{errorMsg}</div>}

      <div className="sidebar-files-list">
        {files.length === 0 ? (
          <div className="sidebar-files-empty">No files yet</div>
        ) : (
          files.map((f) => (
            <div key={f.name} className="sidebar-files-row" title={f.abs_path}>
              <div className="sidebar-files-row-top">
                <span className="sidebar-files-name">{f.name}</span>
              </div>
              <div className="sidebar-files-meta">
                {formatSize(f.size)} · {relTime(f.mtime)}
              </div>
              <div className="sidebar-files-actions">
                <button
                  type="button"
                  className="sidebar-files-btn"
                  onClick={() => onCopyPath(f.abs_path)}
                  title="Copy absolute path"
                >
                  {copiedPath === f.abs_path ? '✓' : '📋'} path
                </button>
                <a
                  className="sidebar-files-btn"
                  href={`/api/files/${encodeURIComponent(f.name)}`}
                  title="Download"
                >
                  ⬇
                </a>
                <button
                  type="button"
                  className="sidebar-files-btn sidebar-files-btn-danger"
                  onClick={() => onDelete(f.name)}
                  title="Delete"
                >
                  ✗
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
