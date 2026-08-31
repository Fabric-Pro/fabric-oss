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
 *  2. The actor's org membership is re-checked at the point of use, before any
 *     model is resolved. Org model resolution PREFERS the actor's personal
 *     provider, so an editor who starts a run and then loses org access would
 *     otherwise keep powering org work under their identity. Fail-closed via a
 *     non-retryable throw, exactly as `summarize-topic-suggestions.ts` does.
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
	db,
	getBoundPromptForAgent,
	isCurrentOrgMember,
} from "@repo/database";
import { logger } from "@repo/logs";
import type { TemplateFormat } from "@repo/utils";
import { heartbeat } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import {
	composePlanningAnalysisPrompt,
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
	// resolves a model or spends the actor's provider quota.
	if (organizationId != null) {
		const stillMember = await isCurrentOrgMember(
			actorUserId,
			organizationId,
		);
		if (!stillMember) {
			throw ApplicationFailure.nonRetryable(
				"AI actor is no longer an org member",
				"PUBLISHING_ACTOR_INVALID",
			);
		}
	}

	const [boundPrompt, contextResult, contributors, roleClause] =
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
			resolveContributorNames(topic.contributorUserIds),
			// Flag-gated and self-authorizing inside the helper: a no-op when
			// function tags are off or no roster member holds one.
			getProjectFunctionTagClause({
				projectId,
				requesterUserId: actorUserId,
				surface: "publishing-suite",
			}),
		]);

	heartbeat(`planningAnalysis: context assembled for ${analysisId}`);

	const composed = await composePlanningAnalysisPrompt({
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
	const questions = resolveConfirmationQuestions(topic.id, parsed.data);

	// `recommendedQuestions` is deliberately dropped in favour of `questions`:
	// the raw array carries no ids, and keeping both would leave the page two
	// sources of truth for the same list.
	const { recommendedQuestions: _raw, ...sections } = parsed.data;
	const content = {
		...sections,
		questions,
		generation: {
			promptSource,
			promptId: boundPrompt?.id ?? null,
			promptVersion: boundPrompt?.version?.version ?? null,
			formatOverridden: composed.formatOverridden,
			generatedAt: new Date().toISOString(),
		},
	};

	const { persisted } = await completePlanningAnalysis({
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
			whyItMatters: q.whyItMatters,
		})),
	});

	if (!persisted) {
		logger.warn(
			"[publishing-planning] analysis superseded before it could be committed",
			{ analysisId, topicId, projectId },
		);
		return { status: "SUPERSEDED" };
	}

	return { status: "READY" };
}

/**
 * Display names for the topic's already-resolved contributors.
 *
 * The ids are server-written by the 1A contributor resolver from the project's
 * own stories and documents, so this is a name lookup for people the topic
 * already names — not a membership query. Skipped entirely when the list is
 * empty, which is both common and valid.
 */
async function resolveContributorNames(
	contributorUserIds: string[],
): Promise<{ id: string; name: string | null }[]> {
	if (contributorUserIds.length === 0) {
		return [];
	}
	const users = await db.user.findMany({
		where: { id: { in: contributorUserIds } },
		select: { id: true, name: true },
	});
	return users.map((u) => ({ id: u.id, name: u.name ?? null }));
}
