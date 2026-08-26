/**
 * FR16's other half: the admins are actually told.
 *
 * The requirement is "must be notified AND shown an AI-generated summary". The
 * summary was built; the notification was not, so a proposal only existed for
 * someone who happened to open the queue — which, for a page nobody has a habit
 * of visiting, means never. A nomination nobody sees is a feature that quietly
 * does nothing.
 *
 * Run with:
 *   pnpm --filter @repo/api test modules/prompts/__tests__/nominate-notifies-reviewers.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	createPromptNomination,
	listPromptNominationReviewers,
	promptNominationPending,
	promptVersionFindUnique,
} = vi.hoisted(() => ({
	createPromptNomination: vi.fn(),
	listPromptNominationReviewers: vi.fn(),
	promptNominationPending: vi.fn(),
	promptVersionFindUnique: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	createPromptNomination,
	listPromptNominationReviewers,
	approvePromptNomination: vi.fn(),
	declinePromptNomination: vi.fn(),
	getNominationById: vi.fn(),
	listPendingNominations: vi.fn(),
	withdrawPromptNomination: vi.fn(),
	getBoundPromptVersion: vi.fn().mockResolvedValue(null),
	listPromptDefaultRecipients: vi.fn().mockResolvedValue([]),
	db: {
		promptVersion: { findUnique: promptVersionFindUnique },
		// The FR16 deep-link resolves the org slug; no row → personal-context path.
		organization: { findUnique: vi.fn().mockResolvedValue(null) },
	},
}));

vi.mock("../../organizations/lib/membership", () => ({
	verifyOrganizationMembership: vi.fn().mockResolvedValue({ role: "member" }),
}));

vi.mock("../../../lib/notification-service", () => ({
	fanOut: {
		promptNominationPending,
		promptDefaultUpdated: vi.fn(),
	},
}));

vi.mock("../lib/nomination-summary", () => ({
	summariseNominationChange: vi.fn().mockResolvedValue({
		summary: "Adds preconditions to every case.",
		degraded: false,
	}),
}));

vi.mock("../../../orpc/procedures", () => ({
	Permissions: { PROMPT_READ: "prompt:read", PROMPT_UPDATE: "prompt:update" },
	requirePermission: () => (next: unknown) => next,
	requireInputOrgPermission: () => (next: unknown) => next,
	requireOrganizationAdmin: vi.fn(),
	resolveOrganizationId: (i: string | null | undefined) => i ?? null,
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

const create = (input: Record<string, unknown> = {}) =>
	(nominateProcedures.create as unknown as Handler)({
		input: {
			promptVersionId: "pv-1",
			targetScope: "ORG",
			organizationId: "org-a",
			targets: [
				{
					targetKey: "test_case_drafter",
					documentType: "GENERAL",
					storyKind: null,
				},
			],
			...input,
		},
		context: {
			user: { id: "member-1", name: "A Teammate", role: null },
			session: {},
		},
	});

beforeEach(() => {
	createPromptNomination.mockReset();
	createPromptNomination.mockResolvedValue({ id: "nom-1" });
	listPromptNominationReviewers.mockReset();
	listPromptNominationReviewers.mockResolvedValue([
		{ userId: "admin-1", organizationId: "org-a" },
	]);
	promptNominationPending.mockReset();
	promptVersionFindUnique.mockReset();
	promptVersionFindUnique.mockResolvedValue({
		id: "pv-1",
		scope: "ORG",
		userId: null,
		organizationId: "org-a",
		content: "the proposed body",
		prompt: { id: "p-1", name: "Tighter drafter" },
	});
});

describe("nominations.create notifies the reviewing tier", () => {
	it("tells the admins who can decide it", async () => {
		await create();

		expect(promptNominationPending).toHaveBeenCalledTimes(1);
		expect(promptNominationPending).toHaveBeenCalledWith(
			expect.objectContaining({
				nominationId: "nom-1",
				targetScope: "ORG",
				promptName: "Tighter drafter",
				recipients: [{ userId: "admin-1", organizationId: "org-a" }],
			}),
		);
	});

	it("asks for reviewers of the nomination's own tier and organization", async () => {
		await create();

		expect(listPromptNominationReviewers).toHaveBeenCalledWith(
			expect.objectContaining({
				targetScope: "ORG",
				organizationId: "org-a",
				// The nominator already knows.
				excludeUserId: "member-1",
			}),
		);
	});

	it("carries the change summary so the bell row is already useful", async () => {
		await create();

		expect(promptNominationPending).toHaveBeenCalledWith(
			expect.objectContaining({
				changeSummary: "Adds preconditions to every case.",
				summaryDegraded: false,
			}),
		);
	});

	it("says how many actions it covers", async () => {
		await create({
			targets: [
				{
					targetKey: "test_case_drafter",
					documentType: "GENERAL",
					storyKind: null,
				},
				{
					targetKey: "test_case_step_reviser",
					documentType: "GENERAL",
					storyKind: null,
				},
			],
		});

		expect(promptNominationPending).toHaveBeenCalledWith(
			expect.objectContaining({ actionCount: 2 }),
		);
	});

	it("still creates the nomination when there is nobody to tell", async () => {
		// A one-person organization has no other admin. The proposal is still a
		// valid record; it must not fail because the audience is empty.
		listPromptNominationReviewers.mockResolvedValue([]);

		await expect(create()).resolves.toEqual({ id: "nom-1" });
		expect(promptNominationPending).not.toHaveBeenCalled();
	});
});
