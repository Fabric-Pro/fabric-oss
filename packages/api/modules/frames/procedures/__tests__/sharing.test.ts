/**
 * The app's share and invite procedures are `shareFrame`'s callers, not a
 * second copy of its rules: the organization's policy for public links and
 * invitation domains is `shareFrame`'s (its own test pins it, and the Fabric
 * Agent's `fabric_share_frame` calls it too). What these cases pin is what the
 * procedures hand it and what they hand back.
 *
 * Run with: pnpm --filter @repo/api test modules/frames/procedures/__tests__/sharing.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type InputSchema = {
	safeParse: (input: unknown) => {
		success: boolean;
		data?: Record<string, unknown>;
	};
};

const { handlers, schemas, mockShareFrame, mockRevokeFrameSharing } =
	vi.hoisted(() => ({
		handlers: {} as Record<string, (...args: unknown[]) => unknown>,
		schemas: {} as Record<string, InputSchema>,
		mockShareFrame: vi.fn(),
		mockRevokeFrameSharing: vi.fn(),
	}));

vi.mock("@repo/database", () => ({
	shareFrame: mockShareFrame,
	revokeFrameSharing: mockRevokeFrameSharing,
}));

vi.mock("../../../../orpc/procedures", () => {
	let current = "";
	const chainable: any = {
		use: () => chainable,
		route: (route: { path: string }) => {
			current = route.path;
			return chainable;
		},
		input: (schema: InputSchema) => {
			schemas[current] = schema;
			return chainable;
		},
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			handlers[current] = fn;
			return { _handler: fn };
		},
	};
	return {
		tenantProtectedProcedure: chainable,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requirePermission: () => (c: unknown) => c,
		requireInputOrgPermission: () => (c: unknown) => c,
		resolveOrganizationId: vi.fn(
			(organizationId: string | null | undefined) =>
				organizationId ?? undefined,
		),
	};
});

import "../invite-email";
import "../share";
import "../revoke-share";
import "../revoke-invite";

const SHARE = "/frames/{id}/share";
const INVITE = "/frames/{id}/invite";

const run = (path: string, input: Record<string, unknown>) =>
	handlers[path]({
		input: { id: "frame-1", organizationId: "org-1", ...input },
		context: { user: { id: "owner-1" }, session: {} },
	});

beforeEach(() => {
	vi.clearAllMocks();
});

describe("frames.share", () => {
	it("takes only the four scopes", () => {
		const accepted = [
			"PRIVATE",
			"EMAILS_ONLY",
			"WORKSPACE_AND_EMAILS",
			"PUBLIC",
		];

		for (const shareScope of accepted) {
			expect(
				schemas[SHARE].safeParse({ id: "f", shareScope }).success,
			).toBe(true);
		}
		expect(
			schemas[SHARE].safeParse({ id: "f", shareScope: "PROJECT" })
				.success,
		).toBe(false);
	});

	it("changes the scope of the caller's own frame in their organization, and nothing else", async () => {
		mockShareFrame.mockResolvedValue({
			ok: true,
			updatedAt: new Date("2026-11-01T00:00:00Z"),
			scope: "EMAILS_ONLY",
			invited: [],
			grants: [],
		});

		const result = await run(SHARE, { shareScope: "EMAILS_ONLY" });

		expect(mockShareFrame).toHaveBeenCalledWith({
			frameId: "frame-1",
			userId: "owner-1",
			organizationId: "org-1",
			scope: "EMAILS_ONLY",
		});
		expect(result).toEqual({
			success: true,
			updatedAt: "2026-11-01T00:00:00.000Z",
			shareToken: undefined,
			shareUrl: undefined,
		});
	});

	it("hands back the public link when one is made", async () => {
		mockShareFrame.mockResolvedValue({
			ok: true,
			updatedAt: new Date("2026-11-01T00:00:00Z"),
			scope: "PUBLIC",
			shareToken: "link-token",
			invited: [],
			grants: [],
		});

		const result = await run(SHARE, { shareScope: "PUBLIC" });

		expect(result).toMatchObject({
			success: true,
			updatedAt: "2026-11-01T00:00:00.000Z",
			shareToken: "link-token",
			shareUrl: expect.stringMatching(/\/share\/frame\/link-token$/),
		});
	});

	it("says what the command refused, as its own sentence", async () => {
		mockShareFrame.mockResolvedValue({
			ok: false,
			reason: "public_sharing_disabled",
			message: "Public sharing is disabled for this organization.",
		});

		const result = await run(SHARE, { shareScope: "PUBLIC" });

		expect(result).toEqual({
			success: false,
			error: "Public sharing is disabled for this organization.",
		});
	});
});

describe("frames.invite", () => {
	it("takes between one and fifty valid addresses", () => {
		const parse = (emails: unknown) =>
			schemas[INVITE].safeParse({ id: "f", emails }).success;

		expect(parse(["a@example.com"])).toBe(true);
		expect(parse([])).toBe(false);
		expect(parse(["not-an-email"])).toBe(false);
		expect(
			parse(Array.from({ length: 51 }, (_, i) => `u${i}@example.com`)),
		).toBe(false);
	});

	it("invites on the frame's own scope: it names no scope, so it cannot change one", async () => {
		mockShareFrame.mockResolvedValue({
			ok: true,
			updatedAt: new Date("2026-11-01T00:00:00Z"),
			scope: "EMAILS_ONLY",
			invited: ["a@example.com"],
			grants: [],
		});

		await run(INVITE, { emails: ["a@example.com"] });

		const call = mockShareFrame.mock.calls[0][0];
		expect(call).toEqual({
			frameId: "frame-1",
			userId: "owner-1",
			organizationId: "org-1",
			emails: ["a@example.com"],
		});
		expect(call).not.toHaveProperty("scope");
	});

	it("hands back the grants it made, with their dates as text", async () => {
		const invitedAt = new Date("2026-10-15T10:00:00Z");
		mockShareFrame.mockResolvedValue({
			ok: true,
			updatedAt: new Date("2026-11-01T00:00:00Z"),
			scope: "EMAILS_ONLY",
			invited: ["a@example.com"],
			grants: [
				{
					id: "grant-1",
					frameId: "frame-1",
					email: "a@example.com",
					invitedBy: "owner-1",
					invitedAt,
					lastAccessedAt: null,
					accessCount: 0,
				},
			],
		});

		const result = await run(INVITE, { emails: ["a@example.com"] });

		expect(result).toEqual({
			success: true,
			updatedAt: "2026-11-01T00:00:00.000Z",
			grants: [
				{
					id: "grant-1",
					email: "a@example.com",
					invitedAt: "2026-10-15T10:00:00.000Z",
				},
			],
		});
	});

	it("says what the command refused, as its own sentence, and invites no one", async () => {
		mockShareFrame.mockResolvedValue({
			ok: false,
			reason: "email_domain_not_allowed",
			message:
				"This organization allows invitations only to the domains example.com.",
			emails: ["stranger@outside.test"],
		});

		const result = await run(INVITE, { emails: ["stranger@outside.test"] });

		expect(result).toEqual({
			success: false,
			error: "This organization allows invitations only to the domains example.com.",
		});
	});
});

describe("explicit revocation", () => {
	it.each(["public-link", "all"])(
		"forwards %s with the reviewed revision and current actor",
		async (mode) => {
			mockRevokeFrameSharing.mockResolvedValue({
				ok: true,
				scope: "PRIVATE",
				revokedInvitations: 2,
				updatedAt: new Date("2026-11-02T00:00:00Z"),
			});
			await run("/frames/{id}/revoke-share", {
				mode,
				expectedUpdatedAt: "2026-11-01T00:00:00Z",
			});
			expect(mockRevokeFrameSharing).toHaveBeenCalledWith({
				frameId: "frame-1",
				userId: "owner-1",
				organizationId: "org-1",
				mode,
				expectedUpdatedAt: new Date("2026-11-01T00:00:00Z"),
			});
		},
	);
	it("invitation removal cannot broaden into revoke-all", async () => {
		mockRevokeFrameSharing.mockResolvedValue({
			ok: true,
			scope: "EMAILS_ONLY",
			revokedInvitations: 1,
			updatedAt: new Date("2026-11-02T00:00:00Z"),
		});
		await run("/frames/{id}/revoke-invite", {
			email: "person@example.com",
			expectedUpdatedAt: "2026-11-01T00:00:00Z",
		});
		expect(mockRevokeFrameSharing).toHaveBeenCalledWith(
			expect.objectContaining({
				mode: "invitation",
				email: "person@example.com",
				expectedUpdatedAt: new Date("2026-11-01T00:00:00Z"),
			}),
		);
	});
	it("forwards the reviewed revision for scope changes", async () => {
		mockShareFrame.mockResolvedValue({
			ok: true,
			scope: "EMAILS_ONLY",
			invited: [],
			grants: [],
			updatedAt: new Date("2026-11-02T00:00:00Z"),
		});
		await run(SHARE, {
			shareScope: "EMAILS_ONLY",
			expectedUpdatedAt: "2026-11-01T00:00:00Z",
		});
		expect(mockShareFrame).toHaveBeenCalledWith(
			expect.objectContaining({
				expectedUpdatedAt: new Date("2026-11-01T00:00:00Z"),
			}),
		);
	});
});
