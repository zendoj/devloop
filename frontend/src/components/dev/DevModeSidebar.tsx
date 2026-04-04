'use client';

import React, { useEffect } from 'react';
import { useDevModeStore, type DevReport } from './dev-mode-store';

const OVERLAY_Z = 99999;

export function DevModeSidebar() {
  const { reports, setReports, toggleSidebar } = useDevModeStore();

  // Fetch reports on mount
  useEffect(() => {
    fetch('/api/dev-reports', { credentials: 'same-origin' })
      .then(r => r.json())
      .then(data => { if (Array.isArray(data)) setReports(data); })
      .catch(() => {});
  }, [setReports]);

  const statusColors: Record<string, string> = {
    new: '#3b82f6',
    triaged: '#e6a700',
    'in-progress': '#9333ea',
    fixed: '#28a745',
    'wont-fix': '#999',
  };

  return (
    <div style={{
      position: 'fixed', top: 28, right: 0, bottom: 0, width: 340,
      background: '#fff', boxShadow: '-4px 0 16px rgba(0,0,0,0.15)',
      borderLeft: '1px solid #d9dde5',
      display: 'flex', flexDirection: 'column',
      pointerEvents: 'auto',
      zIndex: OVERLAY_Z + 5,
    }}>
      {/* Header */}
      <div style={{
        padding: '10px 12px', borderBottom: '1px solid #d9dde5',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <span style={{ fontSize: 13, fontWeight: 700 }}>Dev Reports ({reports.length})</span>
        <button onClick={toggleSidebar} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, color: '#999' }}>×</button>
      </div>

      {/* List */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 8 }}>
        {reports.length === 0 && (
          <div style={{ textAlign: 'center', padding: 24, color: '#999', fontSize: 12 }}>
            Inga rapporter ännu
          </div>
        )}
        {reports.map((r: DevReport) => (
          <div key={r.displayId} style={{
            padding: '8px 10px', marginBottom: 6, borderRadius: 6,
            background: '#f8f9fa', border: '1px solid #e9ecef',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 }}>
              <span style={{ fontSize: 14, fontWeight: 800, color: '#1a1a2e' }}>{r.displayId}</span>
              <span style={{
                fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 10,
                background: statusColors[r.status] || '#999', color: '#fff',
              }}>
                {r.status}
              </span>
            </div>
            <div style={{ fontSize: 12, color: '#333', marginBottom: 4 }}>{r.description}</div>
            <div style={{ fontSize: 10, color: '#999' }}>
              {r.pageUrl?.replace(/https?:\/\/[^/]+/, '')} · {r.elementSelector?.slice(0, 30)}
            </div>
            <div style={{ fontSize: 10, color: '#bbb', marginTop: 2 }}>
              {r.createdAt ? new Date(r.createdAt).toLocaleString('sv-SE') : ''}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
