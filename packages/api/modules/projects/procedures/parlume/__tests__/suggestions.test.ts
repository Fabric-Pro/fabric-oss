import { beforeEach, describe, expect, it, vi } from "vitest";

type SuggestionsInput = { projectId: string; sessionId: string };
const mocks = vi.hoisted(() => ({
	project: vi.fn(),
	suggestions: vi.fn(),
	permission: vi.fn(),
	handler: undefined as
		| ((args: { input: SuggestionsInput }) => Promise<unknown>)
		| undefined,
}));
vi.mock("@repo/database", () => ({
	db: { parlumeSuggestion: { findMany: mocks.suggestions } },
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
await import("../suggestions");

beforeEach(() => {
	mocks.project
		.mockReset()
		.mockResolvedValue({ id: "project", organizationId: "org" });
	mocks.suggestions.mockReset().mockResolvedValue([]);
});

describe("Parlume session suggestions", () => {
	it("needs the Requests list's project read permission and scopes to the authorized project and tenant, newest first", async () => {
		expect(mocks.permission).toHaveBeenCalledWith("project:read");
		const row = {
			id: "suggestion-1",
			kind: "MISSED_QUESTION",
			audience: "TEAM",
			text: "Who signs off the migration?",
			speaker: "Dana",
			quote: "we cover the data migration",
			topic: "Data migration",
			chatTag: null,
			createdAt: new Date("2026-11-04T10:00:00Z"),
		};
		mocks.suggestions.mockResolvedValue([row]);

		await expect(
			mocks.handler?.({
				input: { projectId: "project", sessionId: "session-1" },
			}),
		).resolves.toEqual({ items: [row] });
		expect(mocks.project).toHaveBeenCalledWith("project");
		expect(mocks.suggestions).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					projectId: "project",
					organizationId: "org",
					sessionId: "session-1",
				},
				orderBy: [{ createdAt: "desc" }, { id: "desc" }],
				take: 50,
			}),
		);
	});

	it("refuses when the project or feature is unavailable", async () => {
		mocks.project.mockRejectedValueOnce(new Error("Not found"));

		await expect(
			mocks.handler?.({
				input: { projectId: "other", sessionId: "session-1" },
			}),
		).rejects.toThrow("Not found");
		expect(mocks.suggestions).not.toHaveBeenCalled();
	});
});
