import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { pool } from './db/pool.js';
import { embedQuery } from './indexer/embedder.js';
import { computeScore } from './scoring.js';
import { fuseResults, expandQuery, type RankedResult } from './hybrid-search.js';
import { getOrCreateSession, recordSessionAccess } from './sessions.js';
import { indexProject } from './indexer/index-project.js';
import { getGitFileTimestamp, isStale } from './git-staleness.js';

const server = new McpServer({
  name: 'docmem',
  version: '0.1.0',
});

server.registerTool(
  'docmem_search',
  {
    description: 'Semantic search across indexed documentation. Returns summaries and metadata only — use docmem_load_chunk to get full content. Always start here to find relevant docs.',
    inputSchema: {
      project: z.string().describe('Project name (e.g., "boost-api") or "*" to search all projects'),
      query: z.string().describe('Natural language search query'),
      max_results: z.number().optional().default(5).describe('Max results to return (default 5)'),
      topic: z.string().optional().describe('Filter to a specific topic (e.g., "features/automations")'),
      include_branches: z.boolean().optional().default(false).describe('Include unmerged feature branch docs (default: false, only searches merged/stable docs)'),
      branch: z.string().optional().describe('Filter to a specific branch (e.g., "feature/billing"). Shows that branch\'s docs overlaid on merged master docs.'),
    },
  },
  async ({ project, query, max_results, topic, include_branches, branch: branchFilter }) => {
    // 1. Project lookup (supports '*' wildcard)
    let projectId: string | null = null;

    if (project !== '*') {
      const projResult = await pool.query(
        'SELECT id FROM docmem.projects WHERE name = $1',
        [project]
      );
      if (projResult.rows.length === 0) {
        return { content: [{ type: 'text' as const, text: `Project "${project}" not found. Run "docmem index" first.` }] };
      }
      projectId = projResult.rows[0].id;
    }

    // 2. Query expansion
    const queryVariants = expandQuery(query);

    // 3. Embedding for vector search
    const queryEmbedding = await embedQuery(query);
    const embeddingStr = `[${queryEmbedding.join(',')}]`;

    // Max access for heat normalization
    let maxAccessSql = `SELECT COALESCE(MAX(a.access_count), 0) AS max_access
       FROM docmem.access_stats a
       JOIN docmem.chunks c ON c.id = a.chunk_id`;
    const maxAccessParams: unknown[] = [];
    if (projectId) {
      maxAccessSql += ` WHERE c.project_id = $1`;
      maxAccessParams.push(projectId);
    }
    const maxAccessResult = await pool.query(maxAccessSql, maxAccessParams);
    const maxAccess = parseInt(maxAccessResult.rows[0].max_access) || 0;

    const candidateLimit = Math.max((max_results ?? 5) * 3, 15);

    // 4. Vector search — ranks only
    let vectorSql = `
      SELECT c.id, ROW_NUMBER() OVER (ORDER BY c.embedding <=> $1::vector) AS rank
      FROM docmem.chunks c
      WHERE 1=1`;
    const vectorParams: unknown[] = [embeddingStr];
    let vIdx = 2;

    if (projectId) {
      vectorSql += ` AND c.project_id = $${vIdx}`;
      vectorParams.push(projectId);
      vIdx++;
    }
    if (topic) {
      vectorSql += ` AND c.topic = $${vIdx}`;
      vectorParams.push(topic);
      vIdx++;
    }

    // Branch filtering
    if (!include_branches && !branchFilter) {
      // Default: only merged docs
      vectorSql += ` AND c.merged = true`;
    } else if (branchFilter) {
      // Specific branch: that branch's docs + merged master docs
      vectorSql += ` AND (c.branch = $${vIdx} OR c.merged = true)`;
      vectorParams.push(branchFilter);
      vIdx++;
    }
    // include_branches = true: no filter, search everything

    vectorSql += ` ORDER BY c.embedding <=> $1::vector LIMIT $${vIdx}`;
    vectorParams.push(candidateLimit);

    const vectorResult = await pool.query(vectorSql, vectorParams);
    const vectorRanked: RankedResult[] = vectorResult.rows.map(r => ({
      id: r.id,
      rank: parseInt(r.rank),
    }));

    // 5. BM25 search — ranks only (may fail if search_vector not backfilled)
    let bm25Ranked: RankedResult[] = [];
    try {
      // Build tsquery combining all expanded variants with OR
      const bm25Params: unknown[] = [];
      let bIdx = 1;

      if (projectId) {
        bm25Params.push(projectId);
        bIdx++;
      }
      if (topic) {
        bm25Params.push(topic);
        bIdx++;
      }
      if (branchFilter) {
        bm25Params.push(branchFilter);
        bIdx++;
      }

      const tsqueryParts = queryVariants.map(variant => {
        bm25Params.push(variant);
        return `plainto_tsquery('english', $${bIdx++})`;
      });
      const tsqueryCombined = tsqueryParts.join(' || ');

      let bm25Sql = `
        SELECT c.id, ROW_NUMBER() OVER (ORDER BY ts_rank(c.search_vector, query) DESC) AS rank
        FROM docmem.chunks c, (SELECT ${tsqueryCombined} AS query) q
        WHERE c.search_vector @@ q.query`;

      // Re-apply filters using the original param positions
      let filterIdx = 1;
      if (projectId) {
        bm25Sql += ` AND c.project_id = $${filterIdx}`;
        filterIdx++;
      }
      if (topic) {
        bm25Sql += ` AND c.topic = $${filterIdx}`;
        filterIdx++;
      }

      // Branch filtering
      if (!include_branches && !branchFilter) {
        bm25Sql += ` AND c.merged = true`;
      } else if (branchFilter) {
        bm25Sql += ` AND (c.branch = $${filterIdx} OR c.merged = true)`;
        filterIdx++;
      }

      bm25Sql += ` ORDER BY ts_rank(c.search_vector, query) DESC LIMIT ${candidateLimit}`;

      const bm25Result = await pool.query(bm25Sql, bm25Params);
      bm25Ranked = bm25Result.rows.map(r => ({
        id: r.id,
        rank: parseInt(r.rank),
      }));
    } catch {
      // BM25 may fail if search_vector column is NULL / not yet backfilled
    }

    // 6. RRF fusion
    const fused = fuseResults(vectorRanked, bm25Ranked);

    if (fused.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No results found.' }] };
    }

    // Take top candidates for full data fetch
    const topIds = fused.slice(0, candidateLimit).map(f => f.id);
    const rrfScoreMap = new Map(fused.map(f => [f.id, f.rrfScore]));

    // 7. Fetch full data for fused IDs
    const fullSql = `
      SELECT c.id, c.source_file, c.section_path, c.summary, c.topic, c.token_count,
             c.last_modified, c.branch, c.merged, p.name AS project_name,
             1 - (c.embedding <=> $1::vector) AS similarity,
             COALESCE(a.access_count, 0) AS access_count,
             COALESCE(a.avg_usefulness, 0.5) AS avg_usefulness
      FROM docmem.chunks c
      LEFT JOIN docmem.access_stats a ON a.chunk_id = c.id
      JOIN docmem.projects p ON p.id = c.project_id
      WHERE c.id = ANY($2)`;
    const fullResult = await pool.query(fullSql, [embeddingStr, topIds]);

    // 8. Composite scoring
    const now = new Date();
    const queryLower = query.toLowerCase();

    const scored = fullResult.rows.map(row => {
      const { score, breakdown } = computeScore({
        similarity: parseFloat(row.similarity),
        accessCount: parseInt(row.access_count),
        maxAccess,
        lastModified: new Date(row.last_modified),
        now,
        queryMatchesTopic: queryLower.includes(row.topic.split('/').pop()?.toLowerCase() ?? ''),
        usefulness: parseFloat(row.avg_usefulness),
      });

      return { row, score, breakdown, rrfScore: rrfScoreMap.get(row.id) ?? 0 };
    });

    scored.sort((a, b) => b.score - a.score);

    const topResults = scored.slice(0, max_results ?? 5);

    // 9. Session tracking — record top results
    const sessionId = await getOrCreateSession(projectId);
    for (const s of topResults) {
      await recordSessionAccess(sessionId, s.row.id, 'search');
    }

    // 10. Output
    const output = topResults.map((s, i) => ({
      rank: i + 1,
      chunk_id: s.row.id,
      project: s.row.project_name,
      source_file: s.row.source_file,
      section_path: s.row.section_path,
      topic: s.row.topic,
      token_count: s.row.token_count,
      branch: s.row.branch,
      merged: s.row.merged,
      score: s.score,
      score_breakdown: s.breakdown,
      rrf_score: s.rrfScore,
      similarity: Math.round(parseFloat(s.row.similarity) * 1000) / 1000,
      summary: s.row.summary || `[${s.row.section_path}] (${s.row.token_count} tokens)`,
    }));

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(output, null, 2),
      }],
    };
  }
);

server.registerTool(
  'docmem_load_chunk',
  {
    description: 'Load the full content of a specific documentation chunk. Use chunk_id from docmem_search results.',
    inputSchema: {
      chunk_id: z.string().describe('The chunk ID from search results'),
    },
  },
  async ({ chunk_id }) => {
    const result = await pool.query(
      `SELECT c.content, c.source_file, c.section_path, c.topic, c.token_count, c.project_id
       FROM docmem.chunks c
       WHERE c.id = $1`,
      [chunk_id]
    );

    if (result.rows.length === 0) {
      return { content: [{ type: 'text' as const, text: `Chunk "${chunk_id}" not found.` }] };
    }

    const row = result.rows[0];

    // Record access for heat tracking
    await pool.query(
      `INSERT INTO docmem.access_stats (chunk_id, access_count, last_accessed)
       VALUES ($1, 1, NOW())
       ON CONFLICT (chunk_id) DO UPDATE SET
         access_count = docmem.access_stats.access_count + 1,
         last_accessed = NOW()`,
      [chunk_id]
    );

    // Record session access
    const sessionId = await getOrCreateSession(row.project_id);
    await recordSessionAccess(sessionId, chunk_id, 'load');

    // Fetch entities mentioned in this chunk
    const entitiesResult = await pool.query(
      `SELECT name, type FROM docmem.entities
       WHERE project_id = (SELECT project_id FROM docmem.chunks WHERE id = $1)
       AND $1 = ANY(chunk_ids)`,
      [chunk_id]
    );

    // Count relationships
    const relCount = await pool.query(
      `SELECT COUNT(*) FROM docmem.relationships
       WHERE source_id = $1 OR target_id = $1`,
      [chunk_id]
    );

    const output = {
      source_file: row.source_file,
      section_path: row.section_path,
      topic: row.topic,
      token_count: row.token_count,
      content: row.content,
      entities: entitiesResult.rows.map(e => ({ name: e.name, type: e.type })),
      related_count: parseInt(relCount.rows[0].count),
    };

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(output, null, 2),
      }],
    };
  }
);

server.registerTool(
  'docmem_list_topics',
  {
    description: 'List all available documentation topics for a project with chunk counts. Cheapest possible operation — use this first to discover what documentation exists.',
    inputSchema: {
      project: z.string().describe('Project name (e.g., "boost-api")'),
    },
  },
  async ({ project }) => {
    const projResult = await pool.query(
      'SELECT id, root_path FROM docmem.projects WHERE name = $1',
      [project]
    );
    if (projResult.rows.length === 0) {
      return { content: [{ type: 'text' as const, text: `Project "${project}" not found.` }] };
    }
    const projectId = projResult.rows[0].id;
    const rootPath = projResult.rows[0].root_path;

    const result = await pool.query(
      `SELECT
        c.topic,
        c.source_file,
        c.last_modified,
        COUNT(*) OVER (PARTITION BY c.topic) AS chunk_count,
        SUM(c.token_count) OVER (PARTITION BY c.topic) AS total_tokens,
        MAX(c.last_modified) OVER (PARTITION BY c.topic) AS topic_last_modified
      FROM docmem.chunks c
      WHERE c.project_id = $1
      ORDER BY c.topic, c.source_file`,
      [projectId]
    );

    // Check staleness by comparing git commit time to indexed last_modified
    const topicStats = new Map<string, { chunk_count: number; total_tokens: number; last_modified: string; stale_chunks: number }>();

    for (const row of result.rows) {
      if (!topicStats.has(row.topic)) {
        topicStats.set(row.topic, {
          chunk_count: parseInt(row.chunk_count),
          total_tokens: parseInt(row.total_tokens),
          last_modified: row.topic_last_modified,
          stale_chunks: 0,
        });
      }

      const gitTime = getGitFileTimestamp(rootPath, row.source_file);
      if (isStale(gitTime, new Date(row.last_modified))) {
        topicStats.get(row.topic)!.stale_chunks++;
      }
    }

    const output = [...topicStats.entries()].map(([topic, stats]) => ({
      topic,
      ...stats,
    }));

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(output, null, 2),
      }],
    };
  }
);

server.registerTool(
  'docmem_overview',
  {
    description: 'Get an overview of a specific documentation topic — lists all sections with token counts and access frequency. Use after list_topics to understand a topic before searching.',
    inputSchema: {
      project: z.string().describe('Project name (e.g., "boost-api")'),
      topic: z.string().describe('Topic name from list_topics (e.g., "features/automations")'),
    },
  },
  async ({ project, topic }) => {
    const projResult = await pool.query(
      'SELECT id FROM docmem.projects WHERE name = $1',
      [project]
    );
    if (projResult.rows.length === 0) {
      return { content: [{ type: 'text' as const, text: `Project "${project}" not found.` }] };
    }
    const projectId = projResult.rows[0].id;

    const result = await pool.query(
      `SELECT
        c.id,
        c.source_file,
        c.section_path,
        c.token_count,
        c.last_modified,
        COALESCE(a.access_count, 0) AS access_count
      FROM docmem.chunks c
      LEFT JOIN docmem.access_stats a ON a.chunk_id = c.id
      WHERE c.project_id = $1 AND c.topic = $2
      ORDER BY c.source_file, c.section_path`,
      [projectId, topic]
    );

    if (result.rows.length === 0) {
      return { content: [{ type: 'text' as const, text: `No chunks found for topic "${topic}".` }] };
    }

    const totalTokens = result.rows.reduce((sum, r) => sum + r.token_count, 0);

    const output = {
      topic,
      total_chunks: result.rows.length,
      total_tokens: totalTokens,
      sections: result.rows.map(row => ({
        chunk_id: row.id,
        source_file: row.source_file,
        section_path: row.section_path,
        token_count: row.token_count,
        access_count: parseInt(row.access_count),
        last_modified: row.last_modified,
      })),
    };

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(output, null, 2),
      }],
    };
  }
);

server.registerTool(
  'docmem_related',
  {
    description: 'Find chunks related to a given chunk via documentation links and shared entities. Use after loading a chunk to discover connected documentation.',
    inputSchema: {
      chunk_id: z.string().describe('The chunk ID to find related chunks for'),
      max_results: z.number().optional().default(10).describe('Max related chunks to return (default 10)'),
    },
  },
  async ({ chunk_id, max_results }) => {
    // Get relationships in both directions
    const result = await pool.query(
      `SELECT
        CASE WHEN r.source_id = $1 THEN r.target_id ELSE r.source_id END AS related_id,
        r.rel_type,
        r.confidence,
        c.source_file,
        c.section_path,
        c.topic,
        c.token_count
      FROM docmem.relationships r
      JOIN docmem.chunks c ON c.id = CASE WHEN r.source_id = $1 THEN r.target_id ELSE r.source_id END
      WHERE r.source_id = $1 OR r.target_id = $1
      ORDER BY r.confidence DESC, r.rel_type
      LIMIT $2`,
      [chunk_id, max_results ?? 10]
    );

    if (result.rows.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No related chunks found.' }] };
    }

    // Deduplicate (a chunk may be related via both link and shared_entity)
    const seen = new Map<string, { rel_types: string[]; confidence: number; source_file: string; section_path: string; topic: string; token_count: number }>();
    for (const row of result.rows) {
      const existing = seen.get(row.related_id);
      if (existing) {
        if (!existing.rel_types.includes(row.rel_type)) {
          existing.rel_types.push(row.rel_type);
        }
        existing.confidence = Math.max(existing.confidence, row.confidence);
      } else {
        seen.set(row.related_id, {
          rel_types: [row.rel_type],
          confidence: row.confidence,
          source_file: row.source_file,
          section_path: row.section_path,
          topic: row.topic,
          token_count: row.token_count,
        });
      }
    }

    const output = [...seen.entries()].map(([id, data]) => ({
      chunk_id: id,
      source_file: data.source_file,
      section_path: data.section_path,
      topic: data.topic,
      token_count: data.token_count,
      rel_types: data.rel_types,
      confidence: data.confidence,
    }));

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(output, null, 2),
      }],
    };
  }
);

server.registerTool(
  'docmem_index',
  {
    description: 'Reindex a project\'s documentation. Use when you know docs have changed or when search results seem stale. Returns indexing stats.',
    inputSchema: {
      project_path: z.string().describe('Absolute path to the project root (must contain .docmem.json)'),
    },
  },
  async ({ project_path }) => {
    try {
      const result = await indexProject(project_path);
      const output = {
        status: 'ok',
        ...result,
      };
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(output, null, 2),
        }],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ status: 'error', message }, null, 2),
        }],
      };
    }
  }
);

server.registerTool(
  'docmem_feedback',
  {
    description: 'Record whether a loaded chunk was useful. Helps improve future search ranking. Call after using a chunk\'s content.',
    inputSchema: {
      chunk_id: z.string().describe('The chunk ID to give feedback on'),
      useful: z.boolean().describe('Whether the chunk content was useful for your task'),
    },
  },
  async ({ chunk_id, useful }) => {
    const score = useful ? 1.0 : 0.0;

    // Update running average: new_avg = old_avg + (score - old_avg) / count
    const result = await pool.query(
      `INSERT INTO docmem.access_stats (chunk_id, access_count, last_accessed, avg_usefulness)
       VALUES ($1, 0, NOW(), $2)
       ON CONFLICT (chunk_id) DO UPDATE SET
         avg_usefulness = docmem.access_stats.avg_usefulness +
           ($2 - docmem.access_stats.avg_usefulness) / (docmem.access_stats.access_count + 1),
         last_accessed = NOW()
       RETURNING avg_usefulness, access_count`,
      [chunk_id, score]
    );

    if (result.rows.length === 0) {
      return { content: [{ type: 'text' as const, text: `Chunk "${chunk_id}" not found.` }] };
    }

    const row = result.rows[0];
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          status: 'recorded',
          chunk_id,
          useful,
          avg_usefulness: Math.round(parseFloat(row.avg_usefulness) * 100) / 100,
        }, null, 2),
      }],
    };
  }
);

server.registerTool(
  'docmem_suggest',
  {
    description: 'Suggest related chunks based on co-access patterns. Shows what other agents typically loaded alongside a given chunk. Use after loading a chunk to discover commonly co-accessed documentation.',
    inputSchema: {
      chunk_id: z.string().describe('The chunk ID to find co-accessed chunks for'),
      max_results: z.number().optional().default(5).describe('Max suggestions to return (default 5)'),
    },
  },
  async ({ chunk_id, max_results }) => {
    const result = await pool.query(
      `SELECT
        sa2.chunk_id AS suggested_id,
        c.source_file, c.section_path, c.topic, c.token_count,
        p.name AS project,
        COUNT(DISTINCT sa2.session_id) AS co_access_count
      FROM docmem.session_accesses sa1
      JOIN docmem.session_accesses sa2 ON sa2.session_id = sa1.session_id AND sa2.chunk_id != sa1.chunk_id
      JOIN docmem.chunks c ON c.id = sa2.chunk_id
      JOIN docmem.projects p ON p.id = c.project_id
      WHERE sa1.chunk_id = $1
      GROUP BY sa2.chunk_id, c.source_file, c.section_path, c.topic, c.token_count, p.name
      ORDER BY co_access_count DESC
      LIMIT $2`,
      [chunk_id, max_results ?? 5]
    );

    if (result.rows.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No co-access patterns found yet. Suggestions improve as more chunks are accessed in sessions.' }] };
    }

    const output = result.rows.map((row, i) => ({
      rank: i + 1,
      chunk_id: row.suggested_id,
      project: row.project,
      source_file: row.source_file,
      section_path: row.section_path,
      topic: row.topic,
      token_count: row.token_count,
      co_access_count: parseInt(row.co_access_count),
    }));

    return { content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }] };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('DocMem MCP server running on stdio');
}

main().catch((err) => {
  console.error('Server failed to start:', err);
  process.exit(1);
});
