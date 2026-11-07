/*
  Public, no-key discovery adapters. These are source indexes, not generated answers:
  every returned item retains the provider, original URL and provider-supplied metadata.

  Every adapter below is free, keyless and called directly by this server. No
  third-party search product, SDK or embedded widget is used. The two readers that
  sit in front of it (dictionary and Wikipedia) live in lib/reference.js.
*/
import { dictionaryLookup } from './reference.js';
const TIMEOUT_MS = 5500;
const USER_AGENT = 'TheBrainResearch/0.1 (local source discovery)';
const WIKIPEDIA_CACHE_MS = 180000;
const wikipediaPageCache = new Map();
const wikipediaSearchCache = new Map();

function clean(value = '') {
  return String(value).replace(/<[^>]*>/g, ' ').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
}
function limit(value, length) { return clean(value).slice(0, length); }
function datePart(value) { return value ? String(value).slice(0, 10) : ''; }
function validUrl(value) { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href : ''; } catch { return ''; } }
const pause = milliseconds => new Promise(resolve=>setTimeout(resolve,milliseconds));
async function getJson(url) {
  // Public indexes occasionally apply a short shared-IP rate limit. Retry once before
  // treating the source as unavailable; never replace it with an unrelated result.
  for(let attempt=0;attempt<2;attempt++){
    const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
    if(response.ok)return response.json();
    if(response.status===429 && attempt===0){await pause(900);continue;}
    throw new Error(`HTTP ${response.status}`);
  }
}
async function getText(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'User-Agent': USER_AGENT, Accept: 'application/atom+xml, application/xml, text/xml' } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}
function make({ provider, kind, title, url, website, snippet = '', extractedText = '', author = '', publishedDate = '', thumbnail = '', metadata = {} }) {
  const safe = validUrl(url);
  if (!safe || !title) return null;
  return { provider, kind, title: limit(title, 500), url: safe, website: limit(website || new URL(safe).hostname, 250), snippet: limit(snippet, 1000), extractedText: String(extractedText || '').slice(0, 12000), author: limit(author, 250), publishedDate: datePart(publishedDate), thumbnail: validUrl(thumbnail), metadata };
}
function invertedAbstract(index) {
  if (!index || typeof index !== 'object') return '';
  const terms = [];
  for (const [word, positions] of Object.entries(index)) for (const position of positions || []) terms[position] = word;
  return terms.filter(Boolean).join(' ');
}

async function wikipediaStructure(title) {
  // This bounded page read supplies both the actual article text and its table of
  // contents. A result is therefore evaluated on page material, not just its title.
  const key=clean(title).toLowerCase(); const cached=wikipediaPageCache.get(key);
  if(cached && Date.now()-cached.at<WIKIPEDIA_CACHE_MS)return cached.value;
  const value=(async()=>{
    const endpoint=`https://en.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(title)}&prop=sections%7Ctext&format=json&origin=*`;
    const data=await getJson(endpoint);
    const sectionOutline=(data.parse?.sections || []).map(section=>({title:clean(section.line).replace(/<[^>]+>/g,'').trim(),level:Number(section.toclevel || 1)}))
      .filter(section=>section.title.length>=2&&section.title.length<=120).slice(0,42);
    const sections=sectionOutline.map(section=>section.title);
    const extractedText=stripHtml(data.parse?.text?.['*'] || '').slice(0,12000);
    return {sections,sectionOutline,extractedText};
  })();
  wikipediaPageCache.set(key,{at:Date.now(),value});
  try{return await value;}catch(error){wikipediaPageCache.delete(key);throw error;}
}
function stripHtml(value = '') {
  return clean(String(value).replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' '));
}
function isLdsFoundationsQuery(query = '') {
  const words=clean(query).toLowerCase();
  return /\b(?:lds|mormon|latter[ -]day saints?)\b/.test(words) && /\b(?:belief|believe|doctrine|faith|religion|church|gospel)\b/.test(words);
}
function ldsFoundationSections(pageText = '') {
  const sections=[]; const found=(label, expression)=>{if(expression.test(pageText))sections.push(label);};
  // Each label below is an exact or shortened phrase in the page's visible primary text.
  // We only return it after the live page itself supplied the matching wording.
  found('God the Father, Jesus Christ, and the Holy Ghost', /we\s+believe\s+in\s+god[^.]{0,400}?jesus christ[^.]{0,240}?holy ghost/i);
  found('The first principles and ordinances of the Gospel', /first\s+principles\s+and\s+ordinances\s+of\s+the\s+gospel/i);
  found('Apostles and prophets', /apostles\s*,\s*prophets\s*,\s*pastors/i);
  found('The Bible and the Book of Mormon', /believe\s+the\s+bible[^.]{0,500}?book\s+of\s+mormon/i);
  found('Continuing revelation', /does\s+now\s+reveal[^.]{0,320}?will\s+yet\s+reveal/i);
  return sections;
}
async function officialLdsFoundations(query) {
  if (!isLdsFoundationsQuery(query)) return [];
  const url='https://www.churchofjesuschrist.org/study/scriptures/pgp/a-of-f/1?lang=eng';
  const response=await fetch(url,{signal:AbortSignal.timeout(TIMEOUT_MS),headers:{'User-Agent':USER_AGENT,Accept:'text/html,application/xhtml+xml'}});
  if(!response.ok) throw new Error(`HTTP ${response.status}`);
  const pageText=stripHtml((await response.text()).slice(0,900000));
  const sections=ldsFoundationSections(pageText);
  if(!sections.length) throw new Error('The official primary text did not expose its visible foundations.');
  return [make({
    provider:'Church of Jesus Christ — official primary source', kind:'primary source',
    title:'Articles of Faith — official Latter-day Saint beliefs', url, website:'churchofjesuschrist.org',
    snippet:'Primary text collected directly from the Church’s public scripture site.', extractedText:pageText,
    metadata:{searchRank:-3,sections,sourceRole:'official primary text',sectionMethod:'matched visible source wording',contextAliases:['lds','mormon','latter-day saints']}
  })];
}
function searchWords(value = '') {
  return [...new Set(clean(value).toLowerCase().split(/[^a-z0-9]+/).filter(word=>word.length>2&&!['the','and','for','with','from','about','work'].includes(word)))];
}
function wikipediaPagePriority(page, focus = '') {
  const title=clean(page.title || '').toLowerCase(); const excerpt=clean(page.excerpt || page.description || '').toLowerCase();
  const words=searchWords(focus); if(!words.length)return 0;
  const titleHits=words.filter(word=>title.includes(word)).length;
  const excerptHits=words.filter(word=>excerpt.includes(word)).length;
  const phrase=clean(focus).toLowerCase();
  return titleHits*12+excerptHits*2+(phrase.length>4&&title.includes(phrase)?16:0);
}
async function wikipedia(query, options = {}) {
  const cacheKey=clean(query).toLowerCase(); const cached=wikipediaSearchCache.get(cacheKey);
  let data;
  if(cached && Date.now()-cached.at<WIKIPEDIA_CACHE_MS)data=await cached.value;
  else {
    const value=getJson(`https://en.wikipedia.org/w/rest.php/v1/search/page?q=${encodeURIComponent(query)}&limit=8`);
    wikipediaSearchCache.set(cacheKey,{at:Date.now(),value});
    try{data=await value;}catch(error){wikipediaSearchCache.delete(cacheKey);throw error;}
  }
  const pages=data.pages || [];
  // A bounded four-page read is enough to inspect the best focus matches without
  // hammering a public endpoint. In particular, a clicked topic may be result four
  // even when result one is an adjacent but less relevant page.
  const focus=options?.focus || query;
  const focusOrdered=[...pages].sort((left,right)=>wikipediaPagePriority(right,focus)-wikipediaPagePriority(left,focus));
  const pagesToRead=[]; const seenPage=new Set();
  for(const page of [pages[0],...focusOrdered]){const key=String(page?.id || page?.key || page?.title || '');if(!key||seenPage.has(key))continue;seenPage.add(key);pagesToRead.push(page);if(pagesToRead.length>=4)break;}
  const pageReads=await Promise.allSettled(pagesToRead.map(async page=>({key:String(page.id || page.key || page.title),structure:await wikipediaStructure(page.title)})));
  const structuresByPage=new Map(pageReads.filter(result=>result.status==='fulfilled').map(result=>[result.value.key,result.value.structure]));
  return pages.map((page,index) => {
    const structure=structuresByPage.get(String(page.id || page.key || page.title)) || {sections:[],extractedText:''};
    return make({
      provider: 'Wikipedia', kind: 'article', title: page.title,
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(page.key || page.title.replaceAll(' ', '_'))}`,
      website: 'en.wikipedia.org', snippet: page.excerpt || page.description || '', extractedText:structure.extractedText, thumbnail: page.thumbnail?.url || '',
      metadata: { pageId: page.id, key: page.key, searchRank:index, sections:structure.sections, sectionOutline:structure.sectionOutline || [], pageRead:Boolean(structure.extractedText) }
    });
  }).filter(Boolean);
}
async function wikimediaImages(query) {
  const api = new URL('https://commons.wikimedia.org/w/api.php');
  const parameters = { action: 'query', generator: 'search', gsrsearch: query, gsrnamespace: '6', gsrlimit: '10', prop: 'imageinfo|info', inprop: 'url', iiprop: 'url|extmetadata', iiurlwidth: '240', format: 'json', origin: '*' };
  for (const [key, value] of Object.entries(parameters)) api.searchParams.set(key, value);
  const data = await getJson(api.href);
  return Object.values(data.query?.pages || {}).map(page => {
    const info = page.imageinfo?.[0] || {};
    return make({ provider: 'Wikimedia Commons', kind: 'image', title: page.title?.replace(/^File:/i, '') || 'Untitled image', url: info.url || page.canonicalurl, website: 'commons.wikimedia.org', snippet: 'Public media from Wikimedia Commons.', thumbnail: info.thumburl || info.url || '', metadata: { pageUrl: page.canonicalurl || '', mediaTitle: page.title || '', license: info.extmetadata?.LicenseShortName?.value || '' } });
  }).filter(Boolean);
}
async function openAlex(query) { 
  const data = await getJson(`https://api.openalex.org/works?search=${encodeURIComponent(query)}&per-page=8`);
  return (data.results || []).map(work => make({
    provider: 'OpenAlex', kind: 'paper', title: work.title,
    url: work.open_access?.oa_url || work.primary_location?.landing_page_url || work.doi || `https://openalex.org/${work.id?.split('/').pop()}`,
    website: work.primary_location?.source?.display_name || 'OpenAlex', snippet: invertedAbstract(work.abstract_inverted_index),
    author: (work.authorships || []).slice(0, 4).map(item => item.author?.display_name).filter(Boolean).join(', '), publishedDate: work.publication_date || '',
    thumbnail: '', metadata: { openAlexId: work.id || '', doi: work.doi || '', citedByCount: work.cited_by_count || 0, source: work.primary_location?.source?.display_name || '' }
  })).filter(Boolean);
}
async function crossref(query) {
  const data = await getJson(`https://api.crossref.org/works?query=${encodeURIComponent(query)}&rows=8&select=DOI,title,author,abstract,published-online,published-print,created,type,URL,link,publisher`);
  return (data.message?.items || []).map(item => {
    const parts = item['published-online']?.['date-parts']?.[0] || item['published-print']?.['date-parts']?.[0] || item.created?.['date-parts']?.[0] || [];
    const publishedDate = parts.length ? `${parts[0]}-${String(parts[1] || 1).padStart(2, '0')}-${String(parts[2] || 1).padStart(2, '0')}` : '';
    return make({ provider: 'Crossref', kind: 'paper', title: item.title?.[0], url: item.link?.find(link => /pdf/i.test(link['content-type'] || ''))?.URL || item.URL || `https://doi.org/${item.DOI}`, website: item.publisher || 'Crossref', snippet: item.abstract || '', author: (item.author || []).slice(0, 4).map(a => [a.given, a.family].filter(Boolean).join(' ')).filter(Boolean).join(', '), publishedDate, metadata: { doi: item.DOI || '', crossrefType: item.type || '' } });
  }).filter(Boolean);
}
function xmlTag(block, name) { return clean(block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'))?.[1] || ''); }
async function arxiv(query) {
  const data = await getText(`https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&start=0&max_results=8&sortBy=relevance&sortOrder=descending`);
  return [...data.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)].map(match => {
    const entry = match[1]; const id = xmlTag(entry, 'id');
    const author = [...entry.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/gi)].map(a => clean(a[1])).slice(0, 4).join(', ');
    return make({ provider: 'arXiv', kind: 'document', title: xmlTag(entry, 'title'), url: id, website: 'arxiv.org', snippet: xmlTag(entry, 'summary'), author, publishedDate: xmlTag(entry, 'published'), metadata: { arxivId: id.split('/').pop() || '' } });
  }).filter(Boolean);
}
function archiveThumbnail(identifier = '') { return identifier ? `https://archive.org/services/img/${encodeURIComponent(identifier)}` : ''; }
function archiveEmbed(identifier = '') { return identifier ? `https://archive.org/embed/${encodeURIComponent(identifier)}` : ''; }
async function internetArchive(query) {
  const url = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(`(${query}) AND mediatype:texts`)}&fl[]=identifier,title,creator,date,year,description,mediatype&rows=12&page=1&output=json`;
  const data = await getJson(url);
  return (data.response?.docs || []).map(item => make({ provider: 'Internet Archive', kind: 'book', title: item.title || item.identifier, url: `https://archive.org/details/${encodeURIComponent(item.identifier)}`, website: 'archive.org', snippet: item.description || '', author: Array.isArray(item.creator) ? item.creator.join(', ') : item.creator || '', publishedDate: item.date || item.year || '', thumbnail: archiveThumbnail(item.identifier), metadata: { identifier: item.identifier, mediatype: item.mediatype || 'texts', embedUrl: archiveEmbed(item.identifier) } })).filter(Boolean);
}
async function internetArchiveMedia(query, mediatype, kind) {
  const url = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(`(${query}) AND mediatype:${mediatype}`)}&fl[]=identifier,title,creator,date,year,description,mediatype,downloads&rows=16&page=1&output=json`;
  const data = await getJson(url);
  return (data.response?.docs || []).map(item => make({
    provider: 'Internet Archive', kind, title: item.title || item.identifier,
    url: `https://archive.org/details/${encodeURIComponent(item.identifier)}`, website: 'archive.org', snippet: item.description || '',
    author: Array.isArray(item.creator) ? item.creator.join(', ') : item.creator || '', publishedDate: item.date || item.year || '', thumbnail: archiveThumbnail(item.identifier),
    metadata: { identifier: item.identifier, mediatype: item.mediatype || mediatype, downloads: item.downloads || 0, embedUrl: archiveEmbed(item.identifier) }
  })).filter(Boolean);
}
async function internetArchiveVideos(query) { return internetArchiveMedia(query, 'movies', 'video'); }
async function internetArchiveMusic(query) { return internetArchiveMedia(query, 'audio', 'music'); }

// Dictionary and Wikipedia are reader types as well as search types: the inspector
// opens them in this application's own readers (see lib/reference.js).
function wikipediaOnly(query, options = {}) { return wikipedia(query, options); }
// Readable provider names for the client's source-status line.
for (const [adapter, label] of [[wikipedia,'Wikipedia'],[wikipediaOnly,'Wikipedia'],[dictionaryEntries,'Dictionary'],[wikimediaImages,'Wikimedia Commons'],[openAlex,'OpenAlex'],[crossref,'Crossref'],[arxiv,'arXiv'],[internetArchive,'Internet Archive'],[internetArchiveVideos,'Internet Archive video'],[internetArchiveMusic,'Internet Archive audio']]) adapter.label = label;
async function dictionaryEntries(query) {
  try {
    const result = await dictionaryLookup(query);
    return (result.entries || []).slice(0, 3).map(entry => make({
      provider: 'Dictionary', kind: 'dictionary',
      title: entry.word + (entry.phonetic ? ` ${entry.phonetic}` : ''),
      url: entry.sourceUrls?.[0] || `https://en.wiktionary.org/wiki/${encodeURIComponent(entry.word)}`,
      website: 'dictionaryapi.dev',
      snippet: (entry.meanings[0]?.definitions[0]?.definition || '') + (entry.meanings.length > 1 ? ` · ${entry.meanings.length - 1} more senses` : ''),
      extractedText: entry.meanings.map(meaning => `(${meaning.partOfSpeech}) ${meaning.definitions.slice(0, 3).map(d => d.definition).join(' / ')}`).join('\n'),
      metadata: { entry }
    }));
  } catch (error) { throw new Error(`No dictionary entry (${error.message})`); }
}

// "reference" answers "what is this thing?" — the structured description and the
// dictionary sense, with no general web noise. The layered search engine starts here.
const groups = {
  reference: [wikipedia, dictionaryEntries],
  web: [wikipedia, internetArchive],
  wikipedia: [wikipediaOnly],
  dictionary: [dictionaryEntries],
  articles: [wikipedia, internetArchive],
  websites: [wikipedia],
  images: [wikimediaImages],
  videos: [internetArchiveVideos],
  books: [internetArchive],
  music: [internetArchiveMusic],
  papers: [openAlex, crossref],
  documents: [arxiv, internetArchive],
  all: [wikipedia, dictionaryEntries, wikimediaImages, openAlex, crossref, arxiv, internetArchive]
};

export async function discoverFreeSources(query, type = 'web', options = {}) {
  const search = String(query || '').trim().slice(0, 300);
  if (!search) return { query: search, type, results: [], providers: [] };
  const jobs = groups[type] || groups.web;
  const settled = await Promise.allSettled(jobs.map(job => job(search, options)));
  const providers = settled.map((result, index) => ({ provider: jobs[index].label || jobs[index].name, status: result.status === 'fulfilled' ? 'ok' : 'unavailable', count: result.status === 'fulfilled' ? result.value.length : 0, error: result.status === 'rejected' ? String(result.reason?.message || 'unavailable') : '' }));
  const unique = new Map();
  for (const result of settled) if (result.status === 'fulfilled') for (const item of result.value) if (!unique.has(item.url)) unique.set(item.url, item);
  return { query: search, type: groups[type] ? type : 'web', results: [...unique.values()].slice(0, 48), providers };
}
