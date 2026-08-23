'use client';

import { Button } from '@/components/ui/button';

export default function Error({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <div className="mx-auto max-w-lg rounded-lg border border-coral/40 bg-coral/10 p-6 text-center"><h2 className="text-lg font-semibold text-ink">Dashboard unavailable</h2><p className="mt-2 text-sm text-muted">The route could not render its data.</p><Button className="mt-5" onClick={() => reset()}>Try again</Button></div>;
}
