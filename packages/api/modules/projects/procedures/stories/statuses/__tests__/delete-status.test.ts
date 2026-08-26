import { beforeEach, describe, expect, it, vi } from "vitest";

const deleteStoryStatusMock = vi.hoisted(() => vi.fn());

vi.mock("@repo/database", () => ({
	deleteStoryStatus: deleteStoryStatusMock,
}));

vi.mock("../../../../../../orpc/procedures", () => {
	const chain = {
		route: () => chain,
		input: () => chain,
		use: () => chain,
		handler: (handler: unknown) => ({ handler }),
	};
	return {
		Permissions: { STORY_DELETE: "story:delete" },
		requireProjectPermission: () => (handler: unknown) => handler,
		tenantProtectedProcedure: chain,
	};
});

import { deleteStoryStatusProcedure } from "../delete-status";

describe("deleteStoryStatusProcedure", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		deleteStoryStatusMock.mockResolvedValue({ id: "status-old" });
	});

	it("attributes moved stories to the authenticated user", async () => {
		const handler = (
			deleteStoryStatusProcedure as unknown as {
				handler: (args: {
					input: { projectId: string; statusId: string };
					context: { user: { name: string | null } };
				}) => Promise<{ success: boolean }>;
			}
		).handler;

		await expect(
			handler({
				input: { projectId: "project-1", statusId: "status-old" },
				context: { user: { name: "Grace Hopper" } },
			}),
		).resolves.toEqual({ success: true });

		expect(deleteStoryStatusMock).toHaveBeenCalledWith(
			"status-old",
			"project-1",
			{
				lastEditedByName: "Grace Hopper",
				lastEditedSource: "MANUAL",
			},
		);
	});
});
