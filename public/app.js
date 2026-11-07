/* The Brain client: search and reading only — this application has no AI layer.
   All public-index searches, page reads and file access stay behind /api, and every
   viewer (dictionary, Wikipedia, web, image, video, audio, document) is built here. */
const state = { project: null, graph: { nodes: [], connections: [], sources: [], queue: [] }, selectedId: null, centerId: null, focusScopeId: null, focusBranchIds: new Set(), mediaView: null, reader: null, scale: 1, mode: 'web', status: null, drag: null, expandingNodeId: null, camera: { x:0, y:0, z:0, yaw:0, pitch:0, panX:0, panY:0 }, projections: new Map() };
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const icons = { dictionary:'Aa', article:'W', book:'📚', paper:'📄', music:'♪', idea:'📝', concept:'◈', website:'🌐', image:'🖼', document:'📄', video:'🎬', person:'👤', event:'📅', place:'⌖', question:'?', evidence:'🔎', task:'☑', source:'📚' };
const typeNames = { dictionary:'Dictionary entry', article:'Article', idea:'Idea', concept:'Concept', website:'Website', image:'Image', document:'Document', video:'Video', person:'Person', event:'Event', place:'Place', question:'Question', evidence:'Evidence', task:'Task', source:'Source' };
const relationshipNames = { related_to:'related to', caused:'caused', influenced:'influenced', supports:'supports', contradicts:'contradicts', created:'created', participated_in:'participated in', occurred_during:'occurred during', located_in:'located in', evidence_for:'evidence for', evidence_against:'evidence against', depends_on:'depends on', similar_to:'similar to', part_of:'part of', documents:'documents' };

function esc(value='') { return String(value).replace(/[&<>'"]/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#039;','"':'&quot;'}[char])); }
function safeUrl(url='') { try { const parsed = new URL(url); return ['https:','http:'].includes(parsed.protocol) ? parsed.href : '#'; } catch { return '#'; } }
function text(value='') { return esc(value).replace(/\n/g, '<br>'); }
function brief(value='', max=180) { const str=String(value); return str.length > max ? `${str.slice(0,max - 1)}…` : str; }
function friendly(value='') { return String(value).replaceAll('_',' '); }
const MAP_LABEL_STOP_WORDS=new Set(['the','a','an','and','or','of','for','to','in','on','with','from','by','at','as','is','are','was','were','be','this','that','these','those','what','how','why','when','where','who','about','into','through','using','use','new','study','studies','analysis','report','article','paper','guide','overview','introduction']);
function mapLabel(value='', fallback='Research topic') { const words=String(value).replace(/https?:\/\/\S+/g,'').replace(/[^\p{L}\p{N}'’-]+/gu,' ').trim().split(/\s+/).filter(word=>word.length>1&&!MAP_LABEL_STOP_WORDS.has(word.toLowerCase())); return (words.slice(0,5).join(' ')||fallback).slice(0,80); }
function sourceReferenceList(source) {
  const links=[...new Set((source.metadata?.outboundLinks || []).filter(url=>safeUrl(url)!=='#'))].slice(0,6); if(!links.length)return '';
  return `<details class="source-references"><summary>${links.length} linked reference${links.length===1?'':'s'} on this source</summary>${links.map(url=>{let label=url;try{label=new URL(url).hostname;}catch{}const safe=safeUrl(url);return `<div><a href="${safe}" target="_blank" rel="noreferrer">${esc(label)} ↗</a><button type="button" data-add-reference="${esc(safe)}">Add</button></div>`;}).join('')}</details>`;
}
async function addLinkedReference(url, node, button) {
  if(!url || url==='#')return; const original=button.textContent; button.disabled=true;button.textContent='Adding…';
  try { const parsed=new URL(url); await api(`/api/projects/${state.project.id}/sources/import`,{method:'POST',body:JSON.stringify({url,title:parsed.hostname,website:parsed.hostname,sourceType:'website',query:researchQueryForNode(node),targetNodeId:node.id,provider:'Linked reference',deferCollection:true})}); button.textContent='Added';await loadGraph();toast('Linked public reference saved to the knowledge web.','success'); }
  catch(error){button.disabled=false;button.textContent=original;toast(error.message,'error');}
}
const typingAssistState={timer:null,request:0,items:[],active:-1};
function hideTypingAssist(host) { if(host){host.hidden=true;host.replaceChildren();} typingAssistState.items=[];typingAssistState.active=-1; }
function applyTypingSuggestion(input, host, value) { input.value=value; hideTypingAssist(host); input.focus(); input.dispatchEvent(new Event('input',{bubbles:true})); }
function renderTypingAssist(input, host, result) {
  const correction=result.correction?.title; const suggestions=(result.suggestions||[]).filter(item=>item.title!==correction).slice(0,5); const items=[...(correction?[{title:correction,kind:'correction'}]:[]),...suggestions];
  if(!items.length){hideTypingAssist(host);return;} typingAssistState.items=items;typingAssistState.active=-1;
  host.innerHTML=`${correction?'<span class="assist-label">Possible spelling correction</span>':''}${!correction?'<span class="assist-label">Suggested topics</span>':''}${items.map((item,index)=>`<button type="button" class="${item.kind==='correction'?'assist-correction':''}" data-typing-suggestion="${index}" role="option">${item.kind==='correction'?`Did you mean <b>${esc(item.title)}</b>?`:esc(item.title)}${item.kind==='correction'?'<small>Select to use this spelling</small>':''}</button>`).join('')}`;
  host.hidden=false; host.querySelectorAll('[data-typing-suggestion]').forEach(button=>{button.onpointerdown=event=>event.preventDefault();button.onclick=()=>applyTypingSuggestion(input,host,items[Number(button.dataset.typingSuggestion)]?.title||'');});
}
function requestTypingAssist(input, host) {
  clearTimeout(typingAssistState.timer); const query=input.value.trim(); if(query.length<2){hideTypingAssist(host);return;} const request=++typingAssistState.request;
  typingAssistState.timer=setTimeout(async()=>{try{const result=await api(`/api/typing-suggestions?q=${encodeURIComponent(query)}`);if(request!==typingAssistState.request||input.value.trim()!==query)return;renderTypingAssist(input,host,result);}catch{if(request===typingAssistState.request)hideTypingAssist(host);}},220);
}
function setupTypingAssist(input, host) {
  if(!input||!host)return; input.spellcheck=true;
  input.addEventListener('input',()=>requestTypingAssist(input,host));
  input.addEventListener('keydown',event=>{const buttons=[...host.querySelectorAll('[data-typing-suggestion]')];if(!buttons.length)return;if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();typingAssistState.active=(typingAssistState.active+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length;buttons.forEach((button,index)=>button.classList.toggle('assist-active',index===typingAssistState.active));return;}if((event.key==='Enter'||event.key==='Tab')&&typingAssistState.active>=0){event.preventDefault();applyTypingSuggestion(input,host,typingAssistState.items[typingAssistState.active]?.title||'');}if(event.key==='Escape')hideTypingAssist(host);});
  input.addEventListener('blur',()=>setTimeout(()=>hideTypingAssist(host),160));
}
function api(path, options={}) {
  // The workspace file renderer has no network access. Its explicitly marked preview
  // adapter supports local graph interactions but never fabricates web/AI research.
  if (window.__THE_BRAIN_STATIC_PREVIEW__ && window.previewApi) return window.previewApi(path, options);
  return fetch(path, { headers: { 'content-type':'application/json', ...(options.headers || {}) }, ...options }).then(async response => { const body = await response.json().catch(() => ({})); if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`); return body; });
}
function toast(message, kind='') { const el=document.createElement('div'); el.className=`toast ${kind}`; el.textContent=message; $('#toast-region').append(el); setTimeout(()=>el.remove(),4300); }
function modePlaceholder() { return ({web:'Search public sources by keyword…',wikipedia:'Read a Wikipedia article…',dictionary:'Look up a word…',media:'Find images, video or audio…'})[state.mode] || 'Search public sources…'; }
function setBusy(busy, label='') { const button=$('#send-button'); button.disabled=busy; button.innerHTML=busy ? '<span class="spin">◌</span>' : '<span>↑</span>'; $('#command-input').disabled=busy; $('#command-input').placeholder=busy && label ? label : modePlaceholder(); }
function showResearchProgress(topic, phase='starting', summary=null) {
  const panel=$('#research-progress'); if(!panel)return;
  const rows=phase==='complete'?[['Understanding the main point','✓'],['Building a focused question tree','✓'],['Finding and ranking public sources','✓'],['Extracting source quotations and checking gaps','✓']]:[['Understanding the main point','✓'],['Building a focused question tree','✓'],['Finding and ranking public sources','…'],['Reading high-value source material','…'],['Checking duplicates, conflicts and gaps','…']];
  panel.hidden=false; panel.innerHTML=`<p class="research-progress-kicker">RESEARCHING</p><h2>${esc(mapLabel(topic))}</h2><div class="research-progress-steps">${rows.map(([label,status])=>`<div><span>${status}</span>${esc(label)}</div>`).join('')}</div>${summary?`<p class="research-progress-summary">${esc(summary)}</p>`:''}`;
}
function hideResearchProgress(delay=0) { const panel=$('#research-progress'); if(!panel)return; clearTimeout(panel._hideTimer); if(delay)panel._hideTimer=setTimeout(()=>{panel.hidden=true;panel.replaceChildren();},delay);else{panel.hidden=true;panel.replaceChildren();} }
function renderApiStatus() { const status=$('#api-status'); const sources=(state.status?.webSearch?.sources||[]).length; status.classList.add('ready'); status.querySelector('span:last-child').textContent=sources ? `${sources} source indexes · no key` : 'Search ready'; status.title=(state.status?.webSearch?.sources||[]).join(', '); }
async function bootstrap() {
  try {
    state.status = await api('/api/status');
    renderApiStatus();
    const projects=await api('/api/projects'); state.project=projects[0];
    if (!state.project) throw new Error('No project could be created.');
    await loadGraph();
  } catch (error) { toast(error.message,'error'); }
}
async function loadGraph() {
  if (!state.project) return;
  state.graph=await api(`/api/projects/${state.project.id}/graph`);
  state.project=state.graph.project;
  $('#project-title').textContent=state.project.name;
  const hasNodes=state.graph.nodes.length>0;
  document.body.classList.toggle('is-empty',!hasNodes);
  if (!hasNodes) document.body.classList.remove('initial-search-running');
  $('#map-title').textContent=hasNodes ? state.project.name : 'Start a line of inquiry';
  $('#map-subtitle').textContent=hasNodes ? 'The centred focus word is surrounded by links, evidence, and original sources. Left-click a card to centre it and grow a fresh, source-backed layer around that item; right-click for information and actions.' : 'Begin with one idea. Your source-aware network will grow from there.';
  const sourceBadge=$('#source-badge'), queueBadge=$('#queue-badge'); if(sourceBadge) sourceBadge.textContent=state.graph.sourceCount || 0; if(queueBadge) queueBadge.textContent=(state.graph.queue || []).length;
  buildTwoDimensionalLayout();
  if (hasNodes) fitMap();
  renderMap();
  if (state.selectedId && !state.graph.nodes.some(node => node.id===state.selectedId)) selectNode(null);
}
function mapRect() {
  const rect=$('#canvas-wrap').getBoundingClientRect();
  return { ...rect, width:rect.width || 1200, height:rect.height || 760 };
}
function edgeKey(a, b) { return [a,b].sort().join('::'); }
function defaultMapCentre(nodes, connections) {
  const degree=new Map(nodes.map(node=>[node.id,0]));
  connections.forEach(edge=>{degree.set(edge.from_node_id,(degree.get(edge.from_node_id)||0)+1);degree.set(edge.to_node_id,(degree.get(edge.to_node_id)||0)+1);});
  return [...nodes].sort((a,b)=>{
    const aRoot=['neural-root','discovery-root'].includes(a.metadata?.role)||Number(a.metadata?.generation)===0;
    const bRoot=['neural-root','discovery-root'].includes(b.metadata?.role)||Number(b.metadata?.generation)===0;
    return Number(bRoot)-Number(aRoot)||(degree.get(b.id)||0)-(degree.get(a.id)||0)||a.title.localeCompare(b.title);
  })[0] || null;
}
function isMapCard(node) {
  // These records preserve source lineage for the inspector, but are not independent
  // concepts. Showing a cloned “Topic overview/source” card for every topic makes the
  // visible web read as repetition rather than research.
  return !['neural-basic-evidence','neural-basic-source','neural-evidence','neural-source','neural-topic-detail','neural-topic-source'].includes(node.metadata?.role);
}
function mapCards() {
  const cards=(state.graph.nodes || []).filter(isMapCard); if(!state.focusScopeId)return cards;
  const byId=new Map(cards.map(node=>[node.id,node]));
  if(!byId.has(state.focusScopeId)) { state.focusScopeId=null; state.focusBranchIds.clear(); return cards; }
  // The server returns the exact branch IDs created by this search. Keep those cards
  // visible even if a legacy saved card has imperfect old metadata; current and future
  // cards are also discovered through their persisted neuralRootId relationship.
  const included=new Set([state.focusScopeId,...state.focusBranchIds]); let changed=true;
  while(changed){changed=false;for(const node of cards)if(!included.has(node.id)&&included.has(node.metadata?.neuralRootId)){included.add(node.id);changed=true;}}
  return cards.filter(node=>included.has(node.id));
}
function showFullMap() {
  state.focusScopeId=null; state.focusBranchIds.clear(); state.centerId=defaultMapCentre(mapCards(),state.graph.connections || [])?.id || null;
  $('#map-title').textContent=state.project?.name || 'Knowledge map';
  $('#map-subtitle').textContent='Full saved map. Left-click any card to open and research its own focused web.';
  buildTwoDimensionalLayout(); fitMap(); renderMap();
}
function buildTwoDimensionalLayout() {
  const nodes=mapCards(), allConnections=state.graph.connections || [];
  const visibleIds=new Set(nodes.map(node=>node.id));
  const connections=allConnections.filter(edge=>visibleIds.has(edge.from_node_id)&&visibleIds.has(edge.to_node_id));
  if (!nodes.length) { state.layout=new Map(); state.layoutBounds={minX:0,maxX:0,minY:0,maxY:0}; state.primaryEdges=new Set(); return; }
  if (!nodes.some(node=>node.id===state.centerId)) state.centerId=defaultMapCentre(nodes,connections)?.id || nodes[0].id;
  const byId=new Map(nodes.map(node=>[node.id,node]));
  const neighbours=new Map(nodes.map(node=>[node.id,[]]));
  connections.forEach(edge=>{
    if (!byId.has(edge.from_node_id)||!byId.has(edge.to_node_id)) return;
    neighbours.get(edge.from_node_id).push(edge.to_node_id); neighbours.get(edge.to_node_id).push(edge.from_node_id);
  });
  const distance=new Map([[state.centerId,0]]), predecessor=new Map(), queue=[state.centerId];
  while(queue.length) {
    const id=queue.shift();
    [...new Set(neighbours.get(id)||[])].sort((a,b)=>(byId.get(a)?.title||'').localeCompare(byId.get(b)?.title||'')).forEach(next=>{
      if(distance.has(next)) return;
      distance.set(next,distance.get(id)+1); predecessor.set(next,id); queue.push(next);
    });
  }
  // Keep disconnected saved material visible in a final outer ring, without inventing links.
  const connectedDepth=Math.max(...distance.values());
  nodes.filter(node=>!distance.has(node.id)).sort((a,b)=>a.title.localeCompare(b.title)).forEach((node,index)=>distance.set(node.id,connectedDepth+1+Math.floor(index/10)));
  const rings=new Map(); nodes.forEach(node=>{const depth=distance.get(node.id)||0;const list=rings.get(depth)||[];list.push(node);rings.set(depth,list);});
  const firstRing=(rings.get(1)||[]).sort((a,b)=>a.title.localeCompare(b.title));
  const branchAngle=new Map();
  firstRing.forEach((node,index)=>branchAngle.set(node.id,-Math.PI/2+(Math.PI*2*index)/Math.max(firstRing.length,1)));
  const branchOf=id=>{
    let current=id, parent=predecessor.get(current), safety=0;
    while(parent && parent!==state.centerId && safety++<nodes.length){current=parent;parent=predecessor.get(current);}
    return parent===state.centerId ? current : id;
  };
  const positions=new Map([[state.centerId,{x:0,y:0,generation:0}]]);
  const maxDepth=Math.max(...distance.values());
  for(let depth=1;depth<=maxDepth;depth++) {
    const members=(rings.get(depth)||[]).sort((a,b)=>a.title.localeCompare(b.title));
    const groups=new Map();
    members.forEach(node=>{const branch=branchOf(node.id);const list=groups.get(branch)||[];list.push(node);groups.set(branch,list);});
    const unassigned=[...groups.keys()].filter(id=>!branchAngle.has(id)).sort((a,b)=>(byId.get(a)?.title||'').localeCompare(byId.get(b)?.title||''));
    unassigned.forEach((id,index)=>branchAngle.set(id,-Math.PI/2+(Math.PI*2*index)/Math.max(unassigned.length,1)));
    const radius=205+(depth-1)*185;
    groups.forEach((membersInBranch,branch)=>{
      const base=branchAngle.get(branch)||-Math.PI/2;
      const spread=Math.min(.34,Math.PI/Math.max(firstRing.length||groups.size,3));
      membersInBranch.sort((a,b)=>a.title.localeCompare(b.title)).forEach((node,index)=>{
        const angle=base+(index-(membersInBranch.length-1)/2)*spread;
        positions.set(node.id,{x:Math.cos(angle)*radius,y:Math.sin(angle)*radius,generation:depth});
      });
    });
  }
  // A deliberate drag stores an offset from this generated inside-out position.
  // The research structure stays readable while the user's arrangement persists.
  nodes.forEach(node=>{
    if(node.id===state.centerId) return;
    const offset=node.metadata?.manualOffset, point=positions.get(node.id);
    if(point && Number.isFinite(Number(offset?.x)) && Number.isFinite(Number(offset?.y))) { point.x+=Number(offset.x); point.y+=Number(offset.y); }
  });
  state.layout=positions;
  state.primaryEdges=new Set([...predecessor.entries()].map(([child,parent])=>edgeKey(child,parent)));
  const values=[...positions.values()];
  state.layoutBounds={minX:Math.min(...values.map(p=>p.x)),maxX:Math.max(...values.map(p=>p.x)),minY:Math.min(...values.map(p=>p.y)),maxY:Math.max(...values.map(p=>p.y))};
}
function layoutPoint(node) { return state.layout?.get(node.id) || { x:Number(node.x)||0, y:Number(node.y)||0, generation:0 }; }
function fitMap() {
  const rect=mapRect(), bounds=state.layoutBounds || {minX:0,maxX:0,minY:0,maxY:0};
  const width=Math.max(1,bounds.maxX-bounds.minX+300), height=Math.max(1,bounds.maxY-bounds.minY+170);
  state.camera.x=(bounds.minX+bounds.maxX)/2; state.camera.y=(bounds.minY+bounds.maxY)/2; state.camera.z=0;
  state.camera.panX=0; state.camera.panY=28;
  state.scale=Math.max(.18,Math.min(1.28,(rect.width-80)/width,(rect.height-96)/height));
}
function centreNode(node) {
  state.centerId=node.id;
  buildTwoDimensionalLayout();
  fitMap();
  renderMap();
}
function projectNode(node, rect=mapRect()) {
  const point=layoutPoint(node), camera=state.camera;
  return { x:rect.width/2+camera.panX+(point.x-camera.x)*state.scale, y:rect.height/2+camera.panY+(point.y-camera.y)*state.scale, depth:0, scale:state.scale, opacity:1 };
}
function renderSelectionDock() {
  // Node-specific actions intentionally live in the information window, not on the map.
  const dock=$('#selection-dock'); dock.hidden=true; dock.replaceChildren();
}
function renderMap() {
  const nodes=mapCards(), allConnections=state.graph.connections || [];
  const visibleIds=new Set(nodes.map(node=>node.id));
  const connections=allConnections.filter(edge=>visibleIds.has(edge.from_node_id)&&visibleIds.has(edge.to_node_id));
  $('#node-count').textContent=nodes.length; const edgeCount=$('#edge-count'); if(edgeCount) edgeCount.textContent=connections.length; $('#sources-count').textContent=state.graph.sourceCount || 0; const claimCount=$('#claim-count'); if(claimCount) claimCount.textContent=state.graph.claimCount || 0;
  $('#empty-state').hidden=nodes.length>0;
  const guide=$('#generation-guide'); guide.hidden=!nodes.length;
  if(nodes.length) guide.innerHTML=state.focusScopeId?'<span>Chosen focus</span><span>Fresh source-backed web</span><span>Source evidence in information</span>':'<span>Main point</span><span>Distinct topic paths</span><span>Source evidence in information</span>';
  const fit=$('#fit-map'); if(fit){fit.textContent=state.focusScopeId?'Full map':'Fit map';fit.title=state.focusScopeId?'Return to the full saved map':'Fit the complete map';}
  const shortcut=$('#focus-button'); if(shortcut){const label=shortcut.querySelector('span');if(label)label.textContent=state.focusScopeId?'Full map':'Fit map';shortcut.title=state.focusScopeId?'Return to the full saved map':'Fit the complete 2D map';}
  const layer=$('#nodes-layer'), rect=mapRect(); layer.replaceChildren(); state.projections=new Map();
  const projected=nodes.map(node=>({node,point:projectNode(node,rect)}));
  projected.forEach(({node,point})=>{
    state.projections.set(node.id,point);
    const el=document.createElement('button'); el.type='button'; el.className=`brain-node node-drag ${node.type} priority-${node.priority}${node.id===state.centerId?' center-node':''}${node.id===state.selectedId?' selected':''}`;
    el.dataset.id=node.id; el.style.left=`${point.x}px`; el.style.top=`${point.y}px`; el.style.opacity=point.opacity; el.style.zIndex=String(Math.round(1000-point.depth));
    el.style.transform=`translate(-50%,-50%) scale(${point.scale})`;
    el.innerHTML=`<div class="node-title">${esc(mapLabel(node.title))}</div>`;
    layer.append(el);
  });
  const centre=state.projections.get(state.centerId); const canvas=$('#canvas-wrap');
  if(centre){canvas.style.setProperty('--centre-x',`${centre.x}px`);canvas.style.setProperty('--centre-y',`${centre.y}px`);canvas.style.setProperty('--ring-one',`${205*state.scale}px`);canvas.style.setProperty('--ring-two',`${390*state.scale}px`);canvas.style.setProperty('--ring-three',`${575*state.scale}px`);}
  drawEdges(rect); renderSelectionDock();
}
function drawEdges(rect=mapRect()) {
  const svg=$('#edge-layer'); svg.setAttribute('viewBox',`0 0 ${rect.width} ${rect.height}`); svg.replaceChildren();
  state.graph.connections.forEach(edge=>{
    // Show the clear inside-out connection tree. Other saved relationships remain in the
    // information window instead of turning the focused web into a zig-zag tangle.
    if (!state.primaryEdges?.has(edgeKey(edge.from_node_id,edge.to_node_id))) return;
    const a=state.projections.get(edge.from_node_id),b=state.projections.get(edge.to_node_id); if(!a||!b)return;
    const path=document.createElementNS('http://www.w3.org/2000/svg','path');
    path.setAttribute('class',`edge ${edge.relationship}`); path.setAttribute('d',`M ${a.x} ${a.y} L ${b.x} ${b.y}`); svg.append(path);
  });
}
async function selectAsMapCentre(node, openInformation=false) {
  centreNode(node);
  $('#map-title').textContent=mapLabel(node.title);
  $('#map-subtitle').textContent='This focus is now at the centre. Its saved links have been balanced around it.';
  return selectNode(node.id,openInformation);
}
async function focusAndResearchNode(node) {
  if (!node) return;
  // One click deliberately makes the card the centre and opens a fresh, saved web
  // around that exact focus. Unrelated project branches remain available via Full map.
  if (state.expandingNodeId) { toast('A source search is already growing this map.'); return; }
  state.focusScopeId=node.id;
  state.focusBranchIds=new Set([node.id]);
  await selectAsMapCentre(node,false);
  const query=researchQueryForNode(node);
  if (query.length<2) { toast('This card does not yet contain enough wording to search.','error'); return; }
  state.expandingNodeId=node.id;
  $('#map-subtitle').textContent=`Searching real sources around “${mapLabel(query)}”…`;
  try { await growNeuralNetwork(query,node.id); }
  finally { state.expandingNodeId=null; }
}
function focusNode(node) { return selectAsMapCentre(node,true); }
function researchQueryForNode(node) {
  // A concise map label can be a simplification (for example “Scriptures”). Preserve
  // the exact heading/link recorded from the source when searching the selected card.
  const focus=String(node.metadata?.sourceHeading || node.metadata?.topicLabel || node.title || '').trim();
  const context=String(node.metadata?.researchRootQuery || node.metadata?.query || '').trim();
  return [focus,context].filter((value,index,values)=>value&&values.indexOf(value)===index).join(' ').trim();
}
async function selectNode(id, openInformation=true) {
  state.selectedId=id;
  document.body.classList.toggle('has-selection',Boolean(id));
  document.body.classList.toggle('has-inspector',Boolean(id && openInformation));
  renderMap();
  if (!id || !openInformation) {
    $('#inspector-empty').hidden=true; $('#inspector-content').hidden=true;
    return;
  }
  try { const detail=await api(`/api/nodes/${id}/detail`); renderInspector(detail); } catch(error) { toast(error.message,'error'); }
}
function renderInspector(detail) {
  const {node,sources,connections,related,claims=[]}=detail; $('#inspector-empty').hidden=true; const panel=$('#inspector-content'); panel.hidden=false;
  const sourceCards=sources.length ? sources.map(source=>{const score=source.metadata?.research;return `<article class="source-card">${source.metadata?.thumbnail?`<img class="source-thumbnail" src="${safeUrl(source.metadata.thumbnail)}" alt="">`:''}<h4>${esc(source.title)}</h4><span class="source-domain">${esc(source.website || source.url)}</span>${score?.relevance!==undefined?`<p class="source-score"><b>Relevance ${esc(score.relevance)}/100</b> · distance ${esc(score.distance)} · authority ${esc(score.authority)}/100<br>${esc(score.why || 'Source evaluation recorded.')}</p>`:''}${source.relevant_passage?`<p>${esc(brief(source.relevant_passage,250))}</p>`:''}<p><b>${esc(source.reliability)}</b> · ${esc(source.collection_status)}</p>${sourceReferenceList(source)}<button class="minor-button" type="button" data-read-source="${esc(source.id)}">Read in app</button> <a href="${safeUrl(source.url)}" target="_blank" rel="noreferrer">Open original source ↗</a></article>`;}).join('') : '<p class="empty-copy">No sources are attached yet. Use Research web to collect and compare evidence.</p>';
  const claimCards=claims.length?claims.map(claim=>`<article class="claim-card"><p>${esc(brief(claim.statement,360))}</p><small>Source quotation · relevance ${esc(claim.relevance)}/100 · ${esc(claim.supporting_source_count)} supporting source${Number(claim.supporting_source_count)===1?'':'s'} · ${esc(claim.confidence)}</small></article>`).join(''):'<p class="empty-copy">No source quotations have been retained for this item yet.</p>';
  const relatedCards=related.length ? related.map(item=>`<button class="related-item" data-select="${esc(item.id)}"><span>${icons[item.type]||'◈'} ${esc(item.title)}</span><small>${esc(typeNames[item.type]||item.type)} · ${esc(item.confidence)} confidence</small></button>`).join('') : '<p class="empty-copy">No direct connections yet.</p>';
  const evidenceConnections=connections.filter(c=>['supports','contradicts','evidence_for','evidence_against','documents'].includes(c.relationship));
  const candidateRootId=['discovery-root','neural-root'].includes(node.metadata?.role) ? node.id : (node.metadata?.discoveryRootId || node.metadata?.neuralRootId);
  const discoveryRootId=['discovery-root','neural-root'].includes(state.graph.nodes.find(item=>item.id===candidateRootId)?.metadata?.role) ? candidateRootId : '';
  const analysisAction=discoveryRootId ? `<section class="inspector-section discovery-action"><h3 class="section-heading">Read this focus</h3><p>Open the dictionary, an encyclopaedia article or a live list of images and video for this word. Sources are searched live and never invented.</p><div class="medium-picker"><button data-reader-for="dictionary">Dictionary</button><button data-reader-for="wikipedia">Wikipedia</button><button data-reader-for="images">Images</button><button data-reader-for="videos">Video</button></div></section>` : '';
  panel.innerHTML=`<button class="inspect-close" id="inspector-close" aria-label="Close context">×</button><span class="type-pill">${icons[node.type]||'◈'} ${esc(typeNames[node.type]||node.type)}</span><h2 class="inspect-title">${esc(node.title)}</h2>${node.body?`<section class="inspector-section research-information"><h3 class="section-heading">Research information</h3><p class="inspect-body">${text(node.body)}</p></section>`:''}<div class="confidence-row"><div class="metric"><span>Confidence</span><b class="confidence-${esc(node.confidence)}">${esc(node.confidence)}</b></div><div class="metric"><span>Priority</span><b>${esc(friendly(node.priority))}</b></div><div class="metric"><span>Origin</span><b>${esc(node.origin)}</b></div></div>${node.type==='evidence'||evidenceConnections.length?`<section class="inspector-section"><h3 class="section-heading">Evidence chain</h3><div class="evidence-chain"><div class="chain-step">Source / material</div><div class="chain-step">Evidence: ${esc(brief(node.title,70))}</div><div class="chain-step">${evidenceConnections.length?`${evidenceConnections.length} documented relationship${evidenceConnections.length===1?'':'s'}`:'Interpretation pending'}</div></div></section>`:''}<section class="inspector-section"><h3 class="section-heading">Source-quoted claims <span>(${claims.length})</span></h3><p class="medium-help">These are retained source quotations, not automatic final conclusions.</p>${claimCards}</section><section class="inspector-section"><h3 class="section-heading">Original research sources <span>(${sources.length})</span></h3>${sourceCards}</section><section class="inspector-section medium-options"><h3 class="section-heading">Explore this focus as</h3><p class="medium-help">Map is the default: drag real thumbnails, pan and zoom. Right-click a card for its large preview. Grid remains optional; items save only when you choose Add to web.</p><div class="medium-picker"><button data-medium="wikipedia">Wikipedia</button><button data-medium="dictionary">Dictionary</button><button data-medium="websites">Web</button><button data-medium="images">Images</button><button data-medium="videos">Videos</button><button data-medium="books">Books</button><button data-medium="documents">Papers</button><button data-medium="music">Music</button></div></section><section class="inspector-section"><h3 class="section-heading">Connected thoughts <span>(${related.length})</span></h3><div class="related-list">${relatedCards}</div></section>${analysisAction}<section class="inspector-section"><h3 class="section-heading">Actions for this information</h3><div class="inspector-actions"><button class="inspector-action primary" data-research-node="${esc(node.id)}">Search around this focus</button><button class="inspector-action" data-edit="${esc(node.id)}">Edit information</button><button class="inspector-action" data-priority-node="${esc(node.id)}">Set importance</button><button class="inspector-action" data-connect="${esc(node.id)}">Connect to a word</button><button class="inspector-action" data-attach-node="${esc(node.id)}">Attach a file</button><button class="inspector-action danger" data-delete="${esc(node.id)}">Delete</button></div></section>`;
  $('#inspector-close').onclick=()=>selectNode(null);
  $$('[data-select]').forEach(button=>button.onclick=()=>{const relatedNode=state.graph.nodes.find(item=>item.id===button.dataset.select);if(relatedNode)focusAndResearchNode(relatedNode);});
  panel.querySelector('[data-research-node]')?.addEventListener('click',()=>focusAndResearchNode(node));
  panel.querySelectorAll('[data-medium]').forEach(button=>button.addEventListener('click',()=>openMediumView(button.dataset.medium,node)));
  panel.querySelectorAll('[data-add-reference]').forEach(button=>button.addEventListener('click',()=>addLinkedReference(button.dataset.addReference,node,button)));
  panel.querySelector('[data-edit]')?.addEventListener('click',()=>openNodeModal(node));
  panel.querySelector('[data-priority-node]')?.addEventListener('click',()=>openImportanceModal(node));
  panel.querySelector('[data-connect]')?.addEventListener('click',()=>openConnectModal(node));
  panel.querySelector('[data-attach-node]')?.addEventListener('click',()=>$('#file-input').click());
  panel.querySelectorAll('[data-read-source]').forEach(button=>button.addEventListener('click',event=>openSavedSource(event.currentTarget.dataset.readSource)));
  panel.querySelectorAll('[data-reader-for]').forEach(button=>button.addEventListener('click',()=>openReaderForNode(button.dataset.readerFor,node)));
  panel.querySelector('[data-delete]')?.addEventListener('click',()=>deleteNode(node));
}

function showModal(html) {
  const modal=$('#modal');
  // Source discovery is a working result browser, not a small settings dialog.
  // Give it the available screen so results do not stay in a narrow left-hand column.
  modal.className = html.includes('free-source-search-form') ? 'modal source-search-modal' : html.includes('apply-research-form') ? 'modal research-results-modal' : 'modal';
  modal.innerHTML=html;
  // Do not intercept clipboard events. Native browser paste is the most reliable
  // and accessible behaviour for password, text and multiline controls.
  modal.onpaste=null;
  $('#modal-backdrop').hidden=false;
  $('#modal-backdrop').onclick=event=>{if(event.target===$('#modal-backdrop')) closeModal();};
  $$('.modal-close').forEach(button=>button.onclick=closeModal);
}
function closeModal(){ $('#modal-backdrop').hidden=true; $('#modal').replaceChildren(); }
const freeDiscoveryResults=new Map();
let activeDiscoveryQuery='', activeDiscoveryType='all', activeDiscoveryTargetId='';
function sourceTypeLabel(kind='source') { return ({article:'website',image:'image',video:'video',book:'book',music:'music',paper:'paper',document:'document'})[kind] || 'source'; }
const MEDIUM_DETAILS={wikipedia:{label:'Wikipedia',action:'Read article'},dictionary:{label:'Dictionary',action:'Read entry'},websites:{label:'Web',action:'Read page'},images:{label:'Images',action:'View image'},videos:{label:'Videos',action:'Play video'},books:{label:'Books',action:'Read book'},documents:{label:'Papers & documents',action:'Open document'},music:{label:'Music',action:'Listen'}};
function mediumDetails(medium) { return MEDIUM_DETAILS[medium] || MEDIUM_DETAILS.websites; }
function closeMediumView() { state.mediaView=null; const stage=$('#media-stage'); stage.hidden=true; stage.replaceChildren(); }
function mediaSearchQuery(node) { return String(node?.metadata?.mediaQuery || node?.metadata?.sourceTitle || node?.metadata?.query || node?.title || '').trim(); }
function mediaMapPositions(results = []) {
  const centre={x:920,y:560};
  return results.map((_item,index)=>{const ring=Math.floor(index/6), count=Math.min(6,results.length-ring*6)||1, slot=index%6;const angle=-Math.PI/2+(Math.PI*2*slot/count)+(ring%2?.24:0);const radius=230+ring*185;return {x:centre.x+Math.round(radius*Math.cos(angle)),y:centre.y+Math.round(radius*Math.sin(angle))};});
}
async function openMediumView(medium, node) {
  const details=mediumDetails(medium), query=mediaSearchQuery(node); if(!query) return;
  state.mediaView={medium,nodeId:node.id,query,results:[],providers:[],loading:true,layout:'map',map:{scale:.78,panX:0,panY:0,positions:[]}}; renderMediumStage();
  try { const result=await api(`/api/discovery?q=${encodeURIComponent(query)}&type=${encodeURIComponent(medium)}`); if(!state.mediaView||state.mediaView.nodeId!==node.id||state.mediaView.medium!==medium)return; state.mediaView={...state.mediaView,results:result.results||[],providers:result.providers||[],loading:false,map:{...state.mediaView.map,positions:mediaMapPositions(result.results||[])}}; renderMediumStage(); }
  catch(error) { if(state.mediaView){state.mediaView={...state.mediaView,error:error.message,loading:false};renderMediumStage();} }
}
function mediumCard(item,index,details,map=false) {
  const thumbnail=safeUrl(item.thumbnail||''); const visual=thumbnail!=='#'?`<img src="${thumbnail}" alt="" loading="lazy">`:`<div class="media-placeholder">${esc(details.label)}</div>`;
  return `<article class="medium-card${map?' media-map-card':''}"${map?` data-media-map-card="${index}" style="left:${state.mediaView.map.positions[index]?.x||920}px;top:${state.mediaView.map.positions[index]?.y||560}px"`:''}><div class="medium-visual">${visual}</div><div class="medium-card-body"><span>${esc(item.provider)} · ${esc(sourceTypeLabel(item.kind))}</span><h3>${esc(item.title)}</h3>${item.author?`<p class="media-author">${esc(item.author)}</p>`:''}${item.snippet?`<p>${esc(brief(item.snippet,map?118:190))}</p>`:''}<div class="medium-actions"><button type="button" class="medium-open" data-media-open="${index}">Open in app</button><a href="${safeUrl(item.url)}" target="_blank" rel="noreferrer">Source ↗</a><button type="button" class="medium-save" data-media-save="${index}">Add to web</button></div></div></article>`;
}
function mediaMapMarkup(view, details) {
  const positions=view.map.positions||[]; const links=positions.map(point=>`<path d="M 920 560 L ${point.x} ${point.y}"></path>`).join('');
  return `<div class="media-map-viewport" id="media-map-viewport" aria-label="Draggable ${esc(details.label)} source map"><div class="media-map-world" id="media-map-world" style="transform:translate(${view.map.panX}px,${view.map.panY}px) scale(${view.map.scale})"><svg class="media-map-links" viewBox="0 0 1840 1120" aria-hidden="true">${links}</svg><div class="media-map-focus"><span>${esc(details.label.toUpperCase())}</span><b>${esc(mapLabel(view.query))}</b><small>drag space to pan</small></div>${view.results.map((item,index)=>mediumCard(item,index,details,true)).join('')}</div><div class="media-map-controls"><button type="button" data-media-map-zoom="out" aria-label="Zoom out">−</button><button type="button" data-media-map-fit>Fit</button><button type="button" data-media-map-zoom="in" aria-label="Zoom in">+</button></div><p class="media-map-hint">Drag cards to arrange them · Drag empty space to pan · Scroll to zoom · Right-click a card for its large preview</p></div>`;
}
function updateMediaMapTransform() { const world=$('#media-map-world'), view=state.mediaView;if(world&&view?.map)world.style.transform=`translate(${view.map.panX}px,${view.map.panY}px) scale(${view.map.scale})`; }
function bindMediaMapInteractions(stage) {
  const viewport=$('#media-map-viewport'); if(!viewport)return; let drag=null;
  const move=event=>{if(!drag||!state.mediaView?.map)return;const dx=event.clientX-drag.startX,dy=event.clientY-drag.startY;if(drag.kind==='card'){const point=state.mediaView.map.positions[drag.index];point.x=drag.x+dx/state.mediaView.map.scale;point.y=drag.y+dy/state.mediaView.map.scale;const card=stage.querySelector(`[data-media-map-card="${drag.index}"]`);if(card){card.style.left=`${point.x}px`;card.style.top=`${point.y}px`;}}else{state.mediaView.map.panX=drag.x+dx;state.mediaView.map.panY=drag.y+dy;updateMediaMapTransform();}};
  viewport.addEventListener('pointerdown',event=>{if(event.button!==0||event.target.closest('button,a'))return;const card=event.target.closest('[data-media-map-card]');const index=Number(card?.dataset.mediaMapCard);if(card){const point=state.mediaView.map.positions[index];drag={kind:'card',index,startX:event.clientX,startY:event.clientY,x:point.x,y:point.y};}else drag={kind:'pan',startX:event.clientX,startY:event.clientY,x:state.mediaView.map.panX,y:state.mediaView.map.panY};viewport.setPointerCapture?.(event.pointerId);event.preventDefault();event.stopPropagation();});
  viewport.addEventListener('pointermove',move); viewport.addEventListener('pointerup',()=>{drag=null;});viewport.addEventListener('pointercancel',()=>{drag=null;});
  viewport.addEventListener('wheel',event=>{event.preventDefault();event.stopPropagation();if(!state.mediaView?.map)return;state.mediaView.map.scale=Math.max(.38,Math.min(1.45,state.mediaView.map.scale+(event.deltaY<0?.08:-.08)));updateMediaMapTransform();},{passive:false});
  viewport.addEventListener('contextmenu',event=>{const card=event.target.closest('[data-media-map-card]');if(!card)return;event.preventDefault();openMediumItem(state.mediaView.results[Number(card.dataset.mediaMapCard)],state.mediaView.medium);});
  stage.querySelectorAll('[data-media-map-zoom]').forEach(button=>button.onclick=()=>{state.mediaView.map.scale=Math.max(.38,Math.min(1.45,state.mediaView.map.scale+(button.dataset.mediaMapZoom==='in'?.12:-.12)));updateMediaMapTransform();});
  stage.querySelector('[data-media-map-fit]')?.addEventListener('click',()=>{state.mediaView.map={...state.mediaView.map,scale:.78,panX:0,panY:0};updateMediaMapTransform();});
}
function renderMediumStage() {
  const stage=$('#media-stage'), view=state.mediaView; if(!view){stage.hidden=true;return;} const details=mediumDetails(view.medium); stage.hidden=false;
  const providerText=(view.providers||[]).filter(item=>item.status==='ok').map(item=>item.provider).join(', ');
  if(view.loading){stage.innerHTML=`<header class="media-stage-head"><div><span class="media-kicker">${esc(details.label.toUpperCase())} VIEW</span><h2>Finding real ${esc(details.label.toLowerCase())}…</h2><p>Searching public source indexes for “${esc(view.query)}”.</p></div><button class="media-close" type="button">× Back to knowledge web</button></header><div class="media-loading">Searching public sources…</div>`;stage.querySelector('.media-close').onclick=closeMediumView;return;}
  const noResults=view.error?`<div class="media-empty">${esc(view.error)}</div>`:'<div class="media-empty">No real public results were returned for this focus. Try a narrower wording or another medium.</div>';
  const content=view.results.length ? (view.layout==='grid'?`<div class="media-grid">${view.results.map((item,index)=>mediumCard(item,index,details)).join('')}</div>`:mediaMapMarkup(view,details)) : noResults;
  stage.innerHTML=`<header class="media-stage-head"><div><span class="media-kicker">${esc(details.label.toUpperCase())} VIEW</span><h2>${esc(details.label)} around “${esc(mapLabel(view.query))}”</h2><p>${view.results.length} genuine result${view.results.length===1?'':'s'}${providerText?` from ${esc(providerText)}`:''}. Drag the source cards in Map view; choose <b>Add to web</b> to preserve an item in this project.</p></div><div class="media-stage-actions"><div class="media-layout-toggle" aria-label="Result layout"><button type="button" class="${view.layout==='map'?'active':''}" data-media-layout="map">Map</button><button type="button" class="${view.layout==='grid'?'active':''}" data-media-layout="grid">Grid</button></div><button class="media-close" type="button">× Back to knowledge web</button></div></header>${content}`;
  stage.querySelector('.media-close').onclick=closeMediumView;
  stage.querySelectorAll('[data-media-layout]').forEach(button=>button.onclick=()=>{state.mediaView.layout=button.dataset.mediaLayout;renderMediumStage();});
  stage.querySelectorAll('[data-media-open]').forEach(button=>button.onclick=()=>openMediumItem(view.results[Number(button.dataset.mediaOpen)],view.medium));
  stage.querySelectorAll('[data-media-save]').forEach(button=>button.onclick=()=>saveMediumItem(view.results[Number(button.dataset.mediaSave)],button));
  if(view.layout==='map'&&view.results.length)bindMediaMapInteractions(stage);
}
async function saveMediumItem(item, button) {
  const view=state.mediaView; if(!view||!item)return; const original=button.textContent;button.disabled=true;button.textContent='Adding…';
  try { await api(`/api/projects/${state.project.id}/sources/import`,{method:'POST',body:JSON.stringify({url:item.url,title:item.title,website:item.website,author:item.author,publishedDate:item.publishedDate,snippet:item.snippet,extractedText:item.extractedText,sourceType:item.kind,query:view.query,targetNodeId:view.nodeId,provider:item.provider,providerMetadata:item.metadata,deferCollection:true})}); button.textContent='Added to web'; await loadGraph(); toast('Real source saved to the knowledge web.','success'); }
  catch(error){button.disabled=false;button.textContent=original;toast(error.message,'error');}
}
function openMediumItem(item, medium) {
  if (!item) return;
  if (medium === 'dictionary') return openReader({ kind:'dictionary', term:item.metadata?.entry?.word || item.title, entry:item.metadata?.entry || null });
  return openResult(item);
}
function openImageViewer(item) {
  if (!item) return;
  openReader({ kind:'image', title:item.title, src:item.url, original:item.url, caption:item.provider || '' });
}
function showDiscoveryBranchAction(branch) {
  // Keep research actions together in the selected word's information window.
  const source=branch?.sourceNode; if(!source?.id) return;
  const liveSource=state.graph.nodes.find(node=>node.id===source.id) || source;
  void focusNode(liveSource);
}
async function saveFreeDiscoveryResult(resultId, button) {
  const result=freeDiscoveryResults.get(resultId); if(!result) return;
  const original=button.textContent; button.disabled=true; button.textContent='Saving source…';
  try {
    const saved=await api(`/api/projects/${state.project.id}/sources/import`,{method:'POST',body:JSON.stringify({url:result.url,title:result.title,website:result.website,author:result.author,publishedDate:result.publishedDate,snippet:result.snippet,sourceType:result.kind,query:activeDiscoveryQuery,targetNodeId:activeDiscoveryTargetId,provider:result.provider,providerMetadata:result.metadata})});
    button.textContent=saved.collected?'Saved & mapped':'Mapped as source';
    closeModal(); await loadGraph();
    if (saved.branch?.sourceNode?.id) await selectNode(saved.branch.sourceNode.id);
    showDiscoveryBranchAction(saved.branch);
    toast(saved.collected?'Source branch added to the Brain.':'Source branch added; page content could not be collected.','success');
  } catch(error) { button.textContent=original; toast(error.message,'error'); }
  finally { button.disabled=false; }
}
function renderFreeDiscoveryResults(result) {
  const host=$('#free-search-results'); if(!host) return;
  const items=result.results || [];
  if (!items.length) { host.innerHTML='<p class="empty-copy">No sources were returned. Try fewer terms or select a different source type.</p>'; return; }
  host.innerHTML=`<div class="grow-map-prompt"><div><b>Ready to grow a neural map?</b><span>Add the six closest source branches first, then inspect or analyse them.</span></div><button class="primary-button" type="button" id="grow-neural-map">Grow map from closest sources</button></div>`+items.map((item,index)=>{
    const id=`free-result-${Date.now()}-${index}`; freeDiscoveryResults.set(id,item);
    const thumbnail=safeUrl(item.thumbnail || '');
    return `<article class="free-result-card">${thumbnail!=='#'?`<img src="${thumbnail}" alt="" referrerpolicy="no-referrer">`:''}<div><p class="free-result-type">${esc(item.provider)} · ${esc(sourceTypeLabel(item.kind))}</p><h3><a href="#" data-free-open="${id}">${esc(item.title)}</a></h3><span>${esc(item.website)}</span>${item.author?`<p class="result-byline">${esc(item.author)}${item.publishedDate?` · ${esc(item.publishedDate)}`:''}</p>`:''}<p>${esc(brief(item.snippet || 'No summary was supplied by this source index.',300))}</p><button class="minor-button" type="button" data-free-open="${id}">Open in app</button> <button class="minor-button" type="button" data-free-result="${id}">Save to Brain</button></div></article>`;
  }).join('');
  $$('[data-free-result]').forEach(button=>button.onclick=()=>saveFreeDiscoveryResult(button.dataset.freeResult,button));
  $$('[data-free-open]').forEach(button=>button.onclick=event=>{ event.preventDefault(); const item=freeDiscoveryResults.get(button.dataset.freeOpen); if(item) openResult(item); });
  $('#grow-neural-map').onclick=()=>growNeuralMapFromResults(items);
}
function chooseClosestSources(items, maximum=6) {
  const meaningful=items.filter(item=>item.kind!=='image'); const selected=[]; const providers=new Set();
  for (const item of meaningful) if(!providers.has(item.provider) && selected.length<maximum) { selected.push(item); providers.add(item.provider); }
  for (const item of meaningful) if(!selected.includes(item) && selected.length<maximum) selected.push(item);
  return selected.length ? selected : items.slice(0,maximum);
}
async function growNeuralMapFromResults(items) {
  const button=$('#grow-neural-map'); const chosen=chooseClosestSources(items); if(!chosen.length)return;
  const original=button?.textContent; if(button){button.disabled=true;button.textContent=`Growing ${chosen.length} branches…`;}
  const status=$('#free-search-status'); status.textContent=`Adding ${chosen.length} real source branches to your Brain…`;
  const jobs=chosen.map(result=>api(`/api/projects/${state.project.id}/sources/import`,{method:'POST',body:JSON.stringify({url:result.url,title:result.title,website:result.website,author:result.author,publishedDate:result.publishedDate,snippet:result.snippet,sourceType:result.kind,query:activeDiscoveryQuery,targetNodeId:activeDiscoveryTargetId,provider:result.provider,providerMetadata:result.metadata,deferCollection:true})}));
  const settled=await Promise.allSettled(jobs); const saved=settled.filter(item=>item.status==='fulfilled').map(item=>item.value);
  if(!saved.length){if(button){button.disabled=false;button.textContent=original;}status.textContent='No source branches could be added. Try saving one source directly.';return;}
  const root=saved.find(item=>item.branch?.rootNode)?.branch?.rootNode; closeModal(); await loadGraph();
  if(root){const current=state.graph.nodes.find(node=>node.id===root.id)||root;await focusNode(current);showDiscoveryBranchAction(saved[0].branch);}
  toast(`${saved.length} real source branch${saved.length===1?'':'es'} added to your neural map.`,'success');
}
function returnedFocusCardIds(result = {}) {
  const ids=[result.root?.id];
  for (const branch of result.branches || []) {
    // Different source-backed modes use topic or concept as their visible card.
    for (const candidate of [branch?.topic,branch?.concept]) if(candidate?.id) ids.push(candidate.id);
  }
  return new Set(ids.filter(Boolean));
}
async function growNeuralNetwork(query, centerNodeId='', triggerButton=null) {
  const cleanQuery=String(query||'').trim(); if(cleanQuery.length<2)return;
  const centralStatus=$('#empty-search-status'); const original=triggerButton?.textContent;
  const startsAnEmptyBrain=!centerNodeId&&document.body.classList.contains('is-empty');
  if (startsAnEmptyBrain) { hideTypingAssist($('#empty-typing-assist')); $('#empty-command-input').blur(); document.body.classList.add('initial-search-running'); }
  if(centralStatus) centralStatus.textContent=`Searching public sources and building your map for “${cleanQuery}”…`;
  showResearchProgress(cleanQuery);
  if(triggerButton){triggerButton.disabled=true;triggerButton.textContent='Researching network…';}
  try {
    const result=await api(`/api/projects/${state.project.id}/neural-grow`,{method:'POST',body:JSON.stringify({query:cleanQuery,centerNodeId})});
    if(!centerNodeId){state.selectedId=null;document.body.classList.remove('has-selection');document.body.classList.remove('has-inspector');}
    await loadGraph();
    document.body.classList.remove('initial-search-running');
    const root=state.graph.nodes.find(node=>node.id===result.root.id)||result.root;
    if(centerNodeId){
      state.focusScopeId=centerNodeId;
      state.focusBranchIds=returnedFocusCardIds(result);
      const center=state.graph.nodes.find(node=>node.id===centerNodeId)||root;
      await focusNode(center);
    }else{fitMap();renderMap();}
    const report=result.research; const summary=report?`${report.selectedSources} relevance-ranked sources · ${report.sourceQuotedClaims} source quotations · ${report.openGaps} open gaps`:'';
    showResearchProgress(cleanQuery,'complete',summary); hideResearchProgress(2800);
    const newBranches=(result.branches||[]).filter(branch=>branch.topic?.id!==result.root?.id).length;
    const refreshNote=result.refreshedFocusCards?` Replaced ${result.refreshedFocusCards} prior automatic card${result.refreshedFocusCards===1?'':'s'} in this focus web.`:'';
    toast(newBranches?`${newBranches} source-backed map branch${newBranches===1?'':'es'} saved to the Brain.${refreshNote}`:`Source-backed search completed. No further distinct child topic was found; its source evidence was retained for inspection.${refreshNote}`,'success');
  } catch(error) { hideResearchProgress(); if(centralStatus) centralStatus.textContent=error.message; if(startsAnEmptyBrain)document.body.classList.remove('initial-search-running'); toast(error.message,'error'); }
  finally { if(triggerButton){triggerButton.disabled=false;triggerButton.textContent=original;} }
}
async function runFreeDiscovery(query, type='web', growNetwork=false) {
  const host=$('#free-search-results'), status=$('#free-search-status'); if(!host) return;
  activeDiscoveryQuery=query; activeDiscoveryType=type; freeDiscoveryResults.clear();
  status.textContent='Searching public source indexes in parallel…'; host.innerHTML='<p class="empty-copy">Finding real sources…</p>';
  try {
    const result=await api(`/api/discovery?q=${encodeURIComponent(query)}&type=${encodeURIComponent(type)}`);
    const live=result.providers.filter(provider=>provider.status==='ok');
    const unavailable=result.providers.filter(provider=>provider.status!=='ok');
    status.textContent=`${result.results.length} real result${result.results.length===1?'':'s'} from ${live.map(provider=>provider.provider).join(', ') || 'available public sources'}; no AI was used.${unavailable.length?` ${unavailable.length} source index${unavailable.length===1?' was':'es were'} unavailable.`:''}`;
    renderFreeDiscoveryResults(result);
    if (growNetwork) await growNeuralMapFromResults(result.results || []);
  } catch(error) { status.textContent=error.message; host.innerHTML='<p class="empty-copy">The source search could not finish. Try again in a moment or add an original URL directly below.</p>'; }
}
async function saveDirectSourceUrl() {
  const input=$('#direct-source-url'), button=$('#save-direct-source'); const url=input?.value.trim(); if(!url) return;
  const original=button.textContent; button.disabled=true; button.textContent='Collecting…';
  try {
    const saved=await api(`/api/projects/${state.project.id}/sources/import`,{method:'POST',body:JSON.stringify({url,query:'direct URL import',provider:'user-provided URL'})});
    input.value=''; closeModal(); await loadGraph(); if (saved.branch?.sourceNode?.id) await selectNode(saved.branch.sourceNode.id); toast(saved.collected?'Source branch added to the Brain.':'Source branch added with transparent collection status.','success');
  } catch(error) { toast(error.message,'error'); }
  finally { button.disabled=false; button.textContent=original; }
}
function openSourceSearchModal(initialQuery='', growNetwork=false, targetNodeId='', initialType='web') {
  activeDiscoveryTargetId=targetNodeId || ''; activeDiscoveryType=initialType || 'web';
  const query=esc(initialQuery);
  showModal(`<button class="modal-close">×</button><h2>Search free sources</h2><p class="modal-subtitle">Fast public-source discovery for articles, images, papers and documents. No AI, no account and no API key.</p><form id="free-source-search-form"><input id="free-source-query" value="${query}" required autocomplete="off" placeholder="Search a topic, person, organisation or question…" aria-label="Search free sources" /><button class="primary-button" type="submit">Find sources</button></form><div class="source-search-tools"><button type="button" class="minor-button selected" data-source-type="web">Web</button><button type="button" class="minor-button" data-source-type="wikipedia">Wikipedia</button><button type="button" class="minor-button" data-source-type="dictionary">Dictionary</button><button type="button" class="minor-button" data-source-type="images">Images</button><button type="button" class="minor-button" data-source-type="videos">Video</button><button type="button" class="minor-button" data-source-type="music">Audio</button><button type="button" class="minor-button" data-source-type="papers">Papers</button><button type="button" class="minor-button" data-source-type="documents">Documents</button></div><p class="free-search-status" id="free-search-status">Searches only when you request it. <b>Save to Brain</b> immediately creates a visible source branch in the map, and <b>Open</b> reads the item inside this application.</p><div id="free-search-results" class="free-search-results"></div><div class="direct-source-import"><label for="direct-source-url">Have a specific website, image or document?</label><div><input id="direct-source-url" type="url" inputmode="url" autocomplete="url" placeholder="Paste its public URL" /><button id="save-direct-source" type="button" class="minor-button">Save URL</button></div></div>`);
  const form=$('#free-source-search-form'), input=$('#free-source-query');
  form.onsubmit=event=>{event.preventDefault(); const query=input.value.trim(); if(query) runFreeDiscovery(query,activeDiscoveryType,growNetwork);};
  $$('[data-source-type]').forEach(button=>button.classList.toggle('selected',button.dataset.sourceType===activeDiscoveryType));
  $$('[data-source-type]').forEach(button=>button.onclick=()=>{activeDiscoveryType=button.dataset.sourceType;$$('[data-source-type]').forEach(item=>item.classList.toggle('selected',item===button));const current=input.value.trim();if(current)runFreeDiscovery(current,activeDiscoveryType);});
  $('#save-direct-source').onclick=saveDirectSourceUrl;
  if(initialQuery) setTimeout(()=>runFreeDiscovery(initialQuery,activeDiscoveryType,growNetwork),0); else input.focus();
}
function optionList(current, values) { return values.map(value=>`<option value="${value}" ${value===current?'selected':''}>${friendly(value)}</option>`).join(''); }
function openNodeModal(node=null) {
  const isNew=!node; const title=isNew?'Add a thought':'Edit thought';
  showModal(`<button class="modal-close" aria-label="Close">×</button><h2>${title}</h2><p class="modal-subtitle">User-created priorities remain yours. AI research may suggest, but never silently changes them.</p><form id="node-form"><label>Title</label><input name="title" required maxlength="220" value="${esc(node?.title||'')}" placeholder="A question, fact or idea" /><label>Type</label><select name="type">${optionList(node?.type||'idea',Object.keys(typeNames))}</select><label>Description / notes</label><textarea name="body" placeholder="Why does this matter?">${esc(node?.body||'')}</textarea><div style="display:grid;grid-template-columns:1fr 1fr;gap:10px"><div><label>Priority</label><select name="priority">${optionList(node?.priority||'unclassified',['critical','high','medium','low','informational','research_required','unclassified'])}</select></div><div><label>Confidence</label><select name="confidence">${optionList(node?.confidence||'unverified',['high','medium','low','unverified'])}</select></div></div><div class="modal-actions"><button type="button" class="secondary-button modal-close">Cancel</button><button class="primary-button">${isNew?'Create thought':'Save changes'}</button></div></form>`);
  $('#node-form').onsubmit=async event=>{ event.preventDefault(); const form=new FormData(event.currentTarget); const body=Object.fromEntries(form.entries()); try { let saved; if(node) saved=await api(`/api/nodes/${node.id}`,{method:'PATCH',body:JSON.stringify(body)}); else { const angle=(state.graph.nodes.length*1.618)%6.28; saved=await api(`/api/projects/${state.project.id}/nodes`,{method:'POST',body:JSON.stringify({...body,x:260*Math.cos(angle),y:200*Math.sin(angle)})}); } closeModal(); await loadGraph(); selectNode(saved.id); toast(isNew?'Thought created.':'Thought updated.','success'); } catch(error){toast(error.message,'error');} };
}
function openImportanceModal(node) {
  const priorities=['critical','high','medium','low','informational','research_required','unclassified'];
  showModal(`<button class="modal-close">×</button><h2>Importance &amp; colour</h2><p class="modal-subtitle">Importance is your decision. It is separate from confidence and controls this thought’s colour in the network.</p><div class="priority-picker">${priorities.map(priority=>`<button class="priority-choice priority-${priority}${node.priority===priority?' chosen':''}" data-priority-choice="${priority}"><i></i><span>${esc(friendly(priority))}</span>${node.priority===priority?'<b>Current</b>':''}</button>`).join('')}</div>`);
  $$('[data-priority-choice]').forEach(button=>button.onclick=async()=>{try{await api(`/api/nodes/${node.id}`,{method:'PATCH',body:JSON.stringify({priority:button.dataset.priorityChoice})});closeModal();await loadGraph();await focusNode(state.graph.nodes.find(item=>item.id===node.id)||node);toast('Importance colour updated.','success');}catch(error){toast(error.message,'error');}});
}
async function deleteNode(node){if(!confirm(`Delete “${node.title}” and its connections?`))return;try{await api(`/api/nodes/${node.id}`,{method:'DELETE'});await loadGraph();selectNode(null);toast('Thought deleted.');}catch(error){toast(error.message,'error');}}
function openConnectModal(fromNode) {
  const candidates=state.graph.nodes.filter(node=>node.id!==fromNode.id); if(!candidates.length){toast('Create another thought first.');return;}
  showModal(`<button class="modal-close">×</button><h2>Connect thoughts</h2><p class="modal-subtitle"><b>${esc(fromNode.title)}</b> will be the starting point of this semantic relationship.</p><form id="connect-form"><label>Connect to</label><select name="to_node_id">${candidates.map(n=>`<option value="${esc(n.id)}">${esc(n.title)}</option>`).join('')}</select><label>Relationship</label><select name="relationship">${Object.keys(relationshipNames).filter(x=>x!=='documents').map(x=>`<option value="${x}">${esc(relationshipNames[x])}</option>`).join('')}</select><label>Why are they connected? <small>(optional)</small></label><textarea name="notes" placeholder="Briefly explain the connection"></textarea><div class="modal-actions"><button type="button" class="secondary-button modal-close">Cancel</button><button class="primary-button">Create connection</button></div></form>`);
  $('#connect-form').onsubmit=async event=>{event.preventDefault();const data=Object.fromEntries(new FormData(event.currentTarget));try{await api(`/api/projects/${state.project.id}/connections`,{method:'POST',body:JSON.stringify({...data,from_node_id:fromNode.id})});closeModal();await loadGraph();selectNode(fromNode.id);toast('Connection added.','success');}catch(error){toast(error.message,'error');}};
}

function openView(view) {
  $$('.nav-item').forEach(button=>button.classList.toggle('active',button.dataset.view===view));
  if(view==='brain'){closeModal();return;}
  if(view==='projects')return openProjectsModal(); if(view==='sources')return openSourcesModal(); if(view==='questions')return openQueueModal(); if(view==='history'||view==='research')return openHistoryModal(view); if(view==='files')return openFilesModal(); if(view==='privacy')return openPrivacyModal(); if(view==='settings')return openSettingsModal(); if(view==='timeline')return openTimelineModal();
}
async function startNewSearchProject(triggerButton=$('#new-project')) {
  if (triggerButton?.disabled) return;
  const original=triggerButton?.textContent || '';
  if (triggerButton) { triggerButton.disabled=true; triggerButton.textContent='Creating search…'; }
  try {
    const projects=await api('/api/projects');
    const nextNumber=projects.filter(project=>/^New Brain \d+$/.test(project.name)).length+1;
    state.project=await api('/api/projects',{method:'POST',body:JSON.stringify({name:`New Brain ${nextNumber}`,description:'An empty Brain waiting for its first research topic.'})});
    state.selectedId=null; state.centerId=null; state.focusScopeId=null; state.focusBranchIds.clear(); closeMediumView(); closeModal(); await loadGraph();
    const input=$('#empty-command-input'); if(input)input.value='';
    requestAnimationFrame(()=>input?.focus());
    toast('New search ready. Type one topic, then press Enter or Start search.','success');
  } catch(error) { toast(error.message,'error'); }
  finally { if(triggerButton){triggerButton.disabled=false;triggerButton.textContent=original;} }
}
async function openProjectsModal() {
  try {
    const projects=await api('/api/projects');
    showModal(`<button class="modal-close">×</button><h2>Projects</h2><p class="modal-subtitle">Each project keeps an independent graph, research trail and source collection. Use <b>+ New search</b> in the top bar to create a fresh project and open its centre search box.</p><div class="view-list">${projects.map(p=>`<div class="view-card"><h3>${esc(p.name)} ${p.id===state.project.id?'<span class="proposal-label">CURRENT</span>':''}</h3><p>${esc(p.description||'No description.')}</p><button class="minor-button" data-open-project="${esc(p.id)}">Open project</button></div>`).join('')}</div>`);
    $$('[data-open-project]').forEach(button=>button.onclick=async()=>{state.project=(await api('/api/projects')).find(p=>p.id===button.dataset.openProject);state.selectedId=null;state.centerId=null;state.focusScopeId=null;state.focusBranchIds.clear();closeMediumView();closeModal();await loadGraph();});
  } catch(error){toast(error.message,'error');}
}
async function openSourcesModal(){try{const sources=await api(`/api/projects/${state.project.id}/sources`);showModal(`<button class="modal-close">×</button><h2>Source collection</h2><p class="modal-subtitle">Every web result retained by research is listed with collection status and a transparent, heuristic reliability signal.</p><div class="view-list">${sources.map(s=>`<article class="view-card"><h3>${esc(s.title)}</h3><p>${esc(s.source_type)} · ${esc(s.reliability)}<br>Retrieved ${new Date(s.retrieved_at).toLocaleString()} · ${esc(s.collection_status)}</p>${s.relevant_passage?`<p>${esc(brief(s.relevant_passage,260))}</p>`:''}<button class="minor-button" data-open-source="${esc(s.id)}">Read in app</button> <a class="minor-button" href="${safeUrl(s.url)}" target="_blank" rel="noreferrer">Open original ↗</a> <button class="minor-button" data-recheck-source="${esc(s.id)}">Recheck</button></article>`).join('')||'<p class="empty-copy">No sources yet. Run a web research command to build this collection.</p>'}</div>`);$$('[data-recheck-source]').forEach(button=>button.onclick=()=>recheckSource(button.dataset.recheckSource,button));
$$('[data-open-source]').forEach(button=>button.onclick=()=>openSavedSource(button.dataset.openSource));}catch(error){toast(error.message,'error');}}
// A saved source keeps its kind, so it reopens in the viewer that fits it.
async function openSavedSource(sourceId){
  const source=(await api(`/api/sources/${encodeURIComponent(sourceId)}`)) || {};
  const kind=String(source.source_type||'').toLowerCase();
  if(['video','music'].includes(kind)) return openReader({kind:'media',title:source.title,provider:source.website||'Saved source',thumbnail:source.metadata?.thumbnail||'',playback:await playbackFor(source)});
  if(kind==='image') return openReader({kind:'image',title:source.title,src:source.url,original:source.url,caption:source.website||''});
  if(kind==='dictionary') return openReader({kind:'dictionary',term:source.title,entry:source.metadata?.providerMetadata?.entry||null});
  return openReader({kind:'web',title:source.title,url:source.url});
}
async function recheckSource(sourceId, button){try{button.disabled=true;button.textContent='Checking…';const result=await api(`/api/sources/${sourceId}/recheck`,{method:'POST',body:'{}'});toast(result.message,result.changed?'success':'');await loadGraph();openSourcesModal();}catch(error){toast(error.message,'error');if(button){button.disabled=false;button.textContent='Recheck';}}}
async function openQueueModal(){try{const items=await api(`/api/projects/${state.project.id}/queue`);showModal(`<button class="modal-close">×</button><h2>Research queue</h2><p class="modal-subtitle">Questions generated from genuine gaps stay open until you resolve, defer or dismiss them.</p><div class="view-list">${items.map(item=>`<article class="view-card ${item.status!=='open'?'queue-done':''}"><h3>${esc(item.question)} <span class="proposal-label">${esc(item.priority)}</span></h3><p>${esc(item.reason||'No reason recorded.')}</p><button class="minor-button" data-research-queue="${esc(item.id)}" data-question="${esc(item.question)}" data-target-node="${esc(item.node_id || '')}">Research this gap</button> <button class="minor-button" data-finish-queue="${esc(item.id)}">${item.status==='open'?'Mark done':'Reopen'}</button></article>`).join('')||'<p class="empty-copy">No open questions. Use “What am I missing?” to generate evidence-aware next steps.</p>'}</div>`);$$('[data-research-queue]').forEach(btn=>btn.onclick=()=>{closeModal();const target=state.graph.nodes.find(node=>node.id===btn.dataset.targetNode);if(target)centreNode(target);growNeuralNetwork(btn.dataset.question,target?.id || '');});$$('[data-finish-queue]').forEach(btn=>btn.onclick=async()=>{await api(`/api/queue/${btn.dataset.finishQueue}`,{method:'PATCH',body:JSON.stringify({status:btn.textContent.includes('Reopen')?'open':'done'})});openQueueModal();loadGraph();});}catch(error){toast(error.message,'error');}}
async function openHistoryModal(mode='history'){try{const history=await api(`/api/projects/${state.project.id}/history`);showModal(`<button class="modal-close">×</button><h2>${mode==='research'?'Research sessions':'Research trail'}</h2><p class="modal-subtitle">An auditable record of what was searched, the relevance decisions, retained source quotations, open gaps, and any failures.</p><div class="view-list">${history.sessions.map(s=>`<article class="view-card"><h3>${esc(s.request)} <span class="proposal-label">${esc(s.status)}</span></h3><p>${new Date(s.created_at).toLocaleString()} · ${esc(s.model||'search engine')}<br>${esc(brief(s.analysis?.summary||s.error||'No synthesis recorded.',360))}</p>${s.plan?.length?`<p><b>Plan:</b> ${esc(s.plan.map(step=>typeof step==='string'?step:step.label).join(' · '))}</p>`:''}<button class="minor-button" data-repeat="${esc(s.request)}">Research again</button> <button class="minor-button" data-session-log="${esc(s.id)}">Research log</button></article>`).join('')||'<p class="empty-copy">No research has been run in this project yet.</p>'}</div>`);$$('[data-repeat]').forEach(btn=>btn.onclick=()=>{closeModal();growNeuralNetwork(btn.dataset.repeat);});$$('[data-session-log]').forEach(btn=>btn.onclick=()=>openResearchLog(btn.dataset.sessionLog));}catch(error){toast(error.message,'error');}}
async function openResearchLog(sessionId){
  try { const output=await api(`/api/research/${encodeURIComponent(sessionId)}/decisions`); const engine=output.session.analysis?.engine||{}; const decisions=output.decisions||[];
    showModal(`<button class="modal-close">×</button><h2>Research log</h2><p class="modal-subtitle">${esc(output.session.request)} · the engine records why it searched, ranked, kept, paused or queued work.</p><div class="research-log-summary"><b>${esc(engine.selectedSources||0)} relevance-ranked sources</b> · <b>${esc(engine.independentLineages||0)} independent domains</b> · <b>${esc(engine.sourceQuotedClaims||0)} source quotations</b> · <b>${esc(engine.openGaps||0)} open gaps</b></div><div class="view-list">${decisions.map(item=>`<article class="view-card research-log-entry"><h3>${esc(item.stage)} · ${esc(item.decision)}</h3><p>${esc(item.reason||'No additional rationale recorded.')}</p>${item.data?.query?`<p><b>Query:</b> ${esc(item.data.query)}</p>`:''}</article>`).join('')||'<p class="empty-copy">No research decisions were recorded for this older session.</p>'}</div>`);
  } catch(error){toast(error.message,'error');}
}
async function openFilesModal(){try{const files=await api(`/api/projects/${state.project.id}/files`);showModal(`<button class="modal-close">×</button><h2>Research files</h2><p class="modal-subtitle">Files stay on this machine. Images, video, audio, PDFs and text open in this application's own viewers.</p><div class="view-list">${files.map(f=>`<article class="view-card"><h3>${esc(f.original_name)}</h3><p>${esc(f.mime_type)} · ${(f.size/1024/1024).toFixed(2)} MB · added ${new Date(f.created_at).toLocaleString()}</p><div class="reader-actions"><button class="minor-button" data-view-file="${esc(f.id)}" data-file-name="${esc(f.original_name)}" data-file-type="${esc(f.mime_type)}">Open in app</button><a class="minor-button" href="/api/files/${esc(f.id)}/download">Download</a></div></article>`).join('')||'<p class="empty-copy">Attach a file from the command bar to add it here.</p>'}</div>`);$$('[data-view-file]').forEach(btn=>btn.onclick=()=>openLocalFile(btn.dataset.viewFile,btn.dataset.fileName,btn.dataset.fileType));}catch(error){toast(error.message,'error');}}
// Local files render with the same viewers used for saved public sources.
function openLocalFile(id,name,mime=''){
  const type=String(mime||'');
  if(type.startsWith('image/')) return openReader({kind:'image',title:name,src:`/api/files/${encodeURIComponent(id)}/view`,original:`/api/files/${encodeURIComponent(id)}/view`,caption:name});
  if(type.startsWith('video/')) return openReader({kind:'media',title:name,provider:'Local file',playback:{kind:'direct',mimeType:type,url:`/api/files/${encodeURIComponent(id)}/view`,originalUrl:`/api/files/${encodeURIComponent(id)}/view`,source:'this device',provider:'Local file'}});
  if(type.startsWith('audio/')) return openReader({kind:'media',title:name,provider:'Local file',playback:{kind:'direct',mimeType:type,url:`/api/files/${encodeURIComponent(id)}/view`,originalUrl:`/api/files/${encodeURIComponent(id)}/view`,source:'this device',provider:'Local file'}});
  if(type==='application/pdf') return openReader({kind:'document',title:name,src:`/api/files/${encodeURIComponent(id)}/view`,original:`/api/files/${encodeURIComponent(id)}/view`});
  if(/^text\/|json|xml|csv|markdown/i.test(type)) return openReader({kind:'textfile',title:name,id});
  return openReader({kind:'unavailable',title:name,message:'This file type has no in-app viewer. Use Download to open it with an application on your device.',original:`/api/files/${encodeURIComponent(id)}/download`});
}
function openSettingsModal() {
  const sources=(state.status?.webSearch?.sources||[]).join(' · ');
  showModal(`<button class="modal-close">×</button><h2>Settings</h2><p class="modal-subtitle">This application searches public indexes and reads the results itself. There is no AI, no account and no API key.</p><div class="view-list"><section class="view-card setting-card"><p class="settings-kicker">SEARCH</p><h3>Public source indexes</h3><p>${esc(sources||'Wikipedia · Wikimedia Commons · OpenAlex · Crossref · arXiv · Internet Archive')}</p><p class="setting-help">Every search is made directly by this server to those public indexes. Results keep their provider, original URL and supplied metadata.</p></section><section class="view-card setting-card"><p class="settings-kicker">READERS</p><h3>In-app viewers</h3><p>Dictionary, Wikipedia article, web page reader, image viewer, video and audio player, and a document reader — all built into this application.</p></section><section class="view-card setting-card"><p class="settings-kicker">MAP CONTROLS</p><h3>Canvas</h3><p>The map is arranged in a clear 2D topic → keyword → evidence → source order. Use Fit map, zoom, or drag empty space to read the project.</p><button class="minor-button" id="reset-map-view">Fit complete map</button></section><section class="view-card setting-card"><p class="settings-kicker">LOCAL WORKSPACE</p><h3>Project data</h3><p>Projects, map nodes, source records, search sessions and files are saved locally in this workspace.</p><button class="minor-button" id="open-privacy-from-settings">View privacy & data</button></section></div>`);
  $('#reset-map-view').onclick = () => { fitMap(); renderMap(); toast('The complete 2D map is fitted to the workspace.'); };
  $('#open-privacy-from-settings').onclick = openPrivacyModal;
}
function openPrivacyModal() {
  showModal(`<button class="modal-close">×</button><h2>Privacy &amp; data</h2><p class="modal-subtitle">A plain-language record of what this local application stores and what it sends outside your workspace.</p><div class="view-list"><section class="view-card"><p class="settings-kicker">NO AI SERVICE</p><h3>Nothing is generated</h3><p>There is no AI provider in this application. Every result you see was returned by a public source index or is a page this server fetched directly.</p></section><section class="view-card"><p class="settings-kicker">SENT ONLY WHEN YOU ASK</p><h3>Search and reader requests</h3><p>Your search term goes to the public indexes listed in Settings. Opening a reader sends only that article title, word or page address. Typing suggestions send the current word to Wikipedia.</p></section><section class="view-card"><p class="settings-kicker">NEVER SENT</p><h3>Private workspace data</h3><p>Your full database, unrelated notes and files you did not open are never sent anywhere.</p></section><section class="view-card"><p class="settings-kicker">STORED LOCALLY</p><h3>Research trail</h3><p>Projects, nodes, connections, collected source records, search sessions, queues and files remain in the local workspace. There is no key to store.</p></section></div>`);
}
function openTimelineModal(){const events=state.graph.nodes.filter(n=>n.type==='event');showModal(`<button class="modal-close">×</button><h2>Timeline</h2><p class="modal-subtitle">Event nodes in the current Brain. Add dates to node notes today; the schema already reserves timeline-event storage for a richer chronological view.</p><div class="view-list">${events.map(e=>`<article class="view-card"><h3>📅 ${esc(e.title)}</h3><p>${esc(e.body||'No date or description recorded.')}</p></article>`).join('')||'<p class="empty-copy">No event nodes have been accepted into this Brain yet.</p>'}</div>`);}
function activateBottomNav(id){$$('.mobile-nav button').forEach(button=>button.classList.toggle('active',button.id===id));}
function openMoreModal(){showModal(`<button class="modal-close">×</button><h2>More</h2><p class="modal-subtitle">Additional project views and data controls.</p><div class="view-list"><button class="view-card more-action" data-more="timeline"><h3>◷ Timeline</h3><p>Review accepted event nodes in chronological context.</p></button><button class="view-card more-action" data-more="history"><h3>◌ Research trail</h3><p>Review past search sessions and their decisions.</p></button><button class="view-card more-action" data-more="privacy"><h3>◈ Privacy &amp; data</h3><p>See what remains local and what a search sends.</p></button><button class="view-card more-action" data-more="settings"><h3>⚙ Settings</h3><p>Source indexes, readers and map controls.</p></button></div>`);$$('[data-more]').forEach(button=>button.onclick=()=>{const action=button.dataset.more;if(action==='timeline')openTimelineModal();if(action==='history')openHistoryModal();if(action==='privacy')openPrivacyModal();if(action==='settings')openSettingsModal();});}

/* ================================================================= readers
   These viewers are this application's own. A reader receives data from /api/read/*
   (dictionary senses, Wikipedia sections, readable page text, a playable media URL)
   and renders it here: no third-party player, widget or embed is used anywhere.
*/
function closeReader(){ const overlay=$('#reader-overlay'); if(!overlay)return; overlay.hidden=true; overlay.replaceChildren(); state.reader=null; document.body.classList.remove('has-reader'); }
function readerShell({ kicker='READER', title='', origin='', actions='', body='' }){
  const overlay=$('#reader-overlay'); overlay.hidden=false; document.body.classList.add('has-reader');
  overlay.innerHTML=`<div class="reader-shell"><header class="reader-bar"><span class="reader-kicker">${esc(kicker)}</span><div style="min-width:0"><h2>${esc(title)}</h2><div class="reader-origin">${esc(origin)}</div></div><nav>${actions}<button type="button" class="reader-close" data-reader-close>Close ×</button></nav></header><div class="reader-body">${body}</div></div>`;
  overlay.querySelector('[data-reader-close]').onclick=closeReader;
  overlay.onclick=event=>{ if(event.target===overlay) closeReader(); };
  return overlay.querySelector('.reader-body');
}
const readerLoading = (label='Reading the public source…')=>`<p class="reader-status"><span class="spin">◌</span> ${esc(label)}</p>`;
const readerError = message=>`<div class="reader-error">${esc(message)}</div>`;
function readerExternal(name,url,label='Open the original'){ const safe=safeUrl(url); return safe==='#'?'':`<a href="${safe}" target="_blank" rel="noreferrer">${esc(label)} · ${esc(name)} ↗</a>`; }

/* ------------------------------------------------------------- dispatcher */
async function openReader(request={}){
  const kind=request.kind;
  if(kind==='image') return openImageReader(request);
  if(kind==='media') return openMediaReader(request);
  if(kind==='dictionary') return openDictionaryReader(request);
  if(kind==='wikipedia') return openWikipediaReader(request);
  if(kind==='web') return openWebReader(request);
  if(kind==='document') return openDocumentReader(request);
  if(kind==='textfile') return openTextFileReader(request);
  if(kind==='unavailable') return openUnavailableReader(request);
  return openLinkReader(request);
}
// Entry point used by search results, saved sources and the map inspector.
async function openResult(item={}){
  const url=safeUrl(item.url||'');
  if(item.kind==='image') return openReader({kind:'image',title:item.title,src:url,original:url,caption:item.snippet||item.provider||''});
  if(item.kind==='video'||item.kind==='music') return openReader({kind:'media',title:item.title,provider:item.provider,thumbnail:item.thumbnail,playback:await playbackFor(item)});
  if(item.kind==='dictionary') return openReader({kind:'dictionary',term:item.metadata?.entry?.word||item.title,entry:item.metadata?.entry});
  const wikipedia=/^https?:\/\/[a-z]{2}\.wikipedia\.org\/wiki\//i.test(url);
  if(item.kind==='article'&&(item.provider==='Wikipedia'||wikipedia)) return openReader({kind:'wikipedia',title:item.title,summary:item.snippet});
  if(item.kind==='book'||item.kind==='paper'||item.kind==='document') return openReader({kind:'web',title:item.title,url});
  return openReader({kind:'web',title:item.title,url});
}
async function playbackFor(item,thumbnail=''){
  try { return await api(`/api/read/playback?url=${encodeURIComponent(item.url||'')}&thumbnail=${encodeURIComponent(thumbnail||item.thumbnail||'')}`); }
  catch { return { kind:'external', originalUrl:safeUrl(item.url||'') }; }
}
// Reader shortcuts for a selected map node.
function openReaderForNode(medium,node){
  const term=mediaSearchQuery(node);
  if(!term){ toast('This card has no searchable wording.','error'); return; }
  if(medium==='dictionary') return openReader({kind:'dictionary',term});
  if(medium==='wikipedia') return openReader({kind:'wikipedia',title:term});
  return openMediumView(medium,node);
}

/* -------------------------------------------------------------- dictionary */
function dictionaryBody(entry,wikipedia){
  const audio=entry.audio?`<button type="button" class="dict-audio" data-dict-audio="${esc(entry.audio)}">🔊 Hear it</button>`:'';
  const senses=(entry.meanings||[]).map(meaning=>`<div class="dict-sense-group"><span class="dict-pos">${esc(meaning.partOfSpeech||'sense')}</span><ol class="dict-senses">${meaning.definitions.map(definition=>`<li>${esc(definition.definition)}${definition.example?`<span class="dict-example">“${esc(definition.example)}”</span>`:''}</li>`).join('')}</ol>${(meaning.synonyms||[]).length?`<div class="dict-relations"><b>Synonyms:</b> ${meaning.synonyms.slice(0,8).map(esc).join(', ')}</div>`:''}${(meaning.antonyms||[]).length?`<div class="dict-relations"><b>Antonyms:</b> ${meaning.antonyms.slice(0,8).map(esc).join(', ')}</div>`:''}</div>`).join('');
  return `<div class="dict-entry"><div class="dict-headword"><h3>${esc(entry.word)}</h3>${entry.phonetic?`<span class="dict-phonetic">${esc(entry.phonetic)}</span>`:''}${audio}</div>${entry.origin?`<p class="reader-status">Origin: ${esc(entry.origin)}</p>`:''}${senses}</div>${wikipedia?`<h4 class="reader-lead">${esc(wikipedia.title)}</h4><p>${esc(wikipedia.extract||'')}</p><p><a href="#" data-reader-wikipedia="${esc(wikipedia.title)}">Read the full Wikipedia article inside this app →</a></p>`:'<p class="reader-status">This dictionary has no encyclopaedia cross-reference for that word.</p>'}`;
}
async function openDictionaryReader({term='',entry=null}={}){
  const word=String(term||'').trim();
  readerShell({kicker:'DICTIONARY',title:word||'Look up a word',origin:'dictionaryapi.dev · Wiktionary-derived · Wikipedia cross-reference',body:readerLoading(`Looking up “${word}”…`)});
  if(!word){ return renderDictionaryReader('',null,null,'Type a word to look up.'); }
  try {
    let result;
    if(entry){ result={term:entry.word,entries:[entry],provider:'Dictionary'}; }
    else result=await api(`/api/read/dictionary?q=${encodeURIComponent(word)}`);
    renderDictionaryReader(result.term||word,result.entries?.[0]||null,result.wikipedia,result.entries?.length?'':`No dictionary entry was found for “${word}”. Try a single word, or search the web for the phrase.`);
  } catch(error){ renderDictionaryReader(word,null,null,error.message); }
}
function renderDictionaryReader(word,entry,wikipedia,message){
  const body=readerShell({kicker:'DICTIONARY',title:entry?.word||word,origin:'dictionaryapi.dev · Wiktionary-derived · Wikipedia cross-reference',body:entry?dictionaryBody(entry,wikipedia):readerError(message||'No entry found.')});
  body.querySelector('[data-dict-audio]')?.addEventListener('click',event=>{ const audio=new Audio(event.currentTarget.dataset.dictAudio); audio.play().catch(()=>toast('This recording could not be played.','error')); });
  body.querySelector('[data-reader-wikipedia]')?.addEventListener('click',event=>{ event.preventDefault(); openReader({kind:'wikipedia',title:event.currentTarget.dataset.readerWikipedia}); });
}

/* --------------------------------------------------------------- wikipedia */
const wikiSectionId = index=>`wiki-section-${index}`;
function wikipediaBody(article){
  const nav=article.sections.length>2?`<nav class="reader-section-nav">${article.sections.map((section,index)=>`<button type="button" data-wiki-jump="${index}">${esc(brief(section.title,42))}</button>`).join('')}</nav>`:'';
  const sections=article.sections.map((section,index)=>`<section id="${wikiSectionId(index)}"><h3>${esc(section.title)}</h3>${section.text.split('\n\n').filter(Boolean).map(paragraph=>`<p>${esc(paragraph)}</p>`).join('')}</section>`).join('');
  const images=article.images.length?`<h3>Images from the article</h3><div class="reader-image-grid">${article.images.slice(0,12).map(url=>`<img src="${safeUrl(url)}" alt="" loading="lazy" data-reader-image="${esc(url)}">`).join('')}</div>`:'';
  const links=article.links.length?`<h3>Linked articles</h3><ul class="reader-link-list">${article.links.slice(0,30).map(title=>`<li><a href="#" data-wiki-article="${esc(title)}">${esc(title)}</a></li>`).join('')}</ul>`:'';
  return `${nav}${sections||'<p class="reader-status">This article has no readable sections.</p>'}${images}${links}<div class="reader-actions">${readerExternal('Wikipedia',article.url,'Open the original article')}</div>`;
}
async function openWikipediaReader({title='',summary=''}={}){
  const name=String(title||'').trim();
  readerShell({kicker:'WIKIPEDIA',title:name||'Wikipedia',origin:'en.wikipedia.org · article text displayed by this app',body:readerLoading(`Reading “${name}”…`)});
  if(!name) return;
  try {
    const article=await api(`/api/read/wikipedia?title=${encodeURIComponent(name)}`);
    const body=readerShell({kicker:'WIKIPEDIA',title:article.title,origin:`en.wikipedia.org · ${article.sections.length} sections read`,body:wikipediaBody(article)});
    body.querySelectorAll('[data-wiki-jump]').forEach(button=>button.onclick=()=>{ const target=body.querySelector(`#${wikiSectionId(button.dataset.wikiJump)}`); target?.scrollIntoView({behavior:'smooth',block:'start'}); });
    body.querySelectorAll('[data-wiki-article]').forEach(link=>link.onclick=event=>{ event.preventDefault(); openReader({kind:'wikipedia',title:event.currentTarget.dataset.wikiArticle}); });
    body.querySelectorAll('[data-reader-image]').forEach(image=>image.onclick=()=>openImageReader({title:article.title,src:image.dataset.readerImage,original:image.dataset.readerImage}));
  } catch(error){ readerShell({kicker:'WIKIPEDIA',title:name,origin:'en.wikipedia.org',body:`${readerError(error.message)}${summary?`<p class="reader-status">${esc(summary)}</p>`:''}`}); }
}

/* ---------------------------------------------------------------- web page */
function webReaderBody(page){
  const paragraphs=page.paragraphs.length?page.paragraphs.map(line=>`<p>${esc(line)}</p>`).join(''):`<p class="reader-status">This page returned no readable paragraphs (it may be built by scripts or require a sign-in). The original link is below.</p>`;
  const links=page.links.length?`<h3>Links on this page</h3><ul class="reader-link-list">${page.links.slice(0,40).map(link=>`<li><a href="#" data-reader-link="${esc(link.url)}">${esc(brief(link.label,70))}</a></li>`).join('')}</ul>`:'';
  return `${page.description?`<p class="reader-lead">${esc(page.description)}</p>`:''}${paragraphs}${links}<div class="reader-actions"><button type="button" data-reader-save="${esc(page.url)}" data-reader-title="${esc(page.title)}">Save this page to the map</button>${readerExternal(page.siteName,page.url,'Open the original page')}</div>`;
}
async function openWebReader({title='',url=''}={}){
  const address=safeUrl(url);
  readerShell({kicker:'WEB READER',title:title||address,origin:address,body:readerLoading('Fetching the page and reducing it to readable text…')});
  if(address==='#') return readerShell({kicker:'WEB READER',title:title,origin:'',body:readerError('That address is not a public web page.')});
  try { bindWebReader(await api(`/api/read/page?url=${encodeURIComponent(address)}`)); }
  catch(error){ bindWebReader({ url:address, title, siteName:'Original page', description:'', paragraphs:[], links:[], error:error.message }); }
  function bindWebReader(page){
    const body=readerShell({kicker:'WEB READER',title:page.title||title,origin:`${page.siteName||''} · read server-side by this app`,body:`${page.error?readerError(page.error):''}${webReaderBody(page)}`});
    body.querySelectorAll('[data-reader-link]').forEach(link=>link.onclick=event=>{ event.preventDefault(); const next=event.currentTarget.dataset.readerLink; if(/wikipedia\.org\/wiki\//i.test(next)) openReader({kind:'wikipedia',title:decodeURIComponent(next.split('/wiki/')[1]||'')}); else openReader({kind:'web',title:next,url:next}); });
    body.querySelector('[data-reader-save]')?.addEventListener('click',async event=>{
      const button=event.currentTarget; button.disabled=true; button.textContent='Saving…';
      try { await api(`/api/projects/${state.project.id}/sources/import`,{method:'POST',body:JSON.stringify({url:button.dataset.readerSave,title:button.dataset.readerTitle,query:'saved from the reader',provider:'web reader',deferCollection:true})}); button.textContent='Saved to the map'; await loadGraph(); toast('Page saved as a source branch.','success'); }
      catch(error){ button.disabled=false; button.textContent='Save this page to the map'; toast(error.message,'error'); }
    });
  }
}

/* ------------------------------------------------------------------- image */
function openImageReader({title='',src='',original='',caption=''}={}){
  const image=safeUrl(src)||safeUrl(original);
  const figure=`<figure class="reader-figure"><img id="reader-image" src="${image}" alt="${esc(title)}"><figcaption>Click the image to zoom. Brightness, rotation and download happen in your browser.</figcaption></figure><div class="reader-actions"><button type="button" data-image-zoom>Zoom</button><button type="button" data-image-brightness>Brightness</button><button type="button" data-image-rotate>Rotate</button><button type="button" data-image-download="png">Download PNG</button><button type="button" data-image-download="jpg">Download JPG</button>${readerExternal('original',original||src,'Open the original image')}</div>`;
  const body=readerShell({kicker:'IMAGE VIEWER',title,origin:caption||'Public image · shown directly by this app',body:image==='#'?readerError('No image address was supplied.'):figure});
  const img=body.querySelector('#reader-image'); if(!img)return;
  let rotation=0, bright=false;
  body.querySelector('[data-image-zoom]').onclick=()=>img.classList.toggle('zoomed');
  img.onclick=()=>img.classList.toggle('zoomed');
  body.querySelector('[data-image-rotate]').onclick=()=>{ rotation=(rotation+90)%360; img.style.transform=`rotate(${rotation}deg)`; img.style.transition='transform .2s ease'; };
  body.querySelector('[data-image-brightness]').onclick=()=>{ bright=!bright; img.style.filter=bright?'brightness(1.35) contrast(1.05)':'none'; };
  body.querySelectorAll('[data-image-download]').forEach(button=>button.onclick=()=>convertImage(img,button.dataset.imageDownload,title));
}
async function convertImage(img,format,title='image'){
  try {
    await (img.complete?Promise.resolve():new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=reject;}));
    const canvas=document.createElement('canvas'); canvas.width=img.naturalWidth||img.width; canvas.height=img.naturalHeight||img.height;
    canvas.getContext('2d').drawImage(img,0,0);
    const mime=format==='png'?'image/png':'image/jpeg';
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,mime,.92));
    if(!blob) throw new Error('conversion refused');
    const link=document.createElement('a'); link.href=URL.createObjectURL(blob);
    link.download=`${mapLabel(title,'image').replace(/\s+/g,'-').toLowerCase()}.${format}`; link.click();
    setTimeout(()=>URL.revokeObjectURL(link.href),1200); toast(`Image downloaded as ${format.toUpperCase()}.`,'success');
  } catch { toast('This source blocks browser conversion. Use the original-image link instead.','error'); }
}

/* ---------------------------------------------------------- video / audio */
function mediaBody(playback,title){
  if(playback.kind==='direct'){
    const isAudio=/^audio\//i.test(playback.mimeType||'');
    const player=isAudio
      ? `<audio controls preload="metadata" src="${safeUrl(playback.url)}"></audio>`
      : `<video id="reader-video" controls preload="metadata" playsinline poster="${safeUrl(playback.poster||'')}" src="${safeUrl(playback.url)}"></video>`;
    return `<div class="media-player-frame">${player}</div>${isAudio&&playback.poster?`<img class="reader-figure" src="${safeUrl(playback.poster)}" alt="" style="max-height:220px;object-fit:contain">`:''}`;
  }
  // A source that only offers its own player is stated plainly rather than faked:
  // the real poster is shown, and the button says where it will open.
  const note=`<div class="media-note">“${esc(title)}” cannot be streamed directly by this app — this source only offers it on its own page. The poster and original link below still work.</div>`;
  const poster=playback.poster?`<div class="media-poster-stage"><img src="${safeUrl(playback.poster)}" alt=""><button type="button" class="media-play-badge" data-play-external aria-label="Open the original page"><span>▶</span></button></div>`:'';
  return `${poster}${note}`;
}
async function openMediaReader({title='',playback=null,provider='',thumbnail='',url=''}={}){
  readerShell({kicker:'MEDIA PLAYER',title,origin:provider||'Media source',body:readerLoading('Finding a playable file for this source…')});
  const resolved=playback||await playbackFor({url,thumbnail});
  const playState=resolved.kind==='direct'?`<span><b>Playing in app</b> · ${esc(resolved.mimeType||'media')}</span>`:'<span><b>Original page only</b></span>';
  const detail=`<div class="media-reader">${mediaBody(resolved,title)}<div class="media-meta">${playState}${resolved.label?`<span>File: ${esc(resolved.label)}</span>`:''}</div><div class="reader-actions">${readerExternal('source',resolved.originalUrl||url||thumbnail,'Open the original')}</div></div>`;
  const body=readerShell({kicker:'MEDIA PLAYER',title,origin:resolved.provider||provider||'Media source',body:detail});
  body.querySelector('[data-play-external]')?.addEventListener('click',()=>{ const link=safeUrl(resolved.originalUrl||url); if(link!=='#') window.open(link,'_blank','noreferrer'); });
  const video=body.querySelector('#reader-video');
  if(video) video.addEventListener('error',()=>{ const note=body.querySelector('.media-meta'); if(note) note.insertAdjacentHTML('beforebegin','<div class="media-note">The direct file could not be played by this browser. Use the original-source link below.</div>'); });
}

/* ------------------------------------------------- pdf and text documents */
function openDocumentReader({title='',src='',original=''}={}){
  const source=safeUrl(src)||safeUrl(original);
  const body=readerShell({kicker:'DOCUMENT READER',title,origin:'PDF displayed by this app',body:`${source==='#'?readerError('No document address was supplied.'):`<iframe class="medium-frame" style="width:100%;height:70vh;border:1px solid rgba(120,190,255,.2);border-radius:12px;background:#0b1626" src="${source}" title="${esc(title)}"></iframe><div class="reader-actions">${readerExternal('original',original||src,'Open the original document')}</div>`}`});
  return body;
}
async function openTextFileReader({title='',id=''}={}){
  readerShell({kicker:'TEXT READER',title,origin:'Local file · read from this device',body:readerLoading('Reading the file…')});
  try {
    const file=await api(`/api/files/${encodeURIComponent(id)}/text`);
    readerShell({kicker:'TEXT READER',title:file.name||title,origin:`${file.mimeType} · ${file.text.length} characters`,body:`<pre style="white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;line-height:1.6">${esc(file.text)}</pre>`});
  } catch(error){ readerShell({kicker:'TEXT READER',title,origin:'Local file',body:readerError(error.message)}); }
}
function openUnavailableReader({title='',message='',original=''}={}){
  readerShell({kicker:'VIEWER',title,origin:'No in-app viewer for this type',body:`${readerError(brief(message||'This item cannot be shown inside the app.',300))}<div class="reader-actions">${readerExternal('file',original,'Download it')}</div>`});
}
async function openLinkReader({title='',url=''}={}){
  const wiki=/^https?:\/\/[a-z]{2}\.wikipedia\.org\/wiki\/(.+)$/i.exec(url||'');
  if(wiki) return openReader({kind:'wikipedia',title:decodeURIComponent(wiki[1]).replace(/_/g,' ')});
  return openReader({kind:'web',title,url});
}

async function uploadFiles(fileList){if(!fileList?.length)return;const form=new FormData();[...fileList].forEach(file=>form.append('files',file));try{toast(`Uploading ${fileList.length} file${fileList.length===1?'':'s'}…`);const response=await fetch(`/api/projects/${state.project.id}/files`,{method:'POST',body:form});const files=await response.json();if(!response.ok)throw new Error(files.error||'Upload failed.');for(const f of files){const type=f.mime_type.startsWith('image/')?'image':f.mime_type.startsWith('video/')?'video':'document';const parent=state.graph.nodes.find(node=>node.id===state.selectedId);const angle=(state.graph.nodes.length*1.618)%6.28;const created=await api(`/api/projects/${state.project.id}/nodes`,{method:'POST',body:JSON.stringify({type,title:f.original_name,body:'User-provided research file. Open it in the file reader to read or play it.',priority:'informational',confidence:'unverified',origin:'user',x:(Number(parent?.x)||0)+290*Math.cos(angle),y:(Number(parent?.y)||0)+210*Math.sin(angle),metadata:{fileId:f.id,mimeType:f.mime_type,attachedTo:parent?.id||null}})});if(parent)await api(`/api/projects/${state.project.id}/connections`,{method:'POST',body:JSON.stringify({from_node_id:parent.id,to_node_id:created.id,relationship:'documents',notes:'User attached this local file to the selected thought.'})});}await loadGraph();toast(`${files.length} file${files.length===1?'':'s'} added${state.selectedId?' to the selected thought':' locally to your Brain'}.`,'success');}catch(error){toast(error.message,'error');}finally{$('#file-input').value='';}}
// A single command entry point: the mode decides which reader or search runs.
function runCommand(value, mode='web'){
  if(mode==='dictionary') return openReader({kind:'dictionary',term:value});
  if(mode==='wikipedia') return openReader({kind:'wikipedia',title:value});
  if(mode==='media') return openSourceSearchModal(value,false,'','images');
  return openSourceSearchModal(value);
}
function promptReaderUrl(){
  const overlay=$('#reader-overlay'); overlay.hidden=false; document.body.classList.add('has-reader');
  overlay.innerHTML=`<div class="reader-shell"><header class="reader-bar"><span class="reader-kicker">WEB READER</span><div><h2>Read a page</h2><div class="reader-origin">Paste any public http(s) address. It is fetched by this server and shown here.</div></div><nav><button type="button" class="reader-close" data-reader-close>Close ×</button></nav></header><div class="reader-body"><form id="reader-url-form" style="display:flex;gap:10px;flex-wrap:wrap"><input id="reader-url-input" type="url" required autocomplete="url" placeholder="https://example.com/article" style="flex:1;min-width:260px;padding:12px 14px;border-radius:10px;border:1px solid rgba(120,190,255,.3);background:rgba(10,22,36,.9);color:#e6f2ff"><button class="primary-button" type="submit">Read it</button></form></div></div>`;
  overlay.querySelector('[data-reader-close]').onclick=closeReader;
  overlay.onclick=event=>{ if(event.target===overlay) closeReader(); };
  const input=overlay.querySelector('#reader-url-input'); input.focus();
  overlay.querySelector('#reader-url-form').onsubmit=event=>{ event.preventDefault(); const url=input.value.trim(); if(url) openReader({kind:'web',title:url,url}); };
}
// Serendipity: reads the day's featured article list from Wikipedia and opens one at random.
// Nothing is invented — the choice comes from a real public page.
async function surpriseMe(){
  try {
    toast('Finding something to read…');
    const page=await api('/api/read/page?url=' + encodeURIComponent('https://en.wikipedia.org/wiki/Wikipedia:Today%27s_featured_article'));
    const candidates=(page.links||[]).filter(link=>/\/wiki\//.test(link.url)&&!/^(?:Wikipedia|Help|Portal|Category|Special|File|Talk|Template):/i.test(decodeURIComponent((link.url.split('/wiki/')[1]||'')))).slice(0,25);
    if(!candidates.length) throw new Error('No article was offered today. Try a topic search instead.');
    const pick=candidates[Math.floor(Math.random()*candidates.length)];
    openReader({kind:'wikipedia',title:decodeURIComponent(pick.url.split('/wiki/')[1]||'').replace(/_/g,' ')});
  } catch(error){ toast(error.message,'error'); }
}
function setModeUI(){ $$('.mode-button').forEach(button=>button.classList.toggle('selected',button.dataset.mode===state.mode)); $('#command-input').placeholder=modePlaceholder(); }
function initEvents(){
  $('#command-form').onsubmit=event=>{event.preventDefault();const input=$('#command-input');const value=input.value.trim();if(!value)return;input.value='';runCommand(value,state.mode);};
  $$('.mode-button').forEach(button=>button.onclick=()=>{state.mode=button.dataset.mode;setModeUI();$('#command-input').focus();});
  $$('.suggestions button').forEach(button=>button.onclick=()=>{
    const action=button.dataset.command;
    // Chips are immediate actions rather than placeholder text, so nothing pretends to answer.
    if(action==='Look up a word'){ state.mode='dictionary'; setModeUI(); $('#command-input').placeholder='Type one word, then press ↑'; $('#command-input').focus(); return; }
    if(action==='Read a web page'){ openReader({kind:'web',title:'Read a page',url:''}); promptReaderUrl(); return; }
    if(action==='Serendipity'){ surpriseMe(); return; }
    const val=action.replace(/^Search a topic$/,'South African history'); $('#command-input').value=val; state.mode='web'; setModeUI(); $('#command-input').focus();
  });
  const emptyInput=$('#empty-command-input'), emptyStatus=$('#empty-search-status');
  const beginInitialGrowth=()=>{const query=emptyInput.value.trim();if(query.length<2)return;state.mode='web';setModeUI();growNeuralNetwork(query);};
  // Typing only offers reviewable spelling/topic choices. Enter is the deliberate
  // commitment: the exact text in the long centre box is the search request.
  $('#empty-command-form').onsubmit=event=>{event.preventDefault();hideTypingAssist($('#empty-typing-assist'));beginInitialGrowth();};
  emptyInput.oninput=()=>{if(emptyInput.value.trim())emptyStatus.textContent='Suggestions appear as you type. Press Enter when this is your search.';}; setupTypingAssist(emptyInput,$('#empty-typing-assist')); $('#add-thought')?.addEventListener('click',()=>openNodeModal()); $('#attach-button').onclick=()=>$('#file-input').click(); $('#file-input').onchange=event=>uploadFiles(event.target.files);
  $('#new-project').onclick=()=>startNewSearchProject($('#new-project')); $('#project-switcher').onclick=openProjectsModal; $('#search-button').onclick=openSearchModal; $('#settings-button').onclick=openSettingsModal; $('#api-status').onclick=openSettingsModal; $('#mobile-brain').onclick=()=>{closeModal();activateBottomNav('mobile-brain');$('#command-input').focus();}; $('#mobile-projects').onclick=()=>{activateBottomNav('mobile-projects');openProjectsModal();}; $('#mobile-research').onclick=()=>{activateBottomNav('mobile-research');state.mode='web';setModeUI();openSourceSearchModal();}; $('#mobile-sources').onclick=()=>{activateBottomNav('mobile-sources');openSourcesModal();}; $('#mobile-questions').onclick=()=>{activateBottomNav('mobile-questions');openQueueModal();}; $('#mobile-files').onclick=()=>{activateBottomNav('mobile-files');openFilesModal();}; $('#mobile-more').onclick=()=>{activateBottomNav('mobile-more');openMoreModal();}; $('#focus-button').onclick=()=>{if(state.focusScopeId){showFullMap();toast('Returned to the full saved map.');}else{fitMap();renderMap();toast('Map fitted to the current 2D project.');}};
  $$('.nav-item[data-view]').forEach(button=>button.onclick=()=>openView(button.dataset.view));
  $('#zoom-in').onclick=()=>{state.scale=Math.min(2.4,state.scale+.12);renderMap();};
  $('#zoom-out').onclick=()=>{state.scale=Math.max(.14,state.scale-.12);renderMap();};
  $('#fit-map').onclick=()=>{if(state.focusScopeId)showFullMap();else{fitMap();renderMap();}};
  $('#nodes-layer').addEventListener('click',event=>{const target=event.target.closest('.brain-node');if(!target||state.suppressNodeClick)return;const node=state.graph.nodes.find(item=>item.id===target.dataset.id);if(node)void focusAndResearchNode(node);});
  $('#nodes-layer').addEventListener('contextmenu',event=>{const target=event.target.closest('.brain-node');if(!target)return;event.preventDefault();const node=state.graph.nodes.find(item=>item.id===target.dataset.id);if(node)void selectAsMapCentre(node,true);});
  $('#nodes-layer').addEventListener('pointerdown',event=>{const target=event.target.closest('.brain-node');if(!target||event.button!==0)return;const node=state.graph.nodes.find(item=>item.id===target.dataset.id);if(!node)return;event.preventDefault();event.stopPropagation();if(node.id===state.centerId){state.drag={kind:'pan',selectedCenterId:node.id,startX:event.clientX,startY:event.clientY,origPanX:state.camera.panX,origPanY:state.camera.panY,moved:false};target.setPointerCapture?.(event.pointerId);return;}const offset=node.metadata?.manualOffset||{};state.drag={kind:'node',id:node.id,startX:event.clientX,startY:event.clientY,offsetX:Number(offset.x)||0,offsetY:Number(offset.y)||0,moved:false};target.setPointerCapture?.(event.pointerId);});
  $('#canvas-wrap').addEventListener('pointerdown',event=>{if(event.target.closest('.brain-node, .canvas-controls, .legend, .generation-guide, input, textarea, select, button, a, form'))return;event.preventDefault();state.drag={kind:'pan',startX:event.clientX,startY:event.clientY,origPanX:state.camera.panX,origPanY:state.camera.panY};event.currentTarget.setPointerCapture?.(event.pointerId);});
  window.addEventListener('pointermove',event=>{if(!state.drag)return;const drag=state.drag,dx=event.clientX-drag.startX,dy=event.clientY-drag.startY;if(drag.kind==='node'){const node=state.graph.nodes.find(item=>item.id===drag.id);if(!node)return;drag.moved=drag.moved||Math.abs(dx)+Math.abs(dy)>4;node.metadata={...(node.metadata||{}),manualOffset:{x:drag.offsetX+dx/state.scale,y:drag.offsetY+dy/state.scale}};buildTwoDimensionalLayout();renderMap();return;}drag.moved=drag.moved||Math.abs(dx)+Math.abs(dy)>4;state.camera.panX=drag.origPanX+dx;state.camera.panY=drag.origPanY+dy;renderMap();});
  window.addEventListener('pointerup',async()=>{const drag=state.drag;if(!drag)return;state.drag=null;const searchFromClick=async node=>{state.suppressNodeClick=true;setTimeout(()=>{state.suppressNodeClick=false;},100);await focusAndResearchNode(node);};if(drag.kind==='pan'){if(drag.selectedCenterId&&!drag.moved){const selected=state.graph.nodes.find(item=>item.id===drag.selectedCenterId);if(selected)await searchFromClick(selected);}return;}if(drag.kind!=='node')return;const node=state.graph.nodes.find(item=>item.id===drag.id);if(!node)return;if(!drag.moved){await searchFromClick(node);return;}state.suppressNodeClick=true;setTimeout(()=>{state.suppressNodeClick=false;},0);try{const point=layoutPoint(node);const saved=await api(`/api/nodes/${node.id}`,{method:'PATCH',body:JSON.stringify({x:point.x,y:point.y,metadata:node.metadata})});Object.assign(node,saved);toast('Card position saved.','success');}catch(error){toast(error.message,'error');}});
  $('#canvas-wrap').addEventListener('wheel',event=>{event.preventDefault();state.scale=Math.max(.14,Math.min(2.4,state.scale+(event.deltaY<0?.10:-.10)));renderMap();},{passive:false});
  document.addEventListener('keydown',event=>{if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='k'){event.preventDefault();openSearchModal();}if(event.key==='Escape'){if(!$('#reader-overlay').hidden)closeReader();else if(!$('#modal-backdrop').hidden)closeModal();else if(state.mediaView)closeMediumView();else if(document.body.classList.contains('has-inspector'))selectNode(null);}});
}
async function openSearchModal(){showModal(`<button class="modal-close">×</button><h2>Search this Brain</h2><p class="modal-subtitle">Search your locally accumulated nodes, collected source extracts and conversation record.</p><input id="local-search" placeholder="Everything I know about…" autocomplete="off"><div id="search-results" class="view-list" style="margin-top:12px"></div>`);const input=$('#local-search');input.focus();let timer;input.oninput=()=>{clearTimeout(timer);timer=setTimeout(async()=>{const q=input.value.trim();if(!q){$('#search-results').innerHTML='';return;}try{const r=await api(`/api/projects/${state.project.id}/search?q=${encodeURIComponent(q)}`);$('#search-results').innerHTML=`${r.nodes.map(n=>`<button class="view-card search-node" data-result-node="${esc(n.id)}"><h3>${icons[n.type]||'◈'} ${esc(n.title)}</h3><p>${esc(brief(n.body,180))}</p></button>`).join('')}${r.sources.map(s=>`<article class="view-card"><h3>📚 ${esc(s.title)}</h3><p>${esc(brief(s.relevant_passage||s.url,180))}</p><button class="minor-button" data-open-saved="${esc(s.id)}">Read in app</button> <a href="${safeUrl(s.url)}" target="_blank" rel="noreferrer">Original ↗</a></article>`).join('')}${r.conversations.map(c=>`<article class="view-card"><h3>◌ ${esc(c.role)} conversation</h3><p>${esc(brief(c.content,180))}</p></article>`).join('')||'<p class="empty-copy">No local matches.</p>'}`;$$('[data-result-node]').forEach(btn=>btn.onclick=()=>{closeModal();selectNode(btn.dataset.resultNode);});
$$('[data-open-saved]').forEach(btn=>btn.onclick=()=>{closeModal();openSavedSource(btn.dataset.openSaved);});}catch(error){toast(error.message,'error');}},180);};}

initEvents(); bootstrap();
