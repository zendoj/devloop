import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { apiFetchServer } from '@/lib/api';
import Sidebar from '@/components/sidebar';
import UserBadge from '@/components/user-badge';

interface Me {
  user_id: string;
  role: string;
  expires_at: string;
}

async function fetchMe(): Promise<Me | null> {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  const res = await apiFetchServer('/auth/me', {
    method: 'POST',
    cookieHeader: cookieHeader.length > 0 ? cookieHeader : null,
  });
  if (res.status === 401) return null;
  if (!res.ok) return null;
  return (await res.json()) as Me;
}

/**
 * (app) route group — every route under this folder shares the
 * authenticated shell (sidebar + header). The auth check runs here
 * in the layout so each page component can assume it has a valid
 * session and user context without redoing the /auth/me call.
 */
export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}): Promise<React.ReactElement> {
  const me = await fetchMe();
  if (!me) {
    redirect('/login');
  }

  return (
    <div className="app">
      <Sidebar />
      <div className="app-main">
        <header className="app-header">
          <div className="app-header-left" />
          <UserBadge userId={me.user_id} role={me.role} />
        </header>
        <main className="app-content">{children}</main>
      </div>
    </div>
  );
}
