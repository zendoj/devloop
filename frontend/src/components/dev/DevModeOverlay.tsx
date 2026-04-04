'use client';

import React, { useEffect, useRef, useState, useCallback } from 'react';
import html2canvas from 'html2canvas';
import { useDevModeStore, buildSelector, getComponentInfo, captureConsoleErrors, installErrorCapture, type RecordingClick } from './dev-mode-store';
import { DevModeSidebar } from './DevModeSidebar';

const OVERLAY_Z = 99999;

export function DevModeOverlay() {
  const {
    state, selectedElement, lastSubmittedId, activate, deactivate, selectElement, clearSelection,
    setState, setLastSubmittedId, addReport, sidebarOpen, toggleSidebar,
    startRecording, stopRecording, addFrame, recordingFrames, recordingStartTime, setFrameComment, clearRecording,
    addAnnotation, removeAnnotation, addLog, addClick, flushClicks, recordingLogs,
  } = useDevModeStore();
  const [hoverRect, setHoverRect] = useState<DOMRect | null>(null);
  const [hoverSelector, setHoverSelector] = useState('');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [recordingElapsed, setRecordingElapsed] = useState(0);
  const [reviewSelectedIdx, setReviewSelectedIdx] = useState<number | null>(null);
  const [reviewDescription, setReviewDescription] = useState('');
  const [reviewSubmitting, setReviewSubmitting] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);
  const recordingIntervalRef = useRef<any>(null);

  // Install error capture on mount
  useEffect(() => { installErrorCapture(); }, []);

  // Click logging during recording
  useEffect(() => {
    if (state !== 'recording') return;
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('[data-devmode-root]')) return;
      const text = (target.textContent || '').trim().slice(0, 50);
      const tag = target.tagName.toLowerCase();
      const selector = buildSelector(target);
      addClick({
        timestamp: new Date().toISOString(),
        x: e.clientX,
        y: e.clientY,
        selector,
        text,
        tag,
      });
      addLog({
        timestamp: new Date().toISOString(),
        type: 'click',
        summary: `Klick: <${tag}> "${text}" (${selector})`,
      });
    };
    window.addEventListener('click', handler, true);
    return () => window.removeEventListener('click', handler, true);
  }, [state, addClick, addLog]);

  // API call logging during recording (intercept fetch)
  useEffect(() => {
    if (state !== 'recording') return;
    const origFetch = window.fetch;
    const maskPhone = (s: string) => s.replace(/(\+\d{3})\d{4}(\d{4})/g, '$1****$2');
    window.fetch = async function (...args: any[]) {
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
      const method = args[1]?.method || 'GET';
      const start = Date.now();
      try {
        const resp = await origFetch.apply(this, args as any);
        const elapsed = Date.now() - start;
        if (url.startsWith('/api')) {
          addLog({
            timestamp: new Date().toISOString(),
            type: url.includes('/telephony/') ? 'call' : url.includes('/sms/') ? 'sms' : 'api',
            summary: maskPhone(`${method} ${url} → ${resp.status} (${elapsed}ms)`),
          });
        }
        return resp;
      } catch (err: any) {
        addLog({
          timestamp: new Date().toISOString(),
          type: 'error',
          summary: maskPhone(`${method} ${url} → FEL: ${err.message}`),
        });
        throw err;
      }
    };
    return () => { window.fetch = origFetch; };
  }, [state, addLog]);

  // XMLHttpRequest logging (axios uses XHR)
  useEffect(() => {
    if (state !== 'recording') return;
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    const maskPhone = (s: string) => s.replace(/(\+\d{3})\d{4}(\d{4})/g, '$1****$2');
    XMLHttpRequest.prototype.open = function (method: string, url: string | URL, ...rest: any[]) {
      (this as any).__recMethod = method;
      (this as any).__recUrl = String(url);
      (this as any).__recStart = Date.now();
      return origOpen.apply(this, [method, url, ...rest] as any);
    };
    XMLHttpRequest.prototype.send = function (...args: any[]) {
      this.addEventListener('loadend', () => {
        const url = (this as any).__recUrl || '';
        if (url.startsWith('/api')) {
          const elapsed = Date.now() - ((this as any).__recStart || Date.now());
          addLog({
            timestamp: new Date().toISOString(),
            type: url.includes('/telephony/') ? 'call' : url.includes('/sms/') ? 'sms' : 'api',
            summary: maskPhone(`${(this as any).__recMethod} ${url} → ${this.status} (${elapsed}ms)`),
          });
        }
      });
      return origSend.apply(this, args as [any]);
    };
    return () => {
      XMLHttpRequest.prototype.open = origOpen;
      XMLHttpRequest.prototype.send = origSend;
    };
  }, [state, addLog]);

  // Navigation logging
  useEffect(() => {
    if (state !== 'recording') return;
    let lastUrl = window.location.href;
    const check = setInterval(() => {
      if (window.location.href !== lastUrl) {
        addLog({
          timestamp: new Date().toISOString(),
          type: 'navigation',
          summary: `Navigerade till ${window.location.pathname}`,
        });
        lastUrl = window.location.href;
      }
    }, 500);
    return () => clearInterval(check);
  }, [state, addLog]);

  // Recording: capture frames every 5 seconds
  useEffect(() => {
    if (state !== 'recording') {
      if (recordingIntervalRef.current) {
        clearInterval(recordingIntervalRef.current);
        recordingIntervalRef.current = null;
      }
      return;
    }
    // Take first frame immediately
    const captureFrame = async () => {
      try {
        const canvas = await html2canvas(document.body, {
          ignoreElements: (el) => !!(el as HTMLElement).dataset?.devmodeRoot,
          scale: 0.5,
          logging: false,
        });
        const clicks = flushClicks();
        addFrame({
          dataUrl: canvas.toDataURL('image/jpeg', 0.7),
          comment: '',
          timestamp: new Date().toISOString(),
          clicks,
          annotations: [],
        });
      } catch { /* ignore capture errors */ }
    };
    captureFrame();
    recordingIntervalRef.current = setInterval(captureFrame, 5000);
    return () => {
      if (recordingIntervalRef.current) clearInterval(recordingIntervalRef.current);
    };
  }, [state, addFrame]);

  // Recording timer
  useEffect(() => {
    if (state !== 'recording' || !recordingStartTime) {
      setRecordingElapsed(0);
      return;
    }
    const timer = setInterval(() => {
      setRecordingElapsed(Math.floor((Date.now() - recordingStartTime) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, [state, recordingStartTime]);

  // Keyboard shortcut: Ctrl+Shift+D (inspect) and Ctrl+Shift+R (record)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key === 'D') {
        e.preventDefault();
        if (state === 'inactive') activate();
        else if (state !== 'recording' && state !== 'reviewing') deactivate();
      }
      if (e.ctrlKey && e.shiftKey && e.key === 'R') {
        e.preventDefault();
        if (state === 'inactive' || state === 'inspect') startRecording();
        else if (state === 'recording') stopRecording();
      }
      if (e.key === 'Escape' && state !== 'inactive') {
        if (state === 'recording') stopRecording();
        else if (state === 'reviewing') clearRecording();
        else if (state === 'selected' || state === 'editing') clearSelection();
        else deactivate();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [state, activate, deactivate, clearSelection, startRecording, stopRecording, clearRecording]);

  // Hover detection
  const onMouseMove = useCallback((e: MouseEvent) => {
    if (state !== 'inspect') return;
    const target = e.target as HTMLElement;
    if (target.closest('[data-devmode-root]')) return;
    const rect = target.getBoundingClientRect();
    setHoverRect(rect);
    setHoverSelector(buildSelector(target));
  }, [state]);

  // Click to select
  const onClick = useCallback((e: MouseEvent) => {
    if (state !== 'inspect') return;
    const target = e.target as HTMLElement;
    if (target.closest('[data-devmode-root]')) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = target.getBoundingClientRect();
    selectElement({
      selector: buildSelector(target),
      text: (target.innerText || '').slice(0, 200),
      componentInfo: getComponentInfo(target),
      rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
    });
    setDescription('');
    setHoverRect(null);
  }, [state, selectElement]);

  useEffect(() => {
    if (state === 'inspect') {
      document.addEventListener('mousemove', onMouseMove, true);
      document.addEventListener('click', onClick, true);
    }
    return () => {
      document.removeEventListener('mousemove', onMouseMove, true);
      document.removeEventListener('click', onClick, true);
    };
  }, [state, onMouseMove, onClick]);

  // Submit report
  const submitReport = async () => {
    if (!selectedElement || !description.trim()) return;
    setSubmitting(true);
    setState('submitting');
    try {
      // Capture screenshot — keep dev overlay visible so marked element shows
      let screenshotBase64: string | null = null;
      try {
        const canvas = await html2canvas(document.documentElement, { useCORS: true, logging: false });
        screenshotBase64 = canvas.toDataURL('image/png');
      } catch {
        // Screenshot failed — continue without it
      }

      const res = await fetch('/api/dev-reports', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description: description.trim(),
          pageUrl: window.location.href,
          elementSelector: selectedElement.selector,
          elementText: selectedElement.text,
          componentInfo: selectedElement.componentInfo,
          viewport: `${window.innerWidth}x${window.innerHeight}`,
          scrollPosition: `${window.scrollX},${window.scrollY}`,
          userAgent: navigator.userAgent,
          consoleErrors: captureConsoleErrors(),
          screenshot: screenshotBase64,
        }),
      });
      const data = await res.json();
      setLastSubmittedId(data.displayId);
      addReport({
        displayId: data.displayId,
        description: description.trim(),
        pageUrl: window.location.href,
        elementSelector: selectedElement.selector,
        elementText: selectedElement.text,
        componentInfo: selectedElement.componentInfo,
        viewport: `${window.innerWidth}x${window.innerHeight}`,
        scrollPosition: `${window.scrollX},${window.scrollY}`,
        userAgent: navigator.userAgent,
        consoleErrors: captureConsoleErrors(),
        status: 'new',
        createdAt: new Date().toISOString(),
      });
      setDescription('');
    } catch {
      setState('selected');
    }
    setSubmitting(false);
  };

  if (state === 'inactive') return null;

  // Recording bar (bottom center)
  if (state === 'recording') {
    const mins = Math.floor(recordingElapsed / 60);
    const secs = recordingElapsed % 60;
    return (
      <div data-devmode-root style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', zIndex: OVERLAY_Z + 10, pointerEvents: 'auto' }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12, padding: '10px 20px',
          background: '#1a1a2e', borderRadius: 12, boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
          color: '#fff', fontSize: 14, fontWeight: 600,
        }}>
          <span style={{ width: 12, height: 12, borderRadius: '50%', background: '#dc2626', animation: 'pulse 1.5s infinite' }} />
          <span>REC {String(mins).padStart(2, '0')}:{String(secs).padStart(2, '0')}</span>
          <span style={{ color: 'rgba(255,255,255,0.5)', fontSize: 12 }}>{recordingFrames.length} bilder · {recordingLogs.length} loggar</span>
          <button
            onClick={stopRecording}
            style={{
              padding: '6px 16px', borderRadius: 8, border: 'none',
              background: '#dc2626', color: '#fff', cursor: 'pointer',
              fontSize: 13, fontWeight: 700,
            }}
          >
            Stoppa
          </button>
        </div>
        <style>{`@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }`}</style>
      </div>
    );
  }

  // Review screen (fullscreen overlay)
  if (state === 'reviewing') {
    const submitSequence = async () => {
      setReviewSubmitting(true);
      try {
        const resp = await fetch('/api/dev-reports/sequence', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            description: reviewDescription,
            pageUrl: window.location.href,
            images: recordingFrames.map((f) => ({
              data: f.dataUrl,
              comment: f.comment || undefined,
              timestamp: f.timestamp,
              clicks: f.clicks,
              annotations: f.annotations.filter((a) => a.comment),
            })),
            logs: recordingLogs,
          }),
        });
        const data = await resp.json();
        if (data.displayId) {
          setLastSubmittedId(data.displayId);
          setReviewDescription('');
          setReviewSelectedIdx(null);
          setTimeout(() => clearRecording(), 3000);
        }
      } catch {
        alert('Kunde inte skapa rapport');
      }
      setReviewSubmitting(false);
    };

    return (
      <div data-devmode-root style={{
        position: 'fixed', inset: 0, zIndex: OVERLAY_Z + 20,
        background: 'rgba(0,0,0,0.85)', display: 'flex', flexDirection: 'column',
        pointerEvents: 'auto',
      }}>
        {/* Header */}
        <div style={{ padding: '16px 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
          <div style={{ color: '#fff', fontSize: 16, fontWeight: 700 }}>
            Granska inspelning — {recordingFrames.length} bilder
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={clearRecording} style={{ padding: '6px 16px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.2)', background: 'transparent', color: '#fff', cursor: 'pointer', fontSize: 13 }}>
              Avbryt
            </button>
            <button
              onClick={submitSequence}
              disabled={reviewSubmitting}
              style={{ padding: '6px 16px', borderRadius: 8, border: 'none', background: '#2563eb', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 700, opacity: reviewSubmitting ? 0.5 : 1 }}
            >
              {reviewSubmitting ? 'Skapar...' : 'Skapa rapport'}
            </button>
          </div>
        </div>

        {/* Description */}
        <div style={{ padding: '12px 24px' }}>
          <textarea
            value={reviewDescription}
            onChange={(e) => setReviewDescription(e.target.value)}
            placeholder="Beskriv övergripande vad du testade..."
            rows={2}
            style={{ width: '100%', padding: 10, borderRadius: 8, border: '1px solid rgba(255,255,255,0.2)', background: 'rgba(255,255,255,0.1)', color: '#fff', fontSize: 13, resize: 'none', fontFamily: 'inherit' }}
          />
        </div>

        {/* Image strip + detail */}
        <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
          {/* Thumbnail strip */}
          <div style={{ width: 180, borderRight: '1px solid rgba(255,255,255,0.1)', overflow: 'auto', padding: 8 }}>
            {recordingFrames.map((f, i) => {
              const ts = new Date(f.timestamp);
              const t = ts.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
              return (
                <div
                  key={i}
                  onClick={() => setReviewSelectedIdx(i)}
                  style={{
                    padding: 4, borderRadius: 6, marginBottom: 4, cursor: 'pointer',
                    border: reviewSelectedIdx === i ? '2px solid #2563eb' : '2px solid transparent',
                    background: reviewSelectedIdx === i ? 'rgba(37,99,235,0.15)' : 'transparent',
                  }}
                >
                  <img src={f.dataUrl} alt={`Frame ${i}`} style={{ width: '100%', borderRadius: 4 }} />
                  <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.5)', textAlign: 'center', marginTop: 2 }}>
                    #{i + 1} — {t}
                    {f.comment && <span style={{ color: '#fbbf24' }}> ✎</span>}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Selected frame detail */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: 16, overflow: 'auto' }}>
            {reviewSelectedIdx !== null && recordingFrames[reviewSelectedIdx] ? (
              <>
                {/* Image with annotation markers */}
                <div style={{ position: 'relative', display: 'inline-block', alignSelf: 'center' }}>
                  <img
                    src={recordingFrames[reviewSelectedIdx].dataUrl}
                    alt="Selected"
                    style={{ maxWidth: '100%', maxHeight: 'calc(100vh - 280px)', borderRadius: 8, border: '1px solid rgba(255,255,255,0.2)', cursor: 'crosshair' }}
                    onClick={(e) => {
                      const rect = e.currentTarget.getBoundingClientRect();
                      const xPct = Math.round(((e.clientX - rect.left) / rect.width) * 100);
                      const yPct = Math.round(((e.clientY - rect.top) / rect.height) * 100);
                      addAnnotation(reviewSelectedIdx, { xPct, yPct, comment: '' });
                    }}
                  />
                  {/* Render annotation pins */}
                  {recordingFrames[reviewSelectedIdx].annotations.map((a, ai) => (
                    <div
                      key={ai}
                      style={{
                        position: 'absolute', left: `${a.xPct}%`, top: `${a.yPct}%`,
                        transform: 'translate(-50%, -50%)',
                        width: 22, height: 22, borderRadius: '50%',
                        background: '#dc2626', color: '#fff', fontSize: 11, fontWeight: 700,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        border: '2px solid #fff', cursor: 'pointer', boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
                      }}
                      title={a.comment || 'Klicka för att ta bort'}
                      onClick={(e) => { e.stopPropagation(); removeAnnotation(reviewSelectedIdx, ai); }}
                    >
                      {ai + 1}
                    </div>
                  ))}
                </div>

                {/* Annotation comments */}
                {recordingFrames[reviewSelectedIdx].annotations.length > 0 && (
                  <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4, maxWidth: 600, alignSelf: 'center', width: '100%' }}>
                    {recordingFrames[reviewSelectedIdx].annotations.map((a, ai) => (
                      <div key={ai} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ width: 20, height: 20, borderRadius: '50%', background: '#dc2626', color: '#fff', fontSize: 10, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{ai + 1}</span>
                        <input
                          value={a.comment}
                          onChange={(e) => {
                            const updated = { ...a, comment: e.target.value };
                            const frames = [...recordingFrames];
                            frames[reviewSelectedIdx] = { ...frames[reviewSelectedIdx], annotations: frames[reviewSelectedIdx].annotations.map((ann, j) => j === ai ? updated : ann) };
                            useDevModeStore.setState({ recordingFrames: frames });
                          }}
                          placeholder="Beskriv vad som är fel här..."
                          style={{ flex: 1, padding: '4px 8px', borderRadius: 4, border: '1px solid rgba(255,255,255,0.2)', background: 'rgba(255,255,255,0.1)', color: '#fff', fontSize: 11, fontFamily: 'inherit' }}
                        />
                      </div>
                    ))}
                  </div>
                )}

                {/* Frame comment */}
                <div style={{ width: '100%', maxWidth: 600, marginTop: 8, alignSelf: 'center' }}>
                  <textarea
                    value={recordingFrames[reviewSelectedIdx].comment}
                    onChange={(e) => setFrameComment(reviewSelectedIdx, e.target.value)}
                    placeholder="Övergripande kommentar för denna bild (valfritt)..."
                    rows={2}
                    style={{ width: '100%', padding: 8, borderRadius: 6, border: '1px solid rgba(255,255,255,0.2)', background: 'rgba(255,255,255,0.1)', color: '#fff', fontSize: 12, resize: 'none', fontFamily: 'inherit' }}
                  />
                </div>

                {/* Clicks during this frame */}
                {recordingFrames[reviewSelectedIdx].clicks.length > 0 && (
                  <div style={{ marginTop: 8, maxWidth: 600, alignSelf: 'center', width: '100%' }}>
                    <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', marginBottom: 4 }}>Klick under denna frame:</div>
                    {recordingFrames[reviewSelectedIdx].clicks.map((c, ci) => (
                      <div key={ci} style={{ fontSize: 10, color: 'rgba(255,255,255,0.6)', padding: '2px 0' }}>
                        → &lt;{c.tag}&gt; &quot;{c.text.slice(0, 30)}&quot; ({c.selector.slice(0, 40)})
                      </div>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <div style={{ color: 'rgba(255,255,255,0.4)', fontSize: 14, textAlign: 'center', marginTop: 40 }}>
                Klicka på en bild till vänster för att granska<br />
                Klicka på bilden för att placera markörer
              </div>
            )}
          </div>

          {/* Activity log panel */}
          <div style={{ width: 240, borderLeft: '1px solid rgba(255,255,255,0.1)', overflow: 'auto', padding: 8 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'rgba(255,255,255,0.7)', marginBottom: 8, padding: '0 4px' }}>
              Aktivitetslogg ({recordingLogs.length})
            </div>
            {recordingLogs.map((log, i) => {
              const ts = new Date(log.timestamp);
              const t = ts.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
              const colors: Record<string, string> = { click: '#60a5fa', api: '#a78bfa', call: '#34d399', sms: '#fbbf24', error: '#f87171', navigation: '#94a3b8' };
              return (
                <div key={i} style={{ fontSize: 10, padding: '3px 4px', borderBottom: '1px solid rgba(255,255,255,0.05)', color: 'rgba(255,255,255,0.6)' }}>
                  <span style={{ color: 'rgba(255,255,255,0.3)', marginRight: 4 }}>{t}</span>
                  <span style={{ color: colors[log.type] || '#fff', fontWeight: 600, marginRight: 4 }}>[{log.type}]</span>
                  <span>{log.summary.slice(0, 60)}</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Submitted confirmation */}
        {lastSubmittedId && state === 'reviewing' && (
          <div style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', padding: '12px 24px', borderRadius: 10, background: '#16a34a', color: '#fff', fontSize: 14, fontWeight: 700, zIndex: OVERLAY_Z + 30 }}>
            Rapport skapad: {lastSubmittedId}
          </div>
        )}
      </div>
    );
  }

  return (
    <div data-devmode-root style={{ position: 'fixed', inset: 0, zIndex: OVERLAY_Z, pointerEvents: 'none' }}>
      {/* Red border indicating dev mode is active */}
      <div style={{
        position: 'fixed', inset: 0,
        border: '3px solid #e15b64',
        borderRadius: 0,
        pointerEvents: 'none',
        zIndex: OVERLAY_Z,
      }} />

      {/* Top bar */}
      <div style={{
        position: 'fixed', top: 0, left: 0, right: 0,
        background: '#e15b64', color: '#fff',
        padding: '4px 12px', fontSize: 12, fontWeight: 700,
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        pointerEvents: 'auto', zIndex: OVERLAY_Z + 1,
      }}>
        <span>DEV MODE — Klicka på element för att rapportera</span>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={toggleSidebar} style={{ background: 'rgba(255,255,255,0.2)', border: 'none', color: '#fff', padding: '2px 8px', borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 600 }}>
            Rapporter
          </button>
          <button onClick={deactivate} style={{ background: 'rgba(255,255,255,0.2)', border: 'none', color: '#fff', padding: '2px 8px', borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 600 }}>
            Stäng (Esc)
          </button>
        </div>
      </div>

      {/* Hover highlight */}
      {state === 'inspect' && hoverRect && (
        <>
          <div style={{
            position: 'fixed',
            top: hoverRect.top - 2, left: hoverRect.left - 2,
            width: hoverRect.width + 4, height: hoverRect.height + 4,
            border: '2px solid #3b82f6',
            borderRadius: 3,
            background: 'rgba(59,130,246,0.08)',
            pointerEvents: 'none',
            zIndex: OVERLAY_Z + 2,
            transition: 'all 0.05s',
          }} />
          <div style={{
            position: 'fixed',
            top: hoverRect.top - 22, left: hoverRect.left,
            background: '#1a1a2e', color: '#e0e0e0',
            padding: '2px 6px', borderRadius: 3,
            fontSize: 10, fontFamily: 'monospace',
            pointerEvents: 'none',
            zIndex: OVERLAY_Z + 3,
            maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {hoverSelector}
          </div>
        </>
      )}

      {/* Selected element + form */}
      {(state === 'selected' || state === 'editing' || state === 'submitting' || state === 'submitted') && selectedElement && (
        <>
          {/* Selection highlight */}
          <div style={{
            position: 'fixed',
            top: selectedElement.rect.top - 2, left: selectedElement.rect.left - 2,
            width: selectedElement.rect.width + 4, height: selectedElement.rect.height + 4,
            border: '3px solid #e15b64',
            borderRadius: 3,
            background: 'rgba(225,91,100,0.1)',
            pointerEvents: 'none',
            zIndex: OVERLAY_Z + 2,
          }} />

          {/* Report form */}
          <div ref={overlayRef} style={{
            position: 'fixed',
            top: Math.min(selectedElement.rect.top + selectedElement.rect.height + 8, window.innerHeight - 220),
            left: Math.min(selectedElement.rect.left, window.innerWidth - 340),
            width: 320,
            background: '#fff', borderRadius: 8,
            boxShadow: '0 8px 32px rgba(0,0,0,0.25)',
            border: '1px solid #d9dde5',
            padding: 12,
            pointerEvents: 'auto',
            zIndex: OVERLAY_Z + 4,
          }}>
            {state === 'submitted' && lastSubmittedId ? (
              <div style={{ textAlign: 'center', padding: 8 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: '#28a745', marginBottom: 4 }}>Rapport skickad!</div>
                <div style={{ fontSize: 20, fontWeight: 800, color: '#1a1a2e', marginBottom: 8 }}>{lastSubmittedId}</div>
                <div style={{ fontSize: 11, color: '#666', marginBottom: 12 }}>Referera till detta ID i chatten</div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button onClick={clearSelection} style={{ flex: 1, padding: '6px 0', borderRadius: 6, background: '#3b82f6', color: '#fff', border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>
                    Ny rapport
                  </button>
                  <button onClick={deactivate} style={{ flex: 1, padding: '6px 0', borderRadius: 6, background: '#e9ecef', color: '#333', border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>
                    Stäng
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div style={{ fontSize: 10, color: '#999', marginBottom: 4, fontFamily: 'monospace' }}>
                  {selectedElement.selector}
                </div>
                {selectedElement.componentInfo && (
                  <div style={{ fontSize: 10, color: '#3b82f6', marginBottom: 4 }}>
                    Komponent: {selectedElement.componentInfo}
                  </div>
                )}
                {selectedElement.text && (
                  <div style={{ fontSize: 11, color: '#666', marginBottom: 6, maxHeight: 40, overflow: 'hidden' }}>
                    Text: "{selectedElement.text.slice(0, 80)}"
                  </div>
                )}
                <textarea
                  value={description}
                  onChange={(e) => { setDescription(e.target.value); setState('editing'); }}
                  placeholder="Beskriv buggen eller vad som ska ändras..."
                  autoFocus
                  style={{
                    width: '100%', height: 80, borderRadius: 6,
                    border: '1px solid #d9dde5', padding: 8,
                    fontSize: 12, resize: 'vertical', fontFamily: 'inherit',
                  }}
                  onKeyDown={(e) => { if (e.key === 'Enter' && e.metaKey) submitReport(); }}
                />
                <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                  <button
                    onClick={submitReport}
                    disabled={submitting || !description.trim()}
                    style={{
                      flex: 1, padding: '6px 0', borderRadius: 6,
                      background: description.trim() ? '#28a745' : '#ccc',
                      color: '#fff', border: 'none', cursor: description.trim() ? 'pointer' : 'default',
                      fontSize: 12, fontWeight: 600,
                    }}
                  >
                    {submitting ? 'Skickar...' : 'Skicka rapport (⌘+Enter)'}
                  </button>
                  <button onClick={clearSelection} style={{ padding: '6px 10px', borderRadius: 6, background: '#e9ecef', color: '#333', border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>
                    Avbryt
                  </button>
                </div>
              </>
            )}
          </div>
        </>
      )}

      {/* Sidebar */}
      {sidebarOpen && <DevModeSidebar />}
    </div>
  );
}
