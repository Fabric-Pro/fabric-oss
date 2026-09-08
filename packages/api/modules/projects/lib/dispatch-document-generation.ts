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
 * no longer needed to protect a fast-failing run's own FAILED write.
 *
 * That guard is a freshness window, not a status check, and the difference is
 * the whole point: refusing terminal rows looked equivalent and was not, because
 * regeneration BEGINS from a terminal row. Guarding on status meant every
 * regenerate — the only path the list offers, on exactly COMPLETE and FAILED
 * documents — had its queue mark silently declined, so the wait this feature
 * exists to show was never visible on the path users actually take.
 *
 * Failures propagate raw. The caller — a procedure boundary — logs the real
 * cause and throws a fixed generic message, because everything in here is
 * infrastructure (Temporal client, token issuance, workflow start) whose errors
 * can carry hosts, connection strings, and provider messages that must never
 * reach a toast.
 */

import { createHash } from "node:crypto";
import { issueAIToken } from "@repo/ai-token";
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
	WorkflowExecutionAlreadyStartedError,
	WorkflowNotFoundError,
} from "@temporalio/client";
import { withCorrelationMemo } from "../../../lib/temporal-correlation";

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

	// NOTE — deliberately absent: `skipDependencyWait`. The workflow input
	// carries that flag for exactly one in-process caller (the ingestion
	// workflow that spawns a generation as its own child, which would otherwise
	// wait on the extraction that produced it). Accepting it here, or on either
	// procedure's zod schema, would put a "generate anyway" switch on the public
	// API and let a client walk straight past the queue this feature exists to
	// enforce.
}

/**
 * What a dispatch did. Discriminated on `outcome` because the three answers
 * need different surfaces: a new run, someone else's run that is already
 * underway, and "we could not tell".
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
			/** The start's real outcome is unknown; see the branch below. */
			outcome: "statusUnknown";
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

export async function dispatchDocumentGeneration(
	input: DispatchDocumentGenerationInput,
): Promise<DispatchDocumentGenerationResult> {
	// Get Temporal client
	const client = await getTemporalClient();

	// Issue AI token in the API layer where AI_TOKEN_SECRET is available
	// This token will be passed to Temporal activities for agent authentication
	const aiToken = await issueAIToken({
		userId: input.userId,
		organizationId: input.organizationId,
		source: "project-document-generation",
		// Use longer expiry for document generation (15 minutes)
		expirySeconds: 900,
	});

	const workflowId = buildGenerationWorkflowId(input);

	// This attempt's identity, minted here rather than by the queue write
	// because the workflow has to be told it at start time: the run's own
	// QUEUED → GENERATING flip is scoped to this exact value, and the queue
	// write cannot happen until we know the start was not refused as a
	// duplicate. Both ends therefore carry the same timestamp by construction.
	const attemptStartedAt = new Date();

	let handle: Awaited<ReturnType<typeof client.workflow.start>> | undefined;
	let workflowStartError: unknown;
	try {
		handle = await client.workflow.start(
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
					},
				],
			}),
		);
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
	// `applied: false` is not an error: it means the run already terminalized
	// the row (a dependency probe that failed inside the first second), and the
	// guard exists precisely so that answer stands.
	await markDocumentGenerationQueued(input.documentId, {
		generationStartedAt: attemptStartedAt,
		workflowId,
	});

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
	try {
		liveDescription = await client.workflow
			.getHandle(workflowId)
			.describe();
	} catch (describeError) {
		if (!(describeError instanceof WorkflowNotFoundError)) {
			describeWasAmbiguous = true;
			ambiguousDescribeError = describeError;
		}
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
