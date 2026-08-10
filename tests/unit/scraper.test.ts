import { describe, it, expect } from 'vitest';
import { extractCleanMarkdown } from '../../src/core/icp/scraper.js';

describe('LookaCrawler Scraper Engine', () => {
  it('should prune noisy elements and produce clean Markdown', () => {
    const rawHtml = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>Acme AI - High Performance GTM</title>
          <script>console.log("tracking pixel");</script>
          <style>body { color: red; }</style>
        </head>
        <body>
          <header class="header">
            <nav><a href="/login">Login</a><a href="/pricing">Pricing</a></nav>
          </header>
          <main>
            <h1>Automate Your Outbound Pipeline</h1>
            <p>Acme AI helps B2B sales teams find high-intent buyers with real-time signal detection.</p>
            <p>Target key personas and close deals 3x faster.</p>
          </main>
          <footer>
            <p>Copyright 2026 Acme Corp. All rights reserved.</p>
            <svg><path d="M0 0h24v24H0z"/></svg>
          </footer>
        </body>
      </html>
    `;

    const result = extractCleanMarkdown(rawHtml, 'https://acme.ai');

    expect(result.title).toContain('Acme AI');
    expect(result.markdown).toContain('Automate Your Outbound Pipeline');
    expect(result.markdown).toContain('Acme AI helps B2B sales teams');
    expect(result.markdown).not.toContain('tracking pixel');
    expect(result.markdown).not.toContain('color: red');
    expect(result.markdown).not.toContain('Copyright 2026 Acme Corp');
    expect(result.tokensSavedPct).toBeGreaterThan(30);
  });
});
