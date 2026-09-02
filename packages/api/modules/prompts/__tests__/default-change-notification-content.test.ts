/**
 * What the "the default changed" message actually carries, and what declining
 * deliberately does not.
 *
 * Two requirements had no test naming them, found by walking the card's list
 * against the suite rather than by anything failing:
 *
 *   FR7 — the reader can see what changed in the updated prompt. That is the
 *   version's own change note, and "absent" is normal rather than an error, so
 *   the fallback has to say something useful instead of rendering an empty line.
 *
 *   FR17 — declining closes the proposal SILENTLY: the nominator is not told and
 *   their prompt is untouched. Silence is the requirement, and an absence is
 *   exactly what nobody notices regressing. A later "be helpful, tell them"
 *   change would look like an improvement and break the spec.
 *
 * Run with:
 *   pnpm --filter @repo/api test modules/prompts/__tests__/default-change-notification-content.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	promptVersionFindUnique,
	organizationFindUnique,
	listPromptDefaultAudience,
	markOwnOverrides,
	promptDefaultUpdated,
	promptNominationPending,
	declinePromptNomination,
	getNominationById,
	requireOrganizationAdmin,
} = vi.hoisted(() => ({
	promptVersionFindUnique: vi.fn(),
	organizationFindUnique: vi.fn(),
	listPromptDefaultAudience: vi.fn(),
	markOwnOverrides: vi.fn(),
	promptDefaultUpdated: vi.fn(),
	promptNominationPending: vi.fn(),
	declinePromptNomination: vi.fn(),
	getNominationById: vi.fn(),
	requireOrganizationAdmin: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		promptVersion: { findUnique: promptVersionFindUnique },
		organization: { findUnique: organizationFindUnique },
	},
	listPromptDefaultAudience,
	markOwnOverrides,
	declinePromptNomination,
	getNominationById,
	approvePromptNomination: vi.fn(),
	createPromptNomination: vi.fn(),
	listPendingNominations: vi.fn(),
	withdrawPromptNomination: vi.fn(),
	listPromptNominationReviewers: vi.fn().mockResolvedValue([]),
	getBoundPromptVersion: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../organizations/lib/membership", () => ({
	verifyOrganizationMembership: vi.fn().mockResolvedValue({ role: "member" }),
}));

vi.mock("../../../lib/notification-service", () => ({
	fanOut: { promptDefaultUpdated, promptNominationPending },
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

import { announceDefaultChange } from "../lib/announce-default-change";
import { nominateProcedures } from "../procedures/nominate";

beforeEach(() => {
	promptVersionFindUnique.mockReset();
	organizationFindUnique.mockReset();
	// The deep-link resolves the org's slug; default to one so assertions can
	// pin the org-scoped path.
	organizationFindUnique.mockResolvedValue({ slug: "acme" });
	listPromptDefaultAudience.mockReset();
	markOwnOverrides.mockReset();
	// The audience is the tier's people; the per-action framing is the second
	// call, which is what the announcer actually hands to the fan-out.
	listPromptDefaultAudience.mockResolvedValue([
		{ userId: "u-1", organizationId: "org-a" },
	]);
	markOwnOverrides.mockResolvedValue([
		{ userId: "u-1", organizationId: "org-a", hasOwnOverride: false },
	]);
	promptDefaultUpdated.mockReset();
	promptNominationPending.mockReset();
	declinePromptNomination.mockReset();
	declinePromptNomination.mockResolvedValue({ id: "nom-1" });
	getNominationById.mockReset();
	requireOrganizationAdmin.mockReset();
	requireOrganizationAdmin.mockResolvedValue(undefined);
});

const announce = () =>
	announceDefaultChange({
		scope: "ORG",
		organizationId: "org-a",
		targetKey: "test_case_drafter",
		documentType: "GENERAL",
		storyKind: null,
		promptVersionId: "pv-1",
		actorUserId: "admin-1",
	});

describe("FR7 — the message says what changed", () => {
	it("carries the version's own change note", async () => {
		promptVersionFindUnique.mockResolvedValue({
			changeNote: "Added preconditions to every case.",
			prompt: { id: "p-1", name: "Drafter" },
		});

		await announce();

		expect(promptDefaultUpdated).toHaveBeenCalledWith(
			expect.objectContaining({
				changeNote: "Added preconditions to every case.",
			}),
		);
	});

	it("names the action so the reader knows what this affects", async () => {
		promptVersionFindUnique.mockResolvedValue({
			changeNote: null,
			prompt: { id: "p-1", name: "Drafter" },
		});

		await announce();

		const [args] = promptDefaultUpdated.mock.calls[0];
		expect(args.actionLabel).toMatch(/test case drafter/i);
	});

	it("links into the organization's own catalog, not the personal one", async () => {
		// An ORG default's deep-link that lands on the personal-context page
		// shows a different tier's view entirely — the bug class this pins.
		promptVersionFindUnique.mockResolvedValue({
			changeNote: "note",
			prompt: { id: "p-1", name: "Drafter" },
		});
		organizationFindUnique.mockResolvedValue({ slug: "acme" });

		await announce();

		const [args] = promptDefaultUpdated.mock.calls[0];
		expect(args.link).toBe(
			"/app/acme/prompts/catalog?action=test_case_drafter%3AGENERAL%3AANY",
		);
	});

	it("treats a missing change note as normal, not as an error", async () => {
		// Plenty of edits carry no note. The fan-out still has to produce a
		// usable message rather than an empty line or a throw.
		promptVersionFindUnique.mockResolvedValue({
			changeNote: null,
			prompt: { id: "p-1", name: "Drafter" },
		});

		await expect(announce()).resolves.toBeUndefined();
		expect(promptDefaultUpdated).toHaveBeenCalledTimes(1);
	});

	it("says nothing at all when the version has vanished", async () => {
		promptVersionFindUnique.mockResolvedValue(null);

		await announce();

		expect(promptDefaultUpdated).not.toHaveBeenCalled();
	});

	it("links to the action's catalog entry so the reader can act", async () => {
		// FR8 leans on this: a notice you cannot act on is just noise.
		promptVersionFindUnique.mockResolvedValue({
			changeNote: "x",
			prompt: { id: "p-1", name: "Drafter" },
		});

		await announce();

		const [args] = promptDefaultUpdated.mock.calls[0];
		expect(args.link).toMatch(/\/prompts\/catalog\?action=/);
	});
});

describe("FR17 — declining is silent", () => {
	it("notifies nobody when a proposal is declined", async () => {
		// The requirement is an ABSENCE, which is what nobody notices
		// regressing. A later "tell them we declined" would read as a kindness
		// and contradict the spec.
		getNominationById.mockResolvedValue({
			id: "nom-1",
			status: "PENDING",
			targetScope: "ORG",
			organizationId: "org-a",
			promptVersionId: "pv-1",
			nominatedById: "member-1",
			targets: [],
		});

		await (
			nominateProcedures.decline as unknown as (
				a: unknown,
			) => Promise<unknown>
		)({
			input: { nominationId: "nom-1", organizationId: "org-a" },
			context: { user: { id: "admin-1", role: null }, session: {} },
		});

		expect(declinePromptNomination).toHaveBeenCalledTimes(1);
		expect(promptDefaultUpdated).not.toHaveBeenCalled();
		expect(promptNominationPending).not.toHaveBeenCalled();
	});
});
