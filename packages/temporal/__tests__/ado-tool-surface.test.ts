/**
 * Contract tests for the Azure DevOps MCP tool-surface resolver.
 *
 * `@azure-devops/mcp` 2.9.0 consolidated the granular per-operation tools into
 * action-dispatched ones. Because the catalog spawns the server unpinned, a
 * connection may be on either surface, so every dispatch has to resolve the
 * right tool name AND the right argument shape. These assert the exact args —
 * the thing a mocked MCP layer otherwise hides.
 */
import { describe, expect, it } from "vitest";
import {
	describeAdoToolRequirement,
	resolveAdoTool,
} from "../src/activities/pm-integration/ado-tool-surface";

/** Granular surface (<= 2.8.x), trimmed to the names the resolver cares about. */
const GRANULAR_TOOLS = [
	"wit_get_work_item",
	"wit_get_work_items_batch_by_ids",
	"wit_get_work_item_type",
	"wit_list_work_item_comments",
	"wit_query_by_wiql",
	"wit_get_query",
	"wit_create_work_item",
	"wit_work_item_unlink",
	"wit_work_items_link",
];

/** Consolidated surface (>= 2.9.0). */
const CONSOLIDATED_TOOLS = [
	"wit_work_item",
	"wit_work_item_write",
	"wit_work_item_comment_write",
	"wit_work_item_link_write",
	"wit_query",
	"wit_backlog",
];

describe("resolveAdoTool — granular surface", () => {
	it("uses the granular tool name and passes args through untouched", () => {
		const resolved = resolveAdoTool(GRANULAR_TOOLS, "get_type", {
			project: "example-project",
			workItemType: "User Story",
		});

		expect(resolved).toEqual({
			toolName: "wit_get_work_item_type",
			args: { project: "example-project", workItemType: "User Story" },
			surface: "granular",
		});
	});

	it("does NOT inject an action key", () => {
		const resolved = resolveAdoTool(GRANULAR_TOOLS, "wiql", {
			wiql: "SELECT [System.Id] FROM WorkItems",
			project: "example-project",
		});

		expect(resolved?.toolName).toBe("wit_query_by_wiql");
		expect(resolved?.args).not.toHaveProperty("action");
	});

	it("resolves batch reads to the granular batch tool", () => {
		const resolved = resolveAdoTool(GRANULAR_TOOLS, "get_batch", {
			ids: [1, 2],
			project: "example-project",
		});

		expect(resolved?.toolName).toBe("wit_get_work_items_batch_by_ids");
	});

	it("is not confused by similarly named link tools", () => {
		// `wit_work_item_unlink` / `wit_work_items_link` must never satisfy `get`.
		const resolved = resolveAdoTool(GRANULAR_TOOLS, "get", { id: 1 });
		expect(resolved?.toolName).toBe("wit_get_work_item");
	});
});

describe("resolveAdoTool — consolidated surface", () => {
	it("dispatches get_type through wit_work_item with an action", () => {
		const resolved = resolveAdoTool(CONSOLIDATED_TOOLS, "get_type", {
			project: "example-project",
			workItemType: "User Story",
		});

		expect(resolved).toEqual({
			toolName: "wit_work_item",
			args: {
				action: "get_type",
				project: "example-project",
				workItemType: "User Story",
			},
			surface: "consolidated",
		});
	});

	it("maps each work-item read to its action", () => {
		expect(
			resolveAdoTool(CONSOLIDATED_TOOLS, "get", { id: 7 })?.args,
		).toEqual({ action: "get", id: 7 });

		expect(
			resolveAdoTool(CONSOLIDATED_TOOLS, "get_batch", { ids: [7, 8] })
				?.args,
		).toEqual({ action: "get_batch", ids: [7, 8] });

		expect(
			resolveAdoTool(CONSOLIDATED_TOOLS, "list_comments", {
				workItemId: 7,
			})?.args,
		).toEqual({ action: "list_comments", workItemId: 7 });
	});

	it("routes wiql to wit_query, not the work-item tool", () => {
		const resolved = resolveAdoTool(CONSOLIDATED_TOOLS, "wiql", {
			wiql: "SELECT [System.Id] FROM WorkItems",
			project: "example-project",
		});

		expect(resolved?.toolName).toBe("wit_query");
		expect(resolved?.args).toEqual({
			action: "wiql",
			wiql: "SELECT [System.Id] FROM WorkItems",
			project: "example-project",
		});
	});

	it("keeps caller args when they collide in name with nothing reserved", () => {
		const resolved = resolveAdoTool(CONSOLIDATED_TOOLS, "get", {
			id: 7,
			project: "example-project",
			fields: ["System.Title"],
		});
		expect(resolved?.args).toEqual({
			action: "get",
			id: 7,
			project: "example-project",
			fields: ["System.Title"],
		});
	});
});

describe("resolveAdoTool — prefixed registrations", () => {
	it("matches namespaced tool names by suffix", () => {
		const resolved = resolveAdoTool(
			["mcp__azure-devops__wit_get_work_item_type"],
			"get_type",
			{ workItemType: "Bug" },
		);
		expect(resolved?.toolName).toBe(
			"mcp__azure-devops__wit_get_work_item_type",
		);
		expect(resolved?.surface).toBe("granular");
	});

	it("matches namespaced consolidated names too", () => {
		const resolved = resolveAdoTool(
			["mcp__azure-devops__wit_work_item"],
			"get_batch",
			{ ids: [1] },
		);
		expect(resolved?.toolName).toBe("mcp__azure-devops__wit_work_item");
		expect(resolved?.args).toEqual({ action: "get_batch", ids: [1] });
	});
});

describe("resolveAdoTool — unavailable", () => {
	it("returns null when neither surface is present", () => {
		expect(
			resolveAdoTool(["repo_file", "wiki"], "get_type", {}),
		).toBeNull();
	});

	it("describes both surfaces so the error is diagnosable either way", () => {
		const description = describeAdoToolRequirement("get_type");
		expect(description).toContain("wit_get_work_item_type");
		expect(description).toContain("wit_work_item");
		expect(description).toContain("get_type");
	});
});
