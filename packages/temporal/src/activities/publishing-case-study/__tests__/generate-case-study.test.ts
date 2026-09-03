import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Case Study LLM activity (Fizzy #1854, Phase 2C).
 *
 * The family's established guards are pinned by its siblings; what is NEW in 2C,
 * and therefore what most of this file is about, is three things:
 *
 *  1. THE RESTRICTION SPLIT. `restrictsPostType(thread, "CASE_STUDY")` matches
 *     three kinds no other content type restricts, and those are questions about
 *     framing rather than subjects to omit — so they must land in
 *     `openQuestionSubjects`, never in the "NOT approved for use" list.
 *  2. THE CLAMP. `customerIdentity`, `metricsBasis` and `confirmedAssets` are
 *     MODEL claims a downstream reader trusts without re-reading the narrative.
 *     Two enum transitions are corrected against the topic's open approvals and
 *     a claimed-confirmed asset an open approval is about is demoted; the two
 *     TERMINAL SAFE STATES must survive untouched, nothing is ever upgraded,
 *     and an UNRELATED confirmed asset must survive — a clamp that fires on
 *     everything is one its reader learns to ignore.
 *  3. THE WRITE SURFACE. The card's guarantee is that generating a case study
 *     neither publishes anything, nor pushes to a feed, nor creates an asset,
 *     nor mutates a tag. It is asserted as an IMPORT SURFACE rather than as
 *     "these two writers were not called": a `not.toHaveBeenCalled()` on a name
 *     the module never imports cannot distinguish any two implementations, and
 *     the pair originally named there (`saveWorkingDraft`,
 *     `updateWorkingDraftBody`) were both working-draft writers — so even a
 *     truthful version of that assertion would not have covered publishing,
 *     feeds, assets or tags at all. The set below fails the moment any new
 *     `@repo/database` writer is pulled in, whatever it is called.
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
const isCurrentOrgMember = vi.fn();
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
	isCurrentOrgMember: (...a: unknown[]) => isCurrentOrgMember(...a),
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

import { generateCaseStudyActivity } from "../generate-case-study";

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
	title: "Faster incremental builds at an enterprise customer",
	body: "## Executive Summary\n\nBuilds used to start cold.",
	customerIdentity: "ANONYMIZED",
	metricsBasis: "QUALITATIVE",
	isScaffold: false,
	confirmedAssets: [],
	assetsNeedingConfirmation: ["customer logo"],
	categories: ["Toolchain"],
	keywords: ["ci-pipeline"],
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
	isCurrentOrgMember.mockResolvedValue(true);
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
	generateCaseStudyActivity({
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

describe("generateCaseStudyActivity — tenancy and actor revalidation", () => {
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

	it("never reaches the model factory when the actor lost org access", async () => {
		// The second assertion is the one that matters: org model resolution
		// PREFERS the actor's personal provider, so only "the factory was never
		// called" proves the check runs BEFORE resolution rather than beside it.
		isCurrentOrgMember.mockResolvedValue(false);

		await expect(run()).rejects.toMatchObject({
			type: "PUBLISHING_ACTOR_INVALID",
			nonRetryable: true,
		});
		expect(getAIModelWithMetadata).not.toHaveBeenCalled();
		expect(generateObject).not.toHaveBeenCalled();
	});

	it("skips the membership check for a personal project", async () => {
		await run({ organizationId: null });

		expect(isCurrentOrgMember).not.toHaveBeenCalled();
		expect(getBoundPromptForAgent.mock.calls[0]?.[0]?.organizationId).toBe(
			undefined,
		);
	});

	it("resolves the case study's own bound prompt", async () => {
		await run();

		expect(getBoundPromptForAgent).toHaveBeenCalledWith(
			expect.objectContaining({
				agentName: "publishing_topic_case_study",
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
			expect.objectContaining({ jobType: "publishing-case-study" }),
		);
	});
});

describe("generateCaseStudyActivity — the restriction split", () => {
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

	it("routes a CLAIM_STRENGTH thread into openQuestionSubjects for CASE_STUDY", async () => {
		// `isRestrictingThread` returns FALSE for CLAIM_STRENGTH — it is not a
		// kind that constrains every content type. Only
		// `restrictsPostType(thread, "CASE_STUDY")` sees it, and this case is
		// what proves the activity calls the per-type predicate rather than the
		// shared one.
		listTopicDecisions.mockResolvedValue([
			openQuestion("CLAIM_STRENGTH", "the latency result"),
		]);

		await run();

		const prompt = generateObject.mock.calls[0]?.[0]?.prompt as string;
		const openHeading = prompt.indexOf(
			"## Open questions that constrain this content type",
		);
		expect(openHeading).toBeGreaterThan(-1);
		expect(prompt.slice(openHeading)).toContain("the latency result");
		expect(prompt).not.toMatch(/Unresolved approvals for this topic/);
	});

	it("keeps an AUDIENCE_SCOPE thread out of the NOT-approved block", async () => {
		// Putting it there would instruct the model to strip the audience
		// framing — on this content type, the opposite of caution.
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
			openQuestion("CODEBASE_DETAIL", "how much of the resolver to show"),
		]);

		await run();

		const generation = persistedContent().generation;
		expect(generation.restrictedSubjects).toEqual([
			{ kind: "METRICS_APPROVAL", label: "the adoption number" },
		]);
		expect(generation.openQuestionSubjects).toEqual([
			"how much of the resolver to show",
		]);
	});

	it("treats an ANSWERED question as an instruction, not a restriction", async () => {
		// An answered decision is not a limit — counting one would make the
		// warning permanent and teach its reader to ignore it.
		listTopicDecisions.mockResolvedValue([
			answeredQuestion(
				"CUSTOMER_NAME",
				"example-org",
				"Yes, we may name them.",
			),
		]);

		await run();

		const prompt = generateObject.mock.calls[0]?.[0]?.prompt as string;
		expect(prompt).not.toMatch(/Unresolved approvals for this topic/);
		expect(prompt).toContain("Yes, we may name them.");
		expect(persistedContent().generation.restrictedSubjects).toEqual([]);
	});
});

describe("generateCaseStudyActivity — the clamp", () => {
	it("lowers APPROVED to APPROVAL_NEEDED when a CUSTOMER_NAME question is open", async () => {
		generateObject.mockResolvedValue({
			object: { ...MODEL_OUTPUT, customerIdentity: "APPROVED" },
			usage: {},
		});
		listTopicDecisions.mockResolvedValue([
			openQuestion("CUSTOMER_NAME", "example-org"),
		]);

		await run();

		expect(persistedContent().customerIdentity).toBe("APPROVAL_NEEDED");
		expect(persistedContent().generation.clamped).toEqual({
			customerIdentity: "CUSTOMER_NAME",
		});
	});

	it("lowers CONFIRMED to PLACEHOLDER when a METRICS_APPROVAL question is open", async () => {
		generateObject.mockResolvedValue({
			object: { ...MODEL_OUTPUT, metricsBasis: "CONFIRMED" },
			usage: {},
		});
		listTopicDecisions.mockResolvedValue([
			openQuestion("METRICS_APPROVAL", "the adoption number"),
		]);

		await run();

		expect(persistedContent().metricsBasis).toBe("PLACEHOLDER");
		expect(persistedContent().generation.clamped).toEqual({
			metricsBasis: "METRICS_APPROVAL",
		});
	});

	it("leaves ANONYMIZED untouched — it is a TERMINAL SAFE STATE", async () => {
		// Two reasons, and both are about what the author is told. Clamping this
		// would say a correctly-generalized draft is blocked on an approval it
		// does not need; and it would erase the only signal separating "the
		// model complied with the locked clause" from "the model ignored it",
		// because both outcomes would then store APPROVAL_NEEDED.
		generateObject.mockResolvedValue({
			object: { ...MODEL_OUTPUT, customerIdentity: "ANONYMIZED" },
			usage: {},
		});
		listTopicDecisions.mockResolvedValue([
			openQuestion("CUSTOMER_NAME", "example-org"),
		]);

		await run();

		expect(persistedContent().customerIdentity).toBe("ANONYMIZED");
		expect(persistedContent().generation.clamped).toEqual({});
	});

	it("leaves QUALITATIVE untouched — it is a TERMINAL SAFE STATE", async () => {
		// The draft asserted no number. There is nothing for a metrics approval
		// to unblock, and marking it PLACEHOLDER would send its author looking
		// for a number they deliberately did not use.
		generateObject.mockResolvedValue({
			object: { ...MODEL_OUTPUT, metricsBasis: "QUALITATIVE" },
			usage: {},
		});
		listTopicDecisions.mockResolvedValue([
			openQuestion("METRICS_APPROVAL", "the adoption number"),
		]);

		await run();

		expect(persistedContent().metricsBasis).toBe("QUALITATIVE");
		expect(persistedContent().generation.clamped).toEqual({});
	});

	it("never UPGRADES APPROVAL_NEEDED to APPROVED when nothing is open", async () => {
		// The clamp only ever lowers. The model saw the narrative; the absence
		// of an open question is not evidence that the story stopped needing an
		// approval.
		generateObject.mockResolvedValue({
			object: { ...MODEL_OUTPUT, customerIdentity: "APPROVAL_NEEDED" },
			usage: {},
		});
		listTopicDecisions.mockResolvedValue([]);

		await run();

		expect(persistedContent().customerIdentity).toBe("APPROVAL_NEEDED");
		expect(persistedContent().generation.clamped).toEqual({});
	});

	it("never UPGRADES PLACEHOLDER to CONFIRMED when nothing is open", async () => {
		generateObject.mockResolvedValue({
			object: { ...MODEL_OUTPUT, metricsBasis: "PLACEHOLDER" },
			usage: {},
		});
		listTopicDecisions.mockResolvedValue([]);

		await run();

		expect(persistedContent().metricsBasis).toBe("PLACEHOLDER");
	});

	it("leaves APPROVED standing when the open question is a DIFFERENT kind", async () => {
		// The clamp is keyed on the specific approval, not on "is anything
		// unresolved". An open codebase-detail question says nothing about
		// whether the customer may be named.
		generateObject.mockResolvedValue({
			object: {
				...MODEL_OUTPUT,
				customerIdentity: "APPROVED",
				metricsBasis: "CONFIRMED",
			},
			usage: {},
		});
		listTopicDecisions.mockResolvedValue([
			openQuestion("CODEBASE_DETAIL", "how much of the resolver to show"),
		]);

		await run();

		expect(persistedContent().customerIdentity).toBe("APPROVED");
		expect(persistedContent().metricsBasis).toBe("CONFIRMED");
		expect(persistedContent().generation.clamped).toEqual({});
	});

	it("clamps both fields independently in one run", async () => {
		generateObject.mockResolvedValue({
			object: {
				...MODEL_OUTPUT,
				customerIdentity: "APPROVED",
				metricsBasis: "CONFIRMED",
			},
			usage: {},
		});
		listTopicDecisions.mockResolvedValue([
			openQuestion("CUSTOMER_NAME", "example-org"),
			openQuestion("METRICS_APPROVAL", "the adoption number"),
		]);

		await run();

		expect(persistedContent().customerIdentity).toBe("APPROVAL_NEEDED");
		expect(persistedContent().metricsBasis).toBe("PLACEHOLDER");
		expect(persistedContent().generation.clamped).toEqual({
			customerIdentity: "CUSTOMER_NAME",
			metricsBasis: "METRICS_APPROVAL",
		});
	});

	it("demotes a claimed-confirmed asset an OPEN approval is about", async () => {
		// `confirmedAssets` is a STRONGER publication claim than either enum
		// above — the panel renders it as cleared for use — and it was the one
		// the clamp did not cover. The NEGATIVE half is the point of this case:
		// the unrelated asset must SURVIVE, because demoting a whole list on any
		// open approval teaches the reader to ignore it.
		generateObject.mockResolvedValue({
			object: {
				...MODEL_OUTPUT,
				confirmedAssets: ["The Latency Chart", "architecture diagram"],
				assetsNeedingConfirmation: [],
			},
			usage: {},
		});
		listTopicDecisions.mockResolvedValue([
			openQuestion("ASSET_APPROVAL", "latency chart"),
		]);

		await run();

		expect(persistedContent().confirmedAssets).toEqual([
			"architecture diagram",
		]);
		expect(persistedContent().assetsNeedingConfirmation).toEqual([
			"The Latency Chart",
		]);
		expect(persistedContent().generation.clamped).toEqual({
			assets: ["The Latency Chart"],
		});
	});

	it("demotes on INTERNAL_UI and VIDEO_WALKTHROUGH, not just ASSET_APPROVAL", async () => {
		// An unapproved internal UI capture or an unconfirmed walkthrough is the
		// same claim wearing a different decision kind.
		generateObject.mockResolvedValue({
			object: {
				...MODEL_OUTPUT,
				confirmedAssets: [
					"admin console screenshot",
					"product walkthrough video",
					"public roadmap slide",
				],
				assetsNeedingConfirmation: [],
			},
			usage: {},
		});
		listTopicDecisions.mockResolvedValue([
			openQuestion("INTERNAL_UI", "admin console screenshot"),
			openQuestion("VIDEO_WALKTHROUGH", "product walkthrough video"),
		]);

		await run();

		expect(persistedContent().confirmedAssets).toEqual([
			"public roadmap slide",
		]);
		expect(persistedContent().generation.clamped.assets).toEqual([
			"admin console screenshot",
			"product walkthrough video",
		]);
	});

	it("does not list a demoted asset twice when the model already hedged", async () => {
		// A model that put the same asset in BOTH lists is not rare. Two
		// entries read as two separate things still to chase.
		generateObject.mockResolvedValue({
			object: {
				...MODEL_OUTPUT,
				confirmedAssets: ["customer logo"],
				assetsNeedingConfirmation: ["customer logo"],
			},
			usage: {},
		});
		listTopicDecisions.mockResolvedValue([
			openQuestion("ASSET_APPROVAL", "customer logo"),
		]);

		await run();

		expect(persistedContent().confirmedAssets).toEqual([]);
		expect(persistedContent().assetsNeedingConfirmation).toEqual([
			"customer logo",
		]);
	});

	it("leaves every confirmed asset standing when no ASSET-restricting kind is open", async () => {
		// The clamp is keyed on the specific approval. An open customer-name
		// question says nothing about whether a diagram may be used, and a
		// framing question (CLAIM_STRENGTH here) is not a claim about an asset
		// at all.
		generateObject.mockResolvedValue({
			object: {
				...MODEL_OUTPUT,
				confirmedAssets: ["architecture diagram"],
				assetsNeedingConfirmation: [],
			},
			usage: {},
		});
		listTopicDecisions.mockResolvedValue([
			openQuestion("CUSTOMER_NAME", "architecture diagram"),
			openQuestion("CLAIM_STRENGTH", "architecture diagram"),
		]);

		await run();

		expect(persistedContent().confirmedAssets).toEqual([
			"architecture diagram",
		]);
		expect(persistedContent().assetsNeedingConfirmation).toEqual([]);
		expect(persistedContent().generation.clamped.assets).toBeUndefined();
	});

	it("leaves an ANSWERED asset approval alone — it is not a restriction", async () => {
		// The same rule the subject-shaped block follows. Counting an answered
		// decision would make the demotion permanent.
		generateObject.mockResolvedValue({
			object: {
				...MODEL_OUTPUT,
				confirmedAssets: ["latency chart"],
				assetsNeedingConfirmation: [],
			},
			usage: {},
		});
		listTopicDecisions.mockResolvedValue([
			answeredQuestion(
				"ASSET_APPROVAL",
				"latency chart",
				"Approved for external use.",
			),
		]);

		await run();

		expect(persistedContent().confirmedAssets).toEqual(["latency chart"]);
		expect(persistedContent().generation.clamped).toEqual({});
	});

	it("seeds through the SHARED composer, carrying the title into the body", async () => {
		// Deliberately NOT named as a clamp control: `customerIdentity` and
		// `metricsBasis` never reach the composed text, so no fixture can make
		// seeding from `parsed.data` differ from seeding from the clamped
		// document. What this DOES pin is that the body comes from
		// `composeCaseStudyWorkingDraftBody` in `@repo/utils` — the same
		// function `@repo/api` re-composes an adopted version with — rather than
		// a local join that would drift away from it, which is exactly what
		// happened to the Blog Post sibling.
		generateObject.mockResolvedValue({
			object: { ...MODEL_OUTPUT, title: "A case study title" },
			usage: {},
		});

		await run();

		expect(seedWorkingDraftIfAbsent).toHaveBeenCalledWith(
			expect.objectContaining({
				postType: "CASE_STUDY",
				sourceDraftId: "draft-1",
				updatedById: "user-1",
				body: "# A case study title\n\n## Executive Summary\n\nBuilds used to start cold.",
			}),
		);
	});
});

/**
 * Every VALUE this module imports from `@repo/database`, as source.
 *
 * Type-only imports are excluded on purpose — a type cannot write a row, so
 * adding one is not a change to the write surface and should not fail this.
 * A namespace import (`* as`) or a dynamic `import("@repo/database")` WOULD
 * defeat the check, so both are recorded as their own entries and the expected
 * set below contains neither.
 */
function databaseValueImports(file: string): string[] {
	const source = ts.createSourceFile(
		file,
		readFileSync(file, "utf8"),
		ts.ScriptTarget.Latest,
		true,
	);
	const found = new Set<string>();

	const visit = (node: ts.Node): void => {
		if (
			ts.isImportDeclaration(node) &&
			ts.isStringLiteral(node.moduleSpecifier) &&
			node.moduleSpecifier.text === "@repo/database"
		) {
			const clause = node.importClause;
			if (!clause) {
				found.add("<side-effect import>");
			} else if (!clause.isTypeOnly) {
				if (clause.name) {
					found.add(`<default> ${clause.name.text}`);
				}
				const bindings = clause.namedBindings;
				if (bindings && ts.isNamespaceImport(bindings)) {
					found.add(`<namespace> ${bindings.name.text}`);
				}
				if (bindings && ts.isNamedImports(bindings)) {
					for (const element of bindings.elements) {
						if (!element.isTypeOnly) {
							found.add(
								(element.propertyName ?? element.name).text,
							);
						}
					}
				}
			}
		}
		if (
			ts.isCallExpression(node) &&
			node.expression.kind === ts.SyntaxKind.ImportKeyword
		) {
			const [arg] = node.arguments;
			if (
				arg &&
				ts.isStringLiteral(arg) &&
				arg.text === "@repo/database"
			) {
				found.add("<dynamic import>");
			}
		}
		ts.forEachChild(node, visit);
	};

	visit(source);
	return [...found].sort();
}

describe("generateCaseStudyActivity — the write surface", () => {
	// The card's guarantee: generating a case study publishes nothing, pushes
	// nothing to a feed, creates no asset and mutates no tag.
	//
	// Asserted as the module's `@repo/database` import list, read off the AST,
	// because that is the only formulation that can FAIL. A
	// `not.toHaveBeenCalled()` on a helper the module never imports is true of
	// every possible implementation — including one that publishes — so it
	// distinguishes nothing. This set does: pulling in ANY additional database
	// helper turns it red, whether it is a publisher, a feed writer, an asset
	// creator, a tag mutator or another working-draft writer, and whether or not
	// this file thought to name it.
	//
	// Widening the list is allowed. It just has to be a deliberate edit here,
	// with the new name justified against the guarantee above.
	it("imports ONLY the reads and the two writes the guarantee allows", () => {
		expect(
			databaseValueImports(join(__dirname, "../generate-case-study.ts")),
		).toEqual([
			// The two writes. `completeTopicDraft` finishes the row this run
			// already owns; `seedWorkingDraftIfAbsent` is create-only by
			// construction, which is what makes FR35 hold without a condition
			// here having to be right.
			"completeTopicDraft",
			// Reads.
			"db",
			"getBoundPromptForAgent",
			"isCurrentOrgMember",
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
		// `customerIdentity` is required and has no safe default. A run that
		// cannot produce a valid shape will not produce one on a retry either,
		// and a half-shaped case study persisted as READY is worse than a
		// visible failure.
		generateObject.mockResolvedValue({
			object: { title: "A title", body: "Some body." },
			usage: {},
		});

		await expect(run()).rejects.toMatchObject({
			type: "PUBLISHING_CASE_STUDY_SCHEMA_VALIDATION_FAILED",
			nonRetryable: true,
		});
		expect(completeTopicDraft).not.toHaveBeenCalled();
		expect(seedWorkingDraftIfAbsent).not.toHaveBeenCalled();
	});

	it("rejects a whitespace-only title instead of seeding a headless draft", async () => {
		// The schema's own guard used to be weaker than every reader's:
		// `min(1)` accepts "   ", so the run SUCCEEDED, seeded "# \n\n<body>",
		// and then made the panel's document null — every safety surface gone
		// while the editor still showed text, and adopt throwing forever on a
		// draft the server itself wrote. A visible failure is strictly better.
		generateObject.mockResolvedValue({
			object: { ...MODEL_OUTPUT, title: "   " },
			usage: {},
		});

		await expect(run()).rejects.toMatchObject({
			type: "PUBLISHING_CASE_STUDY_SCHEMA_VALIDATION_FAILED",
			nonRetryable: true,
		});
		expect(completeTopicDraft).not.toHaveBeenCalled();
		expect(seedWorkingDraftIfAbsent).not.toHaveBeenCalled();
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

describe("generateCaseStudyActivity — what it persists", () => {
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
		// The one fact about a run that cannot be recovered from its output: a
		// case study built from the default body because the bound prompt would
		// not render reads exactly like one built from the bound prompt.
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
		await run({ guidance: "Aim it at platform teams." });

		expect(persistedContent().generation.guidance).toBe(
			"Aim it at platform teams.",
		);
	});
});

describe("generateCaseStudyActivity — the model call", () => {
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
