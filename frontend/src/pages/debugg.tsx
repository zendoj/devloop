'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, Image, Package, ChevronDown, ChevronUp, Save, Trash2, Pencil, ExternalLink, Upload, Download, Copy, X, FolderOpen } from 'lucide-react';
import toast from 'react-hot-toast';
import { Topbar } from '@/components/layout/Topbar';
import { useSearchParams, useRouter } from 'next/navigation';
import axios from 'axios';

const api = axios.create({ baseURL: '/api' });
// No 401 redirect — debugg page must always stay up

type DevReport = {
  id: string;
  displayId: string;
  description: string;
  pageUrl: string;
  elementSelector: string | null;
  elementText: string | null;
  componentInfo: string | null;
  screenshotPath: string | null;
  viewport: string | null;
  scrollPosition: string | null;
  userAgent: string | null;
  userEmail: string | null;
  consoleErrors: string[] | null;
  status: string;
  assignee: string | null;
  comment: string | null;
  thread: { author: string; text: string; timestamp: string }[] | null;
  sequence: { index: number; imagePath: string; comment: string | null; timestamp: string }[] | null;
  createdAt: string;
};

const STATUS_OPTIONS = [
  { value: 'new', label: 'New', color: '#6b7280' },
  { value: 'in-progress', label: 'In Progress', color: '#f59e0b' },
  { value: 'done', label: 'Done', color: '#22c55e' },
  { value: 'not-solved', label: 'Not Solved', color: '#dc2626' },
];

function StatusBadge({ status }: { status: string }) {
  const opt = STATUS_OPTIONS.find((o) => o.value === status) || STATUS_OPTIONS[0];
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 10px',
        borderRadius: 12,
        fontSize: 12,
        fontWeight: 600,
        background: opt.color + '22',
        color: opt.color,
        border: `1px solid ${opt.color}44`,
      }}
    >
      {opt.label}
    </span>
  );
}

function ReportCard({ report, onUpdate, onDelete, isOpen, onToggle }: { report: DevReport; onUpdate: () => void; onDelete: (id: string) => void; isOpen: boolean; onToggle: () => void }) {
  const expanded = isOpen;
  const [status, setStatus] = useState(report.status);
  const [assignee, setAssignee] = useState(report.assignee || '');
  const [comment, setComment] = useState(report.comment || '');
  const [saving, setSaving] = useState(false);
  const [commentDirty, setCommentDirty] = useState(false);
  const [assigneeDirty, setAssigneeDirty] = useState(false);
  const [editingDesc, setEditingDesc] = useState(false);
  const [description, setDescription] = useState(report.description || '');

  useEffect(() => {
    setStatus(report.status);
    setAssignee(report.assignee || '');
    setComment(report.comment || '');
    setDescription(report.description || '');
    setCommentDirty(false);
    setAssigneeDirty(false);
    setEditingDesc(false);
  }, [report]);

  const saveField = useCallback(async (fields: { status?: string; assignee?: string; comment?: string }) => {
    setSaving(true);
    try {
      await api.patch(`/dev-reports/${report.id}`, fields);
      toast.success('Saved');
      setCommentDirty(false);
      setAssigneeDirty(false);
      onUpdate();
    } catch {
      toast.error('Could not save');
    }
    setSaving(false);
  }, [report.id, onUpdate]);

  const handleStatusChange = (newStatus: string) => {
    setStatus(newStatus);
    if (newStatus === 'not-solved') {
      const now = new Date();
      const ts = now.toLocaleDateString('sv-SE') + ' ' + now.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
      const prefix = `⚠ Markerad ej löst: ${ts}`;
      const newComment = comment ? `${prefix}\n${comment}` : prefix;
      setComment(newComment);
      saveField({ status: newStatus, comment: newComment });
    } else {
      saveField({ status: newStatus });
    }
  };

  const handleDelete = () => {
    if (window.confirm(`Delete report ${report.displayId}? This cannot be undone.`)) {
      onDelete(report.id);
    }
  };

  const date = new Date(report.createdAt);
  const dateStr = date.toLocaleDateString('sv-SE') + ' ' + date.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });

  // Shortened description for header (first 50 chars)
  const shortDesc = report.description.length > 50
    ? report.description.slice(0, 50) + '...'
    : report.description;

  return (
    <div
      style={{
        background: '#fff',
        borderRadius: 10,
        border: '1px solid #e5e7eb',
        marginBottom: 12,
        overflow: 'hidden',
        opacity: report.status === 'done' ? 0.7 : 1,
      }}
    >
      {/* Header row — displayId, status, shortened description */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '12px 16px',
        }}
      >
        <span style={{ fontWeight: 700, fontSize: 15, color: '#1a1a2e', minWidth: 90 }}>
          {report.displayId}
        </span>
        <StatusBadge status={report.status} />
        <span style={{ flex: 1, fontSize: 13, color: '#374151', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {shortDesc}
        </span>
        {report.assignee && (
          <span style={{ fontSize: 12, color: '#6b7280', background: '#f3f4f6', padding: '2px 8px', borderRadius: 8 }}>
            {report.assignee}
          </span>
        )}
        <span style={{ fontSize: 11, color: '#9ca3af', whiteSpace: 'nowrap' }}>{dateStr}</span>
        {/* Quick action buttons */}
        <div style={{ display: 'flex', gap: 3 }} onClick={(e) => e.stopPropagation()}>
          {STATUS_OPTIONS.map((o) => (
            <button
              key={o.value}
              onClick={() => { if (status !== o.value) { setStatus(o.value); saveField({ status: o.value }); } }}
              style={{
                padding: '3px 8px', borderRadius: 5, fontSize: 11, fontWeight: 600,
                border: `1px solid ${status === o.value ? o.color : '#e5e7eb'}`,
                background: status === o.value ? o.color + '22' : '#fff',
                color: status === o.value ? o.color : '#9ca3af',
                cursor: 'pointer', whiteSpace: 'nowrap',
              }}
            >
              {o.label}
            </button>
          ))}
          <button
            onClick={handleDelete}
            style={{
              padding: '3px 8px', borderRadius: 5, fontSize: 11, fontWeight: 600,
              border: '1px solid #fecaca', background: '#fff',
              color: '#dc2626', cursor: 'pointer', whiteSpace: 'nowrap',
            }}
          >
            <Trash2 size={11} style={{ display: 'inline', verticalAlign: '-1px' }} />
          </button>
        </div>
        <button
          onClick={onToggle}
          style={{
            display: 'flex', alignItems: 'center', gap: 4,
            padding: '4px 12px', borderRadius: 6,
            background: expanded ? '#f3f4f6' : '#eff6ff',
            color: expanded ? '#374151' : '#2563eb',
            border: `1px solid ${expanded ? '#d1d5db' : '#bfdbfe'}`,
            cursor: 'pointer', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap',
          }}
        >
          {expanded ? (
            <><ChevronUp size={14} /> Close</>
          ) : (
            <><ExternalLink size={14} /> Open</>
          )}
        </button>
      </div>

      {/* Description — always visible, editable via Edit button */}
      <div style={{ padding: '0 16px 8px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
          <label style={{ fontSize: 11, color: '#9ca3af' }}>Description</label>
          {!editingDesc && (
            <button
              onClick={(e) => { e.stopPropagation(); setEditingDesc(true); }}
              style={{
                display: 'flex', alignItems: 'center', gap: 3,
                padding: '1px 8px', borderRadius: 4, border: '1px solid #d1d5db',
                background: '#fff', color: '#374151', fontSize: 11, cursor: 'pointer',
              }}
            >
              <Pencil size={10} /> Edit
            </button>
          )}
        </div>
        {editingDesc ? (
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              style={{
                flex: 1, padding: 8, borderRadius: 6,
                border: '1px solid #2563eb', fontSize: 13,
                resize: 'vertical', fontFamily: 'inherit',
                background: '#eff6ff',
              }}
              onClick={(e) => e.stopPropagation()}
              autoFocus
            />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <button
                onClick={async (e) => {
                  e.stopPropagation();
                  setSaving(true);
                  try {
                    await api.patch(`/dev-reports/${report.id}`, { description });
                    toast.success('Description saved');
                    setEditingDesc(false);
                    onUpdate();
                  } catch { toast.error('Could not save'); }
                  setSaving(false);
                }}
                disabled={saving}
                style={{
                  display: 'flex', alignItems: 'center', gap: 4,
                  padding: '6px 12px', borderRadius: 6, background: '#2563eb', color: '#fff',
                  border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap',
                }}
              >
                <Save size={12} /> {saving ? 'Saving...' : 'Save'}
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); setDescription(report.description || ''); setEditingDesc(false); }}
                style={{
                  padding: '6px 12px', borderRadius: 6, background: '#f3f4f6', color: '#374151',
                  border: '1px solid #d1d5db', cursor: 'pointer', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap',
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div
            style={{
              width: '100%', padding: 8, borderRadius: 6,
              border: '1px solid #e5e7eb', fontSize: 13,
              background: '#f9fafb', color: '#374151',
              minHeight: 36, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            }}
          >
            {report.description || '—'}
          </div>
        )}
      </div>

      {/* Page URL — always visible */}
      {report.pageUrl && (
        <div style={{ padding: '0 16px 8px' }}>
          <label style={{ fontSize: 11, color: '#9ca3af', display: 'block', marginBottom: 2 }}>URL</label>
          <a
            href={report.pageUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{ fontSize: 12, color: '#2563eb', textDecoration: 'none', wordBreak: 'break-all' }}
          >
            {report.pageUrl}
          </a>
        </div>
      )}

      {/* Thread — always visible */}
      <div style={{ padding: '0 16px 12px' }}>
        <label style={{ fontSize: 11, color: '#9ca3af', display: 'block', marginBottom: 6 }}>Thread</label>
        {/* Existing thread messages */}
        {(report.thread || []).length > 0 && (
          <div style={{ marginBottom: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {(report.thread || []).map((msg, i) => {
              const isClaude = msg.author.toLowerCase().includes('claude');
              const ts = new Date(msg.timestamp);
              const tsStr = ts.toLocaleDateString('sv-SE') + ' ' + ts.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
              return (
                <div key={i} style={{
                  padding: '6px 10px', borderRadius: 6, fontSize: 12,
                  background: isClaude ? '#eff6ff' : '#f3f4f6',
                  border: `1px solid ${isClaude ? '#bfdbfe' : '#e5e7eb'}`,
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                    <span style={{ fontWeight: 600, color: isClaude ? '#2563eb' : '#374151', fontSize: 11 }}>
                      {msg.author}
                    </span>
                    <span style={{ fontSize: 10, color: '#9ca3af' }}>{tsStr}</span>
                  </div>
                  <div style={{ color: '#374151', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{msg.text}</div>
                </div>
              );
            })}
          </div>
        )}
        {/* Add comment input */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <textarea
            value={comment}
            onChange={(e) => {
              setComment(e.target.value);
              const el = e.target;
              el.style.height = 'auto';
              el.style.height = Math.min(el.scrollHeight, 120) + 'px';
            }}
            placeholder="Write a comment..."
            rows={1}
            style={{
              flex: 1, padding: '6px 10px', borderRadius: 6,
              border: '1px solid #e5e7eb', fontSize: 12, fontFamily: 'inherit',
              background: '#f9fafb', resize: 'none',
              minHeight: 32, maxHeight: 120, overflowY: 'auto',
            }}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={async (e) => {
              if (e.key === 'Enter' && !e.shiftKey && comment.trim()) {
                e.preventDefault();
                setSaving(true);
                try {
                  await api.post(`/dev-reports/${report.id}/thread`, { author: report.userEmail || 'Jonas', text: comment.trim() });
                  setComment('');
                  onUpdate();
                } catch { toast.error('Could not save'); }
                setSaving(false);
              }
            }}
          />
          <button
            onClick={async (e) => {
              e.stopPropagation();
              if (!comment.trim()) return;
              setSaving(true);
              try {
                await api.post(`/dev-reports/${report.id}/thread`, { author: report.userEmail || 'Jonas', text: comment.trim() });
                setComment('');
                onUpdate();
              } catch { toast.error('Could not save'); }
              setSaving(false);
            }}
            disabled={saving || !comment.trim()}
            style={{
              display: 'flex', alignItems: 'center', gap: 4,
              padding: '6px 12px', borderRadius: 6, background: '#2563eb', color: '#fff',
              border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600,
              opacity: !comment.trim() ? 0.5 : 1, whiteSpace: 'nowrap',
            }}
          >
            <Save size={12} /> Send
          </button>
        </div>
      </div>

      {/* Expanded content */}
      {expanded && (
        <div style={{ padding: '0 16px 16px', borderTop: '1px solid #f3f4f6' }}>
          {/* Controls row: status, assignee, delete */}
          <div style={{ display: 'flex', gap: 12, marginTop: 12, alignItems: 'flex-end' }}>
            <div>
              <label style={{ fontSize: 11, color: '#9ca3af', display: 'block', marginBottom: 3 }}>Status</label>
              <select
                value={status}
                onChange={(e) => handleStatusChange(e.target.value)}
                style={{ padding: '6px 8px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: 13, background: '#fff' }}
                onClick={(e) => e.stopPropagation()}
              >
                {STATUS_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: 11, color: '#9ca3af', display: 'block', marginBottom: 3 }}>Tilldelad</label>
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  type="text"
                  value={assignee}
                  onChange={(e) => { setAssignee(e.target.value); setAssigneeDirty(true); }}
                  placeholder="Vem jobbar på detta?"
                  style={{
                    flex: 1, padding: '6px 8px', borderRadius: 6,
                    border: assigneeDirty ? '1px solid #2563eb' : '1px solid #d1d5db', fontSize: 13,
                  }}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => { if (e.key === 'Enter' && assigneeDirty) { e.preventDefault(); saveField({ assignee }); } }}
                />
                {assigneeDirty && (
                  <button
                    onClick={(e) => { e.stopPropagation(); saveField({ assignee }); }}
                    disabled={saving}
                    style={{ padding: '6px 10px', borderRadius: 6, background: '#2563eb', color: '#fff', border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}
                  >
                    <Save size={14} />
                  </button>
                )}
              </div>
            </div>
            <button
              onClick={(e) => { e.stopPropagation(); handleDelete(); }}
              style={{
                display: 'flex', alignItems: 'center', gap: 4,
                padding: '6px 12px', borderRadius: 6, background: '#fef2f2', color: '#dc2626',
                border: '1px solid #fecaca', cursor: 'pointer', fontSize: 12, fontWeight: 600,
                marginBottom: 1,
              }}
            >
              <Trash2 size={14} /> Delete
            </button>
          </div>

          {/* Info grid */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 16, fontSize: 12 }}>
            <div>
              <div style={{ color: '#9ca3af', marginBottom: 2 }}>Page</div>
              <div style={{ color: '#374151', wordBreak: 'break-all' }}>{report.pageUrl}</div>
            </div>
            <div>
              <div style={{ color: '#9ca3af', marginBottom: 2 }}>Reported by</div>
              <div style={{ color: '#374151' }}>{report.userEmail || '—'}</div>
            </div>
            {report.elementSelector && (
              <div>
                <div style={{ color: '#9ca3af', marginBottom: 2 }}>Element</div>
                <div style={{ color: '#374151', fontFamily: 'monospace', fontSize: 11 }}>{report.elementSelector}</div>
              </div>
            )}
            {report.elementText && (
              <div>
                <div style={{ color: '#9ca3af', marginBottom: 2 }}>Element-text</div>
                <div style={{ color: '#374151' }}>"{report.elementText}"</div>
              </div>
            )}
            {report.componentInfo && (
              <div>
                <div style={{ color: '#9ca3af', marginBottom: 2 }}>Component</div>
                <div style={{ color: '#374151' }}>{report.componentInfo}</div>
              </div>
            )}
            <div>
              <div style={{ color: '#9ca3af', marginBottom: 2 }}>Viewport</div>
              <div style={{ color: '#374151' }}>{report.viewport || '—'}</div>
            </div>
          </div>

          {/* Screenshot preview */}
          {report.screenshotPath && (
            <div style={{ marginTop: 12 }}>
              <div style={{ color: '#9ca3af', fontSize: 12, marginBottom: 4 }}>Screenshot</div>
              <img
                src={`/api/dev-reports/${report.displayId}/screenshot`}
                alt="Screenshot"
                style={{ maxWidth: '100%', maxHeight: 300, borderRadius: 6, border: '1px solid #e5e7eb', cursor: 'pointer' }}
                onClick={(e) => {
                  e.stopPropagation();
                  window.open(`/api/dev-reports/${report.displayId}/screenshot`, '_blank');
                }}
              />
            </div>
          )}

          {/* Sequence recording */}
          {report.sequence && report.sequence.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div style={{ color: '#9ca3af', fontSize: 12, marginBottom: 6 }}>Recording ({report.sequence.length} bilder)</div>
              <div style={{ display: 'flex', gap: 6, overflow: 'auto', paddingBottom: 8 }}>
                {report.sequence.map((frame, i) => {
                  const ts = new Date(frame.timestamp);
                  const t = ts.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                  return (
                    <div key={i} style={{ flexShrink: 0, width: 160 }}>
                      <img
                        src={`/api/dev-reports/${report.displayId}/screenshot`}
                        alt={`Frame ${i}`}
                        style={{ width: 160, height: 100, objectFit: 'cover', borderRadius: 4, border: '1px solid #e5e7eb', cursor: 'pointer' }}
                        onClick={(e) => { e.stopPropagation(); window.open(`/api/dev-reports/${report.displayId}/screenshot`, '_blank'); }}
                      />
                      <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 2 }}>#{i + 1} — {t}</div>
                      {frame.comment && (
                        <div style={{ fontSize: 11, color: '#374151', background: '#fffbeb', padding: '3px 6px', borderRadius: 4, marginTop: 2, border: '1px solid #fef3c7' }}>
                          {frame.comment}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Console errors */}
          {report.consoleErrors && report.consoleErrors.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div style={{ color: '#9ca3af', fontSize: 12, marginBottom: 4 }}>Console errors</div>
              <div style={{ background: '#1a1a2e', color: '#f87171', padding: 8, borderRadius: 6, fontSize: 11, fontFamily: 'monospace', maxHeight: 120, overflow: 'auto' }}>
                {report.consoleErrors.map((e, i) => (
                  <div key={i}>{e}</div>
                ))}
              </div>
            </div>
          )}

          {/* Downloads */}
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            {report.screenshotPath && (
              <a
                href={`/api/dev-reports/${report.displayId}/screenshot`}
                download
                style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '6px 12px', borderRadius: 6, background: '#eff6ff', color: '#2563eb', fontSize: 12, fontWeight: 600, textDecoration: 'none', border: '1px solid #bfdbfe' }}
                onClick={(e) => e.stopPropagation()}
              >
                <Image size={14} /> Screenshot (.png)
              </a>
            )}
            <a
              href={`/api/dev-reports/${report.displayId}/report.txt`}
              download
              style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '6px 12px', borderRadius: 6, background: '#f0fdf4', color: '#16a34a', fontSize: 12, fontWeight: 600, textDecoration: 'none', border: '1px solid #bbf7d0' }}
              onClick={(e) => e.stopPropagation()}
            >
              <FileText size={14} /> Report (.txt)
            </a>
            <a
              href={`/api/dev-reports/${report.displayId}/download.zip`}
              download
              style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '6px 12px', borderRadius: 6, background: '#faf5ff', color: '#9333ea', fontSize: 12, fontWeight: 600, textDecoration: 'none', border: '1px solid #e9d5ff' }}
              onClick={(e) => e.stopPropagation()}
            >
              <Package size={14} /> Allt (.zip)
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

type SharedFile = { id: string; filename: string; filePath: string; uploadedBy: string | null; createdAt: string };

function FileSharePanel() {
  const qc = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const { data: files = [] } = useQuery<SharedFile[]>({
    queryKey: ['dev-files'],
    queryFn: () => api.get('/dev-reports/files').then((r) => r.data),
    retry: 2,
  });

  const handleUpload = async (file: File) => {
    setUploading(true);
    try {
      const reader = new FileReader();
      const base64 = await new Promise<string>((resolve) => {
        reader.onload = () => resolve(reader.result as string);
        reader.readAsDataURL(file);
      });
      await api.post('/dev-reports/files/upload', { filename: file.name, data: base64 });
      qc.invalidateQueries({ queryKey: ['dev-files'] });
      toast.success('File uploaded');
    } catch {
      toast.error('Could not upload');
    }
    setUploading(false);
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete file?')) return;
    await api.delete(`/dev-reports/files/${id}`);
    qc.invalidateQueries({ queryKey: ['dev-files'] });
    toast.success('File deleted');
  };

  const copyFilePath = (f: SharedFile) => {
    const fullPath = `/${f.filePath}`;
    navigator.clipboard.writeText(fullPath);
    toast.success('Path copied');
  };

  return (
    <div style={{
      width: 220, flexShrink: 0, borderRight: '1px solid #e5e7eb',
      display: 'flex', flexDirection: 'column', background: '#fff', overflow: 'hidden',
    }}>
      <div style={{ padding: '12px 12px 8px', borderBottom: '1px solid #f3f4f6' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
          <FolderOpen size={14} style={{ color: '#2563eb' }} />
          <span style={{ fontSize: 13, fontWeight: 700, color: '#1a1a2e' }}>Files</span>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleUpload(f);
            e.target.value = '';
          }}
        />
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          style={{
            width: '100%', padding: '5px 0', borderRadius: 6, fontSize: 11, fontWeight: 600,
            border: '1px solid #bfdbfe', background: '#eff6ff', color: '#2563eb',
            cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
          }}
        >
          <Upload size={12} /> {uploading ? 'Uploading...' : 'Upload file'}
        </button>
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: 4 }}>
        {files.length === 0 ? (
          <div style={{ padding: 12, textAlign: 'center', color: '#9ca3af', fontSize: 11 }}>
            No files yet
          </div>
        ) : (
          files.map((f) => (
            <div
              key={f.id}
              style={{
                padding: '6px 8px', borderRadius: 5, marginBottom: 2,
                border: '1px solid #f3f4f6', fontSize: 11,
              }}
            >
              <div style={{ fontWeight: 600, color: '#374151', marginBottom: 3, wordBreak: 'break-all' }}>
                {f.filename}
              </div>
              <div style={{ display: 'flex', gap: 3 }}>
                <button
                  onClick={() => copyFilePath(f)}
                  style={{ padding: '2px 5px', borderRadius: 3, border: '1px solid #e5e7eb', background: '#fff', cursor: 'pointer', fontSize: 10, color: '#6b7280', display: 'flex', alignItems: 'center', gap: 2 }}
                  title="Copy file path"
                >
                  <Copy size={9} />
                </button>
                <a
                  href={`/api/dev-reports/files/${f.id}/download`}
                  download
                  style={{ padding: '2px 5px', borderRadius: 3, border: '1px solid #e5e7eb', background: '#fff', cursor: 'pointer', fontSize: 10, color: '#2563eb', display: 'flex', alignItems: 'center', gap: 2, textDecoration: 'none' }}
                  title="Download"
                >
                  <Download size={9} />
                </a>
                <button
                  onClick={() => handleDelete(f.id)}
                  style={{ padding: '2px 5px', borderRadius: 3, border: '1px solid #fecaca', background: '#fff', cursor: 'pointer', fontSize: 10, color: '#dc2626', display: 'flex', alignItems: 'center', gap: 2 }}
                  title="Delete"
                >
                  <Trash2 size={9} />
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function SystemStatus() {
  const [backendUp, setBackendUp] = useState<boolean | null>(null);
  const [currentTask, setCurrentTask] = useState<string | null>(null);

  useEffect(() => {
    const check = () => {
      fetch('/api/dev-reports', { credentials: 'same-origin' })
        .then((r) => {
          setBackendUp(r.ok);
          return r.ok ? r.json() : null;
        })
        .then((data) => {
          if (data) {
            const inProgress = data.find((r: any) => r.status === 'in-progress');
            setCurrentTask(inProgress ? `${inProgress.displayId}: ${inProgress.description?.slice(0, 60)}` : null);
          }
        })
        .catch(() => setBackendUp(false));
    };
    check();
    const interval = setInterval(check, 10000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 16, padding: '8px 24px',
      fontSize: 12, flexShrink: 0,
      background: backendUp === false ? '#fef2f2' : '#f0fdf4',
      borderBottom: `1px solid ${backendUp === false ? '#fecaca' : '#bbf7d0'}`,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: backendUp ? '#22c55e' : backendUp === false ? '#dc2626' : '#9ca3af' }} />
        <span style={{ fontWeight: 600, color: backendUp ? '#16a34a' : '#dc2626' }}>
          Backend: {backendUp === null ? '...' : backendUp ? 'Online' : 'Down'}
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#22c55e' }} />
        <span style={{ fontWeight: 600, color: '#16a34a' }}>Frontend: Online</span>
      </div>
      {currentTask && (
        <>
          <span style={{ color: '#9ca3af' }}>|</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#f59e0b', animation: 'pulse 2s infinite' }} />
            <span style={{ fontWeight: 500, color: '#92400e', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              Working on: {currentTask}
            </span>
          </div>
        </>
      )}
    </div>
  );
}

export default function DebuggPage() {
  const qc = useQueryClient();
  const router = useRouter();
  const searchParams = useSearchParams();

  const filter = searchParams.get('filter') || 'all';
  const openReport = searchParams.get('report') || null;

  const updateUrl = useCallback((params: { filter?: string; report?: string | null }) => {
    const sp = new URLSearchParams(searchParams.toString());
    if (params.filter !== undefined) {
      if (params.filter === 'all') sp.delete('filter');
      else sp.set('filter', params.filter);
    }
    if (params.report !== undefined) {
      if (params.report === null) sp.delete('report');
      else sp.set('report', params.report);
    }
    const qs = sp.toString();
    router.replace(`/debugg${qs ? '?' + qs : ''}`, { scroll: false });
  }, [searchParams, router]);

  const setFilter = useCallback((f: string) => {
    updateUrl({ filter: f, report: null });
  }, [updateUrl]);

  const toggleReport = useCallback((displayId: string) => {
    if (openReport?.toLowerCase() === displayId.toLowerCase()) {
      updateUrl({ report: null });
    } else {
      updateUrl({ report: displayId.toLowerCase() });
    }
  }, [openReport, updateUrl]);

  const { data: reports = [], isLoading } = useQuery<DevReport[]>({
    queryKey: ['dev-reports'],
    queryFn: () => api.get('/dev-reports').then((r) => r.data),
    retry: 3,
    retryDelay: 5000,
    refetchInterval: 15000,
    placeholderData: (prev) => prev,
  });

  const refresh = useCallback(() => {
    qc.invalidateQueries({ queryKey: ['dev-reports'] });
  }, [qc]);

  const handleDelete = useCallback(async (id: string) => {
    try {
      await api.delete(`/dev-reports/${id}`);
      toast.success('Report deleted');
      updateUrl({ report: null });
      refresh();
    } catch {
      toast.error('Could not delete');
    }
  }, [refresh, updateUrl]);

  const filtered = filter === 'all' ? reports : reports.filter((r) => r.status === filter);

  const counts = {
    all: reports.length,
    new: reports.filter((r) => r.status === 'new').length,
    'in-progress': reports.filter((r) => r.status === 'in-progress').length,
    done: reports.filter((r) => r.status === 'done').length,
    'not-solved': reports.filter((r) => r.status === 'not-solved').length,
  };

  return (
    <>
      <Topbar title="Debugg" subtitle="Bug reports and error handling" />
      <SystemStatus />
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
      <FileSharePanel />
      <div style={{ padding: 24, maxWidth: 960, margin: '0 auto', paddingBottom: 120, flex: 1, overflow: 'auto' }}>
        {/* Filter tabs */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
          {[
            { key: 'all', label: 'All' },
            { key: 'new', label: 'New' },
            { key: 'in-progress', label: 'In Progress' },
            { key: 'not-solved', label: 'Not Solved' },
            { key: 'done', label: 'Done' },
          ].map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              style={{
                padding: '6px 16px',
                borderRadius: 8,
                border: '1px solid',
                borderColor: filter === f.key ? '#2563eb' : '#e5e7eb',
                background: filter === f.key ? '#eff6ff' : '#fff',
                color: filter === f.key ? '#2563eb' : '#6b7280',
                fontSize: 13,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              {f.label} ({counts[f.key as keyof typeof counts]})
            </button>
          ))}
        </div>

        {/* Report list */}
        {isLoading ? (
          <div style={{ textAlign: 'center', color: '#9ca3af', padding: 40 }}>Loading reports...</div>
        ) : filtered.length === 0 ? (
          <div style={{ textAlign: 'center', color: '#9ca3af', padding: 40 }}>
            No reports{filter !== 'all' ? ' with this status' : ''}. Use Ctrl+Shift+D to create one.
          </div>
        ) : (
          filtered.map((r) => (
            <ReportCard
              key={r.id}
              report={r}
              onUpdate={refresh}
              onDelete={handleDelete}
              isOpen={openReport?.toLowerCase() === r.displayId.toLowerCase()}
              onToggle={() => toggleReport(r.displayId)}
            />
          ))
        )}
      </div>
      </div>
    </>
  );
}
