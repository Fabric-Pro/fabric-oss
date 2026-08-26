/**
 * Whose prompt may you nominate, and whose may an approval bind?
 *
 * `bind.set` has always confirmed the caller can actually REACH the version it
 * is told to bind (`loadBindablePromptVersion`) — without it, a version id is
 * enough to bind another tenant's prompt content, which is both cross-tenant
 * exposure and injection. The nomination path was added later and did not carry
 * that control over, so it accepted ANY version id.
 *
 * That is worse here than at the bind site, because a nomination is *shown* to
 * a reviewer: the queue returns the version's content, so a member of one
 * organization could put another organization's private prompt in front of
 * their own admin, who then reads it and — on approve — binds it.
 *
 * Reachability is NOT the same rule as `assertVersionSuitsScope`. Promoting a
 * personal prompt to a shared tier is the entire point of nomination, so the
 * version's own scope is deliberately allowed to sit below the target tier.
 * What is checked is only whether the person is entitled to the content.
 *
 * Run with:
 *   pnpm --filter @repo/api test modules/prompts/__tests__/nominate-version-access.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	promptVersionFindUnique,
	createPromptNomination,
	approvePromptNomination,
	getNominationById,
	verifyOrganizationMembership,
	requireOrganizationAdmin,
} = vi.hoisted(() => ({
	promptVersionFindUnique: vi.fn(),
	createPromptNomination: vi.fn(),
	approvePromptNomination: vi.fn(),
	getNominationById: vi.fn(),
	verifyOrganizationMembership: vi.fn(),
	requireOrganizationAdmin: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	createPromptNomination,
	approvePromptNomination,
	getNominationById,
	declinePromptNomination: vi.fn(),
	listPendingNominations: vi.fn().mockResolvedValue([]),
	withdrawPromptNomination: vi.fn(),
	getBoundPromptVersion: vi.fn().mockResolvedValue(null),
	listPromptDefaultRecipients: vi.fn().mockResolvedValue([]),
	// The reviewing tier is notified on create (FR16); not this file's subject.
	listPromptNominationReviewers: vi.fn().mockResolvedValue([]),
	db: {
		promptVersion: { findUnique: promptVersionFindUnique },
		// The FR16 deep-link resolves the org slug; no row → personal-context path.
		organization: { findUnique: vi.fn().mockResolvedValue(null) },
	},
}));

vi.mock("../../organizations/lib/membership", () => ({
	verifyOrganizationMembership,
}));

vi.mock("../../../lib/notification-service", () => ({
	fanOut: {
		promptDefaultUpdated: vi.fn(),
		promptNominationPending: vi.fn(),
	},
}));

vi.mock("../lib/nomination-summary", () => ({
	summariseNominationChange: vi
		.fn()
		.mockResolvedValue({ summary: "s", degraded: false }),
}));

vi.mock("../../../orpc/procedures", () => ({
	Permissions: { PROMPT_READ: "prompt:read", PROMPT_UPDATE: "prompt:update" },
	requirePermission: () => (next: unknown) => next,
	requireInputOrgPermission: () => (next: unknown) => next,
	requireOrganizationAdmin,
	resolveOrganizationId: (
		input: string | null | undefined,
		_session: unknown,
	) => input ?? null,
	tenantProtectedProcedure: {
		use: () => ({
			route: () => ({
				input: () => ({
					output: () => ({ handler: (fn: unknown) => fn }),
				}),
			}),
		}),
	},
}));

import { nominateProcedures } from "../procedures/nominate";

type Handler = (a: unknown) => Promise<unknown>;

const TARGET = {
	targetKey: "test_case_drafter",
	documentType: "GENERAL",
	storyKind: null,
};

const create = (
	input: Record<string, unknown> = {},
	user: { id?: string; role?: string | null } = {},
) =>
	(nominateProcedures.create as unknown as Handler)({
		input: {
			promptVersionId: "pv-1",
			targetScope: "ORG",
			organizationId: "org-a",
			targets: [TARGET],
			...input,
		},
		context: {
			user: { id: user.id ?? "member-1", role: user.role ?? null },
			session: {},
		},
	});

beforeEach(() => {
	promptVersionFindUnique.mockReset();
	createPromptNomination.mockReset();
	createPromptNomination.mockResolvedValue({ id: "nom-1" });
	approvePromptNomination.mockReset();
	approvePromptNomination.mockResolvedValue({
		approved: { id: "nom-1" },
		supersededCount: 0,
	});
	getNominationById.mockReset();
	verifyOrganizationMembership.mockReset();
	verifyOrganizationMembership.mockResolvedValue({ role: "member" });
	requireOrganizationAdmin.mockReset();
	requireOrganizationAdmin.mockResolvedValue(undefined);
});

describe("nominations.create — which versions the nominator may reach", () => {
	it("refuses another organization's prompt version", async () => {
		// THE BUG THIS EXISTS FOR: a member of org A sends a version id
		// belonging to org B. Accepting it puts org B's private prompt content
		// in front of org A's admin, and binds it if they approve.
		promptVersionFindUnique.mockResolvedValue({
			scope: "ORG",
			userId: null,
			organizationId: "org-b",
			content: "org B's private prompt",
			id: "pv-1",
			prompt: { id: "p-1", name: "Theirs" },
		});

		await expect(create()).rejects.toThrow();
		expect(createPromptNomination).not.toHaveBeenCalled();
	});

	it("refuses another user's personal prompt version", async () => {
		promptVersionFindUnique.mockResolvedValue({
			scope: "USER",
			userId: "someone-else",
			organizationId: null,
			content: "their private prompt",
			id: "pv-1",
			prompt: { id: "p-1", name: "Theirs" },
		});

		await expect(create()).rejects.toThrow();
		expect(createPromptNomination).not.toHaveBeenCalled();
	});

	it("allows your own personal prompt — promoting one upward is the point", async () => {
		promptVersionFindUnique.mockResolvedValue({
			scope: "USER",
			userId: "member-1",
			organizationId: null,
			content: "my prompt",
			id: "pv-1",
			prompt: { id: "p-1", name: "Mine" },
		});

		await create();

		expect(createPromptNomination).toHaveBeenCalledWith(
			expect.objectContaining({ promptVersionId: "pv-1" }),
		);
	});

	it("allows your own organization's prompt", async () => {
		promptVersionFindUnique.mockResolvedValue({
			scope: "ORG",
			userId: null,
			organizationId: "org-a",
			content: "our prompt",
			id: "pv-1",
			prompt: { id: "p-1", name: "Ours" },
		});

		await create();

		expect(createPromptNomination).toHaveBeenCalledTimes(1);
	});

	it("allows a system prompt", async () => {
		promptVersionFindUnique.mockResolvedValue({
			scope: "SYSTEM",
			userId: null,
			organizationId: null,
			content: "system prompt",
			id: "pv-1",
			prompt: { id: "p-1", name: "System" },
		});

		await create();

		expect(createPromptNomination).toHaveBeenCalledTimes(1);
	});
});

describe("nominations.approve — the stored version id is re-checked", () => {
	const approve = () =>
		(nominateProcedures.approve as unknown as Handler)({
			input: { nominationId: "nom-1", organizationId: "org-a" },
			context: {
				user: { id: "admin-1", role: null },
				session: {},
			},
		});

	const pendingOrgNomination = {
		id: "nom-1",
		status: "PENDING",
		targetScope: "ORG",
		organizationId: "org-a",
		promptVersionId: "pv-1",
		nominatedById: "member-1",
		targets: [TARGET],
	};

	it("refuses to bind a version the nominator cannot reach", async () => {
		// Create-time validation is not sufficient on its own: the row stores an
		// id, and approval happens later, by someone else. A row written before
		// this check existed — or a nominator who has since lost access — must
		// not become a live binding.
		getNominationById.mockResolvedValue(pendingOrgNomination);
		promptVersionFindUnique.mockResolvedValue({
			scope: "ORG",
			userId: null,
			organizationId: "org-b",
			id: "pv-1",
		});
		verifyOrganizationMembership.mockResolvedValue(null);

		await expect(approve()).rejects.toThrow();
		expect(approvePromptNomination).not.toHaveBeenCalled();
	});

	it("binds the nominator's own personal prompt", async () => {
		getNominationById.mockResolvedValue(pendingOrgNomination);
		promptVersionFindUnique.mockResolvedValue({
			scope: "USER",
			userId: "member-1",
			organizationId: null,
			id: "pv-1",
		});

		await approve();

		expect(approvePromptNomination).toHaveBeenCalledTimes(1);
	});

	it("binds an org prompt when the nominator is still a member of that org", async () => {
		getNominationById.mockResolvedValue(pendingOrgNomination);
		promptVersionFindUnique.mockResolvedValue({
			scope: "ORG",
			userId: null,
			organizationId: "org-a",
			id: "pv-1",
		});
		verifyOrganizationMembership.mockResolvedValue({ role: "member" });

		await approve();

		expect(approvePromptNomination).toHaveBeenCalledTimes(1);
	});
});
