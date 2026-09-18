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
const projectFindUnique = vi.fn();
const projectMemberFindMany = vi.fn();
const checkPublishingGenerationActor = vi.fn();
const getBoundPromptForAgent = vi.fn();
// The project's `autoProposeAnswers` switch, read when the prompt is written.
const getPublishingSuiteSettings = vi.fn();
const completePlanningAnalysis = vi.fn();
const listTopicDecisions = vi.fn();
vi.mock("@repo/database", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@repo/database")>();
	return {
		// `effectiveContributorUserIds` is the REAL implementation, not a
		// hand-rolled stand-in — a second copy here would encode this file's
		// guess of the override semantics instead of measuring them, and the
		// empty-override case is exactly where a guess goes wrong.
		effectiveContributorUserIds: actual.effectiveContributorUserIds,
		logDraftRefusal: vi.fn(),
		db: {
			publishingTopic: {
				findFirst: (...a: unknown[]) => topicFindFirst(...a),
			},
			// `resolveContributorNames` fences name resolution to the people who
			// still have project access before it reads a single user row. Here
			// everyone submitted passes: what the fence actually admits is pinned
			// in publishing-shared/__tests__/contributor-names.test.ts, and a
			// second opinion about it in this file would be a guess.
			project: {
				findUnique: (...a: unknown[]) => projectFindUnique(...a),
			},
			projectMember: {
				findMany: (...a: unknown[]) => projectMemberFindMany(...a),
			},
			user: { findMany: (...a: unknown[]) => userFindMany(...a) },
		},
		checkPublishingGenerationActor: (...a: unknown[]) =>
			checkPublishingGenerationActor(...a),
		getBoundPromptForAgent: (...a: unknown[]) =>
			getBoundPromptForAgent(...a),
		getPublishingSuiteSettings: (...a: unknown[]) =>
			getPublishingSuiteSettings(...a),
		completePlanningAnalysis: (...a: unknown[]) =>
			completePlanningAnalysis(...a),
		listTopicDecisions: (...a: unknown[]) => listTopicDecisions(...a),
	};
});

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
	contributorsOverridden: false,
	userContributorUserIds: [],
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
	// Both conditional on the activity's OWN project id ("proj-1"), not
	// unconditional: an unconditional mock answers the same way no matter what
	// id the fence asked about, so it cannot tell a correctly-scoped fence from
	// one asked about the wrong project entirely (e.g. `topicId` passed where
	// `projectId` belongs). See "contributor fence scope" below.
	projectFindUnique.mockImplementation(
		async (args: { where: { id: string } }) =>
			args.where.id === "proj-1"
				? { userId: "project-owner", organizationId: null }
				: null,
	);
	projectMemberFindMany.mockImplementation(
		async (args: {
			where: { projectId: string; userId: { in: string[] } };
		}) =>
			args.where.projectId === "proj-1"
				? args.where.userId.in.map((userId) => ({ userId }))
				: [],
	);
	userFindMany.mockResolvedValue([{ id: "user-2", name: "A Contributor" }]);
	checkPublishingGenerationActor.mockResolvedValue({ ok: true });
	getBoundPromptForAgent.mockResolvedValue(null);
	// No settings row is the ordinary case, and it means the default: on.
	getPublishingSuiteSettings.mockResolvedValue(null);
	collectPlanningContext.mockResolvedValue(CONTEXT_RESULT);
	// A topic with no settled decisions is the ordinary case for most of this
	// file; the tests that care supply their own threads.
	listTopicDecisions.mockResolvedValue([]);
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

describe("generatePlanningAnalysisActivity — contributor override", () => {
	// `effectiveContributorUserIds` is the ONLY thing that may decide who the
	// prompt calls a contributor — never `topic.contributorUserIds` directly.
	it("builds the prompt from the override, not the AI list", async () => {
		topicFindFirst.mockResolvedValue({
			...TOPIC,
			contributorUserIds: ["ai-user"],
			contributorsOverridden: true,
			userContributorUserIds: ["chosen-user"],
		});
		userFindMany.mockResolvedValue([
			{ id: "chosen-user", name: "Chosen Contributor" },
		]);

		await run();

		expect(userFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: { in: ["chosen-user"] } },
			}),
		);
		expect(generateObject.mock.calls[0]?.[0]?.prompt).toContain(
			"Chosen Contributor",
		);
	});

	it("yields no contributor names when the override is deliberately empty", async () => {
		// `contributorsOverridden: true` with an empty `userContributorUserIds`
		// is "nobody", not "fall back to the AI list" — the case a hand-rolled
		// mock of `effectiveContributorUserIds` would be most likely to get
		// wrong.
		topicFindFirst.mockResolvedValue({
			...TOPIC,
			contributorUserIds: ["ai-user"],
			contributorsOverridden: true,
			userContributorUserIds: [],
		});

		await run();

		// `resolveContributorNames` short-circuits on an empty list, so the
		// lookup never runs at all.
		expect(userFindMany).not.toHaveBeenCalled();
		expect(generateObject.mock.calls[0]?.[0]?.prompt).not.toContain(
			"People associated with the work behind this topic",
		);
	});
});

describe("generatePlanningAnalysisActivity — contributor fence scope", () => {
	// The mocks above are conditional on "proj-1" precisely so these two can
	// fail: an unconditional `projectFindUnique` / `projectMemberFindMany`
	// answers identically no matter which project id the fence asks about, so
	// swapping `projectId` for `topicId` at the call site would go just as
	// green as the correct call.
	it("resolves contributor names against the activity's OWN project id, not the topic id", async () => {
		await run();

		expect(projectFindUnique.mock.calls[0]?.[0]?.where).toEqual({
			id: "proj-1",
		});
	});

	it("yields no contributor names when the fence is asked about a project it does not recognize", async () => {
		await run({ projectId: "proj-9" });

		expect(userFindMany).not.toHaveBeenCalled();
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

	it("keeps the model's own questions, and mints none for a content type", async () => {
		// A content type is a SETTING now — the checklist on Summary &
		// Questions — so `contentTypes.needsConfirmation` mints nothing, and
		// the only question left here is the model's own. FR39 still holds
		// between the buckets and the question list: an ASSET that requires
		// approval is still derived, because there is no control for it.
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
		expect(bySource).toEqual({ MODEL: "CUSTOMER_NAME" });
		expect(
			new Set(
				content.questions.map(
					(q: { questionId: string }) => q.questionId,
				),
			).size,
		).toBe(1);
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

	it("hands each question's answer options to the reconciliation rows", async () => {
		// FR39's derived approvals are most of what a reader sees on a topic, and
		// every one of them carries two pickable options (`approvalOptions`,
		// `build-planning-analysis-prompt.ts`). The question map below used to
		// omit `answerOptions` entirely (six fields, not seven), so no stored row
		// ever carried options and no option button ever rendered
		// (`TopicQuestionsPanel.tsx:698`, `const options = root.answerOptions ??
		// []`). Worse: the reconcile writer stores `answerOptions ?? Prisma.DbNull`
		// on refresh, so an omitted field does not leave existing options alone —
		// it ERASES them on every regeneration.
		generateObject.mockResolvedValue({
			object: {
				...MODEL_OUTPUT,
				supportingAssets: {
					requiresApproval: [
						{
							type: "the customer logo",
							rationale: "Shown on the slide.",
						},
					],
				},
			},
			usage: { totalTokens: 100 },
		});

		await run();

		const content = completePlanningAnalysis.mock.calls[0]?.[0]?.content;
		const questions =
			completePlanningAnalysis.mock.calls[0]?.[0]?.questions;

		const contentEntry = content.questions.find(
			(q: { decisionKind: string }) =>
				q.decisionKind === "ASSET_APPROVAL",
		);
		// Precondition: if the fixture itself carried no options, the row
		// assertion below would pass vacuously by comparing `null` to `null`.
		expect(contentEntry?.answerOptions).not.toBeNull();
		expect(contentEntry?.answerOptions).toHaveLength(2);

		const row = questions.find(
			(q: { questionId: string }) =>
				q.questionId === contentEntry.questionId,
		);
		// The fixture is the shipped option text, never hand-typed: the row's
		// options must equal the SAME question's options in `content.questions`.
		expect(row?.answerOptions).toEqual(contentEntry.answerOptions);
		expect(row?.answerOptions).toHaveLength(2);
	});

	it("hands the resolved questions to completePlanningAnalysis as reconciliation rows", async () => {
		// This is the single link that makes reconciliation happen at all
		// (`publishing-decisions.ts`): `content.questions` is the analysis's own
		// record of what it raised, but `reconcileTopicQuestions` never sees the
		// content blob — only this separate `questions` argument. Pinned by
		// comparing it against `content.questions` itself (projected down to the
		// fields the DB layer's `ReconcilableQuestion` type takes), so deleting
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
					answerOptions:
						| { text: string; justification: string }[]
						| null;
					whyItMatters: string | null;
				}) => ({
					questionId: q.questionId,
					decisionKind: q.decisionKind,
					subject: q.subject,
					question: q.question,
					recommendedResponse: q.recommendedResponse,
					answerOptions: q.answerOptions,
					whyItMatters: q.whyItMatters,
					foldedQuestions: [],
				}),
			),
		);
		// Guards against a vacuous pass: MODEL_OUTPUT resolves to one question
		// now that a content type is a setting rather than a question, so if
		// the `questions:` argument were ever deleted entirely, `questions`
		// here is `undefined` and this fails loudly rather than `toEqual`
		// quietly comparing two empty arrays.
		expect(questions).toHaveLength(1);
	});

	it("hands every folded list to reconciliation, and an empty one where nothing was folded (Fizzy #1988)", async () => {
		// One run with all four shapes: a question and a blocker something was
		// folded into, and a question and a blocker nothing was folded into.
		generateObject.mockResolvedValue({
			object: {
				...MODEL_OUTPUT,
				recommendedQuestions: [
					{
						decisionKind: "ASSET_APPROVAL",
						subject: "Customer name/logo (example-org)",
						question:
							"Is the Customer name/logo (example-org) approved for use?",
						whyItMatters: "No approval is recorded.",
					},
					{
						decisionKind: "CLAIM_STRENGTH",
						subject: "the retry reduction figure",
						question:
							"May the piece claim the retry reduction as measured?",
					},
				],
				blockers: [
					{
						kind: "MISSING_APPROVAL",
						subject:
							"customer approval to name example-org publicly",
						need: "Someone needs explicit sign-off from example-org to name them publicly.",
					},
					{
						kind: "MISSING_DATA",
						subject: "a confirmed public launch date",
						need: "Get a firm date from the team driving implementation.",
					},
					{
						kind: "MISSING_DATA",
						subject:
							"the confirmed launch date for the public release",
						need: "Confirm the public release date with the team.",
					},
					{
						kind: "MISSING_QUOTE",
						subject: "the problem behind the feature",
						need: "Nobody recorded the motivation.",
					},
				],
			},
			usage: { totalTokens: 100 },
		});

		await run();

		const committed = completePlanningAnalysis.mock.calls[0]?.[0];
		const id = expect.stringMatching(/^[0-9a-f]{32}$/);
		expect(committed.questions).toEqual([
			{
				questionId: id,
				decisionKind: "ASSET_APPROVAL",
				subject: "Customer name/logo (example-org)",
				question:
					"Is the Customer name/logo (example-org) approved for use?",
				recommendedResponse: null,
				answerOptions: null,
				whyItMatters:
					"No approval is recorded.\n\nAnswering this also settles: Someone needs explicit sign-off from example-org to name them publicly.",
				foldedQuestions: [
					"Someone needs explicit sign-off from example-org to name them publicly.",
				],
			},
			{
				questionId: id,
				decisionKind: "CLAIM_STRENGTH",
				subject: "the retry reduction figure",
				question:
					"May the piece claim the retry reduction as measured?",
				recommendedResponse: null,
				answerOptions: null,
				whyItMatters: null,
				foldedQuestions: [],
			},
		]);
		expect(committed.blockers).toEqual([
			{
				questionId: id,
				decisionKind: "MISSING_DATA",
				subject: "a confirmed public launch date",
				question:
					"Get a firm date from the team driving implementation.",
				recommendedResponse: null,
				answerOptions: null,
				whyItMatters:
					"Answering this also settles: Confirm the public release date with the team.",
				foldedQuestions: [
					"Confirm the public release date with the team.",
				],
			},
			{
				questionId: id,
				decisionKind: "MISSING_QUOTE",
				subject: "the problem behind the feature",
				question: "Nobody recorded the motivation.",
				recommendedResponse: null,
				answerOptions: null,
				whyItMatters: null,
				foldedQuestions: [],
			},
		]);
		// The analysis document keeps its shape: the list rides only on the
		// rows. Precondition first — this stored item IS the folded one.
		expect(committed.content.questions[0].whyItMatters).toContain(
			"Answering this also settles:",
		);
		expect(committed.content.questions[0]).not.toHaveProperty(
			"foldedQuestions",
		);
	});

	it("reports SUPERSEDED rather than throwing when the CAS is lost", async () => {
		// The attempt was reclaimed by a deadline sweep while the model ran. Its
		// row is already terminal and a newer attempt owns the topic — writing
		// over that would silently make the older result the current one.
		// A refusal now carries WHICH fence refused. The reasonless shape
		// this used to mock is no longer one the writer can return, and it
		// passed the old assertion while handing the reporter `undefined`.
		completePlanningAnalysis.mockResolvedValue({
			persisted: false,
			reason: "superseded",
		});

		await expect(run()).resolves.toEqual({
			status: "SUPERSEDED",
			refusalReason: "superseded",
		});
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

describe("generatePlanningAnalysisActivity — decisions already settled", () => {
	// WHY. The analysis is re-derived from scratch on every regeneration, and
	// nothing used to carry into it what a member had already answered. So the
	// model re-reached the same decisions in slightly different words, and
	// `deriveQuestionId` — which hashes (kind, subject) precisely so it does NOT
	// collapse two genuinely different subjects — saw new identities and minted
	// new roots beside the answered ones. The owner answered the same decision on
	// four consecutive versions of one topic.

	/** A settled root plus the member reply that settled it. */
	const settledThread = (
		kind: "QUESTION" | "BLOCKER",
		decisionKind: string,
		subject: string,
		answer: string,
	) => ({
		root: {
			kind,
			status: "RESOLVED",
			decisionKind,
			subject,
			summary: "the model's own question, which is never the answer",
		},
		replies: [
			{
				id: "reply-1",
				createdAt: new Date("2026-01-01T00:00:00Z"),
				status: "RESOLVED",
				authorType: "USER",
				content: answer,
			},
		],
	});

	it("carries a settled QUESTION into the prompt", async () => {
		listTopicDecisions.mockResolvedValue([
			settledThread(
				"QUESTION",
				"CUSTOMER_NAME",
				"the customer name",
				"Keep the customer unnamed for now.",
			),
		]);

		await run();

		const prompt = generateObject.mock.calls[0]?.[0]?.prompt as string;
		expect(prompt).toContain("ALREADY settled");
		expect(prompt).toContain("Keep the customer unnamed for now.");
	});

	it("carries a settled BLOCKER into the prompt as well", async () => {
		// The second producer. `reconcileTopicQuestions` runs twice per completed
		// analysis — once over questions, once over blockers — and a blocker root
		// carries kind "BLOCKER", which `settledDecision` refuses. Reading only
		// questions would leave the errand form ("get sign-off to name the
		// customer") coming back after its question form was answered.
		listTopicDecisions.mockResolvedValue([
			settledThread(
				"BLOCKER",
				"MISSING_APPROVAL",
				"sign-off to name the customer",
				"Not needed — the piece will not name anyone.",
			),
		]);

		await run();

		expect(generateObject.mock.calls[0]?.[0]?.prompt).toContain(
			"Not needed — the piece will not name anyone.",
		);
	});

	it("leaves an unanswered question out of the settled block", async () => {
		// POSSIBLY_RESOLVED is what the reconciler writes for a question NOBODY
		// answered when a later analysis stopped raising it. Presenting it as
		// settled would stop the analysis ever asking again for a decision that
		// was never made.
		listTopicDecisions.mockResolvedValue([
			{
				root: {
					kind: "QUESTION",
					status: "POSSIBLY_RESOLVED",
					decisionKind: "CUSTOMER_NAME",
					subject: "the customer name",
					summary: "May we name the customer?",
				},
				replies: [],
			},
		]);

		await run();

		const prompt = generateObject.mock.calls[0]?.[0]?.prompt as string;
		expect(prompt).not.toContain("ALREADY settled");
		expect(prompt).not.toContain("May we name the customer?");
	});

	it("reads the thread scoped to the topic AND the project", async () => {
		// A topic id is a client input everywhere it appears (DV16); every read
		// in this activity re-scopes by project.
		await run();

		expect(listTopicDecisions).toHaveBeenCalledWith({
			topicId: "topic-1",
			projectId: "proj-1",
		});
	});
});

describe("generatePlanningAnalysisActivity — one decision, one item per run", () => {
	// The owner's call: a question and a blocker about the same subject are one
	// decision in two costumes, and nobody answers the same thing twice in one
	// run. The identity key cannot do this — the two producers word the same
	// subject differently on purpose — so the fold is subject-level.

	it("commits one item when a blocker restates a question", async () => {
		generateObject.mockResolvedValue({
			object: {
				...MODEL_OUTPUT,
				recommendedQuestions: [
					{
						decisionKind: "ASSET_APPROVAL",
						subject: "Customer name/logo (example-org)",
						question:
							"Is the Customer name/logo (example-org) approved for use?",
						whyItMatters: "No approval is recorded.",
					},
				],
				blockers: [
					{
						kind: "MISSING_APPROVAL",
						subject:
							"customer approval to name example-org publicly",
						need: "Someone needs explicit sign-off from example-org to name them publicly.",
					},
				],
			},
			usage: { totalTokens: 100 },
		});

		await run();

		const committed = completePlanningAnalysis.mock.calls[0]?.[0];
		expect(committed.blockers).toHaveLength(0);
		expect(committed.questions).toHaveLength(1);
		// FOLDED, not dropped: `blockers` never reaches the stored document, so
		// a discarded one would leave no trace anywhere on the topic.
		expect(committed.questions[0].whyItMatters).toContain(
			"No approval is recorded.",
		);
		expect(committed.questions[0].whyItMatters).toContain(
			"sign-off from example-org",
		);
	});

	it("still commits a blocker the run raised no question about", async () => {
		generateObject.mockResolvedValue({
			object: {
				...MODEL_OUTPUT,
				recommendedQuestions: [],
				blockers: [
					{
						kind: "MISSING_DATA",
						subject: "a confirmed public launch date",
						need: "Get a firm date from the team driving implementation.",
					},
				],
			},
			usage: { totalTokens: 100 },
		});

		await run();

		expect(
			completePlanningAnalysis.mock.calls[0]?.[0]?.blockers,
		).toHaveLength(1);
	});
});
