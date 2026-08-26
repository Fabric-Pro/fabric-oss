/**
 * Tests for the Living-Documents auto-refresh enrollment queries.
 *
 * Mocks the Prisma client and the project-access helper so the enrollment and
 * sweep-support logic is exercised in isolation.
 *
 * Run with:
 *   pnpm --filter @repo/database test prisma/queries/projects/document-refresh.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	upsertMock,
	findUniqueMock,
	findManyMock,
	updateMock,
	updateManyMock,
	memberFindManyMock,
	subscriptionUpsertMock,
	hasProjectAccessMock,
} = vi.hoisted(() => ({
	upsertMock: vi.fn(),
	findUniqueMock: vi.fn(),
	findManyMock: vi.fn(),
	updateMock: vi.fn(),
	updateManyMock: vi.fn(),
	memberFindManyMock: vi.fn(),
	subscriptionUpsertMock: vi.fn(),
	hasProjectAccessMock: vi.fn(),
}));

vi.mock("../../client", () => ({
	db: {
		documentAutoRefreshSettings: {
			upsert: upsertMock,
			findUnique: findUniqueMock,
			findMany: findManyMock,
			update: updateMock,
			updateMany: updateManyMock,
		},
		member: { findMany: memberFindManyMock },
		subscription: { upsert: subscriptionUpsertMock },
	},
}));

vi.mock("./projects", () => ({
	hasProjectAccess: hasProjectAccessMock,
}));

import {
	clearRefreshProposal,
	completeRefreshCycle,
	listEnabledAutoRefreshSettings,
	MAX_REFRESHES_PER_SWEEP,
	markRefreshAttempt,
	recordRefreshOutcome,
	recordRefreshOutcomes,
	resolveValidRefreshActors,
	SHORTEST_CADENCE_DAYS,
	storeRefreshProposal,
	upsertAutoRefreshSettings,
} from "./document-refresh";

const BASE = {
	documentId: "doc_1",
	projectId: "proj_1",
	enabled: true,
	cadence: "BIWEEKLY" as const,
	// Off by default in the product too: an unattended whole-document rewrite is
	// opted INTO, never defaulted into.
	autoApply: false,
	createdByUserId: "user_1",
	userId: "user_1",
	organizationId: null,
};

const NOW = new Date("2026-07-13T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

/** An org-context actor candidate, with every field the resolver reads. */
const orgCandidate = (over: Record<string, unknown> = {}) => ({
	documentId: "doc_1",
	projectId: "proj_1",
	createdByUserId: "user_1",
	organizationId: "org_1",
	ownerUserId: null,
	...over,
});

beforeEach(() => {
	vi.clearAllMocks();
	subscriptionUpsertMock.mockResolvedValue({});
	// Default: the actor still has access to the project. The org-membership query
	// is necessary but not sufficient, so this has to be stubbed for org rows.
	hasProjectAccessMock.mockResolvedValue(true);
});

describe("upsertAutoRefreshSettings", () => {
	it("creates the row on first enrollment", async () => {
		await upsertAutoRefreshSettings(BASE);

		const call = upsertMock.mock.calls[0]?.[0];
		expect(call.where).toEqual({ documentId: "doc_1" });
		expect(call.create).toMatchObject({
			documentId: "doc_1",
			enabled: true,
			cadence: "BIWEEKLY",
			createdByUserId: "user_1",
		});
	});

	it("re-homes createdByUserId to the current caller on update", async () => {
		// The sweep runs under this identity. The most recent member to touch the
		// setting is the safest actor, so a second member enabling it takes over.
		await upsertAutoRefreshSettings({ ...BASE, createdByUserId: "user_2" });

		expect(upsertMock.mock.calls[0]?.[0].update).toMatchObject({
			createdByUserId: "user_2",
		});
	});

	it("never resets lastRefreshedAt — disabling and re-enabling keeps the cycle", async () => {
		await upsertAutoRefreshSettings({ ...BASE, enabled: false });

		const call = upsertMock.mock.calls[0]?.[0];
		expect(call.update).not.toHaveProperty("lastRefreshedAt");
		expect(call.create).not.toHaveProperty("lastRefreshedAt");
	});

	it("carries the organization tenant column through", async () => {
		await upsertAutoRefreshSettings({
			...BASE,
			userId: null,
			organizationId: "org_1",
		});

		expect(upsertMock.mock.calls[0]?.[0].create).toMatchObject({
			organizationId: "org_1",
			userId: null,
		});
	});

	it("persists autoApply on both the create and the update branch", async () => {
		// The whole safety posture of the feature hangs off this flag: if an update
		// dropped it, a document could not be switched back OUT of auto-apply.
		await upsertAutoRefreshSettings({ ...BASE, autoApply: true });

		const call = upsertMock.mock.calls[0]?.[0];
		expect(call.create).toMatchObject({ autoApply: true });
		expect(call.update).toMatchObject({ autoApply: true });
	});

	it("defaults a fresh enrollment to propose-only, not auto-apply", async () => {
		await upsertAutoRefreshSettings(BASE);

		expect(upsertMock.mock.calls[0]?.[0].create).toMatchObject({
			autoApply: false,
		});
	});

	describe("watch subscription", () => {
		it("subscribes the enroller to the document so the refresh has a recipient", async () => {
			// Enrolling a document IS an expression of interest in it. Without this
			// row the notification the feature exists to send has NOBODY to go to:
			// Subscription rows are otherwise only created by the "Watch" button.
			await upsertAutoRefreshSettings(BASE);

			expect(subscriptionUpsertMock).toHaveBeenCalledTimes(1);
			expect(subscriptionUpsertMock.mock.calls[0]?.[0]).toMatchObject({
				where: {
					userId_subjectType_subjectId: {
						userId: "user_1",
						subjectType: "DOCUMENT",
						subjectId: "doc_1",
					},
				},
				create: {
					userId: "user_1",
					subjectType: "DOCUMENT",
					subjectId: "doc_1",
					organizationId: null,
				},
			});
		});

		it("carries the org tenant onto the subscription row", async () => {
			await upsertAutoRefreshSettings({
				...BASE,
				userId: null,
				organizationId: "org_1",
			});

			expect(
				subscriptionUpsertMock.mock.calls[0]?.[0].create,
			).toMatchObject({
				organizationId: "org_1",
			});
		});

		it("does not subscribe anyone when the document is being un-enrolled", async () => {
			await upsertAutoRefreshSettings({ ...BASE, enabled: false });

			expect(subscriptionUpsertMock).not.toHaveBeenCalled();
		});

		it("leaves an existing watch row untouched", async () => {
			// Someone who already watches the document must not have their row
			// rewritten (and a re-enrollment must not fail on the unique index).
			await upsertAutoRefreshSettings(BASE);

			expect(subscriptionUpsertMock.mock.calls[0]?.[0].update).toEqual(
				{},
			);
		});

		it("still enrolls the document when the watch row cannot be written", async () => {
			// A missing watch row is a degraded notification, not a failed
			// enrollment — the setting itself must survive.
			subscriptionUpsertMock.mockRejectedValue(new Error("db is down"));
			upsertMock.mockResolvedValue({
				documentId: "doc_1",
				enabled: true,
			});

			await expect(
				upsertAutoRefreshSettings(BASE),
			).resolves.toMatchObject({ documentId: "doc_1" });

			expect(upsertMock).toHaveBeenCalledTimes(1);
		});
	});
});

describe("listEnabledAutoRefreshSettings", () => {
	it("returns only enabled rows and selects only what the sweep reads", async () => {
		findManyMock.mockResolvedValue([]);
		await listEnabledAutoRefreshSettings(NOW);

		const call = findManyMock.mock.calls[0]?.[0];
		expect(call.where.enabled).toBe(true);
		// The collision gate needs the lock and updatedAt; the notification needs
		// the title. Nothing else is read.
		expect(call.include.document.select).toEqual({
			title: true,
			updatedAt: true,
			lock: { select: { expiresAt: true } },
		});
		// Emphatically NOT the document body: this query runs against every
		// enrolled document in the system, 24 times a day, and the sweep never
		// looks at the content.
		expect(call.include.document.select).not.toHaveProperty("content");
		// The project's tenant is read so the sweep can cross-check it against the
		// settings row's and fail a mis-tenanted row closed.
		expect(call.include.project.select).toEqual({
			userId: true,
			organizationId: true,
		});
	});

	it("discards rows refreshed inside the shortest cadence, in the DATABASE", async () => {
		// A row refreshed less recently than the SHORTEST cadence cannot be due
		// under any of them. Filtering in memory instead would let
		// recently-refreshed rows fill the `take` and starve the genuinely stale
		// ones behind them.
		//
		// Asserted against the exported constant rather than a literal. The
		// literal here used to be 7, and stayed 7 when DAILY was added — so this
		// test went on passing while agreeing with the bug, and a Daily document
		// was filtered out of the sweep for six days. A hard-coded window in the
		// test is what let the window and the cadence table drift apart.
		findManyMock.mockResolvedValue([]);
		await listEnabledAutoRefreshSettings(NOW);

		const call = findManyMock.mock.calls[0]?.[0];
		expect(call.where.OR).toEqual([
			{ lastRefreshedAt: null },
			{
				lastRefreshedAt: {
					lte: new Date(
						NOW.getTime() - SHORTEST_CADENCE_DAYS * DAY_MS,
					),
				},
			},
			{ deployPendingSince: { not: null } },
		]);
	});

	it("keeps a deploy-pending row whatever its lastRefreshedAt", async () => {
		// ON_DEPLOY documents are due because an event happened, not because time
		// passed. Without this arm the lastRefreshedAt pre-filter would discard a
		// document whose project shipped twice in one day — exactly the case the
		// cadence exists for.
		findManyMock.mockResolvedValue([]);
		await listEnabledAutoRefreshSettings(NOW);

		const call = findManyMock.mock.calls[0]?.[0];
		expect(call.where.OR).toContainEqual({
			deployPendingSince: { not: null },
		});
	});

	it("keeps a document refreshed yesterday in the sweep, so DAILY can fire", async () => {
		// The regression itself, stated as behaviour rather than as a constant:
		// yesterday's refresh must still be inside the window the query asks for.
		findManyMock.mockResolvedValue([]);
		await listEnabledAutoRefreshSettings(NOW);

		const call = findManyMock.mock.calls[0]?.[0];
		const cutoff = call.where.OR[1].lastRefreshedAt.lte as Date;
		const yesterday = new Date(NOW.getTime() - 1 * DAY_MS);

		expect(yesterday.getTime()).toBeLessThanOrEqual(cutoff.getTime());
	});

	it("caps one tick and drains the most-stale documents first", async () => {
		// Without a cap, the first sweep after the flag goes on finds EVERY enrolled
		// document due at once (never-refreshed is due immediately), dispatches all
		// of them, and the ones at the back of the worker queue time out having done
		// nothing — with no attempt recorded, so they return next hour with no
		// backoff, forever.
		findManyMock.mockResolvedValue([]);
		await listEnabledAutoRefreshSettings(NOW);

		const call = findManyMock.mock.calls[0]?.[0];
		expect(call.take).toBe(MAX_REFRESHES_PER_SWEEP);
		expect(MAX_REFRESHES_PER_SWEEP).toBe(50);
		expect(call.orderBy).toEqual([
			{ lastRefreshedAt: { sort: "asc", nulls: "first" } },
		]);
	});
});

describe("resolveValidRefreshActors", () => {
	it("accepts the project owner in a personal project without querying", async () => {
		const valid = await resolveValidRefreshActors([
			{
				documentId: "doc_1",
				projectId: "proj_1",
				createdByUserId: "user_1",
				organizationId: null,
				ownerUserId: "user_1",
			},
		]);

		expect(valid.has("doc_1")).toBe(true);
		expect(memberFindManyMock).not.toHaveBeenCalled();
		expect(hasProjectAccessMock).not.toHaveBeenCalled();
	});

	it("rejects a non-owner actor in a personal project", async () => {
		// createdByUserId has no FK, so a drifted id must not be trusted.
		const valid = await resolveValidRefreshActors([
			{
				documentId: "doc_1",
				projectId: "proj_1",
				createdByUserId: "user_9",
				organizationId: null,
				ownerUserId: "user_1",
			},
		]);

		expect(valid.has("doc_1")).toBe(false);
	});

	it("rejects when a personal project has no owner", async () => {
		const valid = await resolveValidRefreshActors([
			{
				documentId: "doc_1",
				projectId: "proj_1",
				createdByUserId: "user_1",
				organizationId: null,
				ownerUserId: null,
			},
		]);

		expect(valid.has("doc_1")).toBe(false);
	});

	it("resolves every organization document's MEMBERSHIP in ONE query", async () => {
		memberFindManyMock.mockResolvedValue([
			{ organizationId: "org_1", userId: "user_1" },
		]);

		const valid = await resolveValidRefreshActors([
			orgCandidate({ documentId: "doc_1", createdByUserId: "user_1" }),
			orgCandidate({ documentId: "doc_2", createdByUserId: "user_1" }),
			orgCandidate({ documentId: "doc_3", createdByUserId: "user_gone" }),
		]);

		expect(memberFindManyMock).toHaveBeenCalledTimes(1);
		expect(valid.has("doc_1")).toBe(true);
		expect(valid.has("doc_2")).toBe(true);
		expect(valid.has("doc_3")).toBe(false);
	});

	it("matches on the (org, user) PAIR, not on either half", async () => {
		// The two `in` clauses form a cross product, so the query can return a
		// membership no candidate asked about. A user who belongs to org_2 must not
		// be waved through as a valid actor for a document owned by org_1.
		memberFindManyMock.mockResolvedValue([
			{ organizationId: "org_2", userId: "user_1" },
		]);

		const valid = await resolveValidRefreshActors([
			orgCandidate({ documentId: "doc_1", createdByUserId: "user_1" }),
			orgCandidate({
				documentId: "doc_2",
				createdByUserId: "user_2",
				organizationId: "org_2",
			}),
		]);

		expect(valid.has("doc_1")).toBe(false);
		expect(valid.has("doc_2")).toBe(false);
	});

	describe("project access (org membership alone is not sufficient)", () => {
		beforeEach(() => {
			memberFindManyMock.mockResolvedValue([
				{ organizationId: "org_1", userId: "user_1" },
			]);
		});

		it("rejects a member who was removed from the PROJECT but is still in the org", async () => {
			// The actor's identity decides whose AI provider resolves and whose usage
			// is billed — and org model resolution falls back to the actor's PERSONAL
			// key when the org has none. A member removed from the project would
			// otherwise keep paying, out of their own pocket, for unattended writes to
			// a project they can no longer even open.
			hasProjectAccessMock.mockResolvedValue(false);

			const valid = await resolveValidRefreshActors([orgCandidate()]);

			expect(valid.has("doc_1")).toBe(false);
			// Membership passed; the project check is what rejected them.
			expect(memberFindManyMock).toHaveBeenCalledTimes(1);
			expect(hasProjectAccessMock).toHaveBeenCalledWith(
				"proj_1",
				"user_1",
				"org_1",
			);
		});

		it("accepts a member who still has project access", async () => {
			hasProjectAccessMock.mockResolvedValue(true);

			const valid = await resolveValidRefreshActors([orgCandidate()]);

			expect(valid.has("doc_1")).toBe(true);
		});

		it("never asks about a candidate the membership query already rejected", async () => {
			// The project check costs a query per candidate; an actor who has left the
			// org entirely must not pay for one.
			const valid = await resolveValidRefreshActors([
				orgCandidate({
					documentId: "doc_1",
					createdByUserId: "user_1",
				}),
				orgCandidate({
					documentId: "doc_2",
					createdByUserId: "user_gone",
				}),
			]);

			expect(valid.has("doc_2")).toBe(false);
			expect(hasProjectAccessMock).toHaveBeenCalledTimes(1);
			expect(hasProjectAccessMock).toHaveBeenCalledWith(
				"proj_1",
				"user_1",
				"org_1",
			);
		});

		it("decides each candidate on its OWN project access", async () => {
			hasProjectAccessMock.mockImplementation(
				async (projectId: string) => projectId === "proj_ok",
			);

			const valid = await resolveValidRefreshActors([
				orgCandidate({ documentId: "doc_ok", projectId: "proj_ok" }),
				orgCandidate({
					documentId: "doc_gone",
					projectId: "proj_gone",
				}),
			]);

			expect(valid.has("doc_ok")).toBe(true);
			expect(valid.has("doc_gone")).toBe(false);
		});
	});
});

describe("recordRefreshOutcomes", () => {
	it("writes every skipped document in one statement", async () => {
		await recordRefreshOutcomes(
			["doc_1", "doc_2", "doc_3"],
			"SKIPPED_COLLISION",
			"in use",
		);

		expect(updateManyMock).toHaveBeenCalledTimes(1);
		expect(updateManyMock.mock.calls[0]?.[0]).toMatchObject({
			where: { documentId: { in: ["doc_1", "doc_2", "doc_3"] } },
			data: { lastRefreshStatus: "SKIPPED_COLLISION" },
		});
	});

	it("issues no query when nothing was skipped", async () => {
		await recordRefreshOutcomes([], "SKIPPED_COLLISION", "in use");

		expect(updateManyMock).not.toHaveBeenCalled();
	});

	it("never touches lastRefreshedAt", async () => {
		await recordRefreshOutcomes(["doc_1"], "SKIPPED_STALE_ACTOR", null);

		expect(updateManyMock.mock.calls[0]?.[0].data).not.toHaveProperty(
			"lastRefreshedAt",
		);
	});
});

describe("cycle bookkeeping", () => {
	it("markRefreshAttempt stamps only lastAttemptAt", async () => {
		const when = new Date("2026-07-13T12:00:00Z");
		await markRefreshAttempt("doc_1", when);

		expect(updateMock.mock.calls[0]?.[0].data).toEqual({
			lastAttemptAt: when,
		});
	});

	it("completeRefreshCycle advances lastRefreshedAt", async () => {
		const when = new Date("2026-07-13T12:00:00Z");
		await completeRefreshCycle("doc_1", {
			when,
			status: "COMMITTED",
			summary: "Updated the rollout section.",
		});

		expect(updateMock.mock.calls[0]?.[0].data).toMatchObject({
			lastRefreshedAt: when,
			lastRefreshStatus: "COMMITTED",
			lastRefreshSummary: "Updated the rollout section.",
		});
	});

	it("completeRefreshCycle advances lastRefreshedAt on a no-change cycle too", async () => {
		// A cycle that ran and found nothing still consumed its interval; not
		// advancing would re-run it on every sweep for the rest of the period.
		const when = new Date("2026-07-13T12:00:00Z");
		await completeRefreshCycle("doc_1", {
			when,
			status: "NO_CHANGES",
			summary: null,
		});

		expect(updateMock.mock.calls[0]?.[0].data).toMatchObject({
			lastRefreshedAt: when,
			lastRefreshStatus: "NO_CHANGES",
		});
	});

	it("completeRefreshCycle advances lastRefreshedAt on a REFUSED cycle too", async () => {
		// A refusal is a COMPLETED cycle: the model ran and answered, and we threw
		// its answer away. Treating it as a failure would leave the document
		// permanently due and re-generate it, at the owner's expense, every six
		// hours until a human intervened.
		const when = new Date("2026-07-13T12:00:00Z");
		await completeRefreshCycle("doc_1", {
			when,
			status: "REFUSED",
			summary: "Conflicting sources.",
		});

		expect(updateMock.mock.calls[0]?.[0].data).toMatchObject({
			lastRefreshedAt: when,
			lastRefreshStatus: "REFUSED",
		});
	});

	it("recordRefreshOutcome never touches lastRefreshedAt", async () => {
		// A skipped or failed cycle must stay due, or the document silently loses
		// a whole cadence interval.
		await recordRefreshOutcome(
			"doc_1",
			"SKIPPED_COLLISION",
			"document locked",
		);

		const data = updateMock.mock.calls[0]?.[0].data;
		expect(data).not.toHaveProperty("lastRefreshedAt");
		expect(data).toMatchObject({ lastRefreshStatus: "SKIPPED_COLLISION" });
	});
});

describe("proposals", () => {
	const when = new Date("2026-07-13T12:00:00Z");

	it("stores the candidate, its summary, and the version it was based on", async () => {
		// The baseline version is what lets the UI tell an accepting human that the
		// document has moved on under the proposal.
		await storeRefreshProposal("doc_1", {
			when,
			content: "# PRD\n\nProposed body.",
			summary: "Removed SSO from scope.",
			baselineVersion: 3,
		});

		expect(updateMock.mock.calls[0]?.[0]).toMatchObject({
			where: { documentId: "doc_1" },
			data: {
				pendingContent: "# PRD\n\nProposed body.",
				pendingSummary: "Removed SSO from scope.",
				pendingProposedAt: when,
				pendingBaselineVersion: 3,
			},
		});
	});

	it("ADVANCES the cadence clock — a proposal is a completed cycle", async () => {
		// The model looked and produced something. If this did not advance
		// lastRefreshedAt, a proposal nobody got round to accepting would be
		// re-generated, and re-billed, every six hours forever.
		await storeRefreshProposal("doc_1", {
			when,
			content: "body",
			summary: "Updated scope.",
			baselineVersion: 3,
		});

		expect(updateMock.mock.calls[0]?.[0].data).toMatchObject({
			lastRefreshedAt: when,
			lastRefreshStatus: "PROPOSED",
			lastRefreshSummary: "Updated scope.",
		});
	});

	it("clears every pending field on accept or reject", async () => {
		await clearRefreshProposal("doc_1");

		expect(updateMock.mock.calls[0]?.[0]).toEqual({
			where: { documentId: "doc_1" },
			data: {
				pendingContent: null,
				pendingSummary: null,
				pendingProposedAt: null,
				pendingBaselineVersion: null,
			},
		});
	});

	it("clearing a proposal does not disturb the cadence clock", async () => {
		// Rejecting a proposal must not make the document due again immediately —
		// the cycle it came from is still complete.
		await clearRefreshProposal("doc_1");

		const data = updateMock.mock.calls[0]?.[0].data;
		expect(data).not.toHaveProperty("lastRefreshedAt");
		expect(data).not.toHaveProperty("lastRefreshStatus");
	});
});
