import { pool } from './pool.js';

const MIGRATION = `
CREATE EXTENSION IF NOT EXISTS vector;

CREATE SCHEMA IF NOT EXISTS docmem;

CREATE TABLE IF NOT EXISTS docmem.projects (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL UNIQUE,
  root_path  TEXT NOT NULL,
  config     JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS docmem.chunks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    UUID NOT NULL REFERENCES docmem.projects(id) ON DELETE CASCADE,
  source_file   TEXT NOT NULL,
  section_path  TEXT NOT NULL,
  content       TEXT NOT NULL,
  summary       TEXT NOT NULL,
  embedding     vector(768) NOT NULL,
  token_count   INT NOT NULL,
  topic         TEXT NOT NULL,
  tags          TEXT[] DEFAULT '{}',
  last_modified TIMESTAMPTZ NOT NULL,
  checksum      TEXT NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chunks_embedding ON docmem.chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_chunks_project_topic ON docmem.chunks (project_id, topic);
CREATE INDEX IF NOT EXISTS idx_chunks_project_file ON docmem.chunks (project_id, source_file);

CREATE TABLE IF NOT EXISTS docmem.entities (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES docmem.projects(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  type       TEXT NOT NULL,
  chunk_ids  UUID[] DEFAULT '{}',
  UNIQUE (project_id, name)
);

CREATE TABLE IF NOT EXISTS docmem.relationships (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id   UUID REFERENCES docmem.chunks(id) ON DELETE CASCADE,
  target_id   UUID REFERENCES docmem.chunks(id) ON DELETE CASCADE,
  rel_type    TEXT NOT NULL,
  confidence  FLOAT DEFAULT 1.0
);

CREATE INDEX IF NOT EXISTS idx_relationships_source ON docmem.relationships (source_id);
CREATE INDEX IF NOT EXISTS idx_relationships_target ON docmem.relationships (target_id);

CREATE TABLE IF NOT EXISTS docmem.access_stats (
  chunk_id       UUID REFERENCES docmem.chunks(id) ON DELETE CASCADE PRIMARY KEY,
  access_count   INT DEFAULT 0,
  last_accessed  TIMESTAMPTZ,
  avg_usefulness FLOAT DEFAULT 0.5
);
`;

async function migrate() {
  console.log('Running docmem database migration...');
  await pool.query(MIGRATION);
  console.log('Migration complete.');
  await pool.end();
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
