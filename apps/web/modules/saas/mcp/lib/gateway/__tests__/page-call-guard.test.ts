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

import { checkPageCall as checkCall } from "../page-call-guard";
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
