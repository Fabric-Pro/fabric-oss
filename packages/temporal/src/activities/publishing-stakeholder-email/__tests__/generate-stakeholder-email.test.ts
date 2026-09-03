import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { databaseValueImports } from "../../publishing-shared/__tests__/_ast-guards";

/**
 * The Stakeholder Email LLM activity (Fizzy #1854, Phase 2C-2).
 *
 * The family's established guards are pinned by its siblings; what is specific
 * to this content type, and therefore what most of this file is about, is three
 * things:
 *
 *  1. THE RESTRICTION SPLIT, keyed on this type's own extra set.
 *     `restrictsPostType(thread, "STAKEHOLDER_EMAIL")` matches AUDIENCE_SCOPE
 *     and CLAIM_STRENGTH — questions about framing rather than subjects to omit
 *     — so they must land in `openQuestionSubjects`, never in the "NOT approved
 *     for use" list. And it must NOT match CODEBASE_DETAIL, which the case
 *     study's set does: that is the one difference between the two 2C sets, and
 *     the only case that can tell them apart.
 *  2. NO CLAMP, asserted rather than assumed. The case study lowers three model
 *     claims against the topic's open approvals; this type has nothing to
 *     compare a release claim against, so the activity writes what the model
 *     said. The cases below pin that the stored document is `parsed.data`
 *     unchanged INCLUDING on the fixtures that would trip a naive clamp, so a
 *     later "consistency" fix has to be a deliberate edit here.
 *  3. THE WRITE SURFACE. The card's guarantee is that generating an email
 *     neither publishes anything, nor pushes to a feed, nor creates an asset,
 *     nor mutates a tag, nor SENDS anything. It is asserted as an IMPORT SURFACE
 *     rather than as "these writers were not called": a `not.toHaveBeenCalled()`
 *     on a name the module never imports cannot distinguish any two
 *     implementations. The set below fails the moment any new `@repo/database`
 *     writer is pulled in, whatever it is called — a mail sender included.
 *
 * `@repo/utils/publishing-restrictions` is deliberately NOT mocked. The whole
 * question in (1) is which real predicate routes which real decision kind, and
 * a stubbed predicate would encode this file's guess about that instead of
 * measuring it.
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
const analysisFindFirst = vi.fn();
const userFindMany = vi.fn();
const checkPublishingGenerationActor = vi.fn();
const getBoundPromptForAgent = vi.fn();
const listTopicDecisions = vi.fn();
const completeTopicDraft = vi.fn();
const seedWorkingDraftIfAbsent = vi.fn();
vi.mock("@repo/database", () => ({
	db: {
		publishingTopic: {
			findFirst: (...a: unknown[]) => topicFindFirst(...a),
		},
		publishingTopicPlanningAnalysis: {
			findFirst: (...a: unknown[]) => analysisFindFirst(...a),
		},
		user: { findMany: (...a: unknown[]) => userFindMany(...a) },
	},
	checkPublishingGenerationActor: (...a: unknown[]) =>
		checkPublishingGenerationActor(...a),
	getBoundPromptForAgent: (...a: unknown[]) => getBoundPromptForAgent(...a),
	listTopicDecisions: (...a: unknown[]) => listTopicDecisions(...a),
	completeTopicDraft: (...a: unknown[]) => completeTopicDraft(...a),
	seedWorkingDraftIfAbsent: (...a: unknown[]) =>
		seedWorkingDraftIfAbsent(...a),
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const collectPlanningContext = vi.fn();
vi.mock("../../publishing-planning/collect-planning-context", () => ({
	collectPlanningContext: (...a: unknown[]) => collectPlanningContext(...a),
}));

import { generateStakeholderEmailActivity } from "../generate-stakeholder-email";

const trackUsage = vi.fn();

const TOPIC = {
	id: "topic-1",
	title: "Faster incremental builds",
	pitch: "Builds now reuse a warm cache.",
	angle: "delivery velocity",
	subject: "build caching",
	relevantFunctionTags: ["BACKEND"],
	postTypeRecommendations: [],
	contributorUserIds: ["user-2"],
	provenance: {},
};

const MODEL_OUTPUT = {
	subject: "Build times are down for the platform team",
	body: "Hi team,\n\nWe finished the warm-cache work this week.\n\nThanks,\nDelivery",
	audience: "Internal leadership",
	releaseStatus: "SHIPPED",
	inputsNeeded: [],
	safetyNote: null,
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

/** An OPEN question thread of one decision kind. */
function openQuestion(decisionKind: string, subject: string | null = null) {
	return {
		root: {
			kind: "QUESTION",
			status: "OPEN",
			decisionKind,
			subject,
			summary: null,
		},
		replies: [],
	};
}

/** An ANSWERED question thread, which is an instruction rather than a limit. */
function answeredQuestion(
	decisionKind: string,
	subject: string,
	answer: string,
) {
	return {
		root: {
			kind: "QUESTION",
			status: "RESOLVED",
			decisionKind,
			subject,
			summary: null,
		},
		replies: [{ authorType: "USER", content: answer }],
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	topicFindFirst.mockResolvedValue(TOPIC);
	analysisFindFirst.mockResolvedValue(null);
	userFindMany.mockResolvedValue([{ id: "user-2", name: "A Contributor" }]);
	checkPublishingGenerationActor.mockResolvedValue({ ok: true });
	getBoundPromptForAgent.mockResolvedValue(null);
	listTopicDecisions.mockResolvedValue([]);
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
	completeTopicDraft.mockResolvedValue({ persisted: true });
	seedWorkingDraftIfAbsent.mockResolvedValue({ status: "seeded" });
});

const run = (overrides: Record<string, unknown> = {}) =>
	generateStakeholderEmailActivity({
		draftId: "draft-1",
		topicId: "topic-1",
		projectId: "proj-1",
		organizationId: "org-1",
		actorUserId: "user-1",
		guidance: null,
		...overrides,
	});

/** The document as it was written, minus the generation metadata. */
const persistedContent = () => completeTopicDraft.mock.calls[0]?.[0]?.content;

describe("generateStakeholderEmailActivity — tenancy and actor revalidation", () => {
	it("re-scopes the topic read by projectId", async () => {
		await run();

		expect(topicFindFirst.mock.calls[0]?.[0]?.where).toEqual({
			id: "topic-1",
			projectId: "proj-1",
		});
	});

	it("fails closed when the topic does not resolve inside the project", async () => {
		// DV16: a real topic id belonging to another project must be
		// indistinguishable from a deleted one.
		topicFindFirst.mockResolvedValue(null);

		await expect(run()).rejects.toMatchObject({
			type: "PUBLISHING_TENANT_MISMATCH",
			nonRetryable: true,
		});
		expect(getAIModelWithMetadata).not.toHaveBeenCalled();
	});

	it("never reaches the model factory when the actor is no longer authorized", async () => {
		// The second assertion is the one that matters. Throwing is easy to get
		// right by accident; what this guard exists for is that no model is
		// resolved and no source collected under a revoked collaborator's
		// identity, and only "the factory was never called" proves the check
		// runs BEFORE resolution rather than beside it.
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
		expect(checkPublishingGenerationActor).toHaveBeenCalledWith({
			projectId: "proj-1",
			organizationId: null,
			actorUserId: "user-1",
		});
		expect(getAIModelWithMetadata).not.toHaveBeenCalled();
	});

	it("passes a null organization through to prompt resolution", async () => {
		// Kept from the case this block replaced: `organizationId ?? undefined`
		// is load-bearing in `getBoundPromptForAgent`, and nothing else pins it.
		await run({ organizationId: null });

		expect(getBoundPromptForAgent.mock.calls[0]?.[0]?.organizationId).toBe(
			undefined,
		);
	});

	it("resolves the stakeholder email's own bound prompt", async () => {
		// The agent key is spelled in four places (seed prompt, seed binding,
		// catalog, here) and a mismatch resolves NO binding, falls back to the
		// default body forever, and looks entirely normal in the output.
		await run();

		expect(getBoundPromptForAgent).toHaveBeenCalledWith(
			expect.objectContaining({
				agentName: "publishing_topic_stakeholder_email",
				documentType: "GENERAL",
				userId: "user-1",
				organizationId: "org-1",
			}),
		);
	});

	it("bills the run under its own job type", async () => {
		await run();

		expect(getAIModelWithMetadata).toHaveBeenCalledWith(
			{ taskType: "COMPLEX" },
			expect.objectContaining({
				jobType: "publishing-stakeholder-email",
			}),
		);
	});
});

describe("generateStakeholderEmailActivity — the restriction split", () => {
	it("routes a shared safety-critical kind into the NOT-approved block", async () => {
		listTopicDecisions.mockResolvedValue([
			openQuestion("CUSTOMER_NAME", "example-org"),
		]);

		await run();

		const prompt = generateObject.mock.calls[0]?.[0]?.prompt as string;
		const restricted = prompt.slice(
			prompt.indexOf("## Unresolved approvals for this topic"),
		);
		expect(restricted).toContain("example-org");
		expect(prompt).not.toMatch(
			/Open questions that constrain this content type/,
		);
	});

	it("routes an AUDIENCE_SCOPE thread into openQuestionSubjects for STAKEHOLDER_EMAIL", async () => {
		// `isRestrictingThread` returns FALSE for AUDIENCE_SCOPE — it is not a
		// kind that constrains every content type. Only
		// `restrictsPostType(thread, "STAKEHOLDER_EMAIL")` sees it, and this
		// case is what proves the activity calls the per-type predicate with
		// THIS type rather than the shared one or a neighbour's.
		listTopicDecisions.mockResolvedValue([
			openQuestion("AUDIENCE_SCOPE", "who this update is addressed to"),
		]);

		await run();

		const prompt = generateObject.mock.calls[0]?.[0]?.prompt as string;
		const openHeading = prompt.indexOf(
			"## Open questions that constrain this content type",
		);
		expect(openHeading).toBeGreaterThan(-1);
		expect(prompt.slice(openHeading)).toContain(
			"who this update is addressed to",
		);
		expect(prompt).not.toMatch(/Unresolved approvals for this topic/);
	});

	it("routes a CLAIM_STRENGTH thread there too", async () => {
		listTopicDecisions.mockResolvedValue([
			openQuestion("CLAIM_STRENGTH", "the build-time number"),
		]);

		await run();

		const prompt = generateObject.mock.calls[0]?.[0]?.prompt as string;
		const openHeading = prompt.indexOf(
			"## Open questions that constrain this content type",
		);
		expect(openHeading).toBeGreaterThan(-1);
		expect(prompt.slice(openHeading)).toContain("the build-time number");
	});

	it("IGNORES a CODEBASE_DETAIL thread, which the case study restricts on", async () => {
		// THE case that tells the two 2C extra sets apart. An activity that
		// passed "CASE_STUDY" to `restrictsPostType` — the likeliest mistake
		// when this file is copied from its sibling — would list this question
		// under open questions and pass every other case in this describe.
		listTopicDecisions.mockResolvedValue([
			openQuestion("CODEBASE_DETAIL", "how much of the resolver to show"),
		]);

		await run();

		const prompt = generateObject.mock.calls[0]?.[0]?.prompt as string;
		expect(prompt).not.toMatch(
			/Open questions that constrain this content type/,
		);
		expect(prompt).not.toMatch(/Unresolved approvals for this topic/);
		expect(prompt).not.toContain("how much of the resolver to show");
		expect(persistedContent().generation.openQuestionSubjects).toEqual([]);
	});

	it("keeps an AUDIENCE_SCOPE thread out of the NOT-approved block", async () => {
		// Putting it there would instruct the model to strip the audience
		// framing — on a message that is addressed to somebody, the opposite of
		// caution.
		listTopicDecisions.mockResolvedValue([
			openQuestion("CUSTOMER_NAME", "example-org"),
			openQuestion("AUDIENCE_SCOPE", "who this is written for"),
		]);

		await run();

		const prompt = generateObject.mock.calls[0]?.[0]?.prompt as string;
		const restrictedHeading = prompt.indexOf(
			"## Unresolved approvals for this topic",
		);
		const openHeading = prompt.indexOf(
			"## Open questions that constrain this content type",
		);
		expect(restrictedHeading).toBeGreaterThan(-1);
		expect(openHeading).toBeGreaterThan(restrictedHeading);
		expect(prompt.slice(restrictedHeading, openHeading)).not.toContain(
			"who this is written for",
		);
		expect(prompt.slice(openHeading)).toContain("who this is written for");
	});

	it("records restricted subjects as {kind, label} objects, not bare strings", async () => {
		// A stored draft has to be able to say WHICH rule set was in force. A
		// later change to SAFETY_CRITICAL_KINDS would otherwise silently
		// reinterpret every draft already on disk.
		listTopicDecisions.mockResolvedValue([
			openQuestion("METRICS_APPROVAL", "the adoption number"),
			openQuestion("AUDIENCE_SCOPE", "who this is written for"),
		]);

		await run();

		const generation = persistedContent().generation;
		expect(generation.restrictedSubjects).toEqual([
			{ kind: "METRICS_APPROVAL", label: "the adoption number" },
		]);
		expect(generation.openQuestionSubjects).toEqual([
			"who this is written for",
		]);
	});

	it("treats an ANSWERED question as an instruction, not a restriction", async () => {
		// An answered decision is not a limit — counting one would make the
		// warning permanent and teach its reader to ignore it.
		listTopicDecisions.mockResolvedValue([
			answeredQuestion(
				"AUDIENCE_SCOPE",
				"who this is written for",
				"The steering group.",
			),
		]);

		await run();

		const prompt = generateObject.mock.calls[0]?.[0]?.prompt as string;
		expect(prompt).not.toMatch(
			/Open questions that constrain this content type/,
		);
		expect(prompt).toContain("The steering group.");
		expect(persistedContent().generation.openQuestionSubjects).toEqual([]);
	});
});

describe("generateStakeholderEmailActivity — release status is NOT clamped", () => {
	/**
	 * The case study clamps three model claims against the topic's open
	 * approvals, because the claim and the thread name the same thing. Nothing
	 * here does, and the activity's header explains why: Fabric's decision
	 * vocabulary has no kind that asks whether the work shipped, and neither the
	 * topic row nor the collected context carries a release state. A clamp built
	 * on `CLAIM_STRENGTH` — the nearest-looking kind — would demote correctly
	 * SHIPPED emails on any topic with an open question about a number, which is
	 * most of them.
	 *
	 * These cases pin that absence on the fixtures a naive clamp would trip, so
	 * adding one later is a deliberate edit here rather than a silent behaviour
	 * change. They are NOT an argument that a clamp would be wrong in principle:
	 * if a `RELEASE_STATUS` decision kind is ever added, this describe is the
	 * first thing that should go red.
	 */
	it("stores SHIPPED unchanged with an open CLAIM_STRENGTH question", async () => {
		generateObject.mockResolvedValue({
			object: { ...MODEL_OUTPUT, releaseStatus: "SHIPPED" },
			usage: {},
		});
		listTopicDecisions.mockResolvedValue([
			openQuestion("CLAIM_STRENGTH", "the build-time number"),
		]);

		await run();

		expect(persistedContent().releaseStatus).toBe("SHIPPED");
	});

	it("stores SHIPPED unchanged with an open CUSTOMER_NAME question", async () => {
		// The nearest thing to a comparable thread, and it still says nothing
		// about whether the work is live.
		generateObject.mockResolvedValue({
			object: { ...MODEL_OUTPUT, releaseStatus: "SHIPPED" },
			usage: {},
		});
		listTopicDecisions.mockResolvedValue([
			openQuestion("CUSTOMER_NAME", "example-org"),
		]);

		await run();

		expect(persistedContent().releaseStatus).toBe("SHIPPED");
	});

	it("writes NO clamped record at all, so nothing can render an empty check as a passed one", async () => {
		// Deliberately not `clamped: {}`. An always-empty record invites a panel
		// to read "no clamps fired" as "a check ran and found nothing", which is
		// the false reassurance this content type must not give — no check runs.
		listTopicDecisions.mockResolvedValue([
			openQuestion("CUSTOMER_NAME", "example-org"),
			openQuestion("CLAIM_STRENGTH", "the build-time number"),
		]);

		await run();

		expect(persistedContent().generation).not.toHaveProperty("clamped");
	});

	it("stores the model's audience and safety note verbatim", async () => {
		generateObject.mockResolvedValue({
			object: {
				...MODEL_OUTPUT,
				audience: "The client steering group",
				safetyNote: "Generalized the customer reference.",
			},
			usage: {},
		});

		await run();

		expect(persistedContent().audience).toBe("The client steering group");
		expect(persistedContent().safetyNote).toBe(
			"Generalized the customer reference.",
		);
	});

	it("keeps a null audience null rather than inventing one", async () => {
		generateObject.mockResolvedValue({
			object: { ...MODEL_OUTPUT, audience: null },
			usage: {},
		});

		await run();

		expect(persistedContent().audience).toBeNull();
	});

	it("seeds through the SHARED composer, carrying the subject into the body", async () => {
		// What this pins is that the body comes from
		// `composeStakeholderEmailWorkingDraftBody` in `@repo/utils` — the same
		// function `@repo/api` re-composes an adopted version with — rather than
		// a local join that would drift away from it, which is exactly what
		// happened to the Blog Post sibling. The headings are the PO's own, so
		// the assertion is also the format contract.
		generateObject.mockResolvedValue({
			object: {
				...MODEL_OUTPUT,
				subject: "An email subject",
				body: "Hi team,\n\nAn update.",
			},
			usage: {},
		});

		await run();

		expect(seedWorkingDraftIfAbsent).toHaveBeenCalledWith(
			expect.objectContaining({
				postType: "STAKEHOLDER_EMAIL",
				sourceDraftId: "draft-1",
				updatedById: "user-1",
				body: "## Subject\n\nAn email subject\n\n## Email Draft\n\nHi team,\n\nAn update.",
			}),
		);
	});

	it("leaves the advice fields OUT of the seeded body", async () => {
		// They are advice about the draft. A body carrying them is a body whose
		// author deletes three sections before pasting it into a mail client.
		generateObject.mockResolvedValue({
			object: {
				...MODEL_OUTPUT,
				audience: "Internal leadership",
				releaseStatus: "UNCONFIRMED",
				inputsNeeded: ["Confirm the release date"],
				safetyNote: "Generalized the customer reference.",
			},
			usage: {},
		});

		await run();

		const seeded = seedWorkingDraftIfAbsent.mock.calls[0]?.[0]
			?.body as string;
		expect(seeded).not.toContain("Internal leadership");
		expect(seeded).not.toContain("UNCONFIRMED");
		expect(seeded).not.toContain("Confirm the release date");
		expect(seeded).not.toContain("Generalized the customer reference.");
	});
});

// `databaseValueImports` now lives in `publishing-shared/__tests__` — the
// authorization read moved into `assert-generation-actor.ts`, which needs
// the same guard, and the walker does not follow imports.

describe("generateStakeholderEmailActivity — the write surface", () => {
	// The card's guarantee: generating a stakeholder email publishes nothing,
	// pushes nothing to a feed, creates no asset, mutates no tag — and, on this
	// content type specifically, SENDS nothing. It writes a draft.
	//
	// Asserted as the module's `@repo/database` import list, read off the AST,
	// because that is the only formulation that can FAIL. A
	// `not.toHaveBeenCalled()` on a helper the module never imports is true of
	// every possible implementation — including one that sends mail — so it
	// distinguishes nothing. This set does: pulling in ANY additional database
	// helper turns it red, whether it is a publisher, a feed writer, a delivery
	// ledger writer or another working-draft writer, and whether or not this
	// file thought to name it.
	//
	// Widening the list is allowed. It just has to be a deliberate edit here,
	// with the new name justified against the guarantee above.
	it("imports ONLY the reads and the two writes the guarantee allows", () => {
		expect(
			databaseValueImports(
				join(__dirname, "../generate-stakeholder-email.ts"),
			),
		).toEqual([
			// The two writes. `completeTopicDraft` finishes the row this run
			// already owns; `seedWorkingDraftIfAbsent` is create-only by
			// construction, which is what makes FR35 hold without a condition
			// here having to be right.
			"completeTopicDraft",
			// Reads.
			"db",
			"getBoundPromptForAgent",
			"listTopicDecisions",
			"seedWorkingDraftIfAbsent",
		]);
	});

	it("uses the create-only seed on the happy path", async () => {
		await run();

		expect(seedWorkingDraftIfAbsent).toHaveBeenCalledTimes(1);
	});

	it("reports no seeding when the topic already has a draft", async () => {
		// The regeneration path — the one where a careless "just update it"
		// would silently overwrite an author's edits (FR35). The activity does
		// not choose here: the helper refuses, and the status comes back.
		seedWorkingDraftIfAbsent.mockResolvedValue({
			status: "already_exists",
		});

		const result = await run();

		expect(result).toEqual({ status: "READY", seededWorkingDraft: false });
	});

	it("writes nothing at all when the output fails schema validation", async () => {
		// `releaseStatus` is required and has no safe default. A run that cannot
		// produce a valid shape will not produce one on a retry either, and a
		// half-shaped email persisted as READY is worse than a visible failure.
		generateObject.mockResolvedValue({
			object: { subject: "A subject", body: "Hi team," },
			usage: {},
		});

		await expect(run()).rejects.toMatchObject({
			type: "PUBLISHING_STAKEHOLDER_EMAIL_SCHEMA_VALIDATION_FAILED",
			nonRetryable: true,
		});
		expect(completeTopicDraft).not.toHaveBeenCalled();
		expect(seedWorkingDraftIfAbsent).not.toHaveBeenCalled();
	});

	it("rejects a whitespace-only subject instead of seeding a headless draft", async () => {
		// `min(1)` alone accepts "   ", and the run would then SUCCEED, seed a
		// "## Subject" heading followed by nothing, and make the panel's
		// document null — every safety surface gone while the editor still
		// showed text, and adopt throwing forever on a draft the server itself
		// wrote. A visible failure is strictly better.
		generateObject.mockResolvedValue({
			object: { ...MODEL_OUTPUT, subject: "   " },
			usage: {},
		});

		await expect(run()).rejects.toMatchObject({
			type: "PUBLISHING_STAKEHOLDER_EMAIL_SCHEMA_VALIDATION_FAILED",
			nonRetryable: true,
		});
		expect(completeTopicDraft).not.toHaveBeenCalled();
		expect(seedWorkingDraftIfAbsent).not.toHaveBeenCalled();
	});

	it("rejects a release status outside the five, rather than storing it", async () => {
		// The panel falls back to UNCONFIRMED on an unreadable value, which is
		// the right READ behaviour — but a WRITE that accepted "PROBABLY_LIVE"
		// would leave a row whose stored claim and rendered claim disagree.
		generateObject.mockResolvedValue({
			object: { ...MODEL_OUTPUT, releaseStatus: "PROBABLY_LIVE" },
			usage: {},
		});

		await expect(run()).rejects.toMatchObject({
			type: "PUBLISHING_STAKEHOLDER_EMAIL_SCHEMA_VALIDATION_FAILED",
			nonRetryable: true,
		});
		expect(completeTopicDraft).not.toHaveBeenCalled();
	});

	it("does not seed after a lost CAS, and reports SUPERSEDED rather than throwing", async () => {
		completeTopicDraft.mockResolvedValue({ persisted: false });

		await expect(run()).resolves.toEqual({
			status: "SUPERSEDED",
			seededWorkingDraft: false,
		});
		expect(seedWorkingDraftIfAbsent).not.toHaveBeenCalled();
	});
});

describe("generateStakeholderEmailActivity — what it persists", () => {
	it("reports READY and a seeded draft on the happy path", async () => {
		await expect(run()).resolves.toEqual({
			status: "READY",
			seededWorkingDraft: true,
		});
	});

	it("persists the draft, its source refs and the model", async () => {
		await run();

		expect(completeTopicDraft).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "draft-1",
				projectId: "proj-1",
				model: "test-model",
				sourceRefs: CONTEXT_RESULT.sourceRefs,
				promptSource: "DEFAULT_UNBOUND",
			}),
		);
	});

	it("records DEFAULT_RENDER_FAILED when a bound body renders to nothing", async () => {
		// The one fact about a run that cannot be recovered from its output: an
		// email built from the default body because the bound prompt would not
		// render reads exactly like one built from the bound prompt.
		getBoundPromptForAgent.mockResolvedValue({
			id: "p-1",
			format: "HANDLEBARS",
			version: { content: "   ", version: 3 },
		});

		await run();

		expect(completeTopicDraft.mock.calls[0]?.[0]?.promptSource).toBe(
			"DEFAULT_RENDER_FAILED",
		);
	});

	it("records BOUND and uses the bound body", async () => {
		getBoundPromptForAgent.mockResolvedValue({
			id: "p-1",
			format: "HANDLEBARS",
			version: { content: "Write up {{{topic_title}}}.", version: 2 },
		});

		await run();

		expect(completeTopicDraft.mock.calls[0]?.[0]?.promptSource).toBe(
			"BOUND",
		);
		expect(generateObject.mock.calls[0]?.[0]?.prompt).toContain(
			"Faster incremental builds",
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

	it("carries the run's guidance onto the stored draft", async () => {
		await run({ guidance: "Address it to the steering group." });

		expect(persistedContent().generation.guidance).toBe(
			"Address it to the steering group.",
		);
	});
});

describe("generateStakeholderEmailActivity — the model call", () => {
	it("disables strict JSON schema", async () => {
		// Azure/OpenAI reject a strict JSON schema containing optional fields
		// outright (bug #1681), and this schema has several.
		await run();

		expect(generateObject.mock.calls[0]?.[0]?.providerOptions).toEqual({
			openai: { strictJsonSchema: false },
		});
	});

	it("tracks usage", async () => {
		await run();
		expect(trackUsage).toHaveBeenCalled();
	});

	it("bounds the generation against the full prompt it is about to send", async () => {
		// The FULL prompt, role clause included — the clamp exists to reserve
		// context-window room for the input, so measuring anything shorter than
		// what is actually sent would under-reserve.
		getProjectFunctionTagClause.mockResolvedValue(
			"ROLE COMPOSITION: backend",
		);

		await run();

		const sentPrompt = generateObject.mock.calls[0]?.[0]?.prompt as string;
		expect(computeMaxOutputTokenBudget).toHaveBeenCalledWith(
			expect.anything(),
			{ promptChars: sentPrompt.length },
		);
	});

	it("omits maxOutputTokens entirely when the helper declines to set one", async () => {
		// `undefined` is a real answer: some providers must NOT be sent an
		// explicit budget, and `maxOutputTokens: undefined` is not the same as
		// omitting the key for every SDK that forwards its own request body.
		computeMaxOutputTokenBudget.mockReturnValue(undefined);

		await run();

		expect(generateObject.mock.calls[0]?.[0]).not.toHaveProperty(
			"maxOutputTokens",
		);
	});
});
