import { z } from 'zod';

import { KB_DOCS, type KbDoc } from '../../fixtures/kb';
import type { ToolDescriptor } from '../types';
import { sleep, type MockToolConfig } from './support';

const Args = z.strictObject({
  /** Natural-language query. The tool does the tokenising. */
  query: z.string().min(2).max(400),
  /** Max results; null means the default of 3. */
  limit: z.number().int().min(1).max(5).nullable(),
});

// Words that match everything and rank nothing.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'is', 'are', 'was', 'were', 'be', 'been', 'to', 'of',
  'in', 'on', 'for', 'with', 'my', 'me', 'i', 'we', 'you', 'it', 'this', 'that', 'at', 'as', 'by',
  'from', 'not', 'no', 'do', 'does', 'did', 'can', 'cant', 'how', 'what', 'why', 'when', 'there',
  'have', 'has', 'get', 'got', 'still', 'now', 'any', 'please', 'help',
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/**
 * Weighted token overlap: title matches count most, then tags, then body.
 *
 * Deliberately not embeddings. The KB is seven documents; a vector store would
 * add a dependency, an index to keep warm, and an embedding call per query to
 * solve a problem this size does not have. The trade-off is real and is stated
 * in the write-up: this scorer is lexical, so it cannot match a Thai query
 * against English docs, and it misses synonyms.
 */
export function scoreDoc(doc: KbDoc, queryTokens: string[]): number {
  if (queryTokens.length === 0) return 0;
  const title = new Set(tokenize(doc.title));
  const tags = new Set(doc.tags.flatMap((t) => tokenize(t)));
  const body = new Set(tokenize(doc.body));

  let score = 0;
  for (const token of new Set(queryTokens)) {
    if (title.has(token)) score += 3;
    if (tags.has(token)) score += 2;
    if (body.has(token)) score += 1;
  }
  return score / (new Set(queryTokens).size * 3);
}

/**
 * Minimum score for a result to be worth showing the model.
 *
 * The observed distribution is bimodal and the gap is an order of magnitude:
 * real answers score 0.67-1.2 ("dark mode toggle settings appearance" -> 1.2,
 * "API rate limit 429" -> 1.11, "payment failed duplicate charge" -> 0.67),
 * while incidental single-token overlap scores 0.056-0.083 ("cannot log in
 * spinner forever" -> the billing doc at 0.083).
 *
 * The floor exists because telling the model "ignore low scores" did not work:
 * on a live run it answered a blocked-login ticket from a 0.083 match. Not
 * returning noise is more reliable than asking the model to disregard it, and it
 * makes `result_count` mean "we found something relevant", which the grounding
 * guard in runner.ts depends on.
 */
export const MIN_RELEVANCE = 0.25;

export function searchKb(query: string, limit: number, docs: KbDoc[] = KB_DOCS) {
  const tokens = tokenize(query);
  return docs
    .map((doc) => ({ doc, score: Number(scoreDoc(doc, tokens).toFixed(3)) }))
    .filter((r) => r.score >= MIN_RELEVANCE)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ doc, score }) => ({
      id: doc.id,
      title: doc.title,
      score,
      // Full body: the docs are short, and truncating is how a correct retrieval
      // still produces a wrong answer.
      content: doc.body,
    }));
}

export function createSearchKnowledgeBaseTool(config: MockToolConfig): ToolDescriptor<z.infer<typeof Args>> {
  return {
    name: 'search_knowledge_base',
    description:
      'Search the support knowledge base for FAQ and troubleshooting articles. Use it before ' +
      'answering any product, how-to, or configuration question. Articles below a relevance ' +
      'threshold are not returned at all, so an empty result means the knowledge base does not ' +
      'cover this ticket and you should route it to a human rather than answer from memory.',
    args: Args,
    autonomy: 'auto',
    sideEffecting: false,
    async execute(args) {
      await sleep(config.latencyMs);
      const results = searchKb(args.query, args.limit ?? 3);
      return { ok: true, query: args.query, result_count: results.length, results };
    },
  };
}
