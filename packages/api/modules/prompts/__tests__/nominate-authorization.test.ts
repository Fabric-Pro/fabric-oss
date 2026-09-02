/**
 * Who may decide a nomination, and whose nomination they may decide.
 *
 * Anyone with PROMPT_UPDATE — every org member — may PROPOSE a prompt as a
 * shared default; that is the point of the feature and it changes nothing on
 * its own. Accepting one writes the binding, so accepting carries exactly the
 * authority that writing the binding directly carries. A weaker gate here would
 * be a second, easier route to the same write, which is how the ORG gate in
 * `bind.set` was bypassable before card 2068.
 *
 * The subtle half is WHOSE nomination. Both the tier check and the tenant check
 * must read the nomination ROW, never the caller's input: an admin of org A who
 * passes their own organizationId alongside org B's nomination id must not
 * thereby review org B's queue.
 *
 * Run with:
 *   pnpm --filter @repo/api test modules/prompts/__tests__/nominate-authorization.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	approvePromptNomination,
	declinePromptNomination,
	getNominationById,
	listPendingNominations,
	withdrawPromptNomination,
	requireOrganizationAdmin,
} = vi.hoisted(() => ({
	approvePromptNomination: vi.fn(),
	declinePromptNomination: vi.fn(),
	getNominationById: vi.fn(),
	listPendingNominations: vi.fn(),
	withdrawPromptNomination: vi.fn(),
	requireOrganizationAdmin: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	approvePromptNomination,
	createPromptNomination: vi.fn(),
	declinePromptNomination,
	getNominationById,
	listPendingNominations,
	withdrawPromptNomination,
	getBoundPromptVersion: vi.fn().mockResolvedValue(null),
	listPromptDefaultAudience: vi.fn().mockResolvedValue([]),
	markOwnOverrides: vi.fn().mockResolvedValue([]),
	// The reviewing tier is notified on create (FR16); not this file's subject.
	listPromptNominationReviewers: vi.fn().mockResolvedValue([]),
	// A SYSTEM version — reachable by anyone, so approval's entitlement check
	// passes and these tests stay about TIER authority, which is their subject.
	db: {
		promptVersion: {
			findUnique: vi.fn().mockResolvedValue({
				id: "pv-1",
				scope: "SYSTEM",
				userId: null,
				organizationId: null,
			}),
		},
		// The FR16 deep-link resolves the org slug; no row → personal-context path.
		organization: { findUnique: vi.fn().mockResolvedValue(null) },
	},
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
					output: () => ({
						handler: (fn: unknown) => fn,
					}),
				}),
			}),
		}),
	},
}));

import { nominateProcedures } from "../procedures/nominate";

type Handler = (a: unknown) => Promise<unknown>;

const call = (
	procedure: keyof typeof nominateProcedures,
	input: Record<string, unknown>,
	user: { id?: string; role?: string | null } = {},
) =>
	(nominateProcedures[procedure] as unknown as Handler)({
		input,
		context: {
			user: { id: user.id ?? "user-1", role: user.role ?? null },
			session: {},
		},
	});

const SYSTEM_NOMINATION = {
	id: "nom-1",
	status: "PENDING",
	targetScope: "SYSTEM",
	organizationId: null,
	promptVersionId: "pv-1",
	// Approval re-derives entitlement from the nominator, so a fixture without
	// one cannot be approved. Version reachability itself is covered in
	// nominate-version-access.test.ts; here it is background.
	nominatedById: "member-1",
	targets: [
		{
			targetKey: "test_case_drafter",
			documentType: "GENERAL",
			storyKind: null,
		},
	],
};

const orgNomination = (organizationId: string) => ({
	...SYSTEM_NOMINATION,
	targetScope: "ORG",
	organizationId,
});

beforeEach(() => {
	approvePromptNomination.mockReset();
	approvePromptNomination.mockResolvedValue({
		approved: { id: "nom-1" },
		supersededCount: 0,
	});
	declinePromptNomination.mockReset();
	declinePromptNomination.mockResolvedValue({ id: "nom-1" });
	getNominationById.mockReset();
	listPendingNominations.mockReset();
	listPendingNominations.mockResolvedValue([]);
	withdrawPromptNomination.mockReset();
	requireOrganizationAdmin.mockReset();
	requireOrganizationAdmin.mockResolvedValue(undefined);
});

describe("approving a SYSTEM nomination", () => {
	beforeEach(() => {
		getNominationById.mockResolvedValue(SYSTEM_NOMINATION);
	});

	it("refuses an org member", async () => {
		await expect(
			call("approve", { nominationId: "nom-1" }),
		).rejects.toThrow(/platform admin/i);
		expect(approvePromptNomination).not.toHaveBeenCalled();
	});

	it("refuses an ORG admin — org authority is not platform authority", async () => {
		// The two role fields are orthogonal. Being owner of your own tenant
		// says nothing about setting the default every OTHER tenant inherits.
		await expect(
			call("approve", { nominationId: "nom-1", organizationId: "org-a" }),
		).rejects.toThrow(/platform admin/i);
	});

	it("allows a platform admin", async () => {
		await call("approve", { nominationId: "nom-1" }, { role: "admin" });

		expect(approvePromptNomination).toHaveBeenCalledWith(
			expect.objectContaining({
				targetScope: "SYSTEM",
				promptVersionId: "pv-1",
			}),
		);
	});
});

describe("approving an ORG nomination", () => {
	it("refuses when the caller is not an admin of the nomination's org", async () => {
		getNominationById.mockResolvedValue(orgNomination("org-b"));
		requireOrganizationAdmin.mockRejectedValue(new Error("Forbidden"));

		await expect(
			call("approve", { nominationId: "nom-1", organizationId: "org-b" }),
		).rejects.toThrow();
		expect(approvePromptNomination).not.toHaveBeenCalled();
	});

	it("checks admin against the nomination's org, not the caller's input", async () => {
		// The caller sends org-a, where they really are an admin. The
		// nomination belongs to org-b. Gating on the input would pass.
		getNominationById.mockResolvedValue(orgNomination("org-b"));

		await call("approve", {
			nominationId: "nom-1",
			organizationId: "org-a",
		}).catch(() => undefined);

		expect(requireOrganizationAdmin).toHaveBeenCalledWith(
			"org-b",
			"user-1",
		);
	});

	it("refuses a cross-tenant approval even from an admin of that org", async () => {
		// Defense in depth behind the admin check: the session is org-a and the
		// nomination is org-b, so this is not the tenant the caller is acting in.
		getNominationById.mockResolvedValue(orgNomination("org-b"));

		await expect(
			call("approve", { nominationId: "nom-1", organizationId: "org-a" }),
		).rejects.toThrow(/different organization/i);
		expect(approvePromptNomination).not.toHaveBeenCalled();
	});

	it("allows the org's own admin", async () => {
		getNominationById.mockResolvedValue(orgNomination("org-a"));

		await call("approve", {
			nominationId: "nom-1",
			organizationId: "org-a",
		});

		expect(approvePromptNomination).toHaveBeenCalledWith(
			expect.objectContaining({
				targetScope: "ORG",
				organizationId: "org-a",
			}),
		);
	});
});

describe("what gets bound", () => {
	beforeEach(() => {
		getNominationById.mockResolvedValue(SYSTEM_NOMINATION);
	});

	it("binds the proposed actions when the reviewer edits nothing", async () => {
		await call("approve", { nominationId: "nom-1" }, { role: "admin" });

		expect(approvePromptNomination).toHaveBeenCalledWith(
			expect.objectContaining({
				targets: [
					{
						targetKey: "test_case_drafter",
						documentType: "GENERAL",
						storyKind: null,
					},
				],
			}),
		);
	});

	it("binds the reviewer's edited set when they narrow it (FR23)", async () => {
		await call(
			"approve",
			{
				nominationId: "nom-1",
				targets: [
					{
						targetKey: "test_case_step_reviser",
						documentType: "GENERAL",
					},
				],
			},
			{ role: "admin" },
		);

		expect(approvePromptNomination).toHaveBeenCalledWith(
			expect.objectContaining({
				targets: [
					{
						targetKey: "test_case_step_reviser",
						documentType: "GENERAL",
						storyKind: null,
					},
				],
			}),
		);
	});
});

describe("deciding a nomination twice", () => {
	it("refuses a nomination that was already decided", async () => {
		// Two admins can hold the same queue open. The second one must be told,
		// not silently re-run the binding.
		getNominationById.mockResolvedValue({
			...SYSTEM_NOMINATION,
			status: "APPROVED",
		});

		await expect(
			call("approve", { nominationId: "nom-1" }, { role: "admin" }),
		).rejects.toThrow(/already approved/i);
		expect(approvePromptNomination).not.toHaveBeenCalled();
	});

	it("refuses to decline one that was already decided", async () => {
		getNominationById.mockResolvedValue({
			...SYSTEM_NOMINATION,
			status: "WITHDRAWN",
		});

		await expect(
			call("decline", { nominationId: "nom-1" }, { role: "admin" }),
		).rejects.toThrow(/already withdrawn/i);
		expect(declinePromptNomination).not.toHaveBeenCalled();
	});
});

describe("declining", () => {
	it("carries the same tier gate as approving", async () => {
		// Declining is a decision on someone else's proposal, and it closes it
		// for good. A member must not be able to clear the admin's queue.
		getNominationById.mockResolvedValue(SYSTEM_NOMINATION);

		await expect(
			call("decline", { nominationId: "nom-1" }),
		).rejects.toThrow(/platform admin/i);
		expect(declinePromptNomination).not.toHaveBeenCalled();
	});
});

describe("the review queue", () => {
	it("is not readable by a plain member — it names who proposed what", async () => {
		await expect(
			call("listPending", { targetScope: "SYSTEM" }),
		).rejects.toThrow(/platform admin/i);
		expect(listPendingNominations).not.toHaveBeenCalled();
	});

	it("is readable by the tier's admin", async () => {
		await call("listPending", { targetScope: "SYSTEM" }, { role: "admin" });

		expect(listPendingNominations).toHaveBeenCalledWith(
			expect.objectContaining({ targetScope: "SYSTEM" }),
		);
	});
});

describe("withdrawing", () => {
	it("scopes the withdraw to the caller as the nominator", async () => {
		withdrawPromptNomination.mockResolvedValue({ withdrawn: true });

		await call("withdraw", { nominationId: "nom-1" }, { id: "user-9" });

		expect(withdrawPromptNomination).toHaveBeenCalledWith({
			nominationId: "nom-1",
			nominatedById: "user-9",
		});
	});

	it("reports nothing found when the nomination is not the caller's", async () => {
		// The query matched no row because the owner or the status did not
		// match. Both come back the same way: telling them apart would confirm
		// to a stranger that the id exists.
		withdrawPromptNomination.mockResolvedValue({ withdrawn: false });

		await expect(
			call("withdraw", { nominationId: "nom-1" }),
		).rejects.toThrow(/No pending nomination of yours/i);
	});
});
