/**
 * The one place a project-document generation run is started.
 *
 * Two procedures now dispatch generation — the editor's regenerate action and
 * the Documents tab's create-and-generate call — and the ordering and recovery
 * rules below are the kind that rot silently when a second copy exists. In
 * particular the mark-GENERATING-before-`workflow.start` ordering is not a style
 * choice: it was issue #720, where a failed run left the row FAILED with a stale
 * error, the editor's poller had nothing to watch, and the "Regenerating…"
 * spinner hung until a five-minute safety timer. A second call site that started
 * the workflow first would reintroduce exactly that, and no test in the original
 * file would notice.
 *
 * Failures propagate raw. The caller — a procedure boundary — logs the real
 * cause and throws a fixed generic message, because everything in here is
 * infrastructure (Temporal client, token issuance, workflow start) whose errors
 * can carry hosts, connection strings, and provider messages that must never
 * reach a toast.
 */

import { issueAIToken } from "@repo/ai-token";
import {
	markDocumentGenerationFailed,
	markDocumentGenerationStarted,
} from "@repo/database/prisma/queries/projects/documents";
import { logger } from "@repo/logs";
import { getTemporalClient } from "@repo/temporal";
import { WorkflowNotFoundError } from "@temporalio/client";
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
}

export interface DispatchDocumentGenerationResult {
	workflowId: string;
	/** Null only in the ambiguous-outcome case below, where no run id is knowable. */
	runId: string | null;
	message: string;
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

	// Start workflow
	const workflowId = `project-document-generation-${input.documentId}-${Date.now()}`;

	// Mark the row as generating immediately before starting the
	// workflow — see markDocumentGenerationStarted's doc comment for
	// why the ordering here is deliberate (issue #720: without this, a
	// failed run left the row FAILED with the stale error, the editor's
	// poller had nothing to watch, and the "Regenerating…" spinner
	// stuck around until the 5-minute safety timeout).
	const startedDocument = await markDocumentGenerationStarted(
		input.documentId,
	);
	// The `generationStartedAt` we just wrote is THIS attempt's
	// identity — passed to markDocumentGenerationFailed below so a
	// failure write can only ever apply to this exact attempt (see
	// that function's doc comment). Non-null: we just set this field
	// in the update above.
	const attemptStartedAt = startedDocument.generationStartedAt as Date;

	let handle: Awaited<ReturnType<typeof client.workflow.start>>;
	try {
		handle = await client.workflow.start(
			"projectDocumentGenerationWorkflow",
			withCorrelationMemo({
				taskQueue: "project-documents",
				workflowId,
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
					},
				],
			}),
		);
	} catch (workflowStartError) {
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
		//     stays GENERATING and the editor keeps polling it.
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
			// stays GENERATING and the client's existing 5-minute
			// safety timer surfaces the soft "taking longer than
			// expected" notice instead of a hard error. The
			// deliberate cost: when Temporal is briefly down AND the
			// start truly failed, the user waits out the safety
			// timer instead of getting an instant error — accepted,
			// because the alternative risks a live run being raced.
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
				workflowId,
				runId: null,
				message:
					"Document generation status unknown; treating as started",
			};
		}

		// The workflow never got a chance to write its own FAILED status
		// (it genuinely never started), so without this the row stays on
		// GENERATING forever. Attempt-scoped via attemptStartedAt: if a
		// newer retry has already re-marked the row, this write is a
		// no-op instead of clobbering that more current state (see
		// markDocumentGenerationFailed's doc comment).
		//
		// Residual accepted sliver: `generationStartedAt` has
		// millisecond precision and is not on its own a collision-proof
		// attempt identity. A same-millisecond concurrent attempt is
		// still caught, though — it shares this exact describe()
		// existence check above, which would find the OTHER attempt's
		// live workflow and take the early-return branch instead of
		// reaching this write. We deliberately do not add a dedicated
		// attempt-id column just to close that already-covered gap.
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

	return {
		workflowId: handle.workflowId,
		runId: handle.firstExecutionRunId,
		message: "Document generation started",
	};
}
