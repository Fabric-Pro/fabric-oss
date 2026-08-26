/**
 * Unit tests for `updateDraftingStageProcedure`.
 *
 * Mocks `@repo/database` and the oRPC procedure base so we can invoke the
 * raw handler directly and assert on how it delegates to
 * `updateStoryDraftingStage` and what the input schema accepts/rejects.
 *
 * Covers:
 *   - Happy path: accepts `CLOSED`.
 *   - Re-open: accepts `DRAFT` (from a `CLOSED` story).
 *   - `FeatureVersion` IS written when the stage changes (contract, via stub).
 *   - `FeatureVersion` is NOT written when stage is unchanged (contract).
 *   - Permission middleware wiring (STORY_UPDATE required).
 *   - Cross-tenant `NOT_FOUND` surfaces when query throws.
 *   - Zod BAD_REQUEST for unknown stage.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const { handlers, uses, featureVersionCreateMany } = vi.hoisted(() => ({
	handlers: {} as Record<string, (...args: unknown[]) => unknown>,
	uses: [] as unknown[],
	featureVersionCreateMany: vi.fn(),
}));

// Fake `updateStoryDraftingStage` with the same "write FeatureVersion only
// when stage changes" contract as the real query. This lets us observe
// the contract at the procedure-test layer without reaching into another
// package's internals.
const currentStageByStory: Record<string, string> = {
	"story-draft": "DRAFT",
	"story-closed": "CLOSED",
};

/**
 * The half of the fetched row the test-first auto-draft reads. Mutable so the
 * wiring tests can turn test-first on; the default leaves it off, which is what
 * keeps every other case in this file about the transition alone.
 */
const autoDraftFixture = {
	generateManualTestCases: true,
	applyTddApproach: false,
	linkedCaseCount: 0,
	/** The org the PROJECT belongs to, which is not the one the caller sends. */
	projectOrganizationId: "org-owning-the-project" as string | null,
};

async function fakeUpdateStoryDraftingStage(
	storyId: string,
	projectId: string,
	stage: string,
) {
	const current = currentStageByStory[storyId];
	if (current === undefined) {
		throw new Error("Story not found");
	}
	if (current === stage) {
		return { id: storyId, projectId, draftingStage: current };
	}
	featureVersionCreateMany({
		data: [{ storyId, draftingStage: current }],
	});
	currentStageByStory[storyId] = stage;
	return { id: storyId, projectId, draftingStage: stage };
}

// Mocked so the Temporal client (and the `@repo/ai` graph behind it) never
// loads here. This suite is about the stage transition; the auto-draft trigger's
// own conditions are covered in `lib/__tests__/auto-draft-test-cases.test.ts`,
// and pulling that whole chain in would turn this file's exhaustive
// `@repo/database` mock into a list of exports it has no interest in.
vi.mock("../../../lib/start-test-case-draft", () => ({
	startTestCaseDraft: vi.fn(async () => ({
		started: true,
		jobId: "job-1",
		status: "PENDING",
	})),
}));

vi.mock("@repo/database", () => ({
	updateStoryDraftingStage: vi.fn(fakeUpdateStoryDraftingStage),
	// Used by the procedure to fetch story.kind for validateStageForKind.
	// All test fixtures are FEATURE so the validator is a no-op and the
	// existing assertions continue to hold; cross-tenant rows return null.
	db: {
		userStory: {
			findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
				const stage = currentStageByStory[where.id];
				if (!stage) {
					return null;
				}
				// The full shape the procedure selects. The test-first
				// auto-draft reads the project switches and the linked-case
				// count from this same row, and a fixture missing them would
				// make the guard decide from `undefined`.
				return {
					kind: "FEATURE" as const,
					draftingStage: stage,
					title: "A feature",
					// Test-first OFF by default, so these cases exercise the
					// transition alone. The trigger's own conditions have their
					// own suite; the wiring tests below flip this fixture.
					project: {
						organizationId: autoDraftFixture.projectOrganizationId,
						generateManualTestCases:
							autoDraftFixture.generateManualTestCases,
						applyTddApproach: autoDraftFixture.applyTddApproach,
					},
					_count: { testCaseLinks: autoDraftFixture.linkedCaseCount },
				};
			}),
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
	// Required by transitively imported modules (e.g. `@repo/ai`).
	GATEWAY_PROVIDERS: [],
	DB_GATEWAY_PROVIDERS: [],
}));

// Mock the notification service so importing the SUT does not pull the real
// notification-service graph (@repo/mail / @repo/payments) into the test.
vi.mock("../../../../../lib/notification-service", () => ({
	fanOut: { subscriptionUpdate: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock("../../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: (...args: unknown[]) => {
			uses.push(...args);
			return chainable;
		},
		route: () => chainable,
		input: (schema: unknown) => {
			(chainable as { _input?: unknown })._input = schema;
			return chainable;
		},
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			handlers.updateDraftingStage = fn;
			return {
				_handler: fn,
				_input: (chainable as { _input?: unknown })._input,
			};
		},
	});

	const Permissions = new Proxy({}, { get: (_t, p) => String(p) }) as Record<
		string,
		string
	>;

	return {
		tenantProtectedProcedure: chainable,
		Permissions,
		requirePermission: () => (c: unknown) => c,
		requireProjectPermission: (perm: string) => {
			uses.push({ requireProjectPermission: perm });
			return (c: unknown) => c;
		},
		resolveOrganizationId: vi.fn(
			(organizationId: string | null | undefined) =>
				organizationId ?? null,
		),
	};
});

import { updateStoryDraftingStage } from "@repo/database";
import { startTestCaseDraft } from "../../../lib/start-test-case-draft";

// Register the handler.
import "../update-drafting-stage";

const ctx = {
	user: { id: "user-1" },
	session: { id: "session-1", activeOrganizationId: null },
};

beforeEach(() => {
	vi.clearAllMocks();
	// Reset story stage baselines between tests.
	currentStageByStory["story-draft"] = "DRAFT";
	currentStageByStory["story-closed"] = "CLOSED";
	// Test-first back OFF, so a wiring test cannot leak into its neighbours.
	autoDraftFixture.generateManualTestCases = true;
	autoDraftFixture.applyTddApproach = false;
	autoDraftFixture.linkedCaseCount = 0;
	autoDraftFixture.projectOrganizationId = "org-owning-the-project";
	// Re-bind the fake impl after clearAllMocks() wipes it.
	vi.mocked(updateStoryDraftingStage).mockImplementation(
		fakeUpdateStoryDraftingStage as never,
	);
});

describe("updateDraftingStageProcedure — input schema & happy paths", () => {
	it("accepts targetStage CLOSED and delegates with the correct args", async () => {
		const result = (await handlers.updateDraftingStage({
			input: {
				projectId: "proj-1",
				storyId: "story-draft",
				organizationId: null,
				targetStage: "CLOSED",
			},
			context: ctx,
		})) as { story: { draftingStage: string } };

		expect(updateStoryDraftingStage).toHaveBeenCalledWith(
			"story-draft",
			"proj-1",
			"CLOSED",
			{
				changedBy: "user-1",
				lastEditedByName: null,
				lastEditedSource: "MANUAL",
				organizationId: undefined,
				userId: "user-1",
			},
		);
		expect(result.story.draftingStage).toBe("CLOSED");
	});

	it("accepts targetStage DRAFT to re-open a CLOSED story", async () => {
		const result = (await handlers.updateDraftingStage({
			input: {
				projectId: "proj-1",
				storyId: "story-closed",
				organizationId: null,
				targetStage: "DRAFT",
			},
			context: ctx,
		})) as { story: { draftingStage: string } };

		expect(updateStoryDraftingStage).toHaveBeenCalledWith(
			"story-closed",
			"proj-1",
			"DRAFT",
			{
				changedBy: "user-1",
				lastEditedByName: null,
				lastEditedSource: "MANUAL",
				organizationId: undefined,
				userId: "user-1",
			},
		);
		expect(result.story.draftingStage).toBe("DRAFT");
	});

	it("requires the STORY_UPDATE permission", () => {
		const found = uses.some(
			(u) =>
				typeof u === "object" &&
				u !== null &&
				(u as { requireProjectPermission?: string })
					.requireProjectPermission === "STORY_UPDATE",
		);
		expect(found).toBe(true);
	});
});

describe("updateDraftingStageProcedure — FeatureVersion write guarantees", () => {
	it("writes a FeatureVersion when the stage changes", async () => {
		await handlers.updateDraftingStage({
			input: {
				projectId: "proj-1",
				storyId: "story-draft",
				organizationId: null,
				targetStage: "CLOSED",
			},
			context: ctx,
		});

		expect(featureVersionCreateMany).toHaveBeenCalledTimes(1);
		expect(featureVersionCreateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.arrayContaining([
					expect.objectContaining({
						storyId: "story-draft",
						// Snapshot captures the PREVIOUS stage, not the new one.
						draftingStage: "DRAFT",
					}),
				]),
			}),
		);
	});

	it("does NOT write a FeatureVersion when stage is unchanged", async () => {
		// Story is already CLOSED; setting it to CLOSED is a no-op.
		await handlers.updateDraftingStage({
			input: {
				projectId: "proj-1",
				storyId: "story-closed",
				organizationId: null,
				targetStage: "CLOSED",
			},
			context: ctx,
		});

		expect(featureVersionCreateMany).not.toHaveBeenCalled();
	});
});

describe("updateDraftingStageProcedure — tenant isolation", () => {
	it("surfaces NOT_FOUND-style errors from the query (cross-tenant)", async () => {
		await expect(
			handlers.updateDraftingStage({
				input: {
					projectId: "proj-1",
					storyId: "story-from-another-tenant",
					organizationId: null,
					targetStage: "CLOSED",
				},
				context: ctx,
			}),
		).rejects.toThrow(/not found/i);
	});

	it("passes `projectId` alongside `storyId` so the query scopes the lookup", async () => {
		await handlers.updateDraftingStage({
			input: {
				projectId: "proj-1",
				storyId: "story-draft",
				organizationId: null,
				targetStage: "CLOSED",
			},
			context: ctx,
		});

		const call = vi.mocked(updateStoryDraftingStage).mock.calls[0];
		expect(call[0]).toBe("story-draft");
		expect(call[1]).toBe("proj-1");
	});
});

describe("updateDraftingStageProcedure — zod validation", () => {
	it("rejects unknown stage values with a Zod (BAD_REQUEST) error", async () => {
		const mod = await import("../update-drafting-stage");
		const schema = (
			mod.updateDraftingStageProcedure as unknown as {
				_input?: { safeParse: (v: unknown) => { success: boolean } };
			}
		)._input;

		expect(schema).toBeDefined();
		const invalid = schema?.safeParse({
			projectId: "proj-1",
			storyId: "story-1",
			organizationId: null,
			targetStage: "NOT_A_REAL_STAGE",
		});
		expect(invalid?.success).toBe(false);

		const valid = schema?.safeParse({
			projectId: "proj-1",
			storyId: "story-1",
			organizationId: null,
			targetStage: "CLOSED",
		});
		expect(valid?.success).toBe(true);
	});
});

/**
 * The trigger's conditions are a pure function with its own suite. What is
 * asserted here is the wiring: that reaching Ready for Dev on this procedure
 * actually reaches the drafting run, and that the guards are consulted with
 * this row's own values rather than defaults.
 *
 * Nothing covered this before, so the auto-draft could have been disconnected
 * — or connected to the wrong stage — without a red test.
 */
describe("updateDraftingStageProcedure — test-first auto-draft wiring", () => {
	const previousFlag = process.env.FABRIC_FEATURE_TEST_CASES;

	beforeEach(() => {
		process.env.FABRIC_FEATURE_TEST_CASES = "true";
	});

	afterAll(() => {
		if (previousFlag === undefined) {
			// Assigning undefined would store the string "undefined", which reads
			// as set to every other suite in this process.
			delete process.env.FABRIC_FEATURE_TEST_CASES;
		} else {
			process.env.FABRIC_FEATURE_TEST_CASES = previousFlag;
		}
	});

	it("starts a drafting run when a feature reaches Ready for Dev", async () => {
		autoDraftFixture.applyTddApproach = true;

		await handlers.updateDraftingStage({
			input: {
				projectId: "proj-1",
				storyId: "story-draft",
				organizationId: null,
				targetStage: "PUBLISHED",
			},
			context: ctx,
		});

		expect(startTestCaseDraft).toHaveBeenCalledTimes(1);
		expect(startTestCaseDraft).toHaveBeenCalledWith({
			projectId: "proj-1",
			// The PROJECT's org, not the request's. This assertion used to read
			// `null` because it echoed the input; the run now takes the org from
			// the loaded record, so a caller cannot point a billable drafting
			// run at an org they do not belong to. Covered directly by "bills
			// the org that owns the project" below.
			organizationId: "org-owning-the-project",
			userId: "user-1",
			requestedById: "user-1",
			storyIds: ["story-draft"],
		});
	});

	it("does not draft when the project has not opted into test-first", async () => {
		autoDraftFixture.applyTddApproach = false;

		await handlers.updateDraftingStage({
			input: {
				projectId: "proj-1",
				storyId: "story-draft",
				organizationId: null,
				targetStage: "PUBLISHED",
			},
			context: ctx,
		});

		expect(startTestCaseDraft).not.toHaveBeenCalled();
	});

	it("bills the org that owns the project, not the one the caller sent", async () => {
		// `resolveOrganizationId` hands back a non-null `input.organizationId`
		// verbatim, and this procedure's guard authorizes `projectId` alone — so
		// the request body cannot be the source. The drafting run resolves AI
		// credentials and debits credits against whatever org it is given, which
		// makes a caller-supplied value a cross-tenant billing hole.
		autoDraftFixture.applyTddApproach = true;
		autoDraftFixture.projectOrganizationId = "org-owning-the-project";

		await handlers.updateDraftingStage({
			input: {
				projectId: "proj-1",
				storyId: "story-draft",
				organizationId: "org-the-caller-claimed",
				targetStage: "PUBLISHED",
			},
			context: ctx,
		});

		expect(startTestCaseDraft).toHaveBeenCalledWith(
			expect.objectContaining({
				organizationId: "org-owning-the-project",
			}),
		);
	});

	it("does not draft a feature that already has cases", async () => {
		autoDraftFixture.applyTddApproach = true;
		autoDraftFixture.linkedCaseCount = 3;

		await handlers.updateDraftingStage({
			input: {
				projectId: "proj-1",
				storyId: "story-draft",
				organizationId: null,
				targetStage: "PUBLISHED",
			},
			context: ctx,
		});

		expect(startTestCaseDraft).not.toHaveBeenCalled();
	});

	it("does not draft on a transition to any other stage", async () => {
		autoDraftFixture.applyTddApproach = true;

		await handlers.updateDraftingStage({
			input: {
				projectId: "proj-1",
				storyId: "story-draft",
				organizationId: null,
				targetStage: "CLOSED",
			},
			context: ctx,
		});

		expect(startTestCaseDraft).not.toHaveBeenCalled();
	});
});
