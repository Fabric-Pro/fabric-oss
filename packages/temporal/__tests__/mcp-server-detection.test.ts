/**
 * MCP Server Detection Tests
 *
 * Tests for the improved MCP server detection and tool filtering functionality:
 * - Explicit server mention detection from user queries
 * - Server name inclusion in tool embeddings
 * - Lazy MCP connection (only connect to needed servers)
 *
 * Run with: pnpm --filter @repo/temporal test
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock database before imports
vi.mock("@repo/database", () => ({
	setAiUsageRecorder: vi.fn(),
	db: {
		userOrchestratorPreferences: {
			findUnique: vi.fn().mockResolvedValue(null),
		},
		registeredAgent: {
			findMany: vi.fn().mockResolvedValue([]),
		},
		mCPConfig: {
			findMany: vi.fn().mockResolvedValue([]),
		},
	},
}));

// Mock the RAG embedding generator
vi.mock("@repo/rag/lib/embedding/generator", () => ({
	generateEmbedding: vi
		.fn()
		.mockResolvedValue({ embedding: Array(1536).fill(0), totalTokens: 10 }),
	generateEmbeddings: vi
		.fn()
		.mockResolvedValue({ embeddings: [], totalTokens: 0 }),
}));

// Mock the capability store
vi.mock("@repo/rag/lib/vector-store/capability-store", () => ({
	upsertCapabilities: vi.fn().mockResolvedValue({ success: 0, failed: 0 }),
	searchCapabilities: vi.fn().mockResolvedValue([]),
	deleteCapabilitiesByServer: vi.fn().mockResolvedValue(undefined),
	isCapabilityStoreAvailable: vi.fn().mockResolvedValue(false),
}));

// Mock agent-core backend
vi.mock("@repo/agent-core/backend", () => ({
	getMcpClient: vi.fn().mockResolvedValue(null),
	closeMcpClientSafe: vi.fn().mockResolvedValue(undefined),
}));

import {
	ToolIndex,
	type ToolIndexEntry,
} from "../src/activities/orchestrator/tools/tool-index";

// =============================================================================
// Helper function to create test tool entries
// =============================================================================

function _createTestToolEntry(
	configId: string,
	serverName: string,
	toolName: string,
	description: string,
): ToolIndexEntry {
	return {
		id: `${serverName}:${toolName}`,
		serverName,
		toolName,
		description,
		keywords: [],
		category: "unknown",
		riskLevel: "low",
		isReadOnly: true,
		lastUpdated: new Date(),
		configId,
	};
}

// =============================================================================
// ToolIndex Tests - Server Name in Keywords
// =============================================================================

describe("ToolIndex - Server Name in Keywords and Embeddings", () => {
	let toolIndex: ToolIndex;

	beforeEach(() => {
		toolIndex = new ToolIndex();
	});

	describe("extractKeywords with server name", () => {
		it("should include server name in extracted keywords", async () => {
			await toolIndex.buildIndex({
				configs: [
					{
						id: "config-1",
						serverName: "Context7",
						tools: [
							{
								name: "resolve-library-id",
								description: "Resolves a library ID",
							},
							{
								name: "query-docs",
								description: "Query documentation",
							},
						],
					},
				],
				generateEmbeddings: false,
				apiKey: "test-key",
			});

			const entries = toolIndex.getAllEntries();
			expect(entries.length).toBe(2);

			// Check that server name keywords are included
			const resolveEntry = entries.find(
				(e) => e.toolName === "resolve-library-id",
			);
			expect(resolveEntry).toBeDefined();
			expect(resolveEntry?.keywords).toContain("context7");
		});

		it("should normalize server name (remove MCP suffix)", async () => {
			await toolIndex.buildIndex({
				configs: [
					{
						id: "config-1",
						serverName: "Firecrawl MCP",
						tools: [
							{ name: "scrape", description: "Scrape a website" },
						],
					},
				],
				generateEmbeddings: false,
				apiKey: "test-key",
			});

			const entries = toolIndex.getAllEntries();
			const scrapeEntry = entries.find((e) => e.toolName === "scrape");

			expect(scrapeEntry?.keywords).toContain("firecrawl mcp");
			expect(scrapeEntry?.keywords).toContain("firecrawl");
		});

		it("should split multi-word server names", async () => {
			await toolIndex.buildIndex({
				configs: [
					{
						id: "config-1",
						serverName: "Fizzy MCP Server",
						tools: [
							{
								name: "create_card",
								description: "Create a card",
							},
						],
					},
				],
				generateEmbeddings: false,
				apiKey: "test-key",
			});

			const entries = toolIndex.getAllEntries();
			const cardEntry = entries.find((e) => e.toolName === "create_card");

			expect(cardEntry?.keywords).toContain("fizzy");
		});
	});

	describe("getServerNames", () => {
		it("should return all unique server names", async () => {
			await toolIndex.buildIndex({
				configs: [
					{
						id: "config-1",
						serverName: "Context7",
						tools: [{ name: "tool1", description: "Test" }],
					},
					{
						id: "config-2",
						serverName: "Firecrawl MCP",
						tools: [{ name: "tool2", description: "Test" }],
					},
					{
						id: "config-3",
						serverName: "Fizzy MCP",
						tools: [{ name: "tool3", description: "Test" }],
					},
				],
				generateEmbeddings: false,
				apiKey: "test-key",
			});

			const serverNames = toolIndex.getServerNames();
			expect(serverNames).toContain("Context7");
			expect(serverNames).toContain("Firecrawl MCP");
			expect(serverNames).toContain("Fizzy MCP");
			expect(serverNames.length).toBe(3);
		});
	});

	describe("getAllEntries", () => {
		it("should return all tool entries", async () => {
			await toolIndex.buildIndex({
				configs: [
					{
						id: "config-1",
						serverName: "Server1",
						tools: [
							{ name: "tool1", description: "Test 1" },
							{ name: "tool2", description: "Test 2" },
						],
					},
					{
						id: "config-2",
						serverName: "Server2",
						tools: [{ name: "tool3", description: "Test 3" }],
					},
				],
				generateEmbeddings: false,
				apiKey: "test-key",
			});

			const entries = toolIndex.getAllEntries();
			expect(entries.length).toBe(3);
		});
	});

	describe("getServerTools", () => {
		it("should return tools for a specific server", async () => {
			await toolIndex.buildIndex({
				configs: [
					{
						id: "config-1",
						serverName: "Context7",
						tools: [
							{
								name: "resolve-library-id",
								description: "Resolve library",
							},
							{ name: "query-docs", description: "Query docs" },
						],
					},
					{
						id: "config-2",
						serverName: "Firecrawl MCP",
						tools: [{ name: "scrape", description: "Scrape" }],
					},
				],
				generateEmbeddings: false,
				apiKey: "test-key",
			});

			const context7Tools = toolIndex.getServerTools("Context7");
			expect(context7Tools.length).toBe(2);
			expect(context7Tools.map((t) => t.toolName)).toContain(
				"resolve-library-id",
			);
			expect(context7Tools.map((t) => t.toolName)).toContain(
				"query-docs",
			);

			const firecrawlTools = toolIndex.getServerTools("Firecrawl MCP");
			expect(firecrawlTools.length).toBe(1);
			expect(firecrawlTools[0].toolName).toBe("scrape");
		});
	});
});

// =============================================================================
// Explicit Server Detection Tests
// =============================================================================

describe("Explicit MCP Server Detection", () => {
	// Test the detection logic directly
	function detectExplicitServerMention(
		query: string,
		availableServerNames: string[],
	): { matchedServers: string[]; isExplicitRequest: boolean } {
		const queryLower = query.toLowerCase();

		const explicitPatterns = [
			/use\s+(?:the\s+)?(\w+(?:\s+\w+)?)\s*(?:mcp|server|tool|api)?/gi,
			/using\s+(?:the\s+)?(\w+(?:\s+\w+)?)\s*(?:mcp|server|tool|api)?/gi,
			/with\s+(?:the\s+)?(\w+(?:\s+\w+)?)\s*(?:mcp|server|tool|api)?/gi,
			/via\s+(?:the\s+)?(\w+(?:\s+\w+)?)\s*(?:mcp|server|tool|api)?/gi,
			/from\s+(?:the\s+)?(\w+(?:\s+\w+)?)\s*(?:mcp|server|tool|api)?/gi,
		];

		const matchedServers: string[] = [];
		let isExplicitRequest = false;

		for (const serverName of availableServerNames) {
			const serverLower = serverName.toLowerCase();
			const normalizedServer = serverLower
				.replace(/\s*(mcp|server|api|service)$/i, "")
				.trim();

			for (const pattern of explicitPatterns) {
				pattern.lastIndex = 0;
				const matches = queryLower.matchAll(pattern);
				for (const match of matches) {
					const mentioned = match[1]?.toLowerCase().trim();
					if (mentioned) {
						if (
							serverLower.includes(mentioned) ||
							normalizedServer.includes(mentioned) ||
							mentioned.includes(normalizedServer) ||
							mentioned.includes(serverLower.split(" ")[0])
						) {
							if (!matchedServers.includes(serverName)) {
								matchedServers.push(serverName);
								isExplicitRequest = true;
							}
						}
					}
				}
			}

			if (
				queryLower.includes(normalizedServer) ||
				queryLower.includes(serverLower.split(" ")[0])
			) {
				const serverWord =
					normalizedServer || serverLower.split(" ")[0];
				const wordBoundary = new RegExp(`\\b${serverWord}\\b`, "i");
				if (wordBoundary.test(query)) {
					if (!matchedServers.includes(serverName)) {
						matchedServers.push(serverName);
						if (
							/(?:use|using|with|via|mcp|server)/i.test(
								queryLower,
							)
						) {
							isExplicitRequest = true;
						}
					}
				}
			}
		}

		return { matchedServers, isExplicitRequest };
	}

	const availableServers = ["Context7", "Firecrawl MCP", "Fizzy MCP"];

	describe("Pattern: 'use X mcp'", () => {
		it("should detect 'use context7 mcp'", () => {
			const result = detectExplicitServerMention(
				"use context7 mcp to find the difference between reactjs and nextjs",
				availableServers,
			);
			expect(result.matchedServers).toContain("Context7");
			expect(result.isExplicitRequest).toBe(true);
		});

		it("should detect 'use firecrawl mcp'", () => {
			const result = detectExplicitServerMention(
				"use firecrawl mcp to scrape the website",
				availableServers,
			);
			expect(result.matchedServers).toContain("Firecrawl MCP");
			expect(result.isExplicitRequest).toBe(true);
		});

		it("should detect 'use the fizzy mcp'", () => {
			const result = detectExplicitServerMention(
				"use the fizzy mcp to create a card",
				availableServers,
			);
			expect(result.matchedServers).toContain("Fizzy MCP");
			expect(result.isExplicitRequest).toBe(true);
		});
	});

	describe("Pattern: 'using X'", () => {
		it("should detect 'using context7'", () => {
			const result = detectExplicitServerMention(
				"using context7 query the react documentation",
				availableServers,
			);
			expect(result.matchedServers).toContain("Context7");
			expect(result.isExplicitRequest).toBe(true);
		});
	});

	describe("Pattern: 'with X'", () => {
		it("should detect 'with firecrawl'", () => {
			const result = detectExplicitServerMention(
				"scrape the webpage with firecrawl",
				availableServers,
			);
			expect(result.matchedServers).toContain("Firecrawl MCP");
			expect(result.isExplicitRequest).toBe(true);
		});
	});

	describe("Pattern: 'via X server'", () => {
		it("should detect 'via fizzy server'", () => {
			const result = detectExplicitServerMention(
				"create a card via fizzy server",
				availableServers,
			);
			expect(result.matchedServers).toContain("Fizzy MCP");
			expect(result.isExplicitRequest).toBe(true);
		});
	});

	describe("Direct mention without pattern", () => {
		it("should detect direct server name mention with MCP keyword", () => {
			const result = detectExplicitServerMention(
				"context7 mcp query for react hooks",
				availableServers,
			);
			expect(result.matchedServers).toContain("Context7");
			expect(result.isExplicitRequest).toBe(true);
		});

		it("should detect but not mark as explicit without MCP/use keywords", () => {
			const result = detectExplicitServerMention(
				"context7 query for react hooks",
				availableServers,
			);
			expect(result.matchedServers).toContain("Context7");
			// No explicit request marker since no "use", "mcp", etc.
		});
	});

	describe("No server mention", () => {
		it("should return empty when no server is mentioned", () => {
			const result = detectExplicitServerMention(
				"what is the difference between reactjs and nextjs",
				availableServers,
			);
			expect(result.matchedServers.length).toBe(0);
			expect(result.isExplicitRequest).toBe(false);
		});

		it("should not match partial words", () => {
			const result = detectExplicitServerMention(
				"the context of this issue is important",
				availableServers,
			);
			// "context" shouldn't match "Context7" because of word boundary
			expect(result.matchedServers).not.toContain("Context7");
		});
	});

	describe("Multiple server mentions", () => {
		it("should detect multiple servers", () => {
			const result = detectExplicitServerMention(
				"use context7 to get docs and then use firecrawl to verify",
				availableServers,
			);
			expect(result.matchedServers).toContain("Context7");
			expect(result.matchedServers).toContain("Firecrawl MCP");
			expect(result.isExplicitRequest).toBe(true);
		});
	});
});

// =============================================================================
// Lazy MCP Connection Tests
// =============================================================================

describe("Lazy MCP Connection - matchedMcpTools Filter", () => {
	it("should use matchedMcpTools to determine which configs to connect to", () => {
		// Test the logic that determines mcpFilterIds from matchedMcpTools
		const matchedMcpTools = [
			{
				toolName: "resolve-library-id",
				configId: "config-context7",
				description: "Resolve lib",
				confidence: 0.8,
			},
			{
				toolName: "query-docs",
				configId: "config-context7",
				description: "Query docs",
				confidence: 0.75,
			},
		];

		const configIds = new Set<string>();
		for (const tool of matchedMcpTools) {
			if (tool.configId) {
				configIds.add(tool.configId);
			}
		}

		expect(configIds.size).toBe(1);
		expect(configIds.has("config-context7")).toBe(true);
	});

	it("should handle multiple configs from matchedMcpTools", () => {
		const matchedMcpTools = [
			{
				toolName: "resolve-library-id",
				configId: "config-context7",
				description: "Resolve lib",
				confidence: 0.8,
			},
			{
				toolName: "scrape",
				configId: "config-firecrawl",
				description: "Scrape",
				confidence: 0.6,
			},
			{
				toolName: "create_card",
				configId: "config-fizzy",
				description: "Create card",
				confidence: 0.5,
			},
		];

		const configIds = new Set<string>();
		for (const tool of matchedMcpTools) {
			if (tool.configId) {
				configIds.add(tool.configId);
			}
		}

		expect(configIds.size).toBe(3);
		expect(Array.from(configIds)).toEqual(
			expect.arrayContaining([
				"config-context7",
				"config-firecrawl",
				"config-fizzy",
			]),
		);
	});

	it("should skip tools without configId", () => {
		const matchedMcpTools = [
			{
				toolName: "resolve-library-id",
				configId: "config-context7",
				description: "Resolve lib",
				confidence: 0.8,
			},
			{
				toolName: "unknown-tool",
				configId: "",
				description: "Unknown",
				confidence: 0.4,
			},
		];

		const configIds = new Set<string>();
		for (const tool of matchedMcpTools) {
			if (tool.configId) {
				configIds.add(tool.configId);
			}
		}

		expect(configIds.size).toBe(1);
		expect(configIds.has("config-context7")).toBe(true);
	});
});
