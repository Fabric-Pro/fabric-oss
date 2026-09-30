import { beforeEach, describe, expect, it, vi } from "vitest";

type HistoryInput = {
	projectId: string;
	sessionId?: string;
	before?: { id: string; createdAt: Date };
};
const mocks = vi.hoisted(() => ({
	project: vi.fn(),
	turns: vi.fn(),
	permission: vi.fn(),
	handler: undefined as
		| ((args: { input: HistoryInput }) => Promise<unknown>)
		| undefined,
}));
vi.mock("@repo/database", () => ({
	db: { parlumeMeetingTurn: { findMany: mocks.turns } },
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
await import("../history");

beforeEach(() => {
	mocks.project
		.mockReset()
		.mockResolvedValue({ id: "project", organizationId: "org" });
	mocks.turns.mockReset().mockResolvedValue([]);
});

describe("Parlume project history", () => {
	it("requires project read permission and scopes every page to the authorized project and tenant", async () => {
		expect(mocks.permission).toHaveBeenCalledWith("project:read");
		await mocks.handler?.({
			input: { projectId: "project", sessionId: "other-session" },
		});
		expect(mocks.project).toHaveBeenCalledWith("project");
		expect(mocks.turns).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					projectId: "project",
					organizationId: "org",
					sessionId: "other-session",
				},
				take: 31,
			}),
		);
	});
	it("refuses history when the project or feature is unavailable", async () => {
		mocks.project.mockRejectedValueOnce(new Error("Not found"));
		await expect(
			mocks.handler?.({ input: { projectId: "other" } }),
		).rejects.toThrow("Not found");
		expect(mocks.turns).not.toHaveBeenCalled();
	});
	it("uses a stable timestamp and id cursor without dropping equal-time requests", async () => {
		const createdAt = new Date("2026-09-30T12:00:00Z");
		const rows = Array.from({ length: 31 }, (_, index) => ({
			id: `turn-${index}`,
			createdAt,
		}));
		mocks.turns.mockResolvedValue(rows);
		const response = await mocks.handler?.({
			input: { projectId: "project", before: { id: "prior", createdAt } },
		});
		expect(response).toEqual({
			items: rows.slice(0, 30),
			nextCursor: { id: "turn-29", createdAt },
		});
		expect(mocks.turns).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					OR: [
						{ createdAt: { lt: createdAt } },
						{ createdAt, id: { lt: "prior" } },
					],
				}),
				orderBy: [{ createdAt: "desc" }, { id: "desc" }],
			}),
		);
	});
});
