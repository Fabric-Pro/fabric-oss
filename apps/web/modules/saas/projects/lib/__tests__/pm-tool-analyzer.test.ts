/**
 * Tests for the client-side PM tool analyzer, focused on the Atlassian Rovo
 * (Jira + Confluence) MCP server — the case that exposed a chain of picker
 * bugs:
 *   1. container-type extraction drift dropped getVisibleJiraProjects
 *   2. Confluence `space` got chained ahead of the Jira `project`
 *   3. every container tool requires a `cloudId` the fetch never resolved
 *   4. getVisibleJiraProjects returns `{ values: [...] }`, not a bare array
 *   5. a Jira project must be identified by its `key`, not its numeric `id`
 *
 * Tool names/schemas below mirror the live Atlassian Rovo server.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
	analyzePMToolCapabilities,
	containerIdFieldHint,
	fetchContainersWithHierarchy,
	type McpTool,
} from "../pm-tool-analyzer";

const obj = (
	properties: Record<string, unknown>,
	required: string[] = [],
): McpTool["inputSchema"] => ({
	type: "object",
	properties: properties as McpTool["inputSchema"]["properties"],
	required,
});

const ROVO_TOOLS: McpTool[] = [
	{ name: "getAccessibleAtlassianResources", inputSchema: obj({}) },
	{
		name: "getConfluenceSpaces",
		inputSchema: obj({ cloudId: {}, limit: {} }, ["cloudId"]),
	},
	{
		name: "getPagesInConfluenceSpace",
		inputSchema: obj({ cloudId: {}, spaceId: {} }, ["cloudId", "spaceId"]),
	},
	{
		name: "getVisibleJiraProjects",
		inputSchema: obj({ cloudId: {}, maxResults: {} }, ["cloudId"]),
	},
	{
		name: "createJiraIssue",
		inputSchema: obj(
			{
				cloudId: {},
				projectKey: {},
				issueTypeName: {},
				summary: {},
				description: {},
			},
			["cloudId", "projectKey", "issueTypeName", "summary"],
		),
	},
	{
		name: "searchJiraIssuesUsingJql",
		inputSchema: obj({ cloudId: {}, jql: {} }),
	},
];

describe("analyzePMToolCapabilities — Atlassian Rovo", () => {
	const caps = analyzePMToolCapabilities(ROVO_TOOLS);

	it("detects PM capabilities (regression: was rejected as none)", () => {
		expect(caps.hasPMCapabilities).toBe(true);
		expect(caps.detectedType).toBe("jira");
	});

	it("collapses the hierarchy to the Jira project, dropping Confluence space", () => {
		expect(caps.containerHierarchy).toHaveLength(1);
		expect(caps.containerHierarchy[0].containerType).toBe("project");
		expect(caps.containerHierarchy[0].listToolName).toBe(
			"getVisibleJiraProjects",
		);
	});

	it("surfaces the cloudId resolver tool", () => {
		expect(caps.cloudIdResolverTool).toBe(
			"getAccessibleAtlassianResources",
		);
	});

	it("detects task creation with the projectKey container param", () => {
		expect(caps.taskCreation?.toolName).toBe("createJiraIssue");
		expect(caps.taskCreation?.containerParam).toBe("projectKey");
	});
});

describe("analyzePMToolCapabilities — Fizzy (multi-level chain preserved)", () => {
	// Fizzy: get_accounts (root) → get_boards (needs account_slug). The prune
	// must NOT drop the account level. account_slug is marked OPTIONAL here on
	// purpose — the account is a genuine parent because get_boards *accepts* it,
	// regardless of whether the schema flags it required.
	const FIZZY_TOOLS: McpTool[] = [
		{ name: "fizzy_get_accounts", inputSchema: obj({}) },
		{
			name: "fizzy_get_boards",
			inputSchema: obj({ account_slug: {} }, []),
		},
		{
			name: "fizzy_create_card",
			inputSchema: obj({ account_slug: {}, board_id: {}, title: {} }, [
				"account_slug",
				"board_id",
				"title",
			]),
		},
	];

	it("keeps the account → board chain", () => {
		const caps = analyzePMToolCapabilities(FIZZY_TOOLS);
		expect(caps.containerHierarchy.map((l) => l.containerType)).toEqual([
			"account",
			"board",
		]);
		expect(caps.cloudIdResolverTool).toBeUndefined();
	});
});

describe("containerIdFieldHint", () => {
	it("maps the container param to the right id field", () => {
		expect(containerIdFieldHint("projectKey")).toBe("key");
		expect(containerIdFieldHint("board_id")).toBe("id");
		expect(containerIdFieldHint("account_slug")).toBe("slug");
		expect(containerIdFieldHint("project")).toBeUndefined();
		expect(containerIdFieldHint(undefined)).toBeUndefined();
	});
});

describe("fetchContainersWithHierarchy — Atlassian Rovo", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("resolves cloudId, injects it, unwraps {values}, and keys by project key", async () => {
		const calls: Array<{
			toolName: string;
			params: Record<string, unknown>;
		}> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, init: { body: string }) => {
				const body = JSON.parse(init.body);
				calls.push({ toolName: body.toolName, params: body.params });
				if (body.toolName === "getAccessibleAtlassianResources") {
					return {
						ok: true,
						json: async () => ({
							result: [
								{
									id: "cloud-1",
									name: "site",
									url: "https://x",
								},
							],
						}),
					};
				}
				if (body.toolName === "getVisibleJiraProjects") {
					expect(body.params.cloudId).toBe("cloud-1");
					return {
						ok: true,
						json: async () => ({
							result: {
								total: 1,
								values: [
									{
										id: "10001",
										key: "SAN",
										name: "Sandbox",
									},
								],
							},
						}),
					};
				}
				throw new Error(`unexpected tool ${body.toolName}`);
			}),
		);

		const caps = analyzePMToolCapabilities(ROVO_TOOLS);
		const { containers } = await fetchContainersWithHierarchy(
			"cfg-1",
			caps.containerHierarchy,
			"org-1",
			{
				cloudIdResolverTool: caps.cloudIdResolverTool,
				idFieldHint: containerIdFieldHint(
					caps.taskCreation?.containerParam,
				),
			},
		);

		// cloudId resolved before the project list, Confluence never touched.
		expect(calls.map((c) => c.toolName)).toEqual([
			"getAccessibleAtlassianResources",
			"getVisibleJiraProjects",
		]);
		// project identified by key ("SAN"), not numeric id ("10001").
		expect(containers).toEqual([{ id: "SAN", name: "Sandbox" }]);
	});
});
