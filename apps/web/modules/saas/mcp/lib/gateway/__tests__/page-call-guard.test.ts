/**
 * A call that arrives with a page's id is held to the page's own rules on the
 * server, whatever the host page did or did not check.
 *
 * What these cases pin is each refusal and what a passing call is handed on
 * as: the page's own id in the place of any `frameId` it sent, for the tools
 * that are about one page. The page lookup is the database's (it opens the
 * frame as the viewer); only its answers are stubbed.
 *
 * Run with: pnpm --filter web test modules/saas/mcp/lib/gateway/__tests__/page-call-guard
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getAccessibleFrameById: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	getAccessibleFrameById: mocks.getAccessibleFrameById,
}));

import {
	checkPageCall as checkCall,
	pageCallSession,
} from "../page-call-guard";
import { sessionMayReachProject } from "../project-binding";
import type { GatewaySession } from "../types";
import { accessibleFrame } from "../tools/frame-context";
import { isPlatformToolName } from "../server-selection";

const checkPageCall = (
	pageFrameId: string,
	toolName: string,
	args: Record<string, unknown>,
	session: Parameters<typeof checkCall>[3],
) => checkCall(pageFrameId, toolName, args, session, isPlatformToolName);

const viewer = {
	userId: "viewer-1",
	email: "viewer@example.com",
	organizationId: "org-1",
};

function pageRecord(overrides: Record<string, unknown> = {}) {
	return {
		id: "page-1",
		userId: "owner-1",
		surface: "workspace",
		runtimeTools: [
			"fabric_list_frames",
			"fabric_page_data_set",
			"fabric_get_page_viewer",
			"connected:github/list_issues",
		],
		...overrides,
	};
}

function refusalOf(checked: Awaited<ReturnType<typeof checkPageCall>>): {
	reason: string;
	error: string;
} {
	if (checked.ok) {
		throw new Error("expected a refusal");
	}
	expect(checked.result.isError).toBe(true);
	return JSON.parse(checked.result.content[0].text);
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getAccessibleFrameById.mockResolvedValue(pageRecord());
});

describe("a call a page makes", () => {
	it.each(["foreign-project", null])(
		"refuses a resolved frame in project %s",
		async (projectId) => {
			mocks.getAccessibleFrameById.mockResolvedValue(
				pageRecord({ projectId }),
			);
			await expect(
				accessibleFrame("foreign-frame", {
					...viewer,
					pageProjectId: "project-1",
				}),
			).resolves.toBeNull();
		},
	);

	it.each(["projectId", "pinnedProjectId"] as const)(
		"refuses an attachment conflicting with %s",
		async (binding) => {
			mocks.getAccessibleFrameById.mockResolvedValue(
				pageRecord({ projectId: "project-1" }),
			);
			const checked = await checkPageCall(
				"page-1",
				"fabric_list_frames",
				{},
				{
					...viewer,
					[binding]: "foreign-project",
				},
			);
			expect(refusalOf(checked).reason).toBe("other_project");
		},
	);

	it.each([
		["fabric_list_workspaces", {}],
		["fabric_get_workspace", { workspaceId: "workspace-1" }],
		["fabric_query_workspace", {}],
		["fabric_list_chats", {}],
		[
			"fabric_page_read_connected",
			{
				provider: "github",
				tool: "list_issues",
				args: { repository: "example" },
			},
		],
		["fabric_execute_workflow", { workflowId: "workflow-1" }],
		["fabric_unpublish_workflow", { workflowId: "workflow-1" }],
		["fabric_pause_workflow", { workflowId: "workflow-1" }],
		["fabric_resume_workflow", { workflowId: "workflow-1" }],
	] as const)(
		"refuses unscoped attached-page %s but preserves unattached calls",
		async (tool, args) => {
			const runtimeTools = [tool, "connected:github/list_issues"];
			mocks.getAccessibleFrameById.mockResolvedValue(
				pageRecord({ projectId: "project-1", runtimeTools }),
			);
			expect(
				refusalOf(await checkPageCall("page-1", tool, args, viewer))
					.reason,
			).toBe("attached_page_unscoped_tool");
			mocks.getAccessibleFrameById.mockResolvedValue(
				pageRecord({ runtimeTools }),
			);
			expect((await checkPageCall("page-1", tool, args, viewer)).ok).toBe(
				true,
			);
		},
	);

	it("defaults declared project arguments without adding them to strict page-review calls", async () => {
		mocks.getAccessibleFrameById.mockResolvedValue(
			pageRecord({
				projectId: "project-1",
				runtimeTools: [
					"fabric_list_documents",
					"fabric_page_run_story_review",
				],
			}),
		);
		expect(
			await checkCall(
				"page-1",
				"fabric_list_documents",
				{},
				viewer,
				isPlatformToolName,
				true,
			),
		).toEqual({
			ok: true,
			args: { projectId: "project-1" },
			pageProjectId: "project-1",
		});
		expect(
			await checkPageCall(
				"page-1",
				"fabric_page_run_story_review",
				{},
				viewer,
			),
		).toEqual({
			ok: true,
			args: { frameId: "page-1" },
			pageProjectId: "project-1",
		});
		expect(
			refusalOf(
				await checkCall(
					"page-1",
					"fabric_list_documents",
					{
						projectId: "foreign-project",
					},
					viewer,
					isPlatformToolName,
					true,
				),
			).reason,
		).toBe("other_project");
	});

	it("preserves arbitrary projectId fields in page data and question payloads", async () => {
		mocks.getAccessibleFrameById.mockResolvedValue(
			pageRecord({
				projectId: "project-1",
				runtimeTools: ["fabric_page_data_set", "fabric_page_ask"],
			}),
		);
		const args = {
			records: [
				{ key: "example", value: { projectId: "external-project" } },
			],
		};
		expect(
			await checkPageCall("page-1", "fabric_page_data_set", args, viewer),
		).toEqual({
			ok: true,
			args: { ...args, frameId: "page-1" },
			pageProjectId: "project-1",
		});
		const question = {
			question: "Summarize",
			context: JSON.stringify({ projectId: "external-project" }),
		};
		expect(
			await checkPageCall("page-1", "fabric_page_ask", question, viewer),
		).toEqual({
			ok: true,
			args: { ...question, frameId: "page-1" },
			pageProjectId: "project-1",
		});
	});

	it.each([
		"fabric_page_get_story_review",
		"fabric_page_configure_story_review",
		"fabric_page_run_story_review",
		"fabric_page_list_story_review_runs",
	])(
		"preserves attached-page %s with only its frame argument",
		async (tool) => {
			mocks.getAccessibleFrameById.mockResolvedValue(
				pageRecord({
					projectId: "project-1",
					runtimeTools: [tool],
				}),
			);
			expect(await checkPageCall("page-1", tool, {}, viewer)).toEqual({
				ok: true,
				args: { frameId: "page-1" },
				pageProjectId: "project-1",
			});
		},
	);

	it("keeps concurrent page constraints out of the shared session", async () => {
		const session: GatewaySession = Object.freeze({
			...viewer,
			sessionId: "session-1",
			userName: "Viewer",
			role: "user",
			credential: "session",
			scopes: ["mcp:read"],
			createdAt: new Date(),
			expiresAt: new Date(),
		});
		const [first, second] = await Promise.all([
			Promise.resolve().then(() => pageCallSession(session, "project-1")),
			Promise.resolve().then(() => pageCallSession(session, "project-2")),
		]);
		expect(first.scopes).toBe(session.scopes);
		expect(first.credential).toBe(session.credential);
		expect(first).not.toBe(session);
		expect(session).not.toHaveProperty("pageProjectId");
		expect(session).not.toHaveProperty("projectId");
		expect(session).not.toHaveProperty("pinnedProjectId");
		expect(sessionMayReachProject(first, "project-1")).toBe(true);
		expect(sessionMayReachProject(second, "project-1")).toBe(false);
		expect(sessionMayReachProject(first, null)).toBe(false);
		expect(sessionMayReachProject(session, null)).toBe(true);
		expect(pageCallSession(first, "project-2").pageProjectId).toBe(
			"project-1",
		);
	});

	it.each([
		"fabric_page_get_story_review",
		"fabric_page_configure_story_review",
		"fabric_page_run_story_review",
		"fabric_page_list_story_review_runs",
	])("derives %s's Workspace and refuses another page", async (tool) => {
		mocks.getAccessibleFrameById.mockResolvedValue(
			pageRecord({ runtimeTools: [tool] }),
		);
		expect(
			await checkPageCall(
				"page-1",
				tool,
				{ workflowId: "workflow-1" },
				viewer,
			),
		).toEqual({
			ok: true,
			args: { workflowId: "workflow-1", frameId: "page-1" },
		});
		expect(
			refusalOf(
				await checkPageCall(
					"page-1",
					tool,
					{ frameId: "other-page", workflowId: "workflow-1" },
					viewer,
				),
			).reason,
		).toBe("other_page");
	});
	it.each([
		"fabric_get_project_pm_connection",
		"fabric_list_project_pm_members",
		"fabric_list_project_pm_work_item_types",
		"fabric_get_project_work_item_counts",
	])("keeps %s on the attached project before dispatch", async (tool) => {
		mocks.getAccessibleFrameById.mockResolvedValue(
			pageRecord({ projectId: "project-1", runtimeTools: [tool] }),
		);
		expect(await checkPageCall("page-1", tool, {}, viewer)).toEqual({
			ok: true,
			pageProjectId: "project-1",
			args: { projectId: "project-1" },
		});
		expect(
			await checkPageCall(
				"page-1",
				tool,
				{ projectId: "project-1" },
				viewer,
			),
		).toEqual({
			ok: true,
			args: { projectId: "project-1" },
			pageProjectId: "project-1",
		});
		expect(
			refusalOf(
				await checkPageCall(
					"page-1",
					tool,
					{ projectId: "foreign-project" },
					viewer,
				),
			).reason,
		).toBe("other_project");
	});

	it("preserves explicit project PM reads for an unbound Workspace", async () => {
		const tool = "fabric_list_project_pm_members";
		mocks.getAccessibleFrameById.mockResolvedValue(
			pageRecord({ runtimeTools: [tool] }),
		);
		expect(
			await checkPageCall(
				"page-1",
				tool,
				{ projectId: "project-1" },
				viewer,
			),
		).toEqual({ ok: true, args: { projectId: "project-1" } });
	});
	it("opens the page as the viewer, in the viewer's organization", async () => {
		await checkPageCall("page-1", "fabric_list_frames", {}, viewer);

		expect(mocks.getAccessibleFrameById).toHaveBeenCalledWith({
			id: "page-1",
			userId: "viewer-1",
			userEmail: "viewer@example.com",
			organizationId: "org-1",
		});
	});

	it("passes a tool the page declares, with its arguments unchanged", async () => {
		const args = { limit: 5 };

		const checked = await checkPageCall(
			"page-1",
			"fabric_list_frames",
			args,
			viewer,
		);

		expect(checked).toEqual({ ok: true, args });
	});

	it.each(["fabric_page_data_set", "fabric_get_page_viewer"])(
		"makes the page's own id the frameId of %s, whatever the call said",
		async (tool) => {
			const withoutId = await checkPageCall(
				"page-1",
				tool,
				{ a: 1 },
				viewer,
			);
			const withOwnId = await checkPageCall(
				"page-1",
				tool,
				{ a: 1, frameId: "page-1" },
				viewer,
			);

			expect(withoutId).toEqual({
				ok: true,
				args: { a: 1, frameId: "page-1" },
			});
			expect(withOwnId).toEqual({
				ok: true,
				args: { a: 1, frameId: "page-1" },
			});
		},
	);

	it("treats a null frameId as none, and fills in the page's own", async () => {
		const checked = await checkPageCall(
			"page-1",
			"fabric_page_data_set",
			{ frameId: null },
			viewer,
		);

		expect(checked).toEqual({ ok: true, args: { frameId: "page-1" } });
	});

	it("does not add a frameId to a tool that is not about one page", async () => {
		const checked = await checkPageCall(
			"page-1",
			"fabric_list_frames",
			{},
			viewer,
		);

		expect(checked).toEqual({ ok: true, args: {} });
	});
});

describe("a call a page may not make", () => {
	it("refuses a page id that is not a page id, without looking anything up", async () => {
		for (const bad of ["", "../x", "a b", "x".repeat(129), "page/1"]) {
			const checked = await checkPageCall(
				bad,
				"fabric_list_frames",
				{},
				viewer,
			);

			expect(refusalOf(checked).reason, bad).toBe("invalid_page_frame");
		}
		expect(mocks.getAccessibleFrameById).not.toHaveBeenCalled();
	});

	it.each([
		"fabric_share_frame",
		"fabric_create_frame",
		"fabric_update_frame",
		"fabric_create_workflow",
		"fabric_publish_workflow",
		"fabric_switch_organization",
		"fabric_request_authority",
		"fabric_list_project_pm_assigned_items",
		"fabric_get_project_pm_item_snapshots",
	])("refuses %s, even when the page declares it", async (tool) => {
		mocks.getAccessibleFrameById.mockResolvedValue(
			pageRecord({ runtimeTools: [tool] }),
		);

		const checked = await checkPageCall("page-1", tool, {}, viewer);

		expect(refusalOf(checked).reason).toBe("tool_not_for_pages");
		expect(mocks.getAccessibleFrameById).not.toHaveBeenCalled();
	});

	it.each([
		"fabric_page_data_set",
		"fabric_get_page_viewer",
		"fabric_page_file_read",
	])(
		"refuses %s naming another page, and says a page reaches only its own data",
		async (tool) => {
			const checked = await checkPageCall(
				"page-1",
				tool,
				{ frameId: "page-2" },
				viewer,
			);

			const refusal = refusalOf(checked);
			expect(refusal.reason).toBe("other_page");
			expect(refusal.error).toBe("A page can only reach its own data.");
			expect(mocks.getAccessibleFrameById).not.toHaveBeenCalled();
		},
	);

	it("lets a tool that is not about one page name another page, for the tool's own access check to decide", async () => {
		mocks.getAccessibleFrameById.mockResolvedValue(
			pageRecord({ runtimeTools: ["fabric_get_frame"] }),
		);

		const checked = await checkPageCall(
			"page-1",
			"fabric_get_frame",
			{ frameId: "page-2" },
			viewer,
		);

		expect(checked).toEqual({ ok: true, args: { frameId: "page-2" } });
	});

	it("refuses a tool the page does not declare", async () => {
		const checked = await checkPageCall(
			"page-1",
			"fabric_list_workflows",
			{},
			viewer,
		);

		const refusal = refusalOf(checked);
		expect(refusal.reason).toBe("tool_not_declared");
		expect(refusal.error).toBe(
			"This page does not declare fabric_list_workflows.",
		);
	});

	it("refuses the discovery meta-tools, which run any tool by name, even when the page's stored tools name them", async () => {
		for (const tool of ["search_tools", "get_tool_schema", "call_tool"]) {
			mocks.getAccessibleFrameById.mockResolvedValue(
				pageRecord({ runtimeTools: [tool] }),
			);

			const checked = await checkPageCall(
				"page-1",
				tool,
				{ name: "fabric_share_frame", arguments: {} },
				viewer,
			);

			expect(refusalOf(checked).reason, tool).toBe("not_a_platform_tool");
		}
		expect(mocks.getAccessibleFrameById).not.toHaveBeenCalled();
	});

	it("refuses a connected server's own tool, even when the page's stored tools name it", async () => {
		for (const tool of ["gh__list_issues", "fabric_docs__search"]) {
			mocks.getAccessibleFrameById.mockResolvedValue(
				pageRecord({ runtimeTools: [tool] }),
			);

			const checked = await checkPageCall("page-1", tool, {}, viewer);

			expect(refusalOf(checked).reason, tool).toBe("not_a_platform_tool");
		}
	});

	it("refuses a page the viewer cannot open, as not found", async () => {
		mocks.getAccessibleFrameById.mockResolvedValue(null);

		const checked = await checkPageCall(
			"page-1",
			"fabric_list_frames",
			{},
			viewer,
		);

		expect(refusalOf(checked).reason).toBe("page_not_found");
	});

	it("refuses a viewer with no organization, as not found, without looking the page up", async () => {
		const checked = await checkPageCall(
			"page-1",
			"fabric_list_frames",
			{},
			{ ...viewer, organizationId: null as unknown as string },
		);

		expect(refusalOf(checked).reason).toBe("page_not_found");
		expect(mocks.getAccessibleFrameById).not.toHaveBeenCalled();
	});

	it("refuses a page that is not on a surface, which has no runtime", async () => {
		mocks.getAccessibleFrameById.mockResolvedValue(
			pageRecord({ surface: undefined }),
		);

		const checked = await checkPageCall(
			"page-1",
			"fabric_list_frames",
			{},
			viewer,
		);

		expect(refusalOf(checked).reason).toBe("page_has_no_runtime");
	});
});

describe("a read of the viewer's connected server", () => {
	const connectedArgs = { provider: "github", tool: "list_issues" };

	it("passes when the page declares exactly that provider and tool", async () => {
		mocks.getAccessibleFrameById.mockResolvedValue(
			pageRecord({ runtimeTools: ["connected:github/list_issues"] }),
		);

		const checked = await checkPageCall(
			"page-1",
			"fabric_page_read_connected",
			connectedArgs,
			viewer,
		);

		expect(checked).toEqual({
			ok: true,
			args: { ...connectedArgs, frameId: "page-1" },
		});
	});

	it("is not the same as declaring the tool by name, which does not declare a connected read", async () => {
		mocks.getAccessibleFrameById.mockResolvedValue(
			pageRecord({ runtimeTools: ["fabric_page_read_connected"] }),
		);

		const checked = await checkPageCall(
			"page-1",
			"fabric_page_read_connected",
			connectedArgs,
			viewer,
		);

		expect(refusalOf(checked).reason).toBe("tool_not_declared");
	});

	it.each([
		[
			"another tool of the provider",
			{ provider: "github", tool: "create_issue" },
		],
		[
			"the same tool of another provider",
			{ provider: "gitlab", tool: "list_issues" },
		],
		["no provider", { tool: "list_issues" }],
		["no tool", { provider: "github" }],
		[
			"a provider that is not a string",
			{ provider: 7, tool: "list_issues" },
		],
	])("refuses %s", async (_, args) => {
		const checked = await checkPageCall(
			"page-1",
			"fabric_page_read_connected",
			args,
			viewer,
		);

		expect(refusalOf(checked).reason).toBe("tool_not_declared");
	});
});
