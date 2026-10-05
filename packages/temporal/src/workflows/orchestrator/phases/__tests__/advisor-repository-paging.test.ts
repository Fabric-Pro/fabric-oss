/**
 * A large `code_tree` listing, end to end through the path the Advisor takes:
 * the loop dispatches the discovered tool, `executeMcpTool` hands it to the
 * real Fabric catalog adapter, which runs the real code-search handler over a
 * mocked connector. The page must fit the loop's result cap, so the
 * summarizer never sees a listing and the range line with the next offset
 * reaches the model intact.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const activities = new Map<string, ReturnType<typeof vi.fn>>();
	const stub = (name: string) => {
		let fn = activities.get(name);
		if (!fn) {
			fn = vi.fn();
			activities.set(name, fn);
		}
		return fn;
	};
	return {
		stub,
		resetAll: () => {
			for (const fn of activities.values()) {
				fn.mockReset();
			}
		},
		off: new Set<string>(),
		listRepositoryStructure: vi.fn(),
	};
});

vi.mock("@temporalio/workflow", () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
	patched: vi.fn((id: string) => !mocks.off.has(id)),
	proxyActivities: vi.fn(
		() =>
			new Proxy({}, { get: (_target, name) => mocks.stub(String(name)) }),
	),
	workflowInfo: vi.fn(() => ({
		runId: "test-run-id",
		unsafe: { isReplaying: false },
	})),
	startChild: vi.fn(),
	ParentClosePolicy: { ABANDON: "ABANDON" },
}));

// The handler's own dependencies: one GitHub repository, no code index.
vi.mock("@repo/database", () => ({
	db: { project: { findUnique: vi.fn() } },
	getProjectCodeIndexes: vi.fn().mockResolvedValue([]),
	getProjectReposForCodeSearch: vi.fn().mockResolvedValue([
		{
			provider: "GITHUB",
			owner: "example-org",
			repo: "app",
			branch: "main",
		},
	]),
	parseRepoUrl: vi.fn(),
}));
vi.mock("@repo/utils", () => ({ decryptApiKey: vi.fn() }));
vi.mock("@repo/integrations/repo-auth", () => ({
	resolveFreshRepoTokenForRow: vi
		.fn()
		.mockResolvedValue({ token: "token-example", method: "pat" }),
}));
vi.mock("@repo/integrations/github", () => ({
	getGitHubAccessToken: vi.fn(),
}));
vi.mock("@repo/connectors", () => ({
	searchRepositoryCode: vi.fn().mockResolvedValue({ results: [] }),
	getRepositoryFile: vi.fn(),
	listRepositoryStructure: mocks.listRepositoryStructure,
}));

import { runFabricCatalogTool } from "../../../../activities/orchestrator/execution/fabric-catalog-adapter";
import { getFabricAiTools } from "../../../../activities/orchestrator/tools/fabric-ai-tools";
import { TOOL_RESULTS } from "../../orchestrator-config";
import {
	installDefaultStubs,
	runTurn,
	toolMessage,
} from "./advisor-scenario-harness";

const LONG_PATHS = Array.from(
	{ length: 500 },
	(_, i) =>
		`packages/example-feature-area/src/components/deeply/nested/module-${String(i).padStart(4, "0")}/index.tsx`,
);

beforeEach(() => {
	installDefaultStubs(mocks);
	mocks.listRepositoryStructure.mockReset().mockResolvedValue({
		entries: LONG_PATHS.map((path) => ({ path, type: "file" })),
		totalFiles: LONG_PATHS.length,
		totalDirectories: 0,
		truncated: false,
	});
	const codeTree = getFabricAiTools().find((t) => t.name === "code_tree");
	mocks.stub("searchAvailableTools").mockResolvedValue({
		results: [
			{
				toolId: "Fabric AI:code_tree",
				serverName: "Fabric AI",
				toolName: "code_tree",
				description: codeTree?.description ?? "",
				confidence: 0.9,
				matchReason: "keyword: directory tree",
				category: "development",
				riskLevel: "low",
				isReadOnly: true,
				configId: "fabric-ai-server",
				inputSchema: codeTree?.inputSchema,
			},
		],
		totalToolsSearched: 1,
		semanticSearchUsed: false,
		durationMs: 1,
	});
	// What executeMcpTool does for a Fabric catalog tool (execute-mcp-tool.ts
	// `executeFabricCatalogTool`): run the adapter, map a failure to { error }.
	mocks
		.stub("executeMcpTool")
		.mockImplementation(
			async (req: {
				toolName: string;
				args: Record<string, unknown>;
				userId: string;
				organizationId?: string;
				projectId?: string;
				mcpConfigId?: string;
			}) => {
				expect(req.mcpConfigId).toBe("fabric-ai-server");
				const result = await runFabricCatalogTool(req);
				return {
					output: result.success
						? result.output
						: { error: result.error },
					success: result.success,
					durationMs: 1,
					cached: false,
				};
			},
		);
});

describe("fix 3: a large code_tree page through the adapter and the loop", () => {
	it("fits the cap, skips the summarizer and shows the range and next offset", async () => {
		const { seen } = await runTurn(mocks, {
			message: "List the files in example-org/app.",
			steps: [
				{
					calls: [
						{
							name: "search_tools",
							args: { query: "directory tree" },
						},
					],
				},
				{ calls: [{ name: "code_tree", args: {} }] },
				{ answer: "Listed the first page." },
			],
		});

		expect(mocks.stub("summarizeLargeToolResult")).not.toHaveBeenCalled();
		const shown = toolMessage(seen, 2, "call-2-0");
		expect(shown.length).toBeLessThanOrEqual(TOOL_RESULTS.maxChars);
		const range = shown.match(/Showing entries 1–(\d+) of 500/);
		expect(range).not.toBeNull();
		expect(shown).toContain(`offset=${range?.[1]}`);
	});
});
