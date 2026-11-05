import { beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ canRead: vi.fn(), get: vi.fn() }));
vi.mock("@repo/database", () => ({
	canReadOrganizationFrames: m.canRead,
	getUserById: async () => ({ email: "user@example.com" }),
	getAccessibleFrameById: m.get,
}));

import { getFrameContentActivity } from "../src/activities/frame-export/get-frame-content";

const input = {
	frameId: "example-frame",
	userId: "example-user",
	organizationId: "example-org",
	expectedUpdatedAt: "2026-11-01T00:00:00Z",
};
beforeEach(() => {
	m.canRead.mockResolvedValue(true);
	m.get.mockResolvedValue({
		title: "Report",
		updatedAt: new Date(input.expectedUpdatedAt),
		document: { title: "Report", blocks: [] },
	});
});
it("returns the reviewed immutable document", async () => {
	expect((await getFrameContentActivity(input)).title).toBe("Report");
});
it("refuses a revision changed before the worker read", async () => {
	await expect(
		getFrameContentActivity({
			...input,
			expectedUpdatedAt: "2026-10-01T00:00:00Z",
		}),
	).rejects.toMatchObject({
		type: "FRAME_EXPORT_CONFLICT",
		nonRetryable: true,
	});
});
it("rechecks current authority in the activity", async () => {
	m.canRead.mockResolvedValue(false);
	await expect(getFrameContentActivity(input)).rejects.toMatchObject({
		type: "FRAME_EXPORT_FORBIDDEN",
	});
});
