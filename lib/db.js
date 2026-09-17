import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const dataDir = path.resolve('data');
fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, 'brain.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export const now = () => new Date().toISOString();

// The graph tables are deliberately normalized: a connection has a named semantic
// relationship instead of merely being a line on the canvas.
db.exec(`
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'idea', title TEXT NOT NULL, body TEXT DEFAULT '',
  priority TEXT NOT NULL DEFAULT 'unclassified', confidence TEXT NOT NULL DEFAULT 'unverified',
  origin TEXT NOT NULL DEFAULT 'user', status TEXT NOT NULL DEFAULT 'accepted',
  x REAL, y REAL, metadata TEXT DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS connections (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  from_node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  to_node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  relationship TEXT NOT NULL DEFAULT 'related_to', confidence TEXT DEFAULT 'unverified', notes TEXT DEFAULT '', created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_connections_unique ON connections(project_id, from_node_id, to_node_id, relationship);
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL, website TEXT DEFAULT '', url TEXT NOT NULL, author TEXT DEFAULT '', published_date TEXT DEFAULT '',
  retrieved_at TEXT NOT NULL, source_type TEXT DEFAULT 'website', reliability TEXT DEFAULT 'not assessed',
  extracted_text TEXT DEFAULT '', relevant_passage TEXT DEFAULT '', collection_status TEXT DEFAULT 'metadata only',
  metadata TEXT DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sources_unique_url ON sources(project_id, url);
CREATE TABLE IF NOT EXISTS source_nodes (
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  relationship TEXT NOT NULL DEFAULT 'supports', notes TEXT DEFAULT '', PRIMARY KEY(source_id, node_id, relationship)
);
-- Immutable snapshots enable transparent source-change detection instead of silently overwriting a page extract.
CREATE TABLE IF NOT EXISTS source_versions (
  id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  content_hash TEXT NOT NULL, title TEXT DEFAULT '', relevant_passage TEXT DEFAULT '', extracted_text TEXT DEFAULT '',
  collection_status TEXT DEFAULT '', retrieved_at TEXT NOT NULL, change_summary TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_source_versions_source ON source_versions(source_id, retrieved_at DESC);
-- A claim is a source quotation or later reviewed synthesis, never an untraceable fact.
CREATE TABLE IF NOT EXISTS claims (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES research_sessions(id) ON DELETE SET NULL,
  statement TEXT NOT NULL, normalized_key TEXT NOT NULL, topic TEXT DEFAULT '', branch TEXT DEFAULT '',
  relevance INTEGER DEFAULT 0, confidence TEXT DEFAULT 'unverified', distance INTEGER DEFAULT 1,
  evidence_quality INTEGER DEFAULT 0, status TEXT DEFAULT 'source_quoted', metadata TEXT DEFAULT '{}',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_claims_project_key ON claims(project_id, normalized_key);
CREATE TABLE IF NOT EXISTS claim_sources (
  claim_id TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  excerpt TEXT DEFAULT '', relationship TEXT DEFAULT 'supports', lineage TEXT DEFAULT '',
  PRIMARY KEY(claim_id, source_id, relationship)
);
CREATE TABLE IF NOT EXISTS research_decisions (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES research_sessions(id) ON DELETE CASCADE,
  stage TEXT NOT NULL, decision TEXT NOT NULL, reason TEXT DEFAULT '', data TEXT DEFAULT '{}', created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_research_decisions_session ON research_decisions(session_id, created_at);
CREATE TABLE IF NOT EXISTS research_sessions (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  request TEXT NOT NULL, selected_node_id TEXT REFERENCES nodes(id) ON DELETE SET NULL,
  status TEXT NOT NULL, plan TEXT DEFAULT '[]', analysis TEXT DEFAULT '{}', error TEXT DEFAULT '',
  model TEXT DEFAULT '', created_at TEXT NOT NULL, completed_at TEXT
);
CREATE TABLE IF NOT EXISTS search_queries (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES research_sessions(id) ON DELETE CASCADE,
  query TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS research_queue (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  node_id TEXT REFERENCES nodes(id) ON DELETE SET NULL, question TEXT NOT NULL, reason TEXT DEFAULT '', priority TEXT DEFAULT 'medium',
  status TEXT DEFAULT 'open', origin_session_id TEXT REFERENCES research_sessions(id) ON DELETE SET NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  node_id TEXT REFERENCES nodes(id) ON DELETE SET NULL, role TEXT NOT NULL, content TEXT NOT NULL, metadata TEXT DEFAULT '{}', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  original_name TEXT NOT NULL, stored_name TEXT NOT NULL, mime_type TEXT DEFAULT 'application/octet-stream', size INTEGER DEFAULT 0,
  path TEXT NOT NULL, analysis TEXT DEFAULT '{}', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tags (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, name TEXT NOT NULL, color TEXT DEFAULT '#7c8cff');
CREATE TABLE IF NOT EXISTS node_tags (node_id TEXT REFERENCES nodes(id) ON DELETE CASCADE, tag_id TEXT REFERENCES tags(id) ON DELETE CASCADE, PRIMARY KEY(node_id, tag_id));
CREATE TABLE IF NOT EXISTS timeline_events (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, node_id TEXT REFERENCES nodes(id) ON DELETE SET NULL, title TEXT NOT NULL, date_start TEXT, date_end TEXT, description TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS collections (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, name TEXT NOT NULL, description TEXT DEFAULT '', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_nodes_project ON nodes(project_id);
CREATE INDEX IF NOT EXISTS idx_sources_project ON sources(project_id);
CREATE INDEX IF NOT EXISTS idx_queue_project ON research_queue(project_id, status);
CREATE INDEX IF NOT EXISTS idx_conversations_project ON conversations(project_id, created_at);
`);

export function uid(prefix = 'id') {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function parseJson(value, fallback = {}) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

export function prepareProject(project) {
  return project && { ...project };
}

export function hydrateNode(node) {
  return node && { ...node, metadata: parseJson(node.metadata, {}) };
}

export function hydrateSource(source) {
  return source && { ...source, metadata: parseJson(source.metadata, {}) };
}

export default db;
