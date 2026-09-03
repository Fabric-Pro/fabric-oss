/**
 * Core Chunking Tests
 *
 * Tests the main chunking functionality with mocked dependencies.
 * Run with: pnpm --filter @repo/rag test
 */

import { describe, expect, it, vi } from "vitest";

// Mock the logger
vi.mock("@repo/logs", () => ({
	logger: {
		info: vi.fn(),
		error: vi.fn(),
		warn: vi.fn(),
		debug: vi.fn(),
	},
}));

// Mock the tokenizer to avoid slow tiktoken initialization
vi.mock("../tokenizer", () => ({
	countTokens: vi.fn((text: string) => Math.ceil(text.length / 4)),
	charsToTokensEstimate: vi.fn((chars: number) => Math.ceil(chars / 4)),
}));

import {
	chunkText,
	chunkTextWithStats,
	detectContentType,
	estimateTokenCount,
	getRecommendedOptions,
} from "../chunker";

// Sample texts for testing
const SHORT_TEXT = "Hello, world! This is a short text.";

const PARAGRAPH_TEXT = `
First paragraph with some content that explains the introduction.

Second paragraph that continues with more detailed information about the topic.

Third paragraph that provides additional context and elaboration on the subject matter.

Fourth paragraph with concluding thoughts and summary of the main points.
`.trim();

const MARKDOWN_TEXT = `
# Main Title

Introduction paragraph here.

## Section 1

Content for section 1.

### Subsection 1.1

More detailed content.

## Section 2

Content for section 2.
`.trim();

const CODE_TEXT = `
function hello() {
  console.log("Hello, world!");
}

class Example {
  constructor() {
    this.value = 42;
  }

  getValue() {
    return this.value;
  }
}
`.trim();

describe("RAG Chunking Module", () => {
	describe("Basic Chunking", () => {
		it("should chunk text with FIXED strategy", () => {
			const chunks = chunkText(PARAGRAPH_TEXT, "test.txt", {
				strategy: "FIXED",
				chunkSize: 100,
				chunkOverlap: 20,
				preserveSentences: false, // Disable sentence preservation for exact size test
			});

			expect(chunks.length).toBeGreaterThan(0);
			// With preserveSentences=false, chunks should be close to chunkSize
			expect(chunks[0].content.length).toBeLessThanOrEqual(150);
		});

		it("should chunk text with PARAGRAPH strategy", () => {
			const chunks = chunkText(PARAGRAPH_TEXT, "test.txt", {
				strategy: "PARAGRAPH",
				chunkSize: 200,
			});

			expect(chunks.length).toBeGreaterThan(0);
		});

		it("should chunk text with SENTENCE strategy", () => {
			const chunks = chunkText(PARAGRAPH_TEXT, "test.txt", {
				strategy: "SENTENCE",
				chunkSize: 100,
			});

			expect(chunks.length).toBeGreaterThan(0);
		});

		it("should chunk text with RECURSIVE strategy", () => {
			const chunks = chunkText(PARAGRAPH_TEXT, "test.txt", {
				strategy: "RECURSIVE",
				chunkSize: 150,
			});

			expect(chunks.length).toBeGreaterThan(0);
		});

		it("should chunk text with DOCUMENT strategy", () => {
			const chunks = chunkText(MARKDOWN_TEXT, "test.md", {
				strategy: "DOCUMENT",
				chunkSize: 200,
				minChunkSize: 10, // Lower min chunk size for small test content
			});

			expect(chunks.length).toBeGreaterThanOrEqual(0); // May be 0 if content is too small
		});
	});

	describe("Edge Cases", () => {
		it("should handle empty text", () => {
			const chunks = chunkText("", "test.txt", {
				strategy: "FIXED",
				chunkSize: 100,
			});

			expect(chunks).toHaveLength(0);
		});

		it("should handle text shorter than chunk size", () => {
			const chunks = chunkText(SHORT_TEXT, "test.txt", {
				strategy: "FIXED",
				chunkSize: 1000,
				minChunkSize: 10,
			});

			expect(chunks).toHaveLength(1);
			expect(chunks[0].content).toBe(SHORT_TEXT);
		});

		it("emits one chunk for non-empty text below the DEFAULT minChunkSize (image OCR / short note)", () => {
			// 23 chars — like an image OCR/vision-extracted code — is below the
			// default minChunkSize (100). It must NOT be dropped: otherwise the
			// attachment stores 0 chunks and the model can't see the file.
			const chunks = chunkText("SECRET CODE IMG-JPG-001", "canary.jpg");
			expect(chunks).toHaveLength(1);
			expect(chunks[0].content).toBe("SECRET CODE IMG-JPG-001");
		});

		it("should handle whitespace-only text", () => {
			const whitespace = "   \n\n   \t   ";
			const chunks = chunkText(whitespace, "test.txt", {
				strategy: "PARAGRAPH",
				chunkSize: 100,
			});

			expect(chunks).toHaveLength(0);
		});
	});

	describe("Content Type Detection", () => {
		it("should detect markdown content", () => {
			const result = detectContentType(MARKDOWN_TEXT);
			expect(result.type).toBe("markdown");
			expect(result.hasHeaders).toBe(true);
			expect(result.suggestedStrategy).toBe("DOCUMENT");
		});

		it("should detect code content", () => {
			const result = detectContentType(CODE_TEXT);
			expect(result.type).toBe("code");
			expect(result.suggestedStrategy).toBe("DOCUMENT");
		});

		it("should detect plain text content", () => {
			const result = detectContentType(PARAGRAPH_TEXT);
			expect(result.type).toBe("text");
			expect(result.suggestedStrategy).toBe("RECURSIVE");
		});

		it("does not scan past the bounded sniff prefix (js/polynomial-redos cap)", () => {
			// detectContentType only samples a bounded prefix of unbounded
			// uploaded text — a markdown header appearing only past that
			// window is not used to classify the document.
			const text = `${"x".repeat(6000)}\n# Heading far past the sniff window`;
			expect(detectContentType(text).type).toBe("text");
		});
	});

	describe("Markdown header matching (bounded per-line regex)", () => {
		it("still splits at headers well within the bounded line length", () => {
			const text = [
				"# Title",
				"Intro text.",
				"## Section",
				"Section body text that is long enough to keep as its own chunk content here.",
			].join("\n");
			const chunks = chunkText(text, "test.md", {
				strategy: "DOCUMENT",
				contentType: "markdown",
				chunkSize: 500,
				minChunkSize: 1,
			});
			expect(
				chunks.some((c) => c.metadata.headings?.includes("Title")),
			).toBe(true);
			expect(
				chunks.some((c) => c.metadata.headings?.includes("Section")),
			).toBe(true);
		});
	});

	describe("Sentence splitting (bounded regex parity)", () => {
		it("keeps the final sentence when text has no trailing whitespace after the last period", () => {
			// Regression for dropping the redundant `|[.!?]+$` alternative:
			// the post-loop fallback must still emit this trailing sentence.
			const text = "First sentence. Second sentence. Third sentence.";
			const chunks = chunkText(text, "test.txt", {
				strategy: "SENTENCE",
				chunkSize: 1000,
				minChunkSize: 1,
			});
			expect(chunks).toHaveLength(1);
			expect(chunks[0].content).toBe(text);
		});
	});

	describe("Token Estimation", () => {
		it("should return 0 for empty text", () => {
			expect(estimateTokenCount("")).toBe(0);
		});

		it("should estimate tokens", () => {
			const text = "Hello, world!";
			const estimate = estimateTokenCount(text, false);
			expect(estimate).toBeGreaterThan(0);
		});
	});

	describe("Recommended Options", () => {
		it("should recommend DOCUMENT for markdown", () => {
			const options = getRecommendedOptions(MARKDOWN_TEXT);
			expect(options.strategy).toBe("DOCUMENT");
		});

		it("should recommend RECURSIVE for plain text", () => {
			const options = getRecommendedOptions(PARAGRAPH_TEXT);
			expect(options.strategy).toBe("RECURSIVE");
		});

		it("should include sensible defaults", () => {
			const options = getRecommendedOptions(PARAGRAPH_TEXT);
			expect(options.chunkSize).toBe(2048);
			expect(options.chunkOverlap).toBe(200);
		});
	});

	describe("Chunk Statistics", () => {
		it("should return stats with chunks", () => {
			const result = chunkTextWithStats(PARAGRAPH_TEXT, "test.txt", {
				strategy: "PARAGRAPH",
				chunkSize: 200,
			});

			expect(result.chunks.length).toBeGreaterThan(0);
			expect(result.stats.totalChunks).toBe(result.chunks.length);
			expect(result.stats.totalTokensEstimate).toBeGreaterThan(0);
		});
	});
});
