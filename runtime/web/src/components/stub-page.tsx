import type React from 'react';

interface Props {
  title: string;
  description: string;
  phase: string;
  features: string[];
}

export default function StubPage({
  title,
  description,
  phase,
  features,
}: Props): React.ReactElement {
  return (
    <div className="page">
      <div className="page-header">
        <h1>{title}</h1>
        <p className="page-sub">{description}</p>
      </div>
      <div className="empty">
        <div className="empty-phase">{phase}</div>
        <h2 className="empty-title">Not built yet</h2>
        <p className="empty-body">
          This screen ships in <strong>{phase}</strong>. The backend schema
          already exists (see <code>docs/ARCHITECTURE.md</code>), but the UI
          and service wiring are the next step.
        </p>
        <ul className="empty-list">
          {features.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}
