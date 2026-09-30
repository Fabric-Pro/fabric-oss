import { beforeEach, describe, expect, it, vi } from "vitest";

type UsageInput = { projectId: string };
const mocks = vi.hoisted(() => ({
	project: vi.fn(),
	groupBy: vi.fn(),
	permission: vi.fn(),
	handler: undefined as
		| ((args: { input: UsageInput }) => Promise<unknown>)
		| undefined,
}));
vi.mock("@repo/database", () => ({
	db: { aiUsageLog: { groupBy: mocks.groupBy } },
}));
vi.mock("../sessions", () => ({ requireParlumeProject: mocks.project }));
vi.mock("../../../../../orpc/procedures", () => {
	const chain = {
		use: () => chain,
		route: () => chain,
		input: () => chain,
		handler: (handler: NonNullable<typeof mocks.handler>) => {
			mocks.handler = handler;
			return handler;
		},
	};
	return {
		tenantProtectedProcedure: chain,
		requireProjectPermission: mocks.permission,
		Permissions: { PROJECT_READ: "project:read" },
	};
});
await import("../usage");

beforeEach(() => {
	mocks.project
		.mockReset()
		.mockResolvedValue({ id: "project", organizationId: "org" });
	mocks.groupBy.mockReset().mockResolvedValue([]);
});

describe("Parlume project usage", () => {
	it("requires project read permission and sums only this project's Parlume rows", async () => {
		expect(mocks.permission).toHaveBeenCalledWith("project:read");
		mocks.groupBy.mockResolvedValue([
			{
				conversationId: "session-a",
				_sum: { costMicroUsd: 725_000 },
				_count: { _all: 3 },
			},
			{
				conversationId: "session-b",
				_sum: { costMicroUsd: 15_250 },
				_count: { _all: 2 },
			},
			{
				conversationId: null,
				_sum: { costMicroUsd: 100 },
				_count: { _all: 1 },
			},
		]);

		const response = await mocks.handler?.({
			input: { projectId: "project" },
		});

		expect(mocks.groupBy).toHaveBeenCalledWith(
			expect.objectContaining({
				by: ["conversationId"],
				where: {
					projectId: "project",
					organizationId: "org",
					featureKey: "parlume",
				},
			}),
		);
		expect(response).toEqual({
			totalCostMicroUsd: 740_350,
			calls: 6,
			sessions: [
				{ sessionId: "session-a", costMicroUsd: 725_000, calls: 3 },
				{ sessionId: "session-b", costMicroUsd: 15_250, calls: 2 },
			],
		});
	});

	it("refuses usage when the project or feature is unavailable", async () => {
		mocks.project.mockRejectedValueOnce(new Error("Not found"));
		await expect(
			mocks.handler?.({ input: { projectId: "other" } }),
		).rejects.toThrow("Not found");
		expect(mocks.groupBy).not.toHaveBeenCalled();
	});
});
