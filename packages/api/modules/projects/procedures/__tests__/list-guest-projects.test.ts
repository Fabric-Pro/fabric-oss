/**
 * Tests for `listGuestProjectsProcedure` (`projects.listGuest`).
 *
 * The procedure is a session-keyed cross-org personal surface: it must call
 * the `listGuestProjects` DB helper with the AUTHENTICATED user's id (never
 * anything caller-supplied) and surface the rows as `{ projects }`.
 * Guest-only row scoping (accepted + unexpired ProjectMember, no org Member
 * row) is enforced inside the DB helper and covered by the @repo/database
 * unit test, not re-tested here.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, mockListGuestProjects } = vi.hoisted(() => ({
	handlers: {} as Record<string, (...args: unknown[]) => unknown>,
	mockListGuestProjects: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	listGuestProjects: (...args: unknown[]) => mockListGuestProjects(...args),
}));

vi.mock("../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			handlers.listGuest = fn;
			return { _handler: fn };
		},
	});
	return {
		protectedProcedure: chainable,
	};
});

// Importing the module registers its handler in `handlers`.
import "../list-guest-projects";

type ListGuestHandler = (args: {
	context: { user: { id: string } };
}) => Promise<{ projects: unknown[] }>;

const handler = handlers.listGuest as ListGuestHandler;

const context = {
	user: { id: "user-1" },
};

beforeEach(() => {
	vi.clearAllMocks();
});

describe("listGuestProjectsProcedure", () => {
	it("returns { projects } from listGuestProjects for the session user", async () => {
		const guestProjects = [
			{
				id: "proj-1",
				name: "Shared project",
				organization: { id: "org-1", slug: "acme", name: "Acme" },
			},
		];
		mockListGuestProjects.mockResolvedValue(guestProjects);

		const result = await handler({ context });

		expect(result).toEqual({ projects: guestProjects });
		expect(mockListGuestProjects).toHaveBeenCalledTimes(1);
		expect(mockListGuestProjects).toHaveBeenCalledWith("user-1");
	});

	it("keys the query on the AUTHENTICATED user id only (no caller-supplied id)", async () => {
		mockListGuestProjects.mockResolvedValue([]);

		await handler({
			context: { user: { id: "user-2" } },
		});

		expect(mockListGuestProjects).toHaveBeenCalledWith("user-2");
		// Exactly one argument — nothing from the request can widen the scope.
		expect(mockListGuestProjects.mock.calls[0]).toHaveLength(1);
	});

	it("passes an empty list through unchanged (section hidden client-side)", async () => {
		mockListGuestProjects.mockResolvedValue([]);

		await expect(handler({ context })).resolves.toEqual({ projects: [] });
	});
});
