import { create } from 'zustand';

export type DevModeState = 'inactive' | 'inspect' | 'selected' | 'editing' | 'submitting' | 'submitted' | 'recording' | 'reviewing';

export type DevReport = {
  displayId: string;
  description: string;
  pageUrl: string;
  elementSelector: string | null;
  elementText: string | null;
  componentInfo: string | null;
  viewport: string;
  scrollPosition: string;
  userAgent: string;
  consoleErrors: string[];
  status: string;
  createdAt: string;
};

export type SelectedElement = {
  selector: string;
  text: string;
  componentInfo: string | null;
  rect: { top: number; left: number; width: number; height: number };
};

export type RecordingClick = {
  timestamp: string;
  x: number;
  y: number;
  selector: string;
  text: string;
  tag: string;
};

export type RecordingLog = {
  timestamp: string;
  type: 'api' | 'click' | 'navigation' | 'call' | 'sms' | 'error';
  summary: string;
};

export type Annotation = {
  xPct: number;
  yPct: number;
  comment: string;
};

export type RecordingFrame = {
  dataUrl: string;
  comment: string;
  timestamp: string;
  clicks: RecordingClick[];
  annotations: Annotation[];
};

type DevModeStore = {
  state: DevModeState;
  selectedElement: SelectedElement | null;
  reports: DevReport[];
  sidebarOpen: boolean;
  lastSubmittedId: string | null;
  recordingFrames: RecordingFrame[];
  recordingStartTime: number | null;
  recordingLogs: RecordingLog[];
  pendingClicks: RecordingClick[];

  activate: () => void;
  deactivate: () => void;
  selectElement: (el: SelectedElement) => void;
  clearSelection: () => void;
  setState: (state: DevModeState) => void;
  setReports: (reports: DevReport[]) => void;
  addReport: (report: DevReport) => void;
  toggleSidebar: () => void;
  setLastSubmittedId: (id: string) => void;
  startRecording: () => void;
  stopRecording: () => void;
  addFrame: (frame: RecordingFrame) => void;
  setFrameComment: (index: number, comment: string) => void;
  addAnnotation: (frameIndex: number, annotation: Annotation) => void;
  removeAnnotation: (frameIndex: number, annotationIndex: number) => void;
  addLog: (log: RecordingLog) => void;
  addClick: (click: RecordingClick) => void;
  flushClicks: () => RecordingClick[];
  clearRecording: () => void;
};

export const useDevModeStore = create<DevModeStore>((set, get) => ({
  state: 'inactive',
  selectedElement: null,
  reports: [],
  sidebarOpen: false,
  lastSubmittedId: null,
  recordingFrames: [],
  recordingStartTime: null,
  recordingLogs: [],
  pendingClicks: [],

  activate: () => set({ state: 'inspect', selectedElement: null }),
  deactivate: () => set({ state: 'inactive', selectedElement: null, sidebarOpen: false, recordingFrames: [], recordingStartTime: null, recordingLogs: [], pendingClicks: [] }),
  selectElement: (el) => set({ state: 'selected', selectedElement: el }),
  clearSelection: () => set({ state: 'inspect', selectedElement: null }),
  setState: (state) => set({ state }),
  setReports: (reports) => set({ reports }),
  addReport: (report) => set((s) => ({ reports: [report, ...s.reports] })),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setLastSubmittedId: (id) => set({ lastSubmittedId: id, state: 'submitted' }),
  startRecording: () => set({ state: 'recording', recordingFrames: [], recordingStartTime: Date.now(), recordingLogs: [], pendingClicks: [] }),
  stopRecording: () => set({ state: 'reviewing' }),
  addFrame: (frame) => set((s) => ({ recordingFrames: [...s.recordingFrames, frame] })),
  setFrameComment: (index, comment) => set((s) => ({
    recordingFrames: s.recordingFrames.map((f, i) => i === index ? { ...f, comment } : f),
  })),
  addAnnotation: (frameIndex, annotation) => set((s) => ({
    recordingFrames: s.recordingFrames.map((f, i) =>
      i === frameIndex ? { ...f, annotations: [...f.annotations, annotation] } : f,
    ),
  })),
  removeAnnotation: (frameIndex, annotationIndex) => set((s) => ({
    recordingFrames: s.recordingFrames.map((f, i) =>
      i === frameIndex ? { ...f, annotations: f.annotations.filter((_, ai) => ai !== annotationIndex) } : f,
    ),
  })),
  addLog: (log) => set((s) => ({ recordingLogs: [...s.recordingLogs, log] })),
  addClick: (click) => set((s) => ({ pendingClicks: [...s.pendingClicks, click] })),
  flushClicks: () => { const clicks = get().pendingClicks; set({ pendingClicks: [] }); return clicks; },
  clearRecording: () => set({ recordingFrames: [], recordingStartTime: null, recordingLogs: [], pendingClicks: [], state: 'inactive' }),
}));

/** Build a stable CSS selector for an element */
export function buildSelector(el: HTMLElement): string {
  // Priority: data-testid > id > data attributes > DOM path
  if (el.dataset.testid) return `[data-testid="${el.dataset.testid}"]`;
  if (el.id) return `#${el.id}`;
  if (el.dataset.component) return `[data-component="${el.dataset.component}"]`;

  // Build path
  const parts: string[] = [];
  let current: HTMLElement | null = el;
  while (current && current !== document.body && parts.length < 5) {
    let tag = current.tagName.toLowerCase();
    if (current.id) {
      parts.unshift(`#${current.id}`);
      break;
    }
    if (current.className && typeof current.className === 'string') {
      const cls = current.className.split(' ').filter(c => c && !c.startsWith('_')).slice(0, 2).join('.');
      if (cls) tag += `.${cls}`;
    }
    parts.unshift(tag);
    current = current.parentElement;
  }
  return parts.join(' > ');
}

/** Get component info from nearest data attribute or semantic element */
export function getComponentInfo(el: HTMLElement): string | null {
  let current: HTMLElement | null = el;
  while (current && current !== document.body) {
    if (current.dataset.component) return current.dataset.component;
    if (current.dataset.testid) return current.dataset.testid;
    // Check for known semantic roles
    const role = current.getAttribute('role');
    if (role) return `role="${role}"`;
    current = current.parentElement;
  }
  return null;
}

/** Capture recent console errors */
export function captureConsoleErrors(): string[] {
  return (window as any).__devModeErrors || [];
}

/** Install console error interceptor */
export function installErrorCapture() {
  if (typeof window === 'undefined') return;
  if ((window as any).__devModeErrorsInstalled) return;
  (window as any).__devModeErrors = [];
  const origError = console.error;
  console.error = (...args: any[]) => {
    const errors: string[] = (window as any).__devModeErrors;
    errors.push(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' '));
    if (errors.length > 20) errors.shift();
    origError.apply(console, args);
  };
  (window as any).__devModeErrorsInstalled = true;
}
