import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	handlers,
	mockGetUserPendingInviteForProject,
	mockGetUserRecentMemberForProject,
	mockDismissInviteWelcomeWidget,
	mockRecordAudit,
} = vi.hoisted(() => ({
	handlers: {} as Record<string, (...args: unknown[]) => unknown>,
	mockGetUserPendingInviteForProject: vi.fn(),
	mockGetUserRecentMemberForProject: vi.fn(),
	mockDismissInviteWelcomeWidget: vi.fn(),
	mockRecordAudit: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	getUserPendingInviteForProject: (...a: unknown[]) =>
		mockGetUserPendingInviteForProject(...a),
	getUserRecentMemberForProject: (...a: unknown[]) =>
		mockGetUserRecentMemberForProject(...a),
	dismissInviteWelcomeWidget: (...a: unknown[]) =>
		mockDismissInviteWelcomeWidget(...a),
}));

vi.mock("../../../../../lib/audit", () => ({
	recordAuditFromRequest: (...a: unknown[]) => mockRecordAudit(...a),
}));

vi.mock("../../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			handlers.dismiss = fn;
			return { _handler: fn };
		},
	});
	return {
		protectedProcedure: chainable,
		resolveOrganizationId: (input: string | null | undefined) =>
			input ?? undefined,
	};
});

import "../dismiss-welcome-widget";

const ctx = {
	user: { id: "user-me", email: "me@example.com" },
	session: { id: "s-1", activeOrganizationId: null },
	headers: undefined,
};

beforeEach(() => {
	vi.clearAllMocks();
	mockGetUserRecentMemberForProject.mockResolvedValue(null);
});

describe("dismissWelcomeWidget", () => {
	it("throws NOT_FOUND when neither an invite nor a membership is in scope", async () => {
		mockGetUserPendingInviteForProject.mockResolvedValue(null);
		mockGetUserRecentMemberForProject.mockResolvedValue(null);
		await expect(
			handlers.dismiss({ input: { projectId: "p-evil" }, context: ctx }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mockDismissInviteWelcomeWidget).not.toHaveBeenCalled();
	});

	it("authorizes a guest dismissing via membership when there is no pending invite", async () => {
		mockGetUserPendingInviteForProject.mockResolvedValue(null);
		mockGetUserRecentMemberForProject.mockResolvedValue({
			acceptedAt: new Date("2026-06-16T00:00:00Z"),
			projectOrganizationId: "org-host",
		});
		mockDismissInviteWelcomeWidget.mockResolvedValue({});
		const res = await handlers.dismiss({
			input: { projectId: "pm-1", organizationId: null },
			context: ctx,
		});
		expect(res).toEqual({ success: true });
		// Member-only dismissal: org derived from the project's real org, and NO
		// dismissedInviteExpiry is passed (must not lower an existing invite watermark).
		// (toHaveBeenCalledWith ignores undefined props, so omitting the key here
		// matches a call that passed dismissedInviteExpiry: undefined.)
		expect(mockDismissInviteWelcomeWidget).toHaveBeenCalledWith({
			projectId: "pm-1",
			userId: "user-me",
			organizationId: "org-host",
		});
		expect(mockRecordAudit).toHaveBeenCalledWith(
			ctx,
			expect.objectContaining({
				action: "project.invitation.widget_dismissed",
				projectId: "pm-1",
			}),
		);
	});

	it("writes the dismissal with the project org + invite expiry, and audits", async () => {
		mockGetUserPendingInviteForProject.mockResolvedValue({
			id: "inv-7",
			expiresAt: new Date("2026-06-09T00:00:00Z"),
			projectOrganizationId: "org-2",
		});
		mockDismissInviteWelcomeWidget.mockResolvedValue({});
		const res = await handlers.dismiss({
			input: { projectId: "p-7", organizationId: "org-2" },
			context: ctx,
		});
		expect(res).toEqual({ success: true });
		expect(mockDismissInviteWelcomeWidget).toHaveBeenCalledWith({
			projectId: "p-7",
			userId: "user-me",
			organizationId: "org-2",
			dismissedInviteExpiry: new Date("2026-06-09T00:00:00Z"),
		});
		expect(mockRecordAudit).toHaveBeenCalledWith(
			ctx,
			expect.objectContaining({
				action: "project.invitation.widget_dismissed",
				projectId: "p-7",
			}),
		);
	});

	it("maps a null project org to organizationId:null on write and undefined in the audit", async () => {
		mockGetUserPendingInviteForProject.mockResolvedValue({
			id: "inv-9",
			expiresAt: new Date("2026-06-12T00:00:00Z"),
			projectOrganizationId: null,
		});
		mockDismissInviteWelcomeWidget.mockResolvedValue({});
		const res = await handlers.dismiss({
			input: { projectId: "p-9", organizationId: null },
			context: ctx,
		});
		expect(res).toEqual({ success: true });
		// Personal-tenant project: the dismissal preference is written with a
		// literal null org...
		expect(mockDismissInviteWelcomeWidget).toHaveBeenCalledWith({
			projectId: "p-9",
			userId: "user-me",
			organizationId: null,
			dismissedInviteExpiry: new Date("2026-06-12T00:00:00Z"),
		});
		// ...but the audit record receives undefined (deliberate null -> undefined
		// divergence via `?? undefined`).
		expect(mockRecordAudit).toHaveBeenCalledWith(
			ctx,
			expect.objectContaining({
				action: "project.invitation.widget_dismissed",
				projectId: "p-9",
				organizationId: undefined,
			}),
		);
	});
});
