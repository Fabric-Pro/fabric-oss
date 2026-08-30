/**
 * Topic Planning & Analysis — the pure half (Fizzy #1851, Phase 2A-2).
 *
 * Everything here is synchronous or DB-free on purpose: the schema, the
 * question-id derivation and the prompt composer are the three pieces that
 * decide what the model is asked and how its answer is keyed, and none of them
 * should need a model, a database or a Temporal context to be pinned.
 */

import { describe, expect, it } from "vitest";
import {
	composePlanningAnalysisPrompt,
	deriveQuestionId,
	type PlanningAnalysisContext,
	type PlanningAnalysisTopic,
	PUBLISHING_PLANNING_ANALYSIS_AGENT_KEY,
	PUBLISHING_PLANNING_ANALYSIS_FALLBACK_BODY,
	PublishingPlanningAnalysisSchema,
	resolveConfirmationQuestions,
} from "../build-planning-analysis-prompt";

const TOPIC: PlanningAnalysisTopic = {
	id: "topic-1",
	title: "Bounded the retry window",
	pitch: "Duplicate deliveries dropped once retries stopped overlapping.",
	angle: "Engineering deep-dive",
	subject: "Retry budget shipped",
	relevantFunctionTags: ["DEVELOPER", "ARCHITECT"],
	postTypeRecommendations: [
		{
			type: "Blog Post",
			theme: "Reliability",
			rationale: "The lesson generalises.",
		},
	],
	contributors: [{ id: "user-1", name: "Dev One" }],
};

const EMPTY_CONTEXT: PlanningAnalysisContext = {
	stories: [],
	documents: [],
	transcripts: [],
	repoPrs: [],
};

// ---------------------------------------------------------------------------
// deriveQuestionId
// ---------------------------------------------------------------------------

describe("deriveQuestionId", () => {
	// Spec §4.3 keys reconciliation on (topicId, questionId) and says the identity
	// must come from a question's SUBJECT, "not its wording". Two earlier designs
	// failed that: a model-emitted slug (unstable by nature), then a hash of the
	// question text (stable only against typographic noise — a regeneration that
	// rephrases the same decision still minted a duplicate).
	//
	// Identity is therefore (decisionKind, subject). The question text is the
	// tiebreak of last resort, used only for a free-form OTHER question, where
	// nothing stable exists to key on.

	it("survives a full rephrasing of the same decision", () => {
		// THE case. Both runs ask whether the customer name may be used; only the
		// wording differs. A wording-keyed hash mints a second OPEN question on
		// top of one the user may already have answered.
		const first = deriveQuestionId({
			topicId: "topic-1",
			decisionKind: "CUSTOMER_NAME",
			subject: "the customer name",
			question: "Can we name the customer publicly?",
		});
		const second = deriveQuestionId({
			topicId: "topic-1",
			decisionKind: "CUSTOMER_NAME",
			subject: "the customer name",
			question: "Is public use of the customer name approved?",
		});
		expect(first).toBe(second);
	});

	it("separates two decisions of the same kind about different things", () => {
		// One topic can need approval for two different assets. Keying on the kind
		// alone would collapse them into one question and lose a decision.
		expect(
			deriveQuestionId({
				topicId: "topic-1",
				decisionKind: "ASSET_APPROVAL",
				subject: "customer quote",
				question: "Is the quote approved?",
			}),
		).not.toBe(
			deriveQuestionId({
				topicId: "topic-1",
				decisionKind: "ASSET_APPROVAL",
				subject: "architecture diagram",
				question: "Can we publish the diagram?",
			}),
		);
	});

	it("ignores casing and trailing punctuation in the subject", () => {
		expect(
			deriveQuestionId({
				topicId: "topic-1",
				decisionKind: "ASSET_APPROVAL",
				subject: "  Customer Quote.  ",
				question: "Approved?",
			}),
		).toBe(
			deriveQuestionId({
				topicId: "topic-1",
				decisionKind: "ASSET_APPROVAL",
				subject: "customer quote",
				question: "Approved?",
			}),
		);
	});

	it("distinguishes different decision kinds about the same subject", () => {
		expect(
			deriveQuestionId({
				topicId: "topic-1",
				decisionKind: "ASSET_APPROVAL",
				subject: "customer quote",
				question: "Approved?",
			}),
		).not.toBe(
			deriveQuestionId({
				topicId: "topic-1",
				decisionKind: "CLAIM_STRENGTH",
				subject: "customer quote",
				question: "Strong enough?",
			}),
		);
	});

	it("falls back to the question wording only for a free-form question", () => {
		// OTHER with no subject has nothing stable to key on, so wording is the
		// only option — and that limitation is real, not papered over. Within it,
		// typographic noise is still normalised away.
		expect(
			deriveQuestionId({
				topicId: "topic-1",
				question: "Should we wait for the release notes?",
			}),
		).toBe(
			deriveQuestionId({
				topicId: "topic-1",
				question: "  should we wait for the release notes  ",
			}),
		);
	});

	it("is scoped to the topic, so two topics never collide", () => {
		expect(
			deriveQuestionId({
				topicId: "topic-1",
				decisionKind: "CUSTOMER_NAME",
				subject: "the customer name",
				question: "Can we name the customer?",
			}),
		).not.toBe(
			deriveQuestionId({
				topicId: "topic-2",
				decisionKind: "CUSTOMER_NAME",
				subject: "the customer name",
				question: "Can we name the customer?",
			}),
		);
	});

	it("fits the column and is url/key safe", () => {
		expect(
			deriveQuestionId({ topicId: "topic-1", question: "Anything?" }),
		).toMatch(/^[0-9a-f]{32}$/);
	});
});

// ---------------------------------------------------------------------------
// PublishingPlanningAnalysisSchema
// ---------------------------------------------------------------------------

describe("PublishingPlanningAnalysisSchema", () => {
	it("accepts an analysis with every section present", () => {
		const parsed = PublishingPlanningAnalysisSchema.safeParse({
			topicAngle: "The retry budget as a reliability lesson.",
			whyWorthPublishing:
				"Evidence is strong: two transcripts and a doc.",
			keyDetails: {
				released: "Bounded retry window",
				problem: "Overlapping retries duplicated deliveries",
				solution: "One budget per execution",
				whatMakesItInteresting:
					"The fix was a constraint, not a retry cap",
				evidence: "Duplicate rate fell in the following cycle",
				quotes: "Candidate quote — approval needed",
				caveats: "Do not state a percentage; none was measured",
			},
			recommendedAuthors: "The engineer who owned the change.",
			authorVoiceAndPerspective: "Technical implementation framing.",
			audienceAndDistributionFit: "Practitioner education.",
			contentTypes: {
				recommended: [
					{
						type: "Blog Post",
						rationale: "There is a clear lesson.",
					},
				],
				needsConfirmation: [
					{
						type: "Case Study",
						rationale: "Needs customer approval.",
					},
				],
				deferred: [
					{
						type: "Video Walkthrough Script",
						rationale: "Nothing visual.",
					},
				],
			},
			supportingAssets: {
				recommended: [
					{
						type: "Workflow diagram",
						rationale: "The change is structural.",
					},
				],
				requiresApproval: [
					{
						type: "Customer quote",
						rationale: "Approval not present.",
					},
				],
				deferred: [
					{ type: "Customer logo", rationale: "No agreement." },
				],
			},
			sourceSignals: ["Transcript notes the duplicate deliveries"],
			risks: ["The metric is unconfirmed"],
			recommendedQuestions: [
				{
					question:
						"Is the customer quote approved for external use?",
					recommendedResponse:
						"Ask the account owner before drafting.",
					whyItMatters: "A case study cannot ship without it.",
				},
			],
			preDraftGuidance: "Lead with the constraint, not the incident.",
		});
		expect(parsed.success).toBe(true);
	});

	it("accepts an analysis with nothing available (FR21–FR38 'where available')", () => {
		// Every section is optional because every requirement says "where
		// available". A thin topic must yield a thin analysis, never a validation
		// failure that fails the whole run.
		expect(PublishingPlanningAnalysisSchema.safeParse({}).success).toBe(
			true,
		);
	});

	it("accepts a content type outside PublishingTopicPostType", () => {
		// FR32's supported set includes Webinar/Demo Script, Video Walkthrough
		// Script and Newsletter Blurb, none of which are in the enum. Narrowing
		// `type` to the enum would make the model drop three legitimate answers.
		const parsed = PublishingPlanningAnalysisSchema.safeParse({
			contentTypes: {
				recommended: [
					{
						type: "Newsletter Blurb",
						rationale: "Short but useful.",
					},
				],
			},
		});
		expect(parsed.success).toBe(true);
	});

	it("rejects a classified recommendation with no rationale", () => {
		// DV11/DV12: the classification is only meaningful if it says WHY. An
		// unexplained "requires approval" is not actionable by a writer.
		const parsed = PublishingPlanningAnalysisSchema.safeParse({
			supportingAssets: {
				requiresApproval: [{ type: "Customer quote" }],
			},
		});
		expect(parsed.success).toBe(false);
	});

	it("rejects a question with no question text", () => {
		const parsed = PublishingPlanningAnalysisSchema.safeParse({
			recommendedQuestions: [{ whyItMatters: "It matters." }],
		});
		expect(parsed.success).toBe(false);
	});

	it("does not require the model to supply a question id", () => {
		// The id is derived code-side (deriveQuestionId). Requiring it here would
		// reintroduce the instability that derivation exists to remove.
		const parsed = PublishingPlanningAnalysisSchema.safeParse({
			recommendedQuestions: [{ question: "Can we name the customer?" }],
		});
		expect(parsed.success).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// resolveConfirmationQuestions
// ---------------------------------------------------------------------------

describe("resolveConfirmationQuestions", () => {
	// FR39: "If a recommendation requires user confirmation, the system SHALL
	// represent that unresolved decision as a question in the Summary & Questions
	// tab." Rendering only the model's `recommendedQuestions` array does not
	// satisfy that — the array is optional and independent of the classified
	// buckets, so a perfectly valid response can recommend a case study that
	// "needs confirmation" and a quote that "requires approval" while emitting no
	// question at all, and the user would see no unresolved decision anywhere.
	//
	// The questions are therefore DERIVED from the recommendations that carry a
	// confirmation requirement, and merged with whatever the model volunteered.

	it("mints a question for a content type that needs confirmation", () => {
		const questions = resolveConfirmationQuestions("topic-1", {
			contentTypes: {
				needsConfirmation: [
					{
						type: "Case Study",
						rationale: "Needs customer approval.",
					},
				],
			},
		});

		expect(questions).toHaveLength(1);
		expect(questions[0].question).toMatch(/case study/i);
		expect(questions[0].source).toBe("DERIVED");
	});

	it("mints a question for an asset that requires approval", () => {
		const questions = resolveConfirmationQuestions("topic-1", {
			supportingAssets: {
				requiresApproval: [
					{
						type: "Customer quote",
						rationale: "Approval not present.",
					},
				],
			},
		});

		expect(questions).toHaveLength(1);
		expect(questions[0].question).toMatch(/customer quote/i);
	});

	it("mints nothing for recommended or deferred entries", () => {
		// Only "needs confirmation" and "requires approval" are unresolved
		// decisions. A recommendation the model is confident about, and one it has
		// already ruled out, are both resolved — turning them into questions would
		// bury the real ones.
		expect(
			resolveConfirmationQuestions("topic-1", {
				contentTypes: {
					recommended: [
						{ type: "Blog Post", rationale: "Clear lesson." },
					],
					deferred: [
						{ type: "Case Study", rationale: "No metrics." },
					],
				},
				supportingAssets: {
					recommended: [
						{ type: "Diagram", rationale: "Structural." },
					],
					deferred: [
						{ type: "Customer logo", rationale: "No agreement." },
					],
				},
			}),
		).toEqual([]);
	});

	it("keeps the model's own question instead of a duplicate derived one", () => {
		// The model is asked to raise these as questions too. When it does, its
		// wording is better than anything generated from a bucket entry — but the
		// two must collapse to ONE decision, and the id is what makes that
		// possible.
		const questions = resolveConfirmationQuestions("topic-1", {
			supportingAssets: {
				requiresApproval: [
					{
						type: "Customer quote",
						rationale: "Approval not present.",
					},
				],
			},
			recommendedQuestions: [
				{
					decisionKind: "ASSET_APPROVAL",
					subject: "Customer quote",
					question:
						"Has the account team cleared this quote for public use?",
				},
			],
		});

		expect(questions).toHaveLength(1);
		expect(questions[0].source).toBe("MODEL");
		expect(questions[0].question).toMatch(/account team/i);
	});

	it("gives every question a stable id", () => {
		const of = (
			analysis: Parameters<typeof resolveConfirmationQuestions>[1],
		) =>
			resolveConfirmationQuestions("topic-1", analysis).map(
				(q) => q.questionId,
			);

		// Same decision, reached once through the model and once through the
		// derived path: one identity either way, which is what lets 2A-3 reconcile
		// across regenerations that happen to phrase things differently.
		expect(
			of({
				supportingAssets: {
					requiresApproval: [
						{ type: "Customer quote", rationale: "r" },
					],
				},
			}),
		).toEqual(
			of({
				recommendedQuestions: [
					{
						decisionKind: "ASSET_APPROVAL",
						subject: "Customer quote",
						question: "Cleared?",
					},
				],
			}),
		);
	});

	it("returns nothing for an empty analysis", () => {
		expect(resolveConfirmationQuestions("topic-1", {})).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// composePlanningAnalysisPrompt
// ---------------------------------------------------------------------------

describe("composePlanningAnalysisPrompt", () => {
	it("appends the locked contract to a body that contains none of it", async () => {
		// THE test for this file: the output contract and the FR40–FR42 approval
		// rules are appended code-side precisely so an org override cannot drop
		// them.
		//
		// The body here is deliberately non-blank and valid, so NO recovery guard
		// fires. An empty body would have proved nothing — it trips guard 3 and
		// renders the fallback, so the assertions below would pass even if the
		// clauses had been folded into the seed, which is the exact defect this
		// test exists to catch.
		const composed = await composePlanningAnalysisPrompt({
			templateBody: "Analyse {{{topic_title}}}.",
			format: "HANDLEBARS",
			topic: TOPIC,
			context: EMPTY_CONTEXT,
		});

		expect(composed.bodyRecovered).toBe(false);
		expect(composed.prompt).toContain("Analyse Bounded the retry window.");
		expect(composed.prompt).toMatch(/do not.*generat/i);
		expect(composed.prompt).toMatch(/approv/i);
	});

	it("recovers a blank body rather than sending the contract alone", async () => {
		// The case the test above deliberately does not cover. A blank bound body
		// leaves the model with nothing but the locked clauses — no instructions
		// and no topic — which is still enough of a nudge to invent an analysis
		// that is then persisted as READY.
		const composed = await composePlanningAnalysisPrompt({
			templateBody: "",
			format: "HANDLEBARS",
			topic: TOPIC,
			context: EMPTY_CONTEXT,
		});

		expect(composed.bodyRecovered).toBe(true);
		expect(composed.prompt).toContain("Bounded the retry window");
	});

	it("renders the topic into the prompt", async () => {
		const composed = await composePlanningAnalysisPrompt({
			templateBody: PUBLISHING_PLANNING_ANALYSIS_FALLBACK_BODY,
			format: "HANDLEBARS",
			topic: TOPIC,
			context: EMPTY_CONTEXT,
		});

		expect(composed.prompt).toContain("Bounded the retry window");
		expect(composed.prompt).toContain("Engineering deep-dive");
	});

	it("carries role context even when the function-tag flag is off", async () => {
		// FR28 wants role-based perspective. getProjectFunctionTagClause is
		// flag-gated and returns "" by default, so if that clause were the only
		// role signal FR28 would hold on no environment anyone runs. The topic's
		// OWN relevantFunctionTags and contributors are the load-bearing signal,
		// and they are in the prompt regardless of any flag.
		const composed = await composePlanningAnalysisPrompt({
			templateBody: PUBLISHING_PLANNING_ANALYSIS_FALLBACK_BODY,
			format: "HANDLEBARS",
			topic: TOPIC,
			context: EMPTY_CONTEXT,
		});

		expect(composed.prompt).toContain("DEVELOPER");
		expect(composed.prompt).toContain("Dev One");
	});

	it("recovers to the default body when the bound body will not render", async () => {
		// Guard 2, from the agenda precedent: a Handlebars body under a format
		// that does not template leaves the construct standing, which means the
		// model got no context at all.
		const composed = await composePlanningAnalysisPrompt({
			templateBody: "{{#if has_stories}}unclosed",
			format: "HANDLEBARS",
			topic: TOPIC,
			context: EMPTY_CONTEXT,
		});

		expect(composed.bodyRecovered).toBe(true);
		expect(composed.prompt).toContain("Bounded the retry window");
	});

	it("recovers when the bound body renders to nothing", async () => {
		// Guard 3: `{{#unknown}}…{{/unknown}}` is a falsy block, not a syntax
		// error. It parses, renders to "", and the model would receive only the
		// locked clauses — enough of a nudge to invent a whole analysis that is
		// then persisted as READY.
		const composed = await composePlanningAnalysisPrompt({
			templateBody: "{{#unknown_block}}anything{{/unknown_block}}",
			format: "HANDLEBARS",
			topic: TOPIC,
			context: EMPTY_CONTEXT,
		});

		expect(composed.bodyRecovered).toBe(true);
	});

	it("renders a non-templating format as Handlebars and says so", async () => {
		// Guard 1: MARKDOWN/PLAIN_TEXT do no templating at all — renderTemplate
		// returns the body verbatim with no error, which would silently ship zero
		// topic data to the model.
		const composed = await composePlanningAnalysisPrompt({
			templateBody: PUBLISHING_PLANNING_ANALYSIS_FALLBACK_BODY,
			format: "MARKDOWN",
			topic: TOPIC,
			context: EMPTY_CONTEXT,
		});

		expect(composed.formatOverridden).toBe(true);
		expect(composed.prompt).toContain("Bounded the retry window");
	});

	it("lists the provenance context it was given", async () => {
		const composed = await composePlanningAnalysisPrompt({
			templateBody: PUBLISHING_PLANNING_ANALYSIS_FALLBACK_BODY,
			format: "HANDLEBARS",
			topic: TOPIC,
			context: {
				stories: [
					{
						id: "s1",
						identifier: "F-100",
						title: "Bound the retry window",
					},
				],
				documents: [{ id: "d1", title: "Retry design note" }],
				transcripts: [{ id: "t1", summary: "Agreed to bound retries" }],
				repoPrs: [
					{ repoFullName: "example-org/example-repo", prNumber: 12 },
				],
			},
		});

		expect(composed.prompt).toContain("F-100");
		expect(composed.prompt).toContain("Retry design note");
		expect(composed.prompt).toContain("Agreed to bound retries");
		expect(composed.prompt).toContain("example-org/example-repo#12");
	});

	it("says plainly when a topic has no source context", async () => {
		// A manual topic has provenance: null. The prompt must SAY the context is
		// empty rather than render a bare heading — an empty section invites the
		// model to fill it, which is the one thing FR20 forbids.
		const composed = await composePlanningAnalysisPrompt({
			templateBody: PUBLISHING_PLANNING_ANALYSIS_FALLBACK_BODY,
			format: "HANDLEBARS",
			topic: { ...TOPIC, pitch: null, angle: null, subject: null },
			context: EMPTY_CONTEXT,
		});

		expect(composed.prompt).toMatch(/no .*(source|context)/i);
	});
});

describe("agent key", () => {
	it("is the literal the seed and the catalog must both carry", () => {
		// The same string lives in seed-prompts-only.ts, prompt-action-catalog.ts
		// and here, and nothing cross-checks them at runtime: a mismatch resolves
		// no binding and falls back to the default body forever, silently.
		expect(PUBLISHING_PLANNING_ANALYSIS_AGENT_KEY).toBe(
			"publishing_topic_planning_analysis",
		);
	});
});
