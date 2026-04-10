import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { apiFetchServer } from '@/lib/api';
import LogoutButton from './logout-button';

interface Me {
  user_id: string;
  role: string;
  expires_at: string;
}

async function fetchMe(): Promise<Me | null> {
  // next/headers is async in Next 15.
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

export default async function DashboardPage(): Promise<React.ReactElement> {
  const me = await fetchMe();
  if (!me) {
    redirect('/login');
  }

  // headers() is async in Next 15 as well.
  const h = await headers();
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'devloop.airpipe.ai';

  return (
    <>
      <header className="header">
        <h1 className="brand">DevLoop</h1>
        <LogoutButton />
      </header>
      <main className="dash">
        <h1>Welcome</h1>
        <p className="meta">
          You are signed in to <code>{host}</code>. This is the placeholder
          dashboard for DevLoop Fas 0.9c; feature screens arrive in Fas 1+.
        </p>
        <div className="kv">
          <dl>
            <dt>User ID</dt>
            <dd>{me.user_id}</dd>
            <dt>Role</dt>
            <dd>{me.role}</dd>
            <dt>Session expires</dt>
            <dd>{new Date(me.expires_at).toISOString()}</dd>
          </dl>
        </div>
      </main>
    </>
  );
}
