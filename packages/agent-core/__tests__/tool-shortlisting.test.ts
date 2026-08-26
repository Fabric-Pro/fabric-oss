/**
 * Unit tests for Tool Shortlisting
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
	DEFAULT_SHORTLIST_CONFIG,
	type TaskContext,
	type ToolInfo,
	ToolShortlister,
} from "../src/tool-shortlisting";

describe("ToolShortlister", () => {
	let shortlister: ToolShortlister;

	const sampleTools: ToolInfo[] = [
		{
			name: "create_document",
			description: "Create a new document with specified content",
			category: "documents",
			keywords: ["create", "document", "write", "new"],
		},
		{
			name: "send_email",
			description: "Send an email to specified recipients",
			category: "communication",
			keywords: ["email", "send", "message", "notify"],
		},
		{
			name: "search_database",
			description: "Search the database for records matching criteria",
			category: "data",
			keywords: ["search", "query", "find", "database", "records"],
		},
		{
			name: "generate_report",
			description: "Generate a report from data analysis",
			category: "documents",
			keywords: ["report", "generate", "analysis", "data"],
		},
		{
			name: "schedule_meeting",
			description: "Schedule a meeting with participants",
			category: "calendar",
			keywords: ["meeting", "schedule", "calendar", "invite"],
		},
	];

	beforeEach(() => {
		shortlister = new ToolShortlister();
		shortlister.registerTools(sampleTools);
	});

	describe("registerTools", () => {
		it("should register tools", () => {
			const result = shortlister.shortlist({ task: "test" });
			expect(result.totalToolsConsidered).toBe(5);
		});

		it("should clear cache when tools change", () => {
			shortlister.shortlist({ task: "create a document" });
			expect(shortlister.getCacheStats().size).toBe(1);

			shortlister.registerTools([]);
			expect(shortlister.getCacheStats().size).toBe(0);
		});
	});

	describe("shortlist", () => {
		it("should rank tools by relevance", () => {
			const result = shortlister.shortlist({
				task: "I need to create a new document",
			});

			expect(result.tools.length).toBeGreaterThan(0);
			expect(result.tools[0].tool.name).toBe("create_document");
		});

		it("should match keywords", () => {
			const result = shortlister.shortlist({
				task: "send an email notification",
			});

			const emailTool = result.tools.find(
				(t) => t.tool.name === "send_email",
			);
			expect(emailTool).toBeDefined();
			expect(emailTool?.matchedKeywords).toContain("email");
		});

		it("should match category", () => {
			const result = shortlister.shortlist({
				task: "work with documents",
				category: "documents",
			});

			const docTools = result.tools.filter(
				(t) => t.tool.category === "documents",
			);
			expect(docTools.length).toBeGreaterThan(0);
		});

		it("should filter by minimum score", () => {
			const strictShortlister = new ToolShortlister({ minScore: 0.5 });
			strictShortlister.registerTools(sampleTools);

			const result = strictShortlister.shortlist({
				task: "random unrelated task xyz",
			});

			result.tools.forEach((tool) => {
				expect(tool.score).toBeGreaterThanOrEqual(0.5);
			});
		});

		it("should limit results to maxTools", () => {
			const limitedShortlister = new ToolShortlister({ maxTools: 2 });
			limitedShortlister.registerTools(sampleTools);

			const result = limitedShortlister.shortlist({
				task: "create document send email search database",
			});

			expect(result.tools.length).toBeLessThanOrEqual(2);
		});

		it("should return execution time", () => {
			const result = shortlister.shortlist({ task: "test" });
			expect(result.executionTime).toBeGreaterThanOrEqual(0);
		});
	});

	describe("caching", () => {
		it("should cache results", () => {
			const context: TaskContext = { task: "create a document" };

			const result1 = shortlister.shortlist(context);
			expect(result1.cacheHit).toBe(false);

			const result2 = shortlister.shortlist(context);
			expect(result2.cacheHit).toBe(true);
		});

		it("should not cache when disabled", () => {
			const noCacheShortlister = new ToolShortlister({
				enableCache: false,
			});
			noCacheShortlister.registerTools(sampleTools);

			const context: TaskContext = { task: "create a document" };

			noCacheShortlister.shortlist(context);
			const result = noCacheShortlister.shortlist(context);

			expect(result.cacheHit).toBe(false);
		});

		it("should clear cache", () => {
			shortlister.shortlist({ task: "test" });
			expect(shortlister.getCacheStats().size).toBe(1);

			shortlister.clearCache();
			expect(shortlister.getCacheStats().size).toBe(0);
		});
	});

	describe("DEFAULT_SHORTLIST_CONFIG", () => {
		it("should have sensible defaults", () => {
			expect(DEFAULT_SHORTLIST_CONFIG.maxTools).toBe(10);
			expect(DEFAULT_SHORTLIST_CONFIG.minScore).toBe(0.1);
			expect(DEFAULT_SHORTLIST_CONFIG.enableCache).toBe(true);
		});
	});
});
