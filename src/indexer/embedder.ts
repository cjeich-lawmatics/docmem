import OpenAI from 'openai';
import { config } from '../config.js';

const openai = new OpenAI({ apiKey: config.openaiApiKey });

const EMBEDDING_MODEL = 'text-embedding-3-small';
const MAX_BATCH_SIZE = 100;

/**
 * Generate embeddings for an array of texts.
 * Batches requests to respect API limits.
 * Returns embeddings in the same order as input texts.
 */
export async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  const allEmbeddings: number[][] = [];

  for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
    const batch = texts.slice(i, i + MAX_BATCH_SIZE);
    const response = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: batch,
    });
    const sorted = response.data.sort((a, b) => a.index - b.index);
    allEmbeddings.push(...sorted.map(d => d.embedding));
  }

  return allEmbeddings;
}

/**
 * Estimate token count for a string (rough approximation: ~4 chars per token).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
