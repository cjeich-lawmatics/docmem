import { AutoModel, AutoTokenizer } from '@huggingface/transformers';

const MODEL_ID = 'onnx-community/embeddinggemma-300m-ONNX';

// Task-specific prefixes required by EmbeddingGemma
export const PREFIXES = {
  query: 'task: search result | query: ',
  document: 'title: none | text: ',
} as const;

let model: Awaited<ReturnType<typeof AutoModel.from_pretrained>> | null = null;
let tokenizer: Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>> | null = null;

async function getModel() {
  if (!model) {
    console.error('Loading EmbeddingGemma model (first run downloads ~340MB)...');
    model = await AutoModel.from_pretrained(MODEL_ID, { dtype: 'q8' as any });
    console.error('Model loaded.');
  }
  return model;
}

async function getTokenizer() {
  if (!tokenizer) {
    tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID);
  }
  return tokenizer;
}

const BATCH_SIZE = 32;

/**
 * Generate embeddings for an array of texts.
 * Texts should already have the appropriate prefix prepended.
 * Returns 768-dimensional embeddings in the same order as input texts.
 * Batches internally to avoid memory issues with large inputs.
 */
export async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const tok = await getTokenizer();
  const mod = await getModel();

  const allEmbeddings: number[][] = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    if (texts.length > BATCH_SIZE) {
      console.error(`  Embedding batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(texts.length / BATCH_SIZE)}...`);
    }
    const inputs = await (tok as any)(batch, { padding: true, truncation: true });
    const { sentence_embedding } = await (mod as any)(inputs);
    allEmbeddings.push(...(sentence_embedding.tolist() as number[][]));
  }

  return allEmbeddings;
}

/**
 * Generate embedding for a single query text.
 * Automatically prepends the query prefix.
 */
export async function embedQuery(query: string): Promise<number[]> {
  const results = await generateEmbeddings([PREFIXES.query + query]);
  return results[0];
}

/**
 * Generate embeddings for document texts.
 * Automatically prepends the document prefix.
 */
export async function embedDocuments(texts: string[]): Promise<number[][]> {
  const prefixed = texts.map(t => PREFIXES.document + t);
  return generateEmbeddings(prefixed);
}

/**
 * Estimate token count for a string (rough approximation: ~4 chars per token).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
