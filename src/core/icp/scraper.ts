import axios from 'axios';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import * as cheerio from 'cheerio';
import { config } from '../../config/env.js';

export interface ScrapedContent {
  url: string;
  title: string;
  markdown: string;
  rawText: string;
  source: 'lookacrawler_native' | 'lookacrawler_remote' | 'jina' | 'cheerio_fallback';
  tokensSavedPct: number;
}

/**
 * Token noise pruning rules inspired by LookaCrawler
 */
function pruneHtmlNoise(html: string): string {
  const $ = cheerio.load(html);

  // Remove noise elements that waste LLM tokens
  $(
    'script, style, noscript, svg, iframe, canvas, object, embed, audio, video, ' +
    'header, footer, nav, aside, form, input, button, select, textarea, ' +
    '[role="navigation"], [role="banner"], [role="contentinfo"], ' +
    '.nav, .navbar, .footer, .header, .sidebar, .menu, .ad, .ads, .cookie-banner, .popup'
  ).remove();

  // Remove tracking comments and inline attributes
  $('*').each((_, el) => {
    if (el.type === 'tag') {
      const attribs = el.attribs || {};
      for (const attr of Object.keys(attribs)) {
        if (
          attr.startsWith('data-') ||
          attr.startsWith('aria-') ||
          attr === 'style' ||
          attr === 'onclick' ||
          attr === 'onload'
        ) {
          delete attribs[attr];
        }
      }
    }
  });

  return $.html();
}

/**
 * Extract clean Markdown from HTML using Readability + Turndown (LookaCrawler native engine)
 */
export function extractCleanMarkdown(html: string, url: string): { title: string; markdown: string; rawText: string; tokensSavedPct: number } {
  const originalSize = html.length;
  const prunedHtml = pruneHtmlNoise(html);

  const dom = new JSDOM(prunedHtml, { url });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();

  const title = article?.title || dom.window.document.title || 'Untitled';
  const contentHtml = article?.content || prunedHtml;

  const turndownService = new TurndownService({
    headingStyle: 'atx',
    hr: '---',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
  });

  // Remove links with empty text or javascript
  turndownService.addRule('cleanLinks', {
    filter: 'a',
    replacement: (content, node) => {
      const href = (node as HTMLElement).getAttribute('href');
      if (!href || href.startsWith('javascript:') || !content.trim()) {
        return content;
      }
      return `[${content}](${href})`;
    },
  });

  const markdown = turndownService.turndown(contentHtml).trim();
  const rawText = article?.textContent || dom.window.document.body?.textContent || '';
  
  const finalSize = markdown.length;
  const tokensSavedPct = Math.max(0, Math.round(((originalSize - finalSize) / originalSize) * 100));

  return {
    title,
    markdown,
    rawText: rawText.replace(/\s+/g, ' ').trim(),
    tokensSavedPct,
  };
}

/**
 * Scrapes a website using LookaCrawler pipeline with fallback strategies
 */
export async function scrapeWebsite(targetUrl: string): Promise<ScrapedContent> {
  // Validate and format URL
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(targetUrl.startsWith('http') ? targetUrl : `https://${targetUrl}`);
  } catch (error) {
    throw new Error(`Invalid website URL: ${targetUrl}`);
  }

  const url = parsedUrl.toString();

  // Strategy 1: Remote LookaCrawler service if configured
  if (config.LOOKACRAWLER_URL) {
    try {
      const res = await axios.post(
        `${config.LOOKACRAWLER_URL}/extract`,
        { url, mode: 'fast' },
        { timeout: 15000 }
      );
      if (res.data && res.data.markdown) {
        return {
          url,
          title: res.data.title || parsedUrl.hostname,
          markdown: res.data.markdown,
          rawText: res.data.text || '',
          source: 'lookacrawler_remote',
          tokensSavedPct: res.data.tokensSavedPct || 75,
        };
      }
    } catch (e) {
      console.warn(`LookaCrawler remote failed for ${url}, falling back to native extraction...`);
    }
  }

  // Strategy 2: LookaCrawler Native Engine (HTTP GET + Pruning + Readability + Turndown)
  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'LookaBerry-Crawler/1.0 (Mozilla/5.0 compatible; Bot for GTM Research; +https://github.com/vetlucasmartins/lookacrawler)',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,pt-BR;q=0.8,pt;q=0.7',
      },
      timeout: 15000,
      maxRedirects: 5,
    });

    if (typeof response.data === 'string' && response.data.length > 50) {
      const extracted = extractCleanMarkdown(response.data, url);
      return {
        url,
        title: extracted.title,
        markdown: extracted.markdown,
        rawText: extracted.rawText,
        source: 'lookacrawler_native',
        tokensSavedPct: extracted.tokensSavedPct,
      };
    }
  } catch (err: any) {
    console.warn(`Native crawler failed for ${url}: ${err.message}. Trying Jina fallback...`);
  }

  // Strategy 3: Jina Reader Fallback (https://r.jina.ai/{url})
  try {
    const jinaHeaders: Record<string, string> = {
      'Accept': 'text/plain',
    };
    if (config.JINA_API_KEY) {
      jinaHeaders['Authorization'] = `Bearer ${config.JINA_API_KEY}`;
    }

    const jinaResponse = await axios.get(`https://r.jina.ai/${url}`, {
      headers: jinaHeaders,
      timeout: 15000,
    });

    if (jinaResponse.data && typeof jinaResponse.data === 'string') {
      return {
        url,
        title: parsedUrl.hostname,
        markdown: jinaResponse.data,
        rawText: jinaResponse.data,
        source: 'jina',
        tokensSavedPct: 70,
      };
    }
  } catch (jinaErr: any) {
    console.warn(`Jina Reader fallback failed for ${url}: ${jinaErr.message}. Trying Cheerio fallback...`);
  }

  // Strategy 4: Minimal Cheerio Fallback
  try {
    const response = await axios.get(url, { timeout: 10000 });
    const $ = cheerio.load(response.data);
    const title = $('title').text().trim() || parsedUrl.hostname;
    $('script, style, svg, nav, footer').remove();
    const text = $('body').text().replace(/\s+/g, ' ').trim();
    
    return {
      url,
      title,
      markdown: `# ${title}\n\n${text.substring(0, 4000)}`,
      rawText: text,
      source: 'cheerio_fallback',
      tokensSavedPct: 50,
    };
  } catch (finalErr: any) {
    throw new Error(`Failed to scrape ${url}: ${finalErr.message}`);
  }
}
