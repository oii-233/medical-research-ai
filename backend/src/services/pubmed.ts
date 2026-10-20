const BASE_URL =
  "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
const REQUEST_TIMEOUT_MS = 10000;

export interface PubMedArticle {
  pmid: string;
  title: string;
  authors: string;
  journal: string;
  publishedDate: string;
  url: string;
}

function isTransientNetworkError(error: unknown): boolean {
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      return true;
    }
    const msg = error.message.toLowerCase();
    return (
      msg.includes("timeout") ||
      msg.includes("fetch failed") ||
      msg.includes("und_err_connect_timeout") ||
      msg.includes("econnreset") ||
      msg.includes("enotfound") ||
      msg.includes("econnrefused")
    );
  }
  return false;
}

async function fetchWithTimeoutAndRetry(
  url: string,
  errorContext: string
): Promise<Response> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });

      if (!response.ok) {
        // Ordinary HTTP errors: do not retry
        throw new Error(`${errorContext} failed with status ${response.status}`);
      }

      return response;
    } catch (error) {
      const isTransient = isTransientNetworkError(error);

      // Only retry once on transient network errors or timeouts
      if (isTransient && attempt === 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }

      if (
        error instanceof Error &&
        (error.name === "TimeoutError" ||
          error.name === "AbortError" ||
          error.message.toLowerCase().includes("timeout"))
      ) {
        throw new Error(
          `${errorContext} timed out after ${REQUEST_TIMEOUT_MS / 1000} seconds. NCBI servers may be experiencing high latency.`
        );
      }

      if (
        error instanceof Error &&
        error.message.toLowerCase().includes("fetch failed")
      ) {
        throw new Error(
          `${errorContext} connection failed. Unable to reach PubMed NCBI servers.`
        );
      }

      throw error;
    }
  }

  throw new Error(`${errorContext} failed after retry`);
}

export async function searchPubMed(
  query: string
): Promise<PubMedArticle[]> {
  const toolParam = `&tool=medical-research-ai`;
  const emailParam = process.env.NCBI_EMAIL
    ? `&email=${encodeURIComponent(process.env.NCBI_EMAIL)}`
    : "";

  const searchUrl =
    `${BASE_URL}/esearch.fcgi` +
    `?db=pubmed` +
    `&term=${encodeURIComponent(query)}` +
    `&retmax=5` +
    `&sort=relevance` +
    `&retmode=json` +
    toolParam +
    emailParam;

  const searchResponse = await fetchWithTimeoutAndRetry(
    searchUrl,
    "PubMed search"
  );

  const searchData = await searchResponse.json();

  const ids: string[] = searchData?.esearchresult?.idlist || [];

  if (ids.length === 0) {
    return [];
  }

  const summaryUrl =
    `${BASE_URL}/esummary.fcgi` +
    `?db=pubmed` +
    `&id=${ids.join(",")}` +
    `&retmode=json` +
    toolParam +
    emailParam;

  const summaryResponse = await fetchWithTimeoutAndRetry(
    summaryUrl,
    "PubMed article retrieval"
  );

  const summaryData = await summaryResponse.json();

  const articles: PubMedArticle[] = [];

  for (const id of ids) {
    const article = summaryData?.result?.[id];

    if (!article) {
      continue;
    }

    articles.push({
      pmid: id,
      title: article.title || "Untitled",
      authors:
        article.authors
          ?.map((author: { name: string }) => author.name)
          .join(", ") || "Unknown",
      journal: article.fulljournalname || article.source || "Unknown",
      publishedDate: article.pubdate || "Unknown",
      url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`
    });
  }

  return articles;
}