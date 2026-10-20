/**
 * The one place a project-document generation run is started.
 *
 * Two procedures dispatch generation — the editor's regenerate action and the
 * Documents tab's create-and-generate call — and the identity, ordering and
 * recovery rules below are the kind that rot silently when a second copy
 * exists.
 *
 * **Identity.** The `workflowId` is a hash of the run's own inputs, not a
 * timestamp. An equivalent repeat request therefore lands on the id a live run
 * already holds, Temporal refuses the duplicate start, and the caller is told
 * `alreadyInProgress` instead of racing a second run over the same document.
 * The reuse policy is set explicitly alongside it: the id is stable forever, so
 * a CLOSED prior run under that id must still permit a new start or a document
 * could never be regenerated twice with identical settings.
 *
 * **Ordering.** The row is marked QUEUED *after* the start attempt, not before
 * it, and the mark is guarded. Both halves matter. A start that Temporal
 * rejects as a duplicate must not stamp a fresh `generationStartedAt` over the
 * live attempt's identity — that timestamp is what the live run's own
 * QUEUED → GENERATING flip is scoped to, and overwriting it strands the run.
 * And a workflow that fails inside its first dependency probe writes FAILED
 * within milliseconds; an unguarded later write would drag the row back to
 * QUEUED, a state the watchdog's age ceiling skips and the retry affordance
 * hides. `markDocumentGenerationQueued` declines to write over a row that has
 * been touched since this attempt began, which is what makes marking after the
 * start safe — and is why the old mark-before-start ordering of issue #720 is
 * no longer needed to protect a fast-failing run's own FAILED write. A write
 * that owns no run (a title edit, say) landing in that window also declines
 * it, so the mark then takes the row back by identity unless a newer attempt
 * stamped it (see `markDocumentGenerationQueued`'s `reclaim`).
 *
 * That guard is a freshness window, not a status check, and the difference is
 * the whole point: refusing terminal rows looked equivalent and was not, because
 * regeneration BEGINS from a terminal row. Guarding on status meant every
 * regenerate — the only path the list offers, on exactly COMPLETE and FAILED
 * documents — had its queue mark silently declined, so the wait this feature
 * exists to show was never visible on the path users actually take.
 *
 * **A client-document Proposal joins its live run** (Fizzy #2946). Its run
 * streams the new Main into the page section by section, so a second run
 * started over it — by another member, or by the same one with different
 * instructions, which hash to a different id — would replace the sections on
 * screen with a different run's. While its row is QUEUED or GENERATING with a
 * stored workflow other than the one this request would start, that workflow
 * is asked whether it still runs (the shared probe in
 * `workflow-run-liveness.ts`): `alreadyInProgress` with nothing written when
 * it does, `liveRunUnknown` with nothing started or written when Temporal
 * cannot say (the next request asks again), and a new run only once it is
 * gone — a closed workflow can leave GENERATING behind. `liveRunUnknown` is
 * its own answer, not `statusUnknown`: that one means this request's own
 * start may have registered and the row is queued for it, so a caller treats
 * it as started. The read, the question, the start and the queue mark hold
 * one per-document lock, so two requests a second apart cannot both start.
 * The Temporal calls made under that lock are bounded so the lock's
 * transaction never times out under them: a start that does not answer in
 * time takes the ambiguous-start path below, queued for this attempt.
 * Every other document type supersedes as before.
 *
 * Failures propagate raw. The caller — a procedure boundary — logs the real
 * cause and throws a fixed generic message, because everything in here is
 * infrastructure (Temporal client, token issuance, workflow start) whose errors
 * can carry hosts, connection strings, and provider messages that must never
 * reach a toast.
 */

import { createHash } from "node:crypto";
import { ORPCError } from "@orpc/server";
import { isAiImpersonatedRequest } from "@repo/ai/lib/chatgpt-plan/interactive-context";
import { issueAIToken } from "@repo/ai-token";
import {
	isFeatureEnabled,
	isProposalClientDocument,
	type LiveRunDispatchState,
	withLiveRunDispatchLock,
} from "@repo/database";
// The canonical-form helper, imported from the module that defines it rather
// than from the `@repo/database` barrel: this one is pure (node:crypto only),
// so the dispatcher does not drag the Prisma client in behind a hash.
import { canonicalize } from "@repo/database/prisma/queries/audit-log-seal";
import {
	markDocumentGenerationFailed,
	markDocumentGenerationQueued,
} from "@repo/database/prisma/queries/projects/documents";
import { logger } from "@repo/logs";
import { getTemporalClient } from "@repo/temporal";
import {
	findBoundProposalPrompt,
	proposalPromptNotBoundMessage,
} from "@repo/temporal/proposal-artifact-prompts";
import { PROPOSAL_PROMPT_NOT_BOUND } from "@repo/temporal/proposal-artifact-types";
import { PROPOSAL_CLIENT_MAIN_AGENT_KEY } from "@repo/utils/prompt-action-catalog";
import {
	WorkflowExecutionAlreadyStartedError,
	WorkflowNotFoundError,
} from "@temporalio/client";
import { withCorrelationMemo } from "../../../lib/temporal-correlation";
import { assertCapabilityAvailable } from "../../capabilities/assert";
import {
	WORKFLOW_RUN_LIVENESS_TIMEOUT_MS,
	workflowRunLiveness,
} from "./workflow-run-liveness";

/**
 * How long a client-document Proposal's workflow start may take under its
 * dispatch lock. Temporal sets no deadline of its own, and its client retries
 * an unavailable server for well over the lock transaction's 30 s, after
 * which the lock is released while the dispatch keeps running. The retries
 * honour the same absolute deadline, overshooting it by at most one backoff
 * (5 s), so the locked work stays near 23 s: the liveness question (5 s),
 * this start (8 s, up to 13 s), the post-failure describe (5 s) and the
 * queue mark. A start that runs out of time is the ambiguous start: the row
 * is queued for the attempt and describe() decides.
 */
export const LIVE_RUN_START_DEADLINE_MS = 8_000;

/**
 * The document types whose generator can actually be refused, and the
 * capability key each one resolves to.
 *
 * Only four of the seven registered `documents.generate-*` rules can return a
 * blocking state; the rest warn at most and could never throw. A type that is
 * not here therefore has nothing to assert — a lookup miss is the normal answer
 * for GENERAL, PRD, PROPOSAL and the rest, not a missing registration.
 */
const GATED_DOCUMENT_CAPABILITY_KEYS: Readonly<Record<string, string>> = {
	ARCHITECTURE: "documents.generate-architecture",
	TECHNICAL_SPEC: "documents.generate-tech-spec",
	API_SPEC: "documents.generate-api-spec",
	QA_STRATEGY: "documents.generate-qa-strategy",
};

/**
 * The largest per-run instruction string either dispatch path will accept.
 *
 * Lives here rather than beside one schema because both entry points feed the
 * same run: `createDocument` sends it on the create hop and `generateDocument`
 * on the regenerate hop. A bound on one of them is not a bound — a caller
 * simply uses the other door.
 *
 * Instructions are prose a human types to steer a single run, not a document.
 * Ten thousand characters is several pages of them.
 */
export const MAX_RUN_INSTRUCTIONS_CHARS = 10_000;

/**
 * Hex characters of the input digest carried in the workflow id.
 *
 * Sixteen is the repo's convention for a short deterministic key segment (see
 * `shortHash` in packages/temporal/src/lib/redis-cache.ts): 64 bits is far more
 * than enough to separate the handful of distinct generation requests one
 * document ever sees, and a full digest makes the id unreadable in the Temporal
 * UI for no gain.
 */
const WORKFLOW_ID_HASH_CHARS = 16;

/** Statuses of a run that may still write the document. */
const LIVE_DOCUMENT_STATUSES: ReadonlySet<string> = new Set([
	"QUEUED",
	"GENERATING",
]);

export interface DispatchDocumentGenerationInput {
	documentId: string;
	projectId: string;
	documentType: string;
	userId: string;
	/**
	 * Taken from the project record's own organization, never from a
	 * client-supplied identifier: it drives provider resolution and usage
	 * attribution for the run.
	 */
	organizationId?: string;
	/** Additional instructions for this run only. */
	prompt?: string;
	promptId?: string;
	promptVersionId?: string;
	/** Existing content, so a regeneration knows what it is replacing. */
	currentDocument?: string;
	/**
	 * Source text the user supplied moments ago, already neutralized, bounded,
	 * and wrapped in the shared attachment envelope by `supplied-context.ts`.
	 * Delivered directly because retrieval is similarity-scoped and may not have
	 * indexed it yet — a run could otherwise silently ignore the very material
	 * the user just pasted.
	 */
	suppliedContext?: string;
	/**
	 * The context row created for this run, filtered out of the run's retrieval
	 * result so the same text is not delivered twice.
	 *
	 * Held server-side across create and dispatch and keyed off the document
	 * rather than accepted from the caller: a client-supplied id here would let
	 * a caller suppress arbitrary project context from someone else's run.
	 */
	excludeContextId?: string;
	/**
	 * A person asked for this run in the product (the editor's regenerate or
	 * the Documents tab), so it may run on their own ChatGPT plan (Fizzy
	 * #2939). Unset for every other caller.
	 */
	planEligible?: boolean;
	/**
	 * The caller already ran {@link assertDocumentGenerationAvailable} — the
	 * type's capability and, for a Proposal, its bound Main prompt — before a
	 * write that changes the answer. Server-internal: no procedure schema
	 * carries it.
	 *
	 * The create route needs it. Creating a document stands down every active
	 * document of the same type, and an existing one may be the very source
	 * that grounded this generation — so a gate re-read after that write
	 * refuses the run the gate had just allowed, and the person is left with
	 * their document demoted and an empty draft in its place. That route
	 * asserts BEFORE the write instead and says so here. Every other caller
	 * leaves it unset and is asserted below as before.
	 */
	capabilityAlreadyAsserted?: boolean;

	// NOTE — deliberately absent: `skipDependencyWait`. The workflow input
	// carries that flag for exactly one in-process caller (the ingestion
	// workflow that spawns a generation as its own child, which would otherwise
	// wait on the extraction that produced it). Accepting it here, or on either
	// procedure's zod schema, would put a "generate anyway" switch on the public
	// API and let a client walk straight past the queue this feature exists to
	// enforce.
}

/**
 * What a dispatch did. Discriminated on `outcome` because the answers need
 * different surfaces: a new run, someone else's run that is already underway,
 * a start whose outcome is unknown (treated as started: the row is queued for
 * it), and a live run this request could not confirm (nothing was started or
 * written; try again).
 */
export type DispatchDocumentGenerationResult =
	| {
			/** A run was started by this call. */
			outcome: "started";
			workflowId: string;
			runId: string;
			message: string;
	  }
	| {
			/**
			 * An equivalent run already holds this workflow id, so Temporal
			 * refused the duplicate start. Named "in progress" rather than
			 * "queued" on purpose: the live run may well have moved past its
			 * dependency wait already, and only the document's own status can
			 * say which — the surface reads that, it does not infer it here.
			 */
			outcome: "alreadyInProgress";
			workflowId: string;
			runId: null;
			message: string;
	  }
	| {
			/**
			 * This request's own start threw and Temporal could not say
			 * whether it registered. The row is already marked QUEUED for this
			 * attempt, so a caller treats it as started and keeps watching the
			 * document; see the branch in `startGeneration`.
			 */
			outcome: "statusUnknown";
			workflowId: string;
			runId: null;
			message: string;
	  }
	| {
			/**
			 * A client-document Proposal's row names a live run other than the
			 * one this request would start, and Temporal could not say whether
			 * that run still goes (Fizzy #2946). Nothing was started and
			 * nothing was written: a caller says the state could not be
			 * confirmed and lets the person try again. `workflowId` is the
			 * stored run's, not this request's.
			 */
			outcome: "liveRunUnknown";
			workflowId: string;
			runId: null;
			message: string;
	  };

/**
 * The workflow id for a generation request: the document, plus a digest of
 * everything that makes this request the request it is.
 *
 * Deterministic on purpose. With a `Date.now()` salt every repeat click minted
 * a fresh id, so two identical requests became two concurrent runs writing the
 * same document. Hashing the inputs instead means an equivalent repeat lands on
 * the live run's id and is refused by Temporal (`workflowIdConflictPolicy:
 * "FAIL"`), while a genuinely different request — a different prompt version,
 * different instructions, a different supplied source — gets its own id and
 * starts normally.
 *
 * Instructions are trimmed before hashing: surrounding whitespace is not a
 * different request, and a textarea supplies plenty of it.
 *
 * `aiToken` is excluded because it is minted inside `dispatchDocumentGeneration`
 * and differs on every call; folding it in would make the id unique again and
 * silently undo the whole mechanism.
 */
function buildGenerationWorkflowId(
	input: DispatchDocumentGenerationInput,
): string {
	const fingerprint = createHash("sha256")
		.update(
			canonicalize({
				projectId: input.projectId,
				documentId: input.documentId,
				documentType: input.documentType,
				userId: input.userId,
				organizationId: input.organizationId,
				promptId: input.promptId,
				promptVersionId: input.promptVersionId,
				instructions: input.prompt?.trim(),
				currentDocument: input.currentDocument,
				suppliedContext: input.suppliedContext,
				excludeContextId: input.excludeContextId,
			}),
		)
		.digest("hex")
		.slice(0, WORKFLOW_ID_HASH_CHARS);

	return `project-document-generation-${input.documentId}-${fingerprint}`;
}

/**
 * Why a Proposal generation would be refused before it is queued, or null
 * when nothing stops it (Fizzy #2801).
 *
 * With the Proposal artifact rollout gate on for the project's owning
 * organization, the run renders its Main Document from the prompt bound to
 * the client-only Main action and fails closed when nothing is bound — no
 * fallback to the combined Draft prompt or the built-in instructions. That
 * failure would otherwise surface only after the run was queued, as a FAILED
 * document; asking here turns it into an answer at the door. The plan
 * activity in the run stays authoritative: this is the early copy of the
 * same question, resolved the same way, for the same person.
 *
 * Every other type, a gate that is off, and a project with no organization
 * answer null without a read of the binding, so their runs are unchanged.
 */
export async function proposalPromptRefusal(input: {
	documentType: string;
	projectId: string;
	userId: string;
	/** The project's owning organization, never the session's. */
	organizationId: string | null;
}): Promise<string | null> {
	if (input.documentType !== "PROPOSAL" || !input.organizationId) {
		return null;
	}
	if (!(await isFeatureEnabled("PROPOSAL_ARTIFACT", input.organizationId))) {
		return null;
	}
	const bound = await findBoundProposalPrompt({
		userId: input.userId,
		organizationId: input.organizationId,
		projectId: input.projectId,
		action: PROPOSAL_CLIENT_MAIN_AGENT_KEY,
	});
	return bound
		? null
		: proposalPromptNotBoundMessage(PROPOSAL_CLIENT_MAIN_AGENT_KEY);
}

/**
 * Refuse a generation of this document type unless it can run: a Proposal
 * needs its Main prompt bound while the Proposal artifact is on (see
 * {@link proposalPromptRefusal}), and a type with a refusable capability needs
 * that capability.
 *
 * A no-op for a type with neither — see
 * {@link GATED_DOCUMENT_CAPABILITY_KEYS}.
 */
export async function assertDocumentGenerationAvailable(input: {
	documentType: string;
	projectId: string;
	userId: string;
	organizationId: string | null;
	/**
	 * The request carries source text of its own — pasted into the create
	 * dialog's source box — which is exactly what a "no source" soft block
	 * asks for. See `permitSoftBlock` on the assert.
	 */
	suppliesSource?: boolean;
}): Promise<void> {
	const refusal = await proposalPromptRefusal(input);
	if (refusal) {
		// The same code the run itself would fail with, so a client can
		// recognise the refusal without matching on its prose.
		throw new ORPCError("PRECONDITION_FAILED", {
			message: refusal,
			data: { code: PROPOSAL_PROMPT_NOT_BOUND },
		});
	}

	const capabilityKey = documentCapabilityKey(input.documentType);
	if (!capabilityKey) {
		return;
	}
	await assertCapabilityAvailable({
		capabilityKey,
		projectId: input.projectId,
		userId: input.userId,
		organizationId: input.organizationId,
		permitSoftBlock: input.suppliesSource ?? false,
	});
}

/** The refusable capability behind a document type, if it has one. */
export function documentCapabilityKey(
	documentType: string,
): string | undefined {
	return GATED_DOCUMENT_CAPABILITY_KEYS[documentType];
}

export async function dispatchDocumentGeneration(
	input: DispatchDocumentGenerationInput,
): Promise<DispatchDocumentGenerationResult> {
	// Both dispatch paths funnel through here, and so does every caller that
	// never rendered a button — the public API, MCP tools, agents.
	if (!input.capabilityAlreadyAsserted) {
		await assertDocumentGenerationAvailable({
			documentType: input.documentType,
			projectId: input.projectId,
			userId: input.userId,
			organizationId: input.organizationId ?? null,
		});
	}

	// Get Temporal client
	const pendingClient = getTemporalClient();

	// Issue AI token in the API layer where AI_TOKEN_SECRET is available
	// This token will be passed to Temporal activities for agent authentication.
	// Both start together; the client is awaited first, so its failure still
	// surfaces ahead of the token's.
	const pendingToken = issueAIToken({
		userId: input.userId,
		organizationId: input.organizationId,
		impersonated: isAiImpersonatedRequest(),
		source: "project-document-generation",
		// Use longer expiry for document generation (15 minutes)
		expirySeconds: 900,
		planEligible: input.planEligible,
	});
	// The token's rejection is read below, unless the client's comes first.
	pendingToken.catch(() => {});
	const client = await pendingClient;
	const aiToken = await pendingToken;

	const workflowId = buildGenerationWorkflowId(input);

	// A client-document Proposal joins a run that is still live instead of
	// replacing it, under a per-document lock (see the module comment).
	if (
		await isProposalClientDocument({
			organizationId: input.organizationId,
			documentType: input.documentType,
		})
	) {
		return await withLiveRunDispatchLock(
			input.documentId,
			async (current) =>
				(await joinLiveRun(client, current, workflowId)) ??
				(await startGeneration(client, input, workflowId, aiToken, {
					boundTemporalCalls: true,
					// `joinLiveRun` asked Temporal about a live row only when it
					// names a workflow; one that names none was never judged.
					liveRowJudged: Boolean(current?.workflowId),
				})),
		);
	}

	return await startGeneration(client, input, workflowId, aiToken);
}

type TemporalClient = Awaited<ReturnType<typeof getTemporalClient>>;

/**
 * The answer for a request that must join the document's live run instead of
 * starting one, or null when a run may start: the row is not QUEUED or
 * GENERATING, holds no workflow, holds the very workflow this request would
 * start (Temporal refuses that duplicate itself), or Temporal reports the
 * stored workflow gone ({@link workflowRunLiveness}: a paused run still holds
 * the document). Writes nothing.
 *
 * The stored id is the one the dispatch wrote at queue time until the run's
 * generation attempt claims the live preview; the claim then records the
 * generation workflow it runs in, so wizard, batch and setup runs, which never
 * pass through this dispatch, are joined too.
 */
async function joinLiveRun(
	client: TemporalClient,
	current: LiveRunDispatchState | null,
	workflowId: string,
): Promise<DispatchDocumentGenerationResult | null> {
	if (
		!current ||
		!LIVE_DOCUMENT_STATUSES.has(current.status) ||
		!current.workflowId ||
		current.workflowId === workflowId
	) {
		return null;
	}
	const liveness = await workflowRunLiveness(client, current.workflowId);
	if (liveness === "running") {
		return {
			outcome: "alreadyInProgress",
			workflowId: current.workflowId,
			runId: null,
			message: "Document generation already in progress",
		};
	}
	if (liveness === "unknown") {
		logger.warn(
			`[GenerateDocument] Could not tell whether workflow ${current.workflowId} still runs; not starting ${workflowId} over it`,
		);
		return {
			outcome: "liveRunUnknown",
			workflowId: current.workflowId,
			runId: null,
			message:
				"Could not confirm whether a generation of this document is still running; nothing was started",
		};
	}
	return null;
}

/** describe() gave no answer within its bound: an ambiguous outcome. */
class DescribeTimedOutError extends Error {
	constructor(workflowId: string) {
		super(
			`describe() for workflow ${workflowId} did not answer within ${WORKFLOW_RUN_LIVENESS_TIMEOUT_MS} ms`,
		);
		this.name = "DescribeTimedOutError";
	}
}

/**
 * Start the run under `workflowId` and mark the row QUEUED for it, with the
 * ordering and recovery the module comment describes.
 *
 * `boundTemporalCalls`: the call runs under a dispatch lock, so the start
 * gets {@link LIVE_RUN_START_DEADLINE_MS} and the post-failure describe()
 * {@link WORKFLOW_RUN_LIVENESS_TIMEOUT_MS}; an unanswered describe() is
 * ambiguous, like any other doubtful answer.
 *
 * `liveRowJudged`: under that lock `joinLiveRun` found the workflow a live
 * row names gone (or it is this request's own, which Temporal refuses while
 * it runs), so the queue mark may take such a row back.
 */
async function startGeneration(
	client: TemporalClient,
	input: DispatchDocumentGenerationInput,
	workflowId: string,
	aiToken: string,
	{
		boundTemporalCalls = false,
		liveRowJudged = false,
	}: { boundTemporalCalls?: boolean; liveRowJudged?: boolean } = {},
): Promise<DispatchDocumentGenerationResult> {
	// This attempt's identity, minted here rather than by the queue write
	// because the workflow has to be told it at start time: the run's own
	// QUEUED → GENERATING flip is scoped to this exact value, and the queue
	// write cannot happen until we know the start was not refused as a
	// duplicate. Both ends therefore carry the same timestamp by construction.
	const attemptStartedAt = new Date();

	const startRun = () =>
		client.workflow.start(
			"projectDocumentGenerationWorkflow",
			withCorrelationMemo({
				taskQueue: "project-documents",
				workflowId,
				// At most one LIVE run per equivalent request: a duplicate start
				// is rejected with WorkflowExecutionAlreadyStartedError rather
				// than silently taking over.
				workflowIdConflictPolicy: "FAIL",
				// ALLOW_DUPLICATE is load-bearing, not an inherited default. The
				// id is now stable forever, so every regeneration with identical
				// settings reuses it; anything stricter would let a document be
				// generated once and then never again, because the CLOSED prior
				// run still owns the id.
				workflowIdReusePolicy: "ALLOW_DUPLICATE",
				args: [
					{
						projectId: input.projectId,
						documentId: input.documentId,
						documentType: input.documentType,
						userId: input.userId,
						organizationId: input.organizationId,
						aiToken, // Pass pre-issued token to workflow
						prompt: input.prompt,
						promptId: input.promptId, // Pass custom prompt ID
						promptVersionId: input.promptVersionId, // Pass prompt version for attribution
						currentDocument: input.currentDocument, // Pass current content for regeneration context
						suppliedContext: input.suppliedContext, // Joined into the context array, never over it
						excludeContextId: input.excludeContextId, // Filtered out of this run's retrieval
						// This attempt's identity. Without it the run SKIPS its
						// QUEUED → GENERATING flip entirely — the document
						// queues and never starts generating.
						generationStartedAt: attemptStartedAt.toISOString(),
						planEligible: input.planEligible,
					},
				],
			}),
		);

	let handle: Awaited<ReturnType<typeof client.workflow.start>> | undefined;
	let workflowStartError: unknown;
	try {
		handle = boundTemporalCalls
			? await client.withDeadline(
					Date.now() + LIVE_RUN_START_DEADLINE_MS,
					startRun,
				)
			: await startRun();
	} catch (startError) {
		// Checked BEFORE the describe() probe below, and it has to be: the
		// probe would resolve — the other run is genuinely live — and this call
		// would report "Document generation started", a silent success where
		// the caller needs to know its request joined an existing run rather
		// than beginning one. Nothing is marked here either; the live attempt's
		// `generationStartedAt` is its own identity and must not be replaced.
		if (startError instanceof WorkflowExecutionAlreadyStartedError) {
			return {
				outcome: "alreadyInProgress",
				workflowId,
				runId: null,
				message: "Document generation already in progress",
			};
		}
		// No flag beside this: `handle` is assigned only on success and this
		// path does not return, so `handle` being undefined below IS the
		// failure — a second variable could only ever disagree with it.
		workflowStartError = startError;
	}

	// Past the duplicate check this attempt owns the run — either it started,
	// or it failed in a way that may still have registered it with Temporal —
	// so the row is marked for THIS attempt, carrying the workflow id.
	//
	// The workflow id is persisted because nothing else on this path writes it
	// and the stale-generation watchdog's liveness check reads it: QUEUED has
	// no age ceiling (a dependency wait can legitimately run for an hour), so
	// that check is the only thing that can ever recover an orphaned queued row
	// — including one this function leaves behind in the unknown-outcome branch
	// below.
	//
	// The mark must land: the run takes its row by this attempt's identity
	// before its model call and stops as superseded when the row never names
	// it. A write that owns no run (a title edit, an embed stamp, a save)
	// landing during the start declines the freshness mark, so the mark takes
	// the row back by identity (`reclaim`). A newer attempt's stamp stands. A
	// row still QUEUED or GENERATING under an older attempt is taken only
	// under the lock, where `joinLiveRun` has already found the workflow it names
	// gone; elsewhere it may be a run that is still writing, and the decline
	// stands as before. A mark that matches nothing else (the row was
	// deleted, or moved under the retry) fails this request rather than
	// reporting a run that will stop on its own.
	const queued = await markDocumentGenerationQueued(input.documentId, {
		generationStartedAt: attemptStartedAt,
		workflowId,
		reclaim: { liveRowJudged },
	});
	if (!queued.applied) {
		logger.warn(
			`[GenerateDocument] Queue mark for workflow ${workflowId} declined (${queued.declinedFor ?? "unknown"})`,
		);
		if (queued.declinedFor === "unowned") {
			throw new Error(
				`Document ${input.documentId} could not be queued for workflow ${workflowId}`,
			);
		}
	}

	if (handle) {
		return {
			outcome: "started",
			workflowId: handle.workflowId,
			runId: handle.firstExecutionRunId,
			message: "Document generation started",
		};
	}

	// `workflow.start` can throw even though Temporal actually
	// registered the workflow — a lost response on our end, or a
	// start racing an identical workflowId already in flight. We
	// probe existence with describe() and act on a TRI-STATE
	// outcome, mirroring `livenessOf` in
	// packages/temporal/src/activities/publishing-suggestion/dispatch-suggestion.ts:82
	// (same distinction, same reasoning):
	//
	//   - describe() resolves → the workflow is live → treat the
	//     start as having succeeded (return success) so the row
	//     stays queued and the editor keeps polling it.
	//   - describe() throws WorkflowNotFoundError → the workflow
	//     demonstrably never started → write FAILED and rethrow.
	//   - describe() throws anything else (deadline exceeded,
	//     connection reset, namespace hiccup) → UNKNOWN. See
	//     below for how this is handled — it is NOT the same as
	//     the definite-absence case.
	let liveDescription: Awaited<
		ReturnType<ReturnType<typeof client.workflow.getHandle>["describe"]>
	> | null = null;
	// Separate discriminant from the captured value: a rejection
	// can carry ANY value, including a falsy one (undefined, "",
	// 0), and a falsy rejection is still an ambiguous outcome —
	// only WorkflowNotFoundError proves absence.
	let describeWasAmbiguous = false;
	let ambiguousDescribeError: unknown = null;
	const describeRun = () => client.workflow.getHandle(workflowId).describe();
	let describeTimer: ReturnType<typeof setTimeout> | undefined;
	try {
		liveDescription = boundTemporalCalls
			? await Promise.race([
					describeRun(),
					new Promise<never>((_resolve, reject) => {
						describeTimer = setTimeout(
							() => reject(new DescribeTimedOutError(workflowId)),
							WORKFLOW_RUN_LIVENESS_TIMEOUT_MS,
						);
					}),
				])
			: await describeRun();
	} catch (describeError) {
		if (!(describeError instanceof WorkflowNotFoundError)) {
			describeWasAmbiguous = true;
			ambiguousDescribeError = describeError;
		}
	} finally {
		clearTimeout(describeTimer);
	}

	if (liveDescription) {
		return {
			outcome: "started",
			workflowId,
			runId: liveDescription.runId,
			message: "Document generation started",
		};
	}

	if (describeWasAmbiguous) {
		// UNKNOWN: we cannot tell whether the workflow started or
		// not. Deliberately return success-like instead of
		// rethrowing. Rethrowing would land in the client's
		// onError, which stops polling and re-enables the
		// Regenerate button — and if the workflow actually DID
		// start (lost response + this transient describe
		// failure), the user could immediately fire a SECOND
		// workflow racing the live one over the same document.
		// That duplicate-concurrent-write outcome is strictly
		// worse than a bounded wait, so instead we keep the
		// client in its regenerating/polling state and let both
		// real outcomes resolve themselves: if the workflow did
		// start, its own milestone writes flip the row and
		// polling picks them up; if it never started, the row
		// stays queued and the client's existing 5-minute
		// safety timer surfaces the soft "taking longer than
		// expected" notice instead of a hard error. The
		// deliberate cost: when Temporal is briefly down AND the
		// start truly failed, the user waits out the safety
		// timer instead of getting an instant error — accepted,
		// because the alternative risks a live run being raced.
		// The row left behind is the one case the watchdog's
		// workflow-id liveness check exists to sweep up.
		logger.warn(
			`[GenerateDocument] Ambiguous describe() outcome for workflow ${workflowId} after workflow.start threw — not marking FAILED (start error: ${
				workflowStartError instanceof Error
					? workflowStartError.message
					: String(workflowStartError)
			}; describe error: ${
				ambiguousDescribeError instanceof Error
					? ambiguousDescribeError.message
					: String(ambiguousDescribeError)
			})`,
		);
		return {
			outcome: "statusUnknown",
			workflowId,
			runId: null,
			message: "Document generation status unknown; treating as started",
		};
	}

	// The workflow never got a chance to write its own FAILED status
	// (it genuinely never started), so without this the row stays on
	// QUEUED forever — and QUEUED has no age ceiling for the watchdog
	// to measure against. Attempt-scoped via attemptStartedAt: if a
	// newer retry has already re-marked the row, this write is a
	// no-op instead of clobbering that more current state (see
	// markDocumentGenerationFailed's doc comment).
	//
	// Residual accepted sliver: `generationStartedAt` has
	// millisecond precision and is not on its own a collision-proof
	// attempt identity. A same-millisecond concurrent attempt is
	// still caught, though — an equivalent one is refused outright by
	// the deterministic workflow id above, and any other shares this
	// exact describe() existence check, which would find the OTHER
	// attempt's live workflow and take the early-return branch
	// instead of reaching this write. We deliberately do not add a
	// dedicated attempt-id column just to close that already-covered
	// gap.
	//
	// Best-effort — if this write also fails, the original error
	// still surfaces at the caller's procedure boundary. Never leak
	// internal error details into the persisted message the editor
	// renders.
	await markDocumentGenerationFailed(
		input.documentId,
		attemptStartedAt,
		"Failed to start document generation",
	).catch(() => {
		// non-fatal — surfaced via the rethrow below.
	});
	throw workflowStartError;
}
