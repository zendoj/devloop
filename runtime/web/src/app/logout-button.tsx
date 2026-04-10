'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export default function LogoutButton(): React.ReactElement {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function handleClick(): Promise<void> {
    setBusy(true);
    try {
      await fetch('/auth/logout', {
        method: 'POST',
        credentials: 'include',
      });
    } finally {
      // Whatever the server returns, redirect to /login. A failure
      // here will also 401 on the next protected fetch anyway.
      router.replace('/login');
      router.refresh();
    }
  }

  return (
    <button
      type="button"
      className="logoutBtn"
      onClick={handleClick}
      disabled={busy}
    >
      {busy ? 'Signing out...' : 'Sign out'}
    </button>
  );
}
