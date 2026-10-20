import { GoogleGenAI } from "@google/genai";
import "dotenv/config";

const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
  throw new Error("GEMINI_API_KEY is not configured");
}

const ai = new GoogleGenAI({
  apiKey
});

export class GeminiError extends Error {
  statusCode: number;

  constructor(message: string, statusCode: number = 500) {
    super(message);
    this.name = "GeminiError";
    this.statusCode = statusCode;
  }
}

export function isQuotaOrRateLimitError(error: unknown): boolean {
  if (typeof error === "object" && error !== null) {
    const err = error as {
      status?: number;
      code?: number | string;
      message?: string;
      error?: { code?: number; message?: string; status?: string };
    };
    if (err.status === 429 || err.code === 429 || err.code === "RESOURCE_EXHAUSTED") {
      return true;
    }
    if (err.error?.code === 429 || err.error?.status === "RESOURCE_EXHAUSTED") {
      return true;
    }
    if (typeof err.message === "string") {
      const msg = err.message.toLowerCase();
      if (
        msg.includes("429") ||
        msg.includes("resource_exhausted") ||
        msg.includes("quota") ||
        msg.includes("rate limit")
      ) {
        return true;
      }
    }
  }
  return false;
}

export function isServiceUnavailableError(error: unknown): boolean {
  if (typeof error === "object" && error !== null) {
    const err = error as {
      status?: number;
      code?: number | string;
      message?: string;
      error?: { code?: number; message?: string; status?: string };
    };
    if (err.status === 503 || err.code === 503 || err.code === "UNAVAILABLE") {
      return true;
    }
    if (err.error?.code === 503 || err.error?.status === "UNAVAILABLE") {
      return true;
    }
    if (typeof err.message === "string") {
      const msg = err.message.toLowerCase();
      if (
        msg.includes("503") ||
        msg.includes("unavailable") ||
        msg.includes("overloaded") ||
        msg.includes("high demand")
      ) {
        return true;
      }
    }
  }
  return false;
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

export async function askGemini(prompt: string) {
  const response = await ai.models.generateContent({
    model: "gemini-3.8-flash",
    contents: prompt
  });

  return response.text;
}

export async function createPubMedQuery(
  question: string,
  language: string
) {
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

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: "gemini-3.8-flash",
        contents: prompt
      });

      return response.text?.trim() || "";
    } catch (error) {
      console.error(
        `Gemini attempt ${attempt} failed:`,
        error
      );

      if (isQuotaOrRateLimitError(error)) {
        throw new GeminiError(
          "Gemini API quota exceeded or rate limit reached (HTTP 429). Please try again later.",
          429
        );
      }

      if (attempt === 3) {
        throw error;
      }

      await new Promise((resolve) => {
        setTimeout(resolve, 2000);
      });
    }
  }

  return "";
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

  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: "gemini-3.8-flash",
        contents: prompt
      });

      const rawAnswer =
        response.text?.trim() ||
        "No summary could be generated from the retrieved articles.";

      return validateAndCleanSummary(rawAnswer, question);
    } catch (error) {
      console.error(
        `Gemini research attempt ${attempt} failed:`,
        error
      );

      // Do NOT retry 429 quota exhaustion or rate limit errors repeatedly
      if (isQuotaOrRateLimitError(error)) {
        throw new GeminiError(
          "Gemini API quota exceeded or rate limit reached (HTTP 429). Please try again later.",
          429
        );
      }

      const isUnavailable = isServiceUnavailableError(error);

      // Retry temporary 503 / UNAVAILABLE / model overload errors with short exponential backoff
      if (attempt < maxAttempts) {
        if (isUnavailable) {
          // Exponential backoff: attempt 1 -> 1500ms, attempt 2 -> 3000ms
          const backoffMs = 1500 * Math.pow(2, attempt - 1);
          console.warn(
            `Gemini API is temporarily unavailable (HTTP 503). Retrying in ${backoffMs}ms (attempt ${attempt} of ${maxAttempts})...`
          );
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
          continue;
        }

        // Allow one standard retry for non-quota transient errors
        if (attempt === 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }
      }

      // Preserve the original error status: 503 for unavailable, or original status code
      if (isUnavailable) {
        throw new GeminiError(
          "Gemini API is temporarily unavailable due to high demand (HTTP 503). Please try again in a moment.",
          503
        );
      }

      const message =
        error instanceof Error ? error.message : "Failed to communicate with Gemini API";
      const status =
        typeof (error as any)?.status === "number"
          ? (error as any).status
          : 500;
      throw new GeminiError(message, status);
    }
  }

  return "No summary could be generated from the retrieved articles.";
}