export interface ScoringInput {
  similarity: number;       // 0-1 cosine similarity
  accessCount: number;      // raw access count for this chunk
  maxAccess: number;        // max access count across all project chunks
  lastModified: Date;       // when the chunk's source was last modified
  now: Date;                // current time (injected for testability)
  queryMatchesTopic: boolean; // whether query text contains the topic name
}

export interface ScoringResult {
  score: number;            // final composite score (0-1)
  breakdown: {
    similarity: number;     // weighted similarity component
    heat: number;           // weighted heat component
    recency: number;        // weighted recency component
    topic: number;          // weighted topic component
  };
}

const WEIGHTS = {
  similarity: 0.70,
  heat: 0.15,
  recency: 0.10,
  topic: 0.05,
};

const MAX_AGE_DAYS = 365;

/**
 * Normalize access count to 0-1 range relative to the most-accessed chunk.
 */
export function normalizeHeat(accessCount: number, maxAccess: number): number {
  if (maxAccess <= 0) return 0;
  return Math.min(accessCount / maxAccess, 1);
}

/**
 * Normalize document recency to 0-1 range.
 * 1 = just modified, 0 = older than MAX_AGE_DAYS.
 */
export function normalizeRecency(lastModified: Date, now: Date): number {
  const daysSince = (now.getTime() - lastModified.getTime()) / (24 * 60 * 60 * 1000);
  return Math.max(0, Math.min(1, 1 - daysSince / MAX_AGE_DAYS));
}

/**
 * Compute composite score from multiple signals.
 * Returns the final score and a breakdown of each component.
 */
export function computeScore(input: ScoringInput): ScoringResult {
  const heatNorm = normalizeHeat(input.accessCount, input.maxAccess);
  const recencyNorm = normalizeRecency(input.lastModified, input.now);
  const topicBonus = input.queryMatchesTopic ? 1 : 0;

  const breakdown = {
    similarity: WEIGHTS.similarity * input.similarity,
    heat: WEIGHTS.heat * heatNorm,
    recency: WEIGHTS.recency * recencyNorm,
    topic: WEIGHTS.topic * topicBonus,
  };

  const score = breakdown.similarity + breakdown.heat + breakdown.recency + breakdown.topic;

  return {
    score: Math.round(score * 1000) / 1000,
    breakdown: {
      similarity: Math.round(breakdown.similarity * 1000) / 1000,
      heat: Math.round(breakdown.heat * 1000) / 1000,
      recency: Math.round(breakdown.recency * 1000) / 1000,
      topic: Math.round(breakdown.topic * 1000) / 1000,
    },
  };
}
