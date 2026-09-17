/*
  Topic-centred research engine.

  This module deliberately ranks documents and extracts only source quotations. It
  does not generate factual claims from search titles, and it does not call Gemini.
  Optional Gemini synthesis remains a separate, source-bounded review action.
*/
const STOP_WORDS = new Set([
  'a','an','the','and','or','of','for','to','in','on','with','from','by','at','as','is','are','was','were','be','this','that','these','those','what','how','why','when','where','who','about','into','through','using','use','new','study','studies','analysis','report','article','paper','guide','overview','introduction','did','does','do','can','could','would','should','will','it','its','their','than','then','also','more','most','less','very'
]);

export const DEFAULT_RESEARCH_CONFIG = Object.freeze({
  DIRECT_RELEVANCE_WEIGHT: 35,
  INTENT_MATCH_WEIGHT: 20,
  SPECIFICITY_WEIGHT: 15,
  EVIDENCE_WEIGHT: 10,
  AUTHORITY_WEIGHT: 10,
  BRANCH_IMPORTANCE_WEIGHT: 10,
  DISTANCE_PENALTIES: [0, 5, 15, 30, 50],
  MIN_RELEVANCE_SCORE: 42,
  MAX_DISCOVERY_SOURCES: 18,
  MAX_SELECTED_SOURCES: 8,
  MAX_SOURCES_PER_BRANCH: 3,
  MAX_RESEARCH_CYCLES: 2,
  MAX_TARGETED_QUERIES: 1,
  MAX_OUTWARD_DISTANCE: 3,
  MAX_CLAIMS: 12,
  CLAIM_RELEVANCE_THRESHOLD: 48,
  STOP_INFORMATION_GAIN: 0.12,
  AUTO_TARGETED_CYCLES: true
});

export function researchConfig(overrides = {}) {
  return { ...DEFAULT_RESEARCH_CONFIG, ...(overrides && typeof overrides === 'object' ? overrides : {}) };
}

function normalise(value = '') {
  return String(value).toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}
function terms(value = '') {
  return [...new Set(normalise(value).split(' ').filter(word => word.length > 1 && !STOP_WORDS.has(word)))];
}
function titleCase(value = '') { return String(value).replace(/\b\w/g, letter => letter.toUpperCase()); }
function overlap(left = [], right = []) {
  if (!left.length || !right.length) return 0;
  const rightSet = new Set(right); return left.filter(word => rightSet.has(word)).length / left.length;
}
function clamp(value, min = 0, max = 100) { return Math.max(min, Math.min(max, value)); }
const CONTEXT_GENERIC_TERMS = new Set(['belief','beliefs','doctrine','faith','religion','religious','church','history','work','works','topic','information','overview','general','basic','basics','concept','concepts','theory','practice','practices']);
function contextTerms(value = '') { return terms(value).filter(word=>!CONTEXT_GENERIC_TERMS.has(word)); }
function contextTermMatches(term, sourceTerms = new Set()) {
  if(sourceTerms.has(term))return true;
  // Recognised aliases prevent an acronym in a saved parent context from excluding
  // a directly named source. This is entity resolution, not a source or topic list.
  if(term==='lds')return ['mormon','latter','saint','saints'].some(alias=>sourceTerms.has(alias));
  return false;
}
function sourceContextSupport(source = {}, context = '') {
  const required=contextTerms(context); if(!required.length)return {required:false,score:1};
  const aliases=Array.isArray(source.metadata?.contextAliases)?source.metadata.contextAliases.join(' '):'';
  const available=new Set(terms(`${source.title || ''} ${source.snippet || source.relevant_passage || ''} ${(source.extractedText || source.extracted_text || '').slice(0,3600)} ${aliases}`));
  const matched=required.filter(term=>contextTermMatches(term,available));
  return {required:true,score:matched.length/required.length};
}

function classifyInput(input = '') {
  const value=normalise(input);
  if (/\b(?:why|cause|causes|fall|contribute|led to|result of)\b/.test(value)) return 'historical_or_causal';
  if (/\b(?:how does|how do|how did|mechanism|process|works?\s+(?:by|through|via|in))\b/.test(value)) return 'mechanism';
  if (/\b(?:who is|who was|biography|life|person)\b/.test(value)) return 'person';
  if (/\b(?:evidence|study|studies|scientific|science|experiment|research)\b/.test(value)) return 'scientific';
  if (/\b(?:technology|software|system|device|engineering|algorithm)\b/.test(value)) return 'technology';
  if (/\b(?:belief|beliefs|doctrine|religion|religious|theology|church|faith)\b/.test(value)) return 'beliefs_or_doctrine';
  if (/\b(?:recipe|recipes|cake|cook|cooking|bake|baking|food)\b/.test(value)) return 'practical_or_recipe';
  if (/\b(?:what is|what are|define|definition)\b/.test(value)) return 'definition';
  return 'general';
}

const QUESTION_TREES = {
  historical_or_causal: [
    ['What happened?', ['event','timeline','when']], ['Direct causes', ['cause','causes','factor','why','political','economic','military','social','migration','external','crisis']], ['Evidence', ['evidence','source','record','primary']], ['Competing explanations', ['debate','interpretation','disputed']], ['Consequences', ['impact','consequence','result']]
  ],
  mechanism: [
    ['Definition', ['definition','what']], ['How it works', ['mechanism','process','how']], ['Core components', ['component','part','system']], ['Evidence', ['evidence','study','experiment']], ['Limitations', ['limit','risk','uncertainty']]
  ],
  person: [
    ['Identity and background', ['born','background','early']], ['Major actions', ['work','action','career']], ['Achievements', ['achievement','contribution','award']], ['Influence', ['influence','legacy','impact']], ['Evidence and interpretation', ['source','evidence','interpretation']]
  ],
  scientific: [
    ['Definition', ['definition','what']], ['Mechanism', ['mechanism','process','how']], ['Evidence', ['evidence','study','experiment','data']], ['Results', ['result','finding']], ['Limitations and uncertainty', ['limitation','uncertainty','risk','debate']]
  ],
  technology: [
    ['Definition', ['definition','what']], ['How it works', ['mechanism','architecture','component']], ['Development', ['history','development']], ['Advantages', ['benefit','advantage']], ['Limitations', ['limitation','risk','challenge']], ['Current state', ['current','latest','deployment']]
  ],
  beliefs_or_doctrine: [
    ['Core beliefs and purpose', ['belief','doctrine','teaching','god','jesus','plan','salvation']], ['First principles and ordinances', ['principle','faith','repentance','baptism','ordinance','gospel']], ['Scripture, prophets and revelation', ['scripture','bible','text','prophet','revelation']], ['Priesthood, worship and covenants', ['priesthood','ordinance','temple','covenant','worship']], ['Community and service', ['missionary','service','community']], ['Different interpretations', ['interpretation','beliefs','history']]
  ],
  practical_or_recipe: [
    ['Main variations', ['type','variation','recipe']], ['Core ingredients', ['ingredient','base']], ['Method', ['method','how','step']], ['Useful constraints', ['easy','diet','allergy','time']], ['Reliable sources', ['recipe','source','test']]
  ],
  definition: [
    ['Definition', ['definition','meaning','what']], ['How it works', ['process','mechanism','how']], ['Evidence', ['evidence','source']], ['Limits and uncertainty', ['limit','uncertainty','exception']]
  ],
  general: [
    ['Definition and scope', ['definition','scope','what']], ['Direct information', ['main','key','important']], ['Evidence', ['evidence','source','data']], ['Different views', ['debate','interpretation','disputed']], ['Limits and unanswered questions', ['limit','uncertainty','unknown']]
  ]
};

export function analyseTopic(input = '') {
  const mainTopic=String(input).replace(/\s+/g,' ').trim().slice(0,300);
  const type=classifyInput(mainTopic); const importantTerms=terms(mainTopic);
  const tree=(QUESTION_TREES[type] || QUESTION_TREES.general).map(([label,keywords], index) => ({ id:`branch-${index + 1}`, label, keywords:[...new Set(keywords)], distance:index < 3 ? 1 : 2 }));
  const intent=type==='historical_or_causal'?'explain causes and evidence':type==='mechanism'?'explain how the subject works':type==='person'?'identify and explain the person’s major actions and influence':type==='practical_or_recipe'?'identify useful variations and practical options':type==='beliefs_or_doctrine'?'identify foundational beliefs, practices and primary texts':type==='definition'?'define and explain the subject':`understand ${mainTopic}`;
  const timePeriod=(mainTopic.match(/\b(?:\d{3,4}s?|ancient|medieval|modern|current|today|recent|late|early)\b/gi)||[]).join(', ');
  return {
    mainTopic, type, userIntent:intent, importantTerms, timePeriod,
    location:'', people:[], events:[], concepts:importantTerms,
    expectedOutput:'A focused, source-supported understanding that separates evidence, interpretation, uncertainty and unresolved questions.',
    tree,
    assumptions:['Topic structure is heuristic until public sources are collected; it is not a factual conclusion.']
  };
}

function authorityFor(source = {}) {
  const provider=normalise(source.provider || source.metadata?.discovery || '');
  const url=String(source.url || '').toLowerCase(); const kind=normalise(source.kind || source.source_type || '');
  if (/\.gov(?:\/|$)|government|official government/.test(url + ' ' + provider)) return 92;
  if (/churchofjesuschrist\.org/.test(url) && /official|primary/.test(provider)) return 88;
  if (/\.edu(?:\/|$)|university/.test(url + ' ' + provider)) return 87;
  if (/openalex|crossref/.test(provider) || /journal|peer reviewed/.test(kind)) return 83;
  if (/arxiv/.test(provider)) return 71;
  if (/wikipedia/.test(provider)) return 67;
  if (/internet archive/.test(provider)) return 58;
  if (/official|association|institution|museum|library/.test(url + ' ' + provider)) return 72;
  return 48;
}
function evidenceFor(source = {}) {
  const kind=normalise(source.kind || source.source_type || ''); const text=String(source.extractedText || source.extracted_text || source.snippet || source.relevant_passage || '');
  const structure=Array.isArray(source.metadata?.sections)?source.metadata.sections.length:0;
  let score=/paper|journal|document/.test(kind)?82:/book/.test(kind)?66:55;
  if (text.length>1800) score+=8; else if(text.length>240) score+=4;
  if (structure>=5) score+=7; else if(structure>=2) score+=3;
  if (/\b(?:references|bibliography|citation|sources)\b/i.test(text)) score+=5;
  return clamp(score,0,95);
}
function sourceDistance(direct, intent, specificity) {
  if (direct>=.68 && specificity>=.35) return 0;
  if (direct>=.55 || intent>=.62) return 1;
  if (direct>=.3) return 2;
  if (direct>=.15) return 3;
  return 4;
}
function whyRelevant(source, score) {
  const reasons=[];
  if(score.direct>=.55)reasons.push('directly names key topic terms');
  if(score.intent>=.45)reasons.push('matches the research intent');
  if(score.specificity>=.5)reasons.push('is specific rather than a passing mention');
  if(score.authority>=75)reasons.push('comes from a higher-authority source type');
  if(score.evidence>=75)reasons.push('has stronger evidence signals');
  return reasons.length?reasons.join('; '):'retained as a lower-priority lead for review';
}

export function scoreSource(source, topic, branch = null, config = DEFAULT_RESEARCH_CONFIG) {
  const inputTerms=topic.importantTerms || terms(topic.mainTopic); const branchTerms=branch?.keywords || [];
  const titleTerms=terms(source.title || ''); const sourceHeadings=Array.isArray(source.metadata?.sections)?source.metadata.sections.join(' '):''; const snippetTerms=terms(`${source.snippet || source.relevant_passage || ''} ${(source.extractedText || source.extracted_text || '').slice(0,2400)} ${sourceHeadings}`);
  const headingMatch=overlap(inputTerms,terms(sourceHeadings));
  const direct=clamp(overlap(inputTerms,titleTerms)*.72 + overlap(inputTerms,snippetTerms)*.28 + (source.metadata?.directFocusSource?headingMatch*.5:0),0,1);
  const intent=clamp(overlap(branchTerms,snippetTerms)*.65 + overlap(branchTerms,titleTerms)*.35,0,1);
  const structure=Array.isArray(source.metadata?.sections)?source.metadata.sections.length:0;
  const specificity=clamp((titleTerms.length?overlap(titleTerms,inputTerms):0)*.55 + Math.min(1,snippetTerms.length/28)*.2 + Math.min(1,(source.extractedText || source.extracted_text || '').length/3500)*.15 + Math.min(1,structure/12)*.1,0,1);
  const authority=authorityFor(source); const evidence=evidenceFor(source); const distance=sourceDistance(direct,intent,specificity);
  const context=sourceContextSupport(source,topic.context || '');
  const distancePenalty=(config.DISTANCE_PENALTIES || DEFAULT_RESEARCH_CONFIG.DISTANCE_PENALTIES)[Math.min(distance,4)] ?? 50;
  const directFocusSource=Boolean(source.metadata?.directFocusSource);
  const relevance=clamp(
    direct*config.DIRECT_RELEVANCE_WEIGHT + intent*config.INTENT_MATCH_WEIGHT + specificity*config.SPECIFICITY_WEIGHT +
    (evidence/100)*config.EVIDENCE_WEIGHT + (authority/100)*config.AUTHORITY_WEIGHT + (branch?Math.min(1,intent+.15)*config.BRANCH_IMPORTANCE_WEIGHT:0) +
    (context.required?context.score*8:0) + (directFocusSource?22:0) - distancePenalty
  );
  const score={ relevance:Math.round(relevance), direct:Math.round(direct*100), intent:Math.round(intent*100), specificity:Math.round(specificity*100), authority, evidence, distance, context:Math.round(context.score*100), directFocusSource };
  return {...score, why:whyRelevant(source,score), accepted:score.relevance>=config.MIN_RELEVANCE_SCORE && score.distance<=config.MAX_OUTWARD_DISTANCE && (!context.required || context.score>=.34)};
}

function canonicalTitle(value='') { return normalise(value).split(' ').filter(word=>!STOP_WORDS.has(word)).join(' '); }
function sourceLineage(source={}) {
  try { const host=new URL(source.url).hostname.replace(/^www\./,''); return host; } catch { return normalise(source.website || source.provider || 'unknown'); }
}

export function rankSources(sources = [], topic, config = DEFAULT_RESEARCH_CONFIG) {
  const seenUrl=new Set(); const byTitle=new Map(); const evaluated=[];
  for (const source of sources.slice(0,config.MAX_DISCOVERY_SOURCES)) {
    if(!source?.url || source.kind==='image' || seenUrl.has(source.url))continue; seenUrl.add(source.url);
    const scores=(topic.tree || []).map(branch=>({branch,score:scoreSource(source,topic,branch,config)}));
    const best=scores.sort((left,right)=>right.score.relevance-left.score.relevance)[0];
    const research={...best.score, branch:best.branch?.label || 'Direct information', lineage:sourceLineage(source), candidate:true};
    const value={...source,research}; const titleKey=canonicalTitle(source.title);
    const existing=byTitle.get(titleKey);
    if(existing && existing.research.relevance>=research.relevance)continue;
    if(existing){const index=evaluated.indexOf(existing);if(index>=0)evaluated.splice(index,1);}
    byTitle.set(titleKey,value); evaluated.push(value);
  }
  const ranked=evaluated.sort((left,right)=>right.research.relevance-left.research.relevance || right.research.authority-left.research.authority);
  const selected=[]; const perLineage=new Map();
  for(const source of ranked){
    const count=perLineage.get(source.research.lineage)||0;
    if(!source.research.accepted || count>=config.MAX_SOURCES_PER_BRANCH)continue;
    selected.push(source); perLineage.set(source.research.lineage,count+1);
    if(selected.length>=config.MAX_SELECTED_SOURCES)break;
  }
  return { ranked, selected, rejected:ranked.filter(source=>!selected.includes(source)), independentLineages:[...new Set(selected.map(source=>source.research.lineage))] };
}

function sentenceList(text='') {
  return String(text).replace(/\s+/g,' ').match(/[^.!?]+[.!?]+|[^.!?]+$/g)?.map(value=>value.trim()).filter(value=>value.length>=35&&value.length<=420) || [];
}
function claimKey(value='') { return normalise(value).split(' ').filter(word=>word.length>2&&!STOP_WORDS.has(word)).slice(0,28).join(' '); }
function sentenceRelevance(sentence, topic, source) {
  const sourceScore=Number(source.research?.relevance || 0); const hit=overlap(topic.importantTerms || [],terms(sentence)); return Math.round(clamp(sourceScore*.65+hit*35));
}

export function extractSourceClaims(sources = [], topic, config = DEFAULT_RESEARCH_CONFIG) {
  const grouped=new Map();
  for(const source of sources){
    const text=source.extracted_text || source.extractedText || source.relevant_passage || source.snippet || '';
    const sentences=sentenceList(text); const best=sentences.map(sentence=>({sentence,score:sentenceRelevance(sentence,topic,source)})).filter(item=>item.score>=config.CLAIM_RELEVANCE_THRESHOLD).sort((a,b)=>b.score-a.score).slice(0,4);
    for(const item of best){
      const key=claimKey(item.sentence); if(key.length<10)continue;
      const group=grouped.get(key)||{key,statement:item.sentence,relevance:item.score,sources:[],duplicateCount:0};
      group.sources.push({sourceId:source.id || '',url:source.url,title:source.title,excerpt:item.sentence,lineage:source.research?.lineage || sourceLineage(source)});
      group.relevance=Math.max(group.relevance,item.score); group.duplicateCount=group.sources.length-1; grouped.set(key,group);
    }
  }
  const claims=[...grouped.values()].map(claim=>{
    const lineages=new Set(claim.sources.map(source=>source.lineage));
    const confidence=lineages.size>=3?'medium':lineages.size>=2?'low':'unverified';
    return {...claim,independentSupport:lineages.size,confidence,sourceCount:claim.sources.length};
  }).sort((a,b)=>b.relevance-a.relevance || b.independentSupport-a.independentSupport).slice(0,config.MAX_CLAIMS);
  return claims;
}

export function detectPotentialConflicts(claims = []) {
  const negative=/\b(?:not|no|never|unlikely|disputed|controversial|uncertain|however|but)\b/i;
  const conflicts=[];
  for(let i=0;i<claims.length;i++)for(let j=i+1;j<claims.length;j++){
    const left=claims[i],right=claims[j]; const shared=overlap(terms(left.statement),terms(right.statement));
    if(shared<.38 || negative.test(left.statement)===negative.test(right.statement))continue;
    conflicts.push({leftKey:left.key,rightKey:right.key,status:'needs review',reason:'Two source quotations share substantial terminology but use different certainty/negation language. This is a possible conflict, not a concluded contradiction.'});
    if(conflicts.length>=6)return conflicts;
  }
  return conflicts;
}

export function findKnowledgeGaps(topic, sources = [], claims = []) {
  const coverageText=`${sources.map(source=>`${source.title||''} ${source.snippet||source.relevant_passage||''}`).join(' ')} ${claims.map(claim=>claim.statement).join(' ')}`;
  const coverageTerms=terms(coverageText); const gaps=[];
  for(const branch of topic.tree || []){
    const match=overlap(branch.keywords,coverageTerms);
    if(match<.23)gaps.push({branch:branch.label,coverage:Math.round(match*100),question:`What reliable evidence addresses ${branch.label.toLowerCase()} for ${topic.mainTopic}?`,query:`${topic.mainTopic} ${branch.label} evidence`});
  }
  return gaps.slice(0,5);
}

export function shouldRunTargetedCycle(topic, ranking, gaps, config = DEFAULT_RESEARCH_CONFIG) {
  if(!config.AUTO_TARGETED_CYCLES || config.MAX_RESEARCH_CYCLES<2)return false;
  if(!['historical_or_causal','scientific','mechanism','technology','beliefs_or_doctrine'].includes(topic.type))return false;
  if(!ranking.selected.length || !gaps.length)return false;
  return ranking.selected.some(source=>source.research.relevance>=65);
}

export function researchSummary(topic, ranking, claims, gaps, conflicts, cycles = []) {
  const high=ranking.selected.filter(source=>source.research.relevance>=70).length;
  const lineages=ranking.independentLineages.length;
  return {
    topic:topic.mainTopic, intent:topic.userIntent, researchType:topic.type,
    highRelevanceSources:high, selectedSources:ranking.selected.length, independentLineages:lineages,
    sourceQuotedClaims:claims.length, duplicatesMerged:claims.reduce((count,claim)=>count+claim.duplicateCount,0),
    possibleConflicts:conflicts.length, openGaps:gaps.length, cycles,
    status:gaps.length?'focused but incomplete':'initial focused coverage complete',
    synthesisNotice:'No final factual synthesis is produced automatically. Review source-linked claims or request the separate source-bounded Gemini analysis.'
  };
}

export function planTargetedQueries(gaps = [], config = DEFAULT_RESEARCH_CONFIG) {
  return gaps.slice(0,config.MAX_TARGETED_QUERIES).map(gap=>({query:gap.query,reason:`The initial source pass did not adequately cover ${gap.branch.toLowerCase()}.`}));
}
