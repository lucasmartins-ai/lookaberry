import { NextRequest, NextResponse } from 'next/server';

/**
 * HTTP Basic auth in front of the whole dashboard, including the /api proxy that
 * attaches the server's LOOKABERRY_API_KEY. Without DASHBOARD_USER/DASHBOARD_PASSWORD
 * it stays open only outside production.
 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function middleware(request: NextRequest) {
  const user = process.env.DASHBOARD_USER ?? '';
  const password = process.env.DASHBOARD_PASSWORD ?? '';

  if (!user || !password) {
    if (process.env.NODE_ENV === 'production') {
      return new NextResponse('Dashboard auth not configured (set DASHBOARD_USER and DASHBOARD_PASSWORD).', { status: 503 });
    }
    return NextResponse.next();
  }

  const header = request.headers.get('authorization') ?? '';
  if (header.startsWith('Basic ')) {
    const decoded = atob(header.slice(6));
    const sep = decoded.indexOf(':');
    if (sep > 0 && safeEqual(decoded.slice(0, sep), user) && safeEqual(decoded.slice(sep + 1), password)) {
      return NextResponse.next();
    }
  }

  return new NextResponse('Authentication required', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="LookaBerry Dashboard"' },
  });
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
