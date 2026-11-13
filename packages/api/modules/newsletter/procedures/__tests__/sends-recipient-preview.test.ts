/**
 * Unit tests for `newsletter.sends.recipientPreview`. Same offline harness as
 * sends-chat-deliveries.test.ts: `@repo/database` and the procedure builders
 * are mocked and the handler is invoked directly. The real
 * `assertInputOrgMatchesProject` runs, so the organization guard is exercised.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockProjectFindUnique, mockPreviewCount } = vi.hoisted(() => ({
	mockProjectFindUnique: vi.fn(),
	mockPreviewCount: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: { project: { findUnique: mockProjectFindUnique } },
	previewNewsletterSendRecipientCount: mockPreviewCount,
}));

vi.mock("../../../../orpc/procedures", () => {
	const chainable: any = {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => ({ _handler: fn }),
	};
	return {
		tenantProtectedProcedure: chainable,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requireProjectPermission: () => (c: unknown) => c,
	};
});

import { recipientPreviewProcedure } from "../sends-recipient-preview";

type Handler = (args: { input: unknown; context: unknown }) => Promise<unknown>;
const recipientPreview = (
	recipientPreviewProcedure as unknown as { _handler: Handler }
)._handler;

const context = { organizationId: "org-1", user: { id: "u1" } };

beforeEach(() => {
	vi.clearAllMocks();
	mockProjectFindUnique.mockResolvedValue({
		id: "p1",
		organizationId: "org-1",
	});
	mockPreviewCount.mockResolvedValue({ recipientCount: 3 });
});

describe("newsletter.sends.recipientPreview", () => {
	it("returns the count for the project", async () => {
		await expect(
			recipientPreview({
				input: { projectId: "p1", organizationId: "org-1" },
				context,
			}),
		).resolves.toEqual({ recipientCount: 3 });
		expect(mockPreviewCount).toHaveBeenCalledWith("p1");
	});

	it("rejects an organizationId that does not own the project", async () => {
		await expect(
			recipientPreview({
				input: { projectId: "p1", organizationId: "org-other" },
				context,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mockPreviewCount).not.toHaveBeenCalled();
	});

	it("returns NOT_FOUND for a missing project", async () => {
		mockProjectFindUnique.mockResolvedValue(null);
		await expect(
			recipientPreview({ input: { projectId: "nope" }, context }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mockPreviewCount).not.toHaveBeenCalled();
	});
});
