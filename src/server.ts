import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { pool } from './db/pool.js';
import { embedQuery } from './indexer/embedder.js';
import { computeScore } from './scoring.js';
import { indexProject } from './indexer/index-project.js';

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
    },
  },
  async ({ project, query, max_results, topic }) => {
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

    const queryEmbedding = await embedQuery(query);
    const embeddingStr = `[${queryEmbedding.join(',')}]`;

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

    let sql = `
      SELECT
        c.id,
        c.source_file,
        c.section_path,
        c.summary,
        c.topic,
        c.token_count,
        c.last_modified,
        p.name AS project_name,
        1 - (c.embedding <=> $1::vector) AS similarity,
        COALESCE(a.access_count, 0) AS access_count
      FROM docmem.chunks c
      LEFT JOIN docmem.access_stats a ON a.chunk_id = c.id
      JOIN docmem.projects p ON p.id = c.project_id
    `;
    const params: unknown[] = [embeddingStr];
    let paramIdx = 2;

    if (projectId) {
      sql += ` WHERE c.project_id = $${paramIdx}`;
      params.push(projectId);
      paramIdx++;
    } else {
      sql += ` WHERE 1=1`;
    }

    if (topic) {
      sql += ` AND c.topic = $${paramIdx}`;
      params.push(topic);
      paramIdx++;
    }

    sql += ` ORDER BY c.embedding <=> $1::vector LIMIT $${paramIdx}`;
    params.push(candidateLimit);

    const results = await pool.query(sql, params);

    if (results.rows.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No results found.' }] };
    }

    const now = new Date();
    const queryLower = query.toLowerCase();

    const scored = results.rows.map(row => {
      const { score, breakdown } = computeScore({
        similarity: parseFloat(row.similarity),
        accessCount: parseInt(row.access_count),
        maxAccess,
        lastModified: new Date(row.last_modified),
        now,
        queryMatchesTopic: queryLower.includes(row.topic.split('/').pop()?.toLowerCase() ?? ''),
      });

      return { row, score, breakdown };
    });

    scored.sort((a, b) => b.score - a.score);

    const output = scored.slice(0, max_results ?? 5).map((s, i) => ({
      rank: i + 1,
      chunk_id: s.row.id,
      project: s.row.project_name,
      source_file: s.row.source_file,
      section_path: s.row.section_path,
      topic: s.row.topic,
      token_count: s.row.token_count,
      score: s.score,
      score_breakdown: s.breakdown,
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
      `SELECT c.content, c.source_file, c.section_path, c.topic, c.token_count
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

    // Check staleness by comparing file mtime to indexed last_modified
    const { statSync } = await import('fs');
    const { resolve } = await import('path');

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

      // Check if source file is newer than indexed version
      try {
        const absPath = resolve(rootPath, row.source_file);
        const stat = statSync(absPath);
        if (stat.mtime > new Date(row.last_modified)) {
          topicStats.get(row.topic)!.stale_chunks++;
        }
      } catch {
        // File may have been deleted — counts as stale
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

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('DocMem MCP server running on stdio');
}

main().catch((err) => {
  console.error('Server failed to start:', err);
  process.exit(1);
});
