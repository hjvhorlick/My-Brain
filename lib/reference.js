/*
  Reference layer — original code owned by this application.

  It turns a public URL or a search term into material this application can render
  itself: dictionary entries, Wikipedia article sections, readable web-page text and
  a direct playable media URL. No third-party widget, embed or SDK is used; every
  viewer in the client is built in this repository.

  Public APIs are used only as data sources (Wiktionary/Wikipedia, dictionaryapi.dev,
  Internet Archive, Wikimedia Commons metadata).
*/

const TIMEOUT_MS = 8000;
const USER_AGENT = 'TheBrainResearch/0.1 (reference reader)';

function text(value = '') {
  return String(value)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/[ \t]{2,}/g, ' ').replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
function limit(value, length) { return String(value || '').slice(0, length); }
function keyOf(value = '') { return String(value).toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim(); }
function publicUrl(value) { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href : ''; } catch { return ''; } }
function upstream(error, what = 'public index') {
  const message = /timeout|abort/i.test(String(error?.name || error?.message))
    ? `The ${what} did not answer in time. Try again in a moment.`
    : `The ${what} could not be reached from this server. Check this machine's internet connection and try again.`;
  const wrapped = new Error(message);
  wrapped.status = 502;
  wrapped.cause = error;
  return wrapped;
}
async function fetchJson(url, what = 'public index') {
  let response;
  try { response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } }); }
  catch (error) { throw upstream(error, what); }
  if (!response.ok) { const error = new Error(`The ${what} answered with HTTP ${response.status}.`); error.status = response.status === 404 ? 404 : 502; throw error; }
  return response.json().catch(error => { throw upstream(error, what); });
}

/* ---------------------------------------------------------------- dictionary */

// dictionaryapi.dev is a free, keyless English dictionary aggregator (Wiktionary-derived).
// The shape is normalised here so the client never depends on a provider's raw schema.
export async function dictionaryLookup(term = '') {
  const word = String(term || '').trim().toLowerCase().replace(/[^a-z' -]/g, '').replace(/\s+/g, ' ').slice(0, 60);
  if (!word) return { term: '', entries: [], provider: 'dictionaryapi.dev' };
  let data;
  try { data = await fetchJson(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`, 'dictionary index'); }
  catch (error) {
    // "Not found" is an answer about the word; an unreachable index is not.
    if (error.status === 404) return { term: word, entries: [], provider: 'dictionaryapi.dev (Wiktionary-derived)', notFound: true };
    throw error;
  }
  const entries = (Array.isArray(data) ? data : []).slice(0, 4).map(entry => ({
    word: limit(entry.word, 120),
    phonetic: limit(entry.phonetic || (entry.phonetics || []).find(item => item.text)?.text || '', 120),
    audio: publicUrl((entry.phonetics || []).find(item => item.audio)?.audio || ''),
    origin: limit(entry.origin, 400),
    sourceUrls: (entry.sourceUrls || []).map(publicUrl).filter(Boolean).slice(0, 4),
    meanings: (entry.meanings || []).slice(0, 6).map(meaning => ({
      partOfSpeech: limit(meaning.partOfSpeech, 60),
      definitions: (meaning.definitions || []).slice(0, 8).map(definition => ({
        definition: limit(definition.definition, 1200),
        example: limit(definition.example, 600)
      })).filter(definition => definition.definition),
      synonyms: (meaning.synonyms || []).filter(Boolean).slice(0, 10),
      antonyms: (meaning.antonyms || []).filter(Boolean).slice(0, 10)
    })).filter(meaning => meaning.definitions.length)
  })).filter(entry => entry.meanings.length);
  return { term: word, entries, provider: 'dictionaryapi.dev (Wiktionary-derived)' };
}

/* ----------------------------------------------------------------- wikipedia */

// The article reader parses the encyclopaedia's own public article HTML into plain
// sections, images and internal links. Only text/structure is reused; the reading
// surface, typography and navigation are this application's own.
export async function wikipediaArticle(title = '') {
  const page = String(title || '').trim().replace(/^https?:\/\/[^/]+\/wiki\//i, '').replace(/_/g, ' ');
  if (!page) throw Object.assign(new Error('Choose a Wikipedia article to read.'), { status: 400 });
  const endpoint = `https://en.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(page)}&prop=text%7Csections%7Cdisplaytitle&redirects=1&format=json&origin=*`;
  const data = await fetchJson(endpoint, 'Wikipedia');
  if (data.error) throw Object.assign(new Error(`Wikipedia has no article titled “${page}”.`), { status: 404 });
  const html = String(data.parse?.text?.['*'] || '');
  const displayTitle = text(data.parse?.displaytitle || data.parse?.title || page);

  const sections = [];
  // Only real article headings count. Wikipedia also emits a hidden <h2> for the article
  // title itself; matching any id="..." wrapper pulled that in and silently dropped the
  // first genuine section (for example a "Novel" heading on the Book article).
  const headings = [...html.matchAll(/<h([2-4])\b[^>]*>([\s\S]*?)<\/h\1>/gi)]
    .filter(heading => !/\bid=["'](?:firstHeading|mw-firstHeading|siteSub)["']/i.test(heading[0]));
  const sectionDetails = [];
  headings.forEach((heading, index) => {
    const start = heading.index + heading[0].length;
    const end = index + 1 < headings.length ? headings[index + 1].index : html.length;
    // A heading that names the article itself ("Novel" on the Novel article) is a title,
    // not a section, and its body is the article lead handled below.
    if (index === 0 && keyOf(heading[2]) === keyOf(displayTitle)) return;
    const body = html.slice(start, end)
      .replace(/<figure[\s\S]*?<\/figure>/gi, ' ')
      .replace(/<table[\s\S]*?<\/table>/gi, ' ');
    const content = text(body);
    if (content.length < 20) return;
    const level = Number(heading[1]);
    const title = text(heading[2].replace(/<span[^>]*class="[^"]*mw-editsection[^"]*"[\s\S]*?<\/span>/i, ''))
      .replace(/\s*\[\s*(?:edit|show|hide)\s*\]$/i, '').replace(/\[\w+\]$/, '').trim();
    sections.push({ title, level, text: limit(content, 12000) });
    // Named members: everything until the next heading of the same or higher level, so a
    // "Names" section keeps the sub-headings (Yahweh, Allah) and links that belong to it.
    let blockEndIndex = html.length;
    for (let next = index + 1; next < headings.length; next += 1) {
      if (Number(headings[next][1]) <= level) { blockEndIndex = headings[next].index; break; }
    }
    const block = html.slice(start, blockEndIndex);
    const subs = [...block.matchAll(/<h([3-4])\b[^>]*>([\s\S]*?)<\/h\1>/gi)]
      .map(match => text(match[2].replace(/<span[^>]*mw-editsection[\s\S]*?<\/span>/i, ''))
        .replace(/\s*\[\s*(?:edit|show|hide)\s*\]$/i, '').replace(/\[\w+\]$/, '').trim())
      .filter(Boolean);
    const links = [];
    const seenLinks = new Set();
    for (const match of block.matchAll(/<a\b[^>]*href="\/wiki\/([^"#?]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
      const target = decodeURIComponent(match[1]).replace(/_/g, ' ');
      const label = text(match[2]).replace(/\s+/g, ' ').trim();
      if (!target || !label || label.length > 80 || seenLinks.has(target) || target.includes(':')) continue;
      seenLinks.add(target); links.push(target);
      if (links.length >= 24) break;
    }
    sectionDetails.push({ title, level, subheadings: subs.slice(0, 14), links });
  });

  // Lead text before the first heading is the article's introduction.
  const firstHeading = headings.length ? headings[0].index : html.length;
  const lead = text(html.slice(0, firstHeading).replace(/<table[\s\S]*?<\/table>/gi, ' '));
  if (lead.length > 40) sections.unshift({ title: 'Introduction', level: 2, text: limit(lead, 12000) });

  const images = [];
  for (const match of html.matchAll(/<img\b[^>]*src="([^"]+)"[^>]*>/gi)) {
    const url = publicUrl(match[1].startsWith('//') ? `https:${match[1]}` : match[1]);
    if (!url || /\.svg($|\?)/i.test(url) || /(?:icon|logo|ambox|edit|question_book|padlock|symbol)/i.test(url)) continue;
    if (!images.includes(url)) images.push(url);
    if (images.length >= 12) break;
  }

  const links = [];
  const seen = new Set();
  for (const match of html.matchAll(/<a\b[^>]*href="\/wiki\/([^"#?]+)"[^>]*>/gi)) {
    const target = decodeURIComponent(match[1]).replace(/_/g, ' ');
    if (!target || seen.has(target) || target.includes(':') || target.length > 90) continue;
    seen.add(target); links.push(target);
    if (links.length >= 40) break;
  }

  return {
    title: displayTitle,
    url: `https://en.wikipedia.org/wiki/${encodeURIComponent(String(data.parse?.title || page).replace(/ /g, '_'))}`,
    provider: 'Wikipedia',
    sections: sections.slice(0, 40),
    sectionDetails: sectionDetails.slice(0, 40),
    images,
    links,
    sectionCount: (data.parse?.sections || []).length
  };
}

// A compact summary is used by search results and the map inspector.
export async function wikipediaSummary(title = '') {
  const page = String(title || '').trim().replace(/^https?:\/\/[^/]+\/wiki\//i, '').replace(/_/g, ' ');
  const data = await fetchJson(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(page)}`, 'Wikipedia');
  if (!data || data.type === 'disambiguation' && !data.extract) throw Object.assign(new Error('No single Wikipedia article matches that term.'), { status: 404 });
  return {
    title: data.title || page,
    description: limit(data.description, 300),
    extract: limit(data.extract, 4000),
    url: data.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encodeURIComponent(page)}`,
    thumbnail: publicUrl(data.thumbnail?.source || ''),
    provider: 'Wikipedia'
  };
}

/* -------------------------------------------------------------------- video */

const VIDEO_EXTENSIONS = /\.(?:mp4|webm|ogv|ogg|mov|m4v)(?:$|\?)/i;
const AUDIO_EXTENSIONS = /\.(?:mp3|ogg|oga|opus|flac|m4a|wav)(?:$|\?)/i;

async function internetArchivePlayback(identifier) {
  const data = await fetchJson(`https://archive.org/metadata/${encodeURIComponent(identifier)}`, 'Internet Archive');
  const server = data.server || 'archive.org';
  const directory = data.dir || '';
  const formats = new Set(['h.264', 'mpeg4', '512kb mpeg4', 'ogg video', 'webm', 'h.264 ia', 'matroska', 'mpeg2']);
  const candidates = (data.files || []).filter(file =>
    VIDEO_EXTENSIONS.test(file.name) || (file.format && formats.has(String(file.format).toLowerCase()))
  ).sort((left, right) => Number(right.size || 0) - Number(left.size || 0));
  const best = candidates.find(file => /\.mp4(?:$|\?)/i.test(file.name)) || candidates[0];
  if (!best) return null;
  const filePath = `${String(directory || '').replace(/^\/+/, '')}/${best.name}`.replace(/^\/+/, '');
  return {
    kind: 'direct',
    mimeType: /\.webm/i.test(best.name) ? 'video/webm' : 'video/mp4',
    url: `https://${server}/download/${encodeURIComponent(identifier)}/${filePath.split('/').map(encodeURIComponent).join('/')}`,
    label: best.name
  };
}

async function commonsPlayback(url) {
  // Wikimedia Commons serves original audio and video files from upload.wikimedia.org.
  if (/upload\.wikimedia\.org/i.test(url)) {
    if (VIDEO_EXTENSIONS.test(url)) return { kind: 'direct', mimeType: 'video/webm', url, label: 'Commons file' };
    if (AUDIO_EXTENSIONS.test(url)) return { kind: 'direct', mimeType: 'audio/ogg', url, label: 'Commons file' };
    return null;
  }
  const match = url.match(/commons\.wikimedia\.org\/wiki\/(File:[^?#]+)/i);
  if (!match) return null;
  const title = decodeURIComponent(match[1]).replace(/_/g, ' ');
  const data = await fetchJson(`https://commons.wikimedia.org/w/api.php?action=query&titles=${encodeURIComponent(title)}&prop=imageinfo&iiprop=url%7Cmime&format=json&origin=*`, 'Wikimedia Commons');
  const page = Object.values(data.query?.pages || {})[0];
  const info = page?.imageinfo?.[0];
  if (!info?.url || !/^(?:video|audio)\//i.test(info.mime || '')) return null;
  return { kind: 'direct', mimeType: info.mime, url: info.url, label: title };
}

/**
 * Resolves a saved source into something the client can play natively.
 * Returns { kind: 'direct' | 'external' | 'none' } — never an embedded third-party player.
 */
export async function resolvePlayback({ url, thumbnail = '', metadata = {} } = {}) {
  const original = publicUrl(metadata.playbackUrl || url);
  const archiveIdentifier = metadata.identifier || (original && /archive\.org\/details\/([^/?#]+)/i.exec(original)?.[1]) || '';
  const poster = publicUrl(metadata.poster || thumbnail);
  if (archiveIdentifier) {
    try {
      const found = await internetArchivePlayback(archiveIdentifier);
      if (found) return { ...found, poster, provider: 'Internet Archive', originalUrl: original, source: 'archive.org' };
    } catch { /* fall through to other resolvers */ }
  }
  if (original) {
    try {
      const commons = await commonsPlayback(original);
      if (commons) return { ...commons, poster, provider: 'Wikimedia Commons', originalUrl: original, source: 'commons.wikimedia.org' };
    } catch { /* fall through */ }
    if (VIDEO_EXTENSIONS.test(original)) return { kind: 'direct', mimeType: 'video/mp4', url: original, poster, provider: 'Direct file', originalUrl: original, source: new URL(original).hostname };
    if (AUDIO_EXTENSIONS.test(original)) return { kind: 'direct', mimeType: 'audio/mpeg', url: original, poster, provider: 'Direct file', originalUrl: original, source: new URL(original).hostname };
  }
  // A page we cannot stream is still useful: the client shows its poster and a
  // clearly-labelled link to the original page instead of pretending to play it.
  return { kind: original ? 'external' : 'none', url: '', poster, provider: 'Original page', originalUrl: original, source: original ? new URL(original).hostname : '' };
}

/* ---------------------------------------------------------------- web reader */

/**
 * Fetches a public page server-side and reduces it to readable text plus its
 * outgoing links. Nothing is generated: the reader shows only what the page says.
 */
export async function readWebPage(rawUrl) {
  const url = publicUrl(rawUrl);
  if (!url) throw Object.assign(new Error('Enter a public http(s) web address.'), { status: 400 });
  let response;
  try {
    response = await fetch(url, {
      redirect: 'follow', signal: AbortSignal.timeout(9500),
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' }
    });
  } catch (error) { throw upstream(error, 'page'); }
  const contentType = response.headers.get('content-type') || '';
  if (!response.ok) throw Object.assign(new Error(`The page returned HTTP ${response.status}.`), { status: 502 });
  if (!contentType.includes('text/html') && !contentType.includes('text/plain')) {
    throw Object.assign(new Error('This address is not an HTML page; open the original file instead.'), { status: 415 });
  }
  const html = (await response.text()).slice(0, 2_000_000);
  const meta = name => {
    const pattern = new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]+content=["']([^"']+)["']`, 'i');
    const reversed = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']${name}["']`, 'i');
    const match = html.match(pattern) || html.match(reversed);
    return match ? text(match[1]) : '';
  };
  const title = meta('og:title') || text((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '') || url;
  const description = meta('description') || meta('og:description');
  const siteName = meta('og:site_name') || new URL(url).hostname;
  const author = meta('author') || meta('article:author');
  const published = meta('article:published_time') || meta('date');

  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ').replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ').replace(/<aside[\s\S]*?<\/aside>/gi, ' ')
    .replace(/<(?:br|\/p|\/h[1-6]|\/li|\/div|\/section)>/gi, '\n');
  const paragraphs = text(body).split('\n')
    .map(line => line.trim())
    .filter(line => line.length >= 60)
    .slice(0, 90);

  const links = [];
  const seen = new Set();
  for (const match of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let absolute;
    try { absolute = new URL(match[1], url).href; } catch { continue; }
    if (!/^https?:/i.test(absolute) || seen.has(absolute) || /^(?:#|mailto:|javascript:)/i.test(match[1])) continue;
    const label = text(match[2]).slice(0, 120);
    if (!label) continue;
    seen.add(absolute); links.push({ label, url: absolute });
    if (links.length >= 60) break;
  }

  return {
    url, title: limit(title, 300), siteName: limit(siteName, 160), description: limit(description, 900),
    author: limit(author, 200), published: limit(published, 60),
    paragraphs: paragraphs.map(line => limit(line, 2000)),
    links, provider: 'Original page (read server-side)'
  };
}
