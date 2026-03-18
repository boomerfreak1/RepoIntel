/**
 * Entity and relation extraction.
 * Uses Mistral API when MISTRAL_API_KEY is set (fast, large context, JSON mode).
 * Falls back to local Ollama otherwise.
 */

import { ENTITY_EXTRACTION_PROMPT, RELATION_EXTRACTION_PROMPT } from "./prompts";
import { isMistralConfigured, mistralChat as mistralChatShared } from "./mistral";

const DEFAULT_BASE_URL = "http://localhost:11434";

export interface ExtractedEntity {
  entity_type: "decision" | "dependency" | "gap" | "stakeholder" | "milestone" | "workflow";
  content: string;
  status: "open" | "resolved" | "blocked" | "unknown";
  owner: string | null;
  confidence: number;
}

export interface ExtractedRelation {
  source_index: number;
  target_index: number;
  relation_type: "blocks" | "owns" | "references" | "supersedes";
  confidence: number;
}

const VALID_ENTITY_TYPES = new Set(["decision", "dependency", "gap", "stakeholder", "milestone", "workflow"]);
const VALID_STATUSES = new Set(["open", "resolved", "blocked", "unknown"]);
const VALID_RELATION_TYPES = new Set(["blocks", "owns", "references", "supersedes"]);

/** Whether Mistral API is available for extraction. */
function isMistralEnabled(): boolean {
  return isMistralConfigured();
}

let _loggedBackend = false;
function logBackendOnce(): void {
  if (!_loggedBackend) {
    _loggedBackend = true;
    const backend = isMistralEnabled()
      ? `Mistral API (${process.env.MISTRAL_CHAT_MODEL ?? process.env.MISTRAL_MODEL ?? "mistral-small-latest"})`
      : "Ollama (local)";
    console.log(`[extractor] Using ${backend} for extraction`);
  }
}

/**
 * Call Mistral API with JSON mode for clean structured output.
 * Delegates to the shared mistral.ts helper.
 */
async function mistralChat(prompt: string, systemPrompt?: string): Promise<string> {
  const jsonSystemPrompt = systemPrompt
    ? `${systemPrompt}\n\nYou must respond with valid JSON only. No other text.`
    : "You must respond with valid JSON only. No other text.";

  const content = await mistralChatShared(
    [
      { role: "system", content: jsonSystemPrompt },
      { role: "user", content: prompt },
    ],
    { temperature: 0.1, max_tokens: 4096, json_mode: true }
  );
  console.log(`[extractor] Mistral response: length=${content.length}, preview=${content.substring(0, 200)}`);
  return content;
}

/**
 * Call Ollama chat API (non-streaming) and return the full response text.
 */
async function ollamaChat(prompt: string, systemPrompt?: string): Promise<string> {
  const baseUrl = (process.env.OLLAMA_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const model = process.env.OLLAMA_EXTRACTION_MODEL ?? process.env.OLLAMA_CHAT_MODEL ?? "llama3.2:1b";

  const messages: Array<{ role: string; content: string }> = [];
  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }
  messages.push({ role: "user", content: prompt });

  const response = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
      options: {
        temperature: 0.1,
        num_predict: parseInt(process.env.OLLAMA_NUM_PREDICT ?? "512", 10),
        num_ctx: parseInt(process.env.OLLAMA_NUM_CTX ?? "2048", 10),
      },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Ollama chat error ${response.status}: ${body}`);
  }

  const data = (await response.json()) as { message?: { content?: string } };
  return data.message?.content ?? "";
}

/**
 * Route extraction calls to Mistral API or local Ollama.
 */
async function extractionChat(prompt: string, systemPrompt?: string): Promise<string> {
  logBackendOnce();
  if (isMistralEnabled()) {
    return mistralChat(prompt, systemPrompt);
  }
  return ollamaChat(prompt, systemPrompt);
}

/**
 * Attempt to parse JSON from LLM output, handling common issues
 * like markdown code fences, trailing text, etc.
 */
function parseLooseJson<T>(text: string): T | null {
  // Strip markdown code fences
  let cleaned = text.replace(/```json\s*/gi, "").replace(/```\s*/g, "");

  // Try to find JSON object boundaries
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");

  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return null;
  }

  cleaned = cleaned.substring(firstBrace, lastBrace + 1);

  try {
    return JSON.parse(cleaned) as T;
  } catch {
    // Try fixing common issues: trailing commas
    try {
      const fixed = cleaned.replace(/,\s*([}\]])/g, "$1");
      return JSON.parse(fixed) as T;
    } catch {
      return null;
    }
  }
}

/**
 * Validate and clean a single extracted entity.
 */
function validateEntity(raw: Record<string, unknown>): ExtractedEntity | null {
  const entityType = String(raw.entity_type ?? "").toLowerCase();
  if (!VALID_ENTITY_TYPES.has(entityType)) return null;

  const content = String(raw.content ?? "").trim();
  if (!content || content.length < 5) return null;

  let status = String(raw.status ?? "unknown").toLowerCase();
  if (!VALID_STATUSES.has(status)) status = "unknown";

  const owner = raw.owner && typeof raw.owner === "string" && raw.owner.trim()
    ? raw.owner.trim()
    : null;

  let confidence = Number(raw.confidence);
  if (isNaN(confidence) || confidence < 0 || confidence > 1) confidence = 0.5;

  return {
    entity_type: entityType as ExtractedEntity["entity_type"],
    content: content.substring(0, 1000),
    status: status as ExtractedEntity["status"],
    owner,
    confidence: Math.round(confidence * 100) / 100,
  };
}

/**
 * Validate a single extracted relation.
 */
function validateRelation(raw: Record<string, unknown>, entityCount: number): ExtractedRelation | null {
  const sourceIndex = Number(raw.source_index);
  const targetIndex = Number(raw.target_index);

  if (isNaN(sourceIndex) || isNaN(targetIndex)) return null;
  if (sourceIndex < 0 || sourceIndex >= entityCount) return null;
  if (targetIndex < 0 || targetIndex >= entityCount) return null;
  if (sourceIndex === targetIndex) return null;

  const relationType = String(raw.relation_type ?? "").toLowerCase();
  if (!VALID_RELATION_TYPES.has(relationType)) return null;

  let confidence = Number(raw.confidence);
  if (isNaN(confidence) || confidence < 0 || confidence > 1) confidence = 0.5;

  return {
    source_index: sourceIndex,
    target_index: targetIndex,
    relation_type: relationType as ExtractedRelation["relation_type"],
    confidence: Math.round(confidence * 100) / 100,
  };
}

/**
 * Extract entities from a single chunk of text.
 */
export async function extractEntities(chunkContent: string): Promise<ExtractedEntity[]> {
  try {
    const prompt = ENTITY_EXTRACTION_PROMPT + chunkContent;
    const response = await extractionChat(prompt);

    const parsed = parseLooseJson<{ entities?: unknown[] }>(response);
    if (!parsed || !Array.isArray(parsed.entities)) {
      console.warn("[extractor] Failed to parse entity extraction response, raw:", response.substring(0, 300));
      return [];
    }

    const entities: ExtractedEntity[] = [];
    for (const raw of parsed.entities) {
      if (typeof raw !== "object" || raw === null) continue;
      const validated = validateEntity(raw as Record<string, unknown>);
      if (validated) entities.push(validated);
    }

    console.log(`[extractor] Single chunk: ${entities.length} entities extracted`);
    return entities;
  } catch (error) {
    console.error("[extractor] Entity extraction failed:", error instanceof Error ? error.stack : error);
    return [];
  }
}

/**
 * Minimum token count for a chunk to be worth extracting entities from.
 * Chunks below this are typically headers, separators, or TOC entries.
 */
const MIN_CHUNK_TOKENS = 80;

/**
 * Extract entities from multiple chunks in a single LLM call.
 * Chunks are separated by markers so entities can be attributed back.
 * Returns a map of chunkIndex -> entities.
 */
export async function extractEntitiesBatch(
  chunks: Array<{ content: string; tokenEstimate: number }>,
  onBatchComplete?: (chunksProcessed: number, totalEligible: number) => void
): Promise<Map<number, ExtractedEntity[]>> {
  const result = new Map<number, ExtractedEntity[]>();

  // Filter out tiny chunks
  const eligible = chunks
    .map((c, i) => ({ ...c, originalIndex: i }))
    .filter((c) => c.tokenEstimate >= MIN_CHUNK_TOKENS);

  if (eligible.length === 0) {
    console.log(`[extractor] No eligible chunks (all < ${MIN_CHUNK_TOKENS} tokens) out of ${chunks.length} total`);
    return result;
  }

  const defaultBatch = isMistralEnabled() ? "5" : "4";
  const defaultConcurrency = isMistralEnabled() ? "1" : "2";
  const BATCH_SIZE = parseInt(process.env.EXTRACTION_BATCH_SIZE ?? defaultBatch, 10);
  const CONCURRENCY = parseInt(process.env.EXTRACTION_CONCURRENCY ?? defaultConcurrency, 10);

  // Build all batches upfront
  const batches: Array<typeof eligible> = [];
  for (let b = 0; b < eligible.length; b += BATCH_SIZE) {
    batches.push(eligible.slice(b, b + BATCH_SIZE));
  }

  let chunksProcessed = 0;

  /**
   * Process a single batch: call Ollama and attribute entities to chunks.
   */
  async function processBatch(batch: typeof eligible): Promise<void> {
    const combinedText = batch
      .map((c, j) => `--- CHUNK ${j + 1} ---\n${c.content}`)
      .join("\n\n");

    try {
      const prompt = ENTITY_EXTRACTION_PROMPT + combinedText;
      const response = await extractionChat(prompt);

      const parsed = parseLooseJson<{ entities?: unknown[] }>(response);
      if (!parsed || !Array.isArray(parsed.entities)) {
        console.warn(`[extractor] Failed to parse batch response for chunks ${batch.map((c) => c.originalIndex).join(",")}: ${response.substring(0, 200)}`);
        return;
      }

      const entities: ExtractedEntity[] = [];
      for (const raw of parsed.entities) {
        if (typeof raw !== "object" || raw === null) continue;
        const validated = validateEntity(raw as Record<string, unknown>);
        if (validated) entities.push(validated);
      }

      console.log(`[extractor] Batch complete: ${entities.length} entities from ${batch.length} chunks (indices ${batch.map((c) => c.originalIndex).join(",")})`);

      // Distribute entities across batch chunks by best content match
      if (batch.length === 1) {
        result.set(batch[0].originalIndex, entities);
      } else {
        for (const chunk of batch) {
          result.set(chunk.originalIndex, []);
        }
        for (const entity of entities) {
          let bestIdx = batch[0].originalIndex;
          let bestScore = 0;
          for (const chunk of batch) {
            const words = entity.content.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
            const chunkLower = chunk.content.toLowerCase();
            const matches = words.filter((w) => chunkLower.includes(w)).length;
            const score = words.length > 0 ? matches / words.length : 0;
            if (score > bestScore) {
              bestScore = score;
              bestIdx = chunk.originalIndex;
            }
          }
          result.get(bestIdx)!.push(entity);
        }
      }
    } catch (error) {
      console.warn(`[extractor] Batch extraction failed for chunks ${batch.map((c) => c.originalIndex).join(",")}: ${error instanceof Error ? error.message : error}`);
    }

    chunksProcessed += batch.length;
    console.log(`[extractor] Batch complete: ${batch.length} chunks -> ${Array.from(result.values()).flat().length} entities so far`);
    onBatchComplete?.(chunksProcessed, eligible.length);
  }

  // Bounded-concurrency worker pool
  let nextBatch = 0;
  async function worker(): Promise<void> {
    while (nextBatch < batches.length) {
      const idx = nextBatch++;
      await processBatch(batches[idx]);
      // Delay between batches to avoid Mistral rate limits
      if (isMistralEnabled() && nextBatch < batches.length) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, batches.length) }, () => worker());
  await Promise.all(workers);

  return result;
}

/**
 * Extract relations between a set of entities from a document.
 */
export async function extractRelations(entities: ExtractedEntity[]): Promise<ExtractedRelation[]> {
  if (entities.length < 2) return [];

  try {
    const entityList = entities
      .map((e, i) => `[${i}] (${e.entity_type}) ${e.content}${e.owner ? ` [owner: ${e.owner}]` : ""}`)
      .join("\n");

    const prompt = RELATION_EXTRACTION_PROMPT + entityList;
    const response = await extractionChat(prompt);

    const parsed = parseLooseJson<{ relations?: unknown[] }>(response);
    if (!parsed || !Array.isArray(parsed.relations)) {
      console.warn("[extractor] Failed to parse relation extraction response");
      return [];
    }

    const relations: ExtractedRelation[] = [];
    for (const raw of parsed.relations) {
      if (typeof raw !== "object" || raw === null) continue;
      const validated = validateRelation(raw as Record<string, unknown>, entities.length);
      if (validated) relations.push(validated);
    }

    return relations;
  } catch (error) {
    console.error("[extractor] Relation extraction failed:", error instanceof Error ? error.message : error);
    return [];
  }
}
