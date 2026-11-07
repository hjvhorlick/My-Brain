import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import db, { uid, now, hydrateNode, hydrateSource, parseJson } from './lib/db.js';
import { collectSource, inferSourceType, assessReliability } from './lib/sourceCollector.js';
import { discoverFreeSources } from './lib/freeSourceSearch.js';
import { analyseTopic, researchConfig, rankSources, extractSourceClaims, detectPotentialConflicts, findKnowledgeGaps, shouldRunTargetedCycle, planTargetedQueries, researchSummary } from './lib/researchEngine.js';
import { dictionaryLookup, wikipediaArticle, wikipediaSummary, resolvePlayback, readWebPage } from './lib/reference.js';
import { runSearch, parseIntent, engineConfig } from './lib/searchEngine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 4173);
const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

app.use(express.json({ limit: '2mb' }));
// The live workspace preview must always receive the current client after an interface update.
// Keeping HTML, JS and CSS out of the browser cache prevents an old app.js from being paired
// with newer markup (which would leave buttons without their current event handlers).
app.use((req, res, next) => {
  if (req.path === '/' || /\.(?:html|js|css)$/i.test(req.path)) res.setHeader('Cache-Control', 'no-store, max-age=0, must-revalidate');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => cb(null, `${Date.now()}-${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`)
});
const upload = multer({ storage, limits: { fileSize: 35 * 1024 * 1024, files: 10 } });

const RELATIONSHIPS = new Set(['related_to', 'caused', 'influenced', 'supports', 'contradicts', 'created', 'participated_in', 'occurred_during', 'located_in', 'evidence_for', 'evidence_against', 'depends_on', 'similar_to', 'part_of', 'documents']);
const TYPES = new Set(['idea', 'website', 'image', 'document', 'video', 'person', 'event', 'question', 'evidence', 'task', 'source', 'concept', 'place']);
const PRIORITIES = new Set(['critical', 'high', 'medium', 'low', 'informational', 'research_required', 'unclassified']);
const CONFIDENCES = new Set(['high', 'medium', 'low', 'unverified']);

function safe(value, set, fallback) { return set.has(value) ? value : fallback; }
function badRequest(message) { const error = new Error(message); error.status = 400; return error; }
function publicHttpUrl(value) {
  let parsed;
  try { parsed = new URL(String(value || '').trim()); } catch { throw badRequest('Choose a valid public http(s) source URL.'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw badRequest('Choose a public http(s) source URL.');
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const privateV4 = /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
  if (!host || host === 'localhost' || host.endsWith('.local') || host === '::1' || privateV4) throw badRequest('Only publicly reachable web sources can be collected.');
  return parsed;
}
function getProject(id) { return db.prepare('SELECT * FROM projects WHERE id = ?').get(id); }
function ensureProject(id) { const project = getProject(id); if (!project) throw Object.assign(new Error('Project not found.'), { status: 404 }); return project; }
function getNode(id) { return db.prepare('SELECT * FROM nodes WHERE id = ?').get(id); }
const typingSuggestionCache = new Map();
function normalisedWords(value = '') { return String(value).toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' '); }
function canonicalBasicTopic(value = '') {
  let output=normalisedWords(value).replace(/\bcomic books?\b/g,'comic');
  output=output.split(' ').map(word=>word.endsWith('ies')?`${word.slice(0,-3)}y`:word.endsWith('s')&&!word.endsWith('ss')?word.slice(0,-1):word).join(' ');
  return output.replace(/\s+/g,' ').trim();
}
function wordDistance(left = '', right = '') {
  const a=normalisedWords(left), b=normalisedWords(right); if(a===b) return 0;
  const row=Array.from({ length:b.length+1 },(_,index)=>index);
  for(let i=1;i<=a.length;i++){let diagonal=row[0];row[0]=i;for(let j=1;j<=b.length;j++){const previous=row[j];row[j]=Math.min(row[j]+1,row[j-1]+1,diagonal+(a[i-1]===b[j-1]?0:1));diagonal=previous;}}
  return row[b.length];
}
async function typingSuggestions(query) {
  const key=normalisedWords(query); const cached=typingSuggestionCache.get(key); if(cached&&Date.now()-cached.at<300000)return cached.value;
  const endpoint=`https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(query)}&limit=6&namespace=0&format=json`;
  let response;
  try { response=await fetch(endpoint,{signal:AbortSignal.timeout(5000),headers:{'User-Agent':'TheBrainResearch/0.1 (typing assistance)'}}); }
  catch(error){
    const failure=new Error('Wikipedia could not be reached from this server, so typing suggestions are unavailable. Searching still works when a source index is reachable.');
    failure.status=502; failure.cause=error; throw failure;
  }
  if(!response.ok){const failure=new Error(`Wikipedia suggestions returned HTTP ${response.status}.`);failure.status=502;throw failure;}
  const data=await response.json(); const suggestions=(data[1]||[]).map((title,index)=>({title:String(title),url:String(data[3]?.[index]||`https://en.wikipedia.org/wiki/${encodeURIComponent(String(title).replaceAll(' ','_'))}`)})).filter(item=>item.title&&item.url).slice(0,6);
  const queryWords=key.split(' ').filter(Boolean); const correction=suggestions.find(item=>{const candidate=normalisedWords(item.title);const candidateWords=candidate.split(' ').filter(Boolean);const distance=wordDistance(key,candidate);return queryWords.length===candidateWords.length&&candidate!==key&&distance>0&&distance/Math.max(key.length,candidate.length)<=.28;}) || null;
  const value={query,suggestions,correction:correction?{title:correction.title,url:correction.url}:null,provider:'Wikipedia OpenSearch'}; typingSuggestionCache.set(key,{at:Date.now(),value}); if(typingSuggestionCache.size>250)typingSuggestionCache.delete(typingSuggestionCache.keys().next().value); return value;
}
function firstProject() { return db.prepare('SELECT * FROM projects ORDER BY created_at LIMIT 1').get(); }
function seedProject() {
  let project = firstProject();
  if (!project) {
    const timestamp = now();
    project = { id: uid('project'), name: 'My Research Brain', description: 'A private, source-aware research workspace.', created_at: timestamp, updated_at: timestamp };
    db.prepare('INSERT INTO projects (id,name,description,created_at,updated_at) VALUES (@id,@name,@description,@created_at,@updated_at)').run(project);
  }
  return project;
}
seedProject();

function collapseDuplicateBasicTopics(projectId) {
  const nodes=db.prepare('SELECT * FROM nodes WHERE project_id=? ORDER BY created_at').all(projectId).map(hydrateNode);
  const groups=new Map();
  for (const node of nodes) {
    if(node.metadata?.role!=='neural-basic-topic')continue;
    const parent=node.metadata?.neuralRootId || ''; const label=canonicalBasicTopic(node.metadata?.topicLabel || node.title);
    // A term can correctly appear in two separately chosen focus webs. Only merge a
    // duplicate when it is a repeated sibling under the same focused parent.
    if(!parent || !label)continue; const key=`${parent}::${label}`; const list=groups.get(key)||[];list.push(node);groups.set(key,list);
  }
  let removed=0;
  for (const duplicates of groups.values()) {
    if(duplicates.length<2)continue; const [canonical,...extras]=duplicates;
    for(const duplicate of extras){
      const attached=db.prepare('SELECT source_id FROM source_nodes WHERE node_id=?').all(duplicate.id);
      const children=nodes.filter(node=>node.metadata?.neuralTopicId===duplicate.id&&['neural-basic-evidence','neural-basic-source'].includes(node.metadata?.role));
      for(const child of children){
        for(const item of db.prepare('SELECT source_id FROM source_nodes WHERE node_id=?').all(child.id))attachSource(item.source_id,canonical.id,'supports','Source retained while duplicate topic card was merged.');
        db.prepare('DELETE FROM nodes WHERE id=?').run(child.id);
      }
      for(const item of attached)attachSource(item.source_id,canonical.id,'supports','Source retained while duplicate topic card was merged.');
      db.prepare('DELETE FROM nodes WHERE id=?').run(duplicate.id); removed++;
    }
  }
  return removed;
}
function clearFocusedAutomaticExpansion(projectId, root) {
  const all=db.prepare('SELECT * FROM nodes WHERE project_id=?').all(projectId).map(hydrateNode);
  const parents=new Set([root.id]), remove=new Set(); let changed=true;
  while(changed){
    changed=false;
    for(const node of all){
      const role=node.metadata?.role;
      if(remove.has(node.id)||!parents.has(node.metadata?.neuralRootId)||!['neural-basic-topic','neural-basic-evidence','neural-basic-source'].includes(role))continue;
      remove.add(node.id); changed=true;
      if(role==='neural-basic-topic')parents.add(node.id);
    }
  }
  for(const node of all)if(remove.has(node.id))db.prepare('DELETE FROM nodes WHERE id=?').run(node.id);
  return remove.size;
}
function removeLegacySourceResultBranches(projectId, root) {
  // Earlier builds rendered a card for every search hit. Once a broad topic has a
  // verified source-derived basic layer, those article-result cards are misleading
  // clutter rather than saved topic knowledge. Their source records remain retained.
  const legacyRoles=new Set(['neural-keyword','neural-evidence','neural-source']);
  const all=db.prepare('SELECT * FROM nodes WHERE project_id=?').all(projectId).map(hydrateNode);
  const legacy=all.filter(node=>legacyRoles.has(node.metadata?.role));
  const roots=new Set([root.id]), remove=new Set(); let changed=true;
  // Clicking an old article card could create another old article-result tree. Walk
  // through every such descendant before deleting so an obsolete branch cannot leave
  // disconnected "weird article" cards behind.
  while(changed){
    changed=false;
    for(const node of legacy){
      if(remove.has(node.id)||!roots.has(node.metadata?.neuralRootId))continue;
      remove.add(node.id); changed=true;
      if(node.metadata?.role==='neural-keyword')roots.add(node.id);
    }
  }
  // A previous partial cleanup may already have removed a parent. An orphaned legacy
  // result has no meaningful place in a focused web, so clear those remnants too.
  const remainingIds=new Set(all.map(node=>node.id));
  for(const node of legacy)if(!remove.has(node.id)&&!remainingIds.has(node.metadata?.neuralRootId))remove.add(node.id);
  // And include any old result trees rooted at those newly identified orphan cards.
  let cascading=true;
  while(cascading){
    cascading=false;
    for(const node of legacy){
      if(remove.has(node.id)){if(node.metadata?.role==='neural-keyword')roots.add(node.id);continue;}
      if(roots.has(node.metadata?.neuralRootId)){remove.add(node.id);cascading=true;}
    }
  }
  for(const node of legacy)if(remove.has(node.id))db.prepare('DELETE FROM nodes WHERE id=?').run(node.id);
  return remove.size;
}
function mapGraph(projectId) {
  const project = ensureProject(projectId);
  collapseDuplicateBasicTopics(projectId);
  const nodes = db.prepare('SELECT * FROM nodes WHERE project_id = ? ORDER BY created_at').all(projectId).map(hydrateNode);
  const connections = db.prepare('SELECT * FROM connections WHERE project_id = ? ORDER BY created_at').all(projectId);
  const sources = db.prepare('SELECT * FROM sources WHERE project_id = ? ORDER BY created_at DESC').all(projectId).map(hydrateSource);
  const queue = db.prepare("SELECT * FROM research_queue WHERE project_id = ? AND status = 'open' ORDER BY CASE priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END, created_at DESC").all(projectId);
  const claimCount=db.prepare('SELECT COUNT(*) AS count FROM claims WHERE project_id=?').get(projectId).count;
  return { project, nodes, connections, sourceCount: sources.length, claimCount, sources, queue };
}

function insertNode(data) {
  const timestamp = now();
  const node = {
    id: data.id || uid('node'), project_id: data.project_id,
    type: safe(data.type, TYPES, 'idea'), title: String(data.title || 'Untitled').slice(0, 220), body: String(data.body || '').slice(0, 12000),
    priority: safe(data.priority, PRIORITIES, 'unclassified'), confidence: safe(data.confidence, CONFIDENCES, 'unverified'),
    origin: data.origin || 'user', status: data.status || 'accepted', x: Number.isFinite(data.x) ? data.x : null, y: Number.isFinite(data.y) ? data.y : null,
    metadata: JSON.stringify(data.metadata || {}), created_at: timestamp, updated_at: timestamp
  };
  db.prepare(`INSERT INTO nodes (id,project_id,type,title,body,priority,confidence,origin,status,x,y,metadata,created_at,updated_at)
    VALUES (@id,@project_id,@type,@title,@body,@priority,@confidence,@origin,@status,@x,@y,@metadata,@created_at,@updated_at)`).run(node);
  return hydrateNode(db.prepare('SELECT * FROM nodes WHERE id = ?').get(node.id));
}

function insertConnection(data) {
  if (!data.from_node_id || !data.to_node_id || data.from_node_id === data.to_node_id) return null;
  const relationship = safe(data.relationship, RELATIONSHIPS, 'related_to');
  const existing = db.prepare('SELECT * FROM connections WHERE project_id = ? AND from_node_id = ? AND to_node_id = ? AND relationship = ?').get(data.project_id, data.from_node_id, data.to_node_id, relationship);
  if (existing) return existing;
  const item = { id: uid('edge'), project_id: data.project_id, from_node_id: data.from_node_id, to_node_id: data.to_node_id, relationship, confidence: safe(data.confidence, CONFIDENCES, 'unverified'), notes: String(data.notes || '').slice(0, 3000), created_at: now() };
  db.prepare('INSERT INTO connections (id,project_id,from_node_id,to_node_id,relationship,confidence,notes,created_at) VALUES (@id,@project_id,@from_node_id,@to_node_id,@relationship,@confidence,@notes,@created_at)').run(item);
  return item;
}

function persistSource(projectId, input) {
  const base = {
    title: input.title || input.url, url: input.url, website: input.website || (() => { try { return new URL(input.url).hostname; } catch { return ''; } })(),
    author: input.author || '', published_date: input.published_date || '', source_type: input.source_type || inferSourceType(input.url),
    reliability: input.reliability || assessReliability(input.url, input.source_type || inferSourceType(input.url)),
    extracted_text: input.extracted_text || '', relevant_passage: input.relevant_passage || '', collection_status: input.collection_status || 'metadata only', metadata: input.metadata || {}
  };
  const existing = db.prepare('SELECT id FROM sources WHERE project_id = ? AND url = ?').get(projectId, base.url);
  const timestamp = now();
  if (existing) {
    db.prepare(`UPDATE sources SET title=?, website=?, author=?, published_date=?, source_type=?, reliability=?, extracted_text=?, relevant_passage=?, collection_status=?, metadata=?, retrieved_at=?, updated_at=? WHERE id=?`)
      .run(base.title, base.website, base.author, base.published_date, base.source_type, base.reliability, base.extracted_text, base.relevant_passage, base.collection_status, JSON.stringify(base.metadata), timestamp, timestamp, existing.id);
    return hydrateSource(db.prepare('SELECT * FROM sources WHERE id = ?').get(existing.id));
  }
  const item = { id: uid('source'), project_id: projectId, ...base, retrieved_at: timestamp, metadata: JSON.stringify(base.metadata), created_at: timestamp, updated_at: timestamp };
  db.prepare(`INSERT INTO sources (id,project_id,title,website,url,author,published_date,retrieved_at,source_type,reliability,extracted_text,relevant_passage,collection_status,metadata,created_at,updated_at)
    VALUES (@id,@project_id,@title,@website,@url,@author,@published_date,@retrieved_at,@source_type,@reliability,@extracted_text,@relevant_passage,@collection_status,@metadata,@created_at,@updated_at)`).run(item);
  return hydrateSource(db.prepare('SELECT * FROM sources WHERE id = ?').get(item.id));
}

function attachSource(sourceId, nodeId, relationship = 'supports', notes = '') {
  db.prepare('INSERT OR IGNORE INTO source_nodes (source_id,node_id,relationship,notes) VALUES (?,?,?,?)').run(sourceId, nodeId, relationship, notes);
}

// Direct discovery creates an immediately visible, truthful map branch: a user-requested
// search topic linked to the source the user selected. It does not turn a source title or
// search snippet into an AI claim. AI-derived thoughts remain explicit proposals for review.
function ensureDiscoveryBranch(projectId, source, query, provider = '', targetNodeId = '') {
  const cleanQuery = String(query || '').trim().replace(/^direct URL import$/i, '').slice(0, 300);
  const existingNodes = db.prepare('SELECT * FROM nodes WHERE project_id=? ORDER BY created_at').all(projectId).map(hydrateNode);
  let root = String(targetNodeId || '') ? existingNodes.find(node => node.id === String(targetNodeId)) || null : null;
  if (!root && cleanQuery) {
    root = existingNodes.find(node => node.metadata?.role === 'discovery-root' && node.metadata?.query?.toLowerCase() === cleanQuery.toLowerCase());
    if (!root) {
      const rootIndex = existingNodes.filter(node => node.metadata?.role === 'discovery-root').length;
      const angle = rootIndex * 2.399963229728653;
      root = insertNode({
        project_id: projectId, type: 'concept', title: keywordLabel(cleanQuery),
        body: 'A user-requested source discovery topic. This is not an AI conclusion.',
        priority: 'research_required', confidence: 'unverified', origin: 'user',
        x: rootIndex ? Math.round(420 * Math.cos(angle)) : 0, y: rootIndex ? Math.round(260 * Math.sin(angle)) : 0,
        metadata: { role: 'discovery-root', generation: 0, query: cleanQuery, sourceDiscovery: true }
      });
    }
  }
  let sourceNode = existingNodes.find(node => node.metadata?.sourceId === source.id);
  if (!sourceNode) {
    const branchCount = root ? existingNodes.filter(node => node.metadata?.discoveryRootId === root.id).length : existingNodes.filter(node => node.metadata?.sourceId).length;
    const angle = branchCount * 2.399963229728653 - Math.PI / 2;
    const radius = root ? 340 : 260;
    sourceNode = insertNode({
      project_id: projectId, type: 'source', title: `${keywordLabel(source.title, source.website || 'Source')} source`,
      body: `${source.title}\n${provider || source.metadata?.discovery || 'Selected source'} · ${source.website || source.url}\n${source.url}`,
      priority: 'informational', confidence: 'unverified', origin: 'web',
      x: (Number(root?.x) || 0) + Math.round(radius * Math.cos(angle)), y: (Number(root?.y) || 0) + Math.round(radius * Math.sin(angle)),
      metadata: { sourceId: source.id, discoveryRootId: root?.id || null, sourceDiscovery: true, generation: root ? Math.min(3, Number(root.metadata?.generation || 0) + 1) : 0 }
    });
  }
  attachSource(source.id, sourceNode.id, 'documents', 'User selected this original source during discovery.');
  const connection = root ? insertConnection({ project_id: projectId, from_node_id: sourceNode.id, to_node_id: root.id, relationship: 'evidence_for', confidence: 'unverified', notes: 'Selected source for this investigation. Content has not yet been interpreted as a claim.' }) : null;
  return { rootNode: root, sourceNode, connection };
}

const KEYWORD_STOP_WORDS = new Set(['the','a','an','and','or','of','for','to','in','on','with','from','by','at','as','is','are','was','were','be','this','that','these','those','what','how','why','when','where','who','about','into','through','using','use','new','study','studies','analysis','report','article','paper','guide','overview','introduction']);
function keywordLabel(value, fallback = 'Research topic') {
  const words = String(value || '').replace(/https?:\/\/\S+/g, '').replace(/[^\p{L}\p{N}'’-]+/gu, ' ').trim().split(/\s+/)
    .filter(word => word.length > 1 && !KEYWORD_STOP_WORDS.has(word.toLowerCase()));
  return (words.slice(0, 4).join(' ') || fallback).slice(0, 80);
}
// These terms are used only to group labels that were actually found in live recipe
// catalogue pages. They do not invent recipes or source links; if a label is absent
// from the collected public pages, it cannot appear as a branch.
const RECIPE_VARIATION_TERMS = [
  ['Chocolate', /\bchocolate\b/i], ['Carrot', /\bcarrot\b/i], ['Vanilla', /\bvanilla\b/i], ['Sponge', /\bsponge\b/i],
  ['Lemon', /\blemon\b/i], ['Red velvet', /\bred\s+velvet\b/i], ['Strawberry', /\bstrawberry\b/i], ['Fruit', /\b(?:fruit|apple|blueberry|pumpkin)\b/i],
  ['Bundt', /\bbundt\b/i], ['Cheesecake', /\bcheesecake\b/i]
];
const RECIPE_QUERY_WORDS = new Set(['recipe','recipes','for','how','to','make','easy','best','simple','homemade','from','scratch','the','a','an','and','or','with']);
function isRecipeTopic(query = '') { return /\b(?:recipe|recipes|bake|baking|cake|cakes|dessert|desserts|cook|cooking)\b/i.test(query); }
function recipeFocusWords(query = '') {
  const words=String(query).toLowerCase().replace(/[^a-z0-9]+/g,' ').trim().split(/\s+/).filter(word=>word&&!RECIPE_QUERY_WORDS.has(word));
  return words.length ? words.join(' ') : 'cake';
}
function usableRecipeLinks(results = []) {
  const found=[]; const seen=new Set();
  for (const item of results) {
    if (!Array.isArray(item?.metadata?.relatedLinks)) continue;
    for (const link of item.metadata?.relatedLinks || []) {
      const title=String(link?.title || '').replace(/\s+/g,' ').trim(); const url=String(link?.url || '').trim();
      if (!title || !url || seen.has(url) || /^(?:skip to|close|menu|search|home|print|subscribe|privacy|terms)\b/i.test(title)) continue;
      if (!/\b(?:cake|cakes|chocolate|carrot|vanilla|sponge|dessert|frosting|ganache|bundt|velvet|cheesecake|lemon|strawberry|fruit)\b/i.test(title)) continue;
      seen.add(url); found.push({ title:title.slice(0,110), url, catalogueTitle:item.title, catalogueUrl:item.url, provider:item.provider, snippet:item.snippet || '' });
    }
  }
  return found;
}
function recipeTopicGroups(results = [], query = '') {
  if (!isRecipeTopic(query)) return [];
  const links=usableRecipeLinks(results); const focus=recipeFocusWords(query); const groups=[];
  // Clicking a simple topic such as Chocolate should expand that topic's own
  // variations, not send the map back out through unrelated cake categories.
  const selectedTerm=RECIPE_VARIATION_TERMS.find(([, expression])=>expression.test(query));
  const terms=selectedTerm?[selectedTerm]:RECIPE_VARIATION_TERMS;
  for (const [label, expression] of terms) {
    const ranked=links.filter(link=>expression.test(link.title)).sort((left,right)=>{
      const leftCake=/\bcake|cakes\b/i.test(left.title)?0:1, rightCake=/\bcake|cakes\b/i.test(right.title)?0:1;
      return leftCake-rightCake || left.title.length-right.title.length;
    });
    // Catalogue pages often repeat a generic "Chocolate cakes" navigation link.
    // Keep unique recipe/page names so the second row contains useful variations.
    const names=new Set(); const matches=[];
    for (const link of ranked) { const key=link.title.toLowerCase().replace(/\bcakes\b/g,'cake').replace(/[^a-z0-9]+/g,' ').trim(); if(names.has(key))continue; names.add(key);matches.push(link);if(matches.length>=3)break; }
    if (matches.length) groups.push({ label, mediaQuery:`${label} ${focus} recipes`.replace(/\s+/g,' ').trim(), links:matches });
    if (groups.length >= 4) break;
  }
  return groups;
}
function persistNeuralCatalogues(projectId, root, results = [], sessionId = '') {
  const saved=[];
  for (const item of results) {
    if (!item?.url) continue;
    const source=persistSource(projectId,{title:item.title,website:item.website,url:item.url,author:item.author || '',published_date:item.publishedDate || '',source_type:item.kind || inferSourceType(item.url),reliability:assessReliability(item.url,item.kind || inferSourceType(item.url)),relevant_passage:item.snippet || '',extracted_text:String(item.extractedText || '').slice(0,12000),collection_status:item.extractedText?'collected from live web search':'metadata queued for collection',metadata:{discovery:item.provider || 'public source discovery',query:root.metadata?.query || root.metadata?.researchRootQuery || root.title,providerMetadata:item.metadata || {},research:item.research || {},sessionId,thumbnail:item.thumbnail || '',role:'live-search-catalogue',importedAt:now()}});
    captureSourceVersion(source); attachSource(source.id,root.id,'supports','Live search candidate retained for transparent relevance review.');
    saved.push({...source,research:item.research || source.metadata?.research || {}});
  }
  return saved;
}
function savedLiveCatalogueResults(projectId, rootQuery = '') {
  const target=normalisedWords(rootQuery);
  return db.prepare('SELECT * FROM sources WHERE project_id=? ORDER BY retrieved_at DESC').all(projectId).map(hydrateSource)
    .filter(source=>source.metadata?.role==='live-search-catalogue'&&source.metadata?.providerMetadata?.relatedLinks?.length&&(!target||normalisedWords(source.metadata?.query)===target))
    .map(source=>({provider:source.metadata.discovery || 'public source discovery',title:source.title,url:source.url,website:source.website,snippet:source.relevant_passage || '',metadata:source.metadata.providerMetadata}));
}
const BASIC_TOPIC_NOISE = new Set(['references','notes','footnotes','see also','external links','further reading','contents','history','overview','introduction','bibliography','index','home','search','menu','contact','privacy policy','terms of use','terms of service','origin','legacy','timeline','background','etymology','gallery']);
function cleanTopicText(value = '') {
  return String(value).replace(/\[([^\]]+)\]\([^)]*\)/g,'$1').replace(/<[^>]+>/g,' ').replace(/[*_`#]/g,' ').replace(/\s+/g,' ').replace(/^\d+(?:\.\d+)*\s*/,'').trim();
}
function simpleTopicLabel(value = '', query = '') {
  const raw=cleanTopicText(value); const lower=raw.toLowerCase();
  // These are concise labels for specific, visible source wording. The exact source
  // heading/link is retained in the node body so the simplification is reviewable.
  if (/\bgod\b.*\b(?:jesus christ|holy ghost)\b|\bholy ghost\b.*\bgod\b/i.test(raw)) return 'Godhead';
  if (/\b(?:god the father|jesus christ|holy ghost)\b/i.test(raw) && /\b(?:lds|latter.day|mormon)\b/i.test(query)) return 'Godhead';
  if (/\bplan\s+of\s+salvation\b/i.test(raw)) return 'Plan of salvation';
  if (/\bfirst principles?\b/i.test(raw)) return 'First principles';
  if (/\b(?:apostles?\s+and\s+)?prophets?\b/i.test(raw)) return 'Prophets';
  if (/\bpriesthood\b/i.test(raw)) return 'Priesthood';
  if (/\btemple\b/i.test(raw)) return 'Temples';
  if (/\bmissionary\b/i.test(raw)) return 'Missionary work';
  if (/\b(?:sacred texts?|bible\s+and\s+(?:the\s+)?book\s+of\s+mormon)\b/i.test(raw)) return 'Scriptures';
  if (/\bgospel doctrine\b/i.test(raw)) return 'Gospel doctrine';
  if (/^causes?,?\s+according to\b/i.test(raw)) return 'Causes';
  if (!raw || BASIC_TOPIC_NOISE.has(lower) || /^(?:timeline|legacy|origin|background|references|terms of service)\b/i.test(raw) || /^(?:ritual and doctrine|structure and practices)$/i.test(raw) || /^(?:chapter|part|section)\s+\d+/i.test(raw)) return '';
  const queryWords=new Set(normalisedWords(query).split(' ').filter(word=>word.length>2));
  const words=raw.split(/\s+/); const meaningful=words.filter(word=>!queryWords.has(word.toLowerCase())||words.length<=4);
  const compact=(meaningful.length?meaningful:words).slice(0,5).join(' ');
  return compact.length<=52?compact:compact.slice(0,52).replace(/\s+\S*$/,'');
}
function markdownHeadings(markdown = '') {
  return [...String(markdown).matchAll(/^#{1,4}\s+(.+)$/gm)].map(match=>cleanTopicText(match[1])).filter(Boolean).slice(0,48);
}
function savedTopicSourceResults(projectId, rootQuery = '') {
  const target=normalisedWords(rootQuery);
  return db.prepare('SELECT * FROM sources WHERE project_id=? ORDER BY retrieved_at DESC').all(projectId).map(hydrateSource)
    .filter(source=>source.metadata?.role==='live-search-catalogue'&&(!target||normalisedWords(source.metadata?.query)===target))
    .map(source=>({sourceId:source.id,provider:source.metadata.discovery || 'public source discovery',kind:source.source_type,title:source.title,url:source.url,website:source.website,snippet:source.relevant_passage || '',extractedText:source.extracted_text || '',metadata:source.metadata.providerMetadata || {},research:source.metadata?.research || {}}));
}
function attachedFocusSourceResults(projectId, nodeId = '') {
  if(!nodeId)return [];
  const nodes=db.prepare('SELECT * FROM nodes WHERE project_id=?').all(projectId).map(hydrateNode);
  // A search pass retains many candidate sources on the focused card for auditability.
  // Its originating source is narrower: it is the source attached to the card's own
  // overview/source child. Only that source may act as an inherited focus fallback.
  const originSourceIds=[...new Set(nodes.filter(node=>node.metadata?.neuralTopicId===nodeId&&[
    'neural-basic-evidence','neural-basic-source','neural-topic-detail','neural-topic-source'
  ].includes(node.metadata?.role)).map(node=>node.metadata?.sourceId).filter(Boolean))];
  const rows=originSourceIds.length
    ? db.prepare(`SELECT * FROM sources WHERE project_id=? AND id IN (${originSourceIds.map(()=>'?').join(',')})`).all(projectId,...originSourceIds).map(hydrateSource)
    : db.prepare('SELECT DISTINCT s.* FROM sources s JOIN source_nodes sn ON sn.source_id=s.id WHERE sn.node_id=? AND s.project_id=?').all(nodeId,projectId).map(hydrateSource);
  return rows.map(source=>({
    sourceId:source.id,provider:source.metadata?.discovery || 'saved original source',kind:source.source_type,title:source.title,url:source.url,website:source.website,
    snippet:source.relevant_passage || '',extractedText:source.extracted_text || '',
    metadata:{...(source.metadata?.providerMetadata || {}),directFocusSource:true},research:source.metadata?.research || {}
  }));
}
function sourceFocusProfile(source, focus = '') {
  const focusText=normalisedWords(focus); const focusWords=focusText.split(' ').filter(word=>word.length>2&&!['the','and','for','with','from','about'].includes(word));
  const title=normalisedWords(source?.title); const titleWords=new Set(title.split(' ').filter(Boolean));
  const focusMatch=focusWords.length?focusWords.filter(word=>titleWords.has(word)).length/focusWords.length:0;
  const focusPairs=focusWords.slice(0,-1).map((word,index)=>`${word} ${focusWords[index+1]}`);
  const exactPhrase=focusPairs.some(phrase=>title.includes(phrase));
  const headings=[...(source?.metadata?.sectionOutline || []).map(section=>section?.title),...(source?.metadata?.sections || [])]
    .map(normalisedWords).filter(Boolean);
  const headingMatch=Boolean(focusText&&headings.some(heading=>heading===focusText));
  // A focused card may use a page title (Book of Mormon → its top-level sections),
  // or a named section inside a larger page (Dictation → only its subsections). A
  // page merely mentioning one word in the focus is not a map taxonomy for it.
  return {focusWords,focusMatch,exactPhrase,headingMatch,isFocused:!focusWords.length||focusMatch>=.5||exactPhrase||headingMatch};
}
function focusedSourceSections(source, focus = '') {
  if (!focus) return Array.isArray(source?.metadata?.sections)?source.metadata.sections:[];
  const profile=sourceFocusProfile(source,focus); if(!profile.isFocused)return [];
  const outline=Array.isArray(source?.metadata?.sectionOutline)?source.metadata.sectionOutline:[];
  const focusText=normalisedWords(focus);
  const index=outline.findIndex(section=>normalisedWords(section?.title)===focusText);
  if(index>=0){
    const parentLevel=Number(outline[index].level)||1; const children=[];
    for(let cursor=index+1;cursor<outline.length;cursor++){
      const section=outline[cursor]; const level=Number(section?.level)||1;
      if(level<=parentLevel)break;
      if(level===parentLevel+1)children.push(section.title);
    }
    return children;
  }
  // When the page itself is the focus, its visible top-level table of contents is
  // a truthful next layer. Do not use a non-hierarchical page’s sibling headings.
  if(!outline.length || (profile.focusMatch<.5&&!profile.exactPhrase))return [];
  const topLevel=Math.min(...outline.map(section=>Number(section.level)||1));
  return outline.filter(section=>(Number(section.level)||1)===topLevel).map(section=>section.title);
}
function mergeFocusedCandidates(attached = [], discovered = []) {
  const discoveredByUrl=new Map(discovered.filter(item=>item?.url).map(item=>[item.url,item]));
  const attachedUrls=new Set(attached.map(item=>item?.url).filter(Boolean));
  // A saved attachment retains its source identity, while the newly read copy supplies
  // current structured metadata (including Wikipedia heading levels) for this pass.
  const refreshedAttachments=attached.map(saved=>{
    const fresh=discoveredByUrl.get(saved.url); if(!fresh)return saved;
    return {...fresh,sourceId:saved.sourceId || fresh.sourceId,metadata:{...(fresh.metadata || {}),directFocusSource:true},research:fresh.research || saved.research || {}};
  });
  return [...refreshedAttachments,...discovered.filter(item=>!attachedUrls.has(item?.url))];
}
function topicStructureSources(sources = [], focus = '') {
  const focusWords=normalisedWords(focus).split(' ').filter(word=>word.length>2&&!['the','and','for','with','from','about'].includes(word));
  const best=new Map();
  for (const source of sources) {
    if (!source?.url) continue;
    const profile=sourceFocusProfile(source,focus);
    if (focusWords.length&&!profile.isFocused) continue;
    let lineage=source.research?.lineage || ''; try { lineage ||= new URL(source.url).hostname.replace(/^www\./,''); } catch { lineage ||= source.provider || source.website || source.url; }
    const rank=Number(source.metadata?.searchRank ?? source.metadata?.searchPosition ?? 99);
    const structured=Array.isArray(source.metadata?.sections) ? source.metadata.sections.length : 0;
    // At the root, the provider's broad rank-zero table of contents is useful. Once a
    // card is clicked, only sources focused on that card can supply its new web.
    const value=focusWords.length
      ? (Number(source.research?.relevance)||0)*10+profile.focusMatch*90+(profile.exactPhrase?150:0)+(profile.headingMatch?70:0)+Math.min(12,structured/4)-rank
      : (rank<=0&&structured?1000:0)+(Number(source.research?.relevance)||0)+Math.min(12,structured/4)-rank;
    const previous=best.get(lineage);
    if (!previous || value>previous.value) best.set(lineage,{source,value});
  }
  return [...best.values()].map(entry=>entry.source);
}
function researchFamilyQuery(root) { return normalisedWords(root?.metadata?.researchRootQuery || root?.metadata?.query || root?.title || ''); }
function selectedResearchContext(node) {
  const metadata=node?.metadata || {}; const parts=[metadata.researchContext];
  // Old saved cards predate researchContext. Recover their immediate parent wording so
  // legacy subitems receive the same focused search behaviour as newly created cards.
  if (!metadata.researchContext && metadata.neuralRootId) {
    const parentRow=getNode(metadata.neuralRootId); const parent=parentRow?hydrateNode(parentRow):null;
    if(parent)parts.push(parent.metadata?.sourceHeading || parent.metadata?.topicLabel || parent.title,parent.metadata?.researchContext);
  }
  parts.push(metadata.researchRootQuery,metadata.query);
  return parts.filter((value,index,values)=>value&&values.indexOf(value)===index).join(' ').replace(/\s+/g,' ').trim();
}
function existingBasicTopicLabels(projectId, root) {
  const labels=new Set();
  for (const node of db.prepare('SELECT * FROM nodes WHERE project_id=?').all(projectId).map(hydrateNode)) {
    if (node.metadata?.role==='neural-basic-topic' && node.metadata?.neuralRootId===root?.id) labels.add(canonicalBasicTopic(node.metadata?.topicLabel || node.title));
  }
  return labels;
}
function basicTopicGroups(results = [], topicOrQuery = '', options = {}) {
  const topic=typeof topicOrQuery==='string'?null:topicOrQuery;
  const query=topic?.mainTopic || String(topicOrQuery || '');
  const focusedWording=String(options.focus || '').trim();
  const stem=value=>normalisedWords(value).replace(/(?:ies|es|s)$/,'');
  const plannedTerms=new Set((topic?.tree || []).flatMap(branch=>branch.keywords || []).map(stem).filter(Boolean));
  const grouped=new Map(); const recordCandidate=(raw,item,kind,position)=>{
    const label=simpleTopicLabel(raw,query); if(!label || label.length<2 || label.length>52) return;
    const normalized=normalisedWords(label); const queryNormalized=normalisedWords(query);
    if (!normalized || normalized===queryNormalized || BASIC_TOPIC_NOISE.has(normalized)) return;
    const labelTerms=normalisedWords(label).split(' ').filter(Boolean);
    const rawTerms=normalisedWords(raw).split(' ').filter(Boolean);
    const queryTerms=new Set(queryNormalized.split(' ').filter(word=>word.length>1));
    if (labelTerms.length && labelTerms.every(term=>queryTerms.has(term))) return;
    const branchMatches=[...new Set([...labelTerms,...rawTerms].map(stem).filter(term=>plannedTerms.has(term)))].length;
    const key=canonicalBasicTopic(label); const entry=grouped.get(key) || {label,score:0,sources:new Map()};
    // Headings and navigation labels came from the public page itself. A topic cited
    // by several independently returned pages receives an additional prominence score.
    const baseWeight={section:7,heading:6,link:4,title:2}[kind] || 1;
    const rank=Number(item.metadata?.searchRank ?? item.metadata?.searchPosition ?? 3);
    // A heading on the most relevant returned page is more applicable than a
    // stray heading on a lower-ranked comparison or reference page. A match to the
    // planned question tree is also promoted over unrelated page-navigation text.
    const weight=baseWeight+Math.max(0,5-rank*2)+Math.min(12,branchMatches*5);
    const sourceKey=item.sourceId || item.url;
    const previous=entry.sources.get(sourceKey);
    if (!previous || previous.weight<weight) entry.sources.set(sourceKey,{item,raw,kind,position,weight});
    entry.score+=previous?Math.max(0,weight-previous.weight):weight;
    grouped.set(key,entry);
  };
  for (const item of results.filter(item=>item?.url && item.kind!=='image').slice(0,18)) {
    const sections=focusedWording?focusedSourceSections(item,focusedWording):(item.metadata?.sections || []);
    sections.forEach((section,index)=>recordCandidate(section,item,'section',index));
    // A selected card's web is a hierarchy, not every heading or navigation link that
    // happens to occur on a page. For a fresh focus, only bounded table-of-contents
    // children above are allowed to create topic cards.
    if (!focusedWording) {
      markdownHeadings(item.extractedText).forEach((heading,index)=>recordCandidate(heading,item,'heading',index));
      (item.metadata?.relatedLinks || []).forEach((link,index)=>recordCandidate(link?.title,item,'link',index));
    }
  }
  const ranked=[...grouped.values()].map(group=>{
    const candidates=[...group.sources.values()].sort((left,right)=>right.weight-left.weight || left.position-right.position);
    return {...group,sourceCount:candidates.length,score:group.score+(candidates.length-1)*5,best:candidates[0]};
  }).filter(group=>group.best).sort((left,right)=>right.score-left.score || left.best.position-right.best.position || left.label.localeCompare(right.label));
  const distinct=[];
  for(const group of ranked){
    const words=canonicalBasicTopic(group.label).split(' ').filter(Boolean);
    // When a page gives both a broad heading and its qualified duplicate (for example
    // “Revelation” and “Continuing revelation”), retain the stronger source-backed
    // card so the limited basic layer has room for another distinct topic.
    const overlaps=distinct.some(existing=>{
      const other=canonicalBasicTopic(existing.label).split(' ').filter(Boolean);
      const short=words.length<=other.length?words:other, long=words.length<=other.length?other:words;
      return short.length===1 && short.every(word=>long.includes(word));
    });
    if(!overlaps)distinct.push(group);
  }
  return distinct.slice(0,topic?.type==='beliefs_or_doctrine'?12:6);
}
function sourceForBasicTopic(projectId, root, candidate, sessionId = '') {
  if (candidate.item.sourceId) { const saved=db.prepare('SELECT * FROM sources WHERE id=?').get(candidate.item.sourceId); if(saved)return hydrateSource(saved); }
  const existing=db.prepare('SELECT * FROM sources WHERE project_id=? AND url=?').get(projectId,candidate.item.url);
  if (existing) return hydrateSource(existing);
  const item=candidate.item;
  const source=persistSource(projectId,{title:item.title,website:item.website,url:item.url,source_type:item.kind || inferSourceType(item.url),reliability:assessReliability(item.url,item.kind || inferSourceType(item.url)),relevant_passage:item.snippet || '',extracted_text:String(item.extractedText || '').slice(0,12000),collection_status:item.extractedText?'collected from live web search':'metadata queued for collection',metadata:{discovery:item.provider || 'public source discovery',query:root.metadata?.query || root.title,providerMetadata:item.metadata || {},sessionId,thumbnail:item.thumbnail || '',role:'live-search-catalogue',importedAt:now()}});
  captureSourceVersion(source); return source;
}
function addBasicTopicGroup(projectId, root, group, index, total, sessionId = '') {
  const rootX=Number(root.x)||0, rootY=Number(root.y)||0; const angle=(Math.PI*2*index)/Math.max(total,1)-Math.PI/2;
  const position=radius=>({x:rootX+Math.round(radius*Math.cos(angle)),y:rootY+Math.round(radius*Math.sin(angle))});
  const nodes=()=>db.prepare('SELECT * FROM nodes WHERE project_id=?').all(projectId).map(hydrateNode);
  let all=nodes(); let topic=canonicalBasicTopic(root.title)===canonicalBasicTopic(group.label)?root:all.find(node=>node.metadata?.role==='neural-basic-topic'&&node.metadata?.neuralRootId===root.id&&canonicalBasicTopic(node.metadata?.topicLabel)===canonicalBasicTopic(group.label));
  const contextQuery=root.metadata?.researchRootQuery || root.metadata?.query || root.title;
  const parentResearchContext=[root.metadata?.sourceHeading || root.metadata?.topicLabel || root.title,root.metadata?.researchContext || contextQuery].filter((value,index,values)=>value&&values.indexOf(value)===index).join(' ').replace(/\s+/g,' ').trim();
  const searchQuery=[group.label,parentResearchContext].filter((value,index,values)=>value&&values.indexOf(value)===index).join(' ').replace(/\s+/g,' ').trim();
  if (!topic) topic=insertNode({project_id:projectId,type:'concept',title:group.label,body:`Basic topic found in ${group.sourceCount} collected public page${group.sourceCount===1?'':'s'}${group.best.raw?` under “${group.best.raw}”`:''}. This is a source-derived navigation point, not an AI conclusion. Select it to search and grow this topic's own web.`,priority:'research_required',confidence:'unverified',origin:'web',...position(215),metadata:{role:'neural-basic-topic',generation:1,neuralRootId:root.id,topicLabel:group.label,mediaQuery:searchQuery,researchRootQuery:root.metadata?.query || root.metadata?.researchRootQuery || root.title,researchContext:parentResearchContext,sourceDerived:true,sourceHeading:group.best.raw}});
  if (topic.id!==root.id) insertConnection({project_id:projectId,from_node_id:topic.id,to_node_id:root.id,relationship:'related_to',confidence:'unverified',notes:'Basic topic drawn from a heading or labelled link on collected public pages.'});
  const source=sourceForBasicTopic(projectId,root,group.best,sessionId); all=nodes();
  let evidence=all.find(node=>node.metadata?.role==='neural-basic-evidence'&&node.metadata?.neuralTopicId===topic.id&&node.metadata?.sourceId===source.id);
  if (!evidence) evidence=insertNode({project_id:projectId,type:'evidence',title:`${group.label} overview`,body:`The public page “${source.title}” includes the heading or link “${group.best.raw}”. Open the original source to review its full context.`,priority:'informational',confidence:'unverified',origin:'web',...position(405),metadata:{role:'neural-basic-evidence',generation:2,neuralRootId:root.id,neuralTopicId:topic.id,sourceId:source.id,mediaQuery:searchQuery,sourceTitle:source.title,sourceHeading:group.best.raw}});
  let sourceNode=all.find(node=>node.metadata?.role==='neural-basic-source'&&node.metadata?.neuralTopicId===topic.id&&node.metadata?.sourceId===source.id);
  if (!sourceNode) sourceNode=insertNode({project_id:projectId,type:'source',title:`${group.label} source`,body:`${source.title}\n${source.url}`,priority:'informational',confidence:'unverified',origin:'web',...position(595),metadata:{role:'neural-basic-source',generation:3,neuralRootId:root.id,neuralTopicId:topic.id,sourceId:source.id,mediaQuery:searchQuery,sourceTitle:source.title}});
  attachSource(source.id,topic.id,'supports','Collected public source used to identify this basic topic.'); attachSource(source.id,evidence.id,'supports','Source heading/link supporting this topic overview.'); attachSource(source.id,sourceNode.id,'documents','Original public source.');
  insertConnection({project_id:projectId,from_node_id:evidence.id,to_node_id:topic.id,relationship:'evidence_for',confidence:'unverified',notes:'Public source page contains the named heading or linked topic.'});
  insertConnection({project_id:projectId,from_node_id:sourceNode.id,to_node_id:evidence.id,relationship:'supports',confidence:'unverified',notes:'Original public source for this topic.'});
  return {topic,evidence,sourceNode,source};
}
function addRecipeTopicGroup(projectId, root, group, index, total, sessionId = '') {
  const rootX=Number(root.x)||0, rootY=Number(root.y)||0;
  const angle=(Math.PI*2*index)/Math.max(total,1)-Math.PI/2;
  const atRing=radius=>({x:rootX+Math.round(radius*Math.cos(angle)),y:rootY+Math.round(radius*Math.sin(angle))});
  const existing=()=>db.prepare('SELECT * FROM nodes WHERE project_id=?').all(projectId).map(hydrateNode);
  let nodes=existing();
  // If the user clicked the Chocolate/Carrot/etc. topic itself, it stays as the
  // centre and receives the next layer directly—no redundant second Chocolate node.
  let topic=normalisedWords(root.title)===normalisedWords(group.label)?root:nodes.find(node=>node.metadata?.role==='neural-topic'&&node.metadata?.neuralRootId===root.id&&node.metadata?.topicLabel===group.label);
  if (!topic) topic=insertNode({project_id:projectId,type:'concept',title:group.label,body:`A simple topic choice found in live recipe catalogue pages. Select it to centre this saved web and search its own source-backed variations.`,priority:'research_required',confidence:'unverified',origin:'web',...atRing(215),metadata:{role:'neural-topic',generation:1,neuralRootId:root.id,topicLabel:group.label,mediaQuery:group.mediaQuery,sourceDerived:true}});
  if (topic.id!==root.id) insertConnection({project_id:projectId,from_node_id:topic.id,to_node_id:root.id,relationship:'related_to',confidence:'unverified',notes:'Simple recipe topic derived from labels in collected live public catalogues.'});
  const details=[];
  group.links.forEach((link,detailIndex)=>{
    const source=persistSource(projectId,{title:link.title,website:(()=>{try{return new URL(link.url).hostname;}catch{return '';}})(),url:link.url,source_type:'website',reliability:assessReliability(link.url,'website'),relevant_passage:`Listed as “${link.title}” on the live public recipe catalogue “${link.catalogueTitle}”.`,collection_status:'metadata queued for collection',metadata:{discovery:link.provider,query:group.mediaQuery,sessionId,foundOn:{title:link.catalogueTitle,url:link.catalogueUrl},role:'recipe-topic-link',importedAt:now()}}); captureSourceVersion(source);
    nodes=existing(); let detail=nodes.find(node=>node.metadata?.role==='neural-topic-detail'&&node.metadata?.neuralTopicId===topic.id&&node.metadata?.sourceId===source.id);
    const detailAngle=angle+(detailIndex-(group.links.length-1)/2)*.24; const detailPoint={x:rootX+Math.round(405*Math.cos(detailAngle)),y:rootY+Math.round(405*Math.sin(detailAngle))};
    if (!detail) detail=insertNode({project_id:projectId,type:'evidence',title:keywordLabel(link.title,group.label),body:`A source-listed ${group.label.toLowerCase()} recipe variation: “${link.title}”. Open the attached original page before relying on any recipe details.`,priority:'informational',confidence:'unverified',origin:'web',x:detailPoint.x,y:detailPoint.y,metadata:{role:'neural-topic-detail',generation:2,neuralRootId:root.id,neuralTopicId:topic.id,sourceId:source.id,mediaQuery:group.mediaQuery,sourceTitle:link.title}});
    let sourceNode=nodes.find(node=>node.metadata?.role==='neural-topic-source'&&node.metadata?.neuralTopicId===topic.id&&node.metadata?.sourceId===source.id);
    const sourcePoint={x:rootX+Math.round(595*Math.cos(detailAngle)),y:rootY+Math.round(595*Math.sin(detailAngle))};
    if (!sourceNode) sourceNode=insertNode({project_id:projectId,type:'source',title:`${keywordLabel(link.title,group.label)} source`,body:`${link.title}\n${link.url}`,priority:'informational',confidence:'unverified',origin:'web',x:sourcePoint.x,y:sourcePoint.y,metadata:{role:'neural-topic-source',generation:3,neuralRootId:root.id,neuralTopicId:topic.id,sourceId:source.id,mediaQuery:group.mediaQuery,sourceTitle:link.title}});
    attachSource(source.id,topic.id,'supports','Public catalogue link used to define this simple topic choice.'); attachSource(source.id,detail.id,'supports','Original source for this recipe variation.'); attachSource(source.id,sourceNode.id,'documents','Original linked recipe source.');
    insertConnection({project_id:projectId,from_node_id:detail.id,to_node_id:topic.id,relationship:'evidence_for',confidence:'unverified',notes:'A genuine linked recipe variation in this topic.'});
    insertConnection({project_id:projectId,from_node_id:sourceNode.id,to_node_id:detail.id,relationship:'supports',confidence:'unverified',notes:'Original public recipe page.'});
    void collectSource({url:link.url,title:link.title,website:source.website,source_type:'website',metadata:source.metadata}).then(collected=>{const refreshed=persistSource(projectId,{...collected,metadata:{...(source.metadata||{}),...(collected.metadata||{})}});captureSourceVersion(refreshed);}).catch(error=>console.warn('Background recipe-source collection failed:',error.message));
    details.push({source,detail,sourceNode});
  });
  return {topic,details};
}
function neuralSources(results, maximum = 8) {
  const usable = (results || []).filter(item => item?.url && item.kind !== 'image');
  const selected = []; const providers = new Set();
  // Give a live-web search several independently ranked pages, then keep the map
  // balanced with the specialist public libraries instead of stopping at one web URL.
  // Keep the map balanced across independent libraries: at most two Wikipedia
  // articles, then one item from each remaining provider.
  for (const item of usable.filter(item=>item.provider === 'Wikipedia').slice(0,2)) { selected.push(item); providers.add(item.provider); }
  for (const item of usable) if (!selected.includes(item) && !providers.has(item.provider) && selected.length < maximum) { selected.push(item); providers.add(item.provider); }
  for (const item of usable) if (!selected.includes(item) && selected.length < maximum) selected.push(item);
  return selected;
}
function neuralRootFor(projectId, query, centerNodeId = '') {
  const nodes = db.prepare('SELECT * FROM nodes WHERE project_id=? ORDER BY created_at').all(projectId).map(hydrateNode);
  const selected = centerNodeId ? nodes.find(node => node.id === centerNodeId) : null;
  if (selected) return selected;
  const existing = nodes.find(node => node.metadata?.role === 'neural-root' && node.metadata?.query?.toLowerCase() === query.toLowerCase());
  if (existing) return existing;
  const roots = nodes.filter(node => node.metadata?.role === 'neural-root').length;
  const angle = roots * 2.399963229728653;
  return insertNode({ project_id: projectId, type: 'concept', title: keywordLabel(query), body: `Main research topic: ${query}\nInternet discovery is the first evidence layer; AI interpretation is optional and source-bounded.`, priority: 'research_required', confidence: 'unverified', origin: 'user', x: roots ? Math.round(440 * Math.cos(angle)) : 0, y: roots ? Math.round(280 * Math.sin(angle)) : 0, metadata: { role: 'neural-root', generation: 0, query } });
}
function addNeuralSourceBranch(projectId, root, item, index, total, sessionId = '') {
  const sourceInput = {
    title: item.title, website: item.website, url: item.url, author: item.author || '', published_date: item.publishedDate || '', source_type: item.kind || inferSourceType(item.url),
    reliability: assessReliability(item.url, item.kind || inferSourceType(item.url)), relevant_passage: item.snippet || '', extracted_text: String(item.extractedText || '').slice(0,12000), collection_status: item.extractedText ? 'collected from live web search' : 'metadata queued for collection',
    metadata: { discovery: item.provider || 'public source discovery', query: root.metadata?.query || root.title, providerMetadata: item.metadata || {}, sessionId, thumbnail: item.thumbnail || '', importedAt: now() }
  };
  const source = persistSource(projectId, sourceInput); captureSourceVersion(source);
  const existing = db.prepare('SELECT * FROM nodes WHERE project_id=?').all(projectId).map(hydrateNode);
  let concept = existing.find(node => node.metadata?.neuralRootId === root.id && node.metadata?.sourceId === source.id && node.metadata?.role === 'neural-keyword');
  let evidence = existing.find(node => node.metadata?.neuralRootId === root.id && node.metadata?.sourceId === source.id && node.metadata?.role === 'neural-evidence');
  let sourceNode = existing.find(node => node.metadata?.neuralRootId === root.id && node.metadata?.sourceId === source.id && node.metadata?.role === 'neural-source');
  const keyword = keywordLabel(item.title, item.website || 'Source');
  // Persist a clear 2D inside-out web: the research focus is central and every
  // source branch follows a single radial line through keyword → evidence → source.
  const rootX=Number(root.x)||0, rootY=Number(root.y)||0;
  const angle=(Math.PI*2*index)/Math.max(total,1)-Math.PI/2;
  const atRing=radius=>({x:rootX+Math.round(radius*Math.cos(angle)),y:rootY+Math.round(radius*Math.sin(angle))});
  const keywordPosition=atRing(215), evidencePosition=atRing(405), sourcePosition=atRing(595);
  if (!concept) concept=insertNode({ project_id:projectId,type:'concept',title:keyword,body:`Keyword branch from the source result “${item.title}”.\n${item.snippet || 'Open the attached source record for the available research information.'}`,priority:'research_required',confidence:'unverified',origin:'web',x:keywordPosition.x,y:keywordPosition.y,metadata:{role:'neural-keyword',generation:1,neuralRootId:root.id,sourceId:source.id,sourceTitle:item.title} });
  if (!evidence) evidence=insertNode({ project_id:projectId,type:'evidence',title:`${keywordLabel(keyword, 'Source')} evidence`,body:item.snippet || `Evidence record from ${item.provider || 'a public source index'}. Open the attached original source for full information.`,priority:'informational',confidence:'unverified',origin:'web',x:evidencePosition.x,y:evidencePosition.y,metadata:{role:'neural-evidence',generation:2,neuralRootId:root.id,sourceId:source.id,sourceTitle:item.title} });
  if (!sourceNode) sourceNode=insertNode({ project_id:projectId,type:'source',title:`${keywordLabel(item.title, 'Source')} source`,body:`${item.title}\n${item.url}\n${item.author ? `${item.author} · ` : ''}${item.publishedDate || ''}`.trim(),priority:'informational',confidence:'unverified',origin:'web',x:sourcePosition.x,y:sourcePosition.y,metadata:{role:'neural-source',generation:3,neuralRootId:root.id,sourceId:source.id,sourceTitle:item.title} });
  attachSource(source.id, concept.id, 'supports', 'Original source supporting this keyword branch.');
  attachSource(source.id, evidence.id, 'supports', 'Source excerpt retained as evidence.');
  attachSource(source.id, sourceNode.id, 'documents', 'Original source record.');
  const connections=[
    insertConnection({project_id:projectId,from_node_id:concept.id,to_node_id:root.id,relationship:'related_to',confidence:'unverified',notes:'Internet-discovered related keyword.'}),
    insertConnection({project_id:projectId,from_node_id:evidence.id,to_node_id:concept.id,relationship:'evidence_for',confidence:'unverified',notes:'Source-provided excerpt for this keyword.'}),
    insertConnection({project_id:projectId,from_node_id:sourceNode.id,to_node_id:evidence.id,relationship:'supports',confidence:'unverified',notes:'Original web source for this evidence.'})
  ].filter(Boolean);
  // Indexes that already supply an extract are stored as collected. The rest are
  // enriched from the original page asynchronously without blocking the map.
  if (!sourceInput.extracted_text) void collectSource(sourceInput).then(collected => { const refreshed=persistSource(projectId,collected); captureSourceVersion(refreshed); }).catch(error => console.warn('Background neural-source collection failed:', error.message));
  return { source, concept, evidence, sourceNode, connections };
}

function captureSourceVersion(source) {
  const stableContent = `${source.title || ''}\n${source.relevant_passage || ''}\n${source.extracted_text || ''}\n${source.collection_status || ''}`;
  const hash = createHash('sha256').update(stableContent).digest('hex');
  const previous = db.prepare('SELECT * FROM source_versions WHERE source_id=? ORDER BY retrieved_at DESC LIMIT 1').get(source.id);
  const changed = Boolean(previous && previous.content_hash !== hash);
  if (!previous || changed) {
    const summary = !previous ? 'Initial collected snapshot.' : `Collected page content changed since ${previous.retrieved_at}.`;
    db.prepare('INSERT INTO source_versions (id,source_id,content_hash,title,relevant_passage,extracted_text,collection_status,retrieved_at,change_summary) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(uid('source_version'), source.id, hash, source.title, source.relevant_passage, source.extracted_text, source.collection_status, source.retrieved_at, summary);
  }
  return { changed, previousRetrievedAt: previous?.retrieved_at || null, hash };
}
function logResearchDecision(sessionId, stage, decision, reason = '', data = {}) {
  if (!sessionId) return;
  db.prepare('INSERT INTO research_decisions (id,session_id,stage,decision,reason,data,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(uid('decision'),sessionId,String(stage).slice(0,80),String(decision).slice(0,220),String(reason).slice(0,2000),JSON.stringify(data || {}),now());
}
function persistSourceQuotedClaims(projectId, sessionId, topic, claims = []) {
  const written=[];
  for (const claim of claims) {
    const timestamp=now();
    let row=db.prepare('SELECT * FROM claims WHERE project_id=? AND normalized_key=?').get(projectId,claim.key);
    if (!row) {
      const item={id:uid('claim'),project_id:projectId,session_id:sessionId || null,statement:String(claim.statement).slice(0,3000),normalized_key:claim.key,topic:topic.mainTopic,branch:'Direct information',relevance:Number(claim.relevance)||0,confidence:claim.confidence || 'unverified',distance:1,evidence_quality:0,status:'source_quoted',metadata:JSON.stringify({duplicateCount:claim.duplicateCount,independentSupport:claim.independentSupport,generatedBy:'source quotation extraction'}),created_at:timestamp,updated_at:timestamp};
      db.prepare('INSERT INTO claims (id,project_id,session_id,statement,normalized_key,topic,branch,relevance,confidence,distance,evidence_quality,status,metadata,created_at,updated_at) VALUES (@id,@project_id,@session_id,@statement,@normalized_key,@topic,@branch,@relevance,@confidence,@distance,@evidence_quality,@status,@metadata,@created_at,@updated_at)').run(item);
      row=db.prepare('SELECT * FROM claims WHERE id=?').get(item.id);
    } else {
      db.prepare('UPDATE claims SET relevance=?,confidence=?,updated_at=? WHERE id=?').run(Math.max(Number(row.relevance)||0,Number(claim.relevance)||0),claim.confidence || row.confidence,timestamp,row.id);
    }
    for (const support of claim.sources || []) {
      const source=db.prepare('SELECT id FROM sources WHERE project_id=? AND url=?').get(projectId,support.url);
      if (source) db.prepare('INSERT OR IGNORE INTO claim_sources (claim_id,source_id,excerpt,relationship,lineage) VALUES (?,?,?,?,?)').run(row.id,source.id,String(support.excerpt || '').slice(0,3000),'supports',String(support.lineage || '').slice(0,250));
    }
    written.push(row.id);
  }
  return written;
}
function persistResearchGaps(projectId, sessionId, rootId, gaps = []) {
  const ids=[];
  for (const gap of gaps) {
    const existing=db.prepare("SELECT id FROM research_queue WHERE project_id=? AND question=? AND status='open'").get(projectId,gap.question);
    if (existing) { ids.push(existing.id); continue; }
    const item={id:uid('gap'),project_id:projectId,node_id:rootId || null,question:String(gap.question).slice(0,1000),reason:`Coverage was ${Number(gap.coverage)||0}% for the “${gap.branch}” research branch after source relevance and duplicate checks.`,priority:'medium',status:'open',origin_session_id:sessionId || null,created_at:now(),updated_at:now()};
    db.prepare('INSERT INTO research_queue (id,project_id,node_id,question,reason,priority,status,origin_session_id,created_at,updated_at) VALUES (@id,@project_id,@node_id,@question,@reason,@priority,@status,@origin_session_id,@created_at,@updated_at)').run(item); ids.push(item.id);
  }
  return ids;
}

app.get('/api/status', (_req, res) => res.json({
  app: 'The Brain',
  mode: 'Search and read — no AI, no account, no API key',
  keyStorage: 'No key is required or stored.',
  webSearch: {
    provider: 'Direct public-index search',
    configured: true,
    customerCost: 'No key or account required',
    sources: ['Wikipedia', 'Wiktionary dictionary', 'Wikimedia Commons', 'OpenAlex', 'Crossref', 'arXiv', 'Internet Archive'],
    readers: ['Dictionary', 'Wikipedia article', 'Web page reader', 'Image viewer', 'Video and audio player', 'Document reader']
  },
  connectivity: { note:'Checked live by the app: /api/connectivity probes the public indexes.' },
  researchEngine: { name:'Topic-centred research engine', configuration:researchConfig(parseJson(process.env.BRAIN_RESEARCH_CONFIG,{})), behaviour:'Ranks candidates by relevance, intent, specificity, authority, evidence and distance; stores source quotations, duplicate groups, possible conflicts and research gaps.' },
  privacy: 'Typing assistance sends the current term to Wikipedia OpenSearch after a short pause for real-title suggestions. When you search, the query is sent by this server to the listed public indexes. Saved page text, sources and reader history stay in the local database. Nothing is sent to an AI service, because this application has none.'
}));

app.get('/api/projects', (_req, res) => res.json(db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all()));
app.post('/api/projects', (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim(); if (!name) throw badRequest('A project needs a name.');
    const timestamp = now(); const project = { id: uid('project'), name: name.slice(0, 120), description: String(req.body.description || '').slice(0, 1000), created_at: timestamp, updated_at: timestamp };
    db.prepare('INSERT INTO projects (id,name,description,created_at,updated_at) VALUES (@id,@name,@description,@created_at,@updated_at)').run(project); res.status(201).json(project);
  } catch (e) { next(e); }
});
app.get('/api/projects/:projectId/graph', (req, res, next) => { try { res.json(mapGraph(req.params.projectId)); } catch (e) { next(e); } });

app.post('/api/projects/:projectId/nodes', (req, res, next) => {
  try { ensureProject(req.params.projectId); const node = insertNode({ ...req.body, project_id: req.params.projectId }); res.status(201).json(node); } catch (e) { next(e); }
});
app.patch('/api/nodes/:nodeId', (req, res, next) => {
  try {
    const node = getNode(req.params.nodeId); if (!node) throw Object.assign(new Error('Node not found.'), { status: 404 });
    const patch = req.body || {}; const update = {
      title: patch.title !== undefined ? String(patch.title).slice(0, 220) : node.title,
      body: patch.body !== undefined ? String(patch.body).slice(0, 12000) : node.body,
      type: patch.type !== undefined ? safe(patch.type, TYPES, node.type) : node.type,
      priority: patch.priority !== undefined ? safe(patch.priority, PRIORITIES, node.priority) : node.priority,
      confidence: patch.confidence !== undefined ? safe(patch.confidence, CONFIDENCES, node.confidence) : node.confidence,
      x: Number.isFinite(patch.x) ? patch.x : node.x, y: Number.isFinite(patch.y) ? patch.y : node.y,
      metadata: patch.metadata !== undefined ? JSON.stringify(patch.metadata) : node.metadata, updated_at: now(), id: node.id
    };
    db.prepare('UPDATE nodes SET title=@title,body=@body,type=@type,priority=@priority,confidence=@confidence,x=@x,y=@y,metadata=@metadata,updated_at=@updated_at WHERE id=@id').run(update);
    res.json(hydrateNode(getNode(node.id)));
  } catch (e) { next(e); }
});
app.delete('/api/nodes/:nodeId', (req, res, next) => { try { db.prepare('DELETE FROM nodes WHERE id = ?').run(req.params.nodeId); res.status(204).end(); } catch (e) { next(e); } });
app.get('/api/nodes/:nodeId/detail', (req, res, next) => {
  try {
    const node = getNode(req.params.nodeId); if (!node) throw Object.assign(new Error('Node not found.'), { status: 404 });
    const sources = db.prepare(`SELECT s.*, sn.relationship AS evidence_relationship, sn.notes AS evidence_notes FROM sources s JOIN source_nodes sn ON sn.source_id=s.id WHERE sn.node_id=? ORDER BY s.retrieved_at DESC`).all(node.id).map(hydrateSource);
    const connections = db.prepare('SELECT * FROM connections WHERE from_node_id=? OR to_node_id=?').all(node.id, node.id);
    const relatedIds = connections.map(c => c.from_node_id === node.id ? c.to_node_id : c.from_node_id);
    const related = relatedIds.length ? db.prepare(`SELECT * FROM nodes WHERE id IN (${relatedIds.map(() => '?').join(',')})`).all(...relatedIds).map(hydrateNode) : [];
    const sourceIds=sources.map(source=>source.id);
    const claims=sourceIds.length?db.prepare(`SELECT DISTINCT c.*, (SELECT COUNT(*) FROM claim_sources cs2 WHERE cs2.claim_id=c.id) AS supporting_source_count FROM claims c JOIN claim_sources cs ON cs.claim_id=c.id WHERE cs.source_id IN (${sourceIds.map(()=>'?').join(',')}) ORDER BY c.relevance DESC, c.updated_at DESC LIMIT 12`).all(...sourceIds).map(claim=>({...claim,metadata:parseJson(claim.metadata,{})})):[];
    res.json({ node: hydrateNode(node), sources, connections, related, claims });
  } catch (e) { next(e); }
});
app.post('/api/projects/:projectId/connections', (req, res, next) => { try { ensureProject(req.params.projectId); const item = insertConnection({ ...req.body, project_id: req.params.projectId }); if (!item) throw badRequest('Choose two different nodes to connect.'); res.status(201).json(item); } catch (e) { next(e); } });

app.get('/api/projects/:projectId/sources', (req, res, next) => { try { ensureProject(req.params.projectId); res.json(db.prepare('SELECT * FROM sources WHERE project_id=? ORDER BY retrieved_at DESC').all(req.params.projectId).map(hydrateSource)); } catch (e) { next(e); } });

// Direct, no-key source discovery. Every result comes from the listed public index.
// Search types: web | wikipedia | dictionary | articles | images | videos | books | music | papers | documents | all.
app.get('/api/discovery', async (req, res, next) => {
  try {
    const query = String(req.query.q || '').trim();
    if (!query) throw badRequest('Enter a search query.');
    const type = String(req.query.type || 'web').trim();
    const result = await discoverFreeSources(query, type);
    // Report a total connection failure as such. Returning an empty result list would
    // be indistinguishable from "the indexes answered and had nothing", which is false.
    const reachable = result.providers.filter(provider => provider.status === 'ok').length;
    const failed = result.providers.filter(provider => provider.status !== 'ok');
    const value = {
      ...result,
      reachable,
      connectivity: reachable === 0 ? 'offline' : failed.length ? 'partial' : 'online'
    };
    res.json(value);
  } catch (e) { next(e); }
});

// Lightweight typing support. These are real public-index titles, not AI-completed text.
// A correction is suggested for review and is never silently substituted into the user's query.
app.get('/api/typing-suggestions', async (req, res, next) => {
  try {
    const query=String(req.query.q||'').trim().slice(0,180);
    if(query.length<2)return res.json({query,suggestions:[],correction:null,provider:'Wikipedia OpenSearch'});
    res.json(await typingSuggestions(query));
  } catch (e) { next(e); }
});

// Internet-first neural expansion. It writes a full, source-aware first/second/third-layer
// branch set straight from the public indexes.
app.post('/api/projects/:projectId/neural-grow', async (req, res, next) => {
  const projectId=req.params.projectId; let session=null;
  try {
    ensureProject(projectId);
    const query=String(req.body.query || '').trim().slice(0,300);
    if (query.length < 2) throw badRequest('Enter at least two characters for a research topic.');
    const centerNodeId=String(req.body.centerNodeId || '');
    let selectedFocus=null;
    if (centerNodeId) { const rawSelected=getNode(centerNodeId); if(!rawSelected || rawSelected.project_id!==projectId) throw badRequest('The selected network point is not in this project.'); selectedFocus=hydrateNode(rawSelected); }
    const engineConfig=researchConfig(parseJson(process.env.BRAIN_RESEARCH_CONFIG,{}));
    // Search with the saved context, but evaluate relevance against the clicked focus
    // itself. A parent phrase such as “LDS doctrine” must not make unrelated articles
    // about any use of the word “doctrine” look like evidence for Missionary work.
    const focusWording=selectedFocus?.metadata?.sourceHeading || selectedFocus?.metadata?.topicLabel || selectedFocus?.title || query;
    const topic=analyseTopic(focusWording);
    const savedContext=selectedResearchContext(selectedFocus);
    if (savedContext && normalisedWords(savedContext)!==normalisedWords(focusWording)) topic.context=savedContext;
    const discoveryQuery=centerNodeId?[focusWording,savedContext].filter((value,index,values)=>value&&values.indexOf(value)===index).join(' ').trim():query;
    session={ id:uid('session'), project_id:projectId, request:discoveryQuery, selected_node_id:centerNodeId || null, status:'running', plan:JSON.stringify(topic.tree), analysis:'{}', error:'', model:'topic-centred public-source research engine', created_at:now(), completed_at:null };
    db.prepare('INSERT INTO research_sessions (id,project_id,request,selected_node_id,status,plan,analysis,error,model,created_at,completed_at) VALUES (@id,@project_id,@request,@selected_node_id,@status,@plan,@analysis,@error,@model,@created_at,@completed_at)').run(session);
    logResearchDecision(session.id,'understand topic','Created a focused question tree','The input was classified as a '+topic.type+' research task.',{topic:topic.mainTopic,intent:topic.userIntent,branches:topic.tree.map(branch=>branch.label)});
    const discovered=await discoverFreeSources(discoveryQuery,'all',{focus:focusWording});
    // The original source that produced a saved card is a directly relevant bounded
    // starting point for its next search. It is checked alongside fresh results and
    // is used only when fresh indexes cannot provide a more specific source.
    const attachedFocusSources=attachedFocusSourceResults(projectId,centerNodeId);
    let candidates=mergeFocusedCandidates(attachedFocusSources,discovered.results); let providerStatus=[...discovered.providers];
    let ranking=rankSources(candidates,topic,engineConfig);
    let preliminaryClaims=extractSourceClaims(ranking.selected,topic,engineConfig);
    let preliminaryGaps=findKnowledgeGaps(topic,ranking.selected,preliminaryClaims);
    const cycles=[{cycle:1,query:discoveryQuery,discovered:candidates.length,selected:ranking.selected.length,independentLineages:ranking.independentLineages.length}];
    logResearchDecision(session.id,'source evaluation','Ranked discovery candidates','Search results were treated as candidates and scored for direct relevance, intent, specificity, evidence, authority and research distance.',{discovered:candidates.length,selected:ranking.selected.length,top:ranking.ranked.slice(0,8).map(source=>({title:source.title,score:source.research.relevance,distance:source.research.distance,why:source.research.why}))});
    const targetedQueries=[];
    if (shouldRunTargetedCycle(topic,ranking,preliminaryGaps,engineConfig)) {
      const planned=planTargetedQueries(preliminaryGaps,engineConfig);
      for (const refinement of planned) {
        logResearchDecision(session.id,'knowledge gap','Started one targeted refinement search',refinement.reason,{query:refinement.query});
        const refined=await discoverFreeSources(refinement.query,'articles',{focus:focusWording});
        providerStatus.push(...refined.providers.map(provider=>({...provider,query:refinement.query})));
        const before=new Set(ranking.selected.map(source=>source.url)); candidates.push(...refined.results);
        const nextRanking=rankSources(candidates,topic,engineConfig);
        const newHighValue=nextRanking.selected.filter(source=>!before.has(source.url)).length;
        const informationGain=newHighValue/Math.max(1,ranking.selected.length);
        targetedQueries.push({...refinement,discovered:refined.results.length,newHighValue,informationGain:Math.round(informationGain*100)/100});
        cycles.push({cycle:cycles.length+1,query:refinement.query,discovered:refined.results.length,selected:nextRanking.selected.length,newHighValue,informationGain});
        ranking=nextRanking;
        logResearchDecision(session.id,'information gain',informationGain<engineConfig.STOP_INFORMATION_GAIN?'Stopped targeted refinement':'Retained targeted refinement',informationGain<engineConfig.STOP_INFORMATION_GAIN?'The targeted search added too little new high-value information.':'The targeted search added distinct high-value candidates.',{informationGain,newHighValue});
        if (informationGain<engineConfig.STOP_INFORMATION_GAIN) break;
      }
    }
    const selectedSources=ranking.selected;
    // Never turn low-relevance search candidates into a map merely to fill space.
    // If the public indexes cannot supply direct material, say so and leave the
    // focused web unchanged rather than introducing unrelated topics. A total
    // failure of every index is reported as a connection problem, not as "no results":
    // those are different facts and the distinction matters to the reader.
    if (!selectedSources.length) {
      const reachable=providerStatus.filter(provider=>provider.status==='ok').length;
      if (!candidates.length && !reachable) {
        throw Object.assign(new Error(`None of the public source indexes could be reached from this server (${providerStatus.map(provider=>provider.provider).join(', ')}). Check this machine's internet connection, then try again. Nothing was added to the map.`),{status:502});
      }
      throw Object.assign(new Error('The public indexes were reachable, but no result was relevant enough for this focus. The map was left unchanged; try a more specific wording or paste an original public URL.'),{status:502});
    }
    const root=neuralRootFor(projectId,query,centerNodeId);
    // Candidate sources are stored even when they are not promoted into the map. This
    // makes relevance decisions auditable without treating every search hit as knowledge.
    const savedCandidates=persistNeuralCatalogues(projectId,root,ranking.ranked.slice(0,engineConfig.MAX_DISCOVERY_SOURCES),session.id);
    const savedByUrl=new Map(savedCandidates.map(source=>[source.url,source]));
    const savedSelected=selectedSources.map(candidate=>({...savedByUrl.get(candidate.url),research:candidate.research})).filter(source=>source.id);
    const claims=extractSourceClaims(savedSelected,topic,engineConfig);
    const claimIds=persistSourceQuotedClaims(projectId,session.id,topic,claims);
    const conflicts=detectPotentialConflicts(claims);
    const gaps=findKnowledgeGaps(topic,savedSelected,claims);
    const gapIds=persistResearchGaps(projectId,session.id,root.id,gaps);
    logResearchDecision(session.id,'claims and evidence','Stored source quotations, merged duplicates and identified open gaps','Only source text was stored as an automatic claim. Potential conflicts remain review items, not concluded contradictions.',{claims:claims.length,duplicates:claims.reduce((total,claim)=>total+claim.duplicateCount,0),possibleConflicts:conflicts.length,gaps:gaps.map(gap=>gap.branch)});
    // Keep the user-facing map near the central question. Only sources that passed the
    // relevance gate contribute headings/links to the basic topic layer.
    const structuralLeads=candidates.filter(source=>source?.kind!=='image'&&Number(source.metadata?.searchRank)===0&&Array.isArray(source.metadata?.sections)&&source.metadata.sections.length>=3);
    // The public index’s highest-ranked structured page is a useful map taxonomy even
    // where its title uses a synonym (for example an expanded church name instead of
    // an acronym). It is not promoted as evidence unless it also passes source ranking.
    const topicCandidates=[...ranking.ranked.filter(source=>source.research.relevance>=Math.max(28,engineConfig.MIN_RELEVANCE_SCORE-12)),...structuralLeads];
    const rootResearchQuery=root.metadata?.query || root.metadata?.researchRootQuery || root.title;
    // A child expansion deliberately starts from its own live search results. Parent
    // catalogue headings are useful only for the initial layer; reusing them here is
    // what previously pulled the map back to unrelated parent/article topics.
    const reusableTopicSources=centerNodeId?[]:savedTopicSourceResults(projectId,rootResearchQuery);
    const topicGroups=recipeTopicGroups([...topicCandidates,...(centerNodeId?[]:savedLiveCatalogueResults(projectId,rootResearchQuery))],query);
    const useSimpleRecipeTopics=topicGroups.length>=2 || Boolean(centerNodeId&&topicGroups.length);
    let basicGroups=useSimpleRecipeTopics?[]:basicTopicGroups(topicStructureSources([...topicCandidates,...reusableTopicSources],centerNodeId?focusWording:''),topic,{focus:centerNodeId?focusWording:''});
    const knownSiblingLabels=centerNodeId?new Set():existingBasicTopicLabels(projectId,root);
    // A fresh chosen focus owns its own web. Do not let a card elsewhere in the
    // project suppress a new child layer; only avoid repeated siblings on an initial
    // root expansion.
    basicGroups=basicGroups.filter(group=>{
      const label=canonicalBasicTopic(group.label); return label===canonicalBasicTopic(root.title) || !knownSiblingLabels.has(label);
    });
    const freshChildGroups=basicGroups.filter(group=>canonicalBasicTopic(group.label)!==canonicalBasicTopic(root.title));
    const hasExistingBasicLayer=knownSiblingLabels.size>=3;
    // A focus-level heading equal to the selected card is evidence for that card, not
    // a visible branch. Never let it produce a one-card “web”. If the collected page
    // has no genuine child headings, show the independently ranked original sources
    // as fresh visible branches instead.
    const useBasicTopics=!useSimpleRecipeTopics&&(basicGroups.length>=3 || hasExistingBasicLayer || Boolean(centerNodeId&&freshChildGroups.length));
    const refreshedFocusCards=centerNodeId&&freshChildGroups.length ? clearFocusedAutomaticExpansion(projectId,root) : 0;
    const legacyResultCardsRemoved=useBasicTopics ? removeLegacySourceResultBranches(projectId,root) : 0;
    const branches=useSimpleRecipeTopics
      ? topicGroups.map((group,index)=>addRecipeTopicGroup(projectId,root,group,index,topicGroups.length,session.id))
      : useBasicTopics
        ? basicGroups.map((group,index)=>addBasicTopicGroup(projectId,root,group,index,basicGroups.length,session.id))
        : selectedSources.map((source,index)=>addNeuralSourceBranch(projectId,root,source,index,selectedSources.length,session.id));
    const sourceIds=[...new Set(savedSelected.map(source=>source.id))];
    const engineSummary=researchSummary(topic,{...ranking,selected:selectedSources},claims,gaps,conflicts,cycles);
    const note=useSimpleRecipeTopics?'Simple recipe topics were derived from real labels on collected public catalogue pages.':useBasicTopics?'Basic map topics were extracted from bounded headings and labelled links on relevance-ranked public pages.':'No sufficiently focused page structure was available, so only relevance-ranked source branches were added.';
    const analysis={mode:'internet-first',rootId:root.id,sourceIds,providers:providerStatus,topic,refreshedFocusCards,legacyResultCardsRemoved,sourceEvaluation:ranking.ranked.slice(0,engineConfig.MAX_DISCOVERY_SOURCES).map(source=>({title:source.title,url:source.url,provider:source.provider,relevance:source.research.relevance,distance:source.research.distance,authority:source.research.authority,evidence:source.research.evidence,why:source.research.why,accepted:selectedSources.some(selected=>selected.url===source.url)})),claims:claims.map(claim=>({statement:claim.statement,relevance:claim.relevance,confidence:claim.confidence,independentSupport:claim.independentSupport,sourceCount:claim.sourceCount})),claimIds,possibleConflicts:conflicts,gaps,targetedQueries,queuedGapIds:gapIds,engine:engineSummary,summary:`Focused public-source pass: ${selectedSources.length} relevance-ranked sources across ${ranking.independentLineages.length} independent source domains; ${claims.length} source quotations retained; ${gaps.length} open research gaps.`,note};
    const timestamp=now();
    db.prepare('UPDATE research_sessions SET status=?,analysis=?,completed_at=? WHERE id=?').run('completed',JSON.stringify(analysis),timestamp,session.id);
    db.prepare('INSERT INTO search_queries (id,session_id,query,created_at) VALUES (?,?,?,?)').run(uid('query'),session.id,discoveryQuery,timestamp);
    db.prepare('UPDATE projects SET updated_at=? WHERE id=?').run(timestamp,projectId);
    res.status(201).json({ root, branches, sessionId:session.id, providerStatus, refreshedFocusCards, research:analysis.engine, graph:mapGraph(projectId), privacy:'Public source indexes were searched directly by this server. Sources were relevance-ranked and duplicate source quotations were merged. No AI service was contacted. Original-page collection continues locally in the background.' });
  } catch (e) {
    if (session) db.prepare('UPDATE research_sessions SET status=?,error=?,completed_at=? WHERE id=?').run('failed',String(e.message || e),now(),session.id);
    next(e);
  }
});

/* ------------------------------------------------------- layered search engine
   The internet is the knowledge base; the map is the notebook.
   One search runs a procedure, not a single query:
     main item → the aspects of it → the members named inside an aspect → their detail
   Each layer is persisted as real map cards, so the map itself shows the answer.
*/

const LAYER_ROLES = { main: 'search-main', aspect: 'search-aspect', member: 'search-member' };

function searchNode(projectId, { role, generation, title, body, type = 'concept', priority = 'informational', metadata = {} }) {
  return insertNode({
    project_id: projectId, type, title, body,
    priority, confidence: 'unverified', origin: 'web',
    metadata: { role: LAYER_ROLES[role], generation, ...metadata }
  });
}

// Members in an expanded aspect are reused when the same aspect is re-opened,
// so clicking around does not duplicate the map.
function existingLayerNode(projectId, role, title, parentId) {
  const wanted = normalisedWords(title);
  return db.prepare('SELECT * FROM nodes WHERE project_id=?').all(projectId).map(hydrateNode)
    .find(node => node.metadata?.role === LAYER_ROLES[role]
      && normalisedWords(node.title) === wanted
      && (!parentId || node.metadata?.parentId === parentId));
}

function persistSearchSource(projectId, item, rootId, sessionId, label) {
  if (!item?.url) return null;
  const source = persistSource(projectId, {
    title: item.title, website: item.website, url: item.url, author: item.author || '', published_date: item.publishedDate || '',
    source_type: item.kind || inferSourceType(item.url), reliability: assessReliability(item.url, item.kind || inferSourceType(item.url)),
    relevant_passage: item.snippet || '', extracted_text: String(item.extractedText || '').slice(0, 12000),
    collection_status: item.extractedText ? 'collected from public index' : 'metadata queued for collection',
    metadata: { discovery: item.provider || 'public source discovery', query: label, providerMetadata: item.metadata || {}, sessionId, thumbnail: item.thumbnail || '', role: 'search-layer-source', importedAt: now() }
  });
  captureSourceVersion(source);
  if (rootId) attachSource(source.id, rootId, 'supports', `Evidence for this ${label}.`);
  return source;
}

/**
 * Pass 2 of a search: the main item, the aspects of it, and the members named inside
 * each aspect. Everything is persisted as real map cards, so the map itself is the answer.
 * Sidebar: nothing is written unless the relevance gate produced something.
 */
app.post('/api/projects/:projectId/search-engine', async (req, res, next) => {
  const projectId = req.params.projectId;
  let session = null;
  try {
    ensureProject(projectId);
    const query = String(req.body.query || '').trim().slice(0, 300);
    if (query.length < 2) throw badRequest('Enter at least two characters to search.');
    const config = engineConfig(parseJson(process.env.BRAIN_SEARCH_CONFIG, {}));
    const intent = parseIntent(query);
    session = { id: uid('session'), project_id: projectId, request: query, selected_node_id: null, status: 'running', plan: '[]', analysis: '{}', error: '', model: 'layered search engine', created_at: now(), completed_at: null };
    db.prepare('INSERT INTO research_sessions (id,project_id,request,selected_node_id,status,plan,analysis,error,model,created_at,completed_at) VALUES (@id,@project_id,@request,@selected_node_id,@status,@plan,@analysis,@error,@model,@created_at,@completed_at)').run(session);

    const result = await runSearch({
      query, config,
      discover: (q, type, options) => discoverFreeSources(q, type, options),
      readArticle: title => wikipediaArticle(title)
    });
    logResearchDecision(session.id, 'procedure', 'Ran the layered search procedure', `Interpreted “${query}” as the main item ${intent.main}${intent.facet ? ` narrowed by ${intent.facet}` : ''}.`, { query, steps: result.steps });

    // A search that found nothing at all must not leave a lone card behind, and it must
    // say which of the two things happened: nothing was asked, or nothing was relevant.
    if (!result.aspects.length) {
      if (result.connectivity === 'offline') {
        const names = result.providers.map(provider => provider.name).join(', ');
        throw Object.assign(new Error(`No public source index could be reached from this server (${names || 'all indexes'}). Nothing was searched and nothing was added to the map. Check this machine's internet connection, then try again.`), { status: 502 });
      }
      throw Object.assign(new Error(`The public indexes answered but no aspect of “${query}” was clear enough to show. Nothing was added to the map — try a more specific word, or add a second word to narrow the topic.`), { status: 502 });
    }

    const root = searchNode(projectId, {
      role: 'main', generation: 0, type: 'concept', priority: 'research_required',
      title: result.main.title, body: result.main.body,
      metadata: { query, mainTerm: intent.main, facet: intent.facet, image: result.main.image, sourceUrl: result.main.url, provider: result.main.provider, sessionId: session.id, procedure: 'layered' }
    });
    persistSearchSource(projectId, { title: result.main.title, url: result.main.url, website: result.main.provider, snippet: result.main.body, kind: 'article' }, root.id, session.id, 'Main item');

    const created = { aspects: [], members: [] };
    for (const entry of result.aspects) {
      const aspectNode = searchNode(projectId, {
        role: 'aspect', generation: 1, title: entry.title, body: entry.explanation || `An aspect of ${intent.main}.`, type: 'concept', priority: 'medium',
        metadata: { query, mainTerm: intent.main, facet: intent.facet, parentId: root.id, sessionId: session.id, score: entry.score, why: entry.why, sources: entry.sources, memberCount: entry.members.length }
      });
      insertConnection({ project_id: projectId, from_node_id: aspectNode.id, to_node_id: root.id, relationship: 'part_of', confidence: 'unverified', notes: `An aspect of ${result.main.title}.` });
      created.aspects.push({ ...aspectNode, memberCount: entry.members.length, explanation: aspectNode.body });

      // Members are what the aspect names: the named entries inside it.
      for (const member of entry.members) {
        const memberNode = searchNode(projectId, {
          role: 'member', generation: 2, title: member.title, body: member.body || '', type: 'concept', priority: 'informational',
          metadata: { query, parentId: aspectNode.id, aspectTitle: entry.title, sourceUrl: member.url || '', provider: member.provider || '', thumbnail: member.thumbnail || '', sessionId: session.id, score: member.score || null, why: member.why || [] }
        });
        insertConnection({ project_id: projectId, from_node_id: memberNode.id, to_node_id: aspectNode.id, relationship: 'part_of', confidence: 'unverified', notes: `Named inside ${entry.title}.` });
        persistSearchSource(projectId, { ...member, kind: member.kind === 'evidence' ? 'article' : 'reference' }, memberNode.id, session.id, 'Member');
        created.members.push(memberNode);
      }
    }

    const analysis = { mode: 'layered-search', intent, main: result.main.title, aspects: created.aspects.map(node => node.title), members: created.members.map(node => node.title), steps: result.steps, notes: result.notes, layerSizes: config };
    const timestamp = now();
    db.prepare('UPDATE research_sessions SET status=?,analysis=?,selected_node_id=?,completed_at=? WHERE id=?').run('completed', JSON.stringify(analysis), root.id, timestamp, session.id);
    db.prepare('INSERT INTO search_queries (id,session_id,query,created_at) VALUES (?,?,?,?)').run(uid('query'), session.id, query, timestamp);
    db.prepare('UPDATE projects SET updated_at=? WHERE id=?').run(timestamp, projectId);
    res.status(201).json({
      sessionId: session.id, intent, main: root, aspects: created.aspects, members: created.members,
      steps: result.steps, notes: result.notes, graph: mapGraph(projectId),
      privacy: 'Public indexes were queried directly by this server. No AI was involved and nothing was generated.'
    });
  } catch (e) {
    if (session) db.prepare('UPDATE research_sessions SET status=?,error=?,completed_at=? WHERE id=?').run('failed', String(e.message || e), now(), session.id);
    next(e);
  }
});

/**
 * Pass 3: open an aspect. This is when the other members of that aspect are found, so
 * the first search stays small and fast. Re-opening the same aspect reuses its cards.
 */
app.post('/api/nodes/:nodeId/expand', async (req, res, next) => {
  try {
    const node = getNode(req.params.nodeId);
    if (!node) throw Object.assign(new Error('That card no longer exists.'), { status: 404 });
    const hydrated = hydrateNode(node);
    const role = hydrated.metadata?.role;
    if (role !== LAYER_ROLES.aspect) throw badRequest('Only an aspect of the main item can be expanded.');
    const projectId = node.project_id;
    const config = engineConfig(parseJson(process.env.BRAIN_SEARCH_CONFIG, {}));
    const mainTerm = hydrated.metadata?.mainTerm || hydrated.metadata?.query || hydrated.title;

    const { expandAspect } = await import('./lib/searchEngine.js');
    const expansion = await expandAspect({
      aspectTitle: hydrated.title, mainTerm, config,
      discover: (q, type, options) => discoverFreeSources(q, type, options),
      readArticle: title => wikipediaArticle(title)
    });

    const memberNodes = [];
    for (const member of expansion.members) {
      let memberNode = existingLayerNode(projectId, 'member', member.title, hydrated.id);
      if (!memberNode) {
        memberNode = searchNode(projectId, {
          role: 'member', generation: 2, title: member.title, body: member.body || '', type: 'concept', priority: 'informational',
          metadata: { query: hydrated.metadata?.query || mainTerm, parentId: hydrated.id, aspectTitle: hydrated.title, sourceUrl: member.url || '', provider: member.provider || '', thumbnail: member.thumbnail || '', score: member.score || null, why: member.why || [] }
        });
        insertConnection({ project_id: projectId, from_node_id: memberNode.id, to_node_id: hydrated.id, relationship: 'part_of', confidence: 'unverified', notes: `Named inside ${hydrated.title}.` });
        persistSearchSource(projectId, { ...member, kind: member.kind === 'evidence' ? 'article' : 'reference' }, memberNode.id, null, 'Member');
      }
      memberNodes.push(memberNode);
    }

    db.prepare('UPDATE projects SET updated_at=? WHERE id=?').run(now(), projectId);
    res.status(201).json({
      aspect: hydrated, members: memberNodes,
      steps: expansion.steps, notes: expansion.notes, graph: mapGraph(projectId)
    });
  } catch (e) { next(e); }
});

// A source explicitly selected by the user from direct discovery or pasted as a URL.
// The original public URL is collected locally.
app.post('/api/projects/:projectId/sources/import', async (req, res, next) => {
  try {
    ensureProject(req.params.projectId);
    const url = String(req.body.url || '').trim();
    const parsed = publicHttpUrl(url);
    const discovered = {
      title: String(req.body.title || parsed.hostname).trim().slice(0, 500),
      website: String(req.body.website || parsed.hostname).trim().slice(0, 250),
      url: parsed.href,
      author: String(req.body.author || '').trim().slice(0, 250), published_date: String(req.body.publishedDate || '').trim().slice(0, 80),
      source_type: String(req.body.sourceType || inferSourceType(parsed.href)).slice(0, 100),
      reliability: assessReliability(parsed.href, req.body.sourceType || inferSourceType(parsed.href)),
      relevant_passage: String(req.body.snippet || '').slice(0, 1200), extracted_text: String(req.body.extractedText || '').slice(0, 12000),
      metadata: { discovery: String(req.body.provider || 'direct URL import').slice(0, 120), query: String(req.body.query || '').slice(0, 500), providerMetadata: req.body.providerMetadata && typeof req.body.providerMetadata === 'object' ? req.body.providerMetadata : {}, importedAt: now() }
    };
    // A first-query neural map should appear promptly. For the initial map grow we retain
    // the real provider metadata immediately, create its truthful source branch, then
    // enrich the record with an original-page collection in the background.
    const deferCollection = Boolean(req.body.deferCollection);
    const hasLiveExtract = Boolean(discovered.extracted_text);
    const storedInput = hasLiveExtract ? { ...discovered, collection_status: 'collected from live web search' } : deferCollection ? { ...discovered, collection_status: 'metadata queued for collection' } : await collectSource(discovered);
    const source = persistSource(req.params.projectId, storedInput);
    captureSourceVersion(source);
    const branch = ensureDiscoveryBranch(req.params.projectId, source, req.body.query, req.body.provider, req.body.targetNodeId);
    if (deferCollection && !hasLiveExtract) {
      void collectSource(discovered).then(collected => { const refreshed = persistSource(req.params.projectId, collected); captureSourceVersion(refreshed); }).catch(error => console.warn('Background source collection failed:', error.message));
    }
    res.status(201).json({ source, branch, collected: source.collection_status.startsWith('collected'), collectionQueued: deferCollection && !hasLiveExtract });
  } catch (e) { next(e); }
});

app.get('/api/sources/:sourceId', (req, res, next) => { try { const item = db.prepare('SELECT * FROM sources WHERE id=?').get(req.params.sourceId); if (!item) throw Object.assign(new Error('Source not found.'), { status: 404 }); const versions = db.prepare('SELECT id,retrieved_at,change_summary,collection_status FROM source_versions WHERE source_id=? ORDER BY retrieved_at DESC').all(item.id); res.json({ ...hydrateSource(item), versions }); } catch (e) { next(e); } });
// Revisit the original public page and retain an immutable snapshot when its extract changes.
app.post('/api/sources/:sourceId/recheck', async (req, res, next) => {
  try {
    const existing = db.prepare('SELECT * FROM sources WHERE id=?').get(req.params.sourceId);
    if (!existing) throw Object.assign(new Error('Source not found.'), { status: 404 });
    const refreshed = await collectSource(hydrateSource(existing));
    const stored = persistSource(existing.project_id, refreshed);
    const version = captureSourceVersion(stored);
    res.json({ source: stored, changed: version.changed, previousRetrievedAt: version.previousRetrievedAt, message: version.changed ? 'SOURCE UPDATED — a new page snapshot was retained for review.' : 'No extract change was detected in the current collection.' });
  } catch (e) { next(e); }
});

app.get('/api/projects/:projectId/history', (req, res, next) => {
  try {
    ensureProject(req.params.projectId);
    const sessions = db.prepare('SELECT * FROM research_sessions WHERE project_id=? ORDER BY created_at DESC LIMIT 80').all(req.params.projectId).map(s => ({ ...s, plan: parseJson(s.plan, []), analysis: parseJson(s.analysis, {}) }));
    const conversations = db.prepare('SELECT * FROM conversations WHERE project_id=? ORDER BY created_at DESC LIMIT 100').all(req.params.projectId).map(c => ({ ...c, metadata: parseJson(c.metadata, {}) }));
    res.json({ sessions, conversations });
  } catch (e) { next(e); }
});
app.get('/api/projects/:projectId/claims', (req,res,next)=>{
  try { ensureProject(req.params.projectId); const claims=db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM claim_sources cs WHERE cs.claim_id=c.id) AS supporting_source_count FROM claims c WHERE c.project_id=? ORDER BY c.relevance DESC,c.updated_at DESC LIMIT 120`).all(req.params.projectId).map(claim=>({...claim,metadata:parseJson(claim.metadata,{})}));res.json(claims); } catch(error){next(error);}
});
app.get('/api/research/:sessionId/decisions', (req,res,next)=>{
  try { const session=db.prepare('SELECT * FROM research_sessions WHERE id=?').get(req.params.sessionId);if(!session)throw Object.assign(new Error('Research session not found.'),{status:404});const decisions=db.prepare('SELECT * FROM research_decisions WHERE session_id=? ORDER BY created_at').all(session.id).map(item=>({...item,data:parseJson(item.data,{})}));res.json({session:{...session,plan:parseJson(session.plan,[]),analysis:parseJson(session.analysis,{})},decisions}); }catch(error){next(error);}
});
app.get('/api/projects/:projectId/queue', (req, res, next) => { try { ensureProject(req.params.projectId); res.json(db.prepare('SELECT * FROM research_queue WHERE project_id=? ORDER BY status, created_at DESC').all(req.params.projectId)); } catch (e) { next(e); } });
app.patch('/api/queue/:id', (req, res, next) => { try { const status = ['open','active','done','dismissed'].includes(req.body.status) ? req.body.status : 'open'; db.prepare('UPDATE research_queue SET status=?,updated_at=? WHERE id=?').run(status, now(), req.params.id); res.json(db.prepare('SELECT * FROM research_queue WHERE id=?').get(req.params.id)); } catch (e) { next(e); } });

app.get('/api/projects/:projectId/search', (req, res, next) => {
  try {
    ensureProject(req.params.projectId); const q = String(req.query.q || '').trim(); if (!q) return res.json({ nodes: [], sources: [], conversations: [] });
    const term = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
    const nodes = db.prepare("SELECT * FROM nodes WHERE project_id=? AND (title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\') ORDER BY updated_at DESC LIMIT 30").all(req.params.projectId, term, term).map(hydrateNode);
    const sources = db.prepare("SELECT * FROM sources WHERE project_id=? AND (title LIKE ? ESCAPE '\\' OR website LIKE ? ESCAPE '\\' OR extracted_text LIKE ? ESCAPE '\\') ORDER BY retrieved_at DESC LIMIT 20").all(req.params.projectId, term, term, term).map(hydrateSource);
    const conversations = db.prepare("SELECT * FROM conversations WHERE project_id=? AND content LIKE ? ESCAPE '\\' ORDER BY created_at DESC LIMIT 20").all(req.params.projectId, term);
    res.json({ nodes, sources, conversations });
  } catch (e) { next(e); }
});

app.post('/api/projects/:projectId/files', upload.array('files', 10), (req, res, next) => {
  try {
    ensureProject(req.params.projectId);
    const files = (req.files || []).map(file => {
      const item = { id: uid('file'), project_id: req.params.projectId, original_name: file.originalname, stored_name: file.filename, mime_type: file.mimetype || 'application/octet-stream', size: file.size, path: file.path, analysis: '{}', created_at: now() };
      db.prepare('INSERT INTO files (id,project_id,original_name,stored_name,mime_type,size,path,analysis,created_at) VALUES (@id,@project_id,@original_name,@stored_name,@mime_type,@size,@path,@analysis,@created_at)').run(item);
      return { ...item, analysis: {} };
    });
    res.status(201).json(files);
  } catch (e) { next(e); }
});
app.get('/api/projects/:projectId/files', (req, res, next) => { try { ensureProject(req.params.projectId); res.json(db.prepare('SELECT id,project_id,original_name,mime_type,size,analysis,created_at FROM files WHERE project_id=? ORDER BY created_at DESC').all(req.params.projectId).map(f => ({ ...f, analysis: parseJson(f.analysis, {}) }))); } catch (e) { next(e); } });
app.get('/api/files/:id/download', async (req, res, next) => { try { const file = db.prepare('SELECT * FROM files WHERE id=?').get(req.params.id); if (!file) throw Object.assign(new Error('File not found.'), { status: 404 }); res.type(file.mime_type); res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.original_name)}`); fs.createReadStream(file.path).pipe(res); } catch (e) { next(e); } });
/* ---------------------------------------------------------------- readers
   Every viewer in the browser is built in this repository. These routes supply it
   with data only: dictionary senses, Wikipedia sections, readable page text, a
   playable media URL, or a local file's own bytes. Nothing is generated or rewritten.
*/

// Live connectivity probe. A search that fails because this machine cannot reach the
// public indexes is a different fact from "no relevant result", and the interface must
// be able to say which one happened.
const PROBE_TARGETS = [
  { name:'Wikipedia', url:'https://en.wikipedia.org/w/api.php?action=query&meta=siteinfo&format=json' },
  { name:'Dictionary', url:'https://api.dictionaryapi.dev/api/v2/entries/en/word' },
  { name:'Wikimedia Commons', url:'https://commons.wikimedia.org/w/api.php?action=query&meta=siteinfo&format=json' },
  { name:'OpenAlex', url:'https://api.openalex.org/works?per-page=1' },
  { name:'Internet Archive', url:'https://archive.org/metadata/nasa' }
];
const connectivityCache = { at:0, value:null };
app.get('/api/connectivity', async (req, res, next) => {
  try {
    const fresh = req.query.fresh === '1';
    if (!fresh && connectivityCache.value && Date.now() - connectivityCache.at < 60000) return res.json(connectivityCache.value);
    const settled = await Promise.allSettled(PROBE_TARGETS.map(async target => {
      const started = Date.now();
      const response = await fetch(target.url, { signal: AbortSignal.timeout(6000), headers: { 'User-Agent': 'TheBrainResearch/0.1 (connectivity probe)', Accept: 'application/json' } });
      return { name: target.name, status: response.ok ? 'ok' : `http ${response.status}`, ms: Date.now() - started };
    }));
    const targets = settled.map((result, index) => result.status === 'fulfilled' ? result.value : { name: PROBE_TARGETS[index].name, status: 'unreachable', ms: null, error: String(result.reason?.message || 'unreachable') });
    const reachable = targets.filter(target => target.status === 'ok').length;
    const value = {
      online: reachable > 0,
      reachable,
      total: targets.length,
      targets,
      checkedAt: now(),
      message: reachable === 0
        ? 'This server cannot reach any public source index. Searches, readers and suggestions will fail until outbound internet access is restored.'
        : reachable < targets.length
          ? `${reachable} of ${targets.length} public indexes are reachable. Requests to the others will report an error rather than invent a result.`
          : `All ${targets.length} public indexes are reachable.`
    };
    connectivityCache.at = Date.now(); connectivityCache.value = value;
    res.json(value);
  } catch (e) { next(e); }
});

// Dictionary reader: real senses, examples, pronunciation and audio for one term.
app.get('/api/read/dictionary', async (req, res, next) => {
  try {
    const term = String(req.query.q || '').trim().slice(0, 60);
    if (!term) throw badRequest('Enter a word to look up.');
    const simple = term.toLowerCase().replace(/[^a-z' -]/g, '').trim();
    // A searched phrase ("photosynthesis meaning") is reduced to its likeliest headword,
    // but only after the exact term is genuinely absent rather than merely unreachable.
    let entry = await dictionaryLookup(simple);
    const words = simple.split(/\s+/).filter(Boolean).sort((left, right) => right.length - left.length);
    for (const word of entry.notFound && words.length > 1 ? words.slice(0, 3) : []) {
      const attempt = await dictionaryLookup(word);
      if (attempt.entries.length) { entry = attempt; break; }
    }
    const wikipedia = entry.entries.length ? await wikipediaSummary(entry.entries[0].word).catch(() => null) : null;
    res.json({ term: entry.term || simple, entries: entry.entries, provider: entry.provider, wikipedia, privacy: 'The word was sent to a public dictionary index. Your project notes were not.' });
  } catch (e) { next(e); }
});

// Wikipedia reader: the article's own sections, images and internal article links.
app.get('/api/read/wikipedia', async (req, res, next) => {
  try {
    const title = String(req.query.title || req.query.q || '').trim().slice(0, 240);
    if (!title) throw badRequest('Choose a Wikipedia article to read.');
    res.json(await wikipediaArticle(title));
  } catch (e) { next(e); }
});

// Web reader: server-side fetch reduced to readable paragraphs and the page's own links.
app.get('/api/read/page', async (req, res, next) => {
  try {
    const requested = String(req.query.url || '').trim();
    const parsed = publicHttpUrl(requested);
    res.json(await readWebPage(parsed.href));
  } catch (e) { next(e); }
});

// Media resolver: returns a direct, playable URL where one exists. Used by video,
// music and document viewers so playback happens in this app's own player.
app.get('/api/read/playback', async (req, res, next) => {
  try {
    const url = String(req.query.url || '').trim();
    if (!url) throw badRequest('Choose a video, audio or document source to play.');
    const source = db.prepare('SELECT * FROM sources WHERE url=? ORDER BY retrieved_at DESC LIMIT 1').get(url);
    const hydrated = source ? hydrateSource(source) : null;
    res.json(await resolvePlayback({
      url, thumbnail: String(req.query.thumbnail || hydrated?.metadata?.thumbnail || ''),
      metadata: { ...(hydrated?.metadata?.providerMetadata || {}), identifier: hydrated?.metadata?.providerMetadata?.identifier || '', playbackUrl: hydrated?.metadata?.providerMetadata?.playbackUrl || '' }
    }));
  } catch (e) { next(e); }
});

// Inline preview of a saved local file (images and PDFs render; others download).
app.get('/api/files/:id/view', (req, res, next) => {
  try {
    const file = db.prepare('SELECT * FROM files WHERE id=?').get(req.params.id);
    if (!file || !fs.existsSync(file.path)) throw Object.assign(new Error('File not found.'), { status: 404 });
    res.type(file.mime_type);
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.original_name)}`);
    fs.createReadStream(file.path).pipe(res);
  } catch (e) { next(e); }
});

// Plain-text preview of a saved text/document file, capped so the reader stays responsive.
app.get('/api/files/:id/text', async (req, res, next) => {
  try {
    const file = db.prepare('SELECT * FROM files WHERE id=?').get(req.params.id);
    if (!file || !fs.existsSync(file.path)) throw Object.assign(new Error('File not found.'), { status: 404 });
    if (!/^text\/|json|xml|csv|markdown/i.test(file.mime_type || '')) throw badRequest('This file type has no in-app text preview; use the download button.');
    const content = (await fsp.readFile(file.path, 'utf8')).slice(0, 200000);
    res.json({ id: file.id, name: file.original_name, mimeType: file.mime_type, text: content });
  } catch (e) { next(e); }
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'The Brain encountered an unexpected error.' });
});
// Express 5 uses named wildcard parameters; this serves the single-page client for non-API routes.
app.get('/{*splat}', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, '0.0.0.0', () => console.log(`The Brain listening on http://0.0.0.0:${PORT}`));
