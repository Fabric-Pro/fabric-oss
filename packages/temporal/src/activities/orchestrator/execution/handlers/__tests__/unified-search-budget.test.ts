import type { ProjectSearchResponse } from "@repo/rag/lib/unified-search/types";
import { expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ search: vi.fn() }));
vi.mock("@repo/rag", async () => ({
	projectSearch: h.search,
	...(await import("@repo/rag/lib/unified-search/format")),
}));
vi.mock("@repo/connectors", () => ({ searchAllFederated: vi.fn() }));
vi.mock("@repo/database", () => ({
	getDataConnections: vi.fn(async () => []),
}));
vi.mock("@repo/integrations/github", () => ({ getGitHubAccessToken: vi.fn() }));

import { UnifiedSearchHandler } from "../unified-search-handler";

it("returns bounded prompt text with unchanged selected-source metadata", async () => {
	const search: ProjectSearchResponse = {
		results: Array.from({ length: 10 }, (_, i) => ({
			id: `example-source-${i}`,
			content: "Whole body".repeat(10000),
			matchedPassages: [
				{
					content: `MATCH-${i} ${"relevant detail\n".repeat(10000)}`,
					score: 0.9 - i / 100,
				},
			],
			source: {
				type: "project-context",
				name: `Example ${i}`,
				badge: "Project",
			},
			relevance: 0.9 - i / 100,
		})),
		sourceCounts: {
			"project-context": 10,
			workspace: 0,
			connector: 0,
			artifact: 0,
			web: 0,
			code: 0,
		},
		sourcesSearched: ["project-context"],
		searchTimeMs: 12,
	};
	h.search.mockResolvedValue(search);
	const result = await new UnifiedSearchHandler().execute({
		input: {
			userId: "example-user",
			organizationId: "example-org",
			projectId: "example-project",
			message: "example",
			systemPrompt: "",
			variables: {},
			executionMode: "iterative",
			totalSteps: 1,
			stepIndex: 1,
			previousStepResults: [],
			step: {
				id: "example-step",
				app: "unified_search",
				description: "Search example knowledge",
				type: "api",
				status: "in_progress",
				order: 1,
				inputs: { query: "example" },
			},
		},
		variables: {},
		toolCalls: [],
		startTime: Date.now(),
	});
	expect(result.handled).toBe(true);
	const output = result.output;
	if (!output) {
		throw new Error("Expected successful handler output");
	}
	expect(output.response?.length).toBeLessThanOrEqual(10000);
	expect(JSON.stringify(output.response).length).toBeLessThanOrEqual(10000);
	expect(output.outputs?.response).toBe(output.response);
	expect(output.response).not.toContain("Whole body");
	expect(output.toolCalls?.[0].result).toEqual({
		totalResults: 10,
		sourceCounts: search.sourceCounts,
		searchTimeMs: 12,
		sources: search.results.map((r) => ({
			name: r.source.name,
			type: r.source.type,
			badge: r.source.badge,
			relevance: Math.round(r.relevance * 100) / 100,
		})),
	});
	for (let i = 0; i < 10; i++) {
		expect(output.response).toContain(`Example ${i}`);
		expect(output.response).toContain(`MATCH-${i}`);
	}
});
