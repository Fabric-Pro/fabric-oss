import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Planning & Analysis LLM activity (Fizzy #1851, Phase 2A-2).
 *
 * Three things this file is really about, and only one of them is the model
 * call:
 *
 *  1. The topic read is re-scoped by `projectId`, so a valid topic id from
 *     ANOTHER project resolves to the same nothing a missing one does (DV16).
 *  2. The actor's org membership is re-checked at the point of use, and the
 *     model factory is never reached when it fails (org model resolution
 *     prefers the actor's PERSONAL provider, so a removed admin would otherwise
 *     keep powering org runs under their identity).
 *  3. A run that produces output the schema rejects fails NON-retryably rather
 *     than persisting a half-shaped analysis.
 */

vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn() }));

const generateObject = vi.fn();
const getAIModelWithMetadata = vi.fn();
vi.mock("@repo/ai", () => ({
	generateObject: (...a: unknown[]) => generateObject(...a),
	getAIModelWithMetadata: (...a: unknown[]) => getAIModelWithMetadata(...a),
}));

const computeMaxOutputTokenBudget = vi.fn();
vi.mock("@repo/ai/lib/output-token-budget", () => ({
	computeMaxOutputTokenBudget: (...a: unknown[]) =>
		computeMaxOutputTokenBudget(...a),
}));

const getProjectFunctionTagClause = vi.fn();
vi.mock("@repo/ai/lib/function-tag-context", () => ({
	getProjectFunctionTagClause: (...a: unknown[]) =>
		getProjectFunctionTagClause(...a),
}));

const topicFindFirst = vi.fn();
const userFindMany = vi.fn();
const checkPublishingGenerationActor = vi.fn();
const getBoundPromptForAgent = vi.fn();
const completePlanningAnalysis = vi.fn();
vi.mock("@repo/database", () => ({
	db: {
		publishingTopic: {
			findFirst: (...a: unknown[]) => topicFindFirst(...a),
		},
		user: { findMany: (...a: unknown[]) => userFindMany(...a) },
	},
	checkPublishingGenerationActor: (...a: unknown[]) =>
		checkPublishingGenerationActor(...a),
	getBoundPromptForAgent: (...a: unknown[]) => getBoundPromptForAgent(...a),
	completePlanningAnalysis: (...a: unknown[]) =>
		completePlanningAnalysis(...a),
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const collectPlanningContext = vi.fn();
vi.mock("../collect-planning-context", () => ({
	collectPlanningContext: (...a: unknown[]) => collectPlanningContext(...a),
}));

import { generatePlanningAnalysisActivity } from "../generate-planning-analysis";

const trackUsage = vi.fn();

const TOPIC = {
	id: "topic-1",
	title: "Bounded retry budgets",
	pitch: "We stopped runaway retries.",
	angle: "reliability",
	subject: "retry budgets",
	relevantFunctionTags: ["BACKEND"],
	postTypeRecommendations: [],
	contributorUserIds: ["user-2"],
};

const MODEL_OUTPUT = {
	topicAngle: "An engineering reliability story.",
	whyWorthPublishing: "It is a concrete, measurable change.",
	contentTypes: {
		needsConfirmation: [
			{ type: "Customer case study", rationale: "Names a customer." },
		],
	},
	recommendedQuestions: [
		{
			decisionKind: "CUSTOMER_NAME",
			subject: "the named customer",
			question: "May we name the customer?",
			recommendedResponse: "Ask their marketing contact.",
		},
	],
};

const CONTEXT_RESULT = {
	context: {
		stories: [],
		documents: [],
		transcripts: [],
		repoPrs: [],
	},
	sourceRefs: {
		stories: [],
		documents: [],
		transcripts: [],
		repoPrs: [],
		prBodiesFetched: 0,
		activeRepoCount: null,
		unresolved: { storyIds: [], docIds: [], transcriptIds: [] },
		failures: {},
	},
};

beforeEach(() => {
	vi.clearAllMocks();
	topicFindFirst.mockResolvedValue(TOPIC);
	userFindMany.mockResolvedValue([{ id: "user-2", name: "A Contributor" }]);
	checkPublishingGenerationActor.mockResolvedValue({ ok: true });
	getBoundPromptForAgent.mockResolvedValue(null);
	collectPlanningContext.mockResolvedValue(CONTEXT_RESULT);
	getProjectFunctionTagClause.mockResolvedValue("");
	computeMaxOutputTokenBudget.mockReturnValue(8192);
	getAIModelWithMetadata.mockResolvedValue({
		model: {},
		metadata: { modelString: "test-model", provider: "test" },
		trackUsage,
	});
	generateObject.mockResolvedValue({
		object: MODEL_OUTPUT,
		usage: { totalTokens: 100 },
	});
	completePlanningAnalysis.mockResolvedValue({ persisted: true });
});

const run = (overrides: Record<string, unknown> = {}) =>
	generatePlanningAnalysisActivity({
		analysisId: "pa-1",
		topicId: "topic-1",
		projectId: "proj-1",
		organizationId: "org-1",
		actorUserId: "user-1",
		...overrides,
	});

describe("generatePlanningAnalysisActivity — tenancy", () => {
	it("re-scopes the topic read by projectId", async () => {
		await run();

		expect(topicFindFirst.mock.calls[0]?.[0]?.where).toEqual({
			id: "topic-1",
			projectId: "proj-1",
		});
	});

	it("fails closed when the topic does not resolve inside the project", async () => {
		// DV16: a real topic id belonging to another project must be
		// indistinguishable from a deleted one. Non-retryable, because retrying
		// cannot make a cross-tenant id valid.
		topicFindFirst.mockResolvedValue(null);

		await expect(run()).rejects.toMatchObject({
			type: "PUBLISHING_TENANT_MISMATCH",
			nonRetryable: true,
		});
		expect(getAIModelWithMetadata).not.toHaveBeenCalled();
	});
});

describe("generatePlanningAnalysisActivity — actor revalidation", () => {
	it("re-checks the actor's PROJECT authorization before resolving a model", async () => {
		// The argument bag, not just "it was called". The defect this replaced
		// was that the re-check asked a different question than the API gate —
		// so what has to be pinned is WHICH question, and about which project.
		await run();

		expect(checkPublishingGenerationActor).toHaveBeenCalledWith({
			projectId: "proj-1",
			organizationId: "org-1",
			actorUserId: "user-1",
		});
	});

	it("never reaches the model factory when the actor is no longer authorized", async () => {
		// The assertion that matters is the SECOND one. Throwing is easy to get
		// right by accident; what this guard exists for is that no model is
		// resolved under a revoked collaborator's identity, and only "the factory
		// was never called" proves the check runs BEFORE resolution rather than
		// beside it.
		//
		// Provider resolution is organization-FIRST (`getAiProviderApiKey`), so
		// the spend a late check would allow is the ORGANIZATION's. The comment
		// that stood here said the opposite, and the guard was built on it.
		checkPublishingGenerationActor.mockResolvedValue({
			ok: false,
			reason: "NOT_AUTHORIZED",
			currentOrganizationId: "org-1",
		});

		await expect(run()).rejects.toMatchObject({
			type: "PUBLISHING_ACTOR_INVALID",
			nonRetryable: true,
		});
		expect(getAIModelWithMetadata).not.toHaveBeenCalled();
		expect(generateObject).not.toHaveBeenCalled();
	});

	it("refuses when the project has left the organization the run was queued under", async () => {
		checkPublishingGenerationActor.mockResolvedValue({
			ok: false,
			reason: "TENANT_MISMATCH",
			currentOrganizationId: "org-2",
		});

		await expect(run()).rejects.toMatchObject({
			type: "PUBLISHING_TENANT_MISMATCH",
			nonRetryable: true,
		});
		expect(getAIModelWithMetadata).not.toHaveBeenCalled();
	});

	it("re-checks the actor even when the run carries no organization", async () => {
		// The old guard was `if (organizationId != null)`, so a run with no
		// organization got NO actor re-validation at all — and the case that
		// stood here asserted only that `isCurrentOrgMember` was not called,
		// which is true of every possible implementation, including one that
		// checks nothing.
		//
		// The branch is unreachable in production: the feature gate refuses a
		// project with no organization (ADR-018). A fail-closed unit case, then,
		// not coverage of a live path — said here so nobody reads it as one.
		checkPublishingGenerationActor.mockResolvedValue({
			ok: false,
			reason: "NOT_AUTHORIZED",
			currentOrganizationId: null,
		});

		await expect(run({ organizationId: null })).rejects.toMatchObject({
			type: "PUBLISHING_ACTOR_INVALID",
		});
		expect(generateObject).not.toHaveBeenCalled();
	});

	it("still generates for an authorized run that carries no organization", async () => {
		await run({ organizationId: null });

		expect(generateObject).toHaveBeenCalled();
	});
});

describe("generatePlanningAnalysisActivity — prompt resolution", () => {
	it("resolves the bound prompt in the activity, scoped to the tenant", async () => {
		await run();

		expect(getBoundPromptForAgent).toHaveBeenCalledWith(
			expect.objectContaining({
				agentName: "publishing_topic_planning_analysis",
				documentType: "GENERAL",
				userId: "user-1",
				organizationId: "org-1",
			}),
		);
	});

	it("passes organizationId undefined for a personal project", async () => {
		// Load-bearing for tenancy: falsy takes the personal USER → SYSTEM path,
		// truthy takes ORG → SYSTEM. `null` is not falsy enough for the resolver's
		// signature, so it has to become `undefined`.
		await run({ organizationId: null });

		expect(getBoundPromptForAgent.mock.calls[0]?.[0]?.organizationId).toBe(
			undefined,
		);
	});

	it("records DEFAULT_UNBOUND when no prompt is bound", async () => {
		await run();

		expect(completePlanningAnalysis.mock.calls[0]?.[0]?.promptSource).toBe(
			"DEFAULT_UNBOUND",
		);
	});

	it("records BOUND and uses the bound body", async () => {
		getBoundPromptForAgent.mockResolvedValue({
			id: "p-1",
			format: "HANDLEBARS",
			version: { content: "Analyse {{{topic_title}}} carefully." },
		});

		await run();

		expect(completePlanningAnalysis.mock.calls[0]?.[0]?.promptSource).toBe(
			"BOUND",
		);
		expect(generateObject.mock.calls[0]?.[0]?.prompt).toContain(
			"Bounded retry budgets",
		);
	});

	it("records DEFAULT_RENDER_FAILED when a bound body renders to nothing", async () => {
		// The one fact about a run that cannot be recovered from its output: an
		// analysis built from the default body because the bound prompt would not
		// render reads exactly like one built from the bound prompt.
		getBoundPromptForAgent.mockResolvedValue({
			id: "p-1",
			format: "HANDLEBARS",
			version: { content: "   " },
		});

		await run();

		expect(completePlanningAnalysis.mock.calls[0]?.[0]?.promptSource).toBe(
			"DEFAULT_RENDER_FAILED",
		);
	});

	it("appends the project's function-tag clause", async () => {
		getProjectFunctionTagClause.mockResolvedValue(
			"ROLE COMPOSITION: backend",
		);

		await run();

		expect(generateObject.mock.calls[0]?.[0]?.prompt).toContain(
			"ROLE COMPOSITION: backend",
		);
	});
});

describe("generatePlanningAnalysisActivity — the model call", () => {
	it("disables strict JSON schema", async () => {
		// Every section of the analysis schema is optional, and Azure/OpenAI reject
		// a strict JSON schema containing optional fields outright (bug #1681).
		await run();

		expect(generateObject.mock.calls[0]?.[0]?.providerOptions).toEqual({
			openai: { strictJsonSchema: false },
		});
	});

	it("tracks usage", async () => {
		await run();
		expect(trackUsage).toHaveBeenCalled();
	});

	it("fails non-retryably when the model output does not validate", async () => {
		// `question` is required on every recommended question. A run that cannot
		// produce a valid shape will not produce one on a retry either, and a
		// half-shaped analysis persisted as READY is worse than a visible failure.
		generateObject.mockResolvedValue({
			object: { recommendedQuestions: [{ subject: "no question text" }] },
			usage: {},
		});

		await expect(run()).rejects.toMatchObject({
			type: "PUBLISHING_PA_SCHEMA_VALIDATION_FAILED",
			nonRetryable: true,
		});
		expect(completePlanningAnalysis).not.toHaveBeenCalled();
	});
});

describe("generatePlanningAnalysisActivity — what it persists", () => {
	it("stamps a stable id on every confirmation question", async () => {
		await run();

		const content = completePlanningAnalysis.mock.calls[0]?.[0]?.content;
		for (const q of content.questions) {
			expect(q.questionId).toMatch(/^[0-9a-f]{32}$/);
		}
	});

	it("merges the model's questions with the ones the buckets imply", async () => {
		// Two decisions, not one. The model raised "may we name the customer?";
		// separately, it put a content type in `needsConfirmation`, and that bucket
		// is itself an unanswered decision ("do we publish it as a case study?").
		// Deriving the second is what stops a confirmation requirement the model
		// stated in a bucket from having no question attached to it — FR39's whole
		// point is that the buckets and the question list cannot disagree.
		await run();

		const content = completePlanningAnalysis.mock.calls[0]?.[0]?.content;
		const bySource = Object.fromEntries(
			content.questions.map(
				(q: { source: string; decisionKind: string }) => [
					q.source,
					q.decisionKind,
				],
			),
		);
		expect(bySource).toEqual({
			MODEL: "CUSTOMER_NAME",
			DERIVED: "CONTENT_TYPE",
		});
		expect(
			new Set(
				content.questions.map(
					(q: { questionId: string }) => q.questionId,
				),
			).size,
		).toBe(2);
	});

	it("drops the raw recommendedQuestions array", async () => {
		// The raw array carries no ids. Keeping it beside the resolved list would
		// leave the page two sources of truth for the same questions, and the one
		// without ids is the one that cannot be answered.
		await run();

		const content = completePlanningAnalysis.mock.calls[0]?.[0]?.content;
		expect(content.recommendedQuestions).toBeUndefined();
	});

	it("persists the analysis, the source refs and the model", async () => {
		await run();

		expect(completePlanningAnalysis).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "pa-1",
				projectId: "proj-1",
				model: "test-model",
				sourceRefs: CONTEXT_RESULT.sourceRefs,
			}),
		);
	});

	it("hands the resolved questions to completePlanningAnalysis as reconciliation rows", async () => {
		// This is the single link that makes reconciliation happen at all
		// (`publishing-decisions.ts`): `content.questions` is the analysis's own
		// record of what it raised, but `reconcileTopicQuestions` never sees the
		// content blob — only this separate `questions` argument. Pinned by
		// comparing it against `content.questions` itself (projected down to the
		// 6 fields the DB layer's `ReconcilableQuestion` type takes), so deleting
		// the argument, or letting it drift out of sync with the content, both
		// fail here rather than only in production.
		await run();

		const content = completePlanningAnalysis.mock.calls[0]?.[0]?.content;
		const questions =
			completePlanningAnalysis.mock.calls[0]?.[0]?.questions;

		expect(questions).toEqual(
			content.questions.map(
				(q: {
					questionId: string;
					decisionKind: string;
					subject: string | null;
					question: string;
					recommendedResponse: string | null;
					whyItMatters: string | null;
				}) => ({
					questionId: q.questionId,
					decisionKind: q.decisionKind,
					subject: q.subject,
					question: q.question,
					recommendedResponse: q.recommendedResponse,
					whyItMatters: q.whyItMatters,
				}),
			),
		);
		// Guards against a vacuous pass: MODEL_OUTPUT resolves to two questions
		// (see "merges the model's questions with the ones the buckets imply"
		// above), so if the `questions:` argument were ever deleted entirely,
		// `questions` here is `undefined` and this fails loudly rather than
		// `toEqual` quietly comparing two empty arrays.
		expect(questions).toHaveLength(2);
	});

	it("reports SUPERSEDED rather than throwing when the CAS is lost", async () => {
		// The attempt was reclaimed by a deadline sweep while the model ran. Its
		// row is already terminal and a newer attempt owns the topic — writing
		// over that would silently make the older result the current one.
		completePlanningAnalysis.mockResolvedValue({ persisted: false });

		await expect(run()).resolves.toEqual({ status: "SUPERSEDED" });
	});

	it("reports READY on the happy path", async () => {
		await expect(run()).resolves.toEqual({ status: "READY" });
	});
});

describe("generatePlanningAnalysisActivity — output budget", () => {
	// Repo review bot on #61: `generateObject()` with no `maxOutputTokens`. An
	// unbounded generation fails as a HANG rather than an error — it burns the
	// activity's whole 480s budget and then reports a timeout, which reads as a
	// broken feature rather than a slow one. This repository already has the
	// helper for it; this call site simply was not using it.
	it("bounds the generation against the full prompt it is about to send", async () => {
		await run();

		// The FULL prompt, including the appended role clause — the clamp exists
		// to reserve context-window room for the input, so measuring anything
		// shorter than what is actually sent would under-reserve.
		const sentPrompt = generateObject.mock.calls[0]?.[0]?.prompt;
		expect(computeMaxOutputTokenBudget).toHaveBeenCalledWith(
			expect.anything(),
			{ promptChars: sentPrompt.length },
		);
	});

	it("passes the budget through when the helper returns one", async () => {
		computeMaxOutputTokenBudget.mockReturnValue(12_345);

		await run();

		expect(generateObject.mock.calls[0]?.[0]?.maxOutputTokens).toBe(12_345);
	});

	it("omits the field entirely when the helper declines to set one", async () => {
		// `undefined` is a real answer: some providers must NOT be sent an
		// explicit budget. Sending `maxOutputTokens: undefined` is not the same
		// as omitting the key for every SDK that forwards its own request body.
		computeMaxOutputTokenBudget.mockReturnValue(undefined);

		await run();

		expect(generateObject.mock.calls[0]?.[0]).not.toHaveProperty(
			"maxOutputTokens",
		);
	});
});
