/* Browser-only adapter used only by TheBrain-preview.html. It lets the workspace
   file renderer exercise graph UI interactions without pretending that public-index
   search or page reading is available there. The real app always calls the server. */
(function () {
  const iso = () => new Date().toISOString();
  const id = prefix => `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
  const state = { project: { id:'preview_project', name:'My Research Brain', description:'Preview-only local map', created_at:iso(), updated_at:iso() }, projects:[], nodes:[], connections:[] };
  state.projects = [state.project];
  const decode = body => { try { return typeof body === 'string' ? JSON.parse(body || '{}') : body || {}; } catch { return {}; } };
  const notAvailable = feature => { const e = new Error(`${feature} needs the live The Brain server. The static preview never fabricates search results.`); e.status=503; throw e; };
  window.previewApi = async function(path, options={}) {
    const method=(options.method || 'GET').toUpperCase(); const payload=decode(options.body); const graph=()=>({project:state.project,nodes:state.nodes,connections:state.connections,sourceCount:0,sources:[],queue:[]});
    if(path==='/api/status') return {app:'The Brain',mode:'Search and read — no AI',webSearch:{provider:'Direct public-index search',configured:true,sources:[]},privacy:'Static preview: no API calls are made.'};
    if(path.startsWith('/api/read/')) return notAvailable('The readers');
    if(path==='/api/projects' && method==='GET') return state.projects;
    if(path==='/api/projects' && method==='POST') { const p={id:id('project'),name:String(payload.name||'Untitled Brain'),description:String(payload.description||''),created_at:iso(),updated_at:iso()};state.projects.push(p);state.project=p;state.nodes=[];state.connections=[];return p; }
    if(/\/api\/projects\/[^/]+\/graph$/.test(path) && method==='GET') return graph();
    if(/\/api\/projects\/[^/]+\/nodes$/.test(path) && method==='POST') { const n={id:id('node'),project_id:state.project.id,type:payload.type||'idea',title:payload.title||'Untitled',body:payload.body||'',priority:payload.priority||'unclassified',confidence:payload.confidence||'unverified',origin:payload.origin||'user',status:'accepted',x:Number(payload.x)||0,y:Number(payload.y)||0,metadata:payload.metadata||{},created_at:iso(),updated_at:iso()};state.nodes.push(n);return n; }
    let match=path.match(/^\/api\/nodes\/([^/]+)$/);
    if(match && method==='PATCH') { const n=state.nodes.find(x=>x.id===match[1]);if(!n)throw new Error('Node not found.');Object.assign(n,payload,{updated_at:iso()});return n; }
    if(match && method==='DELETE') { state.nodes=state.nodes.filter(n=>n.id!==match[1]);state.connections=state.connections.filter(c=>c.from_node_id!==match[1]&&c.to_node_id!==match[1]);return {}; }
    match=path.match(/^\/api\/nodes\/([^/]+)\/detail$/);
    if(match && method==='GET') { const node=state.nodes.find(x=>x.id===match[1]);if(!node)throw new Error('Node not found.');const connections=state.connections.filter(c=>c.from_node_id===node.id||c.to_node_id===node.id);const ids=connections.map(c=>c.from_node_id===node.id?c.to_node_id:c.from_node_id);return {node,sources:[],connections,related:state.nodes.filter(n=>ids.includes(n.id))}; }
    if(/\/api\/projects\/[^/]+\/connections$/.test(path) && method==='POST') { const c={id:id('edge'),project_id:state.project.id,from_node_id:payload.from_node_id,to_node_id:payload.to_node_id,relationship:payload.relationship||'related_to',confidence:'unverified',notes:payload.notes||'',created_at:iso()};state.connections.push(c);return c; }
    if(/\/api\/projects\/[^/]+\/(sources|queue|files)$/.test(path) && method==='GET') return [];
    if(/\/api\/projects\/[^/]+\/history$/.test(path)) return {sessions:[],conversations:[]};
    if(/\/api\/projects\/[^/]+\/search/.test(path)) return {nodes:[],sources:[],conversations:[]};
    if(path==='/api/privacy')return {noAiProvider:true,notSentAutomatically:[],sourceStorage:'Preview only'};
    if(path.includes('/recheck')||path.includes('/neural-grow')) return notAvailable('Public-index search and source collection');
    throw new Error(`This preview action is not available: ${method} ${path}`);
  };
})();
