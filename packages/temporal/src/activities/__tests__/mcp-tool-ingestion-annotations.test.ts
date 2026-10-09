import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/ai", () => ({
	AIProviderNotConfiguredError: class extends Error {},
	getSystemEmbeddingRAGProviderConfig: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	getMcpConfigByIdInternal: vi.fn(),
	listMcpConfigsForTenant: vi.fn(),
	updateMcpConfigToolCache: vi.fn(),
}));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@repo/mcp", () => ({
	closeMcpClient: vi.fn(),
	createMcpClientForConfig: vi.fn(),
}));
vi.mock("@repo/rag/lib/embedding/generator", () => ({
	generateEmbeddings: vi.fn(),
}));
vi.mock("@repo/rag/lib/vector-store/capability-store", () => ({
	deleteCapabilitiesByServer: vi.fn(),
	upsertCapabilities: vi.fn(),
}));

import { cachedToolsFromServer } from "../mcp-tool-ingestion";

describe("the tool cache written by MCP ingestion", () => {
	it("keeps the server's own annotations, so a declared read-only tool stays read-only", () => {
		const [tool] = cachedToolsFromServer([
			[
				"list_issues",
				{
					description: "List issues",
					inputSchema: {
						jsonSchema: { type: "object", properties: {} },
					},
					metadata: {
						annotations: {
							readOnlyHint: true,
							destructiveHint: false,
							title: "not a hint",
						},
					},
				},
			],
		]);

		expect(tool).toEqual({
			name: "list_issues",
			description: "List issues",
			inputSchema: { type: "object", properties: {} },
			annotations: { readOnlyHint: true, destructiveHint: false },
		});
	});

	it("stores no annotations for a tool that declared none", () => {
		const [tool] = cachedToolsFromServer([
			["get_or_create_issue", { description: "Upsert", inputSchema: {} }],
		]);

		expect(tool?.annotations).toBeNull();
	});
});
