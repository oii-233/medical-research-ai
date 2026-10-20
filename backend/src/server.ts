import express from "express";
import cors from "cors";
import "dotenv/config";
import {
  askGemini,
  createPubMedQuery,
  generateResearchAnswer,
  isQuotaOrRateLimitError,
  isServiceUnavailableError,
  validateAndCleanSummary
} from "./services/gemini.js";
import { searchPubMed } from "./services/pubmed.js";

const app = express();
const PORT = 5000;

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.json({
    message: "Medical Research AI API is running"
  });
});

app.post("/api/research/test", async (req, res) => {
  try {
    const { question } = req.body;

    if (!question) {
      return res.status(400).json({
        message: "Question is required"
      });
    }

    const answer = await askGemini(
      `You are a medical research assistant.

Research question:
${question}

Give a simple educational explanation.
Do not diagnose the user or provide personalized medical advice.`
    );

    res.json({
      success: true,
      question,
      answer
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      message: "Failed to generate research"
    });
  }
});

app.get("/api/research/search", async (req, res) => {
  try {
    const query = req.query.q as string;

    if (!query) {
      return res.status(400).json({
        success: false,
        message: "Search query is required"
      });
    }

    const articles = await searchPubMed(query);

    res.json({
      success: true,
      query,
      count: articles.length,
      articles
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      message: "PubMed search failed"
    });
  }
});

app.post("/api/research/query", async (req, res) => {
  try {
    const { question, language } = req.body;

    if (!question) {
      return res.status(400).json({
        success: false,
        message: "Question is required"
      });
    }

    if (!language) {
      return res.status(400).json({
        success: false,
        message: "Language is required"
      });
    }

    const pubmedQuery = await createPubMedQuery(
      question,
      language
    );

    res.json({
      success: true,
      originalQuestion: question,
      language,
      pubmedQuery
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      message: "Failed to create research query"
    });
  }
});

app.post("/api/research", async (req, res) => {
  try {
    const { question } = req.body;

    // Validate empty or missing question
    if (!question || typeof question !== "string" || question.trim() === "") {
      return res.status(400).json({
        success: false,
        message: "Medical research question is required"
      });
    }

    const trimmedQuestion = question.trim();

    // Search PubMed directly with the English question
    const articles = await searchPubMed(trimmedQuestion);

    // If no articles are found, return existing no-results response without calling Gemini
    if (articles.length === 0) {
      return res.json({
        success: true,
        question: trimmedQuestion,
        count: 0,
        answer: "No relevant scientific articles were found for this question.",
        articles: [],
        message: "No relevant scientific articles were found for this question."
      });
    }

    // Generate English research summary from PubMed articles using Gemini
    let answer: string;
    try {
      answer = await generateResearchAnswer(trimmedQuestion, articles);
    } catch (geminiError: any) {
      console.error("Gemini summary generation failed:", geminiError);

      const isRateLimit =
        geminiError?.statusCode === 429 ||
        geminiError?.status === 429 ||
        isQuotaOrRateLimitError(geminiError);

      const isUnavailable =
        geminiError?.statusCode === 503 ||
        geminiError?.status === 503 ||
        isServiceUnavailableError(geminiError);

      if (isRateLimit) {
        return res.status(429).json({
          success: false,
          message:
            "Gemini API quota exceeded or rate limit reached (HTTP 429). Please try again later."
        });
      }

      if (isUnavailable) {
        return res.status(503).json({
          success: false,
          message:
            "Gemini AI is temporarily unavailable due to high demand (HTTP 503). Please try again in a moment."
        });
      }

      const statusCode =
        typeof geminiError?.statusCode === "number"
          ? geminiError.statusCode
          : 502;

      return res.status(statusCode).json({
        success: false,
        message: `Failed to generate research summary: ${
          geminiError instanceof Error
            ? geminiError.message
            : "Gemini service error"
        }`
      });
    }

    // Return JSON containing success, question, count, answer, and articles
    return res.json({
      success: true,
      question: trimmedQuestion,
      count: articles.length,
      answer: validateAndCleanSummary(answer, trimmedQuestion),
      articles
    });
  } catch (error) {
    console.error("PubMed research error:", error);

    return res.status(500).json({
      success: false,
      message: error instanceof Error ? error.message : "PubMed search failed"
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});