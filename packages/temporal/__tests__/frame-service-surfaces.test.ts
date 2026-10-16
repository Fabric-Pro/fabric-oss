/**
 * Frames on a surface: a project's Artifacts tab and an organization Workspace.
 *
 * The page is the agent's own HTML, so the service validates what surrounds it:
 * the surface it belongs to, the Fabric tools its script may call at view time,
 * and the project it is placed in. Placement is the one thing a caller names
 * that widens who can read the frame, so it is checked against the project's own
 * rules, and the cases below assert on the write: a refusal that already called
 * `createFrame` is not a refusal.
 *
 * Run with: pnpm --filter @repo/temporal test __tests__/frame-service-surfaces
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	canCreateOrganizationFrames: vi.fn(),
	canUpdateOrganizationFrames: vi.fn(),
	projectPlacementRefusal: vi.fn(),
	createFrame: vi.fn(),
	updateFrame: vi.fn(),
	getFrameById: vi.fn(),
	getAccessibleFrameById: vi.fn(),
	listFrames: vi.fn(),
	listProjectFrames: vi.fn(),
	listWorkspaceFrames: vi.fn(),
}));

vi.mock("@repo/database", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		canCreateOrganizationFrames: mocks.canCreateOrganizationFrames,
		canUpdateOrganizationFrames: mocks.canUpdateOrganizationFrames,
		projectPlacementRefusal: mocks.projectPlacementRefusal,
		createFrame: mocks.createFrame,
		updateFrame: mocks.updateFrame,
		getFrameById: mocks.getFrameById,
		getAccessibleFrameById: mocks.getAccessibleFrameById,
		listFrames: mocks.listFrames,
		listProjectFrames: mocks.listProjectFrames,
		listWorkspaceFrames: mocks.listWorkspaceFrames,
	};
});

import { withAgentToolRuntime } from "../src/activities/shared/agent-tool-runtime";
import {
	MAX_FRAME_RUNTIME_TOOLS,
	validateCreateFrameArgs,
	validateUpdateFrameArgs,
} from "../src/activities/shared/frame-args";
import {
	createFirstClassFrame,
	getFirstClassFrame,
	listFirstClassFrames,
	updateFirstClassFrame,
} from "../src/activities/shared/frame-service";

const USER = "user-1";
const ORG = "org-1";
const PROJECT = "project-1";

const blocks = [{ id: "page", type: "html", content: "<p>page</p>" }];

function frameRecord(overrides: Record<string, unknown> = {}) {
	return {
		id: "frame-1",
		userId: USER,
		title: "Status",
		description: undefined,
		kind: "frame",
		contentType: "application/vnd.fabric.frame",
		shareToken: null,
		isPublic: false,
		shareScope: "PRIVATE",
		surface: undefined,
		projectId: undefined,
		runtimeTools: [],
		version: 1,
		document: { blocks },
		updatedAt: new Date("2026-10-14T10:00:00Z"),
		...overrides,
	};
}

beforeEach(() => {
	vi.resetAllMocks();
	mocks.canCreateOrganizationFrames.mockResolvedValue(true);
	mocks.canUpdateOrganizationFrames.mockResolvedValue(true);
	mocks.projectPlacementRefusal.mockResolvedValue(null);
	mocks.createFrame.mockImplementation(async (input) =>
		frameRecord({
			title: input.title,
			surface: input.surface,
			projectId: input.projectId,
			runtimeTools: input.runtimeTools ?? [],
			document: { blocks: input.blocks },
		}),
	);
	mocks.updateFrame.mockResolvedValue(frameRecord());
});

describe("validateCreateFrameArgs: surface and runtimeTools", () => {
	it("accepts both surfaces and the tools a page declares", () => {
		for (const surface of ["artifact", "workspace"] as const) {
			const result = validateCreateFrameArgs({
				title: "Page",
				surface,
				runtimeTools: ["fabric_list_workflows", " fabric_get_frame "],
			});
			expect(result).toMatchObject({
				ok: true,
				value: {
					surface,
					runtimeTools: ["fabric_list_workflows", "fabric_get_frame"],
				},
			});
		}
	});

	it("leaves both out when the caller names neither", () => {
		const result = validateCreateFrameArgs({ title: "Page" });
		expect(result.ok && "surface" in result.value).toBe(false);
		expect(result.ok && "runtimeTools" in result.value).toBe(false);
	});

	it("refuses an unknown surface", () => {
		expect(
			validateCreateFrameArgs({ title: "Page", surface: "dashboard" }),
		).toEqual({
			ok: false,
			error: "`surface` must be one of: artifact, workspace.",
		});
	});

	it.each([
		["a string", "fabric_list_workflows"],
		["an object", { 0: "fabric_list_workflows" }],
		["an empty name", ["fabric_list_workflows", "  "]],
		["a name that is not a string", ["fabric_list_workflows", 7]],
		["a name that is too long", ["x".repeat(129)]],
	])("refuses runtimeTools given as %s", (_label, runtimeTools) => {
		expect(
			validateCreateFrameArgs({ title: "Page", runtimeTools }).ok,
		).toBe(false);
	});

	it("refuses the same tool listed twice, even when the spelling differs by spaces", () => {
		expect(
			validateCreateFrameArgs({
				title: "Page",
				runtimeTools: ["fabric_get_frame", " fabric_get_frame"],
			}),
		).toEqual({
			ok: false,
			error: '`runtimeTools` lists "fabric_get_frame" more than once.',
		});
	});

	it("accepts as many tools as the limit and refuses one more", () => {
		const names = Array.from(
			{ length: MAX_FRAME_RUNTIME_TOOLS + 1 },
			(_, index) => `fabric_tool_${index}`,
		);
		expect(
			validateCreateFrameArgs({
				title: "Page",
				runtimeTools: names.slice(0, MAX_FRAME_RUNTIME_TOOLS),
			}).ok,
		).toBe(true);
		expect(
			validateCreateFrameArgs({ title: "Page", runtimeTools: names }).ok,
		).toBe(false);
	});

	it("takes the page from `components` when it carries content and `blocks` is absent", () => {
		const result = validateCreateFrameArgs({
			title: "Page",
			components: [{ id: "page", type: "html", content: "<p>page</p>" }],
		});
		expect(result.ok && result.value.blocks).toEqual(blocks);
	});
});

describe("validateUpdateFrameArgs: surface and runtimeTools", () => {
	it("accepts the tools a page declares as the only change", () => {
		expect(
			validateUpdateFrameArgs({
				frameId: "frame-1",
				runtimeTools: ["fabric_get_frame"],
			}),
		).toMatchObject({
			ok: true,
			value: { frameId: "frame-1", runtimeTools: ["fabric_get_frame"] },
		});
	});

	it("accepts clearing the declared tools", () => {
		expect(
			validateUpdateFrameArgs({ frameId: "frame-1", runtimeTools: [] }),
		).toMatchObject({ ok: true, value: { runtimeTools: [] } });
	});

	it("refuses a bad surface or tool list before looking at anything else", () => {
		expect(
			validateUpdateFrameArgs({ frameId: "frame-1", surface: "page" }).ok,
		).toBe(false);
		expect(
			validateUpdateFrameArgs({
				frameId: "frame-1",
				runtimeTools: ["a", "a"],
			}).ok,
		).toBe(false);
	});
});

describe("createFirstClassFrame on a surface", () => {
	it("creates a workspace the organization can open, with no project and no public link", async () => {
		await createFirstClassFrame({
			args: { title: "Delivery", surface: "workspace", blocks },
			runtimeTools: ["fabric_list_workflows"],
			userId: USER,
			organizationId: ORG,
		});

		expect(mocks.createFrame).toHaveBeenCalledWith(
			expect.objectContaining({
				organizationId: ORG,
				surface: "workspace",
				projectId: undefined,
				runtimeTools: ["fabric_list_workflows"],
				shareScope: "WORKSPACE_AND_EMAILS",
				isPublic: false,
			}),
		);
		expect(mocks.projectPlacementRefusal).not.toHaveBeenCalled();
	});

	it("keeps a workspace to its owner when asked", async () => {
		await createFirstClassFrame({
			args: { title: "Drafts", surface: "workspace", blocks },
			shareScope: "PRIVATE",
			userId: USER,
			organizationId: ORG,
		});

		expect(mocks.createFrame).toHaveBeenCalledWith(
			expect.objectContaining({ shareScope: "PRIVATE" }),
		);
	});

	it("ignores runtimeTools in the raw arguments, which only the gateway may set", async () => {
		await createFirstClassFrame({
			args: {
				title: "Delivery",
				surface: "workspace",
				blocks,
				runtimeTools: ["fabric_request_authority"],
			},
			userId: USER,
			organizationId: ORG,
		});

		expect(mocks.createFrame).toHaveBeenCalledWith(
			expect.objectContaining({ runtimeTools: undefined }),
		);
	});

	it("places an artifact in the project it names once the project's rules allow it", async () => {
		const result = await createFirstClassFrame({
			args: { title: "Report", surface: "artifact", blocks },
			userId: USER,
			organizationId: ORG,
			projectId: PROJECT,
		});

		expect(mocks.projectPlacementRefusal).toHaveBeenCalledWith({
			userId: USER,
			organizationId: ORG,
			projectId: PROJECT,
		});
		expect(mocks.createFrame).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: PROJECT,
				surface: "artifact",
				isPublic: false,
			}),
		);
		expect(result).toMatchObject({
			surface: "artifact",
			projectId: PROJECT,
			ownedByCaller: true,
		});
	});

	it("shares the link on creation only when asked to", async () => {
		await createFirstClassFrame({
			args: {
				title: "Report",
				surface: "artifact",
				blocks,
				shareOnCreate: true,
			},
			userId: USER,
			organizationId: ORG,
			projectId: PROJECT,
		});
		expect(mocks.createFrame).toHaveBeenCalledWith(
			expect.objectContaining({ isPublic: true }),
		);
	});

	it("refuses a project the shared placement rule reports as missing, whatever made it so", async () => {
		mocks.projectPlacementRefusal.mockResolvedValue("not_found");

		const result = await createFirstClassFrame({
			args: { title: "Report", surface: "artifact", blocks },
			userId: USER,
			organizationId: ORG,
			projectId: PROJECT,
		});

		expect(result).toEqual({ error: "Project not found." });
		expect(mocks.createFrame).not.toHaveBeenCalled();
	});

	it("refuses with no project check at all when there is no organization to place it in", async () => {
		const result = await createFirstClassFrame({
			args: { title: "Report", surface: "artifact", blocks },
			userId: USER,
			projectId: PROJECT,
		});

		expect(result).toEqual({
			error: "No organization context for this frame operation.",
		});
		expect(mocks.projectPlacementRefusal).not.toHaveBeenCalled();
		expect(mocks.createFrame).not.toHaveBeenCalled();
	});

	it("refuses a caller who can see the project but not edit it", async () => {
		mocks.projectPlacementRefusal.mockResolvedValue("not_editable");

		const result = await createFirstClassFrame({
			args: { title: "Report", surface: "artifact", blocks },
			userId: USER,
			organizationId: ORG,
			projectId: PROJECT,
		});

		expect(result).toEqual({
			error: "No permission to add frames to this project.",
		});
		expect(mocks.createFrame).not.toHaveBeenCalled();
	});

	it("does not check the project when the organization role already refuses the write", async () => {
		mocks.canCreateOrganizationFrames.mockResolvedValue(false);

		await createFirstClassFrame({
			args: { title: "Report", surface: "artifact", blocks },
			userId: USER,
			organizationId: ORG,
			projectId: PROJECT,
		});

		expect(mocks.projectPlacementRefusal).not.toHaveBeenCalled();
		expect(mocks.createFrame).not.toHaveBeenCalled();
	});

	it("refuses an artifact with no project to belong to", async () => {
		const result = await createFirstClassFrame({
			args: { title: "Report", surface: "artifact", blocks },
			userId: USER,
			organizationId: ORG,
		});

		expect(result).toEqual({
			error: "An artifact belongs to a project. Pass `projectId` for the project it is for.",
		});
		expect(mocks.createFrame).not.toHaveBeenCalled();
	});

	it("refuses a page whose content was not supplied, instead of generating one", async () => {
		const result = await createFirstClassFrame({
			args: { title: "Delivery", surface: "workspace" },
			userId: USER,
			organizationId: ORG,
		});

		expect(result).toEqual({
			error: "A page needs its content. Pass the page HTML as `blocks`.",
		});
		expect(mocks.createFrame).not.toHaveBeenCalled();
	});

	it("takes the project of a chat turn from its runtime, which the turn already vouches for", async () => {
		await withAgentToolRuntime(
			{
				invoke: async () => undefined,
				projectScope: {
					projectId: PROJECT,
					userId: USER,
					organizationId: ORG,
				},
			},
			() =>
				createFirstClassFrame({
					args: { title: "Report", surface: "artifact", blocks },
					userId: USER,
					organizationId: ORG,
				}),
		);

		expect(mocks.createFrame).toHaveBeenCalledWith(
			expect.objectContaining({ projectId: PROJECT }),
		);
		expect(mocks.projectPlacementRefusal).not.toHaveBeenCalled();
	});

	it("keeps a loose frame public from the start, as before", async () => {
		await createFirstClassFrame({
			args: { title: "Loose", blocks },
			userId: USER,
			organizationId: ORG,
		});

		expect(mocks.createFrame).toHaveBeenCalledWith(
			expect.objectContaining({
				isPublic: true,
				surface: undefined,
				projectId: undefined,
			}),
		);
	});
});

describe("updateFirstClassFrame on a surface", () => {
	it("passes the declared tools and a new surface to the update", async () => {
		mocks.getFrameById.mockResolvedValue(
			frameRecord({ projectId: PROJECT }),
		);

		await updateFirstClassFrame({
			args: { frameId: "frame-1", surface: "artifact" },
			runtimeTools: ["fabric_get_frame"],
			userId: USER,
			organizationId: ORG,
		});

		expect(mocks.updateFrame).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "frame-1",
				surface: "artifact",
				runtimeTools: ["fabric_get_frame"],
			}),
		);
	});

	it("ignores runtimeTools in the raw arguments, which only the gateway may set", async () => {
		mocks.getFrameById.mockResolvedValue(frameRecord());

		await updateFirstClassFrame({
			args: {
				frameId: "frame-1",
				title: "Renamed",
				runtimeTools: ["fabric_request_authority"],
			},
			userId: USER,
			organizationId: ORG,
		});

		expect(mocks.updateFrame).toHaveBeenCalledWith(
			expect.objectContaining({ runtimeTools: undefined }),
		);
	});

	it("will not turn a frame with no project into an artifact", async () => {
		mocks.getFrameById.mockResolvedValue(frameRecord());

		const result = await updateFirstClassFrame({
			args: { frameId: "frame-1", surface: "artifact" },
			userId: USER,
			organizationId: ORG,
		});

		expect(result).toEqual({
			error: "An artifact belongs to a project, and this frame has none.",
		});
		expect(mocks.updateFrame).not.toHaveBeenCalled();
	});

	it("lets a frame become a workspace without a project", async () => {
		await updateFirstClassFrame({
			args: { frameId: "frame-1", surface: "workspace" },
			userId: USER,
			organizationId: ORG,
		});

		expect(mocks.getFrameById).not.toHaveBeenCalled();
		expect(mocks.updateFrame).toHaveBeenCalledWith(
			expect.objectContaining({ surface: "workspace" }),
		);
	});
});

describe("getFirstClassFrame", () => {
	it("opens the frame through the access rules of the caller's organization", async () => {
		mocks.getAccessibleFrameById.mockResolvedValue(
			frameRecord({
				userId: "someone-else",
				surface: "workspace",
				runtimeTools: ["fabric_list_workflows"],
				shareScope: "WORKSPACE_AND_EMAILS",
			}),
		);

		const result = await getFirstClassFrame({
			args: { frameId: "frame-1" },
			userId: USER,
			userEmail: "viewer@example.com",
			organizationId: ORG,
		});

		expect(mocks.getAccessibleFrameById).toHaveBeenCalledWith({
			id: "frame-1",
			userId: USER,
			userEmail: "viewer@example.com",
			organizationId: ORG,
		});
		expect(result).toMatchObject({
			frameId: "frame-1",
			surface: "workspace",
			runtimeTools: ["fabric_list_workflows"],
			ownedByCaller: false,
			blocks,
		});
	});

	it("does not hand a reader the share link of a frame that is not public", async () => {
		mocks.getAccessibleFrameById.mockResolvedValue(
			frameRecord({ userId: "someone-else", shareToken: "token-1" }),
		);

		const result = await getFirstClassFrame({
			args: { frameId: "frame-1" },
			userId: USER,
			organizationId: ORG,
		});

		expect(result).toMatchObject({
			shareUrl: undefined,
			shareEmbedUrl: undefined,
		});
	});

	it("hands the owner the link", async () => {
		mocks.getAccessibleFrameById.mockResolvedValue(
			frameRecord({ shareToken: "token-1" }),
		);

		const result = await getFirstClassFrame({
			args: { frameId: "frame-1" },
			userId: USER,
			organizationId: ORG,
		});

		expect(result).toMatchObject({
			shareUrl: expect.stringContaining("token-1"),
		});
	});

	it("reports a frame the caller may not open as not found", async () => {
		mocks.getAccessibleFrameById.mockResolvedValue(null);

		expect(
			await getFirstClassFrame({
				args: { frameId: "frame-1" },
				userId: USER,
				organizationId: ORG,
			}),
		).toEqual({ error: "Frame not found." });
	});
});

describe("listFirstClassFrames", () => {
	beforeEach(() => {
		mocks.listFrames.mockResolvedValue([frameRecord()]);
		mocks.listProjectFrames.mockResolvedValue([
			frameRecord({ id: "artifact-1", surface: "artifact" }),
		]);
		mocks.listWorkspaceFrames.mockResolvedValue([
			frameRecord({
				id: "workspace-1",
				surface: "workspace",
				userId: "someone-else",
			}),
		]);
	});

	it("lists the caller's own frames when no surface or project is named", async () => {
		const { frames } = await listFirstClassFrames({
			userId: USER,
			organizationId: ORG,
		});

		expect(frames.map((frame) => frame.frameId)).toEqual(["frame-1"]);
		expect(mocks.listProjectFrames).not.toHaveBeenCalled();
		expect(mocks.listWorkspaceFrames).not.toHaveBeenCalled();
	});

	it("lists the organization's workspaces the caller may see", async () => {
		const { frames } = await listFirstClassFrames({
			userId: USER,
			organizationId: ORG,
			surface: "workspace",
		});

		expect(mocks.listWorkspaceFrames).toHaveBeenCalledWith({
			userId: USER,
			organizationId: ORG,
			projectId: undefined,
		});
		expect(frames).toEqual([
			expect.objectContaining({
				frameId: "workspace-1",
				surface: "workspace",
				ownedByCaller: false,
			}),
		]);
	});

	it("lists a project's artifacts", async () => {
		await listFirstClassFrames({
			userId: USER,
			organizationId: ORG,
			surface: "artifact",
			projectId: PROJECT,
		});

		expect(mocks.listProjectFrames).toHaveBeenCalledWith({
			userId: USER,
			organizationId: ORG,
			projectId: PROJECT,
			surface: "artifact",
		});
	});

	it("lists a project's frames of every surface when only the project is named", async () => {
		await listFirstClassFrames({
			userId: USER,
			organizationId: ORG,
			projectId: PROJECT,
		});

		expect(mocks.listProjectFrames).toHaveBeenCalledWith({
			userId: USER,
			organizationId: ORG,
			projectId: PROJECT,
			surface: undefined,
		});
	});

	it("returns nothing for a surface or project filter without an organization", async () => {
		const { frames } = await listFirstClassFrames({
			userId: USER,
			surface: "workspace",
		});

		expect(frames).toEqual([]);
		expect(mocks.listFrames).not.toHaveBeenCalled();
		expect(mocks.listWorkspaceFrames).not.toHaveBeenCalled();
	});
});

describe("the addresses a frame is handed back with", () => {
	it("are the app's route for the frame and its embed, in create, update, get and list alike", async () => {
		mocks.getAccessibleFrameById.mockResolvedValue(frameRecord());
		mocks.listWorkspaceFrames.mockResolvedValue([frameRecord()]);

		const created = await createFirstClassFrame({
			args: { title: "Report", surface: "workspace", blocks },
			userId: USER,
			organizationId: ORG,
		});
		const updated = await updateFirstClassFrame({
			args: { frameId: "frame-1", title: "Report" },
			userId: USER,
			organizationId: ORG,
		});
		const read = await getFirstClassFrame({
			args: { frameId: "frame-1" },
			userId: USER,
			organizationId: ORG,
		});
		const { frames } = await listFirstClassFrames({
			userId: USER,
			organizationId: ORG,
			surface: "workspace",
		});

		for (const answer of [created, updated, read, frames[0]]) {
			expect(answer).toMatchObject({
				frameUrl: "/app/frames/frame-1",
				embedUrl: "/app/frames/frame-1/embed",
			});
		}
	});

	it("say what produced the frame, so a viewer can tell a page written with nobody watching", async () => {
		mocks.getAccessibleFrameById.mockResolvedValue(
			frameRecord({ sourceRunType: "workflow" }),
		);
		mocks.listWorkspaceFrames.mockResolvedValue([
			frameRecord({ sourceRunType: "workflow" }),
			frameRecord({ id: "frame-2" }),
		]);

		const read = await getFirstClassFrame({
			args: { frameId: "frame-1" },
			userId: USER,
			organizationId: ORG,
		});
		const { frames } = await listFirstClassFrames({
			userId: USER,
			organizationId: ORG,
			surface: "workspace",
		});

		expect(read).toMatchObject({ sourceRunType: "workflow" });
		expect(frames[0]).toMatchObject({ sourceRunType: "workflow" });
		expect(frames[1].sourceRunType).toBeUndefined();
	});

	it("carry the share link only where the frame is the caller's own or public", async () => {
		mocks.getAccessibleFrameById.mockResolvedValue(
			frameRecord({ userId: "someone-else", shareToken: "tok-private" }),
		);
		const hidden = await getFirstClassFrame({
			args: { frameId: "frame-1" },
			userId: USER,
			organizationId: ORG,
		});
		mocks.getAccessibleFrameById.mockResolvedValue(
			frameRecord({
				userId: "someone-else",
				shareToken: "tok-public",
				isPublic: true,
			}),
		);
		const shared = await getFirstClassFrame({
			args: { frameId: "frame-1" },
			userId: USER,
			organizationId: ORG,
		});

		expect(hidden).toMatchObject({
			shareUrl: undefined,
			shareEmbedUrl: undefined,
		});
		expect(shared).toMatchObject({
			shareUrl: expect.stringMatching(/\/share\/frame\/tok-public$/),
			shareEmbedUrl: expect.stringMatching(
				/\/share\/frame\/tok-public\/embed$/,
			),
		});
	});
});
