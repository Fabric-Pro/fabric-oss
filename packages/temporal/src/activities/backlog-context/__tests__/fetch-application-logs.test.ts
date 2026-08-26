/**
 * Unit tests for the application-log MCP adapter (Fizzy #1234).
 *
 * Two things are worth proving here and neither needs a log platform:
 *   1. `parseLogToolResult` copes with the several shapes an MCP server can
 *      return, and treats anything unrecognised as "no logs" rather than
 *      throwing — an adapter that crashes would take the analysis down with it.
 *   2. With the feature flag OFF the activity contacts nothing at all. That is
 *      the rollback guarantee the card depends on, since production rollout is
 *      gated on a feasibility review that has not happened.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/utils/feature-flag", async (orig) => {
	const actual = await orig<Record<string, unknown>>();
	return { ...actual, isBugAnalysisLogContextEnabled: vi.fn() };
});
vi.mock("@repo/database", async (orig) => {
	const actual = await orig<Record<string, unknown>>();
	return {
		...actual,
		getProjectMemberRole: vi.fn(),
		getProjectLogSourceBinding: vi.fn(),
		listMcpConfigsForTenant: vi.fn(),
	};
});
vi.mock("@repo/mcp", () => ({ getCachedMcpClientForConfig: vi.fn() }));

import {
	getProjectLogSourceBinding,
	getProjectMemberRole,
	listMcpConfigsForTenant,
} from "@repo/database";
import { getCachedMcpClientForConfig } from "@repo/mcp";
import { isBugAnalysisLogContextEnabled } from "@repo/utils/feature-flag";
import {
	fetchApplicationLogsForBacklog,
	parseLogToolResult,
} from "../fetch-application-logs";

const flag = vi.mocked(isBugAnalysisLogContextEnabled);
const role = vi.mocked(getProjectMemberRole);
const listConfigs = vi.mocked(listMcpConfigsForTenant);
const binding = vi.mocked(getProjectLogSourceBinding);
const mcpClient = vi.mocked(getCachedMcpClientForConfig);

beforeEach(() => {
	vi.clearAllMocks();
	flag.mockReturnValue(true);
	// Reading logs requires PROJECT_SETTINGS_EDIT, which PROJECT_ADMIN holds.
	role.mockResolvedValue("PROJECT_ADMIN" as never);
	listConfigs.mockResolvedValue([]);
	// No per-project binding by default; the deployment default applies.
	binding.mockResolvedValue(null);
});

describe("parseLogToolResult", () => {
	it("reads an array of log rows", () => {
		expect(
			parseLogToolResult([
				{ timestamp: "t1", severity: "error", message: "boom" },
				{ message: "second" },
			]),
		).toEqual([
			{
				message: "boom",
				timestamp: "t1",
				severity: "error",
				properties: undefined,
			},
			{
				message: "second",
				timestamp: undefined,
				severity: undefined,
				properties: undefined,
			},
		]);
	});

	it("reads the MCP text-content envelope carrying JSON", () => {
		const parsed = parseLogToolResult([
			{
				type: "text",
				text: JSON.stringify([{ message: "from envelope" }]),
			},
		]);
		expect(parsed).toHaveLength(1);
		expect(parsed[0]?.message).toBe("from envelope");
	});

	it("reads a wrapper object under any of the common keys", () => {
		for (const key of [
			"entries",
			"rows",
			"results",
			"logs",
			"items",
			"data",
		]) {
			const parsed = parseLogToolResult({
				[key]: [{ message: `via ${key}` }],
			});
			expect(parsed[0]?.message).toBe(`via ${key}`);
		}
	});

	it("falls back to line splitting for plain text", () => {
		expect(parseLogToolResult("line one\n\nline two")).toEqual([
			{ message: "line one" },
			{ message: "line two" },
		]);
	});

	it("accepts alternate field names used by log platforms", () => {
		const parsed = parseLogToolResult([
			{
				TimeGenerated: "t",
				SeverityLevel: "Error",
				RenderedMessage: "azure",
			},
		]);
		expect(parsed[0]).toMatchObject({
			message: "azure",
			timestamp: "t",
			severity: "Error",
		});
	});

	// Regression, found by running 1,500 real Application Insights rows from
	// Fabric's own dev workspace through the adapter: the field list matched
	// `message`/`RenderedMessage` but NOT `Message`, which is what App Insights
	// actually sends. Every real Azure row parsed to nothing, so the feature
	// would have reported "no logs" against the most likely platform, silently.
	it("parses a real Application Insights row shape", () => {
		const parsed = parseLogToolResult([
			{
				TimeGenerated: "2026-08-19T10:00:00Z",
				SeverityLevel: 3,
				Message: "[Orchestrator] work item batch failed",
				Properties: null,
			},
		]);
		expect(parsed).toHaveLength(1);
		expect(parsed[0]).toMatchObject({
			message: "[Orchestrator] work item batch failed",
			timestamp: "2026-08-19T10:00:00Z",
			// Azure sends a NUMBER here; dropping it lost the severity entirely.
			severity: "3",
		});
	});

	it.each([
		["lowercase", { message: "m", timestamp: "t", level: "error" }],
		["Azure", { Message: "m", TimeGenerated: "t", SeverityLevel: "error" }],
		["camelCase", { msg: "m", ts: "t", logLevel: "error" }],
	])("reads the %s field spelling", (_label, row) => {
		const parsed = parseLogToolResult([row]);
		expect(parsed[0]?.message).toBe("m");
		expect(parsed[0]?.severity).toBe("error");
	});

	it("reads customDimensions as the properties bag", () => {
		const parsed = parseLogToolResult([
			{ Message: "m", customDimensions: { requestId: "req-1" } },
		]);
		expect(parsed[0]?.properties).toEqual({ requestId: "req-1" });
	});

	it("treats unrecognised shapes as no logs rather than throwing", () => {
		expect(parseLogToolResult(null)).toEqual([]);
		expect(parseLogToolResult(42)).toEqual([]);
		expect(parseLogToolResult({ unexpected: true })).toEqual([]);
		expect(parseLogToolResult("")).toEqual([]);
		expect(parseLogToolResult([{ noMessageField: 1 }])).toEqual([]);
	});

	it("does not choke on text that only looks like JSON", () => {
		expect(parseLogToolResult("{not really json")).toEqual([
			{ message: "{not really json" },
		]);
	});
});

describe("fetchApplicationLogsForBacklog", () => {
	const input = {
		projectId: "proj-1",
		userId: "user-1",
		organizationId: "org-1",
		terms: ["checkout timeout"],
	};

	it("contacts nothing and returns an empty clause when the flag is off", async () => {
		flag.mockReturnValue(false);

		const out = await fetchApplicationLogsForBacklog(input);

		expect(out.clause).toBe("");
		expect(out.status).toBe("disabled");
		expect(listConfigs).not.toHaveBeenCalled();
		expect(mcpClient).not.toHaveBeenCalled();
		expect(role).not.toHaveBeenCalled();
	});

	it("reports not-configured when the tenant has no MCP configs", async () => {
		const out = await fetchApplicationLogsForBacklog(input);

		expect(out.status).toBe("not-configured");
		expect(out.clause).toBe("");
		expect(out.note).toMatch(/no log source is configured/i);
	});

	it("reports not-configured when no connected server exposes a log tool", async () => {
		listConfigs.mockResolvedValue([
			{
				id: "cfg-1",
				displayName: "Docs Server",
				mcpServer: { name: "Notion" },
			},
		] as never);
		mcpClient.mockResolvedValue({
			client: { tools: async () => ({ notion_retrieve_page: {} }) },
		} as never);

		const out = await fetchApplicationLogsForBacklog(input);

		expect(out.status).toBe("not-configured");
	});

	it("fetches, redacts and renders when a log tool is available", async () => {
		const execute = vi.fn().mockResolvedValue([
			{
				timestamp: "2026-08-19T10:00:00Z",
				severity: "error",
				message:
					"checkout failed for shopper@example.com token=abcd1234secret",
			},
		]);
		listConfigs.mockResolvedValue([
			{
				id: "cfg-1",
				displayName: "Ops Logs",
				mcpServer: { name: "Log MCP" },
			},
		] as never);
		mcpClient.mockResolvedValue({
			client: { tools: async () => ({ query_logs: { execute } }) },
		} as never);

		const out = await fetchApplicationLogsForBacklog(input);

		expect(out.status).toBe("included");
		expect(out.entryCount).toBe(1);
		expect(out.clause).toContain("checkout failed");
		expect(out.clause).not.toContain("shopper@example.com");
		expect(out.clause).not.toContain("abcd1234secret");
		expect(out.clause).toContain("Ops Logs");
		expect(execute).toHaveBeenCalledTimes(1);
	});

	it("degrades to a note instead of throwing when the log tool fails", async () => {
		listConfigs.mockResolvedValue([
			{
				id: "cfg-1",
				displayName: "Ops Logs",
				mcpServer: { name: "Log MCP" },
			},
		] as never);
		mcpClient.mockResolvedValue({
			client: {
				tools: async () => ({
					query_logs: {
						execute: vi
							.fn()
							.mockRejectedValue(new Error("platform down")),
					},
				}),
			},
		} as never);

		const out = await fetchApplicationLogsForBacklog(input);

		expect(out.status).toBe("unavailable");
		expect(out.clause).toBe("");
	});

	// Regression: the first probe list included `search_issues` (Sentry) and
	// `execute_query`. Both collide with servers that are NOT log platforms —
	// Jira and GitHub expose `search_issues`, any database server exposes
	// `execute_query` — so a tenant's connected Jira could have its ISSUES
	// pulled in and rendered to the model under an "Application Logs"
	// heading. Wrong evidence presented as runtime fact.
	it.each(["search_issues", "execute_query", "run_kql_query"])(
		"does not treat a server exposing only %s as a log source",
		async (toolName) => {
			listConfigs.mockResolvedValue([
				{
					id: "cfg-1",
					displayName: "Issue Tracker",
					mcpServer: { name: "Jira" },
				},
			] as never);
			mcpClient.mockResolvedValue({
				client: {
					tools: async () => ({
						[toolName]: { execute: vi.fn() },
					}),
				},
			} as never);

			const out = await fetchApplicationLogsForBacklog(input);

			expect(out.status).toBe("not-configured");
			expect(out.clause).toBe("");
		},
	);

	it("accepts an ambiguous tool name only when the operator opts in", async () => {
		const execute = vi.fn().mockResolvedValue([{ message: "kql row" }]);
		listConfigs.mockResolvedValue([
			{
				id: "cfg-1",
				displayName: "Azure Monitor",
				mcpServer: { name: "AM" },
			},
		] as never);
		mcpClient.mockResolvedValue({
			client: { tools: async () => ({ run_kql_query: { execute } }) },
		} as never);

		vi.stubEnv("FABRIC_BUG_ANALYSIS_LOG_TOOLS", "run_kql_query");
		try {
			const out = await fetchApplicationLogsForBacklog(input);
			expect(out.status).toBe("included");
			expect(out.clause).toContain("kql row");
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("still finds a log tool on a config beyond the first probe batch", async () => {
		// Discovery probes in bounded concurrent batches so one unreachable
		// server cannot burn the activity timeout. Batching must not stop the
		// sweep early: the only config with a log tool is deliberately placed
		// past the batch size.
		const execute = vi.fn().mockResolvedValue([{ message: "late find" }]);
		listConfigs.mockResolvedValue(
			Array.from({ length: 9 }, (_, i) => ({
				id: `cfg-${i}`,
				displayName: `Server ${i}`,
				mcpServer: { name: `S${i}` },
			})) as never,
		);
		mcpClient.mockImplementation((async ({
			configId,
		}: {
			configId: string;
		}) => ({
			client: {
				tools: async () =>
					configId === "cfg-8" ? { query_logs: { execute } } : {},
			},
		})) as never);

		const out = await fetchApplicationLogsForBacklog(input);

		expect(out.status).toBe("included");
		expect(out.clause).toContain("late find");
		expect(mcpClient).toHaveBeenCalledTimes(9);
	});

	it("skips a config whose client cannot be built and tries the next", async () => {
		const execute = vi.fn().mockResolvedValue([{ message: "found later" }]);
		listConfigs.mockResolvedValue([
			{ id: "broken", displayName: "Broken", mcpServer: { name: "X" } },
			{ id: "good", displayName: "Good", mcpServer: { name: "Y" } },
		] as never);
		mcpClient
			.mockRejectedValueOnce(new Error("oauth expired"))
			.mockResolvedValueOnce({
				client: { tools: async () => ({ query_logs: { execute } }) },
			} as never);

		const out = await fetchApplicationLogsForBacklog(input);

		expect(out.status).toBe("included");
		expect(out.clause).toContain("found later");
	});
});
