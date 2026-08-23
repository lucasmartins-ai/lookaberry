const API_BASE_URL = (process.env.NEXT_PUBLIC_API_URL ?? '').replace(/\/$/, '');

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await fetch(`${API_BASE_URL}${path}`, { ...init, headers });
  if (!response.ok) {
    let message = `API request failed (${response.status})`;
    try {
      const payload = (await response.json()) as { error?: string; message?: string };
      message = payload.error ?? payload.message ?? message;
    } catch {
      // Keep the status-based message when the response is not JSON.
    }
    throw new Error(message);
  }

  return response.json() as Promise<T>;
}
