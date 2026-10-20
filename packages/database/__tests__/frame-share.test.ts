/**
 * Who can open a frame is changed by one command, `shareFrame`, which the app's
 * share and invite procedures and the Fabric Agent's `fabric_share_frame` all
 * call. What it owns, and what these cases pin: a public link needs the
 * organization to allow public links; an email is invited only from a domain
 * the organization allows, whether it arrives with a scope change or on its
 * own; emails are not invited on a private or public frame; the frame must be
 * the caller's own; and an email already invited is not invited twice.
 *
 * The store is faked; what these cases assert on is what would be written.
 *
 * Run with: pnpm --filter @repo/database test __tests__/frame-share
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findFrame: vi.fn(),
	findOrganization: vi.fn(),
	updateScope: vi.fn(),
	listGrants: vi.fn(),
	createGrants: vi.fn(),
}));

vi.mock("../prisma/client", async (importOriginal) => ({
	...(await importOriginal<typeof import("../prisma/client")>()),
	db: {
		agentWorkspaceFile: { findFirst: mocks.findFrame },
		organization: { findUnique: mocks.findOrganization },
	},
}));

vi.mock("../prisma/queries/frame-sharing", () => ({
	updateFrameShareScope: mocks.updateScope,
	listSharingGrants: mocks.listGrants,
	createMultipleSharingGrants: mocks.createGrants,
}));

import {
	PUBLIC_SHARING_DISABLED_MESSAGE,
	publicSharingRefusal,
	shareFrame,
} from "../prisma/queries/frame-share";

const NOW = new Date("2026-10-15T10:00:00Z");

function policy(overrides: Record<string, unknown> = {}) {
	return {
		canShareFramesPublicly: false,
		allowedFrameShareDomains: [] as string[],
		...overrides,
	};
}

const grant = (email: string) => ({
	id: `grant-${email}`,
	frameId: "frame-1",
	email,
	invitedBy: "owner-1",
	invitedAt: NOW,
	lastAccessedAt: null,
	accessCount: 0,
});

const share = (input: Partial<Parameters<typeof shareFrame>[0]> = {}) =>
	shareFrame({
		frameId: "frame-1",
		userId: "owner-1",
		organizationId: "org-1",
		...input,
	});

beforeEach(() => {
	vi.clearAllMocks();
	mocks.findFrame.mockResolvedValue({ shareScope: "PRIVATE" });
	mocks.findOrganization.mockResolvedValue(policy());
	mocks.updateScope.mockResolvedValue({ success: true });
	mocks.listGrants.mockResolvedValue([]);
	mocks.createGrants.mockImplementation(
		async (_frameId: string, emails: string[]) => emails.map(grant),
	);
});

describe("shareFrame", () => {
	describe("the frame", () => {
		it("is looked up as the caller's own, in their organization", async () => {
			await share({ scope: "EMAILS_ONLY" });

			expect(mocks.findFrame).toHaveBeenCalledWith(
				expect.objectContaining({
					where: expect.objectContaining({
						id: "frame-1",
						userId: "owner-1",
						organizationId: "org-1",
					}),
				}),
			);
		});

		it("is not found, and nothing changes, when it is not the caller's", async () => {
			mocks.findFrame.mockResolvedValue(null);

			const outcome = await share({
				scope: "EMAILS_ONLY",
				emails: ["colleague@example.com"],
			});

			expect(outcome).toMatchObject({
				ok: false,
				reason: "frame_not_found",
			});
			expect(mocks.updateScope).not.toHaveBeenCalled();
			expect(mocks.createGrants).not.toHaveBeenCalled();
		});

		it("is not found when the scope change finds no frame to change", async () => {
			mocks.updateScope.mockResolvedValue({
				success: false,
				error: "Frame not found",
			});

			const outcome = await share({ scope: "EMAILS_ONLY" });

			expect(outcome).toMatchObject({
				ok: false,
				reason: "frame_not_found",
			});
		});
	});

	describe("a public link", () => {
		it("is refused when the organization does not allow public links, and the scope is left as it was", async () => {
			mocks.findOrganization.mockResolvedValue(
				policy({ canShareFramesPublicly: false }),
			);

			const outcome = await share({ scope: "PUBLIC" });

			expect(outcome).toMatchObject({
				ok: false,
				reason: "public_sharing_disabled",
			});
			expect(mocks.updateScope).not.toHaveBeenCalled();
		});

		it("is made, with its token, when the organization allows it", async () => {
			mocks.findOrganization.mockResolvedValue(
				policy({ canShareFramesPublicly: true }),
			);
			mocks.updateScope.mockResolvedValue({
				success: true,
				shareToken: "link-token",
			});

			const outcome = await share({ scope: "PUBLIC" });

			expect(outcome).toMatchObject({
				ok: true,
				scope: "PUBLIC",
				shareToken: "link-token",
			});
			expect(mocks.updateScope).toHaveBeenCalledWith({
				frameId: "frame-1",
				userId: "owner-1",
				organizationId: "org-1",
				shareScope: "PUBLIC",
			});
		});

		it("is not part of an unrelated scope change: no token comes back for emails only", async () => {
			mocks.updateScope.mockResolvedValue({
				success: true,
				shareToken: "stale-token",
			});

			const outcome = await share({ scope: "EMAILS_ONLY" });

			expect(outcome).toMatchObject({ ok: true, scope: "EMAILS_ONLY" });
			expect(outcome).not.toHaveProperty("shareToken");
		});
	});

	describe("an invitation", () => {
		beforeEach(() => {
			mocks.findOrganization.mockResolvedValue(
				policy({ allowedFrameShareDomains: ["example.com"] }),
			);
		});

		it("is refused for an address outside the allowed domains, with the scope change that came with it", async () => {
			const outcome = await share({
				scope: "EMAILS_ONLY",
				emails: ["colleague@example.com", "stranger@outside.test"],
			});

			expect(outcome).toMatchObject({
				ok: false,
				reason: "email_domain_not_allowed",
				emails: ["stranger@outside.test"],
			});
			expect(mocks.updateScope).not.toHaveBeenCalled();
			expect(mocks.createGrants).not.toHaveBeenCalled();
		});

		it("is refused for an address outside the allowed domains when it arrives on its own, as the app's invite does", async () => {
			mocks.findFrame.mockResolvedValue({ shareScope: "EMAILS_ONLY" });

			const outcome = await share({ emails: ["stranger@outside.test"] });

			expect(outcome).toMatchObject({
				ok: false,
				reason: "email_domain_not_allowed",
			});
			expect(mocks.createGrants).not.toHaveBeenCalled();
		});

		it("is not fooled by a look-alike domain or letter case", async () => {
			mocks.findFrame.mockResolvedValue({ shareScope: "EMAILS_ONLY" });

			const outcome = await share({
				emails: [
					"a@example.com.outside.test",
					"b@notexample.com",
					"c@Example.com",
				],
			});

			expect(outcome).toMatchObject({
				ok: false,
				reason: "email_domain_not_allowed",
				emails: ["a@example.com.outside.test", "b@notexample.com"],
			});
		});

		it("is made for an allowed address, and the scope is changed with it", async () => {
			const outcome = await share({
				scope: "WORKSPACE_AND_EMAILS",
				emails: ["Colleague@Example.com"],
			});

			expect(outcome).toMatchObject({
				ok: true,
				scope: "WORKSPACE_AND_EMAILS",
				invited: ["colleague@example.com"],
			});
			expect(mocks.updateScope).toHaveBeenCalledTimes(1);
			expect(mocks.createGrants).toHaveBeenCalledWith(
				"frame-1",
				["colleague@example.com"],
				"owner-1",
			);
		});

		it("takes an organization's domains as it wrote them, with or without a leading @", async () => {
			mocks.findOrganization.mockResolvedValue(
				policy({ allowedFrameShareDomains: ["@Example.com"] }),
			);

			const outcome = await share({
				scope: "EMAILS_ONLY",
				emails: ["colleague@example.com"],
			});

			expect(outcome).toMatchObject({ ok: true });
		});

		it("is open to any address when the organization lists no domains", async () => {
			mocks.findOrganization.mockResolvedValue(
				policy({ allowedFrameShareDomains: [] }),
			);

			const outcome = await share({
				scope: "EMAILS_ONLY",
				emails: ["anyone@outside.test"],
			});

			expect(outcome).toMatchObject({ ok: true });
		});

		it("is not made twice for an address already invited", async () => {
			mocks.listGrants.mockResolvedValue([
				grant("colleague@example.com"),
			]);

			const outcome = await share({
				scope: "EMAILS_ONLY",
				emails: ["colleague@example.com", "second@example.com"],
			});

			expect(outcome).toMatchObject({
				ok: true,
				invited: ["second@example.com"],
			});
			expect(mocks.createGrants).toHaveBeenCalledWith(
				"frame-1",
				["second@example.com"],
				"owner-1",
			);
		});

		it("writes no grant when every address is invited already", async () => {
			mocks.listGrants.mockResolvedValue([
				grant("colleague@example.com"),
			]);

			const outcome = await share({
				scope: "EMAILS_ONLY",
				emails: ["colleague@example.com"],
			});

			expect(outcome).toMatchObject({
				ok: true,
				invited: [],
				grants: [],
			});
			expect(mocks.createGrants).not.toHaveBeenCalled();
		});

		it.each(["PRIVATE", "PUBLIC"] as const)(
			"is refused on a frame that is %s already, with the scope left as it was",
			async (current) => {
				mocks.findFrame.mockResolvedValue({ shareScope: current });

				const outcome = await share({
					emails: ["colleague@example.com"],
				});

				expect(outcome).toMatchObject({
					ok: false,
					reason: "emails_need_an_inviting_scope",
				});
				expect(mocks.createGrants).not.toHaveBeenCalled();
			},
		);

		it("is refused together with a scope change to private or public", async () => {
			mocks.findFrame.mockResolvedValue({ shareScope: "EMAILS_ONLY" });

			const outcome = await share({
				scope: "PRIVATE",
				emails: ["colleague@example.com"],
			});

			expect(outcome).toMatchObject({
				ok: false,
				reason: "emails_need_an_inviting_scope",
			});
			expect(mocks.updateScope).not.toHaveBeenCalled();
		});
	});
});

describe("publicSharingRefusal: the same rule, for a frame made public when created", () => {
	it("refuses where the organization does not allow public links, in the sentence shareFrame uses", async () => {
		mocks.findOrganization.mockResolvedValue(
			policy({ canShareFramesPublicly: false }),
		);

		const message = await publicSharingRefusal("org-1");
		const outcome = await share({ scope: "PUBLIC" });

		expect(message).toBe(PUBLIC_SHARING_DISABLED_MESSAGE);
		expect(outcome).toMatchObject({ ok: false, message });
	});

	it("allows it where the organization does", async () => {
		mocks.findOrganization.mockResolvedValue(
			policy({ canShareFramesPublicly: true }),
		);

		expect(await publicSharingRefusal("org-1")).toBeNull();
	});

	it("refuses an organization it cannot find, as shareFrame does", async () => {
		mocks.findOrganization.mockResolvedValue(null);

		expect(await publicSharingRefusal("org-1")).toBe(
			PUBLIC_SHARING_DISABLED_MESSAGE,
		);
	});

	it("has no policy to apply without an organization", async () => {
		expect(await publicSharingRefusal(undefined)).toBeNull();
		expect(mocks.findOrganization).not.toHaveBeenCalled();
	});
});
