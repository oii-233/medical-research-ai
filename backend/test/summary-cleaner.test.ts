import { cleanPubMedReferences, validateAndCleanSummary } from "../src/services/gemini.js";

interface TestCase {
  name: string;
  input: string;
  expectedPhrases: string[];
}

const testCases: TestCase[] = [
  {
    name: "Standard 'according to PubMed' and 'PubMed articles'",
    input: "According to PubMed, SGLT2 inhibitors significantly reduce cardiovascular mortality. Several PubMed articles highlight these therapeutic benefits.",
    expectedPhrases: [
      "According to published scientific literature",
      "scientific publications"
    ]
  },
  {
    name: "Phrases with 'PubMed database' and 'PubMed search'",
    input: "The PubMed database indexes numerous studies on Alzheimer's disease. In this PubMed search, various cognitive interventions were evaluated.",
    expectedPhrases: [
      "medical literature database",
      "scientific literature search"
    ]
  },
  {
    name: "Phrases with 'in/on/from PubMed' and 'PubMed metadata'",
    input: "The findings retrieved from PubMed show positive trends. However, because only PubMed metadata is available, complete clinical details cannot be confirmed.",
    expectedPhrases: [
      "retrieved from published scientific literature",
      "study metadata"
    ]
  },
  {
    name: "All-caps and mixed-case occurrences ('PUBMED', 'pubmed')",
    input: "According to PUBMED, new therapies are emerging. Each pubmed article was reviewed.",
    expectedPhrases: [
      "According to published scientific literature",
      "scientific publication"
    ]
  },
  {
    name: "Direct PubMed URLs in summary text",
    input: "Further details can be found at https://pubmed.ncbi.nlm.nih.gov/12345678/ for this study.",
    expectedPhrases: [
      "the primary study record"
    ]
  },
  {
    name: "Sentence starters like 'PubMed does not provide...'",
    input: "PubMed does not provide full-text trial data for these records.",
    expectedPhrases: [
      "The available study metadata does not provide"
    ]
  }
];

let failedCount = 0;

console.log("=== RUNNING MEDICAL RESEARCH AI SUMMARY SANITIZATION TESTS ===\n");

for (const tc of testCases) {
  const result = validateAndCleanSummary(tc.input, "What are the latest medical treatments?");

  // 1. Strict check: absolutely NO mention of PubMed in any casing
  const hasPubMed = /pubmed/i.test(result);

  if (hasPubMed) {
    console.error(`[FAIL] ${tc.name}:`);
    console.error(`  Output still contains 'PubMed': "${result}"`);
    failedCount++;
    continue;
  }

  // 2. Check that expected natural phrases are present
  let phraseCheckPassed = true;
  for (const phrase of tc.expectedPhrases) {
    if (!result.toLowerCase().includes(phrase.toLowerCase())) {
      console.warn(`  [WARN] Missing expected phrase: "${phrase}" in "${result}"`);
    }
  }

  console.log(`[PASS] ${tc.name}`);
  console.log(`  Input:  "${tc.input}"`);
  console.log(`  Output: "${result}"\n`);
}

if (failedCount > 0) {
  console.error(`\nFAILED: ${failedCount} test(s) failed.`);
  process.exit(1);
} else {
  console.log("\nALL TESTS PASSED: 0 occurrences of 'PubMed' (case-insensitive) found in final output.");
  process.exit(0);
}
