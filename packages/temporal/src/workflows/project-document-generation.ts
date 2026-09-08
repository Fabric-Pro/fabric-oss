/**
 * ProjectDocumentGenerationWorkflow
 *
 * Parent workflow for single document generation/regeneration.
 * Delegates core document generation to documentGenerationChildWorkflow
 * while handling:
 * - AgentTask creation and tracking
 * - ProjectWorkflowStatus updates
 * - Detailed logging and metrics
 *
 * Document Evaluation:
 * - Evaluation runs as a fire-and-forget child workflow (documentEvalWorkflow)
 * - Parent doesn't wait for eval - it starts eval and completes immediately
 * - Eval results are persisted independently to the database
 *
 * Use cases:
 * - Regenerating an existing document
 * - Generating a single document with custom prompt
 */

import {
	ApplicationFailure,
	executeChild,
	log,
	ParentClosePolicy,
	patched,
	proxyActivities,
	sleep,
	startChild,
	workflowInfo,
} from "@temporalio/workflow";
import type * as activities from "../activities";
import type {
	ProjectDocumentGenerationInput,
	ProjectDocumentGenerationOutput,
} from "../types";
import { documentEvalWorkflow } from "./document-eval";
import { documentGenerationChildWorkflow } from "./document-generation-child";

// Activities for status tracking (not document generation - that's in child workflow)
const {
	createAgentTask,
	updateAgentTaskWorkflow,
	updateAgentTaskStatus,
	updateProjectWorkflowStatus,
} = proxyActivities<typeof activities>({
	startToCloseTimeout: "1m",
	retry: {
		initialInterval: "1s",
		maximumInterval: "30s",
		backoffCoefficient: 2,
		maximumAttempts: 3,
	},
});

/**
 * The queue's own activities: the dependency probe, the re-authorization and
 * token re-issue that follow a wait, and the status writes that tell the
 * document's reader what it is waiting for and how the attempt ended.
 *
 * Separate from the tracking proxy above only because the retry policy is a
 * different judgement. Every one of these is a short indexed query, and the
 * probe in particular runs once per poll for as long as the wait lasts — a
 * transient database blip must not fail a run that is otherwise healthy, so it
 * retries a little longer than a status write does.
 */
const {
	assertRequesterMayGenerate,
	failGenerationRun,
	issueGenerationToken,
	probeGenerationDependencies,
	recordGenerationQueueReason,
	startGenerationRun,
} = proxyActivities<typeof activities>({
	startToCloseTimeout: "1m",
	retry: {
		initialInterval: "1s",
		maximumInterval: "30s",
		backoffCoefficient: 2,
		maximumAttempts: 5,
	},
});

/**
 * Job Hub bookkeeping for this run.
 *
 * Its own proxy because its failure budget is a different judgement from the
 * queue's: the row is observational, so a write that will not land has to give
 * up quickly rather than hold a generation open retrying it.
 *
 * These are ACTIVITIES and have to be — `job-progress` resolves the row from
 * the activity context, so the same writes issued from this file would take its
 * "outside an activity" branch and silently do nothing.
 */
const { reportGenerationJobOpened, reportGenerationJobStep } = proxyActivities<
	typeof activities
>({
	startToCloseTimeout: "30s",
	retry: {
		initialInterval: "1s",
		maximumInterval: "5s",
		backoffCoefficient: 2,
		maximumAttempts: 2,
	},
});

/**
 * The one message the requester actually reads.
 *
 * Its own proxy because its failure budget sits between the other two. It is
 * worth retrying past a database blip — a queued run can finish an hour after
 * the person who asked for it closed the tab, and a document that generated and
 * told nobody is the failure this write exists to prevent — but it is not worth
 * holding a finished run open for, so the ceiling stays low and both call sites
 * swallow whatever comes out of it.
 */
const { notifyGenerationOutcome } = proxyActivities<typeof activities>({
	startToCloseTimeout: "30s",
	retry: {
		initialInterval: "1s",
		maximumInterval: "10s",
		backoffCoefficient: 2,
		maximumAttempts: 3,
	},
});

/**
 * Run one Job Hub write and swallow whatever it does.
 *
 * The row exists so a queued generation stops looking like a lost request, and
 * it is worth nothing if failing to write it can fail the generation. Every
 * call site goes through here — including the ones on the terminal paths, where
 * throwing would replace the run's real outcome with a bookkeeping error.
 */
async function reportJob(write: () => Promise<void>): Promise<void> {
	try {
		await write();
	} catch (jobError) {
		log.warn("Job Hub bookkeeping write failed (non-fatal)", {
			error:
				jobError instanceof Error ? jobError.message : "Unknown error",
		});
	}
}

/**
 * How long the queue waits between dependency probes, and the ceiling that
 * interval widens to.
 *
 * Ten seconds so an extraction that is nearly done is picked up almost at once;
 * doubling to five minutes so an hour-long codebase index costs a dozen probes
 * rather than hundreds. Both are constants rather than environment reads: a
 * value that changed between a run's first poll and its second would replay
 * differently and break the run it was meant to tune.
 */
const DEPENDENCY_PROBE_INITIAL_DELAY_MS = 10_000;
const DEPENDENCY_PROBE_MAX_DELAY_MS = 300_000;

/**
 * How long the token re-minted after a wait is good for.
 *
 * The API's dispatch mints for exactly this, and the two have to agree: a run
 * that queued is not a shorter run than one that did not, it is a longer one.
 * The generation child's activity allows fifteen minutes per attempt with five
 * attempts behind it, so anything less turns the wait itself into a new way for
 * a healthy run to fail.
 */
const GENERATION_TOKEN_EXPIRY_SECONDS = 900;

/**
 * How long this run will wait for its OWN queue write to become visible.
 *
 * The dispatcher stamps the row QUEUED after `workflow.start` returns, so the
 * two race across processes whenever the wait is short. Short, bounded, and
 * generous enough for a database round trip that has already been issued —
 * this is waiting for a write in flight, not polling for a state change.
 */
const QUEUE_WRITE_VISIBILITY_ATTEMPTS = 5;
const QUEUE_WRITE_VISIBILITY_DELAY_MS = 1_000;

/**
 * The failure type for a wait that will not clear.
 *
 * Non-retryable in both of its cases, and for the same reason: nothing about
 * re-running this workflow changes the rows the probe just read. A required
 * input that failed for good has failed for good, and a run that has waited as
 * long as one execution may would only start the same wait again.
 */
const DEPENDENCY_BLOCKED_FAILURE_TYPE = "DOCUMENT_GENERATION_BLOCKED";

/**
 * The type `assertRequesterMayGenerate` refuses with.
 *
 * Spelled out rather than imported from the activity: what crosses the activity
 * boundary is a serialized failure carrying a type STRING, not the activity's
 * own constant, so the value is the contract either way.
 */
const NOT_AUTHORIZED_FAILURE_TYPE = "DOCUMENT_GENERATION_NOT_AUTHORIZED";

/**
 * The type a run refuses with when the row stopped being its own mid-wait.
 *
 * Non-retryable for the same reason as the others: a superseded attempt is
 * superseded permanently, and retrying would only race whoever replaced it.
 */
const SUPERSEDED_FAILURE_TYPE = "DOCUMENT_GENERATION_SUPERSEDED";

/**
 * The failures whose message this run wrote itself, and may therefore repeat.
 *
 * A run ends badly for two very different kinds of reason. The refusals above
 * are sentences written FOR the person waiting — which category is outstanding,
 * that their access lapsed — and showing one is the whole reason it is phrased
 * as a sentence. Everything else is whatever a model call, a provider SDK or a
 * database driver produced, and that can carry hostnames, deployment names and
 * internal ids. `emitDocumentGenerationNotification` already refuses to quote
 * any of it into the bell; this list is the same judgement for the two surfaces
 * that do render a string — the document row and the Job Hub card.
 */
const SELF_WRITTEN_FAILURE_TYPES: readonly string[] = [
	DEPENDENCY_BLOCKED_FAILURE_TYPE,
	NOT_AUTHORIZED_FAILURE_TYPE,
	SUPERSEDED_FAILURE_TYPE,
];

/** What a failure this run did not write is allowed to say instead. */
const GENERIC_FAILURE_MESSAGE =
	"Document generation failed. You can run it again.";

/**
 * The sentence a user may be shown for a caught failure.
 *
 * Walks the cause chain because an activity's `ApplicationFailure` never
 * arrives as the top-level error: `assertRequesterMayGenerate`'s refusal is
 * wrapped in an `ActivityFailure` by the time the workflow sees it, while the
 * dependency refusal is thrown in workflow code and is the error itself. Both
 * have to be recognised by the same predicate.
 *
 * Bounded rather than `while (cause)` so a self-referential `cause` — which a
 * third-party error is free to construct — cannot spin a workflow task.
 */
function readableFailureMessage(err: unknown): string {
	let cause: unknown = err;
	for (let depth = 0; depth < 8 && cause instanceof Error; depth += 1) {
		if (
			cause instanceof ApplicationFailure &&
			cause.type &&
			SELF_WRITTEN_FAILURE_TYPES.includes(cause.type)
		) {
			return cause.message;
		}
		cause = cause.cause;
	}
	return GENERIC_FAILURE_MESSAGE;
}

/**
 * ProjectDocumentGenerationWorkflow
 *
 * Generates a project document using RAG contexts and LangGraph agent.
 * This is the parent workflow that handles tracking and status updates.
 *
 * @param input - Workflow input containing project and document details
 * @returns Workflow output with generated document
 */
export async function projectDocumentGenerationWorkflow(
	input: ProjectDocumentGenerationInput,
): Promise<ProjectDocumentGenerationOutput> {
	const {
		projectId,
		documentId,
		documentType,
		userId,
		organizationId,
		prompt,
		promptId,
		promptVersionId,
		currentDocument,
		suppliedContext,
		excludeContextId,
		generationStartedAt,
		skipDependencyWait,
	} = input;
	// Not `const`. The dispatch mints this token for a fifteen-minute run, and
	// the dependency wait below can outlast that several times over — a run that
	// actually waited continues under a freshly issued one, and the child is
	// handed whichever is current when it starts.
	let { aiToken } = input;
	const { workflowId, runId } = workflowInfo();
	const startTime = Date.now();

	log.info("🚀 WORKFLOW STARTED: Project Document Generation", {
		projectId,
		documentId,
		documentType,
		userId,
		organizationId,
		workflowId,
		runId,
		hasCustomPrompt: !!promptId,
		hasCurrentDocument: !!currentDocument,
		isRegeneration: !!currentDocument,
		hasSuppliedContext: !!suppliedContext,
		status: "started",
		timestamp: new Date().toISOString(),
	});

	let agentTaskId: string | undefined;

	/** Which step the row is showing as running, so a failure can close THAT one. */
	let currentJobStep = "awaitContext";

	try {
		// Create AgentTask record for tracking
		try {
			const agentTask = await createAgentTask({
				agentId: "project_document_generator",
				userId,
				organizationId,
				status: "PENDING",
				stage: "initializing",
				input: {
					projectId,
					documentId,
					documentType,
					prompt,
				},
				framework: "langgraph",
			});
			agentTaskId = agentTask.id;

			await updateAgentTaskWorkflow({
				id: agentTaskId,
				workflowId,
				runId,
			});

			await updateAgentTaskStatus({
				id: agentTaskId,
				status: "RUNNING",
			});

			log.info("AgentTask created", { agentTaskId });
		} catch (taskError) {
			log.warn(
				"Failed to create AgentTask, continuing without tracking",
				{
					error:
						taskError instanceof Error
							? taskError.message
							: "Unknown error",
				},
			);
		}

		// Update workflow status to RUNNING
		log.info("Updating workflow status to RUNNING");
		await updateProjectWorkflowStatus(
			projectId,
			workflowId,
			runId,
			"RUNNING",
		);

		// Wait for the project's own context-building work before generating.
		//
		// Gated by `patched()` because it inserts commands into the stream: an
		// activity call on every run, and a timer on every run that actually
		// waits. A history recorded before this shipped replays with the gate
		// false and goes straight to the child — which is precisely what it did.
		if (patched("document-generation-dependency-wait-2026-09-07")) {
			// The Job Hub row, opened only now that the workflow is running.
			// Never from the dispatcher before the start: a row created ahead
			// of a start that then fails leaves a card nobody will ever close,
			// and this workflow id is reused across attempts, so the incoming
			// run's row would be written to by the superseded run's activities.
			// The same ordering, for the same reasons, is spelled out at
			// `code-indexing-trigger.ts`.
			await reportJob(() =>
				reportGenerationJobOpened({
					projectId,
					documentId,
					documentType,
					userId,
					organizationId,
				}),
			);
			// The wait is the run's first step, so the row says so from the
			// outset: "Wait for project context — Running" is the sentence the
			// panel shows instead of silence.
			await reportJob(() =>
				reportGenerationJobStep({
					documentId,
					step: "awaitContext",
					status: "running",
				}),
			);

			// `!generationStartedAt` is an IMPLICIT skip, and it is what makes
			// this worker safe to deploy before the API that feeds it.
			// `patched()` gates the replay of an EXISTING history, not the
			// version of the caller: a brand-new execution takes this branch
			// even when a pre-deploy dispatcher started it, and that dispatcher
			// marked the row GENERATING up front and sent no attempt identity.
			// Waiting there would be wrong twice over — the QUEUED → GENERATING
			// flip has nothing to scope itself to, so the row reads GENERATING
			// for the whole wait, and the stale sweep then measures that against
			// its thirty-minute ceiling and fails a LIVE run, its liveness check
			// skipped because the old dispatcher wrote no `workflowId` either.
			// Going straight to the child is exactly what that dispatcher
			// expects, so deploy order stops being a runbook step.
			if (skipDependencyWait || !generationStartedAt) {
				// `skipDependencyWait` means the caller is the ingestion that
				// produced this run's source. Probing there would wait on that
				// very extraction: a deadlock, not a queue. See
				// `ProjectDocumentGenerationInput`.
				log.info("Dependency wait skipped", {
					documentId,
					documentType,
					reason: skipDependencyWait
						? "the calling workflow opted out"
						: "no attempt identity — started by an older dispatcher",
				});
			} else {
				let delayMs = DEPENDENCY_PROBE_INITIAL_DELAY_MS;
				let recordedReason: string | undefined;
				let waited = false;

				for (;;) {
					const dependencies = await probeGenerationDependencies({
						projectId,
						organizationId,
						documentType,
						// Both of these are this run itself, not something for
						// it to wait on: its own row is already QUEUED, and the
						// source it supplied is being embedded in parallel with
						// the dispatch that started it.
						excludeDocumentId: documentId,
						excludeContextId,
						// Bounds the arms that can refuse rather than delay. A
						// source that failed before this request existed is not
						// something this run waited on, and unbounded it would
						// refuse every generation the project ever asks for.
						generationStartedAt,
					});

					if (dependencies.verdict === "failed") {
						const [leading] = dependencies.failed;
						throw ApplicationFailure.nonRetryable(
							`Generation cannot run: a required input (${leading?.category ?? "unknown"}) failed and will not arrive.`,
							DEPENDENCY_BLOCKED_FAILURE_TYPE,
						);
					}

					if (dependencies.verdict === "clear") {
						break;
					}

					const [leading] = dependencies.outstanding;
					if (!leading) {
						// "waiting" with nothing outstanding is not a shape the
						// probe can produce. Treat it as clear rather than
						// sleeping forever on nothing.
						break;
					}

					// Only when it CHANGES. The row is polled for as long as an
					// hour, and writing the same category on every cycle would
					// be a database write per poll that tells its reader nothing
					// new.
					if (leading.category !== recordedReason) {
						await recordGenerationQueueReason({
							documentId,
							reason: leading.category,
						});
						recordedReason = leading.category;
					}

					// Deliberately NOT `continueAsNew`. A new run means a new
					// runId, and both `updateProjectWorkflowStatus` and the
					// stale-generation watchdog's liveness lookup correlate on
					// the one this run started with — continuing as new would
					// leave the document pointing at a run nobody can find.
					// Ending here instead gives the requester something they can
					// act on, and the wait is theirs to restart.
					if (workflowInfo().continueAsNewSuggested) {
						throw ApplicationFailure.nonRetryable(
							`Generation is still waiting on ${leading.category} after the longest a single run may wait. Try again once it finishes.`,
							DEPENDENCY_BLOCKED_FAILURE_TYPE,
						);
					}

					log.info("Waiting on outstanding generation dependencies", {
						documentId,
						documentType,
						reason: leading.category,
						outstanding: dependencies.outstanding,
						delayMs,
					});

					await sleep(delayMs);
					waited = true;
					delayMs = Math.min(
						delayMs * 2,
						DEPENDENCY_PROBE_MAX_DELAY_MS,
					);
				}

				if (waited) {
					// Re-authorize BEFORE re-issuing. The wait is unbounded and
					// `issueAIToken` signs whatever it is handed, so a requester
					// removed from the organization while they waited would
					// otherwise be handed a fresh key to that organization's
					// provider.
					await assertRequesterMayGenerate({
						documentId,
						userId,
						organizationId,
					});

					({ aiToken } = await issueGenerationToken({
						userId,
						organizationId,
						// The same fifteen minutes the API's dispatch mints for,
						// and for the same reason: the child activity this token
						// feeds allows fifteen minutes per attempt and retries five
						// times. Taking the issuer's much shorter default here would
						// make a run that WAITED strictly likelier to die on an
						// expired token than one that never queued at all.
						expirySeconds: GENERATION_TOKEN_EXPIRY_SECONDS,
					}));

					log.info(
						"Dependency wait cleared; re-issued the AI token",
						{
							documentId,
							documentType,
						},
					);
				}

				// Flip QUEUED → GENERATING for this attempt. Unconditional here:
				// an absent identity took the skip branch above, so reaching this
				// line means there is a queued row and a value to scope the write
				// to.
				// Take ownership of the row before the model call, and treat the
				// answer as the authorization it is.
				//
				// The flip is attempt-scoped, so "nothing written" has two very
				// different causes and acting on the wrong one is expensive
				// either way. SUPERSEDED means somebody else owns the row — the
				// watchdog terminalized it, a newer dispatch replaced it — and
				// continuing would spend a generation and then overwrite
				// whatever took its place, because the child writes the document
				// by id with no attempt guard of its own. NOT-YET-VISIBLE means
				// only that this attempt's own queue write has not landed: the
				// dispatcher stamps QUEUED after `workflow.start` returns, so a
				// worker that picks the run up immediately — which is the normal
				// case when nothing is outstanding — can arrive first. Refusing
				// there would kill a healthy run and strand its row QUEUED with
				// nothing left to advance it.
				let ownership = (
					await startGenerationRun({
						documentId,
						startedAt: generationStartedAt,
					})
				).outcome;

				for (
					let attempt = 0;
					ownership === "not-yet-visible" &&
					attempt < QUEUE_WRITE_VISIBILITY_ATTEMPTS;
					attempt++
				) {
					await sleep(QUEUE_WRITE_VISIBILITY_DELAY_MS);
					ownership = (
						await startGenerationRun({
							documentId,
							startedAt: generationStartedAt,
						})
					).outcome;
				}

				// Still nothing after waiting it out. The dispatcher died
				// between starting this run and marking its row, so no row
				// names this attempt and none ever will. Refusing is the
				// conservative half of the same argument: nobody owns the
				// document, so nobody may overwrite it.
				if (ownership !== "started") {
					throw ApplicationFailure.nonRetryable(
						"Generation stopped: this request was superseded while it waited for the project's context.",
						SUPERSEDED_FAILURE_TYPE,
					);
				}
			}

			// Both paths converge here — one waited, the other had nothing to
			// wait for — and what happens next is the model call.
			await reportJob(() =>
				reportGenerationJobStep({
					documentId,
					step: "awaitContext",
					status: "completed",
				}),
			);
			await reportJob(() =>
				reportGenerationJobStep({
					documentId,
					step: "generate",
					status: "running",
				}),
			);
			currentJobStep = "generate";
		}

		// Execute child workflow for document generation
		log.info("Executing document generation child workflow", {
			documentId,
			documentType,
		});

		const childResult = await executeChild(
			documentGenerationChildWorkflow,
			{
				workflowId: `${workflowId}-child-${documentId}`,
				args: [
					{
						projectId,
						documentId,
						documentType,
						userId,
						organizationId,
						aiToken,
						prompt,
						promptId,
						promptVersionId,
						currentDocument,
						// Both of these are enumerated deliberately. This args
						// object is NOT a spread of `input` — every field the
						// child needs has to be named here, and the API starts
						// this workflow by string name with untyped args, so a
						// field added to the child's input and forgotten here
						// raises no type error anywhere. It simply never
						// arrives, and the feature dies quietly with every unit
						// test green. `supplied-context-wiring.test.ts` pins
						// this call for exactly that reason.
						suppliedContext, // joined into the child's context array, never over it
						excludeContextId, // filtered out of this run's retrieval
					},
				],
			},
		);

		// The run's own closing writes, behind the SAME marker that opened
		// them. Every one is an activity command, so a history recorded before
		// the queue shipped has to replay with all of them absent — the marker
		// is idempotent per execution, so naming it again here is a re-read of
		// the same answer rather than a second gate.
		if (patched("document-generation-dependency-wait-2026-09-07")) {
			// The generation is done the moment the child returns: the
			// evaluation child and the status writes below are all bookkeeping
			// about a document that already exists, so the row closes here
			// rather than staying open across work its reader is not waiting on.
			await reportJob(() =>
				reportGenerationJobStep({
					documentId,
					step: "generate",
					status: "completed",
					closesJob: true,
				}),
			);

			// And tell the requester, who may have closed the tab an hour ago.
			// Its own try/catch for the reason `template-instance-execution.ts`
			// gives at its notification call: this sits ABOVE the catch below, so
			// an unguarded throw here would turn a run that produced a document
			// into a failed one — and then announce that failure.
			try {
				await notifyGenerationOutcome({
					documentId,
					userId,
					outcome: "COMPLETED",
					// Scopes the claim to this attempt: a run superseded while it
					// waited must not spend the claim its replacement needs.
					generationStartedAt,
				});
			} catch (notifyError) {
				log.warn("Completion notification failed (non-fatal)", {
					documentId,
					error:
						notifyError instanceof Error
							? notifyError.message
							: "Unknown error",
				});
			}
		}

		// If we reach here, child succeeded (child throws on failure)
		// Step 5: Start document evaluation as fire-and-forget child workflow
		// The parent doesn't wait for evaluation - it runs independently
		if (childResult.documentContent) {
			try {
				log.info(
					"📊 STEP 5: Starting document evaluation workflow (fire-and-forget)",
					{
						documentId,
						documentType,
						step: "document_evaluation",
					},
				);

				// Fire-and-forget: start eval workflow but don't wait for it
				// ABANDON policy means the child continues even if parent completes
				await startChild(documentEvalWorkflow, {
					workflowId: `${workflowId}-eval-${documentId}`,
					parentClosePolicy:
						ParentClosePolicy.PARENT_CLOSE_POLICY_ABANDON,
					args: [
						{
							projectDocumentId: documentId,
							documentContent: childResult.documentContent,
							documentVersion: 1,
							documentType:
								documentType as import("@repo/database").ProjectDocumentType,
							userId,
							organizationId,
							userPrompt: prompt,
							threshold: 70,
						},
					],
				});

				log.info(
					"✅ STEP 5 COMPLETE: Document evaluation workflow started (async)",
					{
						step: "document_evaluation",
						evalWorkflowId: `${workflowId}-eval-${documentId}`,
						status: "started_async",
					},
				);
			} catch (evalError) {
				log.warn(
					"Failed to start document evaluation workflow (non-fatal)",
					{
						error:
							evalError instanceof Error
								? evalError.message
								: "Unknown error",
					},
				);
				// Non-fatal - evaluation is optional
			}
		}

		// Update workflow status to COMPLETED
		log.info("Updating workflow status to COMPLETED");
		await updateProjectWorkflowStatus(
			projectId,
			workflowId,
			runId,
			"COMPLETED",
		);

		// Update AgentTask status to COMPLETED
		if (agentTaskId) {
			try {
				await updateAgentTaskStatus({
					id: agentTaskId,
					status: "COMPLETED",
					result: {
						documentId,
						documentType,
						contentLength: childResult.metrics.documentLength,
						wordCount: childResult.metrics.wordCount,
						contextCount: childResult.metrics.contextCount,
						episodeCount: childResult.metrics.episodeCount,
					},
					completedAt: new Date(),
				});
				log.info("AgentTask completed", { agentTaskId });
			} catch (taskError) {
				log.warn("Failed to update AgentTask status", {
					error:
						taskError instanceof Error
							? taskError.message
							: "Unknown error",
				});
			}
		}

		const totalDuration = Date.now() - startTime;
		log.info("🎉 WORKFLOW COMPLETED SUCCESSFULLY", {
			projectId,
			documentId,
			documentType,
			documentLength: childResult.metrics.documentLength,
			wordCount: childResult.metrics.wordCount,
			totalDurationMs: totalDuration,
			totalDurationSeconds: (totalDuration / 1000).toFixed(2),
			status: "completed",
			metrics: childResult.metrics,
			evaluationStarted: !!childResult.documentContent,
			note: "Evaluation runs asynchronously as a separate workflow",
		});

		return {
			success: true,
			documentId,
			documentContent: childResult.documentContent,
			// Note: evaluation is no longer returned here - it runs asynchronously
			// Check DocumentEval table for results
		};
	} catch (err) {
		const totalDuration = Date.now() - startTime;
		const error = err instanceof Error ? err.message : "Unknown error";
		// What the two user-facing surfaces below are allowed to say. `error`
		// itself stays raw for the log and for the failure this rethrows —
		// an operator reading Temporal needs the real thing — but the document
		// row and the Job Hub card are read by the requester, so they only get
		// a sentence this run wrote for them.
		const reportableError = readableFailureMessage(err);

		log.error("❌ WORKFLOW FAILED", {
			error,
			projectId,
			documentId,
			documentType,
			totalDurationMs: totalDuration,
			totalDurationSeconds: (totalDuration / 1000).toFixed(2),
			status: "failed",
			...(err instanceof Error && {
				stack: err.stack,
				errorName: err.name,
			}),
		});

		// Update workflow status to FAILED
		try {
			await updateProjectWorkflowStatus(
				projectId,
				workflowId,
				runId,
				"FAILED",
			);
		} catch (statusError) {
			log.error("Failed to update workflow status", {
				error:
					statusError instanceof Error
						? statusError.message
						: "Unknown error",
			});
		}

		// The run's closing writes, behind the SAME marker that opened them —
		// see the success path for why one idempotent re-read beats a flag.
		if (patched("document-generation-dependency-wait-2026-09-07")) {
			// The document row's own terminal status.
			//
			// Without this, a run refused BEFORE the child starts — a
			// dependency that will not arrive, a requester whose access lapsed
			// while they waited — leaves the row QUEUED with nothing left to
			// write it, because the child that would have written FAILED never
			// ran. The reader sees "waiting" for a run that has already given
			// up, until the stale sweep gets to it half an hour later.
			//
			// Safe to issue on EVERY failure, not just those ones, because the
			// write is scoped to this attempt: a row the child already failed,
			// one a newer attempt owns, one already COMPLETE — all no-ops. It
			// goes first so the page the notification links to is already
			// showing the reason by the time the bell rings.
			if (generationStartedAt) {
				try {
					await failGenerationRun({
						documentId,
						startedAt: generationStartedAt,
						reason: reportableError,
					});
				} catch (statusError) {
					// Swallowed like every other write on this path: the run
					// has already failed, and replacing its error with a
					// bookkeeping one helps nobody.
					log.warn("Terminal document status write failed", {
						documentId,
						error:
							statusError instanceof Error
								? statusError.message
								: "Unknown error",
					});
				}
			}

			// Close the row on the step that was actually running, so the panel
			// can say whether the run died waiting for its inputs or while
			// generating — two failures a user answers very differently. The
			// Job Hub renders this string verbatim, which is why it is the
			// discriminated one and not the raw error.
			await reportJob(() =>
				reportGenerationJobStep({
					documentId,
					step: currentJobStep,
					status: "failed",
					closesJob: true,
					error: reportableError,
				}),
			);

			// Say so in the bell too. No message is passed at all: the
			// notification's snippet is generic by design, and the document page
			// already renders the real reason from `generationError`. Guarded
			// like its siblings above so a notification failure cannot displace
			// the run's actual error, which the throw below still has to report.
			try {
				await notifyGenerationOutcome({
					documentId,
					userId,
					outcome: "FAILED",
					// Scopes the claim to this attempt: a run superseded while it
					// waited must not spend the claim its replacement needs.
					generationStartedAt,
				});
			} catch (notifyError) {
				log.warn("Failure notification failed (non-fatal)", {
					documentId,
					error:
						notifyError instanceof Error
							? notifyError.message
							: "Unknown error",
				});
			}
		}

		// Update AgentTask status to FAILED
		if (agentTaskId) {
			try {
				await updateAgentTaskStatus({
					id: agentTaskId,
					status: "FAILED",
					error,
					completedAt: new Date(),
				});
				log.info("AgentTask failed", { agentTaskId });
			} catch (taskError) {
				log.warn("Failed to update AgentTask status", {
					error:
						taskError instanceof Error
							? taskError.message
							: "Unknown error",
				});
			}
		}

		throw ApplicationFailure.nonRetryable(
			error,
			"DOCUMENT_GENERATION_FAILED",
		);
	}
}
