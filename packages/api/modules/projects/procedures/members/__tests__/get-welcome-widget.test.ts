import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, mockGetInviteWelcomeWidgetData } = vi.hoisted(() => ({
	handlers: {} as Record<string, (...args: unknown[]) => unknown>,
	mockGetInviteWelcomeWidgetData: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	getInviteWelcomeWidgetData: (...a: unknown[]) =>
		mockGetInviteWelcomeWidgetData(...a),
}));

vi.mock("../../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			handlers.get = fn;
			return { _handler: fn };
		},
	});
	return {
		protectedProcedure: chainable,
		resolveOrganizationId: (input: string | null | undefined) => input,
	};
});

import "../get-welcome-widget";

const ctx = {
	user: { id: "user-me", email: "me@x.com" },
	session: { activeOrganizationId: null },
};

beforeEach(() => vi.clearAllMocks());

describe("getWelcomeWidget", () => {
	it("forwards the email/id from context.user (not input) and returns the helper result", async () => {
		const widgetData = {
			mostRecent: { invitationId: "inv-1", projectName: "Fabric Main" },
			totalCount: 1,
		};
		mockGetInviteWelcomeWidgetData.mockResolvedValue(widgetData);

		const res = await handlers.get({
			input: { organizationId: null },
			context: ctx,
		});

		// Identity is taken from the authenticated session, never from input —
		// this is the data-leak regression guard.
		expect(mockGetInviteWelcomeWidgetData).toHaveBeenCalledWith(
			"me@x.com",
			"user-me",
			null,
		);
		expect(res).toBe(widgetData);
	});
});
