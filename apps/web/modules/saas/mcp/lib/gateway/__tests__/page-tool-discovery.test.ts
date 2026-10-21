import { FABRIC_GATEWAY_TOOL_DEFINITIONS } from "@repo/temporal/fabric-gateway-tools";
import { NOT_FOR_PAGES } from "@repo/temporal/fabric-page-tool-definitions";
import { FABRIC_PROJECT_PM_TOOL_DEFINITIONS } from "@repo/temporal/fabric-project-pm-tool-definitions";
import { FABRIC_PROJECT_READ_TOOL_DEFINITIONS } from "@repo/temporal/fabric-project-read-tool-definitions";
import { describe, expect, it } from "vitest";
import { listPageTools } from "../tools/page-tool-discovery";
import type { GatewaySession } from "../types";

const session: GatewaySession = {
	sessionId: "session-1",
	userId: "user-1",
	organizationId: "org-1",
	userName: "Example User",
	email: "user@example.com",
	role: "user",
	credential: "session",
	scopes: ["*"],
	createdAt: new Date("2026-10-01T00:00:00Z"),
	expiresAt: new Date("2026-10-02T00:00:00Z"),
};

function discover(query: string, activeSession = session) {
	const result = listPageTools({ query }, activeSession, [
		...FABRIC_GATEWAY_TOOL_DEFINITIONS,
	]);
	return JSON.parse(result.content[0].text);
}

describe("page authoring discovery", () => {
	it.each([
		"fabric_page_get_workflow",
		"fabric_page_run_workflow",
		"fabric_page_list_workflow_runs",
	])(
		"offers provider-neutral %s without graph or authority overrides",
		(name) => {
			const tool = discover(name).tools[0];
			expect(tool.name).toBe(name);
			expect(tool.inputSchema.additionalProperties).toBe(false);
			for (const field of [
				"nodes",
				"edges",
				"variables",
				"projectId",
				"organizationId",
				"workspaceWorkflowBinding",
			]) {
				expect(tool.inputSchema.properties).not.toHaveProperty(field);
			}
		},
	);
	it("never offers binding authority to page scripts", () => {
		expect(NOT_FOR_PAGES.has("fabric_bind_workspace_workflow")).toBe(true);
		expect(discover("fabric_bind_workspace_workflow").tools).toEqual([]);
	});
	it.each([
		"fabric_page_get_story_review",
		"fabric_page_configure_story_review",
		"fabric_page_run_story_review",
		"fabric_page_list_story_review_runs",
	])("offers constrained %s without graph or authority arguments", (name) => {
		const tool = discover(name).tools[0];
		expect(tool.name).toBe(name);
		expect(tool.inputSchema.additionalProperties).toBe(false);
		for (const field of [
			"nodes",
			"edges",
			"projectId",
			"organizationId",
			"status",
		]) {
			expect(tool.inputSchema.properties).not.toHaveProperty(field);
		}
		expect(tool.inputSchema.properties.forceReview !== undefined).toBe(
			name === "fabric_page_run_story_review",
		);
	});
	it("offers bounded Workspace review selectors as reads with no project/tenant input", () => {
		const tool = discover("fabric_page_get_review_options").tools[0];
		expect(tool).toMatchObject({
			name: "fabric_page_get_review_options",
			annotations: { readOnlyHint: true },
			inputSchema: {
				additionalProperties: false,
				properties: { limit: { maximum: 50 } },
			},
		});
		expect(tool.inputSchema.properties).not.toHaveProperty("projectId");
		expect(tool.inputSchema.properties).not.toHaveProperty(
			"organizationId",
		);
	});
	it.each(
		[
			...FABRIC_PROJECT_READ_TOOL_DEFINITIONS,
			...FABRIC_PROJECT_PM_TOOL_DEFINITIONS,
		].filter((tool) => !NOT_FOR_PAGES.has(tool.name)),
	)("offers the exact live $name schema to the page author", (definition) => {
		const { tools } = discover(definition.name);
		expect(tools).toContainEqual({
			name: definition.name,
			description: definition.description,
			inputSchema: definition.inputSchema,
			annotations: definition.annotations,
		});
	});

	it("exposes the record array and file id shapes that generated calls must use", () => {
		const set = discover("fabric_page_data_set").tools[0];
		expect(set.inputSchema.required).toEqual(["collection", "records"]);
		expect(set.inputSchema.properties.records.items.required).toEqual([
			"key",
			"value",
		]);
		expect(set.inputSchema.properties).not.toHaveProperty("key");
		expect(set.inputSchema.properties).not.toHaveProperty("value");

		const read = discover("fabric_page_file_read").tools[0];
		expect(read.inputSchema.required).toEqual(["id"]);
		expect(read.inputSchema.properties).not.toHaveProperty("fileId");
	});

	it.each([
		"fabric_page_read_connected",
		"fabric_page_comment_add",
		"fabric_create_frame",
		"fabric_list_project_features",
		"fabric_list_project_pm_assigned_items",
		"fabric_get_project_pm_item_snapshots",
	])("never recommends an undeclarable %s tool", (query) => {
		expect(discover(query).tools).toEqual([]);
	});

	it("honors the session's narrowed server/tool selection", () => {
		expect(
			discover("fabric_list_project_pm_members", {
				...session,
				serverSelection: [
					{ server: "fabric", tools: ["fabric_get_project"] },
				],
			}).tools,
		).toEqual([]);
	});
});
