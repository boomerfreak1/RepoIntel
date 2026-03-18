/**
 * Shared Mistral API helper for extraction, classification, and chat.
 * Non-streaming for classification + extraction; streaming for answer generation.
 */

const MAX_RETRIES = 3;

export function isMistralConfigured(): boolean {
  return !!process.env.MISTRAL_API_KEY;
}

function getMistralModel(): string {
  return process.env.MISTRAL_CHAT_MODEL ?? process.env.MISTRAL_MODEL ?? "mistral-small-latest";
}

/**
 * Non-streaming Mistral chat completion.
 * Used for classification, extraction, and other structured tasks.
 */
export async function mistralChat(
  messages: Array<{ role: string; content: string }>,
  options?: {
    temperature?: number;
    max_tokens?: number;
    json_mode?: boolean;
  }
): Promise<string> {
  const apiKey = process.env.MISTRAL_API_KEY!;
  const model = getMistralModel();

  const requestBody = JSON.stringify({
    model,
    messages,
    temperature: options?.temperature ?? 0.1,
    max_tokens: options?.max_tokens ?? 4096,
    ...(options?.json_mode ? { response_format: { type: "json_object" } } : {}),
  });

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const response = await fetch("https://api.mistral.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: requestBody,
    });

    if (response.status === 429) {
      if (attempt >= MAX_RETRIES) {
        const body = await response.text();
        throw new Error(`Mistral API rate limited after ${MAX_RETRIES} retries: ${body}`);
      }
      const retryAfter = response.headers.get("Retry-After");
      const delayMs = retryAfter
        ? Math.min(parseInt(retryAfter, 10) * 1000, 30000)
        : Math.min(1000 * Math.pow(2, attempt), 8000);
      console.warn(`[mistral] 429 rate limited — retrying in ${delayMs}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
      await new Promise((r) => setTimeout(r, delayMs));
      continue;
    }

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Mistral API error ${response.status}: ${body}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
    };
    return data.choices?.[0]?.message?.content ?? "";
  }

  throw new Error("Mistral API: exhausted retries");
}

/**
 * Streaming Mistral chat completion.
 * Returns a ReadableStream that emits text tokens.
 * Used for answer generation in the chat pipeline.
 */
export async function mistralChatStream(
  messages: Array<{ role: string; content: string }>,
  options?: {
    temperature?: number;
    max_tokens?: number;
  }
): Promise<{ stream: ReadableStream<Uint8Array>; response: Response }> {
  const apiKey = process.env.MISTRAL_API_KEY!;
  const model = getMistralModel();

  const response = await fetch("https://api.mistral.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      temperature: options?.temperature ?? 0.7,
      max_tokens: options?.max_tokens ?? 2048,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Mistral streaming error ${response.status}: ${body}`);
  }

  return { stream: response.body!, response };
}
