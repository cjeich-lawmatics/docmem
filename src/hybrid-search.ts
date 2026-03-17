export interface RankedResult {
  id: string;
  rank: number;
}

export interface FusedResult {
  id: string;
  rrfScore: number;
}

const RRF_K = 60;
const TOP_RANK_BONUS = 0.05;

export function fuseResults(vectorResults: RankedResult[], bm25Results: RankedResult[]): FusedResult[] {
  const scores = new Map<string, number>();

  for (const r of vectorResults) {
    const rrf = 1 / (RRF_K + r.rank);
    const bonus = r.rank === 1 ? TOP_RANK_BONUS : 0;
    scores.set(r.id, (scores.get(r.id) ?? 0) + rrf + bonus);
  }

  for (const r of bm25Results) {
    const rrf = 1 / (RRF_K + r.rank);
    const bonus = r.rank === 1 ? TOP_RANK_BONUS : 0;
    scores.set(r.id, (scores.get(r.id) ?? 0) + rrf + bonus);
  }

  return [...scores.entries()]
    .map(([id, rrfScore]) => ({ id, rrfScore: Math.round(rrfScore * 10000) / 10000 }))
    .sort((a, b) => b.rrfScore - a.rrfScore);
}

const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
  'before', 'after', 'above', 'below', 'between', 'out', 'off', 'over',
  'under', 'again', 'further', 'then', 'once', 'here', 'there', 'when',
  'where', 'why', 'how', 'all', 'each', 'every', 'both', 'few', 'more',
  'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own',
  'same', 'so', 'than', 'too', 'very', 'just', 'because', 'but', 'and',
  'or', 'if', 'while', 'about', 'up', 'its', 'it', 'this', 'that', 'what',
]);

export function expandQuery(query: string): string[] {
  const trimmed = query.trim();
  if (trimmed.split(/\s+/).length <= 2) return [trimmed];

  const variants: string[] = [trimmed];

  const keywords = trimmed
    .toLowerCase()
    .split(/\s+/)
    .filter(w => !STOPWORDS.has(w) && w.length > 1);

  if (keywords.length > 0) {
    const keywordVariant = keywords.join(' ');
    if (keywordVariant !== trimmed) {
      variants.push(keywordVariant);
    }
  }

  // For 3+ word queries, add a focused variant with fewer terms
  if (keywords.length >= 3 && variants.length < 2) {
    variants.push(keywords.slice(0, keywords.length - 1).join(' '));
  }

  return variants;
}
