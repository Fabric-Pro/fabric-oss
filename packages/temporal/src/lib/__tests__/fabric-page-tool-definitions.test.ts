import { describe, expect, it } from "vitest";
import {
	ASKS_EVERY_TIME,
	ASKS_ONCE,
	connectedDeclaration,
	declarationOf,
	FABRIC_PAGE_TOOL_DEFINITIONS,
	isPageScopedTool,
	NOT_FOR_PAGES,
	PAGE_SHARED_WRITES,
	PAGE_STORE_READS,
	pageMayDeclareTool,
	parseConnectedDeclaration,
	TAINTING_TOOLS,
} from "../fabric-page-tool-definitions";
import { FABRIC_PROJECT_PM_TOOL_DEFINITIONS } from "../fabric-project-pm-tool-definitions";

describe("a connected read as a page declares it", () => {
	it("is connected:<provider>/<tool>, and reads back as the same two parts", () => {
		const entry = connectedDeclaration("github", "list_pull_requests");

		expect(entry).toBe("connected:github/list_pull_requests");
		expect(parseConnectedDeclaration(entry)).toEqual({
			provider: "github",
			tool: "list_pull_requests",
		});
	});

	it("keeps a slash inside the tool name, so a custom provider key is read whole", () => {
		expect(parseConnectedDeclaration("connected:custom:acme/a/b")).toEqual({
			provider: "custom:acme",
			tool: "a/b",
		});
	});

	it("is not a declaration when either part is missing or the prefix is not there", () => {
		for (const entry of [
			"connected:",
			"connected:github",
			"connected:/tool",
			"connected:github/",
			"github/list",
			"fabric_list_frames",
		]) {
			expect(parseConnectedDeclaration(entry), entry).toBeNull();
		}
	});
});

describe("declarationOf: the entry that covers a call", () => {
	it("is the tool's own name for any tool but the connected read", () => {
		expect(declarationOf("fabric_list_frames", {})).toBe(
			"fabric_list_frames",
		);
		expect(declarationOf("fabric_page_data_set", { provider: "x" })).toBe(
			"fabric_page_data_set",
		);
	});

	it("is the provider and tool a connected read names, never the tool that makes the read", () => {
		expect(
			declarationOf("fabric_page_read_connected", {
				provider: "github",
				tool: "list_issues",
			}),
		).toBe("connected:github/list_issues");
	});

	it.each([
		["no provider", { tool: "list_issues" }],
		["no tool", { provider: "github" }],
		["a provider that is not text", { provider: 7, tool: "list_issues" }],
		[
			"a tool that is not text",
			{ provider: "github", tool: ["list_issues"] },
		],
		["nothing", {}],
	])("is covered by nothing for a connected read with %s", (_label, args) => {
		expect(
			declarationOf("fabric_page_read_connected", args),
		).toBeUndefined();
	});
});

describe("NOT_FOR_PAGES", () => {
	it.each([
		"fabric_switch_organization",
		"fabric_request_authority",
		"fabric_revoke_authority",
		"fabric_share_frame",
		"fabric_create_workflow",
		"fabric_update_workflow",
		"fabric_bind_workspace_workflow",
		"fabric_publish_workflow",
		"fabric_create_frame",
		"fabric_update_frame",
		"fabric_create_slideshow",
		"fabric_get_identity",
		"fabric_list_organizations",
		"fabric_restore_frame_version",
		"fabric_duplicate_frame",
		"fabric_page_comment_add",
		"fabric_list_project_pm_assigned_items",
		"fabric_get_project_pm_item_snapshots",
	])("keeps %s from pages", (name) => {
		expect(NOT_FOR_PAGES.has(name)).toBe(true);
	});

	it.each([
		"fabric_get_page_viewer",
		"fabric_page_get_workflow",
		"fabric_page_run_workflow",
		"fabric_page_list_workflow_runs",
		"fabric_page_data_set",
		"fabric_page_ask",
		"fabric_page_comment_list",
		"fabric_list_frame_versions",
		"fabric_page_read_connected",
	])("leaves %s to pages", (name) => {
		expect(NOT_FOR_PAGES.has(name)).toBe(false);
	});
});

describe("pageMayDeclareTool", () => {
	const platform = new Set([
		"fabric_page_data_list",
		"fabric_get_identity",
		"fabric_duplicate_frame",
		"fabric_page_read_connected",
	]);

	it("allows a platform tool that is not barred", () => {
		expect(pageMayDeclareTool("fabric_page_data_list", platform)).toBe(
			true,
		);
	});

	it("refuses a barred tool and a tool that is not a platform tool", () => {
		expect(pageMayDeclareTool("fabric_get_identity", platform)).toBe(false);
		expect(pageMayDeclareTool("fabric_duplicate_frame", platform)).toBe(
			false,
		);
		expect(pageMayDeclareTool("anything_else", platform)).toBe(false);
	});

	it("requires a specific connected alias instead of declaring the proxy", () => {
		expect(pageMayDeclareTool("fabric_page_read_connected", platform)).toBe(
			false,
		);
		expect(NOT_FOR_PAGES.has("fabric_page_read_connected")).toBe(false);
		expect(
			declarationOf("fabric_page_read_connected", {
				provider: "example-provider",
				tool: "list_items",
			}),
		).toBe("connected:example-provider/list_items");
	});
});

describe("isPageScopedTool", () => {
	it.each([
		"fabric_page_data_list",
		"fabric_page_data_set",
		"fabric_page_file_upload",
		"fabric_page_comment_add",
		"fabric_page_ask",
		"fabric_page_read_connected",
		"fabric_get_page_viewer",
	])("is true for %s, which works on one page", (name) => {
		expect(isPageScopedTool(name)).toBe(true);
	});

	it.each([
		"fabric_get_frame",
		"fabric_list_frames",
		"fabric_list_frame_versions",
		"fabric_get_identity",
		"page_data_list",
	])("is false for %s", (name) => {
		expect(isPageScopedTool(name)).toBe(false);
	});

	it("covers every page tool", () => {
		for (const tool of FABRIC_PAGE_TOOL_DEFINITIONS) {
			expect(isPageScopedTool(tool.name), tool.name).toBe(true);
		}
	});
});

describe("the page definitions", () => {
	it("take the page they act on as an optional frameId, so a page names only itself", () => {
		for (const tool of FABRIC_PAGE_TOOL_DEFINITIONS) {
			const schema = tool.inputSchema as {
				properties: Record<string, unknown>;
				required?: string[];
			};
			expect(schema.properties.frameId, tool.name).toEqual({
				type: "string",
			});
			expect(schema.required ?? [], tool.name).not.toContain("frameId");
		}
	});

	it("mark the reads read-only and no write read-only, so the host runs only reads without asking", () => {
		const reads = FABRIC_PAGE_TOOL_DEFINITIONS.filter(
			(tool) => tool.annotations.readOnlyHint === true,
		).map((tool) => tool.name);

		expect(reads.sort()).toEqual([
			"fabric_get_page_viewer",
			"fabric_page_comment_list",
			"fabric_page_data_get",
			"fabric_page_data_list",
			"fabric_page_file_list",
			"fabric_page_file_read",
			"fabric_page_get_review_options",
			"fabric_page_get_story_review",
			"fabric_page_get_workflow",
			"fabric_page_list_story_review_runs",
			"fabric_page_list_workflow_runs",
		]);
	});

	it("say how the page host treats every one of them", () => {
		const effects = ["store-read", "store-write", "taints", "asks-once"];
		for (const tool of FABRIC_PAGE_TOOL_DEFINITIONS) {
			expect(effects, tool.name).toContain(tool.page);
		}
	});

	it("give a read-only tool no write effect, and a tool that changes data no read effect", () => {
		for (const tool of FABRIC_PAGE_TOOL_DEFINITIONS) {
			if (tool.page === "store-write") {
				expect(tool.annotations.readOnlyHint, tool.name).toBe(false);
			}
			if (tool.page === "store-read") {
				expect(tool.annotations.readOnlyHint, tool.name).toBe(true);
			}
		}
	});
});

describe("the sets the page host derives from the definitions", () => {
	it("match the lists the host kept by hand", () => {
		expect([...PAGE_STORE_READS].sort()).toEqual(
			[
				"fabric_page_data_get",
				"fabric_page_data_list",
				"fabric_page_file_list",
				"fabric_page_file_read",
				"fabric_page_comment_list",
			].sort(),
		);
		expect([...PAGE_SHARED_WRITES].sort()).toEqual([
			"fabric_page_data_delete",
			"fabric_page_data_set",
			"fabric_page_file_delete",
			"fabric_page_file_upload",
		]);
		expect([...TAINTING_TOOLS].sort()).toEqual([
			"fabric_get_page_viewer",
			"fabric_get_project_work_item_counts",
			"fabric_list_project_pm_members",
			"fabric_list_project_pm_work_item_types",
			"fabric_page_ask",
			"fabric_page_configure_story_review",
			"fabric_page_get_review_options",
			"fabric_page_get_story_review",
			"fabric_page_get_workflow",
			"fabric_page_list_story_review_runs",
			"fabric_page_list_workflow_runs",
			"fabric_page_read_connected",
			"fabric_page_run_story_review",
			"fabric_page_run_workflow",
		]);
		expect([...ASKS_ONCE].sort()).toEqual([
			"fabric_get_project_work_item_counts",
			"fabric_list_project_pm_members",
			"fabric_list_project_pm_work_item_types",
			"fabric_page_ask",
			"fabric_page_read_connected",
		]);
	});

	it("asks every time for shared deletes and constrained review configuration", () => {
		expect([...ASKS_EVERY_TIME].sort()).toEqual([
			"fabric_page_configure_story_review",
			"fabric_page_data_delete",
			"fabric_page_file_delete",
			"fabric_page_run_story_review",
			"fabric_page_run_workflow",
		]);
		for (const name of [
			"fabric_page_data_delete",
			"fabric_page_file_delete",
		]) {
			expect(PAGE_SHARED_WRITES.has(name), name).toBe(true);
		}
		expect(
			PAGE_SHARED_WRITES.has("fabric_page_configure_story_review"),
		).toBe(false);
		expect(ASKS_EVERY_TIME.has("fabric_page_comment_add")).toBe(false);
		expect(PAGE_SHARED_WRITES.has("fabric_page_run_workflow")).toBe(false);
		for (const name of [
			"fabric_page_get_workflow",
			"fabric_page_list_workflow_runs",
		]) {
			expect(ASKS_EVERY_TIME.has(name), name).toBe(false);
			expect(ASKS_ONCE.has(name), name).toBe(false);
		}
	});

	it("leave out a tool a page can never call", () => {
		for (const set of [
			PAGE_STORE_READS,
			PAGE_SHARED_WRITES,
			TAINTING_TOOLS,
			ASKS_ONCE,
		]) {
			expect(set.has("fabric_page_comment_add")).toBe(false);
		}
	});

	it("name only page tools, each in the sets its effect puts it in", () => {
		const names: ReadonlySet<string> = new Set(
			[
				...FABRIC_PAGE_TOOL_DEFINITIONS,
				...FABRIC_PROJECT_PM_TOOL_DEFINITIONS,
			].map((tool) => tool.name),
		);
		for (const set of [
			PAGE_STORE_READS,
			PAGE_SHARED_WRITES,
			TAINTING_TOOLS,
			ASKS_ONCE,
		]) {
			for (const name of set) {
				expect(names.has(name), name).toBe(true);
			}
		}
		for (const name of ASKS_ONCE) {
			expect(TAINTING_TOOLS.has(name), name).toBe(true);
		}
	});
});
