import { readFileSync, statSync } from 'fs';
import { resolve, relative } from 'path';
import { glob } from 'node:fs/promises';
import { pool } from '../db/pool.js';
import { chunkMarkdown, type Chunk } from './chunker.js';
import { generateEmbeddings, estimateTokens } from './embedder.js';

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
    const embeddings = await generateEmbeddings(toEmbed.map(c => c.content));

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
            content = $1, summary = $2, embedding = $3, token_count = $4,
            topic = $5, checksum = $6, last_modified = $7, updated_at = NOW()
          WHERE id = $8`,
          [chunk.content, '', embeddingStr, tokenCount, chunk.topic, chunk.checksum, chunk.lastModified, ex.id]
        );
        updated++;
      } else {
        // Insert new
        await pool.query(
          `INSERT INTO docmem.chunks (project_id, source_file, section_path, content, summary, embedding, token_count, topic, checksum, last_modified)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
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

  const result: IndexResult = {
    chunksAdded: added,
    chunksUpdated: updated,
    chunksRemoved: toRemove.length,
    totalChunks: allChunks.length,
  };

  console.log(`Done: +${added} ~${updated} -${toRemove.length} = ${allChunks.length} total chunks`);
  return result;
}
