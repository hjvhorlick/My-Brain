const HIGH_AUTHORITY_HOSTS = [
  '.gov', '.gov.za', '.ac.za', '.edu', '.ac.uk', 'who.int', 'un.org', 'nasa.gov',
  'iea.org', 'worldbank.org', 'statssa.gov.za', 'csir.co.za', 'science.org', 'nature.com'
];

function decodeHtml(value = '') {
  return value.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)));
}

function contentOf(meta, html) {
  const re = new RegExp(`<meta[^>]+(?:name|property)=["']${meta}["'][^>]+content=["']([^"']+)["']`, 'i');
  const match = html.match(re) || html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']${meta}["']`, 'i'));
  return match ? decodeHtml(match[1].trim()) : '';
}

export function inferSourceType(url = '') {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host.endsWith('.gov') || host.includes('.gov.')) return 'government';
    if (host.endsWith('.edu') || host.includes('.ac.')) return 'university';
    if (/(nature|science|springer|elsevier|pubmed|arxiv|ieee|acm)/.test(host)) return 'academic publication';
    if (/(wikipedia|britannica)/.test(host)) return 'encyclopaedia';
    if (/(reuters|apnews|bbc|nytimes|guardian|news24)/.test(host)) return 'news';
    if (/(youtube|vimeo)/.test(host)) return 'video';
    return 'website';
  } catch { return 'website'; }
}

export function assessReliability(url = '', type = 'website') {
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch { return 'not assessed'; }
  if (HIGH_AUTHORITY_HOSTS.some(domain => host === domain.slice(1) || host.endsWith(domain))) return 'high — institutional domain signal';
  if (['government', 'university', 'academic publication'].includes(type)) return 'high — source type signal';
  if (type === 'news') return 'medium — newsroom, verify against primary sources';
  if (type === 'encyclopaedia') return 'medium — useful orientation, follow citations';
  return 'not assessed — evaluate author, evidence and date';
}

function htmlToText(html) {
  const withoutNoise = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ').replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ').replace(/<footer[\s\S]*?<\/footer>/gi, ' ');
  return decodeHtml(withoutNoise.replace(/<\/(p|h[1-6]|li|article|section|br|div)>/gi, '\n')
    .replace(/<[^>]*>/g, ' ').replace(/\s+\n/g, '\n').replace(/[ \t]{2,}/g, ' '))
    .split('\n').map(x => x.trim()).filter(x => x.length > 40).join('\n');
}
function outgoingPublicLinks(html, pageUrl) {
  const links=[]; const seen=new Set();
  for (const match of String(html).matchAll(/<a\b[^>]*?\bhref=["']([^"']+)["']/gi)) {
    try {
      const url=new URL(decodeHtml(match[1]),pageUrl);
      if (!['http:','https:'].includes(url.protocol) || seen.has(url.href)) continue;
      seen.add(url.href); links.push(url.href);
      if (links.length>=18) break;
    } catch { /* Ignore malformed, local, mail, and javascript links. */ }
  }
  return links;
}

/** Fetches an original published page server-side after direct discovery. It enriches
 * a source record with readable text and its outward public references; it is not AI. */
export async function collectSource(source) {
  const fallback = {
    ...source,
    website: source.website || (() => { try { return new URL(source.url).hostname; } catch { return ''; } })(),
    source_type: source.source_type || inferSourceType(source.url),
    reliability: source.reliability || assessReliability(source.url, source.source_type),
    extracted_text: '', relevant_passage: '', collection_status: 'metadata only'
  };
  if (!source.url?.startsWith('http')) return fallback;
  try {
    const response = await fetch(source.url, {
      redirect: 'follow', signal: AbortSignal.timeout(9000),
      headers: { 'User-Agent': 'TheBrainResearch/0.1 (local research collector)' }
    });
    const contentType = response.headers.get('content-type') || '';
    if (!response.ok || !contentType.includes('text/html')) {
      return { ...fallback, collection_status: !response.ok ? `unavailable (HTTP ${response.status})` : 'metadata only (non-HTML)' };
    }
    const html = (await response.text()).slice(0, 1_500_000);
    const title = contentOf('og:title', html) || (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/<[^>]*>/g, '').trim() || fallback.title;
    const description = contentOf('description', html) || contentOf('og:description', html);
    const author = contentOf('author', html);
    const date = contentOf('article:published_time', html) || contentOf('date', html);
    const text = htmlToText(html).slice(0, 6500);
    return {
      ...fallback, title: decodeHtml(title), author: author || fallback.author,
      published_date: date || fallback.published_date, extracted_text: text,
      relevant_passage: description || text.slice(0, 700), collection_status: text ? 'collected' : 'metadata only',
      metadata: { ...(source.metadata || {}), outboundLinks: outgoingPublicLinks(html, source.url) }
    };
  } catch (error) {
    return { ...fallback, collection_status: `unavailable (${error.name === 'TimeoutError' ? 'timeout' : 'fetch blocked'})` };
  }
}
