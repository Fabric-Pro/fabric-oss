/**
 * DocumentGenerationChildWorkflow
 *
 * Shared child workflow containing the core document generation logic.
 * This workflow is called by both:
 * - projectDocumentGenerationWorkflow (single document generation/regeneration)
 * - batchDocumentGenerationWorkflow (parallel document generation)
 *
 * Core steps:
 * 1. Retrieve project contexts from Qdrant (with reranking)
 * 2. Retrieve episodic memories (user-level)
 * 2.5. Check if Teams integration is available
 * 2.6. Fetch recent Teams messages (provides Teams context as RAG)
 * 2.7. Check if Slack integration is available
 * 2.8. Fetch recent Slack messages (provides Slack context as RAG)
 * 3. Generate document via unified LangGraph agent (with server-side Teams search tool)
 * 4. Save document to database
 * 5. Create document version
 * 6. Embed document for RAG
 *
 * A Proposal in an organization with the Proposal artifact rollout gate on
 * runs as a coordinated job (Fizzy #2801): a plan first, the client-only
 * Main prompt pinned for generation, visuals before the save, run-guarded
 * writes, and an Internal Analysis started after the embed.
 */

import { hasProjectContextEntries } from "@repo/agent-types";
import { WorkflowExecutionAlreadyStartedError } from "@temporalio/common";
import {
	ActivityFailure,
	ApplicationFailure,
	log,
	ParentClosePolicy,
	patched,
	proxyActivities,
	startChild,
	workflowInfo,
} from "@temporalio/workflow";
import type * as activities from "../activities";
import {
	type CreateProposalAnalysisRunResult,
	DOCUMENT_GENERATION_STALE,
	DOCUMENT_GENERATION_SUPERSEDED,
	type ProposalArtifactPlan,
} from "../lib/proposal-artifact/types";
import { PROJECT_DOCUMENT_GENERATION_ACTIVITY_TASK_QUEUE } from "../task-queues";
import { AI_NON_RETRYABLE_ERROR_TYPES } from "./ai-non-retryable-errors";
import type { proposalAnalysisWorkflow } from "./proposal-analysis";

// Generation awaits its own embedding before returning. Keep that activity
// on the foreground queue too: the next setup document retrieves its vectors,
// and a background backlog must not hold a saved document past the child timeout.
// Independent documentEmbeddingWorkflow runs use the background queue.
const {
	retrieveProjectContexts,
	retrieveAndFormatEpisodicMemory,
	generateDocumentWithAgent,
	saveProjectDocument,
	createDocumentVersion,
	embedProjectDocumentActivity,
} = proxyActivities<typeof activities>({
	taskQueue: PROJECT_DOCUMENT_GENERATION_ACTIVITY_TASK_QUEUE,
	startToCloseTimeout: "15m",
	heartbeatTimeout: "2 minutes",
	retry: {
		initialInterval: "2s",
		maximumInterval: "60s",
		backoffCoefficient: 2,
		maximumAttempts: 5,
		// Retrieval, generation and embedding all resolve a provider first.
		// Without this a tenant that configured none pays five attempts and
		// close to four minutes of backoff PER activity to reach the verdict
		// the first millisecond already had.
		nonRetryableErrorTypes: [...AI_NON_RETRYABLE_ERROR_TYPES],
	},
});

// Short activities: Teams checks, Teams message fetching, and progress status updates
const {
	checkProjectHasTeamsIntegration,
	fetchRecentTeamsMessages,
	checkProjectHasSlackIntegration,
	fetchRecentSlackMessages,
	updateProjectDocumentStatus,
} = proxyActivities<typeof activities>({
	taskQueue: PROJECT_DOCUMENT_GENERATION_ACTIVITY_TASK_QUEUE,
	startToCloseTimeout: "30s",
	retry: {
		maximumAttempts: 3,
	},
});

// Best-effort decision pre-check: bounded, single-attempt, no heartbeat. The
// activity self-gates on the feature flag and swallows its own errors; the
// workflow call is additionally wrapped in try/catch so no failure mode can
// break document generation.
const { runDocumentDecisionPrecheckActivity } = proxyActivities<
	typeof activities
>({
	taskQueue: PROJECT_DOCUMENT_GENERATION_ACTIVITY_TASK_QUEUE,
	startToCloseTimeout: "2m",
	retry: {
		maximumAttempts: 1,
	},
});

// Coordinated Proposal job (Fizzy #2801): the plan, the cleanup of a failed
// run's live preview, and the Internal Analysis run record. Database reads
// and writes only; none of them calls a model.
const {
	planProposalArtifact,
	clearProposalLiveContent,
	createProposalAnalysisRun,
	failProposalAnalysisRun,
} = proxyActivities<typeof activities>({
	taskQueue: PROJECT_DOCUMENT_GENERATION_ACTIVITY_TASK_QUEUE,
	startToCloseTimeout: "1 minute",
	retry: {
		initialInterval: "2s",
		maximumInterval: "30s",
		backoffCoefficient: 2,
		maximumAttempts: 5,
	},
});

// The Proposal's visuals: one bounded attempt with a heartbeat, ticking
// during every model call. The activity fails open, returning the content it
// was given, and the workflow treats any failure of it the same way.
const { generateProposalVisuals } = proxyActivities<typeof activities>({
	taskQueue: PROJECT_DOCUMENT_GENERATION_ACTIVITY_TASK_QUEUE,
	startToCloseTimeout: "5 minutes",
	heartbeatTimeout: "1 minute",
	retry: {
		maximumAttempts: 1,
		nonRetryableErrorTypes: [...AI_NON_RETRYABLE_ERROR_TYPES],
	},
});

/**
 * Visuals are skipped once the child has run this long, so a setup flow that
 * bounds the child at twenty minutes keeps room for the save.
 */
const PROPOSAL_VISUALS_MAX_CHILD_AGE_MS = 10 * 60 * 1000;

/**
 * Why a coordinated run stopped at its plan: a newer request for the same
 * document took it over. Written for the person who reads it on the Job Hub
 * card; the document itself shows the newer run.
 */
const SUPERSEDED_BEFORE_START_MESSAGE =
	"A newer generation of this document started, so this one stopped without changing it.";

/**
 * Input for the document generation child workflow
 */
export interface DocumentGenerationChildInput {
	projectId: string;
	documentId: string;
	documentType: string;
	userId: string;
	organizationId?: string;
	aiToken: string;
	prompt?: string;
	promptId?: string;
	/**
	 * The client's claim about the prompt version. Attribution comes from the
	 * version the generation activity rendered (Fizzy #2807); this is read only
	 * for a generation result recorded before that change.
	 */
	promptVersionId?: string;
	/** Current document content for regeneration context */
	currentDocument?: string;
	/** Pre-assembled context array — skips RAG, episodic memory, and Teams retrieval when provided */
	directContext?: string[];
	/**
	 * Source text the user supplied in the create flow, JOINED into the context
	 * array alongside everything else — never in place of it.
	 *
	 * Deliberately not carried on `directContext`, which replaces the array
	 * outright and skips retrieval, episodic memory, Teams, and Slack. Reusing
	 * that field would silently drop the retrieved project context this input
	 * exists to sit beside.
	 *
	 * Arrives already neutralized, bounded, and wrapped in the shared attachment
	 * envelope by the API (`supplied-context.ts`). This workflow adds no
	 * escaping of its own.
	 */
	suppliedContext?: string;
	/**
	 * The project context row created for this run, excluded from this run's
	 * retrieval so the same words do not reach the model twice — once directly
	 * via `suppliedContext` and once through the corpus.
	 */
	excludeContextId?: string;
	/**
	 * A person started this run from the editor or the Documents tab, so it
	 * may run on their own ChatGPT plan (Fizzy #2939). Every other starter
	 * leaves it unset and stays on the organization's provider.
	 */
	planEligible?: boolean;
	/**
	 * The generation attempt's identity, as the parent received it from the
	 * dispatch (an ISO-8601 `ProjectDocument.generationStartedAt`). A
	 * coordinated Proposal's plan takes the document over only while the
	 * document still carries it (Fizzy #2801), so a plan that arrives after a
	 * newer request replaced this attempt stops the run without writing.
	 * Unset for starters with no attempt identity (batch and setup flows),
	 * whose plan takes the document over unconditionally.
	 */
	generationStartedAt?: string;
}

/**
 * Output from the document generation child workflow
 */
export interface DocumentGenerationChildOutput {
	success: boolean;
	documentId: string;
	documentContent?: string;
	error?: string;
	/**
	 * A coordinated Proposal run's token (Fizzy #2801), for the parent's own
	 * status writes after this child returns: guarded by it, they never land
	 * on a newer run that took the document over in between. Absent for every
	 * other run, and from any result recorded before the field existed.
	 */
	liveRunId?: string;
	metrics: {
		contextCount: number;
		episodeCount: number;
		integrationMessageCount: number;
		teamsSearchCount: number;
		documentLength: number;
		wordCount: number;
		durationMs: number;
	};
}

/**
 * Non-fatal progress update — never throws, never blocks generation.
 *
 * A coordinated Proposal passes its run token (Fizzy #2801): the write then
 * lands only while the run still owns the document, so a superseded run can
 * never flip a newer run's finished document back to GENERATING. Unset
 * otherwise, which the payload drops: today's write, unchanged.
 */
async function reportProgress(
	documentId: string,
	progress: number,
	liveRunId: string | undefined,
): Promise<void> {
	try {
		await updateProjectDocumentStatus({
			documentId,
			status: "GENERATING",
			progress,
			liveRunId,
		});
	} catch {
		// Non-fatal — progress reporting should never break generation
	}
}

/**
 * A coordinated Proposal's Main with its visuals, or exactly `content` when
 * the child has already run too long or the visuals step fails in any way.
 */
async function withProposalVisuals(input: {
	projectId: string;
	documentId: string;
	organizationId: string;
	userId: string;
	liveRunId: string;
	content: string;
	planEligible?: boolean;
}): Promise<string> {
	const childAgeMs = Date.now() - workflowInfo().startTime.getTime();
	if (childAgeMs > PROPOSAL_VISUALS_MAX_CHILD_AGE_MS) {
		log.info("Proposal visuals skipped: the child has run too long", {
			documentId: input.documentId,
			childAgeMs,
		});
		return input.content;
	}
	try {
		const visuals = await generateProposalVisuals(input);
		log.info("Proposal visuals done", {
			documentId: input.documentId,
			insertedCount: visuals.insertedCount,
		});
		return visuals.content;
	} catch (visualsError) {
		log.warn("Proposal visuals failed; saving Main without them", {
			documentId: input.documentId,
			error: extractActivityError(visualsError),
		});
		return input.content;
	}
}

/**
 * Record a coordinated Proposal's Internal Analysis run and, when it may
 * run, start the analysis workflow: abandoned on close, keyed by the run, ids
 * only. A run a project guest triggered, or one with no analysis prompt
 * bound, is recorded FAILED with its code and nothing starts.
 *
 * Never throws. A start that fails marks the run FAILED (`START_FAILED`); a
 * start that finds the workflow already running leaves the run to it. If
 * even the run record cannot be written there is no run to mark, and the
 * failure is only logged.
 */
async function startProposalAnalysis(
	plan: ProposalArtifactPlan,
	run: {
		projectId: string;
		documentId: string;
		organizationId: string;
		userId: string;
		contexts: string[];
		planEligible?: boolean;
	},
): Promise<void> {
	let created: CreateProposalAnalysisRunResult | null = null;
	try {
		created = await createProposalAnalysisRun({
			organizationId: run.organizationId,
			projectId: run.projectId,
			documentId: run.documentId,
			userId: run.userId,
			liveRunId: plan.liveRunId,
			analysisPrompt: plan.analysisPrompt,
			analysisSkipReason: plan.analysisSkipReason,
			triggeredByGuest: plan.triggeredByGuest,
			contexts: run.contexts,
		});
		if (created.kind === "superseded") {
			// A newer generation owns the document: its Main is not this
			// run's to analyse, and that run records its own analysis.
			log.info("Proposal analysis not recorded: run superseded", {
				documentId: run.documentId,
				liveRunId: plan.liveRunId,
			});
			return;
		}
		if (created.kind === "skipped") {
			log.info("Proposal analysis not started", {
				documentId: run.documentId,
				runId: created.runId,
				errorCode: created.errorCode,
			});
			return;
		}
		// Started by name, typed by the workflow: this module does not load
		// the analysis workflow's activity proxies. The worker's bundle
		// registers it from the workflows index.
		await startChild<typeof proposalAnalysisWorkflow>(
			"proposalAnalysisWorkflow",
			{
				workflowId: created.runKey,
				parentClosePolicy:
					ParentClosePolicy.PARENT_CLOSE_POLICY_ABANDON,
				args: [
					{
						runId: created.runId,
						organizationId: run.organizationId,
						projectId: run.projectId,
						documentId: run.documentId,
						userId: run.userId,
						planEligible: run.planEligible,
					},
				],
			},
		);
		log.info("Proposal analysis started", {
			documentId: run.documentId,
			runId: created.runId,
		});
	} catch (analysisError) {
		log.warn("Proposal analysis could not be started; Main is unaffected", {
			documentId: run.documentId,
			runId: created?.kind === "ready" ? created.runId : null,
			error: extractActivityError(analysisError),
		});
		if (
			created?.kind !== "ready" ||
			analysisError instanceof WorkflowExecutionAlreadyStartedError
		) {
			return;
		}
		try {
			await failProposalAnalysisRun({
				runId: created.runId,
				organizationId: run.organizationId,
				projectId: run.projectId,
				documentId: run.documentId,
				userId: run.userId,
				errorCode: "START_FAILED",
			});
		} catch {
			// The page reads a run with no update for twenty minutes as
			// timed out, so a run left PENDING here does not wait forever.
			log.warn("Could not record the proposal analysis start failure", {
				documentId: run.documentId,
				runId: created.runId,
			});
		}
	}
}

/**
 * DocumentGenerationChildWorkflow
 *
 * Core document generation logic shared by single and batch workflows.
 * Returns success/failure with metrics - parent workflows handle status tracking.
 *
 * @param input - Document generation parameters
 * @returns Output with success status, content, and metrics
 */
export async function documentGenerationChildWorkflow(
	input: DocumentGenerationChildInput,
): Promise<DocumentGenerationChildOutput> {
	const {
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
		directContext,
		suppliedContext,
		excludeContextId,
		planEligible,
		generationStartedAt,
	} = input;

	const startTime = Date.now();
	let contexts: string[] = [];
	let episodeCount = 0;
	const teamsSearchCount = 0;
	let hasTeamsIntegration = false;
	let hasSlackIntegration = false;
	// Set when this run is a coordinated Proposal (Fizzy #2801), with the
	// organization it runs in. Declared outside the `try` so a failure can
	// clean up under the run's token.
	let proposal: {
		plan: ProposalArtifactPlan;
		organizationId: string;
	} | null = null;
	// Set when the plan found a newer request owns the document. The run
	// never took it over, so it has nothing of its own to clean up, and any
	// write it made, guarded or not, could only land on the newer run.
	let supersededBeforeStart = false;

	log.info("Child workflow started: Document Generation", {
		projectId,
		documentId,
		documentType,
		hasCustomPrompt: !!promptId,
		hasCurrentDocument: !!currentDocument,
		isRegeneration: !!currentDocument,
		hasDirectContext: !!directContext,
		hasSuppliedContext: !!suppliedContext,
	});

	try {
		// Step 0: Is this a coordinated Proposal run? Decided once, here,
		// for every path that reaches this workflow. The plan activity reads
		// the rollout gate for the project's owning organization first and
		// returns null when it is off, so a gate-off run continues exactly as
		// before. A Main prompt that is not bound fails the run here, before
		// any agent call or live section.
		//
		// `patched()` is REQUIRED — the plan, and every step it switches on
		// below, adds commands to the stream. A history recorded before this
		// change has no marker, so it replays with no plan and takes the
		// legacy path throughout. Evaluated only for a Proposal in an
		// organization, so no other document records the marker.
		if (
			documentType === "PROPOSAL" &&
			organizationId &&
			patched("proposal-artifact-v1")
		) {
			const plan = await planProposalArtifact({
				projectId,
				documentId,
				documentType,
				userId,
				organizationId,
				// The run token is this execution's own run id: the same on
				// every retry of the plan and on replay, and new for every
				// generation, since each starts a new child execution.
				liveRunId: workflowInfo().runId,
				// Scopes the plan's takeover to this attempt, when the run
				// has an identity; unset otherwise, which the payload drops.
				generationStartedAt,
			});
			if (plan && "superseded" in plan) {
				supersededBeforeStart = true;
				throw ApplicationFailure.nonRetryable(
					SUPERSEDED_BEFORE_START_MESSAGE,
					DOCUMENT_GENERATION_STALE,
				);
			}
			if (plan) {
				proposal = { plan, organizationId };
				log.info("Coordinated Proposal run planned", {
					documentId,
					liveRunId: plan.liveRunId,
					analysisSkipReason: plan.analysisSkipReason,
				});
			}
		}

		if (directContext && directContext.length > 0) {
			// Direct context path: skip RAG, episodic memory, and Teams retrieval
			// Used by code-based project setup where orchestrator response IS the context
			contexts = directContext;
			log.info(
				"Using direct context, skipping RAG/episodic/Teams retrieval",
				{
					contextCount: contexts.length,
					totalContextLength: contexts.reduce(
						(sum, c) => sum + c.length,
						0,
					),
				},
			);
			await reportProgress(documentId, 30, proposal?.plan.liveRunId);
		} else {
			// Step 1: Retrieve project contexts from Qdrant
			const contextStartTime = Date.now();
			log.info("Step 1: Retrieving project contexts", {
				projectId,
				documentType,
			});

			try {
				// Don't pass limit — let RAG settings' topK (default: 50) control retrieval count
				// The reranker then narrows to rerankTopK (default: 10) for best quality
				contexts = await retrieveProjectContexts({
					projectId,
					userId,
					organizationId,
					documentType,
					userCustomPrompt: prompt,
					// The context row created moments ago for THIS run is
					// delivered directly below, so it must not also come back
					// through similarity search. The filter has to reach the
					// query: this activity returns `string[]` with no
					// identifiers, so there is nothing here to post-filter on.
					excludeContextId,
				});

				const contextDuration = Date.now() - contextStartTime;
				const totalContextLength = contexts.reduce(
					(sum, c) => sum + c.length,
					0,
				);

				log.info("Step 1 complete: Project contexts retrieved", {
					contextCount: contexts.length,
					totalContextLength,
					durationMs: contextDuration,
				});

				await reportProgress(documentId, 15, proposal?.plan.liveRunId);
			} catch (contextError) {
				const rawMessage =
					contextError instanceof Error
						? contextError.message
						: "Unknown error";
				// The raw `.message` of an ActivityFailure is the generic
				// "Activity task failed"; the provider's own words live further
				// down the cause chain.
				const errorMessage = extractActivityError(contextError);

				// Configuration errors are fatal.
				//
				// `patched()` is REQUIRED — this WIDENS which failures take the
				// throw. A history recorded before this change carried on
				// without RAG after a provider refusal (the old test read the
				// wrapper's generic message and matched nothing), and replaying
				// it down the new branch would fail with a non-determinism
				// error. Old executions keep the old test; new ones get the one
				// that works.
				const fatal = patched("document-provider-refusal-fatal-v1")
					? isProviderNotConfiguredFailure(contextError)
					: rawMessage.includes("No AI provider configured") ||
						rawMessage.includes("Please configure");

				if (fatal) {
					log.error(
						"AI provider configuration error - cannot proceed",
						{
							error: errorMessage,
						},
					);
					throw contextError;
				}

				// Other errors (e.g., Qdrant unavailable) - continue without RAG
				log.warn(
					"Failed to retrieve contexts, continuing without RAG",
					{
						error: errorMessage,
					},
				);
			}

			// Step 2: Retrieve episodic memories (user-level)
			const episodicStartTime = Date.now();
			log.info("Step 2: Retrieving episodic memories", {
				projectId,
				documentType,
			});

			try {
				const episodicQuery = `${documentType} document: ${prompt || "project documentation"}`;

				const episodicResult = await retrieveAndFormatEpisodicMemory({
					projectId,
					userId,
					organizationId,
					query: episodicQuery,
					limit: 5,
				});

				if (episodicResult.episodeCount > 0) {
					episodeCount = episodicResult.episodeCount;
					contexts = [episodicResult.formattedContext, ...contexts];

					const episodicDuration = Date.now() - episodicStartTime;
					log.info("Step 2 complete: Episodic memories retrieved", {
						episodeCount,
						contextLength: episodicResult.formattedContext.length,
						durationMs: episodicDuration,
					});
				} else {
					log.info("Step 2: No episodic memories found", {
						durationMs: Date.now() - episodicStartTime,
					});
				}
			} catch (episodicError) {
				// Non-fatal - continue without episodic memories
				log.warn(
					"Failed to retrieve episodic memories, continuing without",
					{
						error:
							episodicError instanceof Error
								? episodicError.message
								: "Unknown error",
					},
				);
			}

			await reportProgress(documentId, 25, proposal?.plan.liveRunId);

			// Step 2.5: Check if Teams integration is available
			try {
				hasTeamsIntegration = await checkProjectHasTeamsIntegration({
					projectId,
				});
				log.info("Teams integration check", {
					projectId,
					hasTeamsIntegration,
				});
			} catch {
				// Non-fatal - assume no Teams integration
				hasTeamsIntegration = false;
			}

			// Step 2.7: Check if Slack integration is available
			try {
				hasSlackIntegration = await checkProjectHasSlackIntegration({
					projectId,
				});
				log.info("Slack integration check", {
					projectId,
					hasSlackIntegration,
				});
			} catch {
				// Non-fatal - assume no Slack integration
				hasSlackIntegration = false;
			}

			// Step 2.6: Fetch recent Teams messages if integration exists (Fix 2)
			// This provides Teams context to BOTH workflow paths (iterative and non-iterative)
			// Users with custom prompts finally get Teams messages in their context!
			if (hasTeamsIntegration) {
				try {
					const teamsStartTime = Date.now();
					log.info("Step 2.6: Fetching recent Teams messages", {
						projectId,
						userId,
					});

					const teamsResult = await fetchRecentTeamsMessages({
						projectId,
						userId,
						organizationId,
						limit: 10,
					});

					if (teamsResult.messageCount > 0) {
						// Prepend Teams messages to contexts so they're visible to the agent
						contexts = [
							...teamsResult.formattedContexts,
							...contexts,
						];

						log.info(
							"Step 2.6 complete: Teams messages added to context",
							{
								messageCount: teamsResult.messageCount,
								fetchedChats: teamsResult.fetchedChats,
								contextCount: contexts.length,
								durationMs: Date.now() - teamsStartTime,
							},
						);
					} else {
						log.info("Step 2.6: No recent Teams messages found", {
							fetchedChats: teamsResult.fetchedChats,
							errors: teamsResult.errors,
							durationMs: Date.now() - teamsStartTime,
						});
					}
				} catch (teamsError) {
					// Non-fatal - continue without Teams messages
					// The iterative path still has the search tool available
					log.warn(
						"Failed to fetch Teams messages, continuing without them",
						{
							error:
								teamsError instanceof Error
									? teamsError.message
									: "Unknown error",
						},
					);
				}
			}

			// Step 2.8: Fetch recent Slack messages if integration exists
			if (hasSlackIntegration) {
				try {
					const slackStartTime = Date.now();
					log.info("Step 2.8: Fetching recent Slack messages", {
						projectId,
						userId,
					});

					const slackResult = await fetchRecentSlackMessages({
						projectId,
						userId,
						organizationId,
						limit: 10,
					});

					if (slackResult.messageCount > 0) {
						contexts = [
							...slackResult.formattedContexts,
							...contexts,
						];

						log.info(
							"Step 2.8 complete: Slack messages added to context",
							{
								messageCount: slackResult.messageCount,
								fetchedChannels: slackResult.fetchedChannels,
								contextCount: contexts.length,
								durationMs: Date.now() - slackStartTime,
							},
						);
					} else {
						log.info("Step 2.8: No recent Slack messages found", {
							fetchedChannels: slackResult.fetchedChannels,
							errors: slackResult.errors,
							durationMs: Date.now() - slackStartTime,
						});
					}
				} catch (slackError) {
					log.warn(
						"Failed to fetch Slack messages, continuing without them",
						{
							error:
								slackError instanceof Error
									? slackError.message
									: "Unknown error",
						},
					);
				}
			}

			await reportProgress(documentId, 30, proposal?.plan.liveRunId);
		} // end of else (non-directContext path)

		// Supplied source content: JOIN, never assign.
		//
		// Placed here, after both branches converge, so it reaches the direct-
		// context path and the retrieval path alike — and prepended into the
		// same array the three existing additive producers use (episodic
		// memory, Teams, Slack) rather than replacing it. Assigning instead of
		// joining is the exact defect recorded in
		// docs/solutions/design-patterns/prompt-context-fan-in-must-join-not-assign.md:
		// invisible until two sources are present at once, which is precisely
		// what this feature creates by design.
		//
		// The text is already neutralized, bounded, and enveloped by the API
		// (`supplied-context.ts`) — nothing is escaped or truncated here, so
		// there is only one copy of those rules to keep correct.
		if (suppliedContext && suppliedContext.trim().length > 0) {
			contexts = [suppliedContext, ...contexts];

			log.info("Supplied source content joined into context", {
				documentId,
				suppliedLength: suppliedContext.length,
				contextCount: contexts.length,
				excludedFromRetrieval: !!excludeContextId,
			});
		}

		// Step 3: Generate document
		const generationStartTime = Date.now();
		log.info("🤖 Step 3: Generating document", {
			projectId,
			documentType,
			contextCount: contexts.length,
			hasEpisodicMemory: episodeCount > 0,
			hasSuppliedContext: !!suppliedContext,
			hasTeamsIntegration,
			isRegeneration: !!currentDocument,
		});

		let documentContent: string;

		// Unified path: Always use LangGraph agent
		// The agent now has server-side Teams search tool when hasTeamsIntegration is true
		// Template enforcement, custom prompts, and Teams search all work in one path
		log.info("📝 Generating document with unified LangGraph agent", {
			hasPromptId: !!promptId,
			hasTeamsIntegration,
			hasSlackIntegration,
			contextCount: contexts.length,
		});

		await reportProgress(documentId, 35, proposal?.plan.liveRunId);

		const generationResult = await generateDocumentWithAgent({
			projectId,
			documentId,
			documentType,
			prompt: prompt || "",
			contexts,
			userId,
			organizationId,
			aiToken,
			promptId,
			currentDocument,
			// The project's own context only: company entries are marked as
			// vendor material, and a project with nothing of its own keeps its
			// wizard features in the prompt (Fizzy #2719). Histories recorded
			// before company context hold no marked entries, so replay sees
			// the value it always did.
			hasRagContexts: hasProjectContextEntries(contexts),
			hasTeamsIntegration,
			hasSlackIntegration,
			planEligible,
			// A coordinated Proposal renders exactly the pinned client-only
			// Main prompt and saves its sections live under the run token;
			// the request's `promptId` is not used then. Only an argument
			// changes, so no marker is needed beyond the plan's. Unset
			// otherwise, which the payload drops: today's input, unchanged.
			artifact: proposal
				? {
						liveRunId: proposal.plan.liveRunId,
						promptId: proposal.plan.mainPrompt.promptId,
						promptVersionNumber:
							proposal.plan.mainPrompt.versionNumber,
					}
				: undefined,
		});
		documentContent = generationResult.content;

		// Attribute the run to the prompt version the activity actually rendered
		// (Fizzy #2807). The activity now always sets the key — the version's id,
		// or null when no prompt version produced the run — and the client's
		// input ID is never a better answer than that: it can be a stale pin.
		//
		// A result without the key was recorded by a worker from before that
		// change, which set it on the bound path only. A run in flight across
		// the deploy resumes here with such a result, so it keeps the old
		// fallback rather than losing its attribution. No `patched()`: the
		// branch is chosen by the recorded result itself, and either way only
		// an argument of the `createDocumentVersion` activity in Step 5 changes,
		// never which commands run.
		const reportedPromptVersionId =
			generationResult.resolvedPromptVersionId;
		const effectivePromptVersionId =
			reportedPromptVersionId === undefined
				? promptVersionId
				: (reportedPromptVersionId ?? undefined);

		const generationDuration = Date.now() - generationStartTime;
		const wordCount = documentContent.split(/\s+/).length;

		log.info("✅ Step 3 complete: Document generated", {
			contentLength: documentContent.length,
			wordCount,
			teamsSearchCount,
			durationMs: generationDuration,
		});

		await reportProgress(documentId, 80, proposal?.plan.liveRunId);

		// Step 3.5: A coordinated Proposal's visuals go into Main before the
		// save (Fizzy #2801). Bounded and fail-open: whatever happens here,
		// the save below receives Main, with visuals or without.
		if (proposal) {
			documentContent = await withProposalVisuals({
				projectId,
				documentId,
				organizationId: proposal.organizationId,
				userId,
				liveRunId: proposal.plan.liveRunId,
				content: documentContent,
				planEligible,
			});
		}

		// Step 4: Save document to database
		const saveStartTime = Date.now();
		log.info("💾 Step 4: Saving document to database", { documentId });

		// The generation reports `baselineVersion` only when a visual slot is
		// involved: the spliced body is right only for the version its slots
		// were lifted from, so the save must refuse a newer one. That refusal
		// is a non-retryable failure the catch below records like any other
		// (FAILED, with the activity's own sentence), leaving the person's
		// newer document as it is.
		//
		// Replay-safe without `patched()`: both branches schedule the same
		// single `saveProjectDocument` activity at the same point, and Temporal
		// matches a scheduled activity by type and id, not by its input. The
		// slot-free branch passes exactly the three arguments it always has —
		// as does any history whose generation finished before the field
		// existed, since its recorded result simply lacks it.
		//
		// A coordinated Proposal's save is also guarded by its run token, so
		// a run superseded by a newer regeneration cannot overwrite the newer
		// Main: the refusal is the same non-retryable stale failure. Again one
		// activity at the same point; only its input differs.
		//
		// A coordinated Proposal is guarded by a version as well, slots or
		// none: the one it was planned at, which a person's save during the
		// run moves on. A plan recorded before it carried one leaves the
		// generation's baseline, exactly as that history ran. The save also
		// requires the body the run was planned against, which catches the
		// edits that do not move the version.
		const baselineVersion =
			proposal?.plan.baselineVersion ?? generationResult.baselineVersion;
		if (proposal) {
			const { baselineContentHash } = proposal.plan;
			await saveProjectDocument(documentId, documentContent, userId, {
				...(baselineVersion !== undefined && { baselineVersion }),
				liveRunId: proposal.plan.liveRunId,
				...(baselineContentHash !== undefined && {
					baselineContentHash,
				}),
			});
		} else if (baselineVersion !== undefined) {
			await saveProjectDocument(documentId, documentContent, userId, {
				baselineVersion,
			});
		} else {
			await saveProjectDocument(documentId, documentContent, userId);
		}

		log.info("✅ Step 4 complete: Document saved", {
			documentId,
			durationMs: Date.now() - saveStartTime,
		});

		// Step 4.5: Async decision pre-check (flag-gated INSIDE the activity).
		// `patched()` is REQUIRED — this adds a new activity call to the
		// workflow's command stream, so histories recorded before this change
		// would throw a non-determinism error on replay without the gate. The
		// activity self-gates on the feature flag and swallows all errors; the
		// try/catch here additionally guarantees that even a Temporal-level
		// activity failure (timeout, worker restart, retry exhaustion) can never
		// fail document generation.
		if (patched("document-decision-precheck-v1")) {
			try {
				await runDocumentDecisionPrecheckActivity({
					documentId,
					projectId,
					userId,
					organizationId,
				});
			} catch (precheckError) {
				log.warn("Decision pre-check activity failed; continuing", {
					documentId,
					error:
						precheckError instanceof Error
							? precheckError.message
							: "Unknown error",
				});
			}
		}

		// Step 5: Create document version
		const versionStartTime = Date.now();
		log.info("📝 Step 5: Creating document version", { documentId });

		try {
			// The same baseline the save was given, and only then: the version
			// row and bump must land only while the regenerated body is still
			// the live one, or a person's save that landed after Step 4 gets
			// this run's stale body as its version. Same replay argument as
			// Step 4 — one activity at the same point either way, and the
			// slot-free call keeps exactly its four arguments. A coordinated
			// Proposal's version row is guarded by its run token as well.
			if (proposal) {
				await createDocumentVersion(
					documentId,
					documentContent,
					userId,
					effectivePromptVersionId,
					{
						...(baselineVersion !== undefined && {
							baselineVersion,
						}),
						liveRunId: proposal.plan.liveRunId,
					},
				);
			} else if (baselineVersion !== undefined) {
				await createDocumentVersion(
					documentId,
					documentContent,
					userId,
					effectivePromptVersionId,
					{ baselineVersion },
				);
			} else {
				await createDocumentVersion(
					documentId,
					documentContent,
					userId,
					effectivePromptVersionId,
				);
			}
			log.info("✅ Step 5 complete: Version created", {
				documentId,
				durationMs: Date.now() - versionStartTime,
			});
		} catch (versionError) {
			// A stale refusal is the run's verdict, not a versioning hiccup:
			// the regenerated body is no longer the document, so the run fails
			// like a refused save. Only a guarded call (baseline or run token)
			// can refuse this way, so a slot-free legacy run — and every
			// history recorded before the guard — takes the non-fatal branch
			// below exactly as before.
			if (
				(proposal || baselineVersion !== undefined) &&
				isStaleRegenerationFailure(versionError)
			) {
				throw versionError;
			}
			// Non-fatal - document is already saved
			log.warn("Failed to create document version", {
				error:
					versionError instanceof Error
						? versionError.message
						: "Unknown error",
			});
		}

		// Step 6: Embed document for RAG (PRD/PROPOSAL only)
		const embedStartTime = Date.now();
		log.info("🔍 Step 6: Embedding document for RAG", {
			documentId,
			documentType,
		});

		try {
			const embedResult = await embedProjectDocumentActivity({
				documentId,
				userId,
				organizationId,
			});

			if (embedResult.success) {
				log.info("✅ Step 6 complete: Document embedded", {
					documentId,
					durationMs: Date.now() - embedStartTime,
				});
			} else {
				log.warn("Step 6: Document embedding skipped or failed", {
					documentId,
					error: embedResult.error,
					durationMs: Date.now() - embedStartTime,
				});
			}
		} catch (embedError) {
			// Non-fatal - document generation succeeded, embedding can be retried
			log.warn("Failed to embed document", {
				error:
					embedError instanceof Error
						? embedError.message
						: "Unknown error",
			});
		}

		// Step 7: A coordinated Proposal's Internal Analysis (Fizzy #2801),
		// started once Main is saved, versioned and embedded. Non-fatal by
		// construction, like the decision pre-check: Main is complete
		// whatever happens here.
		if (proposal) {
			await startProposalAnalysis(proposal.plan, {
				projectId,
				documentId,
				organizationId: proposal.organizationId,
				userId,
				contexts,
				planEligible,
			});
		}

		const totalDuration = Date.now() - startTime;

		log.info("🎉 Child workflow completed successfully", {
			projectId,
			documentId,
			documentType,
			documentLength: documentContent.length,
			wordCount,
			teamsSearchCount,
			totalDurationMs: totalDuration,
		});

		return {
			success: true,
			documentId,
			documentContent,
			...(proposal && { liveRunId: proposal.plan.liveRunId }),
			metrics: {
				contextCount: contexts.length,
				episodeCount,
				integrationMessageCount: 0, // Deprecated - use teamsSearchCount
				teamsSearchCount,
				documentLength: documentContent.length,
				wordCount,
				durationMs: totalDuration,
			},
		};
	} catch (error) {
		const totalDuration = Date.now() - startTime;
		const errorMessage = extractActivityError(error);

		log.error("❌ Child workflow failed", {
			projectId,
			documentId,
			documentType,
			error: errorMessage,
			totalDurationMs: totalDuration,
			...(error instanceof Error && { stack: error.stack }),
		});

		// A coordinated run a newer generation superseded — refused at its
		// plan, or at its save or version write — ends with its own type, so
		// a parent writes nothing to the document either: the newer run owns
		// it. Every other failure keeps today's type, and so today's handling
		// by every parent.
		const failureType =
			(proposal || supersededBeforeStart) &&
			isStaleRegenerationFailure(error)
				? DOCUMENT_GENERATION_SUPERSEDED
				: "DOCUMENT_GENERATION_CHILD_FAILED";

		// Refused at its plan: the run never took the document over, so it
		// has no live preview to drop and no status of its own to write.
		if (supersededBeforeStart) {
			throw ApplicationFailure.nonRetryable(errorMessage, failureType);
		}

		// A coordinated Proposal drops its live preview first, and its FAILED
		// write is guarded by its run token: a run superseded by a newer
		// regeneration neither clears nor fails the newer run's document.
		if (proposal) {
			try {
				await clearProposalLiveContent({
					documentId,
					liveRunId: proposal.plan.liveRunId,
				});
			} catch {
				// Non-fatal — the FAILED write below still runs
			}
		}

		// Mark document as FAILED so it doesn't stay stuck in GENERATING
		try {
			await updateProjectDocumentStatus({
				documentId,
				status: "FAILED",
				progress: 0,
				error: errorMessage,
				// The run guard; unset outside a coordinated Proposal.
				liveRunId: proposal?.plan.liveRunId,
			});
		} catch {
			// Non-fatal — don't mask the original error
		}

		// A coordinated run's token rides in the failure's details, so a
		// parent can guard its own FAILED write the way this one is guarded.
		// Message and type are unchanged, and so is every other child's
		// failure.
		if (proposal) {
			throw ApplicationFailure.nonRetryable(errorMessage, failureType, {
				liveRunId: proposal.plan.liveRunId,
			});
		}
		throw ApplicationFailure.nonRetryable(errorMessage, failureType);
	}
}

/**
 * Extract the actual error message from Temporal's wrapped errors.
 * Temporal wraps activity failures in ActivityFailure -> ApplicationFailure -> actual error.
 */
function extractActivityError(error: unknown): string {
	if (!error) {
		return "Unknown error";
	}
	if (error instanceof ActivityFailure && error.cause) {
		return extractActivityError(error.cause);
	}
	if (error instanceof ApplicationFailure) {
		if (error.cause) {
			const causeMsg = extractActivityError(error.cause);
			if (causeMsg && causeMsg !== "Unknown error") {
				return causeMsg;
			}
		}
		return error.message;
	}
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

/**
 * Did an activity abandon this run as a stale regeneration — a refused
 * baseline or run-token write? The activity's `ApplicationFailure` reaches the
 * workflow wrapped in an `ActivityFailure`, so its type
 * (`DOCUMENT_GENERATION_STALE`, shared through the Proposal artifact types)
 * is looked for down the cause chain.
 */
function isStaleRegenerationFailure(error: unknown): boolean {
	let current: unknown = error;
	for (let depth = 0; current != null && depth < 8; depth += 1) {
		if (
			current instanceof ApplicationFailure &&
			current.type === DOCUMENT_GENERATION_STALE
		) {
			return true;
		}
		current = (current as { cause?: unknown }).cause;
	}
	return false;
}

/**
 * Is this failure the "this tenant configured no provider" refusal?
 *
 * The branch that consults this decides whether a failed context retrieval is
 * fatal or merely means "generate without RAG", and it used to decide by
 * matching two substrings — `"No AI provider configured"` and
 * `"Please configure"`. `@repo/ai` throws FOUR distinct messages behind one
 * error class, and the embedding variant that context retrieval actually hits
 * ("No embedding provider configured. Please set an embedding provider in
 * Settings → AI Providers.") matches NEITHER. The workflow therefore treated a
 * deterministic configuration verdict as a transient RAG outage, carried on,
 * and failed at generation instead — after five more retried attempts.
 *
 * Match on the error's IDENTITY first: Temporal records the activity failure
 * type as the thrown class's name, so `AIProviderNotConfiguredError` survives
 * the ActivityFailure -> ApplicationFailure wrapping as `.type`. The message
 * test is kept only as a fallback for an error that reaches here unwrapped or
 * re-thrown as a plain `Error`, and it now covers every message the class
 * carries — both "No AI provider configured" and "No embedding provider
 * configured".
 */
const PROVIDER_NOT_CONFIGURED_ERROR_NAME = "AIProviderNotConfiguredError";

function isProviderNotConfiguredFailure(error: unknown): boolean {
	let current: unknown = error;
	let depth = 0;
	while (current != null && depth < 8) {
		if (
			current instanceof ApplicationFailure &&
			current.type === PROVIDER_NOT_CONFIGURED_ERROR_NAME
		) {
			return true;
		}
		if (
			current instanceof Error &&
			current.name === PROVIDER_NOT_CONFIGURED_ERROR_NAME
		) {
			return true;
		}
		current = (current as { cause?: unknown }).cause;
		depth += 1;
	}
	return /No (AI|embedding) provider configured/i.test(
		extractActivityError(error),
	);
}
