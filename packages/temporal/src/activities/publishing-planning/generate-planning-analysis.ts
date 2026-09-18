/**
 * Planning & Analysis — the LLM activity (Publishing Suite Phase 2A-2, #1851).
 *
 * One model call, wrapped in the guards this repository has learned to put
 * around one. In order:
 *
 *  1. The topic is read re-scoped by `projectId`. A topic id is a client input
 *     everywhere it appears, and a valid id from another project must resolve
 *     to the same nothing a deleted one does (DV16) — never to a
 *     distinguishable error a caller could probe with.
 *  2. The actor's authorization is re-checked at the point of use, before any
 *     model is resolved — the SAME question the API gate asked, which is a
 *     project permission and NOT org membership (only the last of that gate's
 *     three paths). Provider resolution is organization-first, so a revoked
 *     collaborator would otherwise keep spending the organization's key and
 *     credits on its material. Fail-closed via a non-retryable throw, exactly as `summarize-topic-suggestions.ts` does.
 *  3. Output is `safeParse`d before anything is written. A half-shaped analysis
 *     persisted as READY is worse than a visible failure: the page would render
 *     it as a finished answer.
 *
 * The bound prompt is resolved HERE, in the activity, never in the workflow —
 * activity bodies are not replayed, so this adds no command to the workflow's
 * sequence and cannot cause TMPRL1100.
 *
 * This activity also COMMITS its own success. Splitting the write into a second
 * activity would open a window where the model call succeeded and the analysis
 * was lost, paid for by a second multi-minute run. The failure marker is the
 * workflow's job instead, because by definition this activity cannot be trusted
 * to write it.
 */

import { generateObject, getAIModelWithMetadata } from "@repo/ai";
import { getProjectFunctionTagClause } from "@repo/ai/lib/function-tag-context";
import { computeMaxOutputTokenBudget } from "@repo/ai/lib/output-token-budget";
import {
	completePlanningAnalysis,
	type DraftCommitRefusal,
	db,
	effectiveContributorUserIds,
	getBoundPromptForAgent,
	getPublishingSuiteSettings,
	listTopicDecisions,
	logDraftRefusal,
} from "@repo/database";
import { logger } from "@repo/logs";
import type { TemplateFormat } from "@repo/utils";
import {
	type SettledDecision,
	settledBlocker,
	settledDecision,
} from "@repo/utils/publishing-restrictions";
import { heartbeat } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import {
	assertGenerationActorAuthorized,
	resolveContributorNames,
} from "../publishing-shared";
import {
	composePlanningAnalysisPrompt,
	deriveQuestionId,
	foldDuplicateDecisions,
	PUBLISHING_PLANNING_ANALYSIS_AGENT_KEY,
	PUBLISHING_PLANNING_ANALYSIS_FALLBACK_BODY,
	PublishingPlanningAnalysisSchema,
	resolveConfirmationQuestions,
} from "./build-planning-analysis-prompt";
import { collectPlanningContext } from "./collect-planning-context";

export interface GeneratePlanningAnalysisInput {
	/** The GENERATING row this run owns. */
	analysisId: string;
	topicId: string;
	projectId: string;
	organizationId: string | null;
	/** Who pressed the button — the identity the model is resolved under. */
	actorUserId: string;
}

export interface GeneratePlanningAnalysisOutput {
	/**
	 * `SUPERSEDED` is not an error. It means a deadline sweep reclaimed this
	 * attempt while the model was running and a newer one now owns the topic, so
	 * the compare-and-set refused the write. The workflow must NOT mark the row
	 * failed on this path — the row is already terminal, and the newer attempt is
	 * the one a reader should see.
	 */
	status: "READY" | "SUPERSEDED";
	/**
	 * Which refusal produced a non-READY status.
	 *
	 * OPTIONAL on purpose. A Temporal history recorded before this field
	 * existed replays without it, and a workflow that read it as required
	 * would fail that replay. Absent means "an older run that could not say".
	 */
	refusalReason?: DraftCommitRefusal;
}

export async function generatePlanningAnalysisActivity(
	input: GeneratePlanningAnalysisInput,
): Promise<GeneratePlanningAnalysisOutput> {
	const { analysisId, topicId, projectId, organizationId, actorUserId } =
		input;

	heartbeat(`planningAnalysis: ${analysisId}`);

	// (1) Tenancy. Both ids, always — see the file header.
	const topic = await db.publishingTopic.findFirst({
		where: { id: topicId, projectId },
		select: {
			id: true,
			title: true,
			pitch: true,
			angle: true,
			subject: true,
			relevantFunctionTags: true,
			postTypeRecommendations: true,
			contributorUserIds: true,
			contributorsOverridden: true,
			userContributorUserIds: true,
			provenance: true,
		},
	});
	if (!topic) {
		throw ApplicationFailure.nonRetryable(
			"Topic does not exist in this project",
			"PUBLISHING_TENANT_MISMATCH",
		);
	}

	// (2) Point-of-use actor re-validation (TOCTOU). Before ANYTHING that
	// resolves a model or spends the organization's provider quota. Asks the
	// API gate's own question; see `assertGenerationActorAuthorized`.
	await assertGenerationActorAuthorized({
		projectId,
		organizationId,
		actorUserId,
		activity: "generatePlanningAnalysisActivity",
	});

	const [boundPrompt, contextResult, contributors, roleClause, threads] =
		await Promise.all([
			// `organizationId ?? undefined` is load-bearing: falsy takes the
			// personal USER → SYSTEM path, truthy takes ORG → SYSTEM, and the two
			// never cross (getBoundPromptVersion, prompts.ts).
			getBoundPromptForAgent({
				agentName: PUBLISHING_PLANNING_ANALYSIS_AGENT_KEY,
				documentType: "GENERAL",
				storyKind: null,
				userId: actorUserId,
				organizationId: organizationId ?? undefined,
			}),
			collectPlanningContext({
				projectId,
				organizationId,
				userId: actorUserId,
				topicId,
				provenance: topic.provenance,
			}),
			resolveContributorNames({
				contributorUserIds: effectiveContributorUserIds(topic),
				projectId,
			}),
			// Flag-gated and self-authorizing inside the helper: a no-op when
			// function tags are off or no roster member holds one.
			getProjectFunctionTagClause({
				projectId,
				requesterUserId: actorUserId,
				surface: "publishing-suite",
			}),
			// What this topic has already decided. Read on every run rather than
			// carried in workflow input, for the reason the suite settings below
			// are: the minutes between the button and this line are exactly when
			// somebody answers a question.
			listTopicDecisions({ topicId, projectId }),
		]);

	heartbeat(`planningAnalysis: context assembled for ${analysisId}`);

	/**
	 * The decisions this analysis must not reach again.
	 *
	 * BOTH passes, one list. `reconcileTopicQuestions` runs twice per completed
	 * analysis — once over the questions, once over the blockers — so the same
	 * decision can come back as a question ("may we use the customer's name?")
	 * or as an errand ("get sign-off to use the customer's name"). To the person
	 * holding the open items those are one thing asked twice, and suppressing
	 * only the question-shaped repeat would leave the errand returning forever.
	 *
	 * Both resolve through the shared settle helper, whose ANSWER is a member's
	 * current RESOLVED reply and never the root's own summary — that field holds
	 * the model's question, which the helper carries separately as the question
	 * the member was shown; presenting it as the answer is the failure the helper
	 * exists to prevent. This analysis reads only the label and the answer.
	 */
	const settledDecisions: SettledDecision[] = [];
	for (const thread of threads) {
		const settled = settledDecision(thread) ?? settledBlocker(thread);
		if (settled) {
			settledDecisions.push(settled);
		}
	}

	/**
	 * Whether this project wants the analysis to draft suggested answers.
	 *
	 * Read here rather than threaded through workflow input on purpose: the
	 * setting is a preference the project can change between the run being
	 * scheduled and it executing, and the honest answer is the one that holds
	 * when the prompt is written. Nothing about it needs to survive a replay —
	 * it shapes the prompt, and the prompt is already part of the result.
	 */
	const suiteSettings = await getPublishingSuiteSettings(projectId);

	const composed = await composePlanningAnalysisPrompt({
		autoProposeAnswers: suiteSettings?.autoProposeAnswers ?? true,
		templateBody:
			boundPrompt?.version?.content ??
			PUBLISHING_PLANNING_ANALYSIS_FALLBACK_BODY,
		format:
			(boundPrompt?.format as TemplateFormat | undefined) ?? "HANDLEBARS",
		topic: {
			id: topic.id,
			title: topic.title,
			pitch: topic.pitch,
			angle: topic.angle,
			subject: topic.subject,
			relevantFunctionTags: topic.relevantFunctionTags as string[],
			postTypeRecommendations: topic.postTypeRecommendations,
			contributors,
		},
		context: contextResult.context,
		settledDecisions,
	});

	const prompt = composed.prompt + (roleClause ? `\n\n${roleClause}` : "");

	// Which prompt actually shaped this analysis. Persisted rather than only
	// logged: an analysis built from the default body because a bound prompt
	// would not render reads exactly like one built from the bound prompt, so it
	// is the one thing about a run a reader cannot recover from the output.
	const promptSource = !boundPrompt
		? ("DEFAULT_UNBOUND" as const)
		: composed.bodyRecovered
			? ("DEFAULT_RENDER_FAILED" as const)
			: ("BOUND" as const);

	const { model, metadata, trackUsage } = await getAIModelWithMetadata(
		{ taskType: "COMPLEX" },
		{
			userId: actorUserId,
			organizationId: organizationId ?? undefined,
			jobType: "publishing-planning-analysis",
		},
	);

	// Bound the generation. Without a budget an over-long response fails as a
	// HANG — it burns this activity's whole 480s allowance and then reports a
	// timeout, which reads as a broken feature rather than a slow one.
	//
	// MAXIMAL mode rather than the scaled variant: the worksheet's size follows
	// its own fixed shape, not the size of the context it was built from, so
	// scaling the allowance to 2x a large input would reserve an absurd quota for
	// a document that is always about the same length. `promptChars` is measured
	// on what is actually SENT (role clause included), because the clamp exists
	// to reserve context-window room for the input.
	//
	// `undefined` is a real answer — some providers must not be sent an explicit
	// budget — so the field is spread in, never set to undefined.
	const maxOutputTokens = computeMaxOutputTokenBudget(metadata, {
		promptChars: prompt.length,
	});

	const beat = setInterval(() => heartbeat(), 10_000);
	let result: Awaited<ReturnType<typeof generateObject>>;
	try {
		result = await generateObject({
			model,
			schema: PublishingPlanningAnalysisSchema,
			prompt,
			...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
			// Every section of the schema is optional, and Azure/OpenAI reject a
			// strict JSON schema containing optional fields outright (bug #1681).
			// The AI SDK still validates the object against the zod schema.
			providerOptions: { openai: { strictJsonSchema: false } },
		});
	} finally {
		clearInterval(beat);
	}

	trackUsage();

	// Fail closed. `generateObject` already validates, but it is not the only way
	// an object reaches this line — and the cost of being wrong is a page that
	// renders an unfinished analysis as a finished one.
	const parsed = PublishingPlanningAnalysisSchema.safeParse(result.object);
	if (!parsed.success) {
		throw ApplicationFailure.nonRetryable(
			`Planning analysis failed schema validation: ${parsed.error.message}`,
			"PUBLISHING_PA_SCHEMA_VALIDATION_FAILED",
		);
	}

	// FR39. Identity is derived code-side from (topic, decisionKind, subject) so
	// it survives a regeneration that rephrases the question — a model-invented
	// id would not, and stability is the whole point of the key.
	const rawQuestions = resolveConfirmationQuestions(topic.id, parsed.data);

	/**
	 * What the topic is MISSING, keyed the same way its questions are.
	 *
	 * Identity is `(topic, kind, subject)` and derived code-side for the same
	 * reason: a model-invented id would not survive a regeneration that
	 * rephrases "we need a quote from the client", and a second blocker beside
	 * one somebody already cleared is worse than none.
	 *
	 * A blocker carries no recommended answer. There is nothing to recommend —
	 * the thing does not exist yet, and the only two outcomes are that somebody
	 * gets it or that somebody decides it is not needed.
	 */
	const rawBlockers = (parsed.data.blockers ?? [])
		.filter((b) => b.need.trim().length > 0)
		.map((b) => {
			const kind = b.kind ?? "OTHER";
			const subject = b.subject?.trim() || null;
			return {
				questionId: deriveQuestionId({
					topicId: topic.id,
					decisionKind: kind,
					subject: subject ?? undefined,
					question: b.need,
				}),
				decisionKind: kind,
				subject,
				question: b.need.trim(),
				recommendedResponse: null,
				// A blocker carries no recommended answer either — see the
				// docblock above.
				answerOptions: null,
				whyItMatters: b.whyItMatters?.trim() || null,
			};
		});

	/**
	 * One decision, one item — within THIS run.
	 *
	 * The identity key recognises a decision across regenerations and cannot
	 * help inside one: the two producers describe the same thing in different
	 * vocabularies on purpose, so a run raised "Is the customer name approved?",
	 * "should we name them as the first trial customer?" and "get sign-off to
	 * name them publicly" as three items wanting three answers. The owner's
	 * call is that nobody answers the same thing twice in one run.
	 *
	 * Folded, not dropped: `blockers` is stripped from the stored document
	 * below, so a discarded one would leave no trace at all. See
	 * `foldDuplicateDecisions`.
	 */
	const { questions, blockers, folded } = foldDuplicateDecisions({
		questions: rawQuestions,
		blockers: rawBlockers,
	});
	if (folded > 0) {
		logger.info(
			"[publishing-planning] folded duplicate decisions into their first item",
			{ analysisId, topicId, folded },
		);
	}

	// `recommendedQuestions` is deliberately dropped in favour of `questions`:
	// the raw array carries no ids, and keeping both would leave the page two
	// sources of truth for the same list.
	const {
		recommendedQuestions: _raw,
		// Dropped from the blob for the same reason: the raw array carries no
		// ids, and the ROWS are what the page reads.
		blockers: _rawBlockers,
		...sections
	} = parsed.data;
	const content = {
		...sections,
		// The folded-question list rides on the reconciliation ROWS only. The
		// analysis document keeps the shape every reader resolves and budgets,
		// and its `whyItMatters` already carries the same questions as prose.
		questions: questions.map(
			({ foldedQuestions: _foldedQuestions, ...question }) => question,
		),
		generation: {
			promptSource,
			promptId: boundPrompt?.id ?? null,
			promptVersion: boundPrompt?.version?.version ?? null,
			formatOverridden: composed.formatOverridden,
			generatedAt: new Date().toISOString(),
		},
	};

	const commit = await completePlanningAnalysis({
		id: analysisId,
		projectId,
		content,
		sourceRefs: contextResult.sourceRefs,
		model: metadata?.modelString ?? null,
		promptSource,
		// The same list that goes into `content.questions`, handed over as rows.
		// The blob remains the analysis's own record of what it raised; the ROWS
		// are what the page reads, because only a row can carry a status and an
		// answer.
		questions: questions.map((q) => ({
			questionId: q.questionId,
			decisionKind: q.decisionKind,
			subject: q.subject,
			question: q.question,
			recommendedResponse: q.recommendedResponse,
			answerOptions: q.answerOptions,
			whyItMatters: q.whyItMatters,
			// Empty for a question nothing was folded into. Required by the row
			// type, so this seam cannot compile while dropping it.
			foldedQuestions: q.foldedQuestions ?? [],
		})),
		// Mapped field by field like the questions, not passed whole: a blocker
		// nothing was folded into carries no list, and the row needs an empty one.
		blockers: blockers.map((b) => ({
			questionId: b.questionId,
			decisionKind: b.decisionKind,
			subject: b.subject,
			question: b.question,
			recommendedResponse: b.recommendedResponse,
			answerOptions: b.answerOptions,
			whyItMatters: b.whyItMatters,
			foldedQuestions: b.foldedQuestions ?? [],
		})),
	});

	if (!commit.persisted) {
		// The reason, not the guess. All three refusals used to log
		// "superseded", which sent an operator looking for a newer attempt
		// that in two of the three cases does not exist.
		logDraftRefusal(
			"[publishing-planning] analysis not committed",
			commit.reason,
			{
				analysisId,
				topicId,
				projectId,
			},
		);
		return { status: "SUPERSEDED", refusalReason: commit.reason };
	}

	return { status: "READY" };
}
