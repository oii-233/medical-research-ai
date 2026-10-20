import { GoogleGenAI } from "@google/genai";
import "dotenv/config";

export class GeminiError extends Error {
  statusCode: number;

  constructor(message: string, statusCode: number = 500) {
    super(message);
    this.name = "GeminiError";
    this.statusCode = statusCode;
  }
}

export interface KeyConfig {
  name: "GEMINI_API_KEY" | "GEMINI_API_KEY_2" | "GEMINI_API_KEY_3";
  index: number;
  apiKey: string;
}

/**
 * Reads configured Gemini API keys from environment variables.
 * Keys are kept strictly server-side and deduplicated.
 */
export function getConfiguredKeyConfigs(): KeyConfig[] {
  const definitions: {
    name: "GEMINI_API_KEY" | "GEMINI_API_KEY_2" | "GEMINI_API_KEY_3";
    index: number;
    envVal?: string;
  }[] = [
    { name: "GEMINI_API_KEY", index: 1, envVal: process.env.GEMINI_API_KEY },
    { name: "GEMINI_API_KEY_2", index: 2, envVal: process.env.GEMINI_API_KEY_2 },
    { name: "GEMINI_API_KEY_3", index: 3, envVal: process.env.GEMINI_API_KEY_3 }
  ];

  const seenKeys = new Set<string>();
  const configs: KeyConfig[] = [];

  for (const def of definitions) {
    const trimmed = def.envVal?.trim();
    if (trimmed && !seenKeys.has(trimmed)) {
      seenKeys.add(trimmed);
      configs.push({
        name: def.name,
        index: def.index,
        apiKey: trimmed
      });
    }
  }

  return configs;
}

// Client cache to avoid re-instantiating GoogleGenAI per request
const clientCache = new Map<string, GoogleGenAI>();

function getGenAIClient(apiKey: string): GoogleGenAI {
  let client = clientCache.get(apiKey);
  if (!client) {
    client = new GoogleGenAI({ apiKey });
    clientCache.set(apiKey, client);
  }
  return client;
}

/**
 * Sanitizes messages to guarantee no API keys are exposed in logs or errors.
 */
export function sanitizeErrorMessage(message: string, extraKeys: string[] = []): string {
  if (!message) return "";

  let sanitized = message;

  // Redact any configured keys passed in
  for (const key of extraKeys) {
    if (key && key.length > 5) {
      sanitized = sanitized.split(key).join("[REDACTED_API_KEY]");
    }
  }

  // Redact environment variable keys
  const allEnvKeys = [
    process.env.GEMINI_API_KEY,
    process.env.GEMINI_API_KEY_2,
    process.env.GEMINI_API_KEY_3
  ];
  for (const envKey of allEnvKeys) {
    const trimmed = envKey?.trim();
    if (trimmed && trimmed.length > 5) {
      sanitized = sanitized.split(trimmed).join("[REDACTED_API_KEY]");
    }
  }

  // Redact standard Google API key patterns (AIzaSy...)
  sanitized = sanitized.replace(/AIza[0-9A-Za-z-_]{35}/g, "[REDACTED_API_KEY]");

  // Redact query parameter key values
  sanitized = sanitized.replace(/([?&]key=)[^&\s]+/gi, "$1[REDACTED_API_KEY]");

  return sanitized;
}

function extractErrorDetails(error: unknown) {
  if (typeof error === "object" && error !== null) {
    const err = error as Record<string, any>;
    const status =
      typeof err.status === "number"
        ? err.status
        : typeof err.statusCode === "number"
        ? err.statusCode
        : typeof err.response?.status === "number"
        ? err.response.status
        : typeof err.error?.code === "number"
        ? err.error.code
        : typeof err.code === "number"
        ? err.code
        : undefined;

    const code =
      typeof err.code === "string"
        ? err.code
        : typeof err.error?.status === "string"
        ? err.error.status
        : typeof err.status === "string"
        ? err.status
        : undefined;

    const message =
      typeof err.message === "string"
        ? err.message
        : typeof err.error?.message === "string"
        ? err.error.message
        : "";

    return { status, code, message };
  }

  return { status: undefined, code: undefined, message: String(error || "") };
}

export function isAuthenticationError(error: unknown): boolean {
  const { status, code, message } = extractErrorDetails(error);

  if (status === 401 || code === 401 || code === "UNAUTHENTICATED") {
    return true;
  }

  const msg = message.toLowerCase();
  return (
    msg.includes("401") ||
    msg.includes("unauthenticated") ||
    msg.includes("api key not valid") ||
    msg.includes("invalid api key") ||
    msg.includes("api_key_invalid")
  );
}

export function isForbiddenError(error: unknown): boolean {
  const { status, code, message } = extractErrorDetails(error);

  if (status === 403 || code === 403 || code === "PERMISSION_DENIED") {
    return true;
  }

  const msg = message.toLowerCase();
  return (
    msg.includes("403") ||
    msg.includes("permission_denied") ||
    msg.includes("forbidden")
  );
}

export function isInvalidRequestError(error: unknown): boolean {
  const { status, code, message } = extractErrorDetails(error);

  if (status === 400 || code === 400 || code === "INVALID_ARGUMENT") {
    return true;
  }

  const msg = message.toLowerCase();
  return (
    msg.includes("400") ||
    msg.includes("invalid_argument") ||
    msg.includes("bad request")
  );
}

export function isQuotaOrRateLimitError(error: unknown): boolean {
  const { status, code, message } = extractErrorDetails(error);

  if (status === 429 || code === 429 || code === "RESOURCE_EXHAUSTED") {
    return true;
  }

  const msg = message.toLowerCase();
  return (
    msg.includes("429") ||
    msg.includes("resource_exhausted") ||
    msg.includes("quota") ||
    msg.includes("rate limit")
  );
}

export function isServiceUnavailableError(error: unknown): boolean {
  const { status, code, message } = extractErrorDetails(error);

  if (status === 503 || code === 503 || code === "UNAVAILABLE") {
    return true;
  }

  const msg = message.toLowerCase();
  return (
    msg.includes("503") ||
    msg.includes("unavailable") ||
    msg.includes("overloaded") ||
    msg.includes("high demand")
  );
}

/**
 * Executes a Gemini operation with automatic fallback across configured API keys.
 * Rate limit (429) or service unavailability (503) triggers fallback to the next key.
 * Authentication (401/403) or invalid request (400) errors immediately fail without trying other keys.
 */
async function runWithKeyFallback<T>(
  actionName: string,
  operation: (client: GoogleGenAI, keyLabel: string) => Promise<T>
): Promise<T> {
  const keyConfigs = getConfiguredKeyConfigs();

  if (keyConfigs.length === 0) {
    throw new GeminiError(
      "No Gemini API key configured. Please set GEMINI_API_KEY in backend/.env",
      500
    );
  }

  const secretKeys = keyConfigs.map((k) => k.apiKey);
  let lastError: unknown = null;

  for (let keyIdx = 0; keyIdx < keyConfigs.length; keyIdx++) {
    const keyConfig = keyConfigs[keyIdx];
    const client = getGenAIClient(keyConfig.apiKey);
    const isLastKey = keyIdx === keyConfigs.length - 1;
    const keyLabel = `Key ${keyConfig.index} (${keyConfig.name})`;

    // If it's the last available key and service is 503, allow 1 backoff retry
    const maxAttemptsForThisKey = isLastKey ? 2 : 1;

    for (let attempt = 1; attempt <= maxAttemptsForThisKey; attempt++) {
      try {
        return await operation(client, keyLabel);
      } catch (error) {
        lastError = error;
        const safeErrorMsg = sanitizeErrorMessage(
          error instanceof Error ? error.message : String(error),
          secretKeys
        );

        // 1. Authentication errors (401) - Do not retry with other keys
        if (isAuthenticationError(error)) {
          console.error(
            `[Gemini] Authentication error on ${keyLabel}. Halting fallback.`
          );
          throw new GeminiError(
            "Gemini API authentication failed (HTTP 401). Invalid API key provided.",
            401
          );
        }

        // 2. Authorization / Forbidden errors (403) - Do not retry with other keys
        if (isForbiddenError(error)) {
          console.error(
            `[Gemini] Access forbidden error on ${keyLabel}. Halting fallback.`
          );
          throw new GeminiError(
            "Gemini API access forbidden (HTTP 403). The API key lacks permissions or has been disabled.",
            403
          );
        }

        // 3. Invalid Request errors (400) - Do not retry with other keys
        if (isInvalidRequestError(error)) {
          console.error(
            `[Gemini] Invalid request error on ${keyLabel}: ${safeErrorMsg}. Halting fallback.`
          );
          throw new GeminiError(
            `Invalid request to Gemini API (HTTP 400): ${safeErrorMsg}`,
            400
          );
        }

        // 4. Rate limiting / Quota (429) or Temporary Service Unavailability (503)
        const isRateLimit = isQuotaOrRateLimitError(error);
        const isUnavailable = isServiceUnavailableError(error);

        if (isRateLimit || isUnavailable) {
          const reason = isRateLimit
            ? "rate limiting / quota exhaustion (HTTP 429)"
            : "temporary service unavailability (HTTP 503)";

          if (!isLastKey) {
            console.warn(
              `[Gemini] ${actionName} failed on ${keyLabel} due to ${reason}. Trying fallback key...`
            );
            // Break from inner attempt loop and advance to next key in keyConfigs
            break;
          } else {
            // Last configured key
            if (isUnavailable && attempt < maxAttemptsForThisKey) {
              const backoffMs = 1500;
              console.warn(
                `[Gemini] ${actionName} on ${keyLabel} hit ${reason}. Retrying in ${backoffMs}ms...`
              );
              await new Promise((resolve) => setTimeout(resolve, backoffMs));
              continue;
            }

            console.error(
              `[Gemini] ${actionName} failed across all configured API keys (last failure on ${keyLabel}: ${reason}).`
            );

            if (isRateLimit) {
              throw new GeminiError(
                "Gemini API quota exceeded or rate limit reached (HTTP 429). Please try again later.",
                429
              );
            } else {
              throw new GeminiError(
                "Gemini API is temporarily unavailable due to high demand (HTTP 503). Please try again in a moment.",
                503
              );
            }
          }
        }

        // 5. Any other unexpected error
        console.error(
          `[Gemini] Unexpected error on ${keyLabel}: ${safeErrorMsg}`
        );

        if (!isLastKey) {
          console.warn(
            `[Gemini] Attempting fallback to next configured key after unexpected error...`
          );
          break;
        } else {
          const status = extractErrorDetails(error).status || 500;
          throw new GeminiError(safeErrorMsg, status);
        }
      }
    }
  }

  // Fallback exhaust safety check
  throw new GeminiError(
    "All configured Gemini API keys failed to process the request.",
    500
  );
}

export function cleanPubMedReferences(text: string): string {
  if (!text) return "";

  let cleaned = text;

  // Contextual phrase replacements to maintain natural sentence flow
  const phraseReplacements: [RegExp, string][] = [
    // Direct URL references
    [/https?:\/\/(?:www\.)?pubmed\.ncbi\.nlm\.nih\.gov\/?\S*/gi, "the primary study record"],

    // Phrases like "according to PubMed"
    [/\baccording to (?:the )?pubmed\b/gi, "according to published scientific literature"],
    [/\bbased on (?:the )?pubmed (?:articles|studies|literature|data|search results|results|publications)\b/gi, "based on published scientific studies"],
    [/\bbased on pubmed\b/gi, "based on published medical research"],

    // Retrieval / indexing / source phrases
    [/\b(?:retrieved|sourced|gathered|obtained|indexed|searched) (?:from|in|on|via) (?:the )?pubmed\b/gi, "retrieved from published scientific literature"],
    [/\b(?:available|found|published|cataloged) (?:on|in|through) (?:the )?pubmed\b/gi, "available in published scientific literature"],
    [/\b(?:on|in|from|through|via) (?:the )?pubmed\b/gi, "in published scientific literature"],

    // Compound nouns with PubMed
    [/\bpubmed database\b/gi, "medical literature database"],
    [/\bpubmed website\b/gi, "scientific literature repository"],
    [/\bpubmed (?:search results|search query|search)\b/gi, "scientific literature search"],
    [/\bpubmed (?:articles|studies|publications|papers)\b/gi, "scientific publications"],
    [/\bpubmed (?:article|study|publication|paper)\b/gi, "scientific publication"],
    [/\bpubmed (?:metadata|citations|records|abstracts)\b/gi, "study metadata"],
    [/\bpubmed (?:citation|record|abstract)\b/gi, "study citation"],
    [/\bpubmed literature\b/gi, "scientific literature"],
    [/\bpubmed id\b/gi, "study ID"],
    [/\bpubmed\s*url\b/gi, "study link"],

    // Sentence starters and active verb statements
    [/\bpubmed does not provide\b/gi, "The available study metadata does not provide"],
    [/\bpubmed shows\b/gi, "Published scientific evidence shows"],
    [/\bpubmed suggests\b/gi, "Published research suggests"],
    [/\bpubmed reports\b/gi, "Published research reports"],
    [/\bpubmed indicates\b/gi, "Published literature indicates"],

    // Fallback for any remaining standalone "PubMed" with word boundaries
    [/\bpubmed\b/gi, "scientific literature"]
  ];

  for (const [pattern, replacement] of phraseReplacements) {
    cleaned = cleaned.replace(pattern, replacement);
  }

  // Safety pass: replace any remaining instance regardless of boundaries or casing
  if (/pubmed/i.test(cleaned)) {
    cleaned = cleaned.replace(/pubmed/gi, "scientific literature");
  }

  // Restore appropriate sentence capitalization if replacement occurred at start of a sentence
  cleaned = cleaned.replace(/(^\s*|[.!?]\s+)([a-z])/g, (match, prefix, char) => {
    return prefix + char.toUpperCase();
  });

  return cleaned.trim();
}

export function validateAndCleanSummary(answer: string, question: string = ""): string {
  if (!answer) return "";

  const cleaned = cleanPubMedReferences(answer);

  // Validate that no mention of "pubmed" remains in any capitalization
  if (/pubmed/i.test(cleaned)) {
    const scrubbed = cleaned.replace(/pubmed/gi, "scientific literature");
    if (!/pubmed/i.test(scrubbed)) {
      return scrubbed;
    }

    // Safe, natural fallback if cleaning would still leave malformed text
    return `Published scientific studies addressing "${question}" investigate key clinical themes and therapeutic mechanisms related to this topic. However, detailed clinical endpoints and statistical outcomes cannot be definitively determined from study title metadata alone; please refer to the individual study records below for full-text findings.`;
  }

  return cleaned;
}

export async function askGemini(prompt: string): Promise<string | undefined> {
  return runWithKeyFallback("askGemini", async (ai) => {
    const response = await ai.models.generateContent({
      model: "gemini-3.8-flash",
      contents: prompt
    });

    return response.text;
  });
}

export async function createPubMedQuery(
  question: string,
  language: string
): Promise<string> {
  const prompt = `
You are a medical research assistant.

The user asked a medical research question in ${language}.

User question:
${question}

Convert the question into a short, clear English search query
that can be used to search PubMed medical literature.

Rules:
- Return ONLY the English search query.
- Do not explain anything.
- Do not answer the medical question.
- Keep important medical terms.
`;

  return runWithKeyFallback("createPubMedQuery", async (ai) => {
    const response = await ai.models.generateContent({
      model: "gemini-3.8-flash",
      contents: prompt
    });

    return response.text?.trim() || "";
  });
}

export async function generateResearchAnswer(
  question: string,
  articles: {
    pmid: string;
    title: string;
    authors: string;
    journal: string;
    publishedDate: string;
    url: string;
  }[]
): Promise<string> {
  const articleText = articles
    .map((article, index) => {
      return `Article ${index + 1}:
Title: ${article.title}
Authors: ${article.authors}
Journal: ${article.journal}
Published Date: ${article.publishedDate}`;
    })
    .join("\n\n");

  const prompt = `You are a medical research assistant.

Research question:
${question}

Relevant published studies:
${articleText}

Instructions:
1. Directly answer the research question using the scientific themes, interventions, and clinical topics identified in the titles and metadata of the published studies above.
2. Structure your response into clear, professional paragraphs:
   - Provide a direct synthesis answering the question based on what these studies investigate.
   - Summarize the specific clinical directions, therapeutic targets, or focus areas represented by the studies.
   - Honestly note evidence limitations: explain that because only study titles and citation metadata are available here (without complete study abstracts or full-text trial data), comprehensive statistical outcomes or definitive clinical conclusions cannot be confirmed from this summary alone.
3. NEVER use the word "PubMed", "PubMed database", or "PubMed website" anywhere in your response, under any capitalization or context. Refer only to "the published studies", "scientific literature", or "primary research publications".
4. Do not invent, fabricate, or assume any clinical statistics, patient numbers, numerical outcomes, authors, or citations not directly provided in the input above.
5. Keep the response strictly educational, objective, and readable. Do not provide personalized medical advice or clinical diagnosis.
6. Do not include a separate sources or references list at the end (the user interface displays the citation list separately).`;

  const rawAnswer = await runWithKeyFallback(
    "generateResearchAnswer",
    async (ai) => {
      const response = await ai.models.generateContent({
        model: "gemini-3.8-flash",
        contents: prompt
      });

      return (
        response.text?.trim() ||
        "No summary could be generated from the retrieved articles."
      );
    }
  );

  return validateAndCleanSummary(rawAnswer, question);
}