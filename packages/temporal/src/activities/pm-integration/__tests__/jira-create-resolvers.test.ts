/**
 * Tests for the Atlassian Rovo create-path resolvers.
 *
 * `createJiraIssue` requires `cloudId` and `issueTypeName`, neither of which is
 * carried in the project's container context. These helpers resolve them
 * just-in-time so the Jira push doesn't fail with "Required" validation errors.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { executeMcpToolMock } = vi.hoisted(() => ({
	executeMcpToolMock: vi.fn(),
}));

vi.mock("../../orchestrator/execution/execute-mcp-tool", () => ({
	executeMcpTool: executeMcpToolMock,
}));

import {
	fillJiraCreateArgs,
	pickDefaultJiraIssueType,
	resolveAtlassianCloudId,
	resolveJiraDefaultIssueType,
} from "../fetch-pm-hierarchy";

const BASE = {
	mcpConfigId: "mcp-1",
	userId: "user-1",
	organizationId: "org-1",
};

const mcpText = (value: unknown) => ({
	success: true,
	output: { content: [{ type: "text", text: JSON.stringify(value) }] },
});

// Mirrors the live SAN project metadata.
const SAN_ISSUE_TYPES = [
	{ id: "10006", name: "Epic", subtask: false, hierarchyLevel: 1 },
	{ id: "10007", name: "Subtask", subtask: true, hierarchyLevel: -1 },
	{ id: "10008", name: "Task", subtask: false, hierarchyLevel: 0 },
	{ id: "10009", name: "Story", subtask: false, hierarchyLevel: 0 },
	{ id: "10010", name: "Feature", subtask: false, hierarchyLevel: 0 },
	{ id: "10011", name: "Bug", subtask: false, hierarchyLevel: 0 },
];

beforeEach(() => {
	executeMcpToolMock.mockReset();
});

describe("pickDefaultJiraIssueType", () => {
	it("prefers Story (Fabric features map to UserStory)", () => {
		expect(pickDefaultJiraIssueType(SAN_ISSUE_TYPES)).toBe("Story");
	});

	it("falls back to Task when there is no Story", () => {
		expect(
			pickDefaultJiraIssueType(
				SAN_ISSUE_TYPES.filter((t) => t.name !== "Story"),
			),
		).toBe("Task");
	});

	it("uses the first standard type when neither Story nor Task exists", () => {
		expect(
			pickDefaultJiraIssueType([
				{ name: "Epic", subtask: false, hierarchyLevel: 1 },
				{ name: "Subtask", subtask: true, hierarchyLevel: -1 },
				{ name: "Feature", subtask: false, hierarchyLevel: 0 },
				{ name: "Bug", subtask: false, hierarchyLevel: 0 },
			]),
		).toBe("Feature");
	});

	it("never returns an Epic or Sub-task", () => {
		const result = pickDefaultJiraIssueType([
			{ name: "Epic", subtask: false, hierarchyLevel: 1 },
			{ name: "Subtask", subtask: true, hierarchyLevel: -1 },
		]);
		expect(result).toBe("Task"); // literal fallback — no standard type
	});

	it("treats absent hierarchyLevel as a standard type", () => {
		expect(
			pickDefaultJiraIssueType([{ name: "Task", subtask: false }]),
		).toBe("Task");
	});

	it("falls back to 'Task' for an empty list", () => {
		expect(pickDefaultJiraIssueType([])).toBe("Task");
	});
});

describe("resolveAtlassianCloudId", () => {
	it("returns the first site's id", async () => {
		executeMcpToolMock.mockResolvedValueOnce(
			mcpText([
				{ id: "cloud-1", name: "site-a", url: "https://a" },
				{ id: "cloud-2", name: "site-b", url: "https://b" },
			]),
		);
		const cloudId = await resolveAtlassianCloudId({
			...BASE,
			availableTools: [
				"createJiraIssue",
				"getAccessibleAtlassianResources",
			],
		});
		expect(cloudId).toBe("cloud-1");
		expect(executeMcpToolMock).toHaveBeenCalledWith(
			expect.objectContaining({
				toolName: "getAccessibleAtlassianResources",
				args: {},
			}),
		);
	});

	it("reads a wrapped result such as { resources: [{ id }] }", async () => {
		executeMcpToolMock.mockResolvedValueOnce(
			mcpText({
				resources: [
					{
						id: "33333333-3333-4333-8333-333333333333",
						name: "site-w",
						url: "https://w",
					},
				],
			}),
		);
		const cloudId = await resolveAtlassianCloudId({
			...BASE,
			availableTools: [
				"createJiraIssue",
				"getAccessibleAtlassianResources",
			],
		});
		expect(cloudId).toBe("33333333-3333-4333-8333-333333333333");
	});

	it("returns undefined when the resolver tool is absent", async () => {
		const cloudId = await resolveAtlassianCloudId({
			...BASE,
			availableTools: ["createJiraIssue"],
		});
		expect(cloudId).toBeUndefined();
		expect(executeMcpToolMock).not.toHaveBeenCalled();
	});

	it("returns undefined when the call fails", async () => {
		executeMcpToolMock.mockResolvedValueOnce({
			success: false,
			output: {},
		});
		const cloudId = await resolveAtlassianCloudId({
			...BASE,
			availableTools: ["getAccessibleAtlassianResources"],
		});
		expect(cloudId).toBeUndefined();
	});

	it("returns undefined when the probe throws (defensive)", async () => {
		executeMcpToolMock.mockRejectedValueOnce(new Error("MCP down"));
		const cloudId = await resolveAtlassianCloudId({
			...BASE,
			availableTools: ["getAccessibleAtlassianResources"],
		});
		expect(cloudId).toBeUndefined();
	});
});

describe("resolveJiraDefaultIssueType", () => {
	const TOOLS = ["createJiraIssue", "getJiraProjectIssueTypesMetadata"];

	it("resolves the default issue type from project metadata", async () => {
		executeMcpToolMock.mockResolvedValueOnce(
			mcpText({ total: 6, issueTypes: SAN_ISSUE_TYPES }),
		);
		const type = await resolveJiraDefaultIssueType({
			...BASE,
			projectKey: "SAN",
			cloudId: "cloud-1",
			availableTools: TOOLS,
		});
		expect(type).toBe("Story");
		expect(executeMcpToolMock).toHaveBeenCalledWith(
			expect.objectContaining({
				toolName: "getJiraProjectIssueTypesMetadata",
				args: { cloudId: "cloud-1", projectIdOrKey: "SAN" },
			}),
		);
	});

	it("uses listJiraProjectIssueTypesMetadata when present (Rovo v2)", async () => {
		executeMcpToolMock.mockResolvedValueOnce(
			mcpText({ total: 6, issueTypes: SAN_ISSUE_TYPES }),
		);
		const type = await resolveJiraDefaultIssueType({
			...BASE,
			projectKey: "SAN",
			cloudId: "cloud-1",
			availableTools: [
				"createJiraIssue",
				"listJiraProjectIssueTypesMetadata",
			],
		});
		expect(type).toBe("Story");
		expect(executeMcpToolMock).toHaveBeenCalledWith(
			expect.objectContaining({
				toolName: "listJiraProjectIssueTypesMetadata",
				args: { cloudId: "cloud-1", projectIdOrKey: "SAN" },
			}),
		);
	});

	it("falls back to 'Task' without a cloudId (and doesn't call the tool)", async () => {
		const type = await resolveJiraDefaultIssueType({
			...BASE,
			projectKey: "SAN",
			cloudId: undefined,
			availableTools: TOOLS,
		});
		expect(type).toBe("Task");
		expect(executeMcpToolMock).not.toHaveBeenCalled();
	});

	it("falls back to 'Task' when the metadata tool is missing", async () => {
		const type = await resolveJiraDefaultIssueType({
			...BASE,
			projectKey: "SAN",
			cloudId: "cloud-1",
			availableTools: ["createJiraIssue"],
		});
		expect(type).toBe("Task");
		expect(executeMcpToolMock).not.toHaveBeenCalled();
	});

	it("falls back to 'Task' when the call throws", async () => {
		executeMcpToolMock.mockRejectedValueOnce(new Error("boom"));
		const type = await resolveJiraDefaultIssueType({
			...BASE,
			projectKey: "SAN",
			cloudId: "cloud-1",
			availableTools: TOOLS,
		});
		expect(type).toBe("Task");
	});

	it("unwraps v2 responses with { data: { issueTypes } }", async () => {
		executeMcpToolMock.mockResolvedValueOnce(
			mcpText({ data: { issueTypes: SAN_ISSUE_TYPES } }),
		);
		const type = await resolveJiraDefaultIssueType({
			...BASE,
			projectKey: "SAN",
			cloudId: "cloud-1",
			availableTools: TOOLS,
		});
		expect(type).toBe("Story");
	});
});

describe("fillJiraCreateArgs", () => {
	const RESOLVER_TOOLS = [
		"getAccessibleAtlassianResources",
		"getJiraProjectIssueTypesMetadata",
	];

	it("fills issueTypeName for a v1 schema", async () => {
		executeMcpToolMock
			.mockResolvedValueOnce(mcpText([{ id: "cloud-1" }]))
			.mockResolvedValueOnce(mcpText({ issueTypes: SAN_ISSUE_TYPES }));
		const createArgs: Record<string, unknown> = {};
		await fillJiraCreateArgs({
			...BASE,
			createArgs,
			createParams: [{ name: "cloudId" }, { name: "issueTypeName" }],
			projectKey: "SAN",
			availableTools: RESOLVER_TOOLS,
		});
		expect(createArgs.cloudId).toBe("cloud-1");
		expect(createArgs.issueTypeName).toBe("Story");
	});

	it("fills issueType for a v2 schema", async () => {
		executeMcpToolMock
			.mockResolvedValueOnce(mcpText([{ id: "cloud-1" }]))
			.mockResolvedValueOnce(
				mcpText({ data: { issueTypes: SAN_ISSUE_TYPES } }),
			);
		const createArgs: Record<string, unknown> = {};
		await fillJiraCreateArgs({
			...BASE,
			createArgs,
			createParams: [{ name: "cloudId" }, { name: "issueType" }],
			projectKey: "SAN",
			availableTools: RESOLVER_TOOLS,
		});
		expect(createArgs.cloudId).toBe("cloud-1");
		expect(createArgs.issueType).toBe("Story");
	});

	it("uses savedCloudId without calling getAccessibleAtlassianResources", async () => {
		executeMcpToolMock.mockResolvedValueOnce(
			mcpText({ issueTypes: SAN_ISSUE_TYPES }),
		);
		const createArgs: Record<string, unknown> = {};
		await fillJiraCreateArgs({
			...BASE,
			createArgs,
			createParams: [{ name: "cloudId" }, { name: "issueType" }],
			projectKey: "SAN",
			savedCloudId: "saved-cloud-123",
			availableTools: RESOLVER_TOOLS,
		});
		expect(createArgs.cloudId).toBe("saved-cloud-123");
		expect(createArgs.issueType).toBe("Story");
		expect(executeMcpToolMock).not.toHaveBeenCalledWith(
			expect.objectContaining({
				toolName: "getAccessibleAtlassianResources",
			}),
		);
	});

	it("resolves cloudId when existing createArgs has cloudId: ''", async () => {
		executeMcpToolMock
			.mockResolvedValueOnce(mcpText([{ id: "cloud-resolved-1" }]))
			.mockResolvedValueOnce(mcpText({ issueTypes: SAN_ISSUE_TYPES }));
		const createArgs: Record<string, unknown> = { cloudId: "" };
		await fillJiraCreateArgs({
			...BASE,
			createArgs,
			createParams: [{ name: "cloudId" }, { name: "issueType" }],
			projectKey: "SAN",
			availableTools: RESOLVER_TOOLS,
		});
		expect(createArgs.cloudId).toBe("cloud-resolved-1");
		expect(createArgs.issueType).toBe("Story");
	});

	it("makes no calls when the tool declares neither parameter", async () => {
		const createArgs: Record<string, unknown> = {};
		await fillJiraCreateArgs({
			...BASE,
			createArgs,
			createParams: [{ name: "summary" }, { name: "description" }],
			projectKey: "SAN",
			availableTools: RESOLVER_TOOLS,
		});
		expect(createArgs).toEqual({});
		expect(executeMcpToolMock).not.toHaveBeenCalled();
	});
});
