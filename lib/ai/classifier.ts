/**
 * Intent classification for smart query routing.
 * Classifies user queries into factual, synthesis, relational, or exploratory
 * and extracts relevant filters (domain, entity type, stakeholder name).
 */

import { isMistralConfigured, mistralChat } from "./mistral";

const DEFAULT_BASE_URL = "http://localhost:11434";

export type QueryIntent = "factual" | "synthesis" | "relational" | "exploratory";

export interface ClassifiedQuery {
  intent: QueryIntent;
  domain: string | null;
  entity_type: string | null;
  stakeholder: string | null;
  subject: string | null;
}

const CLASSIFICATION_PROMPT = `You are a query classifier for a document intelligence system. Classify the user's question into one of four types and extract any filters.

Query types:
- factual: User wants a specific fact (who owns X, what is the status of Y, when was Z decided)
- synthesis: User wants a broad overview or summary (summarize X, what's the status of domain Y, how are things going)
- relational: User wants to trace connections or dependencies (what depends on X, what blocks Y, who is connected to Z)
- exploratory: User wants proactive surfacing of issues (what should I worry about, what needs attention, what are the risks)

Extract these filters if present in the query:
- domain: A domain or category name if mentioned
- entity_type: An entity type if relevant (decision, dependency, gap, stakeholder, milestone, workflow)
- stakeholder: A person's name if referenced
- subject: The main subject/topic of the question

Return ONLY a JSON object with this exact structure, no other text:
{"intent": "factual", "domain": null, "entity_type": null, "stakeholder": null, "subject": null}

Examples:
"who owns the authentication service?" -> {"intent": "factual", "domain": null, "entity_type": "stakeholder", "stakeholder": null, "subject": "authentication service"}
"summarize the status of the backend team" -> {"intent": "synthesis", "domain": "backend", "entity_type": null, "stakeholder": null, "subject": "backend team status"}
"what depends on the database migration?" -> {"intent": "relational", "domain": null, "entity_type": "dependency", "stakeholder": null, "subject": "database migration"}
"what should I be worried about?" -> {"intent": "exploratory", "domain": null, "entity_type": null, "stakeholder": null, "subject": null}

Now classify this query:
`;

const VALID_INTENTS = new Set(["factual", "synthesis", "relational", "exploratory"]);
const VALID_ENTITY_TYPES = new Set(["decision", "dependency", "gap", "stakeholder", "milestone", "workflow"]);

/**
 * Parse JSON loosely from LLM output.
 */
function parseLooseJson<T>(text: string): T | null {
  let cleaned = text.replace(/```json\s*/gi, "").replace(/```\s*/g, "");
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return null;
  cleaned = cleaned.substring(firstBrace, lastBrace + 1);
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    try {
      return JSON.parse(cleaned.replace(/,\s*([}\]])/g, "$1")) as T;
    } catch {
      return null;
    }
  }
}

/**
 * Parse a classification response into a ClassifiedQuery.
 */
function parseClassificationResponse(text: string, question: string): ClassifiedQuery | null {
  const parsed = parseLooseJson<Record<string, unknown>>(text);
  if (!parsed) return null;

  const intent = String(parsed.intent ?? "synthesis").toLowerCase();
  const entityType = parsed.entity_type ? String(parsed.entity_type).toLowerCase() : null;

  return {
    intent: VALID_INTENTS.has(intent) ? intent as QueryIntent : "synthesis",
    domain: parsed.domain && typeof parsed.domain === "string" ? parsed.domain.trim() : null,
    entity_type: entityType && VALID_ENTITY_TYPES.has(entityType) ? entityType : null,
    stakeholder: parsed.stakeholder && typeof parsed.stakeholder === "string" ? parsed.stakeholder.trim() : null,
    subject: parsed.subject && typeof parsed.subject === "string" ? parsed.subject.trim() : null,
  };
}

/**
 * Classify a user query. Tries Mistral first (if configured), then Ollama, then rule-based fallback.
 */
export async function classifyQuery(question: string): Promise<ClassifiedQuery> {
  // Try Mistral first
  if (isMistralConfigured()) {
    try {
      console.log("[classifier] Using Mistral for classification");
      const text = await mistralChat(
        [{ role: "user", content: CLASSIFICATION_PROMPT + question }],
        { temperature: 0.1, max_tokens: 256 }
      );
      const result = parseClassificationResponse(text, question);
      if (result) return result;
      console.warn("[classifier] Failed to parse Mistral classification response, trying Ollama");
    } catch (error) {
      console.warn("[classifier] Mistral classification failed:", error instanceof Error ? error.message : error);
    }
  }

  // Ollama fallback
  const baseUrl = (process.env.OLLAMA_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const model = process.env.OLLAMA_CHAT_MODEL ?? "llama3.2:1b";

  try {
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "user", content: CLASSIFICATION_PROMPT + question },
        ],
        stream: false,
        options: { temperature: 0.1, num_predict: 256 },
      }),
    });

    if (!response.ok) {
      console.warn(`[classifier] Ollama returned ${response.status}, falling back to rules`);
      return fallbackClassify(question);
    }

    const data = (await response.json()) as { message?: { content?: string } };
    const text = data.message?.content ?? "";

    const result = parseClassificationResponse(text, question);
    if (result) return result;

    console.warn("[classifier] Failed to parse Ollama classification response, using fallback");
    return fallbackClassify(question);
  } catch (error) {
    console.warn("[classifier] Classification failed:", error instanceof Error ? error.message : error);
    return fallbackClassify(question);
  }
}

/**
 * Rule-based fallback classifier when LLM is unavailable.
 */
function fallbackClassify(question: string): ClassifiedQuery {
  const q = question.toLowerCase();

  let intent: QueryIntent = "synthesis";
  if (/^(who|what is the status|what's the owner|which team)/.test(q)) {
    intent = "factual";
  } else if (/depend|block|connect|relate|link|upstream|downstream/.test(q)) {
    intent = "relational";
  } else if (/worr|risk|attention|concern|issue|problem|stale|blocked/.test(q)) {
    intent = "exploratory";
  } else if (/summar|overview|status|how.*going|tell me about|describe/.test(q)) {
    intent = "synthesis";
  }

  return { intent, domain: null, entity_type: null, stakeholder: null, subject: null };
}
