import fs from 'node:fs/promises';

const API_ROOT = 'https://generativelanguage.googleapis.com/v1beta';

function key() { return process.env.GEMINI_API_KEY; }
export function configured() { return Boolean(key()); }
// Gemini returned this current production recommendation when the old 2.5 model was retired.
// Keep the version in one provider layer so it can be upgraded without touching application workflows.
export function modelName() { return process.env.GEMINI_MODEL || 'gemini-3.6-flash'; }

function errorWithDetail(response, payload) {
  const apiMessage = payload?.error?.message || `Gemini request failed (${response.status})`;
  const message = response.status === 429
    ? 'Gemini is connected, but this API key currently has no available quota. Check its Google AI Studio project, rate limits and billing, then try again.'
    : apiMessage;
  const error = new Error(message);
  error.status = response.status;
  return error;
}

async function generate(body) {
  if (!configured()) {
    const error = new Error('Gemini is not configured. Add GEMINI_API_KEY to .env, then restart The Brain.');
    error.status = 503;
    throw error;
  }
  const response = await fetch(`${API_ROOT}/models/${encodeURIComponent(modelName())}:generateContent?key=${encodeURIComponent(key())}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(90000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw errorWithDetail(response, payload);
  const candidate = payload.candidates?.[0];
  const text = candidate?.content?.parts?.map(part => part.text || '').join('') || '';
  if (!text) {
    const error = new Error(payload.promptFeedback?.blockReason ? `Gemini blocked the request: ${payload.promptFeedback.blockReason}` : 'Gemini returned no text.');
    error.status = 422;
    throw error;
  }
  return { text, grounding: candidate?.groundingMetadata || {}, raw: payload };
}

function parseJson(text) {
  const clean = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(clean); } catch {
    const first = clean.indexOf('{'); const last = clean.lastIndexOf('}');
    if (first >= 0 && last > first) return JSON.parse(clean.slice(first, last + 1));
    throw new Error('Gemini returned an analysis that could not be parsed as structured data. Try again.');
  }
}

function sourceListFromGrounding(grounding) {
  const seen = new Set();
  return (grounding.groundingChunks || []).map(chunk => chunk.web).filter(Boolean)
    .filter(web => web.uri && !seen.has(web.uri) && seen.add(web.uri))
    .map(web => ({ title: web.title || web.uri, url: web.uri }));
}

const RESEARCH_INSTRUCTIONS = `You are The Brain's careful web research planner. Use Google Search grounding to research the user's request. Do not invent sources, dates, evidence, or certainty. Clearly separate sourced facts, interpretations, disagreement, uncertainty, and unanswered questions. Search for authoritative primary sources and high-quality secondary sources when appropriate. Return ONLY valid JSON, without Markdown, matching this shape:
{
  "scope":"short statement of the research scope",
  "plan":["specific research question"],
  "summary":"neutral concise synthesis with source-aware qualification",
  "proposedNodes":[{"key":"short-id","title":"node label","type":"concept|person|event|place|question|evidence|source|task|idea","description":"what this represents and why it matters","priority":"critical|high|medium|low|informational|research_required|unclassified","confidence":"high|medium|low|unverified","sourceUrls":["only a URL you actually used"],"status":"fact|interpretation|question|uncertain"}],
  "relationships":[{"from":"short-id or ROOT","to":"short-id","relationship":"related_to|caused|influenced|supports|contradicts|created|participated_in|occurred_during|located_in|evidence_for|evidence_against|depends_on|similar_to|part_of","notes":"short explanation"}],
  "claims":[{"claim":"atomic, qualified claim","confidence":"high|medium|low|unverified","supportingUrls":["only a URL you actually used"],"disputingUrls":["only a URL you actually used"],"note":"scope, conflict or caveat"}],
  "conflicts":[{"topic":"what differs","description":"describe sources or interpretations that disagree","sourceUrls":["only URLs you actually used"]}],
  "gaps":[{"question":"specific next question","reason":"why current evidence is insufficient","priority":"critical|high|medium|low"}]
}
Limit proposedNodes to the 12 most useful and claims to the 8 most decision-relevant. Do not turn a source title into a factual claim. A URL may only be used if it is among grounded web results.`;

export async function research({ request, context }) {
  const userPrompt = `${RESEARCH_INSTRUCTIONS}\n\nUser research request: ${request}\n\nRelevant local Brain context (user-owned notes; it is not web evidence):\n${context || 'No relevant accepted nodes yet.'}\n\nFirst form a useful plan internally, search the web, compare the evidence, then return the JSON.`;
  const payload = {
    systemInstruction: { parts: [{ text: 'You are a rigorous research assistant. Be transparent about uncertainty and preserve evidence chains.' }] },
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    tools: [{ google_search: {} }],
    generationConfig: { temperature: 0.15, responseMimeType: 'application/json' }
  };
  // A few Gemini model releases reject responseMimeType in combination with a tool.
  // Keep a deliberate JSON-prompt fallback rather than downgrading the research to ungrounded output.
  let response;
  try { response = await generate(payload); }
  catch (error) {
    if (error.status !== 400) throw error;
    response = await generate({ ...payload, generationConfig: { temperature: 0.15 } });
  }
  const analysis = parseJson(response.text);
  const sources = sourceListFromGrounding(response.grounding);
  const allowed = new Set(sources.map(s => s.url));
  // Grounding metadata is the authority for links persisted by this application.
  for (const node of analysis.proposedNodes || []) node.sourceUrls = (node.sourceUrls || []).filter(url => allowed.has(url));
  for (const claim of analysis.claims || []) {
    claim.supportingUrls = (claim.supportingUrls || []).filter(url => allowed.has(url));
    claim.disputingUrls = (claim.disputingUrls || []).filter(url => allowed.has(url));
  }
  for (const conflict of analysis.conflicts || []) conflict.sourceUrls = (conflict.sourceUrls || []).filter(url => allowed.has(url));
  return { analysis, sources, queries: response.grounding.webSearchQueries || [], model: modelName() };
}

// A low-cost, real request used by the Settings screen. It verifies the exact capabilities
// The Brain needs: authentication, the configured model, and Google Search grounding.
const COLLECTED_SOURCE_INSTRUCTIONS = RESEARCH_INSTRUCTIONS
  .replace('You are The Brain\'s careful web research planner. Use Google Search grounding to research the user\'s request.', 'You are The Brain\'s careful source analyst. Use ONLY the provided source packets; do not perform an internet search or rely on an unseen source.')
  .replace('First form a useful plan internally, search the web, compare the evidence, then return the JSON.', 'Compare the provided material, state its limits, then return the JSON.')
  .replace('A URL may only be used if it is among grounded web results.', 'A URL may only be used if it is one of the provided source-packet URLs.');

function keepOnlyProvidedUrls(analysis, sources) {
  const allowed = new Set(sources.map(source => source.url));
  for (const node of analysis.proposedNodes || []) node.sourceUrls = (node.sourceUrls || []).filter(url => allowed.has(url));
  for (const claim of analysis.claims || []) {
    claim.supportingUrls = (claim.supportingUrls || []).filter(url => allowed.has(url));
    claim.disputingUrls = (claim.disputingUrls || []).filter(url => allowed.has(url));
  }
  for (const conflict of analysis.conflicts || []) conflict.sourceUrls = (conflict.sourceUrls || []).filter(url => allowed.has(url));
  return analysis;
}

// Analyses sources a person deliberately saved into the map. This is separate from
// discovery: no Google Search tool is supplied and no new URLs can be invented.
export async function analyseCollectedSources({ topic, sources, context }) {
  const packets = (sources || []).slice(0, 10).map((source, index) => ({
    number: index + 1, title: source.title, url: source.url, website: source.website,
    author: source.author || '', publishedDate: source.published_date || '', sourceType: source.source_type || '',
    reliability: source.reliability || '', collectionStatus: source.collection_status || '',
    extract: (source.extracted_text || source.relevant_passage || '').slice(0, 5000)
  }));
  if (!packets.length) { const error = new Error('Save at least one source before asking Gemini to build a source-based map.'); error.status = 400; throw error; }
  const payload = {
    systemInstruction: { parts: [{ text: 'You are a rigorous, source-bounded research analyst. Never claim to have searched or read material outside the packets supplied by the user.' }] },
    contents: [{ role: 'user', parts: [{ text: `${COLLECTED_SOURCE_INSTRUCTIONS}\n\nResearch topic: ${topic}\n\nRelevant local Brain context (not external evidence):\n${context || 'None.'}\n\nProvided source packets:\n${JSON.stringify(packets)}\n\nBuild cautious, source-linked proposed thoughts and relationships only from this material.` }] }],
    generationConfig: { temperature: 0.15, responseMimeType: 'application/json' }
  };
  let response;
  try { response = await generate(payload); }
  catch (error) {
    if (error.status !== 400) throw error;
    response = await generate({ ...payload, generationConfig: { temperature: 0.15 } });
  }
  return { analysis: keepOnlyProvidedUrls(parseJson(response.text), sources), sources, queries: [], model: modelName() };
}

export async function testConnection() {
  const response = await generate({
    contents: [{ role: 'user', parts: [{ text: 'Use Google Search to find NASA’s official website, then reply with the single word READY.' }] }],
    tools: [{ google_search: {} }],
    generationConfig: { temperature: 0, maxOutputTokens: 16 }
  });
  return {
    connected: true,
    model: modelName(),
    reply: response.text.trim(),
    groundedSourceCount: (response.grounding.groundingChunks || []).filter(chunk => chunk.web).length
  };
}

export async function assistantReply({ question, context, allowWeb = false }) {
  const instructions = `You are The Brain's research assistant. The supplied local graph may contain user notes, researched facts, source records, and open questions. Treat user notes as user-provided, not independently verified. Explain the provenance of any conclusion. Never make up citations or claim to have visited a source you have not received. If evidence is weak, say so. Respond in concise Markdown with headings or bullets where useful.`;
  const response = await generate({
    systemInstruction: { parts: [{ text: instructions }] },
    contents: [{ role: 'user', parts: [{ text: `Question: ${question}\n\nRelevant Brain context:\n${context || 'No relevant local context.'}` }] }],
    tools: allowWeb ? [{ google_search: {} }] : undefined,
    generationConfig: { temperature: 0.3 }
  });
  return { text: response.text, sources: sourceListFromGrounding(response.grounding), queries: response.grounding.webSearchQueries || [], model: modelName() };
}

export async function createDocument({ title, documentType, instructions, context }) {
  const response = await generate({
    systemInstruction: { parts: [{ text: 'You create useful research documents in Markdown. Use only the supplied Brain context. Clearly mark unknowns, avoid invented citations and distinguish user notes from sourced evidence.' }] },
    contents: [{ role: 'user', parts: [{ text: `Create a ${documentType || 'research brief'} titled “${title}”.\n\nUser instructions: ${instructions || 'Create a concise, well-structured document.'}\n\nRelevant Brain context:\n${context || 'No saved context.'}` }] }],
    generationConfig: { temperature: 0.25 }
  });
  return { text: response.text, model: modelName() };
}

export async function analyzeFile({ filePath, mimeType, filename, prompt, context }) {
  const stat = await fs.stat(filePath);
  if (stat.size > 18 * 1024 * 1024) {
    const error = new Error('This local file is larger than 18 MB. Use a smaller file for inline Gemini analysis; a Gemini Files API adapter can be added for larger media.');
    error.status = 413; throw error;
  }
  const bytes = await fs.readFile(filePath);
  const response = await generate({
    systemInstruction: { parts: [{ text: 'You analyze user-provided research material. State only what can reasonably be inferred from the file and mark uncertainty. Return clear Markdown, no invented external citations.' }] },
    contents: [{ role: 'user', parts: [
      { text: `Analyze the user file “${filename}”. ${prompt || 'Extract key entities, claims, questions, and useful knowledge-map nodes.'}\nExisting local context:\n${context || 'None.'}` },
      { inlineData: { mimeType: mimeType || 'application/octet-stream', data: bytes.toString('base64') } }
    ] }],
    generationConfig: { temperature: 0.2 }
  });
  return { text: response.text, model: modelName() };
}
