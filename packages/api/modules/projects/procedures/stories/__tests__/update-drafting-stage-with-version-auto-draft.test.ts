/**
 * Test-first auto-draft wiring on the OTHER procedure that writes
 * `draftingStage`.
 *
 * `stories.updateDraftingStage` is the roadmap's path;
 * `stories.updateStageWithVersion` is the transition dialog inside the feature
 * editor. Only the first carried the trigger, so a user who moved a feature to
 * Ready for Dev from the editor got no draft even with test-first on — a
 * guarantee only one of the two paths honours is not a guarantee.
 *
 * Its own file because the two suites that already touch this procedure stub
 * `db.userStory.findUnique` to `null` so the trigger short-circuits and they can
 * stay about PM-sync and the attachment guard. That stub neutralises exactly the
 * branch this covers, which is how the gap survived being "fixed".
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const { handlers, mocks, fixture } = vi.hoisted(() => {
	const handlers: Record<string, (...args: unknown[]) => unknown> = {};
	const fixture = {
		kind: "FEATURE" as string,
		generateManualTestCases: true,
		applyTddApproach: true,
		linkedCaseCount: 0,
		/** The org the PROJECT belongs to — not the one the caller sends. */
		projectOrganizationId: "org-owning-the-project" as string | null,
		/** `null` models a feature that vanished between the two reads. */
		present: true,
	};
	const mocks = {
		getStoryById: vi.fn(),
		userStoryUpdate: vi.fn(),
		userStoryFindUnique: vi.fn(),
		createFeatureVersion: vi.fn(),
		enqueuePmSync: vi.fn(),
		startTestCaseDraft: vi.fn(),
	};
	return { handlers, mocks, fixture };
});

vi.mock("@repo/database", () => ({
	getStoryById: mocks.getStoryById,
	createFeatureVersion: mocks.createFeatureVersion,
	db: {
		userStory: {
			update: mocks.userStoryUpdate,
			findUnique: mocks.userStoryFindUnique,
		},
	},
	FeatureDraftingStageSchema: z.enum([
		"PLACEHOLDER",
		"ACTIVE_ANALYSIS",
		"SANITY_CHECK",
		"DRAFT",
		"PUBLISHED",
		"DECLINED",
		"CLOSED",
	]),
	GATEWAY_PROVIDERS: [],
	DB_GATEWAY_PROVIDERS: [],
}));

vi.mock("@repo/logs", () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Mocked at the claim/dispatch boundary so the Temporal client — and the
// `@repo/ai` graph behind it — never loads here.
vi.mock("../../../lib/start-test-case-draft", () => ({
	startTestCaseDraft: mocks.startTestCaseDraft,
}));

vi.mock("../../../lib/enqueue-pm-sync", () => ({
	enqueuePmSync: mocks.enqueuePmSync,
}));

vi.mock("../../../lib/validate-stage-for-kind", () => ({
	validateStageForKind: vi.fn(),
}));

vi.mock("../../../../../lib/notification-service", () => ({
	fanOut: { subscriptionUpdate: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock("../../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			handlers.updateStage = fn;
			return { _handler: fn };
		},
	});
	const Permissions = new Proxy({}, { get: (_t, p) => String(p) }) as Record<
		string,
		string
	>;
	return {
		tenantProtectedProcedure: chainable,
		Permissions,
		requireProjectPermission: () => (c: unknown) => c,
		// Mirrors production: a caller-supplied org is returned verbatim, with
		// no membership check. That is precisely why the trigger must not use it.
		resolveOrganizationId: (organizationId: string | null | undefined) =>
			organizationId ?? null,
	};
});

await import("../update-drafting-stage-with-version");

const ctx = {
	user: { id: "user-1" },
	session: { id: "s-1", activeOrganizationId: null },
};

/** Move the feature from DRAFT to `targetStage` through the editor dialog. */
async function transition(targetStage: string, organizationId: unknown = null) {
	return handlers.updateStage({
		input: {
			projectId: "proj-1",
			storyId: "story-1",
			organizationId,
			targetStage,
		},
		context: ctx,
	});
}

const previousStage = { current: "DRAFT" as string };

beforeEach(() => {
	vi.clearAllMocks();
	fixture.kind = "FEATURE";
	fixture.generateManualTestCases = true;
	fixture.applyTddApproach = true;
	fixture.linkedCaseCount = 0;
	fixture.projectOrganizationId = "org-owning-the-project";
	fixture.present = true;
	previousStage.current = "DRAFT";

	process.env.FABRIC_FEATURE_TEST_CASES = "true";

	mocks.createFeatureVersion.mockResolvedValue({});
	mocks.enqueuePmSync.mockResolvedValue({ enqueued: true });
	mocks.startTestCaseDraft.mockResolvedValue({
		started: true,
		jobId: "job-1",
		status: "PENDING",
	});
	mocks.getStoryById.mockImplementation(async () => ({
		id: "story-1",
		version: 1,
		description: "desc",
		acceptanceCriteria: "AC 1",
		draftingStage: previousStage.current,
		kind: fixture.kind,
	}));
	mocks.userStoryUpdate.mockResolvedValue({
		id: "story-1",
		pmAutoSyncEnabled: false,
	});
	mocks.userStoryFindUnique.mockImplementation(async () =>
		fixture.present
			? {
					kind: fixture.kind,
					project: {
						organizationId: fixture.projectOrganizationId,
						generateManualTestCases:
							fixture.generateManualTestCases,
						applyTddApproach: fixture.applyTddApproach,
					},
					_count: { testCaseLinks: fixture.linkedCaseCount },
				}
			: null,
	);
});

describe("updateStageWithVersion — test-first auto-draft wiring", () => {
	it("starts a drafting run when the editor moves a feature to Ready for Dev", async () => {
		await transition("PUBLISHED");

		expect(mocks.startTestCaseDraft).toHaveBeenCalledTimes(1);
		expect(mocks.startTestCaseDraft).toHaveBeenCalledWith({
			projectId: "proj-1",
			organizationId: "org-owning-the-project",
			userId: "user-1",
			requestedById: "user-1",
			storyIds: ["story-1"],
		});
	});

	it("bills the org that owns the project, not the one the caller sent", async () => {
		// This procedure's guard authorizes `projectId` alone, and
		// `resolveOrganizationId` hands back a non-null input org verbatim. The
		// drafting run resolves AI credentials and debits credits against
		// whatever org it is given, so the request body must not be the source.
		await transition("PUBLISHED", "org-the-caller-claimed");

		expect(mocks.startTestCaseDraft).toHaveBeenCalledWith(
			expect.objectContaining({
				organizationId: "org-owning-the-project",
			}),
		);
	});

	it("does not draft without the test-first switch", async () => {
		// The standard flow owns drafting then, and it happens after the review.
		fixture.applyTddApproach = false;

		await transition("PUBLISHED");

		expect(mocks.startTestCaseDraft).not.toHaveBeenCalled();
	});

	it("does not draft when generation is switched off", async () => {
		fixture.generateManualTestCases = false;

		await transition("PUBLISHED");

		expect(mocks.startTestCaseDraft).not.toHaveBeenCalled();
	});

	it("does not draft a feature that already has cases", async () => {
		// Once per feature: moving back to Draft and forward again must not
		// re-bill, and the drafter's own dedupe runs after the model call.
		fixture.linkedCaseCount = 3;

		await transition("PUBLISHED");

		expect(mocks.startTestCaseDraft).not.toHaveBeenCalled();
	});

	it("does not draft when the stage did not actually change", async () => {
		previousStage.current = "PUBLISHED";

		await transition("PUBLISHED");

		expect(mocks.startTestCaseDraft).not.toHaveBeenCalled();
	});

	it("does not draft on a transition to any other stage", async () => {
		for (const stage of ["DRAFT", "SANITY_CHECK", "CLOSED"]) {
			await transition(stage);
		}

		expect(mocks.startTestCaseDraft).not.toHaveBeenCalled();
	});

	it("does not draft a bug", async () => {
		fixture.kind = "BUG";

		await transition("PUBLISHED");

		expect(mocks.startTestCaseDraft).not.toHaveBeenCalled();
	});

	it("does not draft when the QA feature is off for the deployment", async () => {
		process.env.FABRIC_FEATURE_TEST_CASES = "false";

		await transition("PUBLISHED");

		expect(mocks.startTestCaseDraft).not.toHaveBeenCalled();
	});

	it("still completes the transition when the drafting run cannot start", async () => {
		// Fire-and-forget: the transition is what the user actually asked for.
		mocks.startTestCaseDraft.mockRejectedValue(new Error("temporal down"));

		await expect(transition("PUBLISHED")).resolves.toBeDefined();
		expect(mocks.userStoryUpdate).toHaveBeenCalled();
	});
});
