/**
 * Refine a saved working draft — the LLM activity (Fizzy #1851 follow-up).
 *
 * ONE activity for all seven content types, where generation needs seven. That
 * asymmetry is not an accident of effort: a generation has to know what a case
 * study IS and what a tweet IS, because it is producing one from source
 * material. A refinement is handed the finished piece and a single instruction,
 * and every working draft body is Markdown — so the only thing this activity
 * needs the content type for is the register cue and the bound-prompt-free
 * locked clauses. See `build-refine-prompt.ts` for why the type's own template
 * is deliberately not rendered.
 *
 * The guards are the generation family's, in the same order and for the same
 * reasons:
 *
 *  1. The topic is read re-scoped by `projectId`. A topic id is client input
 *     everywhere it appears, and a valid id from another project must resolve to
 *     the same nothing a deleted one does (DV16).
 *  2. The actor's authorization is re-checked at the point of use, before any
 *     model is resolved. Provider resolution is organization-first, so a revoked
 *     collaborator would otherwise keep spending the organization's key on its
 *     material. Fail-closed via a non-retryable throw.
 *  3. Output is `safeParse`d before anything is written.
 *
 * It COMMITS its own success and the workflow owns the failure marker, which is
 * the same split every generation activity makes: an activity that has just
 * failed is not the thing to ask for a record of its failure.
 *
 * WHAT IT DOES NOT WRITE: no `PublishingTopicDraft` row. A refinement is a
 * proposal about the working draft, so it consumes no version number and never
 * appears in the candidates grid. The whole point of the slice.
 */

import { generateObject, getAIModelWithMetadata } from "@repo/ai";
import { getProjectFunctionTagClause } from "@repo/ai/lib/function-tag-context";
import { computeMaxOutputTokenBudget } from "@repo/ai/lib/output-token-budget";
import {
	completeRefinement,
	type DraftCommitRefusal,
	type DraftPostType,
	db,
	getBoundPromptForAgent,
	listTopicDecisions,
	logDraftRefusal,
} from "@repo/database";
import type { TemplateFormat } from "@repo/utils";
import {
	isRestrictingThread,
	restrictionLabel,
	settledDecision,
} from "@repo/utils/publishing-restrictions";
import { heartbeat } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import { assertGenerationActorAuthorized } from "../publishing-shared";
import {
	composeRefinePrompt,
	PUBLISHING_REFINE_AGENT_KEY,
	PUBLISHING_REFINE_FALLBACK_BODY,
	type RefineDecision,
	refinementSchemaFor,
} from "./build-refine-prompt";

export interface RefineWorkingDraftInput {
	/** The run that owns the proposal slot — the CAS token for the commit. */
	runId: string;
	topicId: string;
	projectId: string;
	postType: DraftPostType;
	organizationId: string | null;
	/** Who pressed Refine — the identity the model is resolved under. */
	actorUserId: string;
	/**
	 * The body to revise, captured under the project lock by `startRefinement`
	 * in the transaction that claimed the slot.
	 *
	 * Passed down rather than re-read here, and that is deliberate: the text
	 * stored as `refinedFromBody` and the text the prompt receives are then the
	 * same string by construction. The path this replaces read the body in one
	 * query and opened the attempt in another, so an edit landing between them
	 * produced a run that revised one version while recording another.
	 */
	currentDraft: string;
	/** What the author asked for. Null is legal; the prompt handles it. */
	instruction: string | null;
}

export interface RefineWorkingDraftOutput {
	status: "READY" | "SUPERSEDED";
	/**
	 * Why a commit was refused, when it was. OPTIONAL — absent on any history
	 * recorded before it existed, and never branched on by the workflow.
	 */
	refusalReason?: DraftCommitRefusal;
}

export async function refineWorkingDraftActivity(
	input: RefineWorkingDraftInput,
): Promise<RefineWorkingDraftOutput> {
	const { runId, topicId, projectId, postType, organizationId, actorUserId } =
		input;

	// (1) Topic re-scoped by BOTH ids.
	const topic = await db.publishingTopic.findFirst({
		where: { id: topicId, projectId },
		select: { id: true, title: true, pitch: true },
	});
	if (!topic) {
		throw ApplicationFailure.nonRetryable(
			"Topic does not exist in this project",
			"PUBLISHING_TENANT_MISMATCH",
		);
	}

	// (2) Point-of-use actor re-validation (TOCTOU), before anything resolves a
	// model or spends the organization's provider quota.
	await assertGenerationActorAuthorized({
		projectId,
		organizationId,
		actorUserId,
		activity: "refineWorkingDraftActivity",
	});

	const [boundPrompt, roleClause, threads] = await Promise.all([
		// `organizationId ?? undefined` is load-bearing: falsy takes the
		// personal USER → SYSTEM path, truthy takes ORG → SYSTEM, and the two
		// never cross (getBoundPromptVersion, prompts.ts).
		getBoundPromptForAgent({
			agentName: PUBLISHING_REFINE_AGENT_KEY,
			documentType: "GENERAL",
			storyKind: null,
			userId: actorUserId,
			organizationId: organizationId ?? undefined,
		}),
		getProjectFunctionTagClause({
			projectId,
			requesterUserId: actorUserId,
			surface: "publishing-suite",
		}),
		listTopicDecisions({ topicId, projectId }),
	]);

	heartbeat(`refine: context assembled for ${runId}`);

	// SETTLED threads become instructions; UNRESOLVED safety-critical ones
	// become restrictions. Two lists from one read, and both are derived HERE
	// rather than passed in, because the minutes between the button and this
	// line are exactly when someone answers a question.
	//
	// Settled decisions reach a REVISION for the same reason they reach a first
	// draft: "add the customer outcome" is answerable only if the run knows the
	// customer agreed to be named. Resolved through `settledDecision` rather
	// than derived inline — the one way a publishing activity settles a
	// decision, so a revision and a first draft cannot disagree about what the
	// team decided.
	const decisions: RefineDecision[] = [];
	const restrictedSubjects: string[] = [];
	for (const thread of threads) {
		if (isRestrictingThread(thread)) {
			restrictedSubjects.push(restrictionLabel(thread));
			continue;
		}
		const settled = settledDecision(thread);
		if (settled) {
			decisions.push(settled);
		}
	}

	const composed = await composeRefinePrompt({
		templateBody:
			boundPrompt?.version?.content ?? PUBLISHING_REFINE_FALLBACK_BODY,
		format:
			(boundPrompt?.format as TemplateFormat | undefined) ?? "HANDLEBARS",
		postType,
		topicTitle: topic.title,
		topicPitch: topic.pitch,
		decisions,
		currentDraft: input.currentDraft,
		instruction: input.instruction ?? "",
		restrictedSubjects,
	});
	const prompt = composed.prompt + (roleClause ? `\n\n${roleClause}` : "");

	const { model, metadata, trackUsage } = await getAIModelWithMetadata(
		{ taskType: "COMPLEX" },
		{
			userId: actorUserId,
			organizationId: organizationId ?? undefined,
			jobType: "publishing-refine",
		},
	);

	// Bound the generation, as the generation activities do: without a budget an
	// over-long response fails as a HANG, burning the activity's whole allowance
	// and then reporting a timeout — which reads as a broken feature rather than
	// a slow one. `undefined` is a real answer for some providers, so the field
	// is spread in and never set to undefined.
	const maxOutputTokens = computeMaxOutputTokenBudget(metadata, {
		promptChars: prompt.length,
	});

	// The editor's OWN bound for this content type, so a proposal cannot commit
	// a body the panel it lands in would refuse to save.
	const schema = refinementSchemaFor(postType);

	const beat = setInterval(() => heartbeat(), 10_000);
	let result: Awaited<ReturnType<typeof generateObject>>;
	try {
		result = await generateObject({
			model,
			schema,
			prompt,
			...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
			// Azure/OpenAI reject a strict JSON schema containing optional
			// fields outright (bug #1681), and this schema has one.
			providerOptions: { openai: { strictJsonSchema: false } },
		});
	} finally {
		clearInterval(beat);
	}

	trackUsage();

	// Fail closed. `generateObject` already validates, but it is not the only
	// way an object reaches this line — and the cost of being wrong here is a
	// proposal offering an empty body over a real draft.
	const parsed = schema.safeParse(result.object);
	if (!parsed.success) {
		throw ApplicationFailure.nonRetryable(
			`Refinement failed schema validation: ${parsed.error.message}`,
			"PUBLISHING_REFINEMENT_SCHEMA_VALIDATION_FAILED",
		);
	}

	const commit = await completeRefinement({
		topicId,
		projectId,
		postType,
		runId,
		body: parsed.data.body,
		note: parsed.data.safetyNote,
	});
	if (!commit.persisted) {
		// A refused commit is a NORMAL outcome, not a failure: the run was
		// superseded, the project moved tenant, or the proposal was rejected
		// while this call was in flight. Marking it failed would be a write to a
		// slot this run no longer owns — the CAS would refuse that too, and the
		// log line would be untrue.
		logDraftRefusal("[publishing-refine] commit refused", commit.reason, {
			runId,
			topicId,
			projectId,
			postType,
		});
		return { status: "SUPERSEDED", refusalReason: commit.reason };
	}

	return { status: "READY" };
}
