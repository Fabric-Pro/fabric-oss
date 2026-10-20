import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getAccessibleFrameById: vi.fn(),
	listProjectFrames: vi.fn(),
	listWorkspaceFrames: vi.fn(),
}));

vi.mock("@repo/database", async (importOriginal) => ({
	...(await importOriginal<typeof import("@repo/database")>()),
	getAccessibleFrameById: mocks.getAccessibleFrameById,
	listProjectFrames: mocks.listProjectFrames,
	listWorkspaceFrames: mocks.listWorkspaceFrames,
}));

import {
	getFirstClassFrame,
	listFirstClassFrames,
} from "../src/activities/shared/frame-service";

const actor = {
	userId: "user-1",
	organizationId: "org-1",
	projectRestrictionId: "project-1",
};

beforeEach(() => {
	vi.resetAllMocks();
	mocks.listProjectFrames.mockResolvedValue([]);
	mocks.listWorkspaceFrames.mockResolvedValue([]);
});

describe("frame service project reads", () => {
	it.each(["project-2", null])(
		"refuses content and source for a frame in project %s",
		async (projectId) => {
			mocks.getAccessibleFrameById.mockResolvedValue({
				id: "frame-1",
				projectId,
			});
			for (const args of [
				{ frameId: "frame-1" },
				{ frameId: "frame-1", blockId: "page", offset: 0, limit: 10 },
			]) {
				await expect(
					getFirstClassFrame({ ...actor, args }),
				).resolves.toEqual({
					error: "Frame not found.",
				});
			}
		},
	);

	it("returns source after the actual frame project matches", async () => {
		mocks.getAccessibleFrameById.mockResolvedValue({
			id: "frame-1",
			projectId: "project-1",
			title: "Example",
			updatedAt: new Date("2026-01-01T00:00:00Z"),
			document: {
				blocks: [{ id: "page", type: "html", content: "<p>Page</p>" }],
			},
		});
		await expect(
			getFirstClassFrame({
				...actor,
				args: { frameId: "frame-1", blockId: "page", limit: 20 },
			}),
		).resolves.toMatchObject({
			source: true,
			block: { content: "<p>Page</p>" },
		});
	});

	it.each([undefined, "workspace", "artifact"] as const)(
		"filters surface %s in the database before its limit",
		async (surface) => {
			await expect(
				listFirstClassFrames({ ...actor, surface }),
			).resolves.toEqual({ frames: [] });
			const query =
				surface === "workspace"
					? mocks.listWorkspaceFrames
					: mocks.listProjectFrames;
			expect(query).toHaveBeenCalledWith(
				expect.objectContaining({
					userId: "user-1",
					organizationId: "org-1",
					projectId: "project-1",
				}),
			);
		},
	);

	it("refuses a conflicting explicit list project before querying", async () => {
		await expect(
			listFirstClassFrames({ ...actor, projectId: "project-2" }),
		).resolves.toEqual({ frames: [] });
		expect(mocks.listProjectFrames).not.toHaveBeenCalled();
		expect(mocks.listWorkspaceFrames).not.toHaveBeenCalled();
	});
});
