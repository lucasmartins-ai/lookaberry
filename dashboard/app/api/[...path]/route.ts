import { NextRequest, NextResponse } from 'next/server';

const upstreamBaseUrl = (process.env.API_URL ?? 'http://localhost:3000').replace(/\/$/, '');

interface ProxyContext {
  params: Promise<{ path: string[] }>;
}

async function proxy(request: NextRequest, context: ProxyContext) {
  const { path } = await context.params;
  const upstreamUrl = new URL(`${upstreamBaseUrl}/api/${path.join('/')}`);
  upstreamUrl.search = new URL(request.url).search;

  const headers = new Headers();
  const contentType = request.headers.get('content-type');
  if (contentType) headers.set('content-type', contentType);
  headers.set('accept', request.headers.get('accept') ?? 'application/json');

  const apiKey = process.env.LOOKABERRY_API_KEY;
  if (apiKey) headers.set('x-api-key', apiKey);

  const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer();
  const response = await fetch(upstreamUrl, {
    method: request.method,
    headers,
    body,
    cache: 'no-store',
  });

  const responseHeaders = new Headers();
  const responseContentType = response.headers.get('content-type');
  if (responseContentType) responseHeaders.set('content-type', responseContentType);

  return new NextResponse(response.body, {
    status: response.status,
    headers: responseHeaders,
  });
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
