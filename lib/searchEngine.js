/*
  The Brain — layered search engine.

  A search is a *procedure*, not a single query. It answers "what is this thing, what
  kinds of it exist, who makes them, and which ones should I look at first?" in four
  passes, and it will not spend the user's map on vague material:

      layer 0   main item            e.g. Book
      layer 1   its kinds/types      e.g. Novel · Poetry · Textbook · Comic book
      layer 2   writers in a kind    e.g. (Novel)  George Orwell · Chimamanda Ngozi Adichie
      layer 3   works in a kind      e.g. (Novel)  1984 · Things Fall Apart

  Rules that make it accurate instead of noisy:
    • Nothing reaches a layer unless it passes an explicit relevance gate.
    • A layer is capped. A wide, vague web is worse than a small correct one.
    • Every parent has at most MAX_CHILDREN_PER_PARENT children, so the map branches
      instead of forming a fan of unrelated cards.
    • Popularity (citation counts, archive downloads) and freshness (publication year)
      only ever *break ties between otherwise relevant candidates*. They can never
      promote an irrelevant one.
    • A second word narrows the whole procedure ("book religion") rather than starting
      a new search.
    • Branching is lazy: kinds appear with the first search; writers appear when a kind
      is opened; works appear when a writer is opened.

  This module is pure logic plus calls to the public-index adapters. It has no AI and
  stores nothing itself; server.js persists what it returns.
*/

const STOP_WORDS = new Set([
  'a','an','the','and','or','of','for','to','in','on','with','from','by','at','as','is','are','was','were','be','this','that',
  'these','those','what','how','why','when','where','who','about','into','through','using','use','new','types','type','kinds',
  'kind','list','examples','example','best','top','most'
]);
// Words that describe nothing specific. A card titled only with these is noise.
const GENERIC_WORDS = new Set(['introduction','overview','summary','general','basic','basics','miscellaneous','other','others','see also','contents']);

// Section and link names that are navigation furniture rather than kinds of a thing.
const NOISE_SECTIONS = new Set([
  'references','notes','footnotes','citations','see also','external links','further reading','bibliography','sources',
  'gallery','contents','index','navigation','awards','reception','adaptations','film adaptations','media','legacy',
  'criticism','controversy','controversies','in popular culture','popular culture','cultural impact','influence',
  'etymology','terminology','definitions','structure','characteristics','features','examples','notable examples',
  'notable','lists','list of','statistics','demographics','gallery of','trivia','external links','references and notes',
  'notes and references','literature','works cited','editions','translations','publications','selected works'
]);

// Words that signal a *kind of* something. Used to recognise real types, in any domain,
// rather than relying on a hard-coded topic list.
const LIST_HEADING = /^(?:types?|kinds?|forms?|genres?|categories|classification|classification of|list of)\b/i;

// Headings that are navigation furniture on Wikipedia but would otherwise look like a
// promising aspect of the subject. Rejected wherever they appear.
const ASPECT_NOISE = new Set([
  'references','notes','footnotes','citations','see also','external links','further reading','bibliography','sources','gallery',
  'contents','index','navigation','reception','legacy','criticism','controversy','controversies','in popular culture','popular culture',
  'cultural impact','influence','etymology','terminology','trivia','notes and references','literature','works cited','editions',
  'translations','publications','selected works','film adaptations','adaptations','awards','statistics','demographics','gallery of',
  'further information','external websites','authority control','footnotes and references'
]);
// The general shape of an aspect: it names a facet of the subject (its names, character,
// worship, churches…) rather than one of the subject's individual members.
const ASPECT_SIGNAL = /\b(?:names?|naming|titles?|epithets?|attributes?|characters?|characteristics|personality|nature|qualities|properties|description|identity|origins?|history|development|beliefs?|doctrine|teachings?|worship|practices?|rituals?|symbols?|representations?|depictions?|iconography|roles?|functions?|relationships?|family|churches|denominations|branches|sects|traditions?|religions?|faiths?|followers|adherents|sites?|places|temples|churches?|cathedrals?|chapels?|mosques?|synagogues?|shrines?|symbolism|philosophy|theology|ethics|morality|texts?|scriptures?|writings|languages|art|music|prayer|festivals|holidays|culture|society|law|government|science|types?|kinds?|forms?|classification|structure|anatomy|uses?|effects?|causes?)\b/i;
const TYPE_SIGNALS = /\b(?:novel|poetry|poem|drama|play|essay|memoir|biography|autobiography|textbook|encyclopedia|dictionary|comic|manga|magazine|journal|newspaper|audiobook|e-book|ebook|chapbook|anthology|almanac|atlas|guidebook|handbook|manual|scripture|scriptures|religious text|mythology|cookbook|diary|notebook|reference work|genre|genres|literary genre|non-fiction|nonfiction|fiction|fable|fairy tale|folklore|legend|saga|epic|satire|tragedy|comedy|children|young adult|picture book|graphic novel|text|texts|law|treatise|monograph|thesis|periodical|pamphlet|booklet|volume|series|format|form)\b/i;

const ALIASES = new Map([
  ['nonfiction','non fiction'], ['non fiction','nonfiction'], ['e book','ebook'], ['ebook','e book'],
  ['graphic novels','comic book'], ['comic books','comic book'], ['comics','comic book'],
  ['religious texts','religious text'], ['scriptures','religious text'], ['religious scripture','religious text'],
  ['scripture','religious text'], ['holy book','religious text'], ['holy books','religious text'],
  ['textbooks','textbook'], ['poems','poetry'], ['novels','novel'], ['plays','drama']
]);

export const DEFAULT_ENGINE_CONFIG = Object.freeze({
  // Layer sizes: deliberately small. The map is a guide, not a dump.
  MAX_TYPES: 4,                 // aspects shown in layer 1
  MAX_MEMBERS_PER_ASPECT: 5,    // named entries inside one aspect
  MAX_CHILDREN_PER_PARENT: 3,
  MAX_WRITERS_PER_TYPE: 2,      // kept for the expand-a-category route
  MAX_WORKS_PER_WRITER: 2,
  MAX_WORKS: 8,
  MIN_TYPE_SCORE: 4,            // an aspect must earn its place
  MIN_MEMBER_SCORE: 3,
  MIN_WRITER_SCORE: 3,
  MIN_WORK_SCORE: 2,
  // Relevance weights. Sum ~= 100 for a perfect title+body match.
  W_TITLE: 45,
  W_BODY: 18,
  W_FACET_TITLE: 16,
  W_FACET_BODY: 8,
  W_REFERENCE: 6,
  W_POPULARITY: 6,        // tie-breaker only
  W_FRESHNESS: 4,         // tie-breaker only
  GENERIC_PENALTY: 12
});

const PROVIDER_RANK = { 'Wikipedia': 3, 'Dictionary': 3, 'Wikimedia Commons': 2, 'Internet Archive': 1, 'OpenAlex': 2, 'Crossref': 1, 'arXiv': 1 };

export function engineConfig(overrides = {}) {
  return { ...DEFAULT_ENGINE_CONFIG, ...(overrides && typeof overrides === 'object' ? overrides : {}) };
}

/* ------------------------------------------------------------------- helpers */

function words(value = '') {
  return String(value).toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean);
}
function keyOf(value = '') {
  const base = words(value).filter(word => !STOP_WORDS.has(word)).join(' ');
  return ALIASES.get(base) || base;
}
function titleCase(value = '') {
  return String(value).replace(/\b\p{L}/gu, letter => letter.toLocaleUpperCase());
}
function uniqueBy(list = [], keyFn = item => item.title) {
  const seen = new Set(); const out = [];
  for (const item of list) { const key = keyFn(item); if (!key || seen.has(key)) continue; seen.add(key); out.push(item); }
  return out;
}
function clamp(value, min = 0, max = 100) { return Math.max(min, Math.min(max, value)); }
function containsTerm(haystack = '', term = '') {
  const needle = keyOf(term);
  if (!needle) return false;
  return keyOf(haystack).includes(needle);
}
function yearOf(item = {}) {
  const raw = String(item.publishedDate || item.metadata?.publishedDate || '').trim();
  const match = raw.match(/(1[5-9]\d{2}|20\d{2})/);
  if (match) return Number(match[1]);
  const fromText = String(item.snippet || '').match(/\b(1[5-9]\d{2}|20\d{2})\b/);
  return fromText ? Number(fromText[1]) : null;
}
function popularityOf(item = {}) {
  const citations = Number(item.metadata?.citedByCount || 0);
  const downloads = Number(item.metadata?.downloads || 0);
  return Math.max(citations, downloads);
}
const PERSON_TITLE = /^\p{Lu}[\p{L}'’.-]+(?:\s+(?:\p{Lu}\.?|[\p{Lu}][\p{L}'’.-]+)){1,4}$/u;
const PERSON_ROLE = /\b(?:writer|authors?|novelist|poet|playwright|historian|philosopher|scholar|theologian|journalist|essayist|editor|critic|biographer|dramatist|translator|professor)\b/i;
const NOT_A_PERSON = /\b(?:publishing|publisher|library|press|award|prize|list of|bookshop|bookseller|society|association|university|college|company|museum|canon|series|collection|club|review|festival|fair|history of|types?|genres?)\b/i;

/**
 * Decides whether a search result is plausibly a person — a writer to file under a
 * kind. It accepts initials ("Bart D. Ehrman") and role wording, and rejects
 * organisations, concepts and anything that is really the subject itself.
 */
function looksLikePerson(item = {}, intent = {}) {
  const title = String(item.title || '').trim();
  if (!title || title.length > 70) return false;
  if (NOT_A_PERSON.test(title)) return false;
  if (containsTerm(title, intent.main) || containsTerm(title, intent.facet)) return false;
  if (PERSON_ROLE.test(title)) return false;               // "Book collecting" style role words belong to orgs
  const text = `${title} ${item.snippet || ''}`;
  if (PERSON_ROLE.test(item.snippet || '')) return true;  // extract says what they do
  return PERSON_TITLE.test(title);
}
function surname(name = '') { const parts = String(name).trim().split(/\s+/).filter(Boolean); return parts.length ? parts[parts.length - 1] : ''; }

/**
 * A work only belongs under a writer if it actually shows that link: the writer's
 * name appears in the title, the extract or the source's author field. An unattributed
 * page is not evidence of authorship, and the subject itself is never its own work.
 */
export function validateWork(item = {}, { writerTitle = '', typeTitle = '', intent = {} } = {}) {
  const key = keyOf(item.title);
  if (!key) return false;
  if (key === keyOf(intent.main) || key === keyOf(typeTitle)) return false;      // the subject or the kind itself
  if (/^(?:list of|index of|outline of)\b/.test(String(item.title).toLowerCase())) return false;
  if (!writerTitle) return true;
  const family = keyOf(surname(writerTitle));
  return containsTerm(item.title, writerTitle) || containsTerm(item.title, family)
    || containsTerm(item.snippet || '', family) || containsTerm(item.author || '', family);
}
// A member of an aspect has to actually be about that aspect. Popularity and freshness
// are only tie-breakers, so an unrelated-but-popular page can never buy its way in.
function mentionsAspect(item = {}, aspectTitle = '') {
  const needle = keyOf(aspectTitle);
  if (!needle) return false;
  const stem = needle.replace(/s$/, '');
  const haystack = keyOf(`${item.title || ''} ${item.snippet || item.body || ''}`);
  return haystack.includes(needle) || (stem.length > 3 && haystack.includes(stem));
}

// Some indexes echo the query back in the title. A card must name a thing, not a search.
function looksLikeQueryEcho(title = '') {
  const value = String(title);
  return /mediatype|\bAND\b|\bOR\b|\(query\)|^\s*search\b/i.test(value) || value.length > 120;
}

function isNoiseLabel(label = '') {
  const clean = String(label).trim().toLocaleLowerCase().replace(/\s+/g, ' ');
  if (!clean || clean.length > 60) return true;
  if (NOISE_SECTIONS.has(clean)) return true;
  if (GENERIC_WORDS.has(clean)) return true;
  if (/^list of\b|^index of\b|^outline of\b/.test(clean)) return true;
  if (/\d{4}$/.test(clean)) return true;          // "By the 19th century"
  return false;
}

/* ---------------------------------------------------------------- 1. intent */

/**
 * Splits the typed text into a main item and an optional narrowing facet.
 * "book religion" → main "book", facet "religion". A single word has no facet.
 * Extra words beyond two are treated as further narrowings, joined in order.
 */
export function parseIntent(query = '') {
  const original = String(query || '').trim().replace(/\s+/g, ' ');
  const parts = original.split(' ').filter(part => part && !STOP_WORDS.has(part.toLocaleLowerCase()));
  if (!parts.length) return { original, main: '', facet: '', words: [] };
  const main = parts[0];
  const facet = parts.slice(1).join(' ');
  return { original, main, facet, words: parts };
}

/* ----------------------------------------------------------- 2. relevance */

/**
 * The scoring rule. Relevance to the main item is the only thing that can put a card
 * in the map; facet match and reference quality refine it; popularity and freshness
 * are the last tie-breakers.
 */
export function scoreCandidate(item = {}, intent = {}, config = DEFAULT_ENGINE_CONFIG) {
  const title = item.title || '';
  const body = `${item.snippet || ''} ${item.extractedText || ''}`.slice(0, 4000);
  let score = 0;
  const why = [];

  if (containsTerm(title, intent.main)) { score += config.W_TITLE; why.push('names the main item'); }
  else if (containsTerm(body, intent.main)) { score += config.W_BODY; why.push('describes the main item'); }

  if (intent.facet) {
    if (containsTerm(title, intent.facet)) { score += config.W_FACET_TITLE; why.push('matches the second word'); }
    else if (containsTerm(body, intent.facet)) { score += config.W_FACET_BODY; why.push('mentions the second word'); }
  }

  score += config.W_REFERENCE * ((PROVIDER_RANK[item.provider] || 0) / 3);
  if (PROVIDER_RANK[item.provider]) why.push(`${item.provider} reference`);

  // Tie-breakers, scaled so they can never exceed the weight of a real match.
  const popularity = popularityOf(item);
  if (popularity) { const bonus = Math.min(1, Math.log10(popularity + 1) / 4); score += config.W_POPULARITY * bonus; why.push(`${popularity} citations/downloads`); }
  const year = yearOf(item);
  if (year) { const age = Math.max(0, new Date().getFullYear() - year); const freshness = Math.max(0, 1 - age / 60); score += config.W_FRESHNESS * freshness; if (freshness > .6) why.push(`published ${year}`); }

  if (words(title).every(word => GENERIC_WORDS.has(word) || STOP_WORDS.has(word))) { score -= config.GENERIC_PENALTY; why.push('generic wording'); }
  if (words(title).length > 16) { score -= 6; why.push('long, unfocused title'); }

  return { score: Math.round(clamp(score)), why };
}

function rank(items = [], intent = {}, config = DEFAULT_ENGINE_CONFIG) {
  return items.map(item => ({ item, ...scoreCandidate(item, intent, config) }))
    .sort((left, right) => right.score - left.score || (left.item.title || '').localeCompare(right.item.title || ''));
}

/* -------------------------------------------------------------- 3. layers */

/**
 * Recognises a *kind of* thing from a label. Returns a score for how strongly the
 * label reads as a type, so "Novel" and "Poetry" outrank "History".
 */
export function typeScore(label = '', context = {}) {
  const text = String(label).trim();
  const clean = text.toLocaleLowerCase().trim();
  if (ASPECT_NOISE.has(clean) || isNoiseLabel(text)) return { score: -99, why: ['navigation or generic wording'] };
  let score = 0; const why = [];
  if (ASPECT_SIGNAL.test(text)) { score += 5; why.push('names an aspect of the subject'); }
  if (TYPE_SIGNALS.test(text)) { score += 3; why.push('a recognisable category'); }
  // A heading that merely lists kinds ("Types of books") is expanded into the kinds it
  // names rather than becoming a card of its own.
  if (LIST_HEADING.test(text)) return { score: -50, why: ['a heading that lists kinds, not a kind'] };
  if (/\p{L}ies$/u.test(text) || (/\p{L}s$/u.test(text) && !/(?:ss|us|is)$/i.test(text))) { score += 2; why.push('plural category'); }
  // An aspect earns its place by owning members: sub-headings or named entries.
  const members = (context.subheadings?.length || 0) + (context.members?.length || 0);
  if (members >= 2) { score += 6; why.push(`${members} named entries inside it`); }
  else if (members === 1) { score += 2; why.push('one named entry inside it'); }
  if (context.position !== undefined && context.position < 6) { score += 2; why.push('early in the source outline'); }
  if (context.appearances > 1) { score += Math.min(3, context.appearances); why.push(`appears in ${context.appearances} sources`); }
  if (context.facetMatch) { score += 4; why.push('matches the second word'); }
  if (words(text).length > 5) score -= 3;
  return { score, why };
}

/**
 * Runs the whole procedure. `discover` is injected (lib/freeSourceSearch) so this
 * module stays testable without network access.
 */
export async function runSearch({ query, config = DEFAULT_ENGINE_CONFIG, discover, readArticle = null }) {
  const intent = parseIntent(query);
  const steps = [];
  const notes = [];
  // Track whether any index actually answered. "Nothing was found" and "nothing could be
  // asked" are different outcomes and the caller must be able to tell them apart.
  const providers = new Map();
  const tracked = async (q, type, options) => {
    const result = await discover(q, type, options);
    for (const provider of result.providers || []) providers.set(provider.provider, provider.status === 'ok' ? 'ok' : (providers.get(provider.provider) || provider.status));
    return result;
  };
  const wideFacet = intent.facet && intent.facet.split(' ').length > 1;

  // —— Pass 0: what is this thing? The structured description first, prose second.
  const reference = await tracked(`${intent.main}${intent.facet ? ` ${intent.facet}` : ''}`, 'reference', { focus: intent.main });
  const subjectRanked = rank(reference.results || [], { ...intent, facet: '' }, config);
  const subjectPage = subjectRanked.find(entry => entry.item.provider === 'Wikipedia' && entry.item.kind === 'article')?.item
    || subjectRanked.find(entry => entry.item.kind === 'article')?.item || null;
  const dictionaryEntry = subjectRanked.find(entry => entry.item.kind === 'dictionary')?.item || null;
  steps.push({ step: 'identify the main item', found: subjectPage ? subjectPage.title : dictionaryEntry ? dictionaryEntry.title : 'nothing', why: subjectRanked[0]?.why || [] });

  const subjectTitle = intent.facet && subjectPage ? subjectPage.title : titleCase(intent.main);
  const description = (subjectPage?.snippet || dictionaryEntry?.snippet || '').split(/(?<=\.)\s/).slice(0, 2).join(' ');
  const subjectImage = subjectPage?.thumbnail || reference.results?.find(item => item.kind === 'image')?.thumbnail || '';

  // —— Pass 1: the aspects of the main item (its names, character, worship, churches…).
  const article = subjectPage && readArticle ? await readArticle(subjectPage.title).catch(() => null) : null;
  const details = article?.sectionDetails || [];
  const sectionText = new Map(details.map(section => [section.title, section.text]));
  const flatSections = (article?.sections || []).map(section => section.title);
  const linkLabels = (article?.links || []).filter(label => !isNoiseLabel(label));
  steps.push({ step: 'read the structure of the main item', sections: details.length, links: linkLabels.length });

  // A facet search proposes aspects directly: "religion book" should surface "Religious text".
  let facetTypes = [];
  if (intent.facet) {
    const constrained = await tracked(`${intent.facet} ${intent.main}`, 'wikipedia', { focus: intent.main });
    facetTypes = (constrained.results || [])
      .filter(item => containsTerm(item.title, intent.facet) && containsTerm(item.title, intent.main))
      .map(item => (ASPECT_SIGNAL.test(item.title) || TYPE_SIGNALS.test(item.title) ? item.title : null))
      .filter(Boolean)
      .slice(0, 3);
    steps.push({ step: 'narrow by the second word', proposed: facetTypes });
  }

  // —— Pass 1 continued: each aspect carries the members named inside it.
  const aspectCandidates = new Map();
  const addAspect = (label, source, extra = {}) => {
    const clean = String(label || '').replace(/\s*\(.*?\)\s*$/, '').trim();
    if (!clean) return;
    const key = keyOf(clean);
    const existing = aspectCandidates.get(key);
    if (existing) {
      existing.appearances += 1;
      existing.sources.add(source);
      existing.members.push(...(extra.members || []));
      existing.subheadings.push(...(extra.subheadings || []));
      if (extra.facetMatch) existing.facetMatch = true;
      return;
    }
    aspectCandidates.set(key, { label: clean, appearances: 1, sources: new Set([source]), members: [...(extra.members || [])], subheadings: [...(extra.subheadings || [])], facetMatch: Boolean(extra.facetMatch) });
  };
  facetTypes.forEach(label => addAspect(label, 'facet search', { facetMatch: true }));

  // Top-level headings become aspects. A list heading is expanded into the kinds it names;
  // a substantive heading keeps its own sub-headings and article links as its members.
  details.filter(section => section.level <= 2).forEach((section, position) => {
    const label = section.title;
    if (ASPECT_NOISE.has(label.toLocaleLowerCase()) || isNoiseLabel(label)) return;
    if (LIST_HEADING.test(label)) {
      for (const named of expandListHeading(label, sectionText.get(label) || '', flatSections, linkLabels, intent)) {
        addAspect(named, `“${label}” heading`);
      }
      return;
    }
    addAspect(label, 'article outline', { subheadings: section.subheadings || [], members: section.links || [], position });
  });
  // Links with a facet shape can also be aspects when the outline is thin.
  linkLabels.filter(label => ASPECT_SIGNAL.test(label)).forEach(label => addAspect(label, 'article links'));

  const alignedToFacet = candidate => !intent.facet
    || candidate.facetMatch
    || containsTerm(candidate.label, intent.facet)
    || containsTerm(sectionText.get(candidate.label) || '', intent.facet);
  const rankedAspects = [...aspectCandidates.values()]
    .map(candidate => ({ ...candidate, ...typeScore(candidate.label, {
      members: [...new Set([...candidate.members, ...candidate.subheadings])],
      subheadings: candidate.subheadings,
      position: candidate.position,
      appearances: candidate.appearances,
      facetMatch: candidate.facetMatch
    }) }))
    .filter(candidate => candidate.score >= config.MIN_TYPE_SCORE)
    .map(candidate => ({ ...candidate, aligned: alignedToFacet(candidate) }))
    .sort((left, right) => (right.aligned - left.aligned) || (right.score - left.score) || left.label.localeCompare(right.label))
    .filter((candidate, index, all) => intent.facet ? (candidate.aligned || !all.some(other => other.aligned)) : true)
    .slice(0, config.MAX_TYPES);
  steps.push({ step: 'choose the aspects worth showing', chosen: rankedAspects.map(aspect => aspect.label) });

  if (!rankedAspects.length) notes.push(`No reliable aspects of ${intent.main} were found. Nothing was invented to fill the layer.`);
  if (wideFacet) notes.push('The second word was broad, so the aspects above are the strongest matches rather than an exhaustive list.');

  const aspects = rankedAspects.map((candidate, index) => {
    const label = candidate.label;
    const ownText = sectionText.get(label) || '';
    const explanation = ownText || `${label} — an aspect of ${intent.main}${intent.facet ? ` within ${intent.facet}` : ''}.`;
    const members = [...new Set([...candidate.subheadings, ...candidate.members])]
      .filter(member => !isNoiseLabel(member)
        && keyOf(member) !== keyOf(label)
        && keyOf(member) !== keyOf(intent.main)
        && keyOf(member) !== keyOf(subjectTitle))
      .slice(0, config.MAX_MEMBERS_PER_ASPECT);
    return {
      id: `aspect-${index}`, title: label, score: candidate.score, why: candidate.why,
      explanation: explanation.split(/(?<=\.)\s/).slice(0, 2).join(' ').slice(0, 600),
      sources: [...candidate.sources],
      members: members.map(member => ({
        title: member,
        body: `${member} — named inside “${label}”, an aspect of ${intent.main}.`,
        kind: 'member'
      }))
    };
  });

  // —— Pass 2: give each aspect real evidence from the public indexes.
  for (const aspect of aspects) {
    const found = await tracked(`${aspect.title} ${intent.main}`, 'web', { focus: intent.main });
    const evidence = rank(found.results || [], { ...intent, facet: aspect.title }, config)
      .filter(entry => entry.score >= config.MIN_MEMBER_SCORE && mentionsAspect(entry.item, aspect.title) && !looksLikeQueryEcho(entry.item.title))
      .slice(0, 3)
      .map(entry => ({
        title: entry.item.title, body: entry.item.snippet || '', url: entry.item.url,
        provider: entry.item.provider, thumbnail: entry.item.thumbnail || '', kind: 'evidence', score: entry.score, why: entry.why
      }));
    // Evidence that repeats a member we already have adds nothing to the picture.
    const known = new Set(aspect.members.map(member => keyOf(member.title)));
    const forbidden = new Set([keyOf(intent.main), keyOf(aspect.title), keyOf(subjectTitle)]);
    for (const item of evidence) {
      const key = keyOf(item.title);
      if (forbidden.has(key) || known.has(key)) continue;
      known.add(key);
      aspect.members.push(item);
    }
    aspect.members = aspect.members.slice(0, config.MAX_MEMBERS_PER_ASPECT);
    steps.push({ step: `collect entries inside “${aspect.title}”`, found: aspect.members.map(member => member.title) });
  }

  return {
    intent,
    main: { title: subjectTitle, body: description || `Main topic: ${intent.main}.`, image: subjectImage, url: subjectPage?.url || dictionaryEntry?.url || '', provider: subjectPage?.provider || dictionaryEntry?.provider || '' },
    aspects,
    subjectSources: reference.results || [],
    steps,
    notes,
    config,
    providers: [...providers.entries()].map(([name, status]) => ({ name, status })),
    connectivity: providers.size === 0 ? 'offline' : [...providers.values()].every(status => status !== 'ok') ? 'offline' : [...providers.values()].some(status => status !== 'ok') ? 'partial' : 'online'
  };
}

/** The list-naming words of a heading, used to expand it into real entries. */
function expandListHeading(heading, body = '', sections = [], links = [], intent = {}) {
  const vocabulary = [...new Set([...sections, ...links].filter(label => !isNoiseLabel(label)).map(label => label.toLocaleLowerCase()))];
  const found = [];
  for (const word of (body.match(/\p{L}[\p{L}-]{2,}/gu) || []).map(word => word.toLocaleLowerCase())) {
    if (STOP_WORDS.has(word) || GENERIC_WORDS.has(word) || word === keyOf(intent.main)) continue;
    if (vocabulary.includes(word) && !found.includes(titleCase(word))) found.push(titleCase(word));
  }
  return found.slice(0, 6);
}

/**
 * Open one aspect: the members named inside it.
 * This is the only place the map grows after the first search, so it stays
 * deliberately small: the aspect's own outline first, public-index evidence second.
 */
export async function expandAspect({ aspectTitle, mainTerm, config = DEFAULT_ENGINE_CONFIG, discover, readArticle = null }) {
  const intent = parseIntent(`${mainTerm} ${aspectTitle}`);
  const steps = [];
  const notes = [];
  const forbidden = new Set([keyOf(aspectTitle), keyOf(mainTerm)]);
  const members = [];
  const seen = new Set();
  const push = member => {
    const key = keyOf(member.title);
    if (!key || forbidden.has(key) || seen.has(key)) return;
    seen.add(key);
    members.push(member);
  };

  // The aspect usually has a page of its own, and that page names its parts.
  const article = readArticle ? await readArticle(aspectTitle).catch(() => null) : null;
  const details = article?.sectionDetails || [];
  for (const section of details) {
    for (const label of section.subheadings || []) {
      if (isNoiseLabel(label)) continue;
      push({ title: label, body: `${label} — named under “${section.title}”.`, kind: 'member' });
    }
  }
  if (!details.length) {
    for (const label of (article?.sections || []).map(section => section.title)) {
      if (!isNoiseLabel(label)) push({ title: label, body: `${label} — a part of ${aspectTitle}.`, kind: 'member' });
    }
  }
  steps.push({ step: `read the structure of “${aspectTitle}”`, found: members.map(member => member.title) });

  // Then real evidence, judged against the aspect and the main item together.
  const found = await discover(`${aspectTitle} ${mainTerm}`, 'web', { focus: mainTerm });
  const evidence = rank(found.results || [], { ...intent, facet: aspectTitle }, config)
    .filter(entry => entry.score >= config.MIN_MEMBER_SCORE && mentionsAspect(entry.item, aspectTitle) && !looksLikeQueryEcho(entry.item.title))
    .slice(0, 3)
    .map(entry => ({
      title: entry.item.title, body: entry.item.snippet || '', url: entry.item.url,
      provider: entry.item.provider, thumbnail: entry.item.thumbnail || '', kind: 'evidence', score: entry.score, why: entry.why
    }));
  evidence.forEach(push);
  if (!evidence.length) notes.push(`The public indexes added no further entries for “${aspectTitle}”.`);

  const capped = members.slice(0, config.MAX_MEMBERS_PER_ASPECT);
  steps.push({ step: `list what “${aspectTitle}” contains`, found: capped.map(member => member.title) });
  return { intent, aspectTitle, members: capped, steps, notes, config };
}

/* ------------------------------------------------- reused by the expand route */

/** Writers for one category, using the same person test and relevance gate as before. */
export function rankWriters(items = [], intent = {}, typeTitle = '', config = DEFAULT_ENGINE_CONFIG) {
  const people = (items || []).filter(item => item.kind !== 'image' && looksLikePerson(item, intent));
  return rank(people, { ...intent, facet: typeTitle }, config)
    .filter(candidate => {
      const linked = containsTerm(candidate.item.snippet || '', typeTitle) || containsTerm(candidate.item.snippet || '', intent.main) || containsTerm(candidate.item.title, typeTitle);
      return candidate.score >= (linked ? config.MIN_WRITER_SCORE : config.MIN_WRITER_SCORE + 4);
    })
    .slice(0, config.MAX_WRITERS_PER_TYPE)
    .map(candidate => ({ title: candidate.item.title, score: candidate.score, why: candidate.why, body: candidate.item.snippet || '', url: candidate.item.url, provider: candidate.item.provider, thumbnail: candidate.item.thumbnail || '' }));
}

/** Works for one kind, optionally restricted to a named writer. */
export function rankWorks(items = [], intent = {}, typeTitle = '', writerTitle = '', config = DEFAULT_ENGINE_CONFIG) {
  return rank((items || []).filter(item => item.kind !== 'image' && validateWork(item, { writerTitle, typeTitle, intent })), { ...intent, facet: typeTitle }, config)
    .filter(candidate => candidate.score >= config.MIN_WORK_SCORE)
    .slice(0, config.MAX_WORKS_PER_WRITER)
    .map(candidate => ({ title: candidate.item.title, score: candidate.score, why: candidate.why, body: candidate.item.snippet || '', url: candidate.item.url, provider: candidate.item.provider, thumbnail: candidate.item.thumbnail || '', publishedDate: candidate.item.publishedDate || '' }));
}
