'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, Image, Package, ChevronDown, ChevronUp, Save, Trash2, Pencil, ExternalLink, Upload, Download, Copy, X, FolderOpen, Plus } from 'lucide-react';
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
  correctedDescription: string | null;
  aiReviewEnabled: boolean;
  aiReviewModel: string | null;
  aiReviewResults: { round: number; score: number; feedback: string; model: string; timestamp: string }[] | null;
  createdAt: string;
};

const STATUS_OPTIONS = [
  { value: 'new', label: 'New', color: '#6b7280' },
  { value: 'in-progress', label: 'In Progress', color: '#f59e0b' },
  { value: 'review', label: 'Review', color: '#3b82f6' },
  { value: 'done', label: 'Done', color: '#22c55e' },
  { value: 'not-solved', label: 'Not Solved', color: '#dc2626' },
  { value: 'monitoring', label: 'Monitoring', color: '#7c3aed' },
];

// Buttons shown to reviewer in sticky footer
const REVIEW_ACTIONS = [
  { value: 'done', label: 'Done', color: '#22c55e' },
  { value: 'not-solved', label: 'Not Solved', color: '#dc2626' },
  { value: 'monitoring', label: 'Monitoring', color: '#7c3aed' },
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
  const [showCorrectionCompare, setShowCorrectionCompare] = useState(false);
  const [localAiEnabled, setLocalAiEnabled] = useState(report.aiReviewEnabled);
  const [threadCorrectionShown, setThreadCorrectionShown] = useState<Set<number>>(new Set());

  useEffect(() => {
    setStatus(report.status);
    setAssignee(report.assignee || '');
    setComment(report.comment || '');
    setDescription(report.description || '');
    setCommentDirty(false);
    setAssigneeDirty(false);
    setLocalAiEnabled(report.aiReviewEnabled);
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
      const ts = now.toLocaleDateString('en-US') + ' ' + now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
      const prefix = `Warning: Marked not solved: ${ts}`;
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
  const dateStr = date.toLocaleDateString('en-US') + ' ' + date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

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

      {/* Debug text — always visible, editable via Edit button */}
      <div style={{ padding: '0 16px 8px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
          <label style={{ fontSize: 11, color: '#9ca3af' }}>Debug text</label>
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
                    toast.success('Description saved — new txt/zip generated on download');
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
          <>
            <div style={{ position: 'relative' }}>
              <div
                style={{
                  width: '100%', padding: 8, paddingRight: 28, borderRadius: 6,
                  border: '1px solid #e5e7eb', fontSize: 13,
                  background: showCorrectionCompare ? '#fffbeb' : '#f9fafb', color: '#374151',
                  minHeight: 36, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                }}
              >
                {/* Default = corrected, click = original */}
                {report.correctedDescription && !showCorrectionCompare
                  ? report.correctedDescription
                  : (report.description || '—')}
              </div>
              {report.correctedDescription && report.correctedDescription !== report.description && (
                <div
                  onClick={(e) => { e.stopPropagation(); setShowCorrectionCompare(!showCorrectionCompare); }}
                  title={showCorrectionCompare ? 'Show original' : 'Show corrected version'}
                  style={{
                    position: 'absolute', top: 6, right: 6, cursor: 'pointer',
                    color: showCorrectionCompare ? '#2563eb' : '#9ca3af',
                  }}
                >
                  <Pencil size={12} />
                </div>
              )}
            </div>
          </>
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

      {/* ChatGPT Review — always visible */}
      <div style={{ padding: '0 16px 8px', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 600, color: '#374151', cursor: 'pointer' }}>
          <input type="checkbox" checked={localAiEnabled}
            onChange={(e) => { e.stopPropagation(); const next = !localAiEnabled; setLocalAiEnabled(next); api.put(`/dev-reports/${report.id}/ai-review-toggle`, { enabled: next }).catch(() => setLocalAiEnabled(!next)); }}
          /> ChatGPT
        </label>
        {localAiEnabled && (
          <>
            <select defaultValue={report.aiReviewModel || 'gpt-4.1'} onChange={(e) => { api.put(`/dev-reports/${report.id}/ai-review-toggle`, { enabled: true, model: e.target.value }); }} onClick={(e) => e.stopPropagation()} style={{ padding: '1px 4px', borderRadius: 3, border: '1px solid #e5e7eb', fontSize: 10 }}>
              <option value="gpt-4.1">GPT-5.4</option>
              <option value="gpt-4o">GPT-4</option>
              <option value="gpt-4o-mini">Mini</option>
            </select>
            <select defaultValue="medium" onClick={(e) => e.stopPropagation()} style={{ padding: '1px 4px', borderRadius: 3, border: '1px solid #e5e7eb', fontSize: 10 }}>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="xhigh">xHigh</option>
            </select>
          </>
        )}
        {report.aiReviewResults && report.aiReviewResults.length > 0 && (
          <span style={{ padding: '1px 6px', borderRadius: 3, fontSize: 10, fontWeight: 700, background: report.aiReviewResults[report.aiReviewResults.length - 1].score >= 9 ? '#f0fdf4' : '#fef2f2', color: report.aiReviewResults[report.aiReviewResults.length - 1].score >= 9 ? '#22c55e' : '#dc2626' }}>
            {report.aiReviewResults[report.aiReviewResults.length - 1].score}/10
          </span>
        )}
      </div>

      {/* Thread — always visible */}
      <div style={{ padding: '0 16px 12px' }}>
        <label style={{ fontSize: 11, color: '#9ca3af', display: 'block', marginBottom: 6 }}>Thread</label>
        {/* Existing thread messages */}
        {(report.thread || []).length > 0 && (
          <div style={{ marginBottom: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {(report.thread || []).map((msg, i) => {
              const isClaude = msg.author.toLowerCase().includes('claude');
              const ts = new Date(msg.timestamp);
              const tsStr = ts.toLocaleDateString('en-US') + ' ' + ts.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
              return (
                <div key={i} style={{
                  padding: '6px 10px', borderRadius: 6, fontSize: 12, position: 'relative',
                  background: isClaude ? '#eff6ff' : '#f3f4f6',
                  border: `1px solid ${isClaude ? '#bfdbfe' : '#e5e7eb'}`,
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 2 }}>
                    <span style={{ fontWeight: 600, color: isClaude ? '#2563eb' : '#374151', fontSize: 11 }}>
                      {msg.author}
                    </span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontSize: 10, color: '#9ca3af' }}>{tsStr}</span>
                      {/* Only allow delete on non-Claude messages that haven't been responded to */}
                      {!isClaude && i === (report.thread || []).length - 1 && (
                        <button
                          onClick={async (e) => {
                            e.stopPropagation();
                            if (!confirm('Delete the message?')) return;
                            setSaving(true);
                            try {
                              await api.delete(`/dev-reports/${report.id}/thread/${i}`);
                              onUpdate();
                            } catch { toast.error('Could not delete'); }
                            setSaving(false);
                          }}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af', padding: 0, opacity: 0.6 }}
                          title="Delete message"
                        >
                          <Trash2 size={10} />
                        </button>
                      )}
                    </div>
                  </div>
                  <div style={{
                    color: '#374151', whiteSpace: 'pre-wrap', wordBreak: 'break-word', position: 'relative',
                    paddingRight: (msg as any).corrected ? 18 : 0,
                    background: threadCorrectionShown.has(i) ? '#fffbeb' : 'transparent',
                    borderRadius: threadCorrectionShown.has(i) ? 4 : 0,
                    padding: threadCorrectionShown.has(i) ? '2px 4px' : undefined,
                  }}>
                    {/* Default = corrected, click pencil = show original with yellow bg */}
                    {(msg as any).corrected && !threadCorrectionShown.has(i)
                      ? (msg as any).corrected
                      : msg.text}
                    {(msg as any).corrected && (msg as any).corrected !== msg.text && (
                      <div
                        onClick={(e) => {
                          e.stopPropagation();
                          setThreadCorrectionShown(prev => {
                            const next = new Set(prev);
                            if (next.has(i)) next.delete(i); else next.add(i);
                            return next;
                          });
                        }}
                        title={threadCorrectionShown.has(i) ? 'Show corrected' : 'Show original'}
                        style={{ position: 'absolute', top: 0, right: 0, cursor: 'pointer', color: threadCorrectionShown.has(i) ? '#f59e0b' : '#9ca3af' }}
                      >
                        <Pencil size={10} />
                      </div>
                    )}
                  </div>
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
          <button
            onClick={async (e) => {
              e.stopPropagation();
              setSaving(true);
              try {
                if (comment.trim()) {
                  await api.post(`/dev-reports/${report.id}/thread`, { author: report.userEmail || 'Jonas', text: comment.trim() });
                  setComment('');
                }
                await api.patch(`/dev-reports/${report.id}`, { status: 'not-solved' });
                onUpdate();
              } catch { toast.error('Could not save'); }
              setSaving(false);
            }}
            disabled={saving}
            style={{
              display: 'flex', alignItems: 'center', gap: 4,
              padding: '6px 12px', borderRadius: 6, background: '#dc2626', color: '#fff',
              border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600,
              whiteSpace: 'nowrap',
            }}
          >
            Not Solved
          </button>
          <button
            onClick={async (e) => {
              e.stopPropagation();
              setSaving(true);
              try {
                if (comment.trim()) { await api.post(`/dev-reports/${report.id}/thread`, { author: report.userEmail || 'Jonas', text: comment.trim() }); setComment(''); }
                await api.patch(`/dev-reports/${report.id}`, { status: 'done' });
                onUpdate();
              } catch { toast.error('Could not save'); }
              setSaving(false);
            }}
            disabled={saving}
            style={{ padding: '6px 12px', borderRadius: 6, background: '#22c55e', color: '#fff', border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' }}
          >
            Solved
          </button>
          <button
            onClick={async (e) => {
              e.stopPropagation();
              setSaving(true);
              try {
                if (comment.trim()) { await api.post(`/dev-reports/${report.id}/thread`, { author: report.userEmail || 'Jonas', text: comment.trim() }); setComment(''); }
                await api.patch(`/dev-reports/${report.id}`, { status: 'monitoring' });
                onUpdate();
              } catch { toast.error('Could not save'); }
              setSaving(false);
            }}
            disabled={saving}
            style={{ padding: '6px 12px', borderRadius: 6, background: '#7c3aed', color: '#fff', border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' }}
          >
            Monitoring
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
              <label style={{ fontSize: 11, color: '#9ca3af', display: 'block', marginBottom: 3 }}>Assigned</label>
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  type="text"
                  value={assignee}
                  onChange={(e) => { setAssignee(e.target.value); setAssigneeDirty(true); }}
                  placeholder="Who is working on this?"
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
                <div style={{ color: '#9ca3af', marginBottom: 2 }}>Element text</div>
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
              <div style={{ color: '#9ca3af', fontSize: 12, marginBottom: 6 }}>Recording ({report.sequence.length} frames)</div>
              <div style={{ display: 'flex', gap: 6, overflow: 'auto', paddingBottom: 8 }}>
                {report.sequence.map((frame, i) => {
                  const ts = new Date(frame.timestamp);
                  const t = ts.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
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
              <Package size={14} /> All (.zip)
            </a>
          </div>

          {/* AI Code Review */}
          <div style={{ marginTop: 12, padding: '10px 16px', borderTop: '1px solid #f3f4f6' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, fontWeight: 600, color: '#374151', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={report.aiReviewEnabled}
                  onChange={async () => {
                    await api.put(`/dev-reports/${report.id}/ai-review-toggle`, { enabled: !report.aiReviewEnabled });
                    onUpdate();
                  }}
                />
                ChatGPT Review
              </label>
              {report.aiReviewEnabled && (
                <select
                  value={report.aiReviewModel || 'gpt-4o'}
                  onChange={async (e) => {
                    await api.put(`/dev-reports/${report.id}/ai-review-toggle`, { enabled: true, model: e.target.value });
                    onUpdate();
                  }}
                  onClick={(e) => e.stopPropagation()}
                  style={{ padding: '2px 6px', borderRadius: 4, border: '1px solid #e5e7eb', fontSize: 11 }}
                >
                  <optgroup label="Model">
                    <option value="gpt-4.1">GPT-5.4</option>
                    <option value="gpt-4o">GPT-4 (default)</option>
                    <option value="gpt-4o-mini">Mini</option>
                  </optgroup>
                  <optgroup label="Reasoning">
                    <option value="o3-mini">Medium (default)</option>
                    <option value="o3">High</option>
                    <option value="o1">xHigh</option>
                  </optgroup>
                </select>
              )}
              {report.aiReviewResults && report.aiReviewResults.length > 0 && (
                <span style={{
                  padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 700,
                  background: report.aiReviewResults[report.aiReviewResults.length - 1].score >= 9 ? '#f0fdf4' : report.aiReviewResults[report.aiReviewResults.length - 1].score >= 7 ? '#fffbeb' : '#fef2f2',
                  color: report.aiReviewResults[report.aiReviewResults.length - 1].score >= 9 ? '#22c55e' : report.aiReviewResults[report.aiReviewResults.length - 1].score >= 7 ? '#f59e0b' : '#dc2626',
                }}>
                  {report.aiReviewResults[report.aiReviewResults.length - 1].score}/10
                </span>
              )}
            </div>
            {report.aiReviewResults && report.aiReviewResults.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {report.aiReviewResults.map((r, i) => (
                  <div key={i} style={{ padding: '6px 10px', borderRadius: 4, fontSize: 11, background: '#f9fafb', border: '1px solid #e5e7eb' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                      <span style={{ fontWeight: 600 }}>Round {r.round} — {r.model}</span>
                      <span style={{ fontWeight: 700, color: r.score >= 9 ? '#22c55e' : r.score >= 7 ? '#f59e0b' : '#dc2626' }}>{r.score}/10</span>
                    </div>
                    <div style={{ color: '#374151', whiteSpace: 'pre-wrap' }}>{r.feedback}</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Sticky review buttons at bottom of expanded view */}
          <div style={{
            position: 'sticky', bottom: 0,
            display: 'flex', gap: 4, padding: '8px 16px',
            background: '#fff', borderTop: '1px solid #f3f4f6',
          }}>
            {REVIEW_ACTIONS.map((o) => (
              <button
                key={o.value}
                onClick={(e) => { e.stopPropagation(); if (status !== o.value) handleStatusChange(o.value); }}
                style={{
                  padding: '4px 10px', borderRadius: 5, fontSize: 11, fontWeight: 600,
                  border: `1px solid ${status === o.value ? o.color : '#e5e7eb'}`,
                  background: status === o.value ? o.color + '22' : '#fff',
                  color: status === o.value ? o.color : '#9ca3af',
                  cursor: 'pointer',
                }}
              >
                {o.label}
              </button>
            ))}
            <button
              onClick={(e) => { e.stopPropagation(); handleDelete(); }}
              style={{ padding: '4px 10px', borderRadius: 5, fontSize: 11, fontWeight: 600, border: '1px solid #fecaca', background: '#fff', color: '#dc2626', cursor: 'pointer', marginLeft: 'auto' }}
            >
              <Trash2 size={11} style={{ display: 'inline', verticalAlign: '-1px' }} /> Delete
            </button>
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
      const formData = new FormData();
      formData.append('file', file);
      const uploadUrl = `${window.location.origin}/api/dev-reports/files/upload-multipart`;
      const res = await fetch(uploadUrl, {
        method: 'POST',
        body: formData,
        credentials: 'include',
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => res.statusText);
        throw new Error(`${res.status}: ${errText}`);
      }
      qc.invalidateQueries({ queryKey: ['dev-files'] });
      toast.success('File uploaded');
    } catch (err: any) {
      console.error('Upload failed:', err);
      toast.error(`Upload failed: ${err?.message || 'Unknown error'}`);
    }
    setUploading(false);
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete the file?')) return;
    await api.delete(`/dev-reports/files/${id}`);
    qc.invalidateQueries({ queryKey: ['dev-files'] });
    toast.success('File deleted');
  };

  const deleteAllFiles = async () => {
    if (!confirm(`Delete all ${files.length} files?`)) return;
    for (const f of files) {
      await api.delete(`/dev-reports/files/${f.id}`).catch(() => {});
    }
    qc.invalidateQueries({ queryKey: ['dev-files'] });
    toast.success('All files deleted');
  };

  const copyFilePath = (f: SharedFile) => {
    const fullPath = `/opt/energicrm/${f.filePath}`;
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
          multiple
          style={{ display: 'none' }}
          onChange={async (e) => {
            const files = Array.from(e.target.files || []);
            for (const f of files) await handleUpload(f);
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
          <Upload size={12} /> {uploading ? 'Uploading...' : 'Upload files'}
        </button>
        {files.length > 0 && (
          <button
            onClick={deleteAllFiles}
            style={{
              width: '100%', padding: '4px 0', borderRadius: 6, fontSize: 10, fontWeight: 600,
              border: '1px solid #fecaca', background: '#fff', color: '#dc2626',
              cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4, marginTop: 4,
            }}
          >
            <Trash2 size={10} /> Delete all ({files.length})
          </button>
        )}
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
                  title="Copy filename"
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

function ModulesPanel() {
  const qc = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', owner: '', description: '', lockedPaths: '', prompt: '', isLocked: true });

  const { data: modules = [] } = useQuery<any[]>({
    queryKey: ['module-locks'],
    queryFn: () => api.get('/module-locks').then((r) => r.data),
    retry: 2,
  });

  const save = async () => {
    const data = { ...form, lockedPaths: form.lockedPaths.split('\n').filter(Boolean) };
    if (editId) await api.put(`/module-locks/${editId}`, data);
    else await api.post('/module-locks', data);
    qc.invalidateQueries({ queryKey: ['module-locks'] });
    setShowAdd(false); setEditId(null); setForm({ name: '', owner: '', description: '', lockedPaths: '', prompt: '', isLocked: true });
    toast.success('Module saved');
  };

  const startEdit = (m: any) => {
    setEditId(m.id);
    setForm({ name: m.name, owner: m.owner || '', description: m.description || '', lockedPaths: (m.lockedPaths || []).join('\n'), prompt: m.prompt || '', isLocked: m.isLocked });
    setShowAdd(true);
  };

  const toggleLock = async (m: any) => {
    await api.put(`/module-locks/${m.id}`, { isLocked: !m.isLocked });
    qc.invalidateQueries({ queryKey: ['module-locks'] });
  };

  return (
    <div style={{ borderTop: '1px solid #e5e7eb', marginTop: 8, paddingTop: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '0 12px 6px' }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: '#1a1a2e' }}>Modules</span>
        <button onClick={() => { setShowAdd(!showAdd); setEditId(null); }} style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--crm-text-3)' }}>
          <Plus size={12} />
        </button>
      </div>

      {showAdd && (
        <div style={{ padding: '6px 8px', background: '#f9fafb', borderRadius: 4, margin: '0 4px 6px', fontSize: 11 }}>
          <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="Module name" style={{ width: '100%', padding: 4, borderRadius: 3, border: '1px solid #e5e7eb', fontSize: 11, marginBottom: 3 }} />
          <input value={form.owner} onChange={e => setForm({ ...form, owner: e.target.value })} placeholder="Owner" style={{ width: '100%', padding: 4, borderRadius: 3, border: '1px solid #e5e7eb', fontSize: 11, marginBottom: 3 }} />
          <textarea value={form.lockedPaths} onChange={e => setForm({ ...form, lockedPaths: e.target.value })} placeholder="Locked paths (one per line)" rows={2} style={{ width: '100%', padding: 4, borderRadius: 3, border: '1px solid #e5e7eb', fontSize: 10, fontFamily: 'monospace', marginBottom: 3, resize: 'vertical' }} />
          <textarea value={form.prompt} onChange={e => setForm({ ...form, prompt: e.target.value })} placeholder="AI prompt for the module" rows={2} style={{ width: '100%', padding: 4, borderRadius: 3, border: '1px solid #e5e7eb', fontSize: 11, marginBottom: 3, resize: 'vertical' }} />
          <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
            <button onClick={() => { setShowAdd(false); setEditId(null); }} style={{ padding: '3px 8px', borderRadius: 3, border: '1px solid #e5e7eb', background: '#fff', fontSize: 10, cursor: 'pointer' }}>Cancel</button>
            <button onClick={save} disabled={!form.name} style={{ padding: '3px 8px', borderRadius: 3, border: 'none', background: '#22c55e', color: '#fff', fontSize: 10, cursor: 'pointer', opacity: form.name ? 1 : 0.5 }}>{editId ? 'Update' : 'Create'}</button>
          </div>
        </div>
      )}

      <div style={{ overflow: 'auto', padding: '0 4px' }}>
        {modules.map((m: any) => (
          <div key={m.id} style={{ padding: '5px 8px', borderRadius: 4, marginBottom: 2, border: '1px solid #f3f4f6', fontSize: 11 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: m.isLocked ? '#dc2626' : '#22c55e', flexShrink: 0 }} />
              <span style={{ fontWeight: 600, color: '#374151', flex: 1 }}>{m.name}</span>
              <button onClick={() => toggleLock(m)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 9, color: m.isLocked ? '#dc2626' : '#22c55e' }}>
                {m.isLocked ? '🔒' : '🔓'}
              </button>
              <button onClick={() => startEdit(m)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af', padding: 0 }}><Pencil size={9} /></button>
              <button onClick={async () => { if (confirm('Delete?')) { await api.delete(`/module-locks/${m.id}`); qc.invalidateQueries({ queryKey: ['module-locks'] }); } }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af', padding: 0 }}><Trash2 size={9} /></button>
            </div>
            {m.owner && <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 1 }}>{m.owner}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

function FutureIdeasView() {
  const qc = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ description: '', pageUrl: '', image: '' });
  const ideaFileRef = useRef<HTMLInputElement>(null);

  const { data: ideas = [] } = useQuery<any[]>({
    queryKey: ['feature-ideas'],
    queryFn: () => api.get('/dev-reports/ideas').then((r) => r.data),
  });

  const save = async () => {
    let imagePath: string | undefined;
    if (form.image) {
      const res = await api.post('/dev-reports/files/upload', { filename: `idea-${Date.now()}.png`, data: form.image });
      imagePath = res.data.filePath;
    }
    await api.post('/dev-reports/ideas', { description: form.description, pageUrl: form.pageUrl || undefined, imagePath });
    qc.invalidateQueries({ queryKey: ['feature-ideas'] });
    setForm({ description: '', pageUrl: '', image: '' }); setShowAdd(false);
    toast.success('Idea saved');
  };

  const convert = async (id: string) => {
    const res = await api.post(`/dev-reports/ideas/${id}/convert`);
    qc.invalidateQueries({ queryKey: ['feature-ideas'] });
    qc.invalidateQueries({ queryKey: ['dev-reports'] });
    toast.success(`Converted to task: ${res.data.displayId}`);
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, color: '#1a1a2e', margin: 0 }}>Future Functions</h2>
        <button onClick={() => setShowAdd(!showAdd)} style={{ padding: '6px 14px', borderRadius: 6, border: 'none', background: '#f59e0b', color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}>
          <Plus size={13} /> New idea
        </button>
      </div>

      {showAdd && (
        <div style={{ padding: 16, borderRadius: 8, border: '1px solid #fef3c7', background: '#fffbeb', marginBottom: 16 }}>
          <textarea value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} placeholder="Describe your idea..." rows={3} style={{ width: '100%', padding: 8, borderRadius: 6, border: '1px solid #e5e7eb', fontSize: 13, resize: 'vertical', fontFamily: 'inherit', marginBottom: 8 }} />
          <input value={form.pageUrl} onChange={e => setForm({ ...form, pageUrl: e.target.value })} placeholder="Related URL (e.g. /dialer)" style={{ width: '100%', padding: '6px 10px', borderRadius: 6, border: '1px solid #e5e7eb', fontSize: 12, marginBottom: 8 }} />
          <div style={{ marginBottom: 8 }}>
            <input ref={ideaFileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) {
                const reader = new FileReader();
                reader.onload = () => setForm(f => ({ ...f, image: reader.result as string }));
                reader.readAsDataURL(file);
              }
              e.target.value = '';
            }} />
            <button onClick={() => ideaFileRef.current?.click()} style={{ padding: '4px 10px', borderRadius: 4, border: '1px solid #e5e7eb', background: '#fff', fontSize: 11, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}>
              <Upload size={11} /> Attach image
            </button>
            {form.image && (
              <div style={{ display: 'inline-flex', alignItems: 'flex-start', gap: 4, marginTop: 4 }}>
                <img src={form.image} alt="Preview" style={{ maxHeight: 60, borderRadius: 4 }} />
                <button onClick={() => setForm(f => ({ ...f, image: '' }))} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#dc2626', padding: 0 }}><X size={14} /></button>
              </div>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={() => setShowAdd(false)} style={{ padding: '6px 14px', borderRadius: 6, border: '1px solid #e5e7eb', background: '#fff', fontSize: 12, cursor: 'pointer' }}>Cancel</button>
            <button onClick={save} disabled={!form.description.trim()} style={{ padding: '6px 14px', borderRadius: 6, border: 'none', background: '#f59e0b', color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer', opacity: form.description.trim() ? 1 : 0.5 }}>Save idea</button>
          </div>
        </div>
      )}

      {ideas.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 40, color: '#9ca3af', fontSize: 13 }}>No ideas yet. Click "New idea" to add one.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {ideas.map((idea: any) => (
            <div key={idea.id} style={{ padding: '14px 16px', borderRadius: 8, border: '1px solid #e5e7eb', background: idea.convertedToTask ? '#f9fafb' : '#fff', opacity: idea.convertedToTask ? 0.7 : 1 }}>
              {idea.imagePath && <img src={`/api/dev-reports/files/${idea.imagePath.split('/').pop()}/download`} alt="" style={{ maxHeight: 120, borderRadius: 6, marginBottom: 8 }} />}
              <div style={{ fontSize: 13, color: '#374151', whiteSpace: 'pre-wrap', marginBottom: 8 }}>{idea.description}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: '#9ca3af' }}>
                {idea.pageUrl && <span>URL: {idea.pageUrl}</span>}
                {idea.createdBy && <span>· {idea.createdBy}</span>}
                <span>· {new Date(idea.createdAt).toLocaleDateString('en-US')}</span>
                <div style={{ flex: 1 }} />
                {idea.convertedToTask && (
                  <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 4, background: '#f0fdf4', color: '#22c55e', fontWeight: 600 }}>→ {idea.taskDisplayId}</span>
                )}
                {!idea.convertedToTask && (
                  <button onClick={() => convert(idea.id)} style={{ padding: '3px 10px', borderRadius: 4, border: 'none', background: '#2563eb', color: '#fff', fontSize: 10, fontWeight: 600, cursor: 'pointer' }}>Convert to task</button>
                )}
                <button onClick={async () => { if (confirm('Delete the idea?')) { await api.delete(`/dev-reports/ideas/${idea.id}`); qc.invalidateQueries({ queryKey: ['feature-ideas'] }); } }} style={{ padding: '3px 8px', borderRadius: 4, border: '1px solid #fecaca', background: '#fff', color: '#dc2626', fontSize: 10, cursor: 'pointer' }} title="Delete"><Trash2 size={10} /></button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ModulesFullView() {
  const qc = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', owner: '', description: '', lockedPaths: '', prompt: '', isLocked: true });

  const { data: modules = [] } = useQuery<any[]>({
    queryKey: ['module-locks'],
    queryFn: () => api.get('/module-locks').then((r) => r.data),
  });

  const save = async () => {
    const data = { ...form, lockedPaths: form.lockedPaths.split('\n').filter(Boolean) };
    if (editId) await api.put(`/module-locks/${editId}`, data);
    else await api.post('/module-locks', data);
    qc.invalidateQueries({ queryKey: ['module-locks'] });
    setShowAdd(false); setEditId(null);
    setForm({ name: '', owner: '', description: '', lockedPaths: '', prompt: '', isLocked: true });
    toast.success('Module saved');
  };

  const startEdit = (m: any) => {
    setEditId(m.id);
    setForm({ name: m.name, owner: m.owner || '', description: m.description || '', lockedPaths: (m.lockedPaths || []).join('\n'), prompt: m.prompt || '', isLocked: m.isLocked });
    setShowAdd(true);
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, color: '#1a1a2e', margin: 0 }}>Module Locking</h2>
        <button onClick={() => { setShowAdd(!showAdd); setEditId(null); setForm({ name: '', owner: '', description: '', lockedPaths: '', prompt: '', isLocked: true }); }} style={{ padding: '6px 14px', borderRadius: 6, border: 'none', background: '#22c55e', color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}>
          <Plus size={13} /> New module
        </button>
      </div>

      {showAdd && (
        <div style={{ padding: 16, borderRadius: 8, border: '1px solid #e5e7eb', background: '#f9fafb', marginBottom: 16 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
            <div>
              <label style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: 3 }}>Module name</label>
              <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} style={{ width: '100%', padding: '6px 10px', borderRadius: 6, border: '1px solid #e5e7eb', fontSize: 13 }} />
            </div>
            <div>
              <label style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: 3 }}>Owner</label>
              <input value={form.owner} onChange={e => setForm({ ...form, owner: e.target.value })} style={{ width: '100%', padding: '6px 10px', borderRadius: 6, border: '1px solid #e5e7eb', fontSize: 13 }} />
            </div>
          </div>
          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: 3 }}>Description</label>
            <input value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} style={{ width: '100%', padding: '6px 10px', borderRadius: 6, border: '1px solid #e5e7eb', fontSize: 13 }} />
          </div>
          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: 3 }}>Locked paths (one per line)</label>
            <textarea value={form.lockedPaths} onChange={e => setForm({ ...form, lockedPaths: e.target.value })} rows={3} style={{ width: '100%', padding: '6px 10px', borderRadius: 6, border: '1px solid #e5e7eb', fontSize: 12, fontFamily: 'monospace', resize: 'vertical' }} placeholder="backend/src/telephony/&#10;frontend/src/features/telephony/" />
          </div>
          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: 3 }}>AI prompt (instruction for this module)</label>
            <textarea value={form.prompt} onChange={e => setForm({ ...form, prompt: e.target.value })} rows={3} style={{ width: '100%', padding: '6px 10px', borderRadius: 6, border: '1px solid #e5e7eb', fontSize: 13, resize: 'vertical' }} placeholder="E.g.: Never change existing functions without approval..." />
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={() => { setShowAdd(false); setEditId(null); }} style={{ padding: '6px 14px', borderRadius: 6, border: '1px solid #e5e7eb', background: '#fff', fontSize: 12, cursor: 'pointer' }}>Cancel</button>
            <button onClick={save} disabled={!form.name} style={{ padding: '6px 14px', borderRadius: 6, border: 'none', background: '#22c55e', color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer', opacity: form.name ? 1 : 0.5 }}>{editId ? 'Update' : 'Create module'}</button>
          </div>
        </div>
      )}

      {modules.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 40, color: '#9ca3af', fontSize: 13 }}>No modules configured yet.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {modules.map((m: any) => (
            <div key={m.id} style={{ padding: '14px 16px', borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ width: 10, height: 10, borderRadius: '50%', background: m.isLocked ? '#dc2626' : '#22c55e', flexShrink: 0 }} />
                <span style={{ fontSize: 15, fontWeight: 700, color: '#1a1a2e', flex: 1 }}>{m.name}</span>
                {m.owner && <span style={{ fontSize: 12, color: '#6b7280', background: '#f3f4f6', padding: '2px 8px', borderRadius: 6 }}>{m.owner}</span>}
                <button onClick={async () => { await api.put(`/module-locks/${m.id}`, { isLocked: !m.isLocked }); qc.invalidateQueries({ queryKey: ['module-locks'] }); }} style={{ padding: '4px 10px', borderRadius: 5, border: '1px solid', borderColor: m.isLocked ? '#dc2626' : '#22c55e', background: m.isLocked ? '#fef2f2' : '#f0fdf4', color: m.isLocked ? '#dc2626' : '#22c55e', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>
                  {m.isLocked ? 'Locked' : 'Unlocked'}
                </button>
                <button onClick={() => startEdit(m)} style={{ padding: '4px 8px', borderRadius: 4, border: '1px solid #e5e7eb', background: '#fff', cursor: 'pointer', color: '#6b7280' }}><Pencil size={12} /></button>
                <button onClick={async () => { if (confirm(`Delete the module "${m.name}"?`)) { await api.delete(`/module-locks/${m.id}`); qc.invalidateQueries({ queryKey: ['module-locks'] }); } }} style={{ padding: '4px 8px', borderRadius: 4, border: '1px solid #fecaca', background: '#fff', cursor: 'pointer', color: '#dc2626' }}><Trash2 size={12} /></button>
              </div>
              {m.description && <div style={{ fontSize: 12, color: '#6b7280', marginTop: 6 }}>{m.description}</div>}
              {m.lockedPaths?.length > 0 && (
                <div style={{ marginTop: 8, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  {m.lockedPaths.map((p: string, i: number) => (
                    <span key={i} style={{ fontSize: 10, fontFamily: 'monospace', padding: '2px 6px', borderRadius: 3, background: '#f3f4f6', color: '#374151', border: '1px solid #e5e7eb' }}>{p}</span>
                  ))}
                </div>
              )}
              {m.prompt && (
                <div style={{ marginTop: 8, padding: '6px 10px', borderRadius: 6, background: '#eff6ff', border: '1px solid #bfdbfe', fontSize: 11, color: '#2563eb' }}>
                  <strong>AI prompt:</strong> {m.prompt}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
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
              In Progress: {currentTask}
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
  const viewMode = searchParams.get('view') || 'reports';

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

  // Notification sound
  const playNotifSound = useCallback(() => {
    try {
      const a = new Audio('/sounds/notification.mp3');
      a.volume = 0.7;
      a.play().catch(() => {});
    } catch {}
  }, []);

  // Play notification sound when new review arrives
  const prevReviewCountRef = useRef(-1);
  useEffect(() => {
    const reviewCount = reports.filter(r => r.status === 'review').length;
    if (prevReviewCountRef.current >= 0 && reviewCount > prevReviewCountRef.current) {
      playNotifSound();
    }
    prevReviewCountRef.current = reviewCount;
  }, [reports, playNotifSound]);

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
    'review': reports.filter((r) => r.status === 'review').length,
    'not-solved': reports.filter((r) => r.status === 'not-solved').length,
    'monitoring': reports.filter((r) => r.status === 'monitoring').length,
  };

  return (
    <>
      <Topbar title="Debug" subtitle="Bug reports and issue tracking" />
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
            { key: 'review', label: 'Review' },
            { key: 'not-solved', label: 'Not Solved' },
            { key: 'monitoring', label: 'Monitoring' },
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
          <div style={{ flex: 1 }} />
          <button
            onClick={() => router.replace(viewMode === 'modules' ? '/debugg' : '/debugg?view=modules')}
            style={{
              padding: '6px 16px', borderRadius: 8, border: '1px solid',
              borderColor: viewMode === 'modules' ? '#7c3aed' : '#e5e7eb',
              background: viewMode === 'modules' ? '#f3e8ff' : '#fff',
              color: viewMode === 'modules' ? '#7c3aed' : '#6b7280',
              fontSize: 13, fontWeight: 600, cursor: 'pointer',
            }}
          >
            Modules
          </button>
          <button
            onClick={() => router.replace(viewMode === 'ideas' ? '/debugg' : '/debugg?view=ideas')}
            style={{
              padding: '6px 16px', borderRadius: 8, border: '1px solid',
              borderColor: viewMode === 'ideas' ? '#f59e0b' : '#e5e7eb',
              background: viewMode === 'ideas' ? '#fffbeb' : '#fff',
              color: viewMode === 'ideas' ? '#92400e' : '#6b7280',
              fontSize: 13, fontWeight: 600, cursor: 'pointer',
            }}
          >
            Future Functions
          </button>
        </div>

        {/* Ideas view */}
        {viewMode === 'ideas' ? (
          <FutureIdeasView />
        ) : viewMode === 'modules' ? (
          <ModulesFullView />
        ) : isLoading ? (
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
