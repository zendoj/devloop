'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

interface Props {
  userId: string;
  role: string;
}

export default function UserBadge({ userId, role }: Props): React.ReactElement {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function handleLogout(): Promise<void> {
    setBusy(true);
    try {
      await fetch('/auth/logout', { method: 'POST', credentials: 'include' });
    } finally {
      router.replace('/login');
      router.refresh();
    }
  }

  const shortId = `${userId.slice(0, 8)}…${userId.slice(-4)}`;

  return (
    <div className="user-badge">
      <button
        type="button"
        className="user-badge-button"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="user-badge-dot" />
        <span className="user-badge-id">{shortId}</span>
        <span className="user-badge-role">{role}</span>
      </button>
      {open && (
        <div className="user-badge-menu">
          <div className="user-badge-menu-item user-badge-menu-readonly">
            <span className="user-badge-menu-label">User ID</span>
            <span className="user-badge-menu-value">{userId}</span>
          </div>
          <button
            type="button"
            className="user-badge-menu-action"
            onClick={handleLogout}
            disabled={busy}
          >
            {busy ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      )}
    </div>
  );
}
