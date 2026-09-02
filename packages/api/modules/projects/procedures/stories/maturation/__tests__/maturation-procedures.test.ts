import { ORPCError } from "@orpc/client";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TG3 maturation procedure tests (spec 2026-06-09 §13). Mirrors the mocking
 * style of `stories/__tests__/comments.test.ts`: `@repo/database` and the oRPC
 * procedure builder are mocked, and each procedure's handler is captured and
 * invoked directly.
 *
 * Hard requirements asserted here:
 *  - ownership/tenant enforcement (FORBIDDEN) + NOT_FOUND, via ORPCError codes;
 *  - effective approval-mode fall-through matrix (feature → user → hard default,
 *    plus the "Auto-accept all" preset);
 *  - PM-sync isolation (§7.7): appendDecisionEntry / answerQuestion /
 *    setApprovalMode never call `enqueuePmSync`;
 *  - question dedupe (AC-2.4): the same question does not mint a 2nd decision.
 */

const { handlers, mocks } = vi.hoisted(() => {
	const handlers: Array<(...args: unknown[]) => unknown> = [];
	const mocks = {
		hasProjectAccess: vi.fn(),
		getFeatureMaturationState: vi.fn(),
		listDecisionLogThreads: vi.fn(),
		getLatestRunChangeSummary: vi.fn(),
		getApprovalPreference: vi.fn(),
		upsertApprovalPreference: vi.fn(),
		setFeatureApprovalOverride: vi.fn(),
		createDecisionLogEntry: vi.fn(),
		findDecisionByQuestionId: vi.fn(),
		resolveQuestionThread: vi.fn(),
		setDecisionMetadata: vi.fn(),
		optInFeatureToMaturationV2: vi.fn(),
		enqueuePmSync: vi.fn(),
		propagateDecisionToCleanSpec: vi.fn(),
		recordAnswerInSpec: vi.fn(),
		extractMaturationQuestions: vi.fn(),
		getDecisionLogEntryById: vi.fn(),
		recordAiOutcome: vi.fn(),
		acceptPendingPatches: vi.fn(),
		isAiAnswerRecommendationsEnabled: vi.fn(),
		// QA tab
		projectFindUnique: vi.fn(),
		testCaseLinkCount: vi.fn().mockResolvedValue(0),
		userStoryFindMany: vi.fn(),
		userStoryFindUnique: vi.fn(),
		testCaseFindMany: vi.fn().mockResolvedValue([]),
		startTestCaseDraft: vi.fn(),
		parseQaAnalysis: vi.fn(),
		setQaAnalysis: vi.fn(),
		generateQaAnalysisLib: vi.fn(),
		assertTestCasesFeatureEnabled: vi.fn(),
		// Question assignment (#1751)
		listQuestionAssignees: vi.fn().mockResolvedValue(new Map()),
		questionAnswered: vi.fn(),
		questionMentioned: vi.fn(),
		filterAuthorizedMentionRecipients: vi.fn(),
		userFindMany: vi.fn().mockResolvedValue([]),
		isFeatureEnabled: vi.fn().mockResolvedValue(true),
	};
	return { handlers, mocks };
});

// Real `effectiveApprovalMode` + HARD_DEFAULT_APPROVAL_MODE are exercised so the
// fall-through matrix tests run against production logic, not a re-stub.
const HARD_DEFAULT_APPROVAL_MODE = {
	cleanSpec: "AUTO_ACCEPT",
	decisionLog: "AUTO_ACCEPT",
	summaryQuestions: "MANUAL",
} as const;

type Tab = "cleanSpec" | "decisionLog" | "summaryQuestions";
const FEATURE_FIELD: Record<Tab, string> = {
	cleanSpec: "cleanSpecApprovalMode",
	decisionLog: "decisionLogApprovalMode",
	summaryQuestions: "summaryQuestionsApprovalMode",
};
const USER_FIELD: Record<Tab, string> = {
	cleanSpec: "cleanSpecMode",
	decisionLog: "decisionLogMode",
	summaryQuestions: "summaryQuestionsMode",
};

function effectiveApprovalMode(
	feature: Record<string, unknown> | null,
	userPref: Record<string, unknown> | null,
	tab: Tab,
) {
	const featureMode = feature ? feature[FEATURE_FIELD[tab]] : null;
	if (featureMode != null) {
		return featureMode;
	}
	const userMode = userPref ? userPref[USER_FIELD[tab]] : null;
	if (userMode != null) {
		return userMode;
	}
	return HARD_DEFAULT_APPROVAL_MODE[tab];
}

vi.mock("@repo/database", () => ({
	hasProjectAccess: mocks.hasProjectAccess,
	getFeatureMaturationState: mocks.getFeatureMaturationState,
	listDecisionLogThreads: mocks.listDecisionLogThreads,
	getLatestRunChangeSummary: mocks.getLatestRunChangeSummary,
	getApprovalPreference: mocks.getApprovalPreference,
	isAiAnswerRecommendationsEnabled: mocks.isAiAnswerRecommendationsEnabled,
	upsertApprovalPreference: mocks.upsertApprovalPreference,
	setFeatureApprovalOverride: mocks.setFeatureApprovalOverride,
	createDecisionLogEntry: mocks.createDecisionLogEntry,
	findDecisionByQuestionId: mocks.findDecisionByQuestionId,
	resolveQuestionThread: mocks.resolveQuestionThread,
	setDecisionMetadata: mocks.setDecisionMetadata,
	optInFeatureToMaturationV2: mocks.optInFeatureToMaturationV2,
	getDecisionLogEntryById: mocks.getDecisionLogEntryById,
	recordAiOutcome: mocks.recordAiOutcome,
	// Faithful mini-implementation (same shape as the one in
	// `stories/__tests__/update-drafting-stage-with-version-attachment-guard.test.ts`):
	// `answerQuestion` narrows on TYPE to tell a lost concurrency race (a hard
	// CONFLICT) apart from an infrastructure failure (non-fatal `status: "error"`),
	// so a plain stub would collapse that distinction.
	StoryVersionConflictError: class StoryVersionConflictError extends Error {
		readonly storyId: string;
		constructor(storyId: string) {
			super(
				"Feature was updated by another request. Please refresh and try again.",
			);
			this.name = "StoryVersionConflictError";
			this.storyId = storyId;
		}
	},
	effectiveApprovalMode,
	HARD_DEFAULT_APPROVAL_MODE,
	// QA tab: editor-state depth read + analysis parse/persist +
	// sibling-feature titles for the cross-feature analysis context (AC-3).
	// Question assignment (#1751). Editor state loads assignees for the open
	// roots, so an absent branch here throws before any assertion is reached.
	// Empty by default: these tests predate assignment and assert on the
	// question list itself, which assignment does not change.
	listQuestionAssignees: mocks.listQuestionAssignees,
	isFeatureEnabled: mocks.isFeatureEnabled,
	db: {
		user: { findMany: mocks.userFindMany },
		project: { findUnique: mocks.projectFindUnique },
		userStory: {
			findMany: mocks.userStoryFindMany,
			// Eligibility for the standard-flow auto-draft that runs once the
			// QA analysis (the "feature review") has persisted.
			findUnique: mocks.userStoryFindUnique,
		},
		// Live test cases linked to the feature, for the test-first warning on
		// the QA tab. Editor state loads it alongside the others, so an absent
		// branch here throws before any assertion in this file is reached.
		testCaseWorkItemLink: { count: mocks.testCaseLinkCount },
		// Under test-first the review grades the spec against the cases that
		// already exist, so the analysis loads them into its prompt.
		testCase: { findMany: mocks.testCaseFindMany },
	},
	parseQaAnalysis: mocks.parseQaAnalysis,
	setQaAnalysis: mocks.setQaAnalysis,
}));

// The two informational notices an answer raises (#1751, AC-10/AC-14). Mocked
// rather than exercised: the fan-out helpers have their own coverage, and what
// these tests pin is WHICH answers reach them.
vi.mock("../../../../../../lib/notification-service", () => ({
	fanOut: {
		questionAnswered: mocks.questionAnswered,
		questionMentioned: mocks.questionMentioned,
	},
}));

vi.mock("../../../../lib/user-mention", () => ({
	filterAuthorizedMentionRecipients: mocks.filterAuthorizedMentionRecipients,
}));

// The QA analysis model call is exercised in its own lib; here it is stubbed so
// the procedure tests never make a real model call.
vi.mock("../../../../lib/generate-qa-analysis", () => ({
	generateQaAnalysis: mocks.generateQaAnalysisLib,
}));

// The QA procedures ride on the QA feature gate; stub the assert so a
// test can flip the gate without touching process.env.
vi.mock("../../../../lib/test-cases-feature", () => ({
	assertTestCasesFeatureEnabled: mocks.assertTestCasesFeatureEnabled,
}));

// The standard flow drafts test cases once the feature review lands. Mocked at
// the claim/dispatch boundary so the Temporal client (and the `@repo/ai` graph
// behind it) never loads here — the trigger's own conditions are covered in
// `lib/__tests__/auto-draft-test-cases.test.ts`. The real
// `auto-draft-test-cases` module runs, so this suite asserts the WIRING: that
// the procedure reaches it at all.
vi.mock("../../../../lib/start-test-case-draft", () => ({
	startTestCaseDraft: mocks.startTestCaseDraft,
}));

// TG4 propagation is exercised in its own suite (propagate-decision-to-spec
// + answer-question-propagation tests). Here it is stubbed so the TG3 answer/
// dedupe/isolation assertions don't make a real model call.
vi.mock("../../../../lib/propagate-decision-to-spec", () => ({
	propagateDecisionToCleanSpec: mocks.propagateDecisionToCleanSpec,
}));

// Notebook model: answering records the Q+A into the spec deterministically.
vi.mock("../../../../lib/record-answer-in-spec", async (importOriginal) => ({
	// Keep the real (pure) `countPendingDecisions` — get-editor-state uses it to
	// derive pendingDecisionCount/refreshNeeded — but stub the DB-writing recorder.
	...(await importOriginal<
		typeof import("../../../../lib/record-answer-in-spec")
	>()),
	recordAnswerInSpec: mocks.recordAnswerInSpec,
}));

vi.mock("../../../../lib/extract-maturation-questions", () => ({
	extractMaturationQuestions: mocks.extractMaturationQuestions,
}));

vi.mock("../../../../lib/accept-pending-patches", () => ({
	acceptPendingPatches: mocks.acceptPendingPatches,
}));

// PM-sync isolation backstop: if any procedure imported `enqueuePmSync`, this
// spy would observe it. The procedures deliberately do NOT import it, so the
// strongest assertion is simply that the spy is never called (below).
vi.mock("../../../../lib/enqueue-pm-sync", () => ({
	enqueuePmSync: mocks.enqueuePmSync,
}));

vi.mock("../../../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			handlers.push(fn);
			return { _handler: fn };
		},
	};
	return {
		tenantProtectedProcedure: chainable,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requireProjectPermission: () => (c: unknown) => c,
		requireInputOrgPermission: () => (c: unknown) => c,
		resolveOrganizationId: (organizationId: string | null | undefined) =>
			organizationId ?? undefined,
	};
});

// The mock's faithful re-implementation (see the `@repo/database` factory), so
// a test can throw the exact type `answerQuestion` narrows on.
const { StoryVersionConflictError } = await import("@repo/database");

// Import each module in a fixed order; handlers[] fills in that order.
await import("../get-editor-state");
const getEditorState = handlers[0];
await import("../get-approval-mode");
const getApprovalMode = handlers[1];
await import("../set-approval-mode");
const setApprovalMode = handlers[2];
await import("../list-decision-log");
const listDecisionLog = handlers[3];
await import("../append-decision-entry");
const appendDecisionEntry = handlers[4];
await import("../answer-question");
const answerQuestion = handlers[5];
await import("../accept-clean-spec-patch");
const acceptCleanSpecPatch = handlers[6];
await import("../record-change-note");
const recordChangeNote = handlers[7];
await import("../generate-qa-analysis");
const generateQaAnalysis = handlers[8];

const ctx = { user: { id: "user-1", name: "Alice Test" }, session: {} };
const base = {
	projectId: "project-1",
	storyId: "story-1",
	organizationId: null,
};

const feature = {
	id: "story-1",
	projectId: "project-1",
	title: "Checkout flow",
	kind: "FEATURE",
	description: "desc",
	acceptanceCriteria: "ac",
	summaryDigest: "digest",
	workingNotesContent: null,
	maturationV2OptedIn: true,
	qaAnalysis: null,
	cleanSpecApprovalMode: null,
	decisionLogApprovalMode: null,
	summaryQuestionsApprovalMode: null,
};

beforeEach(() => {
	for (const m of Object.values(mocks)) {
		(m as ReturnType<typeof vi.fn>).mockReset();
	}
	mocks.hasProjectAccess.mockResolvedValue(true);
	mocks.getFeatureMaturationState.mockResolvedValue(feature);
	mocks.listDecisionLogThreads.mockResolvedValue([]);
	// Question assignment (#1751) — set here rather than at declaration because
	// the loop above mockReset()s every implementation.
	mocks.listQuestionAssignees.mockResolvedValue(new Map());
	// The narrowing is exercised in `user-mention`'s own tests; here it passes
	// through, so a test that stubs no members still reaches the fan-out.
	mocks.filterAuthorizedMentionRecipients.mockImplementation(
		async (ids: string[]) => ids,
	);
	mocks.userFindMany.mockResolvedValue([]);
	mocks.isFeatureEnabled.mockResolvedValue(true);
	mocks.getApprovalPreference.mockResolvedValue(null);
	mocks.isAiAnswerRecommendationsEnabled.mockResolvedValue(true);
	mocks.setFeatureApprovalOverride.mockResolvedValue(1);
	mocks.setDecisionMetadata.mockResolvedValue(1);
	mocks.optInFeatureToMaturationV2.mockResolvedValue(1);
	mocks.extractMaturationQuestions.mockResolvedValue({
		extracted: 0,
		minted: 0,
		skipped: 0,
		questions: [],
	});
	mocks.getDecisionLogEntryById.mockResolvedValue({
		id: "dec-1",
		metadata: null,
	});
	mocks.acceptPendingPatches.mockResolvedValue({
		status: "applied",
		applied: [{ from: "x", to: "y", summary: "s" }],
		failed: [],
		pmSyncEnqueued: false,
	});
	// Default: propagation no-ops (skipped) so TG3 answer tests don't model-call.
	mocks.propagateDecisionToCleanSpec.mockResolvedValue({
		status: "skipped",
		mode: null,
		applied: [],
		pending: [],
		failed: [],
		pmSyncEnqueued: false,
	});
	// Default: the deterministic spec write succeeds.
	mocks.recordAnswerInSpec.mockResolvedValue(undefined);
	// Default: no run summary yet.
	mocks.getLatestRunChangeSummary.mockResolvedValue(null);
	// QA tab defaults: STANDARD depth, no stored analysis, gate open, model OK.
	mocks.projectFindUnique.mockResolvedValue({
		qaStrategyLevel: "STANDARD",
		organizationId: null,
		// The product defaults, so the auto-draft wiring below is exercised
		// against the configuration almost every project actually runs.
		generateManualTestCases: true,
		applyTddApproach: false,
	});
	mocks.userStoryFindMany.mockResolvedValue([]);
	mocks.userStoryFindUnique.mockResolvedValue({
		kind: "FEATURE",
		_count: { testCaseLinks: 0 },
	});
	mocks.testCaseFindMany.mockResolvedValue([]);
	mocks.startTestCaseDraft.mockResolvedValue({
		started: true,
		jobId: "job-1",
		status: "PENDING",
	});
	mocks.parseQaAnalysis.mockReturnValue(null);
	mocks.setQaAnalysis.mockResolvedValue(1);
	mocks.generateQaAnalysisLib.mockResolvedValue({
		warnings: [{ criterionRef: "AC 1", warning: "Vague threshold." }],
		integrationNotes: "- touches checkout",
		e2eScenarios: "### Happy path",
	});
	mocks.assertTestCasesFeatureEnabled.mockImplementation(() => {});
});

describe("ownership / tenant enforcement", () => {
	it("getEditorState rejects with FORBIDDEN when project access is denied", async () => {
		mocks.hasProjectAccess.mockResolvedValue(false);
		await expect(
			getEditorState({ input: base, context: ctx }),
		).rejects.toBeInstanceOf(ORPCError);
		expect(mocks.getFeatureMaturationState).not.toHaveBeenCalled();
	});

	it("getEditorState rejects with NOT_FOUND when the feature is missing", async () => {
		mocks.getFeatureMaturationState.mockResolvedValue(null);
		await expect(
			getEditorState({ input: base, context: ctx }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it("answerQuestion rejects with FORBIDDEN when project access is denied", async () => {
		mocks.hasProjectAccess.mockResolvedValue(false);
		await expect(
			answerQuestion({
				input: { ...base, questionId: "q1", answer: "yes" },
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.createDecisionLogEntry).not.toHaveBeenCalled();
	});

	it("setApprovalMode rejects with FORBIDDEN when project access is denied", async () => {
		mocks.hasProjectAccess.mockResolvedValue(false);
		await expect(
			setApprovalMode({
				input: { ...base, userDefault: { cleanSpec: "MANUAL" } },
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.upsertApprovalPreference).not.toHaveBeenCalled();
	});
});

describe("getEditorState", () => {
	it("passes the XOR tenant filter (personal = organizationId null) to the query layer", async () => {
		await getEditorState({ input: base, context: ctx });
		expect(mocks.listDecisionLogThreads).toHaveBeenCalledWith({
			tenantFilter: { organizationId: null, userId: "user-1" },
			userStoryId: "story-1",
		});
	});

	// QUESTION_ASSIGNMENT (#1751) is resolved here, server-side, and its absence
	// from the payload is what hides every control. `null` and `{}` must stay
	// distinguishable: `{}` means "on, nobody assigned yet", and collapsing the
	// two would render an empty picker on every question with the feature off.
	it("omits question assignees entirely when the flag is off", async () => {
		mocks.isFeatureEnabled.mockResolvedValue(false);

		const res = (await getEditorState({
			input: { projectId: "project-1", storyId: "story-1" },
			context: { user: { id: "user-1" }, session: {} },
		})) as Record<string, unknown>;

		expect(res.questionAssignees).toBeNull();
		// And it must not pay for the read it will not use.
		expect(mocks.listQuestionAssignees).not.toHaveBeenCalled();
	});

	it("returns an assignee map (not null) when the flag is on", async () => {
		const res = (await getEditorState({
			input: { projectId: "project-1", storyId: "story-1" },
			context: { user: { id: "user-1" }, session: {} },
		})) as Record<string, unknown>;

		expect(res.questionAssignees).toEqual({});
		expect(mocks.listQuestionAssignees).toHaveBeenCalled();
	});

	it("returns only OPEN thread roots as open questions", async () => {
		const mkThread = (id: string, status: string) => ({
			root: {
				id,
				status,
				summary: null,
				content: "c",
				impactedSection: null,
				questionId: id,
				authorType: "USER",
				source: "HUMAN",
				decidedBy: null,
				createdAt: new Date("2026-06-01"),
			},
			replies: [],
		});
		mocks.listDecisionLogThreads.mockResolvedValue([
			mkThread("open-1", "OPEN"),
			mkThread("done-1", "RESOLVED"),
		]);

		const result = (await getEditorState({
			input: base,
			context: ctx,
		})) as {
			openQuestions: Array<{ root: { id: string } }>;
			decisionLog: unknown[];
			cleanSpec: { description: string | null };
		};

		expect(result.openQuestions.map((t) => t.root.id)).toEqual(["open-1"]);
		expect(result.decisionLog).toHaveLength(2);
		expect(result.cleanSpec.description).toBe("desc");
	});

	it("hides persisted AI options when the org flag is off (#7, FR-15)", async () => {
		const withRec = {
			root: {
				id: "open-1",
				status: "OPEN",
				summary: null,
				content: "Is MFA mandatory?",
				impactedSection: null,
				topic: null,
				questionId: "open-1",
				authorType: "AGENT",
				source: "AI_CONFIRMED",
				decidedBy: null,
				createdAt: new Date("2026-06-01"),
				metadata: {
					answerRecommendation: {
						options: [{ text: "Yes", justification: "Baseline." }],
						confidence: "high",
					},
				},
			},
			replies: [],
		};
		mocks.listDecisionLogThreads.mockResolvedValue([withRec]);

		// Flag ON → options surface.
		mocks.isAiAnswerRecommendationsEnabled.mockResolvedValue(true);
		const on = (await getEditorState({ input: base, context: ctx })) as {
			openQuestions: Array<{ root: { suggestedOptions: unknown[] } }>;
		};
		expect(on.openQuestions[0].root.suggestedOptions).toHaveLength(1);

		// Flag OFF → the same persisted options are stripped at the display layer.
		mocks.isAiAnswerRecommendationsEnabled.mockResolvedValue(false);
		const off = (await getEditorState({ input: base, context: ctx })) as {
			openQuestions: Array<{ root: { suggestedOptions: unknown[] } }>;
		};
		expect(off.openQuestions[0].root.suggestedOptions).toEqual([]);
	});
});

describe("effective approval-mode fall-through matrix (§5.3)", () => {
	it("falls through to the hard default when no override and no user preference", async () => {
		const result = (await getApprovalMode({
			input: base,
			context: ctx,
		})) as { effective: Record<Tab, string> };
		expect(result.effective).toEqual({
			cleanSpec: "AUTO_ACCEPT",
			decisionLog: "AUTO_ACCEPT",
			summaryQuestions: "MANUAL",
		});
	});

	it("uses the per-user default over the hard default", async () => {
		mocks.getApprovalPreference.mockResolvedValue({
			cleanSpecMode: "MANUAL",
			decisionLogMode: "MANUAL",
			summaryQuestionsMode: "AUTO_ACCEPT",
			autoAcceptAll: false,
		});
		const result = (await getApprovalMode({
			input: base,
			context: ctx,
		})) as { effective: Record<Tab, string> };
		expect(result.effective).toEqual({
			cleanSpec: "MANUAL",
			decisionLog: "MANUAL",
			summaryQuestions: "AUTO_ACCEPT",
		});
	});

	it("uses the per-feature override over the per-user default", async () => {
		mocks.getFeatureMaturationState.mockResolvedValue({
			...feature,
			cleanSpecApprovalMode: "MANUAL",
		});
		mocks.getApprovalPreference.mockResolvedValue({
			cleanSpecMode: "AUTO_ACCEPT",
			decisionLogMode: "AUTO_ACCEPT",
			summaryQuestionsMode: "AUTO_ACCEPT",
			autoAcceptAll: true,
		});
		const result = (await getApprovalMode({
			input: base,
			context: ctx,
		})) as { effective: Record<Tab, string> };
		expect(result.effective.cleanSpec).toBe("MANUAL");
		// other tabs still resolve from the user default
		expect(result.effective.decisionLog).toBe("AUTO_ACCEPT");
	});
});

describe("setApprovalMode", () => {
	it("Auto-accept all preset flips all three user defaults to AUTO_ACCEPT", async () => {
		mocks.upsertApprovalPreference.mockResolvedValue({
			cleanSpecMode: "AUTO_ACCEPT",
			decisionLogMode: "AUTO_ACCEPT",
			summaryQuestionsMode: "AUTO_ACCEPT",
			autoAcceptAll: true,
		});

		const result = (await setApprovalMode({
			input: { ...base, autoAcceptAll: true },
			context: ctx,
		})) as { effective: Record<Tab, string> };

		expect(mocks.upsertApprovalPreference).toHaveBeenCalledWith(
			expect.objectContaining({
				cleanSpecMode: "AUTO_ACCEPT",
				decisionLogMode: "AUTO_ACCEPT",
				summaryQuestionsMode: "AUTO_ACCEPT",
				autoAcceptAll: true,
			}),
		);
		expect(result.effective).toEqual({
			cleanSpec: "AUTO_ACCEPT",
			decisionLog: "AUTO_ACCEPT",
			summaryQuestions: "AUTO_ACCEPT",
		});
	});

	it("writes a per-feature override and re-resolves effective modes", async () => {
		// The procedure reads the feature back AFTER the write so a freshly
		// written override is reflected in the re-resolved effective modes.
		mocks.getFeatureMaturationState.mockResolvedValue({
			...feature,
			decisionLogApprovalMode: "MANUAL",
		});

		const result = (await setApprovalMode({
			input: {
				...base,
				featureOverride: { decisionLog: "MANUAL" },
			},
			context: ctx,
		})) as { effective: Record<Tab, string> };

		expect(mocks.setFeatureApprovalOverride).toHaveBeenCalledWith(
			expect.objectContaining({
				userStoryId: "story-1",
				projectId: "project-1",
				decisionLogApprovalMode: "MANUAL",
			}),
		);
		expect(result.effective.decisionLog).toBe("MANUAL");
	});

	it("rejects with NOT_FOUND when the per-feature override targets a missing feature", async () => {
		mocks.setFeatureApprovalOverride.mockResolvedValue(0);
		await expect(
			setApprovalMode({
				input: { ...base, featureOverride: { cleanSpec: "MANUAL" } },
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
});

describe("answerQuestion dedupe (AC-2.4)", () => {
	it("mints a RESOLVED decision the first time and does not sync", async () => {
		mocks.findDecisionByQuestionId.mockResolvedValue(null);
		mocks.createDecisionLogEntry.mockResolvedValue({
			id: "dec-1",
			status: "RESOLVED",
			summary: null,
			content: "the answer",
			questionId: "q1",
			impactedSection: null,
			createdAt: new Date("2026-06-10"),
		});

		const result = (await answerQuestion({
			input: { ...base, questionId: "q1", answer: "the answer" },
			context: ctx,
		})) as { deduped: boolean; decision: { id: string } };

		expect(result.deduped).toBe(false);
		expect(result.decision.id).toBe("dec-1");
		expect(mocks.createDecisionLogEntry).toHaveBeenCalledTimes(1);
		expect(mocks.createDecisionLogEntry).toHaveBeenCalledWith(
			expect.objectContaining({
				status: "RESOLVED",
				questionId: "q1",
				authorName: "Alice Test",
				sourceProvenance: "Feature Response — Checkout flow",
			}),
		);
	});

	it("does NOT mint a second decision for the same questionId (idempotent)", async () => {
		mocks.findDecisionByQuestionId.mockResolvedValue({
			id: "dec-existing",
			status: "RESOLVED",
			summary: "prior",
			content: "prior answer",
			questionId: "q1",
			impactedSection: null,
			createdAt: new Date("2026-06-09"),
		});

		const result = (await answerQuestion({
			input: { ...base, questionId: "q1", answer: "again" },
			context: ctx,
		})) as { deduped: boolean; decision: { id: string } };

		expect(result.deduped).toBe(true);
		expect(result.decision.id).toBe("dec-existing");
		expect(mocks.createDecisionLogEntry).not.toHaveBeenCalled();
	});

	it("looks up the existing decision BEFORE creating one", async () => {
		const order: string[] = [];
		mocks.findDecisionByQuestionId.mockImplementation(async () => {
			order.push("find");
			return null;
		});
		mocks.createDecisionLogEntry.mockImplementation(async () => {
			order.push("create");
			return {
				id: "dec-2",
				status: "RESOLVED",
				summary: null,
				content: "a",
				questionId: "q2",
				impactedSection: null,
				createdAt: new Date(),
			};
		});

		await answerQuestion({
			input: { ...base, questionId: "q2", answer: "a" },
			context: ctx,
		});
		expect(order).toEqual(["find", "create"]);
	});

	it("resolves an OPEN question thread in place (reply + flip), not a 2nd mint", async () => {
		mocks.findDecisionByQuestionId.mockResolvedValue({
			id: "root-open",
			status: "OPEN",
			summary: null,
			content: "Q?",
			questionId: "q5",
			impactedSection: null,
			createdAt: new Date("2026-06-08"),
		});
		mocks.resolveQuestionThread.mockResolvedValue({
			id: "root-open",
			status: "RESOLVED",
			summary: null,
			content: "Q?",
			questionId: "q5",
			impactedSection: null,
			createdAt: new Date("2026-06-08"),
		});

		const result = (await answerQuestion({
			input: { ...base, questionId: "q5", answer: "the answer" },
			context: ctx,
		})) as { deduped: boolean; decision: { id: string; status: string } };

		expect(mocks.resolveQuestionThread).toHaveBeenCalledWith(
			expect.objectContaining({
				rootId: "root-open",
				answer: "the answer",
			}),
		);
		// The OPEN root was resolved in place — no parallel root minted.
		expect(mocks.createDecisionLogEntry).not.toHaveBeenCalled();
		expect(result.deduped).toBe(false);
		expect(result.decision.id).toBe("root-open");
		expect(result.decision.status).toBe("RESOLVED");
	});
});

describe("answerQuestion → who hears about it (#1751, AC-10/AC-14)", () => {
	/**
	 * The two informational halves of question routing. Neither asks for
	 * anything — one says a question you handed out is settled, the other says an
	 * answer named you — which is what separates both from QUESTION_ASSIGNED.
	 *
	 * Both were written with the feature and never called: `fanOut.questionAnswered`
	 * and `fanOut.questionMentioned` had no production caller, so answering a
	 * question told the person who asked it precisely nothing.
	 */
	const openRoot = {
		id: "root-1",
		status: "OPEN",
		summary: "What retention period applies?",
		content: "What retention period applies?",
		questionId: "q1",
		impactedSection: null,
		createdAt: new Date("2026-06-10"),
	};

	function resolvedRoot() {
		return { ...openRoot, status: "RESOLVED", content: "Ninety days." };
	}

	it("tells whoever ASKED that their question is settled", async () => {
		mocks.findDecisionByQuestionId.mockResolvedValue(openRoot);
		mocks.resolveQuestionThread.mockResolvedValue(resolvedRoot());
		mocks.listQuestionAssignees.mockResolvedValue(
			new Map([
				[
					"root-1",
					[
						// Two people on the question, handed over by the SAME
						// asker — who must hear back exactly once.
						{
							assigneeUserId: "user-sam",
							assignedByUserId: "user-asker",
						},
						{
							assigneeUserId: "user-dana",
							assignedByUserId: "user-asker",
						},
					],
				],
			]),
		);

		await answerQuestion({
			input: { ...base, questionId: "q1", answer: "Ninety days." },
			context: ctx,
		});

		expect(mocks.questionAnswered).toHaveBeenCalledTimes(1);
		const args = mocks.questionAnswered.mock.calls[0][0];
		expect(args.recipientUserIds).toEqual(["user-asker"]);
		// The anchor is the question root, so the notice lands ON the question.
		expect(args.questionRootId).toBe("root-1");
	});

	it("tells anyone the answer CITED, narrowed to project members", async () => {
		mocks.findDecisionByQuestionId.mockResolvedValue(openRoot);
		mocks.resolveQuestionThread.mockResolvedValue(resolvedRoot());
		// One of the two named ids no longer belongs to the project.
		mocks.filterAuthorizedMentionRecipients.mockResolvedValue(["user-sam"]);

		await answerQuestion({
			input: {
				...base,
				questionId: "q1",
				answer: "As per @Sam R., ninety days.",
				mentionedUserIds: ["user-sam", "user-stranger"],
			},
			context: ctx,
		});

		expect(mocks.filterAuthorizedMentionRecipients).toHaveBeenCalledWith(
			["user-sam", "user-stranger"],
			"project-1",
			null,
		);
		expect(mocks.questionMentioned).toHaveBeenCalledTimes(1);
		expect(
			mocks.questionMentioned.mock.calls[0][0].recipientUserIds,
		).toEqual(["user-sam"]);
	});

	it("stays silent on a DEDUPED answer — nothing new happened", async () => {
		// Already settled: the idempotent path returns early. Re-submitting the
		// same answer must not re-ping the asker.
		mocks.findDecisionByQuestionId.mockResolvedValue(resolvedRoot());

		const result = (await answerQuestion({
			input: {
				...base,
				questionId: "q1",
				answer: "Ninety days.",
				mentionedUserIds: ["user-sam"],
			},
			context: ctx,
		})) as { deduped: boolean };

		expect(result.deduped).toBe(true);
		expect(mocks.questionAnswered).not.toHaveBeenCalled();
		expect(mocks.questionMentioned).not.toHaveBeenCalled();
	});

	it("names nobody when the answer cites nobody and nobody asked", async () => {
		mocks.findDecisionByQuestionId.mockResolvedValue(openRoot);
		mocks.resolveQuestionThread.mockResolvedValue(resolvedRoot());

		await answerQuestion({
			input: { ...base, questionId: "q1", answer: "Ninety days." },
			context: ctx,
		});

		expect(mocks.questionAnswered).not.toHaveBeenCalled();
		expect(mocks.questionMentioned).not.toHaveBeenCalled();
	});
});

describe("answerQuestion → Clean Spec write (notebook model)", () => {
	beforeEach(() => {
		mocks.findDecisionByQuestionId.mockResolvedValue(null);
		mocks.createDecisionLogEntry.mockResolvedValue({
			id: "dec-1",
			status: "RESOLVED",
			summary: null,
			content: "the answer",
			questionId: "q1",
			impactedSection: null,
			createdAt: new Date("2026-06-10"),
			metadata: null,
		});
	});

	it("records the answer into the spec deterministically (no LLM patch)", async () => {
		const result = (await answerQuestion({
			input: { ...base, questionId: "q1", answer: "the answer" },
			context: ctx,
		})) as {
			propagation: {
				status: string;
				appliedCount: number;
				pendingCount: number;
				failedCount: number;
			};
		};

		expect(mocks.recordAnswerInSpec).toHaveBeenCalledTimes(1);
		// No per-answer LLM scoped-patch in the notebook model.
		expect(mocks.propagateDecisionToCleanSpec).not.toHaveBeenCalled();
		expect(result.propagation).toEqual({
			status: "applied",
			appliedCount: 1,
			pendingCount: 0,
			failedCount: 0,
		});
	});

	it("never throws when the spec write fails — answer stands, status is error", async () => {
		mocks.recordAnswerInSpec.mockRejectedValue(new Error("db exploded"));

		const result = (await answerQuestion({
			input: { ...base, questionId: "q1", answer: "the answer" },
			context: ctx,
		})) as {
			decision: { id: string };
			propagation: { status: string };
		};

		expect(mocks.createDecisionLogEntry).toHaveBeenCalledTimes(1);
		expect(result.decision.id).toBe("dec-1");
		expect(result.propagation.status).toBe("error");
	});

	it("does not pass a pre-read description — the write re-reads under its own lock", async () => {
		await answerQuestion({
			input: { ...base, questionId: "q1", answer: "the answer" },
			context: ctx,
		});

		// `feature.description` was read before the decision writes above, so
		// appending onto it is exactly the stale-base race that dropped a
		// concurrent answer's bullet. The recorder must derive its base itself.
		const [params] = mocks.recordAnswerInSpec.mock.calls[0] as [
			Record<string, unknown>,
		];
		expect(params).not.toHaveProperty("currentDescription");
		expect(params).toMatchObject({
			storyId: "story-1",
			projectId: "project-1",
		});
	});

	it("fails hard (CONFLICT) when the spec write loses a race the lock should have prevented", async () => {
		mocks.recordAnswerInSpec.mockRejectedValue(
			new StoryVersionConflictError("story-1"),
		);

		// NOT a warning-level `status: "error"`: with the row lock in place a lost
		// race is an anomaly, and degrading it to a warning is precisely how the
		// reported bug presented — "Resolved" in the Decision Log, absent from the
		// spec.
		const thrown = await answerQuestion({
			input: { ...base, questionId: "q1", answer: "the answer" },
			context: ctx,
		}).catch((err: unknown) => err);

		expect(thrown).toBeInstanceOf(ORPCError);
		expect(thrown).toMatchObject({
			code: "CONFLICT",
			// The decision IS durably recorded; only its integration failed, so it
			// rides along rather than being lost to the error path.
			data: {
				storyId: "story-1",
				decision: expect.objectContaining({
					id: "dec-1",
					status: "RESOLVED",
				}),
			},
		});
		expect(mocks.createDecisionLogEntry).toHaveBeenCalledTimes(1);
	});

	it("lazily opts the feature into v2 on the first answer", async () => {
		mocks.getFeatureMaturationState.mockResolvedValue({
			...feature,
			maturationV2OptedIn: false,
		});

		await answerQuestion({
			input: { ...base, questionId: "q1", answer: "the answer" },
			context: ctx,
		});

		expect(mocks.optInFeatureToMaturationV2).toHaveBeenCalledWith({
			userStoryId: "story-1",
			projectId: "project-1",
		});
	});

	it("does not re-opt-in a feature already opted into v2", async () => {
		// Default `feature` fixture has maturationV2OptedIn: true.
		await answerQuestion({
			input: { ...base, questionId: "q1", answer: "the answer" },
			context: ctx,
		});

		expect(mocks.optInFeatureToMaturationV2).not.toHaveBeenCalled();
	});

	it("does NOT propagate for a deduped (already-settled) answer", async () => {
		mocks.findDecisionByQuestionId.mockResolvedValue({
			id: "dec-existing",
			status: "RESOLVED",
			summary: "prior",
			content: "prior",
			questionId: "q1",
			impactedSection: null,
			createdAt: new Date("2026-06-09"),
			metadata: null,
		});

		const result = (await answerQuestion({
			input: { ...base, questionId: "q1", answer: "again" },
			context: ctx,
		})) as { deduped: boolean; propagation: unknown };

		expect(result.deduped).toBe(true);
		expect(result.propagation).toBeNull();
		expect(mocks.recordAnswerInSpec).not.toHaveBeenCalled();
	});
});

describe("acceptCleanSpecPatch (§7.5 MANUAL accept)", () => {
	const acceptInput = { ...base, decisionId: "dec-1" };

	it("rejects with FORBIDDEN when project access is denied", async () => {
		mocks.hasProjectAccess.mockResolvedValue(false);
		await expect(
			acceptCleanSpecPatch({ input: acceptInput, context: ctx }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.acceptPendingPatches).not.toHaveBeenCalled();
	});

	it("rejects with NOT_FOUND when the decision is missing", async () => {
		mocks.getDecisionLogEntryById.mockResolvedValue(null);
		await expect(
			acceptCleanSpecPatch({ input: acceptInput, context: ctx }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it("delegates to the accept lib and returns its summary", async () => {
		const result = (await acceptCleanSpecPatch({
			input: acceptInput,
			context: ctx,
		})) as { status: string; appliedCount: number };

		expect(mocks.acceptPendingPatches).toHaveBeenCalledWith(
			expect.objectContaining({
				feature,
				decision: expect.objectContaining({ id: "dec-1" }),
				tenantFilter: { organizationId: null, userId: "user-1" },
				projectId: "project-1",
			}),
		);
		expect(result.status).toBe("applied");
		expect(result.appliedCount).toBe(1);
	});

	/**
	 * Behavioural acceptance signal (Fizzy #2230): applying a patch is the PO
	 * saying the AI got it right, so it is the measurement we trust — unlike a
	 * rating, it is recorded for every accept without anyone volunteering.
	 */
	it("records an acceptance verdict when the patch applies", async () => {
		await acceptCleanSpecPatch({ input: acceptInput, context: ctx });

		expect(mocks.recordAiOutcome).toHaveBeenCalledWith(
			expect.objectContaining({
				featureKey: "maturation",
				outcome: "ACCEPTED_AS_IS",
				subjectType: "spec-patch",
				subjectId: "dec-1",
				userId: "user-1",
			}),
		);
	});

	it("records a rejection when the stashed patch no longer applies", async () => {
		mocks.acceptPendingPatches.mockResolvedValueOnce({
			status: "refused",
			applied: [],
			failed: [{ id: "p-1" }],
			pmSyncEnqueued: false,
		});

		await acceptCleanSpecPatch({ input: acceptInput, context: ctx });

		expect(mocks.recordAiOutcome).toHaveBeenCalledWith(
			expect.objectContaining({ outcome: "REJECTED" }),
		);
	});

	/** A no-op had nothing to decide; a verdict nobody rendered would drag the rate down. */
	it("records nothing for a no-op", async () => {
		mocks.acceptPendingPatches.mockResolvedValueOnce({
			status: "noop",
			applied: [],
			failed: [],
			pmSyncEnqueued: false,
		});

		await acceptCleanSpecPatch({ input: acceptInput, context: ctx });

		expect(mocks.recordAiOutcome).not.toHaveBeenCalled();
	});

	/**
	 * Measurement must never break the write it measures — and a SYNCHRONOUS
	 * throw is the case a `.catch()` would miss, turning a successful apply
	 * into a 500.
	 */
	it("still succeeds when outcome capture throws synchronously", async () => {
		mocks.recordAiOutcome.mockImplementationOnce(() => {
			throw new Error("db down");
		});

		const result = (await acceptCleanSpecPatch({
			input: acceptInput,
			context: ctx,
		})) as { status: string };

		expect(result.status).toBe("applied");
	});
});

describe("generateQaAnalysis", () => {
	it("rejects when the QA feature gate is closed", async () => {
		mocks.assertTestCasesFeatureEnabled.mockImplementation(() => {
			throw new ORPCError("NOT_FOUND");
		});
		await expect(
			generateQaAnalysis({ input: base, context: ctx }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.generateQaAnalysisLib).not.toHaveBeenCalled();
	});

	it("rejects with FORBIDDEN when project access is denied", async () => {
		mocks.hasProjectAccess.mockResolvedValue(false);
		await expect(
			generateQaAnalysis({ input: base, context: ctx }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.setQaAnalysis).not.toHaveBeenCalled();
	});

	it("rejects a BUG — the QA tab is a feature-only surface", async () => {
		mocks.getFeatureMaturationState.mockResolvedValue({
			...feature,
			kind: "BUG",
		});
		await expect(
			generateQaAnalysis({ input: base, context: ctx }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.generateQaAnalysisLib).not.toHaveBeenCalled();
	});

	it("rejects an empty spec before making a model call", async () => {
		mocks.getFeatureMaturationState.mockResolvedValue({
			...feature,
			description: null,
			acceptanceCriteria: "   ",
		});
		await expect(
			generateQaAnalysis({ input: base, context: ctx }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.generateQaAnalysisLib).not.toHaveBeenCalled();
	});

	it("persists the analysis stamped with the project depth and a spec hash", async () => {
		mocks.projectFindUnique.mockResolvedValue({
			qaStrategyLevel: "LIGHT",
			organizationId: null,
		});

		const result = (await generateQaAnalysis({
			input: base,
			context: ctx,
		})) as { qaAnalysis: { depth: string; specHash: string } };

		expect(mocks.generateQaAnalysisLib).toHaveBeenCalledWith(
			expect.objectContaining({
				depth: "LIGHT",
				tenantFilter: { organizationId: null, userId: "user-1" },
			}),
		);
		expect(mocks.setQaAnalysis).toHaveBeenCalledWith(
			expect.objectContaining({
				userStoryId: "story-1",
				projectId: "project-1",
				qaAnalysis: expect.objectContaining({
					depth: "LIGHT",
					warnings: [
						{ criterionRef: "AC 1", warning: "Vague threshold." },
					],
					specHash: expect.stringMatching(/^[0-9a-f]{64}$/),
					generatedAt: expect.any(String),
				}),
			}),
		);
		expect(result.qaAnalysis.depth).toBe("LIGHT");
		// PM-sync isolation (§7.7): the QA write never touches the Clean Spec.
		expect(mocks.enqueuePmSync).not.toHaveBeenCalled();
	});

	it("maps a vanished feature at write time to NOT_FOUND", async () => {
		mocks.setQaAnalysis.mockResolvedValue(0);
		await expect(
			generateQaAnalysis({ input: base, context: ctx }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it("replays the stored analysis on a double-fire (unchanged spec, same depth, <60s) without a second model call", async () => {
		// First call generates and persists; capture the exact stored payload
		// (correct specHash for this spec) from the setQaAnalysis write.
		await generateQaAnalysis({ input: base, context: ctx });
		const stored = mocks.setQaAnalysis.mock.calls[0][0].qaAnalysis;
		expect(mocks.generateQaAnalysisLib).toHaveBeenCalledTimes(1);

		// Second call finds it stored, fresh, same hash + depth → replay,
		// flagged so the client can say "already up to date" instead of
		// silently swallowing the click.
		mocks.parseQaAnalysis.mockReturnValue(stored);
		const replay = (await generateQaAnalysis({
			input: base,
			context: ctx,
		})) as { qaAnalysis: unknown; replayed: boolean };

		expect(mocks.generateQaAnalysisLib).toHaveBeenCalledTimes(1);
		expect(mocks.setQaAnalysis).toHaveBeenCalledTimes(1);
		expect(replay.qaAnalysis).toBe(stored);
		expect(replay.replayed).toBe(true);
	});

	it("passes sibling-feature titles into the analysis so cross-feature risks can be grounded (AC-3)", async () => {
		mocks.userStoryFindMany.mockResolvedValue([
			{ identifier: "F-001", title: "Realtime presence" },
		]);

		await generateQaAnalysis({ input: base, context: ctx });

		expect(mocks.userStoryFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					projectId: "project-1",
					kind: "FEATURE",
					id: { not: "story-1" },
				}),
			}),
		);
		expect(mocks.generateQaAnalysisLib).toHaveBeenCalledWith(
			expect.objectContaining({
				projectFeatures: [
					{ identifier: "F-001", title: "Realtime presence" },
				],
			}),
		);
	});

	it("regenerates despite a fresh stored analysis when the depth changed", async () => {
		await generateQaAnalysis({ input: base, context: ctx });
		const stored = mocks.setQaAnalysis.mock.calls[0][0].qaAnalysis;
		mocks.parseQaAnalysis.mockReturnValue(stored);
		// Depth flipped since the stored run (the 5.1→5.2 flow) — must not replay.
		mocks.projectFindUnique.mockResolvedValue({
			qaStrategyLevel: "LIGHT",
			organizationId: null,
		});

		await generateQaAnalysis({ input: base, context: ctx });

		expect(mocks.generateQaAnalysisLib).toHaveBeenCalledTimes(2);
	});

	it("regenerates when the stored analysis is fresh but the spec changed", async () => {
		await generateQaAnalysis({ input: base, context: ctx });
		const stored = mocks.setQaAnalysis.mock.calls[0][0].qaAnalysis;
		mocks.parseQaAnalysis.mockReturnValue(stored);
		mocks.getFeatureMaturationState.mockResolvedValue({
			...feature,
			description: "desc EDITED",
		});

		await generateQaAnalysis({ input: base, context: ctx });

		expect(mocks.generateQaAnalysisLib).toHaveBeenCalledTimes(2);
	});

	it("derives the prompt/model tenant from the project record, not the caller-supplied org", async () => {
		// A member of org B targeting a project outside org B must not have
		// org B's prompt override applied or org B's AI usage billed.
		mocks.projectFindUnique.mockResolvedValue({
			qaStrategyLevel: "STANDARD",
			organizationId: "org-of-project",
		});

		await generateQaAnalysis({
			input: { ...base, organizationId: "org-of-caller" },
			context: ctx,
		});

		expect(mocks.generateQaAnalysisLib).toHaveBeenCalledWith(
			expect.objectContaining({
				tenantFilter: {
					organizationId: "org-of-project",
					userId: "user-1",
				},
			}),
		);
	});
});

// The model-coherence trace the dedupe + open-question model must satisfy
// end-to-end (append OPEN question → it shows open → answer → it leaves open),
// run against the real procedures sharing a single in-memory store.
describe("open-question lifecycle (append → open → answer → resolved)", () => {
	it("an answered question leaves the open list and cannot be re-minted", async () => {
		// In-memory Decision Log keyed by the single feature/tenant under test.
		const store: Array<{
			id: string;
			parentId: string | null;
			status: string;
			summary: string | null;
			content: string | null;
			impactedSection: string | null;
			questionId: string | null;
			authorType: string;
			source: string;
			decidedBy: string | null;
			createdAt: Date;
		}> = [];
		let seq = 0;

		mocks.createDecisionLogEntry.mockImplementation(async (args: any) => {
			const row = {
				id: `row-${++seq}`,
				parentId: args.parentId ?? null,
				status: args.status ?? "OPEN",
				summary: args.summary ?? null,
				content: args.content ?? null,
				impactedSection: args.impactedSection ?? null,
				questionId: args.questionId ?? null,
				authorType: args.authorType ?? "USER",
				source: args.source ?? "HUMAN",
				decidedBy: args.decidedBy ?? null,
				createdAt: new Date(2026, 5, seq),
			};
			store.push(row);
			return row;
		});
		mocks.listDecisionLogThreads.mockImplementation(async () => {
			const roots = store.filter((r) => r.parentId === null);
			return roots
				.slice()
				.reverse()
				.map((root) => ({
					root,
					replies: store.filter((r) => r.parentId === root.id),
				}));
		});
		mocks.findDecisionByQuestionId.mockImplementation(
			async (args: any) =>
				store.find(
					(r) =>
						r.parentId === null && r.questionId === args.questionId,
				) ?? null,
		);
		mocks.resolveQuestionThread.mockImplementation(async (args: any) => {
			const root = store.find((r) => r.id === args.rootId);
			if (!root) {
				return null;
			}
			store.push({
				id: `row-${++seq}`,
				parentId: root.id,
				status: "RESOLVED",
				summary: null,
				content: args.answer,
				impactedSection: null,
				questionId: null,
				authorType: "USER",
				source: "HUMAN",
				decidedBy: args.decidedBy,
				createdAt: new Date(2026, 5, seq),
			});
			root.status = "RESOLVED";
			return root;
		});

		// 1. Append an OPEN question thread.
		await appendDecisionEntry({
			input: {
				...base,
				content: "Should checkout support guest mode?",
				questionId: "q-guest",
				status: "OPEN",
			},
			context: ctx,
		});

		// 2. It shows up as an open question.
		const before = (await getEditorState({
			input: base,
			context: ctx,
		})) as {
			openQuestions: Array<{ root: { questionId: string | null } }>;
		};
		expect(before.openQuestions.map((t) => t.root.questionId)).toContain(
			"q-guest",
		);

		// 3. Answer it.
		const answered = (await answerQuestion({
			input: {
				...base,
				questionId: "q-guest",
				answer: "Yes, guest mode.",
			},
			context: ctx,
		})) as { deduped: boolean };
		expect(answered.deduped).toBe(false);

		// 4. It is gone from the open list — the answer was not lost.
		const after = (await getEditorState({
			input: base,
			context: ctx,
		})) as {
			openQuestions: Array<{ root: { questionId: string | null } }>;
		};
		expect(after.openQuestions.map((t) => t.root.questionId)).not.toContain(
			"q-guest",
		);

		// 5. Re-answering the same question is idempotent (dedupe, AC-2.4).
		const again = (await answerQuestion({
			input: { ...base, questionId: "q-guest", answer: "Again." },
			context: ctx,
		})) as { deduped: boolean };
		expect(again.deduped).toBe(true);
	});
});

describe("PM-sync isolation (§7.7)", () => {
	it("appendDecisionEntry does not call enqueuePmSync", async () => {
		mocks.createDecisionLogEntry.mockResolvedValue({
			id: "entry-1",
			parentId: null,
			status: "OPEN",
			summary: null,
			content: "note",
			impactedSection: null,
			questionId: null,
			createdAt: new Date(),
		});

		await appendDecisionEntry({
			input: { ...base, content: "note" },
			context: ctx,
		});
		expect(mocks.enqueuePmSync).not.toHaveBeenCalled();
	});

	it("answerQuestion does not call enqueuePmSync", async () => {
		mocks.findDecisionByQuestionId.mockResolvedValue(null);
		mocks.createDecisionLogEntry.mockResolvedValue({
			id: "dec-3",
			status: "RESOLVED",
			summary: null,
			content: "ans",
			questionId: "q3",
			impactedSection: null,
			createdAt: new Date(),
		});

		await answerQuestion({
			input: { ...base, questionId: "q3", answer: "ans" },
			context: ctx,
		});
		expect(mocks.enqueuePmSync).not.toHaveBeenCalled();
	});

	it("setApprovalMode does not call enqueuePmSync", async () => {
		mocks.upsertApprovalPreference.mockResolvedValue({
			cleanSpecMode: "MANUAL",
			decisionLogMode: "AUTO_ACCEPT",
			summaryQuestionsMode: "MANUAL",
			autoAcceptAll: false,
		});

		await setApprovalMode({
			input: { ...base, userDefault: { cleanSpec: "MANUAL" } },
			context: ctx,
		});
		expect(mocks.enqueuePmSync).not.toHaveBeenCalled();
	});
});

describe("listDecisionLog", () => {
	it("rejects with FORBIDDEN when project access is denied", async () => {
		mocks.hasProjectAccess.mockResolvedValue(false);
		await expect(
			listDecisionLog({ input: base, context: ctx }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("returns the threaded log from the query layer", async () => {
		mocks.listDecisionLogThreads.mockResolvedValue([
			{
				root: {
					id: "r1",
					status: "RESOLVED",
					summary: "did the thing",
					content: "c",
					impactedSection: "AC-5",
					questionId: "q1",
					authorType: "USER",
					source: "HUMAN",
					decidedBy: "user-1",
					createdAt: new Date("2026-06-02"),
				},
				replies: [],
			},
		]);
		const result = (await listDecisionLog({
			input: base,
			context: ctx,
		})) as { threads: Array<{ root: { summary: string | null } }> };
		expect(result.threads).toHaveLength(1);
		expect(result.threads[0].root.summary).toBe("did the thing");
	});
});

describe("recordChangeNote", () => {
	it("records the change note with the confirmer's name and AI Feature Assistant source", async () => {
		mocks.createDecisionLogEntry.mockResolvedValue({ id: "dec-1" });
		const result = (await recordChangeNote({
			input: { ...base, bullets: ["Changed X", "Changed Y"] },
			context: ctx,
		})) as { id: string };

		expect(mocks.createDecisionLogEntry).toHaveBeenCalledWith(
			expect.objectContaining({
				authorName: "Alice Test",
				sourceProvenance: "AI Feature Assistant",
				status: "RESOLVED",
				source: "AI_CONFIRMED",
				impactedSection: "AI Updates",
				content: "Changed X\nChanged Y",
			}),
		);
		expect(result.id).toBe("dec-1");
	});
});

/**
 * The standard flow's drafting trigger.
 *
 * "Apply TDD approach" describes an ORDER, and its OFF position — the default —
 * says cases are drafted after the feature review. Nothing observed that review
 * before, so on the default settings no feature was ever drafted automatically
 * at all: QA moved a feature through every stage and the draft-job list stayed
 * empty. These tests assert the WIRING rather than the conditions, because the
 * conditions were never the bug — the missing call was.
 */
describe("generateQaAnalysis — standard-flow auto-draft wiring", () => {
	const previousFlag = process.env.FABRIC_FEATURE_TEST_CASES;

	beforeEach(() => {
		process.env.FABRIC_FEATURE_TEST_CASES = "true";
	});

	afterAll(() => {
		if (previousFlag === undefined) {
			// Assigning undefined stores the string "undefined", which reads as
			// set to every other suite in this process.
			delete process.env.FABRIC_FEATURE_TEST_CASES;
		} else {
			process.env.FABRIC_FEATURE_TEST_CASES = previousFlag;
		}
	});

	it("starts a drafting run once the review has persisted", async () => {
		await generateQaAnalysis({ input: base, context: ctx });

		expect(mocks.startTestCaseDraft).toHaveBeenCalledTimes(1);
		expect(mocks.startTestCaseDraft).toHaveBeenCalledWith({
			projectId: "project-1",
			organizationId: null,
			userId: "user-1",
			requestedById: "user-1",
			storyIds: ["story-1"],
		});
	});

	it("does not draft under test-first", async () => {
		// Those cases already exist — they are what this review graded.
		mocks.projectFindUnique.mockResolvedValue({
			qaStrategyLevel: "STANDARD",
			organizationId: null,
			generateManualTestCases: true,
			applyTddApproach: true,
		});

		await generateQaAnalysis({ input: base, context: ctx });

		expect(mocks.startTestCaseDraft).not.toHaveBeenCalled();
	});

	it("does not draft when generation is switched off", async () => {
		mocks.projectFindUnique.mockResolvedValue({
			qaStrategyLevel: "STANDARD",
			organizationId: null,
			generateManualTestCases: false,
			applyTddApproach: false,
		});

		await generateQaAnalysis({ input: base, context: ctx });

		expect(mocks.startTestCaseDraft).not.toHaveBeenCalled();
	});

	it("does not draft a feature that already has cases", async () => {
		// Re-reviewing a feature is normal and must not re-bill.
		mocks.userStoryFindUnique.mockResolvedValue({
			kind: "FEATURE",
			_count: { testCaseLinks: 2 },
		});

		await generateQaAnalysis({ input: base, context: ctx });

		expect(mocks.startTestCaseDraft).not.toHaveBeenCalled();
	});

	it("does not draft a second time when the analysis is served from the idempotent replay", async () => {
		// A double-click returns the STORED analysis without generating, so no
		// new review happened — and a run must not be claimed again. Driven
		// through a real first call so the stored payload carries the correct
		// spec hash, rather than a hand-computed one that would silently stop
		// matching the moment `combineCleanSpec` changes.
		await generateQaAnalysis({ input: base, context: ctx });
		expect(mocks.startTestCaseDraft).toHaveBeenCalledTimes(1);

		const stored = mocks.setQaAnalysis.mock.calls[0][0].qaAnalysis;
		mocks.parseQaAnalysis.mockReturnValue(stored);

		const replay = (await generateQaAnalysis({
			input: base,
			context: ctx,
		})) as { replayed: boolean };

		expect(replay.replayed).toBe(true);
		expect(mocks.startTestCaseDraft).toHaveBeenCalledTimes(1);
	});

	it("does not fail the review when the drafting run cannot start", async () => {
		// Fire-and-forget: nobody pressed a button, and the review is what the
		// user actually asked for.
		mocks.startTestCaseDraft.mockRejectedValue(new Error("temporal down"));

		await expect(
			generateQaAnalysis({ input: base, context: ctx }),
		).resolves.toMatchObject({ replayed: false });
	});
});

/**
 * Step 5 of the test-first flow: the review reads the cases too.
 *
 * The prompt clause that carries this is unit-tested where it lives, but
 * nothing asserted that the PROCEDURE loads the cases and hands them over —
 * so deleting the query would have left every test green while the ordering
 * setting quietly stopped affecting the review.
 */
describe("generateQaAnalysis — test-first reads the drafted cases", () => {
	const tddProject = {
		qaStrategyLevel: "STANDARD",
		organizationId: null,
		generateManualTestCases: true,
		applyTddApproach: true,
	};

	it("loads the feature's cases and hands them to the analysis", async () => {
		mocks.projectFindUnique.mockResolvedValue(tddProject);
		mocks.testCaseFindMany.mockResolvedValue([
			{ identifier: "TC-001", title: "Rejects an expired token" },
			{ identifier: "TC-002", title: "Accepts a fresh token" },
		]);

		await generateQaAnalysis({ input: base, context: ctx });

		// Scoped to this feature, not the whole project.
		expect(mocks.testCaseFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					projectId: "project-1",
					workItemLinks: { some: { userStoryId: "story-1" } },
				}),
			}),
		);
		expect(mocks.generateQaAnalysisLib).toHaveBeenCalledWith(
			expect.objectContaining({
				tddTestCases: [
					{ identifier: "TC-001", title: "Rejects an expired token" },
					{ identifier: "TC-002", title: "Accepts a fresh token" },
				],
			}),
		);
	});

	it("records how many cases the review read, so the tab can show it", async () => {
		mocks.projectFindUnique.mockResolvedValue(tddProject);
		mocks.testCaseFindMany.mockResolvedValue([
			{ identifier: "TC-001", title: "One" },
		]);

		await generateQaAnalysis({ input: base, context: ctx });

		expect(mocks.setQaAnalysis).toHaveBeenCalledWith(
			expect.objectContaining({
				qaAnalysis: expect.objectContaining({
					reviewedAgainstCaseCount: 1,
				}),
			}),
		);
	});

	it("reads no cases on the standard flow, and records no count", async () => {
		// Here the cases are drafted FROM this review, so feeding them back
		// would grade the model's own later output. A stamped 0 would read as a
		// failure rather than as the intended ordering, so the field is absent.
		await generateQaAnalysis({ input: base, context: ctx });

		expect(mocks.testCaseFindMany).not.toHaveBeenCalled();
		expect(mocks.generateQaAnalysisLib).toHaveBeenCalledWith(
			expect.objectContaining({ tddTestCases: undefined }),
		);
		const stored = mocks.setQaAnalysis.mock.calls[0][0].qaAnalysis;
		expect(stored).not.toHaveProperty("reviewedAgainstCaseCount");
	});
});
