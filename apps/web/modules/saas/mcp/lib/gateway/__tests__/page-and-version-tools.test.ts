/**
 * The tools that go with a page: who is viewing it, a read on the viewer's
 * connected server, and the page's versions, restore and fork.
 *
 * What these cases pin is what the gateway adds around the frame service and
 * the database: the page a call means (its own, or the Workspace the person has
 * open), that the caller must be able to open it, that a viewer is told no
 * more than their name, and that a fork's tools are checked like any page's.
 * Who may open which page is the database's; its answers are stubbed.
 *
 * Run with: pnpm --filter web test modules/saas/mcp/lib/gateway/__tests__/page-and-version-tools
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getAccessibleFrameById: vi.fn(),
	canUpdateOrganizationFrames: vi.fn(),
	getFrameEditHistory: vi.fn(),
	editCount: vi.fn(),
	userFindMany: vi.fn(),
	organizationFindUnique: vi.fn(),
	restoreFirstClassFrameVersion: vi.fn(),
	duplicateFirstClassFrame: vi.fn(),
	shareFirstClassFrame: vi.fn(),
	readConnectedTool: vi.fn(),
	connectedDeclarationRefusal: vi.fn(),
}));

vi.mock("@repo/api/modules/v1/instruction-direct-repository", () => ({
	getDirectRepositoryState: vi
		.fn()
		.mockResolvedValue({ availability: "UPLOAD", readState: "DIRECT" }),
}));

vi.mock("@repo/database", () => ({
	FRAME_SURFACES: ["artifact", "workspace"],
	getAccessibleFrameById: mocks.getAccessibleFrameById,
	canUpdateOrganizationFrames: mocks.canUpdateOrganizationFrames,
	getFrameEditHistory: mocks.getFrameEditHistory,
	db: {
		frameEditHistory: { count: mocks.editCount },
		user: { findMany: mocks.userFindMany },
		organization: { findUnique: mocks.organizationFindUnique },
	},
}));

vi.mock("@repo/temporal/frame-service", () => ({
	restoreFirstClassFrameVersion: mocks.restoreFirstClassFrameVersion,
	duplicateFirstClassFrame: mocks.duplicateFirstClassFrame,
	shareFirstClassFrame: mocks.shareFirstClassFrame,
}));

vi.mock("../connected-reads", () => ({
	readConnectedTool: mocks.readConnectedTool,
	connectedDeclarationRefusal: mocks.connectedDeclarationRefusal,
}));

import { executePlatformTool } from "../platform-tools";
import type { GatewaySession } from "../types";

const session: GatewaySession = {
	sessionId: "sess-1",
	userId: "viewer-1",
	organizationId: "org-1",
	projectId: null,
	userName: "Ada Lovelace",
	email: "ada@example.com",
	role: "user",
	credential: "session",
	scopes: ["*"],
	createdAt: new Date("2026-01-01T00:00:00Z"),
	expiresAt: new Date("2026-01-02T00:00:00Z"),
};

const onWorkspace = (workspaceId: string): GatewaySession => ({
	...session,
	credential: "service",
	actingContext: { workspaceId },
});

function payload(result: { content: Array<{ text: string }> }) {
	return JSON.parse(result.content[0].text);
}

function pageRecord(overrides: Record<string, unknown> = {}) {
	return {
		id: "frame-1",
		userId: "viewer-1",
		surface: "workspace",
		runtimeTools: [],
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getAccessibleFrameById.mockResolvedValue(pageRecord());
	mocks.canUpdateOrganizationFrames.mockResolvedValue(true);
	mocks.organizationFindUnique.mockResolvedValue({ slug: "example-org" });
	mocks.connectedDeclarationRefusal.mockResolvedValue(null);
	mocks.restoreFirstClassFrameVersion.mockResolvedValue({
		frameId: "frame-1",
		restoredVersion: 2,
		surface: "workspace",
	});
	mocks.duplicateFirstClassFrame.mockResolvedValue({
		frameId: "frame-2",
		surface: "workspace",
	});
});

describe("fabric_get_page_viewer", () => {
	it("tells the page who is viewing it: id, name, initials, and what they may do, and nothing else", async () => {
		const result = await executePlatformTool(
			"fabric_get_page_viewer",
			{ frameId: "frame-1" },
			session,
		);

		expect(payload(result)).toEqual({
			id: "viewer-1",
			name: "Ada Lovelace",
			initials: "AL",
			isOwner: true,
			canEditPage: true,
		});
		expect(JSON.stringify(payload(result))).not.toContain(
			"ada@example.com",
		);
	});

	it("says a viewer who does not own the page cannot edit it, without asking what their role allows", async () => {
		mocks.getAccessibleFrameById.mockResolvedValue(
			pageRecord({ userId: "owner-9" }),
		);

		const result = await executePlatformTool(
			"fabric_get_page_viewer",
			{ frameId: "frame-1" },
			session,
		);

		expect(payload(result)).toMatchObject({
			isOwner: false,
			canEditPage: false,
		});
	});

	it("says an owner whose organization role cannot update pages cannot edit this one", async () => {
		mocks.canUpdateOrganizationFrames.mockResolvedValue(false);

		const result = await executePlatformTool(
			"fabric_get_page_viewer",
			{ frameId: "frame-1" },
			session,
		);

		expect(payload(result)).toMatchObject({
			isOwner: true,
			canEditPage: false,
		});
		expect(mocks.canUpdateOrganizationFrames).toHaveBeenCalledWith(
			"viewer-1",
			"org-1",
		);
	});

	it.each([
		["Ada Lovelace", "AL"],
		["ada", "A"],
		["Jean-Luc Picard Jr", "JP"],
		["   ", "?"],
	])("makes the initials of %s %s", async (userName, initials) => {
		const result = await executePlatformTool(
			"fabric_get_page_viewer",
			{ frameId: "frame-1" },
			{ ...session, userName },
		);

		expect(payload(result).initials).toBe(initials);
	});

	it("means the Workspace the person has open when no page is named", async () => {
		await executePlatformTool(
			"fabric_get_page_viewer",
			{},
			onWorkspace("workspace-7"),
		);

		expect(mocks.getAccessibleFrameById).toHaveBeenCalledWith(
			expect.objectContaining({ id: "workspace-7", userId: "viewer-1" }),
		);
	});

	it("asks for a page when none is named and none is open", async () => {
		const result = await executePlatformTool(
			"fabric_get_page_viewer",
			{},
			session,
		);

		expect(result.isError).toBe(true);
		expect(payload(result).error).toContain("No page to act on");
		expect(payload(result).reason).toBe("no_page");
	});

	it("answers not found for a page the caller cannot open", async () => {
		mocks.getAccessibleFrameById.mockResolvedValue(null);

		const result = await executePlatformTool(
			"fabric_get_page_viewer",
			{ frameId: "frame-1" },
			session,
		);

		expect(result.isError).toBe(true);
		expect(payload(result).error).toBe("Frame not found.");
		expect(payload(result).reason).toBe("page_not_found");
	});
});

describe("fabric_page_read_connected", () => {
	const args = {
		frameId: "frame-1",
		provider: "github",
		tool: "list_issues",
		args: { repo: "example/repo" },
	};

	it("reads on the viewer's server when the page declares exactly that read", async () => {
		mocks.getAccessibleFrameById.mockResolvedValue(
			pageRecord({ runtimeTools: ["connected:github/list_issues"] }),
		);
		mocks.readConnectedTool.mockResolvedValue({
			content: [{ type: "text", text: '{"issues":[]}' }],
		});

		const result = await executePlatformTool(
			"fabric_page_read_connected",
			args,
			session,
		);

		expect(mocks.readConnectedTool).toHaveBeenCalledWith({
			provider: "github",
			tool: "list_issues",
			args: { repo: "example/repo" },
			session,
		});
		expect(result.content[0].text).toBe('{"issues":[]}');
	});

	it("checks the page's declaration again here, for a caller that did not come through the host page", async () => {
		mocks.getAccessibleFrameById.mockResolvedValue(
			pageRecord({ runtimeTools: ["connected:github/get_repo"] }),
		);

		const result = await executePlatformTool(
			"fabric_page_read_connected",
			args,
			session,
		);

		expect(result.isError).toBe(true);
		expect(payload(result).error).toBe(
			"This page does not declare connected:github/list_issues.",
		);
		expect(payload(result).reason).toBe("tool_not_declared");
		expect(mocks.readConnectedTool).not.toHaveBeenCalled();
	});

	it("sends no arguments when the page gives none that are an object", async () => {
		mocks.getAccessibleFrameById.mockResolvedValue(
			pageRecord({ runtimeTools: ["connected:github/list_issues"] }),
		);
		mocks.readConnectedTool.mockResolvedValue({ content: [] });

		for (const bad of [undefined, null, "x", ["a"]]) {
			mocks.readConnectedTool.mockClear();
			await executePlatformTool(
				"fabric_page_read_connected",
				{ ...args, args: bad },
				session,
			);

			expect(mocks.readConnectedTool.mock.calls[0][0].args).toEqual({});
		}
	});

	it("asks for a provider and a tool", async () => {
		const result = await executePlatformTool(
			"fabric_page_read_connected",
			{ frameId: "frame-1", provider: "github" },
			session,
		);

		expect(result.isError).toBe(true);
		expect(payload(result).error).toBe(
			"`provider` and `tool` are required.",
		);
		expect(payload(result).reason).toBe("tool");
	});

	it("is not a tool the service credential holds, since the person's connected servers are theirs", async () => {
		const result = await executePlatformTool(
			"fabric_page_read_connected",
			args,
			{
				...session,
				credential: "service",
				scopes: ["frames:read", "frames:write"],
			},
		);

		expect(result.isError).toBe(true);
		expect(payload(result).error).toBe(
			"fabric_page_read_connected is not available to this agent runtime.",
		);
		expect(mocks.readConnectedTool).not.toHaveBeenCalled();
	});
});

describe("fabric_list_frame_versions", () => {
	it.each(["project-2", null])(
		"reads no version metadata for project %s outside the page attachment",
		async (projectId) => {
			mocks.getAccessibleFrameById.mockResolvedValue(
				pageRecord({ projectId }),
			);
			const result = await executePlatformTool(
				"fabric_list_frame_versions",
				{ frameId: "frame-2" },
				{ ...session, pageProjectId: "project-1" },
			);
			expect(result.isError).toBe(true);
			expect(mocks.getFrameEditHistory).not.toHaveBeenCalled();
			expect(mocks.editCount).not.toHaveBeenCalled();
			expect(mocks.userFindMany).not.toHaveBeenCalled();
		},
	);

	beforeEach(() => {
		mocks.getFrameEditHistory.mockResolvedValue([
			{
				editType: "REVERT",
				editedBy: "owner-9",
				editedAt: new Date("2026-10-03T10:00:00Z"),
				revertedToVersion: 1,
			},
			{
				editType: "AI_EDIT",
				editedBy: "viewer-1",
				editedAt: new Date("2026-10-02T10:00:00Z"),
				revertedToVersion: null,
			},
			{
				editType: "MANUAL_EDIT",
				editedBy: "gone-user",
				editedAt: new Date("2026-10-01T10:00:00Z"),
				revertedToVersion: null,
			},
		]);
		mocks.editCount.mockResolvedValue(3);
		mocks.userFindMany.mockResolvedValue([
			{ id: "owner-9", name: "Grace Hopper" },
			{ id: "viewer-1", name: "Ada Lovelace" },
		]);
	});

	it("lists the versions newest first, numbered from the oldest, with who made each", async () => {
		const result = await executePlatformTool(
			"fabric_list_frame_versions",
			{ frameId: "frame-1" },
			session,
		);

		const { versions, frameId, note } = payload(result);
		expect(frameId).toBe("frame-1");
		expect(note).toContain("Version N is the page as it was before edit N");
		expect(
			versions.map((entry: { version: number }) => entry.version),
		).toEqual([3, 2, 1]);
		expect(versions[0]).toEqual({
			version: 3,
			editType: "REVERT",
			editedBy: { id: "owner-9", name: "Grace Hopper" },
			editedAt: "2026-10-03T10:00:00.000Z",
			revertedToVersion: 1,
		});
		expect(versions[1].editedBy.name).toBe("Ada Lovelace");
		expect(versions[2].editedBy).toEqual({ id: "gone-user", name: null });
		expect(versions[2]).not.toHaveProperty("revertedToVersion");
	});

	it("lists no version content, only who and when", async () => {
		const result = await executePlatformTool(
			"fabric_list_frame_versions",
			{ frameId: "frame-1" },
			session,
		);

		for (const entry of payload(result).versions) {
			expect(Object.keys(entry).sort()).not.toContain("snapshot");
			expect(Object.keys(entry).sort()).not.toContain("blocks");
		}
	});

	it("limits the list to what the caller asks for, within 1 and 200", async () => {
		for (const [limit, expected] of [
			[5, 5],
			[0, 1],
			[9_999, 200],
			[undefined, 50],
			["7", 50],
		] as const) {
			mocks.getFrameEditHistory.mockClear();

			await executePlatformTool(
				"fabric_list_frame_versions",
				{ frameId: "frame-1", limit },
				session,
			);

			expect(mocks.getFrameEditHistory).toHaveBeenCalledWith(
				"frame-1",
				expected,
			);
		}
	});

	it("answers not found, and reads no history, for a page the caller cannot open", async () => {
		mocks.getAccessibleFrameById.mockResolvedValue(null);

		const result = await executePlatformTool(
			"fabric_list_frame_versions",
			{ frameId: "frame-1" },
			session,
		);

		expect(result.isError).toBe(true);
		expect(mocks.getFrameEditHistory).not.toHaveBeenCalled();
	});

	it("means the Workspace the person has open when no page is named", async () => {
		await executePlatformTool(
			"fabric_list_frame_versions",
			{},
			onWorkspace("workspace-7"),
		);

		expect(mocks.getFrameEditHistory).toHaveBeenCalledWith(
			"workspace-7",
			50,
		);
	});
});

describe("fabric_restore_frame_version", () => {
	it("restores as the caller, in their organization, and says where the page is", async () => {
		const result = await executePlatformTool(
			"fabric_restore_frame_version",
			{ frameId: "frame-1", version: 2 },
			session,
		);

		expect(mocks.restoreFirstClassFrameVersion).toHaveBeenCalledWith({
			args: { frameId: "frame-1", version: 2 },
			userId: "viewer-1",
			userEmail: "ada@example.com",
			organizationId: "org-1",
		});
		expect(payload(result)).toMatchObject({
			frameId: "frame-1",
			restoredVersion: 2,
			pageUrl: "/app/example-org/workspaces/frame-1",
		});
	});

	it("restores the Workspace the person has open when no page is named", async () => {
		await executePlatformTool(
			"fabric_restore_frame_version",
			{ version: 1 },
			onWorkspace("workspace-7"),
		);

		expect(
			mocks.restoreFirstClassFrameVersion.mock.calls[0][0].args,
		).toEqual({ version: 1, frameId: "workspace-7" });
	});

	it("reports the service's refusal as an error", async () => {
		mocks.restoreFirstClassFrameVersion.mockResolvedValue({
			error: "Only the page's owner can restore a version.",
		});

		const result = await executePlatformTool(
			"fabric_restore_frame_version",
			{ frameId: "frame-1", version: 2 },
			session,
		);

		expect(result.isError).toBe(true);
		expect(payload(result).error).toContain("Only the page's owner");
	});

	it("needs the frames:write scope", async () => {
		const result = await executePlatformTool(
			"fabric_restore_frame_version",
			{ frameId: "frame-1", version: 2 },
			{ ...session, credential: "personal-key", scopes: ["frames:read"] },
		);

		expect(result.isError).toBe(true);
		expect(payload(result).error).toContain("frames:write");
		expect(mocks.restoreFirstClassFrameVersion).not.toHaveBeenCalled();
	});
});

describe("fabric_duplicate_frame", () => {
	it("forks the page for the caller, with no tools unless they pass some", async () => {
		const result = await executePlatformTool(
			"fabric_duplicate_frame",
			{ frameId: "frame-1", title: "My copy" },
			session,
		);

		expect(mocks.duplicateFirstClassFrame).toHaveBeenCalledWith({
			args: { frameId: "frame-1", title: "My copy" },
			userId: "viewer-1",
			userEmail: "ada@example.com",
			organizationId: "org-1",
			runtimeTools: undefined,
			conversationId: undefined,
			sourceRunType: "MCP_GATEWAY",
			sourceRunId: "sess-1",
		});
		expect(payload(result)).toMatchObject({
			frameId: "frame-2",
			pageUrl: "/app/example-org/workspaces/frame-2",
		});
	});

	it("files the copy under the conversation the chat is in", async () => {
		await executePlatformTool(
			"fabric_duplicate_frame",
			{ frameId: "frame-1" },
			{
				...session,
				credential: "service",
				actingContext: { conversationId: "conv-1" },
			},
		);

		expect(mocks.duplicateFirstClassFrame.mock.calls[0][0]).toMatchObject({
			conversationId: "conv-1",
		});
	});

	it("hands on the tools the caller passes, once each is a tool a page may call", async () => {
		await executePlatformTool(
			"fabric_duplicate_frame",
			{ frameId: "frame-1", runtimeTools: ["fabric_list_frames"] },
			session,
		);

		expect(
			mocks.duplicateFirstClassFrame.mock.calls[0][0].runtimeTools,
		).toEqual(["fabric_list_frames"]);
	});

	it.each([
		"fabric_share_frame",
		"fabric_create_workflow",
		"fabric_no_such_tool",
	])(
		"refuses a fork that declares %s, without making the copy",
		async (tool) => {
			const result = await executePlatformTool(
				"fabric_duplicate_frame",
				{ frameId: "frame-1", runtimeTools: [tool] },
				session,
			);

			expect(result.isError).toBe(true);
			expect(payload(result).error).toContain(tool);
			expect(mocks.duplicateFirstClassFrame).not.toHaveBeenCalled();
		},
	);

	it("checks a connected read a fork declares against the forker's own servers", async () => {
		mocks.connectedDeclarationRefusal.mockResolvedValue(
			"connected:github/list_issues can only be declared by someone who has github connected.",
		);

		const result = await executePlatformTool(
			"fabric_duplicate_frame",
			{
				frameId: "frame-1",
				runtimeTools: ["connected:github/list_issues"],
			},
			session,
		);

		expect(mocks.connectedDeclarationRefusal).toHaveBeenCalledWith(
			[{ provider: "github", tool: "list_issues" }],
			session,
		);
		expect(result.isError).toBe(true);
		expect(mocks.duplicateFirstClassFrame).not.toHaveBeenCalled();
	});

	it("forks the Workspace the person has open when no page is named", async () => {
		await executePlatformTool(
			"fabric_duplicate_frame",
			{},
			onWorkspace("workspace-7"),
		);

		expect(mocks.duplicateFirstClassFrame.mock.calls[0][0].args).toEqual({
			frameId: "workspace-7",
		});
	});

	it("reports the service's refusal as an error", async () => {
		mocks.duplicateFirstClassFrame.mockResolvedValue({
			error: "Frame not found.",
		});

		const result = await executePlatformTool(
			"fabric_duplicate_frame",
			{ frameId: "frame-1" },
			session,
		);

		expect(result.isError).toBe(true);
	});
});

describe("fabric_share_frame", () => {
	it("hands the scope and the emails to the service, as the caller, and answers what it did", async () => {
		mocks.shareFirstClassFrame.mockResolvedValue({
			frameId: "frame-1",
			scope: "EMAILS_ONLY",
			invited: ["lee@example.com"],
		});
		const args = {
			frameId: "frame-1",
			scope: "EMAILS_ONLY",
			emails: ["lee@example.com"],
		};

		const result = await executePlatformTool(
			"fabric_share_frame",
			args,
			session,
		);

		expect(mocks.shareFirstClassFrame).toHaveBeenCalledWith({
			args,
			userId: "viewer-1",
			organizationId: "org-1",
		});
		expect(payload(result)).toMatchObject({
			scope: "EMAILS_ONLY",
			invited: ["lee@example.com"],
		});
	});

	it("reports the service's refusal as an error", async () => {
		mocks.shareFirstClassFrame.mockResolvedValue({
			error: "Public sharing is disabled for this organization.",
		});

		const result = await executePlatformTool(
			"fabric_share_frame",
			{ frameId: "frame-1" },
			session,
		);

		expect(result.isError).toBe(true);
		expect(payload(result).error).toBe(
			"Public sharing is disabled for this organization.",
		);
	});
});

describe("the page and version tools on a connection to one project", () => {
	it.each([
		"fabric_get_page_viewer",
		"fabric_page_data_list",
		"fabric_list_frame_versions",
		"fabric_restore_frame_version",
		"fabric_duplicate_frame",
	])(
		"%s is not available there, because every tool of these families is organization-wide",
		async (tool) => {
			const result = await executePlatformTool(
				tool,
				{ frameId: "frame-1" },
				{ ...session, projectId: "project-1" },
			);

			expect(result.isError).toBe(true);
			expect(payload(result).error).toContain("not available");
		},
	);
});
