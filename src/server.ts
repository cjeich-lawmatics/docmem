import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { pool } from './db/pool.js';
import { embedQuery } from './indexer/embedder.js';

const server = new McpServer({
  name: 'docmem',
  version: '0.1.0',
});

server.registerTool(
  'docmem_search',
  {
    description: 'Semantic search across indexed documentation. Returns summaries and metadata only — use docmem_load_chunk to get full content. Always start here to find relevant docs.',
    inputSchema: {
      project: z.string().describe('Project name (e.g., "boost-api")'),
      query: z.string().describe('Natural language search query'),
      max_results: z.number().optional().default(5).describe('Max results to return (default 5)'),
      topic: z.string().optional().describe('Filter to a specific topic (e.g., "features/automations")'),
    },
  },
  async ({ project, query, max_results, topic }) => {
    // Get project ID
    const projResult = await pool.query(
      'SELECT id FROM docmem.projects WHERE name = $1',
      [project]
    );
    if (projResult.rows.length === 0) {
      return { content: [{ type: 'text' as const, text: `Project "${project}" not found. Run "docmem index" first.` }] };
    }
    const projectId = projResult.rows[0].id;

    // Generate embedding for the query
    const queryEmbedding = await embedQuery(query);
    const embeddingStr = `[${queryEmbedding.join(',')}]`;

    // Search with pgvector cosine distance
    let sql = `
      SELECT
        c.id,
        c.source_file,
        c.section_path,
        c.summary,
        c.topic,
        c.token_count,
        1 - (c.embedding <=> $1::vector) AS similarity
      FROM docmem.chunks c
      WHERE c.project_id = $2
    `;
    const params: unknown[] = [embeddingStr, projectId];
    let paramIdx = 3;

    if (topic) {
      sql += ` AND c.topic = $${paramIdx}`;
      params.push(topic);
      paramIdx++;
    }

    sql += ` ORDER BY c.embedding <=> $1::vector LIMIT $${paramIdx}`;
    params.push(max_results ?? 5);

    const results = await pool.query(sql, params);

    if (results.rows.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No results found.' }] };
    }

    const output = results.rows.map((row, i) => ({
      rank: i + 1,
      chunk_id: row.id,
      source_file: row.source_file,
      section_path: row.section_path,
      topic: row.topic,
      token_count: row.token_count,
      similarity: Math.round(row.similarity * 1000) / 1000,
      summary: row.summary || `[${row.section_path}] (${row.token_count} tokens)`,
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

    const output = {
      source_file: row.source_file,
      section_path: row.section_path,
      topic: row.topic,
      token_count: row.token_count,
      content: row.content,
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
      'SELECT id FROM docmem.projects WHERE name = $1',
      [project]
    );
    if (projResult.rows.length === 0) {
      return { content: [{ type: 'text' as const, text: `Project "${project}" not found.` }] };
    }
    const projectId = projResult.rows[0].id;

    const result = await pool.query(
      `SELECT
        c.topic,
        COUNT(*) AS chunk_count,
        SUM(c.token_count) AS total_tokens,
        MAX(c.last_modified) AS last_modified
      FROM docmem.chunks c
      WHERE c.project_id = $1
      GROUP BY c.topic
      ORDER BY c.topic`,
      [projectId]
    );

    const output = result.rows.map(row => ({
      topic: row.topic,
      chunk_count: parseInt(row.chunk_count),
      total_tokens: parseInt(row.total_tokens),
      last_modified: row.last_modified,
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

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('DocMem MCP server running on stdio');
}

main().catch((err) => {
  console.error('Server failed to start:', err);
  process.exit(1);
});
