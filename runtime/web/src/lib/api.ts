/**
 * Small wrapper around the devloop API. Centralized so auth plumbing
 * can change without rewriting every call site.
 *
 * There are two call sites:
 *   - Server components / route handlers (Node) talk to the API
 *     directly over loopback via INTERNAL_API_BASE.
 *   - Browser code talks to the same-origin public host via relative
 *     paths (e.g. fetch('/auth/login')); Nginx proxies /auth/*  and
 *     /healthz to the API and everything else to this Next.js app.
 */

export const INTERNAL_API_BASE =
  process.env.DEVLOOP_INTERNAL_API_BASE ?? 'http://127.0.0.1:3110';

/**
 * Server-side fetch that forwards the caller's cookies to the API.
 * Usage in a Server Component:
 *
 *   const res = await apiFetchServer('/auth/me', { method: 'POST' });
 */
export async function apiFetchServer(
  path: string,
  init: RequestInit & { cookieHeader?: string | null } = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.cookieHeader) {
    headers.set('cookie', init.cookieHeader);
  }
  return fetch(`${INTERNAL_API_BASE}${path}`, {
    ...init,
    headers,
    cache: 'no-store',
  });
}
