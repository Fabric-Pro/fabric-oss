/**
 * A copy of a page copies the page and where it lives, not what it may do.
 *
 * `duplicateFrame` is the one command behind "duplicate" in the app and "fork"
 * for the Fabric Agent. The copy keeps the original's content (every block under
 * a new id), kind and theme; stays on the original's surface and in its
 * project; is saved PRIVATE without copied sharing grants or a public link;
 * retains inherited project access; and declares the Fabric tools its caller
 * names and no others, so duplicating a page never carries its capabilities
 * along unasked. Where the copy says it came from is the caller's.
 *
 * A copy in a project is held to the project's own placement rule, in this
 * command, so the app's duplicate and the agent's fork cannot differ on it.
 *
 * The write is faked; what these cases assert on is the row that would be
 * written. Who may open and copy the original is the callers' (their tests
 * cover it).
 *
 * Run with: pnpm --filter @repo/database test __tests__/frame-duplicate
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	create: vi.fn(),
	placementRefusal: vi.fn(),
}));

vi.mock("../prisma/client", async (importOriginal) => ({
	...(await importOriginal<typeof import("../prisma/client")>()),
	db: { agentWorkspaceFile: { create: mocks.create } },
}));

vi.mock("../prisma/queries/projects/project-placement", () => ({
	projectPlacementRefusal: mocks.placementRefusal,
}));

import {
	duplicateFrame,
	FramePlacementRefusedError,
	type FrameRecord,
} from "../prisma/queries/frames";

const NOW = new Date("2026-10-15T10:00:00Z");

function original(overrides: Partial<FrameRecord> = {}): FrameRecord {
	return {
		id: "frame-1",
		conversationId: "conv-original",
		userId: "owner-1",
		organizationId: "org-1",
		projectId: undefined,
		storyId: undefined,
		path: "sign-ups.frame.json",
		name: "Sign-ups.frame.json",
		title: "Sign-ups",
		description: "A sheet",
		kind: "frame",
		contentType: "application/vnd.fabric.frame",
		fileType: "FRAME",
		status: "COMPLETE",
		version: 4,
		isPublic: true,
		shareToken: "link-token",
		shareScope: "PUBLIC",
		sourceRunType: "MCP_GATEWAY",
		sourceRunId: "run-original",
		authoritySessionId: "authority-original",
		providerKeys: ["github"],
		surface: "workspace",
		runtimeTools: ["fabric_page_data_get", "fabric_share_frame"],
		document: {
			version: 1,
			kind: "frame",
			title: "Sign-ups",
			description: "A sheet",
			blocks: [
				{ id: "page", type: "html", content: "<p>hi</p>" },
				{ id: "notes", type: "markdown", content: "# Notes" },
			],
			theme: { mode: "dark" },
		},
		createdAt: NOW,
		updatedAt: NOW,
		...overrides,
	};
}

/** What the fake store hands back for the row it was asked to write. */
type Written = { data: Record<string, unknown> };

const written = () => mocks.create.mock.calls[0][0] as Written;

function writtenDocument() {
	return JSON.parse(String(written().data.content)) as {
		kind: string;
		title: string;
		blocks: Array<{ id: string; type: string; content: string }>;
		theme?: { mode?: string };
		metadata?: {
			runtime?: { tools: string[] };
			conversationId?: string;
			authoritySessionId?: string;
			providerKeys?: string[];
		};
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.placementRefusal.mockResolvedValue(null);
	mocks.create.mockImplementation(async ({ data }: Written) => ({
		...data,
		id: "frame-2",
		fileType: "FRAME",
		status: "COMPLETE",
		version: 1,
		createdAt: NOW,
		updatedAt: NOW,
	}));
});

describe("duplicateFrame", () => {
	it("keeps the content of every block, each under a new id, and the kind and theme", async () => {
		await duplicateFrame({ original: original(), userId: "forker-1" });

		const document = writtenDocument();
		expect(document.kind).toBe("frame");
		expect(document.theme).toEqual({ mode: "dark" });
		expect(document.blocks.map((block) => block.content)).toEqual([
			"<p>hi</p>",
			"# Notes",
		]);
		const ids = document.blocks.map((block) => block.id);
		expect(new Set(ids).size).toBe(2);
		expect(ids).not.toContain("page");
		expect(ids).not.toContain("notes");
	});

	it("keeps a Workspace copy on the Workspaces surface and outside any project", async () => {
		await duplicateFrame({ original: original(), userId: "forker-1" });

		expect(written().data).toMatchObject({
			projectId: null,
			metadata: { surface: "workspace" },
		});
	});

	it("never copies trusted workflow grants from the original row or content", async () => {
		const source = original();
		const forged = {
			...source,
			metadata: { workflowBindings: { version: 1, workflows: [] } },
		};
		await duplicateFrame({ original: forged, userId: "forker-1" });
		expect(written().data.metadata).not.toHaveProperty("workflowBindings");
		expect(writtenDocument().metadata).not.toHaveProperty(
			"workflowBindings",
		);
	});

	it("keeps an Artifact copy in the project and on the surface of the original", async () => {
		await duplicateFrame({
			original: original({ projectId: "project-1", surface: "artifact" }),
			userId: "forker-1",
			organizationId: "org-1",
		});

		expect(written().data).toMatchObject({
			projectId: "project-1",
			shareScope: "PRIVATE",
			metadata: { surface: "artifact" },
		});
	});

	it("asks the project whether it takes the copy, for the copier in their organization", async () => {
		await duplicateFrame({
			original: original({ projectId: "project-1", surface: "artifact" }),
			userId: "forker-1",
			organizationId: "org-1",
		});

		expect(mocks.placementRefusal).toHaveBeenCalledWith({
			userId: "forker-1",
			organizationId: "org-1",
			projectId: "project-1",
		});
	});

	it.each(["not_found", "not_editable"] as const)(
		"writes no copy into a project that refuses it (%s)",
		async (refusal) => {
			mocks.placementRefusal.mockResolvedValue(refusal);

			const attempt = duplicateFrame({
				original: original({
					projectId: "project-1",
					surface: "artifact",
				}),
				userId: "forker-1",
				organizationId: "org-1",
			});

			await expect(attempt).rejects.toMatchObject({
				name: "FramePlacementRefusedError",
				refusal,
			});
			await expect(attempt).rejects.toBeInstanceOf(
				FramePlacementRefusedError,
			);
			expect(mocks.create).not.toHaveBeenCalled();
		},
	);

	it("writes no project copy outside an organization, without asking any project", async () => {
		await expect(
			duplicateFrame({
				original: original({
					projectId: "project-1",
					surface: "artifact",
				}),
				userId: "forker-1",
			}),
		).rejects.toMatchObject({ refusal: "not_found" });

		expect(mocks.placementRefusal).not.toHaveBeenCalled();
		expect(mocks.create).not.toHaveBeenCalled();
	});

	it("asks no project for a Workspace copy", async () => {
		await duplicateFrame({
			original: original(),
			userId: "forker-1",
			organizationId: "org-1",
		});

		expect(mocks.placementRefusal).not.toHaveBeenCalled();
	});

	it("saves PRIVATE for the new owner with no public link, whatever the original shared", async () => {
		await duplicateFrame({
			original: original(),
			userId: "forker-1",
			organizationId: "org-1",
		});

		expect(written().data).toMatchObject({
			userId: "forker-1",
			organizationId: "org-1",
			isPublic: false,
			shareToken: null,
		});
		expect(written().data.shareScope).toBe("PRIVATE");
	});

	it.each(["PRIVATE", "PROJECT", "PUBLIC"] as const)(
		"saves a project Workspace copy as PRIVATE when the original scope is %s",
		async (shareScope) => {
			await duplicateFrame({
				original: original({ projectId: "project-1", shareScope }),
				userId: "forker-1",
				organizationId: "org-1",
			});

			expect(written().data).toMatchObject({
				projectId: "project-1",
				shareScope: "PRIVATE",
				isPublic: false,
				shareToken: null,
				metadata: { surface: "workspace" },
			});
		},
	);

	it("declares no tools on the copy unless the caller names them", async () => {
		await duplicateFrame({ original: original(), userId: "forker-1" });

		expect(writtenDocument().metadata?.runtime).toBeUndefined();
	});

	it("declares the tools the caller names, and only those", async () => {
		await duplicateFrame({
			original: original(),
			userId: "forker-1",
			runtimeTools: ["fabric_page_data_get"],
		});

		expect(writtenDocument().metadata?.runtime).toEqual({
			tools: ["fabric_page_data_get"],
		});
	});

	it("says where the copy came from as the caller says it, not as the original did", async () => {
		await duplicateFrame({
			original: original(),
			userId: "forker-1",
			conversationId: "conv-forker",
			sourceRunType: "MCP_GATEWAY",
			sourceRunId: "run-forker",
		});

		expect(written().data).toMatchObject({
			conversationId: "conv-forker",
			sourceRunType: "MCP_GATEWAY",
			sourceRunId: "run-forker",
			providerKeys: [],
		});
		expect(written().data.authoritySessionId).toBeUndefined();
	});

	it("keeps a copy of a page an unattended run wrote marked as that run's, whoever forks it", async () => {
		await duplicateFrame({
			original: original({ sourceRunType: "workflow" }),
			userId: "forker-1",
			sourceRunType: "MCP_GATEWAY",
			sourceRunId: "run-forker",
		});

		expect(written().data).toMatchObject({
			sourceRunType: "workflow",
			sourceRunId: "run-forker",
		});
	});

	it("carries the provenance a caller passes on, which the app does for the owner's own copy", async () => {
		const source = original();

		await duplicateFrame({
			original: source,
			userId: "owner-1",
			conversationId: source.conversationId ?? undefined,
			sourceRunType: source.sourceRunType ?? undefined,
			sourceRunId: source.sourceRunId ?? undefined,
			authoritySessionId: source.authoritySessionId ?? undefined,
			providerKeys: source.providerKeys,
		});

		expect(written().data).toMatchObject({
			conversationId: "conv-original",
			sourceRunType: "MCP_GATEWAY",
			sourceRunId: "run-original",
			authoritySessionId: "authority-original",
			providerKeys: ["github"],
		});
	});

	it("titles the copy '<title> (Copy)' unless the caller gives a title, and keeps the description", async () => {
		await duplicateFrame({ original: original(), userId: "forker-1" });

		expect(writtenDocument().title).toBe("Sign-ups (Copy)");
		expect(written().data.description).toBe("A sheet");

		mocks.create.mockClear();
		await duplicateFrame({
			original: original(),
			userId: "forker-1",
			title: "My poll",
		});

		expect(writtenDocument().title).toBe("My poll");
	});

	it("copies a slideshow as a slideshow", async () => {
		await duplicateFrame({
			original: original({
				kind: "slideshow",
				document: { ...original().document, kind: "slideshow" },
			}),
			userId: "forker-1",
		});

		expect(writtenDocument().kind).toBe("slideshow");
		expect(written().data.fileType).toBe("SLIDESHOW");
	});
});
