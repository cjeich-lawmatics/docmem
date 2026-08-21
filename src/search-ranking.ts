import { computeScore } from './scoring.js';

export interface RankRow {
  id: string;
  source_file: string;
  section_path: string;
  summary: string | null;
  topic: string;
  token_count: number;
  last_modified: string | Date;
  branch: string;
  merged: boolean;
  project_name: string;
  similarity: number | string;
  access_count: number | string;
  avg_usefulness: number | string;
}

export interface RankParams {
  maxAccess: number;
  now: Date;
  query: string;
  degraded: boolean;
  rrfScoreMap: Map<string, number>;
  maxResults: number;
}

export function rankResults(rows: RankRow[], params: RankParams) {
  const queryLower = params.query.toLowerCase();

  const scored = rows.map(row => {
    const { score, breakdown } = computeScore({
      similarity: parseFloat(String(row.similarity)),
      accessCount: parseInt(String(row.access_count)),
      maxAccess: params.maxAccess,
      lastModified: new Date(row.last_modified),
      now: params.now,
      queryMatchesTopic: queryLower.includes(row.topic.split('/').pop()?.toLowerCase() ?? ''),
      usefulness: parseFloat(String(row.avg_usefulness)),
    });
    return { row, score, breakdown, rrfScore: params.rrfScoreMap.get(row.id) ?? 0 };
  });

  scored.sort((a, b) => {
    if (params.degraded && b.rrfScore !== a.rrfScore) return b.rrfScore - a.rrfScore;
    return b.score - a.score;
  });

  const top = scored.slice(0, params.maxResults);

  const results = top.map((s, i) => ({
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
    similarity: Math.round(parseFloat(String(s.row.similarity)) * 1000) / 1000,
    summary: s.row.summary || `[${s.row.section_path}] (${s.row.token_count} tokens)`,
  }));

  return { top, results };
}
