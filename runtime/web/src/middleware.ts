import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * Edge middleware — cheap cookie-presence check to bounce obvious
 * unauthenticated requests before they hit a Server Component. This
 * is NOT a security check; the authoritative validation happens in
 * the page's call to /auth/me (which verifies the token hash in the
 * DB). A user with a stale but present cookie will get through here
 * and be redirected by the server component.
 */
export function middleware(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;

  // Allow the login page + any /auth/* passthrough (Nginx handles
  // /auth routing, but keep the allow list explicit). The exact-match
  // '/auth' + prefix '/auth/' shape is deliberate — a loose
  // startsWith('/auth') would also match '/author' or '/authz'.
  if (
    pathname === '/login' ||
    pathname === '/auth' ||
    pathname.startsWith('/auth/') ||
    pathname.startsWith('/_next/') ||
    pathname === '/favicon.ico'
  ) {
    return NextResponse.next();
  }

  const session = req.cookies.get('devloop_session');
  if (!session) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
