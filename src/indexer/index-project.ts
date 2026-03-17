import { readFileSync, statSync } from 'fs';
import { resolve, relative } from 'path';
import { glob } from 'node:fs/promises';
import { pool } from '../db/pool.js';
import { chunkMarkdown, type Chunk } from './chunker.js';
import { embedDocuments, estimateTokens } from './embedder.js';
import { extractEntities } from './entity-extractor.js';
import { extractLinks } from './link-extractor.js';

// Entities appearing in more chunks than this are too common to create useful co-occurrence links
const MAX_COOCCURRENCE_CHUNKS = 20;

interface ProjectConfig {
  project: string;
  doc_paths: string[];
  exclude?: string[];
}

interface IndexResult {
  chunksAdded: number;
  chunksUpdated: number;
  chunksRemoved: number;
  totalChunks: number;
  entitiesExtracted: number;
  relationshipsCreated: number;
}

function loadProjectConfig(projectRoot: string): ProjectConfig {
  const configPath = resolve(projectRoot, '.docmem.json');
  try {
    return JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch {
    throw new Error(`No .docmem.json found at ${configPath}. Create one first.`);
  }
}

async function discoverFiles(projectRoot: string, docPaths: string[], exclude: string[] = []): Promise<string[]> {
  const files: string[] = [];
  for (const pattern of docPaths) {
    const fullPattern = resolve(projectRoot, pattern);
    for await (const entry of glob(fullPattern)) {
      const relPath = relative(projectRoot, entry);
      const excluded = exclude.some(ex => {
        const exPattern = ex.replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*');
        return new RegExp(`^${exPattern}$`).test(relPath);
      });
      if (!excluded) files.push(relPath);
    }
  }
  return [...new Set(files)].sort();
}

async function ensureProject(name: string, rootPath: string, config: ProjectConfig): Promise<string> {
  const result = await pool.query(
    `INSERT INTO docmem.projects (name, root_path, config)
     VALUES ($1, $2, $3)
     ON CONFLICT (name) DO UPDATE SET root_path = $2, config = $3, updated_at = NOW()
     RETURNING id`,
    [name, rootPath, JSON.stringify(config)]
  );
  return result.rows[0].id;
}

export async function indexProject(projectRoot: string): Promise<IndexResult> {
  const absRoot = resolve(projectRoot);
  const config = loadProjectConfig(absRoot);
  const projectId = await ensureProject(config.project, absRoot, config);

  console.log(`Indexing project "${config.project}" at ${absRoot}`);

  // Discover files
  const files = await discoverFiles(absRoot, config.doc_paths, config.exclude);
  console.log(`Found ${files.length} files to index`);

  // Chunk all files
  const allChunks: (Chunk & { lastModified: Date })[] = [];
  for (const file of files) {
    const absPath = resolve(absRoot, file);
    const content = readFileSync(absPath, 'utf-8');
    const stat = statSync(absPath);
    const chunks = chunkMarkdown(content, file);
    for (const chunk of chunks) {
      allChunks.push({ ...chunk, lastModified: stat.mtime });
    }
  }
  console.log(`Generated ${allChunks.length} chunks`);

  // Get existing checksums to skip unchanged chunks
  const existing = await pool.query(
    'SELECT id, source_file, section_path, checksum FROM docmem.chunks WHERE project_id = $1',
    [projectId]
  );
  const existingMap = new Map<string, { id: string; checksum: string }>();
  for (const row of existing.rows) {
    existingMap.set(`${row.source_file}::${row.section_path}`, { id: row.id, checksum: row.checksum });
  }

  // Determine which chunks need embedding
  const toEmbed: typeof allChunks = [];
  const unchanged: string[] = [];
  for (const chunk of allChunks) {
    const key = `${chunk.sourceFile}::${chunk.sectionPath}`;
    const ex = existingMap.get(key);
    if (ex && ex.checksum === chunk.checksum) {
      unchanged.push(ex.id);
    } else {
      toEmbed.push(chunk);
    }
  }

  console.log(`${unchanged.length} unchanged, ${toEmbed.length} to embed`);

  let added = 0;
  let updated = 0;

  if (toEmbed.length > 0) {
    // Generate embeddings
    console.log('Generating embeddings...');
    const embeddings = await embedDocuments(toEmbed.map(c => c.content));

    // Upsert chunks
    for (let i = 0; i < toEmbed.length; i++) {
      const chunk = toEmbed[i];
      const embedding = embeddings[i];
      const key = `${chunk.sourceFile}::${chunk.sectionPath}`;
      const ex = existingMap.get(key);
      const tokenCount = estimateTokens(chunk.content);
      const embeddingStr = `[${embedding.join(',')}]`;

      if (ex) {
        // Update existing
        await pool.query(
          `UPDATE docmem.chunks SET
            content = $1, search_vector = to_tsvector('english', $1), summary = $2, embedding = $3, token_count = $4,
            topic = $5, checksum = $6, last_modified = $7, updated_at = NOW()
          WHERE id = $8`,
          [chunk.content, '', embeddingStr, tokenCount, chunk.topic, chunk.checksum, chunk.lastModified, ex.id]
        );
        updated++;
      } else {
        // Insert new
        await pool.query(
          `INSERT INTO docmem.chunks (project_id, source_file, section_path, content, summary, embedding, token_count, topic, checksum, last_modified, search_vector)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, to_tsvector('english', $4))`,
          [projectId, chunk.sourceFile, chunk.sectionPath, chunk.content, '', embeddingStr, tokenCount, chunk.topic, chunk.checksum, chunk.lastModified]
        );
        added++;
      }
    }
  }

  // Remove orphaned chunks (files deleted or sections removed)
  const currentKeys = new Set(allChunks.map(c => `${c.sourceFile}::${c.sectionPath}`));
  const toRemove = [...existingMap.entries()]
    .filter(([key]) => !currentKeys.has(key))
    .map(([, val]) => val.id);

  if (toRemove.length > 0) {
    await pool.query(
      'DELETE FROM docmem.chunks WHERE id = ANY($1)',
      [toRemove]
    );
    console.log(`Removed ${toRemove.length} orphaned chunks`);
  }

  // --- Phase 2: Entity extraction ---
  console.log('Extracting entities...');

  // Clear existing entities and relationships for this project (full refresh)
  await pool.query('DELETE FROM docmem.relationships WHERE source_id IN (SELECT id FROM docmem.chunks WHERE project_id = $1)', [projectId]);
  await pool.query('DELETE FROM docmem.entities WHERE project_id = $1', [projectId]);

  // Get all current chunk IDs and content for this project
  const allChunksDb = await pool.query(
    'SELECT id, source_file, section_path, content FROM docmem.chunks WHERE project_id = $1',
    [projectId]
  );

  // Build a map of source_file -> chunk IDs for link resolution
  const fileToChunkIds = new Map<string, string[]>();
  for (const row of allChunksDb.rows) {
    const ids = fileToChunkIds.get(row.source_file) ?? [];
    ids.push(row.id);
    fileToChunkIds.set(row.source_file, ids);
  }

  // Extract entities from each chunk and collect entity -> chunk_ids mapping
  const entityChunkMap = new Map<string, { type: string; chunkIds: Set<string> }>();
  for (const row of allChunksDb.rows) {
    const entities = extractEntities(row.content);
    for (const entity of entities) {
      const existing = entityChunkMap.get(entity.name);
      if (existing) {
        existing.chunkIds.add(row.id);
      } else {
        entityChunkMap.set(entity.name, { type: entity.type, chunkIds: new Set([row.id]) });
      }
    }
  }

  // Insert entities
  let entityCount = 0;
  for (const [name, { type, chunkIds }] of entityChunkMap) {
    await pool.query(
      `INSERT INTO docmem.entities (project_id, name, type, chunk_ids)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (project_id, name) DO UPDATE SET type = $3, chunk_ids = $4`,
      [projectId, name, type, [...chunkIds]]
    );
    entityCount++;
  }
  console.log(`Extracted ${entityCount} entities`);

  // --- Phase 2: Link extraction → relationships ---
  console.log('Extracting links...');
  let linkCount = 0;
  for (const row of allChunksDb.rows) {
    const links = extractLinks(row.content, row.source_file);
    for (const link of links) {
      const targetChunkIds = fileToChunkIds.get(link.targetFile);
      if (!targetChunkIds) continue; // Target file not indexed

      for (const targetId of targetChunkIds) {
        if (targetId === row.id) continue; // Skip self-links
        await pool.query(
          `INSERT INTO docmem.relationships (source_id, target_id, rel_type, confidence)
           VALUES ($1, $2, 'link', 1.0)`,
          [row.id, targetId]
        );
        linkCount++;
      }
    }
  }
  console.log(`Created ${linkCount} link relationships`);

  // --- Phase 2: Entity co-occurrence relationships ---
  console.log('Building co-occurrence relationships...');
  let cooccurrenceCount = 0;
  const relationshipPairs = new Set<string>();

  for (const [, { chunkIds }] of entityChunkMap) {
    if (chunkIds.size < 2 || chunkIds.size > MAX_COOCCURRENCE_CHUNKS) continue;

    const ids = [...chunkIds];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const pairKey = [ids[i], ids[j]].sort().join('::');
        if (relationshipPairs.has(pairKey)) continue;
        relationshipPairs.add(pairKey);

        await pool.query(
          `INSERT INTO docmem.relationships (source_id, target_id, rel_type, confidence)
           VALUES ($1, $2, 'shared_entity', 0.5)`,
          [ids[i], ids[j]]
        );
        cooccurrenceCount++;
      }
    }
  }
  console.log(`Created ${cooccurrenceCount} co-occurrence relationships`);

  // Backfill search_vector for any chunks missing it
  await pool.query(
    `UPDATE docmem.chunks SET search_vector = to_tsvector('english', content)
     WHERE project_id = $1 AND search_vector IS NULL`,
    [projectId]
  );

  const result: IndexResult = {
    chunksAdded: added,
    chunksUpdated: updated,
    chunksRemoved: toRemove.length,
    totalChunks: allChunks.length,
    entitiesExtracted: entityCount,
    relationshipsCreated: linkCount + cooccurrenceCount,
  };

  console.log(`Done: +${added} ~${updated} -${toRemove.length} = ${allChunks.length} total chunks, ${entityCount} entities, ${linkCount + cooccurrenceCount} relationships`);
  return result;
}
