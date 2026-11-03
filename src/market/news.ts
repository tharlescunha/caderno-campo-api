import * as cheerio from 'cheerio';
import { XMLParser } from 'fast-xml-parser';
import { BROWSER_HEADERS, ProviderError, request, type Fetcher } from './http.js';

const BASE = 'https://www.agrolink.com.br';
const RSS_URL = `${BASE}/rss/noticias.rss`;

export class NewsNotFoundError extends Error {}

export interface NewsItem {
  id: string | null;
  title: string;
  summary: string;
  image: string | null;
  published_at: string | null; // ISO UTC
  url: string;
}

export interface Article {
  id: string;
  title: string | null;
  author: string | null;
  published_at: string | null;
  image: string | null;
  url: string;
  content: { type: 'p' | 'h2' | 'h3' | 'li'; text: string }[];
  text: string;
}

/** The id is the number at the end of the URL: ..._520483.html -> 520483. */
export function newsIdFromUrl(url: string): string | null {
  return /_(\d+)\.html/.exec(url)?.[1] ?? null;
}

const toIso = (value: unknown): string | null => {
  const t = Date.parse(String(value ?? ''));
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};

/** The news list from the RSS feed, most recent first, at most `limit` items. */
export async function fetchNewsList(fetcher: Fetcher, limit = 30): Promise<NewsItem[]> {
  const response = await request(fetcher, RSS_URL, { headers: BROWSER_HEADERS });
  if (!response.ok) throw new ProviderError(`HTTP ${response.status}`, response.status);
  const xml = new XMLParser({ ignoreAttributes: true, parseTagValue: false }).parse(await response.text());
  const raw = xml?.rss?.channel?.item;
  const items: Record<string, string>[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
  // the first RSS entries are the site itself; real news have the id in the URL
  return items
    .map((item) => {
      const url = String(item.link ?? '').trim();
      const description = cheerio.load(String(item.description ?? ''));
      return {
        id: newsIdFromUrl(url),
        title: String(item.title ?? '').trim(),
        summary: description.text().replace(/\s+/g, ' ').trim(),
        image: description('img').first().attr('src') ?? null,
        published_at: toIso(item.pubDate),
        url,
      };
    })
    .filter((n) => n.id !== null)
    .slice(0, limit);
}

/** "02/11/2026 10h23" is Brasília time (UTC-3). */
function brasiliaToIso(text: string | undefined): string | null {
  const m = /(\d{2})\/(\d{2})\/(\d{4}) (\d{2})h(\d{2})/.exec(text ?? '');
  return m ? new Date(`${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:00-03:00`).toISOString() : null;
}

/** The full article. Agrolink redirects /noticias/x_<id>.html to the right slug. Only numeric ids are accepted. */
export async function fetchArticle(fetcher: Fetcher, id: string): Promise<Article> {
  if (!/^\d+$/.test(id)) throw new NewsNotFoundError(id);
  const response = await request(fetcher, `${BASE}/noticias/x_${id}.html`, { headers: BROWSER_HEADERS });
  if (response.status === 404) throw new NewsNotFoundError(id);
  if (!response.ok) throw new ProviderError(`HTTP ${response.status}`, response.status);
  const page = cheerio.load(new TextDecoder('utf-8').decode(await response.arrayBuffer()));

  // The page splits the body in several `ds-article-body` blocks (some are empty placeholders): read them all, in order
  const bodies = page('[class*="ds-article-body"]')
    .toArray()
    .map((b) => page(b))
    .filter((b) => b.text().trim() !== '');
  const article = page('article').first();
  if (!bodies.length || !article.length) throw new NewsNotFoundError(id);

  const content: Article['content'] = [];
  for (const body of bodies) {
    body.find('p, h2, h3, li').each((_, el) => {
      const text = page(el).text().replace(/\s+/g, ' ').trim();
      if (text) content.push({ type: (el as unknown as { tagName: string }).tagName.toLowerCase() as 'p' | 'h2' | 'h3' | 'li', text });
    });
  }

  const meta = (property: string) => page(`meta[property="${property}"]`).attr('content') ?? null;
  const header = article.text().replace(/\s+/g, ' ');
  return {
    id,
    title: page('h1').first().text().trim() || meta('og:title'),
    author: /Por (.+?) \d{2}\/\d{2}\/\d{4}/.exec(header)?.[1] ?? null,
    published_at: brasiliaToIso(/(\d{2}\/\d{2}\/\d{4} \d{2}h\d{2})/.exec(header)?.[1]),
    image: meta('og:image'),
    url: response.url || `${BASE}/noticias/x_${id}.html`,
    content,
    text: content.map((b) => b.text).join('\n\n'),
  };
}
