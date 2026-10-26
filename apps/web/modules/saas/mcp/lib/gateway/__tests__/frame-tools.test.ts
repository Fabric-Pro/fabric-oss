/**
 * The frame tools place and read pages on the two surfaces: a project's
 * Artifacts tab and an organization's Workspaces.
 *
 * What these cases pin is what the gateway adds around the frame service: the
 * runtime tools a page declares must be tools of the table (and not session
 * tools), a new frame goes to the project the user is in unless it is a
 * Workspace, an update or read with no id means the Workspace the user has
 * open, and the caller's identity and organization reach the service unchanged.
 * Who may open which frame is the service's and the database's; their tests
 * cover the matrix of owner, organization member, project member, non-member
 * and another organization.
 *
 * `@repo/temporal/frame-service` and `@repo/database` are mocked: the handlers
 * reach them through dynamic `await import(...)`, so the mocks intercept inside
 * the handler body.
 *
 * Run with: pnpm --filter web test modules/saas/mcp/lib/gateway/__tests__/frame-tools
 */

import { FABRIC_PROJECT_READ_TOOL_DEFINITIONS } from "@repo/temporal/fabric-project-read-tool-definitions";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	createFirstClassFrame: vi.fn(),
	updateFirstClassFrame: vi.fn(),
	editFirstClassFrameBlock: vi.fn(),
	getFirstClassFrame: vi.fn(),
	listFirstClassFrames: vi.fn(),
	shareFirstClassFrame: vi.fn(),
	organizationFindUnique: vi.fn(),
}));

vi.mock("@repo/api/modules/v1/instruction-direct-repository", () => ({
	getDirectRepositoryState: vi
		.fn()
		.mockResolvedValue({ availability: "UPLOAD", readState: "DIRECT" }),
}));

vi.mock("@repo/temporal/frame-service", () => ({
	createFirstClassFrame: mocks.createFirstClassFrame,
	updateFirstClassFrame: mocks.updateFirstClassFrame,
	editFirstClassFrameBlock: mocks.editFirstClassFrameBlock,
	getFirstClassFrame: mocks.getFirstClassFrame,
	listFirstClassFrames: mocks.listFirstClassFrames,
	shareFirstClassFrame: mocks.shareFirstClassFrame,
}));

vi.mock("@repo/database", () => ({
	FRAME_SURFACES: ["artifact", "workspace"],
	db: { organization: { findUnique: mocks.organizationFindUnique } },
}));

import {
	executePlatformTool,
	PLATFORM_TOOL_DEFINITIONS,
} from "../platform-tools";
import type { GatewaySession } from "../types";

const session: GatewaySession = {
	sessionId: "sess-1",
	userId: "user-1",
	organizationId: "org-1",
	userName: "Example Agent",
	email: "agent@example.com",
	role: "user",
	credential: "session",
	scopes: ["*"],
	createdAt: new Date("2026-01-01T00:00:00Z"),
	expiresAt: new Date("2026-01-02T00:00:00Z"),
};

const inProject = (projectId: string): GatewaySession => ({
	...session,
	credential: "service",
	actingContext: { projectId },
});

const onWorkspace = (
	workspaceId: string,
	projectId?: string,
): GatewaySession => ({
	...session,
	credential: "service",
	actingContext: { workspaceId, projectId },
});

const blocks = [{ id: "page", type: "html", content: "<p>page</p>" }];

function payload(result: { content: Array<{ text: string }> }) {
	return JSON.parse(result.content[0].text);
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.createFirstClassFrame.mockResolvedValue({
		frameId: "frame-1",
		surface: "workspace",
	});
	mocks.updateFirstClassFrame.mockResolvedValue({ frameId: "frame-1" });
	mocks.getFirstClassFrame.mockResolvedValue({ frameId: "frame-1" });
	mocks.listFirstClassFrames.mockResolvedValue({ frames: [] });
	mocks.organizationFindUnique.mockResolvedValue({ slug: "example-org" });
});

describe("frame tool definitions", () => {
	const definition = (name: string) => {
		const tool = PLATFORM_TOOL_DEFINITIONS.find((t) => t.name === name);
		if (!tool) {
			throw new Error(`no tool ${name}`);
		}
		return tool;
	};

	it("teaches the page runtime where a page is created", () => {
		const { description } = definition("fabric_create_frame");
		expect(description).toContain("fabric.call(tool, args)");
		expect(description).toContain("runtimeTools");
		expect(description).toContain("fabric.openAgent");
		expect(description).toContain("fabric.navigate");
	});

	it("marks the reads read-only, so the page runtime runs them without asking", () => {
		expect(definition("fabric_list_frames").annotations?.readOnlyHint).toBe(
			true,
		);
		expect(definition("fabric_get_frame").annotations?.readOnlyHint).toBe(
			true,
		);
		expect(
			definition("fabric_create_frame").annotations?.readOnlyHint,
		).toBe(false);
		expect(
			definition("fabric_update_frame").annotations?.readOnlyHint,
		).toBe(false);
	});

	it("asks for a frame write only when it gives the page tools or changes who can see or what the page is, and for no other", () => {
		const policy = (name: string) => definition(name)._meta;

		for (const name of [
			"fabric_create_frame",
			"fabric_update_frame",
			"fabric_duplicate_frame",
		]) {
			expect(policy(name), name).toEqual({
				"fabric/confirm": { whenArgumentPresent: "runtimeTools" },
			});
		}
		for (const name of [
			"fabric_share_frame",
			"fabric_restore_frame_version",
		]) {
			expect(policy(name), name).toEqual({ "fabric/confirm": true });
		}
		for (const name of [
			"fabric_get_frame",
			"fabric_list_frames",
			"fabric_list_frame_versions",
			"fabric_create_slideshow",
		]) {
			expect(policy(name), name).toBeUndefined();
		}
	});

	it("takes the surface, the project and the declared tools on create", () => {
		const { properties } = definition("fabric_create_frame")
			.inputSchema as {
			properties: Record<string, unknown>;
		};
		expect(Object.keys(properties)).toEqual(
			expect.arrayContaining([
				"blocks",
				"surface",
				"projectId",
				"runtimeTools",
			]),
		);
	});

	it("does not require a frame id to update or read the open Workspace", () => {
		for (const name of ["fabric_update_frame", "fabric_get_frame"]) {
			expect(definition(name).inputSchema.required).toBeUndefined();
		}
	});

	it("requires the frames:write scope to create and frames:read to list", async () => {
		const readOnlyKey: GatewaySession = {
			...session,
			credential: "personal-key",
			scopes: ["frames:read"],
		};
		const refused = await executePlatformTool(
			"fabric_create_frame",
			{ title: "Page", blocks },
			readOnlyKey,
		);
		expect(refused.isError).toBe(true);
		expect(payload(refused).error).toContain("frames:write");
		expect(mocks.createFirstClassFrame).not.toHaveBeenCalled();

		const listed = await executePlatformTool(
			"fabric_list_frames",
			{},
			readOnlyKey,
		);
		expect(listed.isError).toBeUndefined();
	});
});

describe("fabric_create_frame", () => {
	it("refuses the chat-only feature tool with actionable canonical discovery guidance", async () => {
		const result = await executePlatformTool(
			"fabric_create_frame",
			{
				title: "Dashboard",
				surface: "workspace",
				blocks,
				runtimeTools: ["fabric_list_project_features"],
			},
			session,
		);
		expect(result.isError).toBe(true);
		expect(payload(result).error).toContain("fabric_list_page_tools");
		expect(payload(result).error).toContain(
			"fabric_list_features with required projectId",
		);
		expect(mocks.createFirstClassFrame).not.toHaveBeenCalled();
	});

	it("accepts the gateway's actual project reads in a Workspace", async () => {
		const result = await executePlatformTool(
			"fabric_create_frame",
			{
				title: "Dashboard",
				surface: "workspace",
				blocks,
				runtimeTools: [
					"fabric_list_features",
					"fabric_list_project_instructions",
				],
			},
			session,
		);
		expect(result.isError).toBeUndefined();
		expect(mocks.createFirstClassFrame).toHaveBeenCalledOnce();
	});
	it("refuses a declared tool that is not in the tool table, without creating the page", async () => {
		const result = await executePlatformTool(
			"fabric_create_frame",
			{
				title: "Page",
				surface: "workspace",
				blocks,
				runtimeTools: ["fabric_list_workflows", "fabric_not_a_tool"],
			},
			session,
		);

		expect(result.isError).toBe(true);
		expect(payload(result).error).toContain("fabric_not_a_tool");
		expect(payload(result).error).not.toContain("fabric_list_workflows");
		expect(mocks.createFirstClassFrame).not.toHaveBeenCalled();
	});

	it("refuses tools that change the viewer's session, publish a frame, set up an unattended agent or write pages, whichever page asks", async () => {
		for (const tool of [
			"fabric_switch_organization",
			"fabric_request_authority",
			"fabric_revoke_authority",
			"fabric_share_frame",
			"fabric_create_workflow",
			"fabric_update_workflow",
			"fabric_publish_workflow",
			"fabric_create_frame",
			"fabric_update_frame",
		]) {
			const result = await executePlatformTool(
				"fabric_create_frame",
				{ title: "Page", blocks, runtimeTools: [tool] },
				session,
			);
			expect(result.isError, tool).toBe(true);
		}
		expect(mocks.createFirstClassFrame).not.toHaveBeenCalled();
	});

	it("hands declared tools of the table to the service with the caller's identity", async () => {
		await executePlatformTool(
			"fabric_create_frame",
			{
				title: "Page",
				surface: "workspace",
				blocks,
				runtimeTools: ["fabric_list_workflows", "fabric_get_frame"],
			},
			session,
		);

		expect(mocks.createFirstClassFrame).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "user-1",
				organizationId: "org-1",
				runtimeTools: ["fabric_list_workflows", "fabric_get_frame"],
				shareScope: undefined,
			}),
		);
	});

	it("keeps a Workspace to its owner only when asked", async () => {
		await executePlatformTool(
			"fabric_create_frame",
			{
				title: "Drafts",
				surface: "workspace",
				blocks,
				sharedWithOrganization: false,
			},
			session,
		);

		expect(mocks.createFirstClassFrame).toHaveBeenCalledWith(
			expect.objectContaining({ shareScope: "PRIVATE" }),
		);
	});

	it("leaves the shape of the tool list to the service", async () => {
		await executePlatformTool(
			"fabric_create_frame",
			{ title: "Page", blocks, runtimeTools: "fabric_get_frame" },
			session,
		);
		expect(mocks.createFirstClassFrame).toHaveBeenCalledTimes(1);
	});

	it("places the page in the project the user is in when none is named", async () => {
		await executePlatformTool(
			"fabric_create_frame",
			{ title: "Report", surface: "artifact", blocks },
			inProject("project-1"),
		);

		expect(mocks.createFirstClassFrame).toHaveBeenCalledWith(
			expect.objectContaining({ projectId: "project-1" }),
		);
	});

	it("prefers the project the caller names over the one the user is in", async () => {
		await executePlatformTool(
			"fabric_create_frame",
			{
				title: "Report",
				surface: "artifact",
				blocks,
				projectId: " project-2 ",
			},
			inProject("project-1"),
		);

		expect(mocks.createFirstClassFrame).toHaveBeenCalledWith(
			expect.objectContaining({ projectId: "project-2" }),
		);
	});

	it("places no project on a call that has none to use", async () => {
		await executePlatformTool(
			"fabric_create_frame",
			{ title: "Report", blocks },
			session,
		);

		expect(mocks.createFirstClassFrame).toHaveBeenCalledWith(
			expect.objectContaining({ projectId: undefined }),
		);
	});

	it("keeps a new Workspace out of the project the user happens to be in", async () => {
		await executePlatformTool(
			"fabric_create_frame",
			{ title: "Delivery", surface: "workspace", blocks },
			inProject("project-1"),
		);

		expect(mocks.createFirstClassFrame).toHaveBeenCalledWith(
			expect.objectContaining({ projectId: undefined }),
		);
	});

	it("links a new Workspace to a project only when one is named", async () => {
		await executePlatformTool(
			"fabric_create_frame",
			{
				title: "Delivery",
				surface: "workspace",
				blocks,
				projectId: "project-2",
			},
			inProject("project-1"),
		);

		expect(mocks.createFirstClassFrame).toHaveBeenCalledWith(
			expect.objectContaining({ projectId: "project-2" }),
		);
	});

	it("tells where a Workspace page can be opened", async () => {
		const result = await executePlatformTool(
			"fabric_create_frame",
			{ title: "Delivery", surface: "workspace", blocks },
			session,
		);

		expect(payload(result)).toMatchObject({
			frameId: "frame-1",
			pageUrl: "/app/example-org/workspaces/frame-1",
		});
	});

	it("answers with where the page is, not the page: its content is neither echoed to the model nor allowed to overrun a tool result", async () => {
		mocks.createFirstClassFrame.mockResolvedValueOnce({
			frameId: "frame-1",
			surface: "workspace",
			title: "Delivery",
			content: "<p>".padEnd(60_000, "x"),
		});

		const result = await executePlatformTool(
			"fabric_create_frame",
			{ title: "Delivery", surface: "workspace", blocks },
			session,
		);

		expect(payload(result)).not.toHaveProperty("content");
		expect(payload(result)).toMatchObject({
			frameId: "frame-1",
			title: "Delivery",
		});
		expect(result.content[0].text.length).toBeLessThan(2_000);
	});

	it("answers a slideshow the same way", async () => {
		mocks.createFirstClassFrame.mockResolvedValueOnce({
			frameId: "frame-9",
			kind: "slideshow",
			content: "<section>".padEnd(60_000, "x"),
		});

		const result = await executePlatformTool(
			"fabric_create_slideshow",
			{ title: "Deck", blocks },
			session,
		);

		expect(payload(result)).toEqual({
			frameId: "frame-9",
			kind: "slideshow",
		});
	});

	it("files the page under the conversation the chat is in", async () => {
		await executePlatformTool(
			"fabric_create_frame",
			{ title: "Report", blocks },
			{
				...session,
				credential: "service",
				actingContext: { conversationId: "conversation-1" },
			},
		);
		await executePlatformTool(
			"fabric_create_slideshow",
			{ title: "Deck", blocks },
			{
				...session,
				credential: "service",
				actingContext: { conversationId: "conversation-1" },
			},
		);

		expect(
			mocks.createFirstClassFrame.mock.calls.map(
				([call]) => call.conversationId,
			),
		).toEqual(["conversation-1", "conversation-1"]);
	});

	it("records the page's generation against the conversation the chat is in", async () => {
		const description = {
			title: "Report",
			description: "Open work by status",
		};
		await executePlatformTool("fabric_create_frame", description, {
			...session,
			credential: "service",
			actingContext: { conversationId: "conversation-1" },
		});
		await executePlatformTool("fabric_create_slideshow", description, {
			...session,
			credential: "service",
			actingContext: { conversationId: "conversation-1" },
		});
		await executePlatformTool("fabric_create_frame", description, session);

		expect(
			mocks.createFirstClassFrame.mock.calls.map(
				([call]) => call.usageConversationId,
			),
		).toEqual(["conversation-1", "conversation-1", undefined]);
	});

	it("puts the page where the chat was opened when the caller names no surface", async () => {
		const opened = (surface: "artifact" | "workspace"): GatewaySession => ({
			...session,
			credential: "service",
			actingContext: { surface },
		});

		await executePlatformTool(
			"fabric_create_frame",
			{ title: "Delivery", blocks },
			opened("workspace"),
		);
		await executePlatformTool(
			"fabric_create_frame",
			{ title: "Delivery", surface: "artifact", blocks },
			opened("workspace"),
		);

		const surfaces = mocks.createFirstClassFrame.mock.calls.map(
			([call]) => call.args.surface,
		);
		expect(surfaces).toEqual(["workspace", "artifact"]);
	});

	it("tells where an artifact appears, and skips the lookup for a loose frame", async () => {
		mocks.createFirstClassFrame.mockResolvedValueOnce({
			frameId: "frame-2",
			surface: "artifact",
			projectId: "project-1",
		});
		const artifact = await executePlatformTool(
			"fabric_create_frame",
			{ title: "Report", surface: "artifact", blocks },
			inProject("project-1"),
		);
		expect(payload(artifact).pageUrl).toBe(
			"/app/example-org/projects/project-1?tab=artifacts",
		);

		mocks.organizationFindUnique.mockClear();
		mocks.createFirstClassFrame.mockResolvedValueOnce({
			frameId: "frame-3",
		});
		await executePlatformTool(
			"fabric_create_frame",
			{ title: "Loose", blocks },
			session,
		);
		expect(mocks.organizationFindUnique).not.toHaveBeenCalled();
	});

	it("reports the service's refusal as an error", async () => {
		mocks.createFirstClassFrame.mockResolvedValueOnce({
			error: "Project not found.",
		});

		const result = await executePlatformTool(
			"fabric_create_frame",
			{
				title: "Report",
				surface: "artifact",
				blocks,
				projectId: "other",
			},
			session,
		);

		expect(result.isError).toBe(true);
		expect(payload(result).error).toBe("Project not found.");
	});
});

describe("fabric_list_page_tools", () => {
	it("returns only actual page-compatible tools and their exact schemas", async () => {
		const result = await executePlatformTool(
			"fabric_list_page_tools",
			{ query: "fabric_list_features" },
			session,
		);
		const data = payload(result);
		expect(data.tools).toHaveLength(1);
		const definition = PLATFORM_TOOL_DEFINITIONS.find(
			(tool) => tool.name === "fabric_list_features",
		);
		expect(data.tools[0]).toMatchObject({
			name: definition?.name,
			inputSchema: definition?.inputSchema,
			annotations: definition?.annotations,
		});
		expect(data.tools[0].inputSchema.required).toContain("projectId");
	});

	it("excludes session-changing, authoring and chat-only tools", async () => {
		for (const query of [
			"fabric_list_project_features",
			"fabric_create_frame",
			"fabric_switch_organization",
			"fabric_list_page_tools",
			"fabric_page_read_connected",
		]) {
			const result = await executePlatformTool(
				"fabric_list_page_tools",
				{ query },
				session,
			);
			expect(payload(result).tools, query).toEqual([]);
		}
	});

	it("bounds returned schemas and offers query narrowing without truncating individual schemas", async () => {
		const result = await executePlatformTool(
			"fabric_list_page_tools",
			{ limit: 1 },
			session,
		);
		expect(payload(result)).toMatchObject({
			hasMore: true,
			tools: [
				expect.objectContaining({ inputSchema: expect.any(Object) }),
			],
		});
		expect(payload(result).tools).toHaveLength(1);
	});

	it("shares all six project/instruction schemas unchanged with the gateway", () => {
		for (const definition of FABRIC_PROJECT_READ_TOOL_DEFINITIONS) {
			expect(
				PLATFORM_TOOL_DEFINITIONS.find(
					(tool) => tool.name === definition.name,
				)?.inputSchema,
			).toEqual(definition.inputSchema);
		}
	});
});

describe("fabric_update_frame", () => {
	it("updates the Workspace the user has open when no frame is named", async () => {
		await executePlatformTool(
			"fabric_update_frame",
			{ blocks },
			onWorkspace("workspace-1"),
		);

		expect(mocks.updateFirstClassFrame).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "user-1",
				organizationId: "org-1",
				args: expect.objectContaining({
					frameId: "workspace-1",
					blocks,
				}),
			}),
		);
	});

	it("updates the frame the caller names, not the open Workspace", async () => {
		await executePlatformTool(
			"fabric_update_frame",
			{ frameId: "frame-9", blocks },
			onWorkspace("workspace-1"),
		);

		expect(mocks.updateFirstClassFrame).toHaveBeenCalledWith(
			expect.objectContaining({
				args: expect.objectContaining({ frameId: "frame-9" }),
			}),
		);
	});

	it("asks for a frame id when none is named and no Workspace is open", async () => {
		await executePlatformTool("fabric_update_frame", { blocks }, session);

		const { args } = mocks.updateFirstClassFrame.mock.calls[0][0];
		expect(args.frameId).toBeUndefined();
	});

	it("checks the tools a page declares on update, too", async () => {
		const result = await executePlatformTool(
			"fabric_update_frame",
			{ frameId: "frame-1", runtimeTools: ["fabric_not_a_tool"] },
			session,
		);

		expect(result.isError).toBe(true);
		expect(mocks.updateFirstClassFrame).not.toHaveBeenCalled();
	});
});

describe("fabric_get_frame", () => {
	it("passes bounded source arguments and viewer context through the ordinary gateway", async () => {
		const content = '"\n\\\u0000😀'.repeat(600);
		const source = {
			source: true,
			frameId: "frame-1",
			title: "Example",
			updatedAt: "2026-10-14T10:00:00.000Z",
			block: { id: "page", type: "html", content },
			offset: 0,
			returnedLength: content.length,
			totalChars: content.length + 1,
			nextOffset: content.length,
			complete: false,
		};
		mocks.getFirstClassFrame.mockResolvedValueOnce(source);
		const result = await executePlatformTool(
			"fabric_get_frame",
			{ blockId: "page", offset: 0, limit: 6_000 },
			onWorkspace("frame-1"),
		);
		expect(mocks.getFirstClassFrame).toHaveBeenCalledWith({
			args: {
				frameId: "frame-1",
				blockId: "page",
				offset: 0,
				limit: 6_000,
			},
			userId: "user-1",
			userEmail: "agent@example.com",
			organizationId: "org-1",
		});
		expect(payload(result)).toEqual(source);
		expect(result.content[0].text.length).toBeLessThanOrEqual(10_000);
		expect(JSON.stringify(payload(result)).length).toBeLessThan(12_000);
	});

	it("reads the open Workspace by default, as the caller, in their organization", async () => {
		await executePlatformTool(
			"fabric_get_frame",
			{},
			onWorkspace("workspace-1"),
		);

		expect(mocks.getFirstClassFrame).toHaveBeenCalledWith({
			args: { frameId: "workspace-1" },
			userId: "user-1",
			userEmail: "agent@example.com",
			organizationId: "org-1",
		});
	});

	it("answers not found as an error", async () => {
		mocks.getFirstClassFrame.mockResolvedValueOnce({
			error: "Frame not found.",
		});

		const result = await executePlatformTool(
			"fabric_get_frame",
			{ frameId: "frame-1" },
			session,
		);

		expect(result.isError).toBe(true);
	});
});

describe("fabric_list_frames", () => {
	it("carries the page restriction to frame get and list without trusting the requested project", async () => {
		const pageSession = { ...session, pageProjectId: "project-1" };
		await executePlatformTool(
			"fabric_get_frame",
			{ frameId: "frame-2" },
			pageSession,
		);
		await executePlatformTool(
			"fabric_list_frames",
			{ projectId: "project-2" },
			pageSession,
		);
		expect(mocks.getFirstClassFrame).toHaveBeenCalledWith(
			expect.objectContaining({
				projectRestrictionId: "project-1",
				args: { frameId: "frame-2" },
			}),
		);
		expect(mocks.listFirstClassFrames).toHaveBeenCalledWith(
			expect.objectContaining({
				projectRestrictionId: "project-1",
				projectId: "project-2",
			}),
		);
	});
	it("lists the caller's own frames when told nothing else", async () => {
		await executePlatformTool(
			"fabric_list_frames",
			{},
			inProject("project-1"),
		);

		expect(mocks.listFirstClassFrames).toHaveBeenCalledWith({
			userId: "user-1",
			organizationId: "org-1",
			surface: undefined,
			projectId: undefined,
		});
	});

	it("lists the Workspaces without narrowing to the project the user is in", async () => {
		await executePlatformTool(
			"fabric_list_frames",
			{ surface: "workspace" },
			inProject("project-1"),
		);

		expect(mocks.listFirstClassFrames).toHaveBeenCalledWith(
			expect.objectContaining({
				surface: "workspace",
				projectId: undefined,
			}),
		);
	});

	it("lists the artifacts of the project the user is in by default", async () => {
		await executePlatformTool(
			"fabric_list_frames",
			{ surface: "artifact" },
			inProject("project-1"),
		);

		expect(mocks.listFirstClassFrames).toHaveBeenCalledWith(
			expect.objectContaining({
				surface: "artifact",
				projectId: "project-1",
			}),
		);
	});

	it("lists the artifacts of the project the caller names", async () => {
		await executePlatformTool(
			"fabric_list_frames",
			{ surface: "artifact", projectId: "project-2" },
			inProject("project-1"),
		);

		expect(mocks.listFirstClassFrames).toHaveBeenCalledWith(
			expect.objectContaining({ projectId: "project-2" }),
		);
	});

	it("refuses a surface that does not exist", async () => {
		const result = await executePlatformTool(
			"fabric_list_frames",
			{ surface: "dashboard" },
			session,
		);

		expect(result.isError).toBe(true);
		expect(mocks.listFirstClassFrames).not.toHaveBeenCalled();
	});

	it("adds the page address of each frame that lives on a surface", async () => {
		mocks.listFirstClassFrames.mockResolvedValueOnce({
			frames: [
				{ frameId: "workspace-1", surface: "workspace" },
				{
					frameId: "artifact-1",
					surface: "artifact",
					projectId: "project-1",
				},
				{ frameId: "loose-1" },
			],
		});

		const result = await executePlatformTool(
			"fabric_list_frames",
			{},
			session,
		);

		expect(payload(result).frames).toEqual([
			{
				frameId: "workspace-1",
				surface: "workspace",
				pageUrl: "/app/example-org/workspaces/workspace-1",
			},
			{
				frameId: "artifact-1",
				surface: "artifact",
				projectId: "project-1",
				pageUrl: "/app/example-org/projects/project-1?tab=artifacts",
			},
			{ frameId: "loose-1" },
		]);
	});
});

describe("fabric_edit_frame_block gateway registration", () => {
	it("requires frames:write before the handler runs", async () => {
		const result = await executePlatformTool(
			"fabric_edit_frame_block",
			{
				frameId: "example-frame",
				blockId: "example-block",
				edits: [{ oldText: "old", newText: "new" }],
			},
			{ ...session, credential: "personal-key", scopes: ["frames:read"] },
		);
		expect(result.isError).toBe(true);
		expect(payload(result).error).toContain("frames:write");
		expect(mocks.editFirstClassFrameBlock).not.toHaveBeenCalled();
	});
	it("routes the acting user and organization to the edit service", async () => {
		mocks.editFirstClassFrameBlock.mockResolvedValue({
			frameId: "example-frame",
			blockId: "example-block",
			chars: 3,
			replacements: [1],
		});
		const args = {
			frameId: "example-frame",
			blockId: "example-block",
			edits: [{ oldText: "old", newText: "new" }],
		};
		const result = await executePlatformTool(
			"fabric_edit_frame_block",
			args,
			session,
		);
		expect(result.isError).toBeUndefined();
		expect(mocks.editFirstClassFrameBlock).toHaveBeenCalledWith({
			args,
			userId: session.userId,
			organizationId: session.organizationId,
		});
	});
});
