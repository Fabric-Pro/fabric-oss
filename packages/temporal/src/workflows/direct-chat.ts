/**
 * Direct Chat Workflow
 *
 * Durable workflow for processing Direct mode AI chat messages.
 * Provides the same durability and observability as Orchestrator mode,
 * but with simpler single-agent execution.
 *
 * Features:
 * - Automatic retry on transient failures
 * - MCP tool integration with server management
 * - Semantic memory context injection
 * - RAG context support
 * - Tool suggestion analysis
 * - Workflow confirmation handling
 * - Complete execution history for debugging
 * - Real-time progress queries
 */

import {
	ApplicationFailure,
	defineQuery,
	log,
	ParentClosePolicy,
	patched,
	proxyActivities,
	setHandler,
	startChild,
} from "@temporalio/workflow";
import type * as directChatActivities from "../activities/direct-chat";
import type {
	DirectChatProgressUpdate,
	DirectChatWorkflowInput,
	DirectChatWorkflowOutput,
} from "../types";
import { AI_NON_RETRYABLE_ERROR_TYPES } from "./ai-non-retryable-errors";
import {
	type DirectChatPostOperationInput,
	directChatPostOperationWorkflow,
} from "./direct-chat-post-operation";

// =============================================================================
// Queries for real-time progress tracking
// =============================================================================

export const directChatProgressQuery =
	defineQuery<DirectChatProgressUpdate>("directChatProgress");
export const directChatStatusQuery = defineQuery<
	"running" | "completed" | "failed"
>("directChatStatus");

// =============================================================================
// Activity Proxies
// =============================================================================

// MCP and memory activities - may need multiple retries due to network
const {
	collectMcpToolsActivity,
	generateMemoryContextActivity,
	retrieveRagContextForDirectChatActivity,
	retrieveWorkspaceDocumentsActivity,
} = proxyActivities<typeof directChatActivities>({
	startToCloseTimeout: "60s",
	heartbeatTimeout: "30 seconds",
	retry: {
		initialInterval: "2s",
		maximumInterval: "30s",
		backoffCoefficient: 2,
		maximumAttempts: 3,
	},
});

// Tool suggestions - lightweight activity
const { generateToolSuggestionsActivity } = proxyActivities<
	typeof directChatActivities
>({
	startToCloseTimeout: "10s",
	retry: {
		initialInterval: "1s",
		maximumInterval: "10s",
		backoffCoefficient: 2,
		maximumAttempts: 2,
	},
});

// Main AI execution - longer timeout for complex tool chains
// Note: Model is created INSIDE the activity to avoid Temporal serialization issues
// Heartbeat timeout enables real-time progress updates via activity heartbeats
const { executeDirectChatActivity } = proxyActivities<
	typeof directChatActivities
>({
	startToCloseTimeout: "5m",
	heartbeatTimeout: "30s", // Activity must heartbeat at least every 30s
	retry: {
		initialInterval: "2s",
		maximumInterval: "60s",
		backoffCoefficient: 2,
		maximumAttempts: 3,
		// When the activity rethrows AiUsageLimitExceededError — or the
		// AIProviderNotConfiguredError a keyless tenant now gets instead of a
		// platform-key fallback — Temporal records the failure type as
		// `error.constructor?.name ?? error.name` (see @temporalio/common
		// ensureApplicationFailure). Listing them here tells the server to treat
		// that failure as non-retryable immediately, avoiding the 3-attempt
		// × ~2 s wasted latency before the workflow sees the error. The error
		// object itself is NOT altered, so extractAiUsageLimitExceededError in the
		// route layer still detects it via the message-regex fallback (the
		// original error is nested as ApplicationFailure.cause inside
		// ActivityFailure).
		nonRetryableErrorTypes: [...AI_NON_RETRYABLE_ERROR_TYPES],
	},
});

// The `postOperationResultActivity`
// proxy now lives ONLY inside the fire-and-forget child workflow
// `directChatPostOperationWorkflow`. See `direct-chat-post-operation.ts`
// for the full rationale; the short version is that an inline `await
// postOperationResultActivity(...)` here would couple the SSE route's
// `await handle.result()` resolution time to a `scheduleToCloseTimeout`
// of up to 2 minutes, so a worker outage would delay the user-visible
// "done" event for an AI response that already streamed in full via
// heartbeat queries. Moving Step 6 into a child workflow started with
// `ParentClosePolicy.PARENT_CLOSE_POLICY_ABANDON` decouples the two
// latencies — the parent `await`s only the child's START (milliseconds).

/**
 * Join every source of prompt context into one string, dropping the empties.
 *
 * Exists because the three sources used to be combined three different ways —
 * one seeded, one *assigned over the top* of whatever came before, one
 * concatenated with no separator. The assignment silently discarded everything
 * earlier in the chain, and the bare concatenation ran two contexts together
 * with no blank line between them. One helper means a fourth source cannot
 * reintroduce either bug.
 *
 * Pure and total, so it is safe inside a workflow: no clock, no randomness, no
 * I/O, and the same inputs always produce the same output on replay.
 */
export function joinRagContextParts(
	parts: readonly (string | undefined | null)[],
): string {
	return parts
		.filter((part): part is string => !!part && part.length > 0)
		.join("\n\n");
}

/**
 * Direct Chat Workflow
 *
 * Processes a direct chat message with full durability guarantees.
 * Orchestrates MCP tool collection, memory context, and AI execution.
 * Exposes progress via queries for real-time streaming.
 */
export async function directChatWorkflow(
	input: DirectChatWorkflowInput,
): Promise<DirectChatWorkflowOutput> {
	const startTime = Date.now();
	const {
		executionId,
		instanceId,
		message,
		userId,
		organizationId,
		reasoningMode,
		// Optional AgentConversation backing for the
		// success/failure operation-result message. When undefined, the
		// Step 6 calls below short-circuit (today's transient behaviour
		// is preserved for callers that haven't been mapped to an
		// `AgentConversation`).
		conversationId,
	} = input;

	// ==========================================================================
	// Workflow state for progress tracking (queryable)
	// ==========================================================================
	let workflowStatus: "running" | "completed" | "failed" = "running";
	let progress: DirectChatProgressUpdate = {
		phase: "initializing",
		message: "Starting workflow...",
		progress: 0,
		toolCalls: [],
	};

	// Set up query handlers
	setHandler(directChatProgressQuery, () => progress);
	setHandler(directChatStatusQuery, () => workflowStatus);

	// Helper to update progress
	const updateProgress = (
		phase: DirectChatProgressUpdate["phase"],
		msg: string,
		pct: number,
		activity?: string,
	) => {
		progress = {
			...progress,
			phase,
			message: msg,
			progress: pct,
			currentActivity: activity,
		};
	};

	log.info("Starting direct chat workflow", {
		executionId,
		instanceId,
		userId,
		organizationId,
		reasoningMode,
		messageLength: message.length,
	});

	try {
		// Step 1: Collect MCP tools, generate memory, and retrieve RAG context in parallel
		// These activities are independent and can run concurrently for better performance
		// Note: AI model is created inside executeDirectChatActivity to avoid serialization issues
		updateProgress(
			"collecting_tools",
			"Gathering context (tools, memory, documents)...",
			15,
			"parallelContextGathering",
		);
		log.info("Starting parallel context gathering");

		// Build parallel activities array
		const parallelActivities: Promise<any>[] = [
			// MCP tools collection
			collectMcpToolsActivity(
				userId,
				organizationId,
				input.enabledMcpConfigIds,
			),
			// Memory context generation
			// SECURITY: Credentials are fetched internally by the activity
			generateMemoryContextActivity(message, userId, organizationId),
		];

		// Add RAG retrieval if documents are attached
		const attachedDocumentIds = input.attachedDocumentIds || [];
		const hasDocuments = attachedDocumentIds.length > 0;
		if (hasDocuments) {
			log.info("Including RAG retrieval in parallel execution", {
				documentCount: attachedDocumentIds.length,
			});
			parallelActivities.push(
				retrieveRagContextForDirectChatActivity(
					message,
					userId,
					organizationId,
					input.chatId,
					attachedDocumentIds,
					5, // topK
					0.1, // minSimilarity
					input.projectId, // enrichment mode when project attached
				),
			);
		}

		// Add workspace document retrieval if workspaces are attached
		const workspaceIds = input.workspaceIds || [];
		const hasWorkspaces = workspaceIds.length > 0;
		if (hasWorkspaces) {
			log.info(
				"Including workspace document retrieval in parallel execution",
				{
					workspaceCount: workspaceIds.length,
				},
			);
			parallelActivities.push(
				retrieveWorkspaceDocumentsActivity(
					message,
					userId,
					organizationId,
					workspaceIds,
					input.workspaceDocumentIds,
				),
			);
		}

		// Execute all activities in parallel
		const parallelResults = await Promise.all(parallelActivities);

		// Extract results with correct types from activity return signatures
		// NOTE: We only extract mcpToolInfo for passing to executeDirectChatActivity
		// The actual tool objects are collected INSIDE the activity to avoid
		// Temporal serialization issues (which strip Schema prototypes/methods)
		const mcpToolsResult = parallelResults[0] as {
			tools: Record<string, unknown>;
			toolToServerMap: Record<
				string,
				{ configId: string; serverName: string }
			>;
			mcpToolInfo: Array<{
				configId: string;
				serverName: string;
				configName: string;
				tools: Array<{ name: string; description?: string }>;
			}>;
		};
		const memoryResult = parallelResults[1] as {
			context: string;
			memoryCount: number;
		};

		// We only use mcpToolInfo - the actual tool collection happens inside executeDirectChatActivity
		const { mcpToolInfo } = mcpToolsResult;
		const { context: memoryContext, memoryCount } = memoryResult;

		log.info("MCP tool info collected", {
			serverCount: mcpToolInfo.length,
		});

		if (memoryCount > 0) {
			log.info("Memory context generated", { memoryCount });
		}

		// Extract RAG context and sources from documents and/or workspaces.
		//
		// The inline entries lead, and every later source is joined onto them
		// rather than replacing them. Both halves have to survive: the inline
		// text is every word of a file the user attached this turn, retrieval is
		// what covers the part a bound cut.
		let ragContext = joinRagContextParts([
			...(input.inlineAttachmentContexts ?? []),
			input.ragContext,
		]);
		let ragSources: Array<{
			id: string;
			title: string;
			type: "document" | "web" | "other";
			excerpt?: string;
			similarity?: number;
		}> = [];

		// Track result index - documents come before workspaces in the array
		let resultIndex = 2;

		// Extract document RAG context if documents were attached
		if (hasDocuments) {
			const ragResult = parallelResults[resultIndex] as {
				context: string;
				chunkCount: number;
				sources?: Array<{
					id: string;
					title: string;
					type: "document" | "web" | "other";
					excerpt?: string;
					similarity?: number;
				}>;
			};
			resultIndex++;
			// Always use the RAG context if available, even with 0 chunks
			// The context may contain helpful messages like "no relevant content found"
			// or error messages that should be communicated to the user
			if (ragResult.context && ragResult.context.length > 0) {
				// Join, matching the workspace branch below. A plain assignment
				// stood here, which is what dropped anything already in
				// `ragContext` — including the inline attachment entries.
				ragContext = joinRagContextParts([
					ragContext,
					ragResult.context,
				]);
				ragSources = ragResult.sources || [];
				log.info("Document RAG context retrieved", {
					chunkCount: ragResult.chunkCount,
					sourceCount: ragSources.length,
					contextLength: ragResult.context.length,
				});
			}
		}

		// Extract workspace document RAG context if workspaces were attached
		if (hasWorkspaces) {
			const workspaceRagResult = parallelResults[resultIndex] as {
				context: string;
				chunkCount: number;
				sources?: Array<{
					id: string;
					title: string;
					type: "document" | "web" | "other";
					excerpt?: string;
					similarity?: number;
				}>;
			};
			// Combine workspace context with existing RAG context
			if (
				workspaceRagResult.context &&
				workspaceRagResult.context.length > 0
			) {
				ragContext = joinRagContextParts([
					ragContext,
					workspaceRagResult.context,
				]);
				ragSources = [
					...ragSources,
					...(workspaceRagResult.sources || []),
				];
				log.info("Workspace RAG context retrieved", {
					chunkCount: workspaceRagResult.chunkCount,
					sourceCount: workspaceRagResult.sources?.length || 0,
					contextLength: workspaceRagResult.context.length,
				});
			}
		}

		updateProgress(
			"generating_suggestions",
			"Analyzing tool suggestions...",
			45,
			"generateToolSuggestionsActivity",
		);

		// Step 2: Generate tool suggestions (depends on mcpToolInfo from step 1)
		log.info("Generating tool suggestions");
		const toolSuggestionContext = await generateToolSuggestionsActivity(
			message,
			mcpToolInfo as Parameters<
				typeof generateToolSuggestionsActivity
			>[1],
		);

		// Step 3: Execute AI interaction
		// Note: Pass ragContext separately (not combined with memory/toolSuggestions)
		// The activity will build the system prompt using all three contexts appropriately
		// Note: AI model is created inside the activity to avoid Temporal serialization issues
		updateProgress(
			"executing_ai",
			"Executing AI interaction...",
			60,
			"executeDirectChatActivity",
		);
		log.info("Executing AI interaction", {
			hasRagContext: ragContext.length > 0,
			ragContextLength: ragContext.length,
			memoryContextLength: memoryContext.length,
		});
		// Pass mcpToolInfo (serializable config data) instead of mcpTools (non-serializable Schema objects)
		// The activity will collect fresh MCP tools internally to avoid Temporal serialization issues
		let result = await executeDirectChatActivity(
			{ ...input, ragContext },
			mcpToolInfo,
			memoryContext,
			toolSuggestionContext,
		);

		// Graceful degradation (#1644): if the turn failed and tools were in
		// scope, retry once with tools disabled so the user still gets an
		// answer instead of a hard error.
		if (
			!result.success &&
			mcpToolInfo.length > 0 &&
			!input.forceDisableTools &&
			patched("direct-chat-no-tools-retry")
		) {
			const firstError = result.error;
			// The retry runs without tools, so its own toolCalls are empty
			// and replacing `result` wholesale would erase every trace of
			// the attempt that failed. When the retry then answers, the user
			// reads a confident "I can't reach that system" with nothing
			// showing that a tool call was attempted and broke — a loud
			// failure quietly turned into a plausible wrong answer. Carry
			// the failed calls across so they stay on screen beside it.
			const firstToolCalls = result.toolCalls ?? [];
			log.warn("Direct chat failed with tools; retrying without tools", {
				error: result.error,
				mcpServerCount: mcpToolInfo.length,
			});
			result = await executeDirectChatActivity(
				{ ...input, ragContext, forceDisableTools: true },
				[],
				memoryContext,
				toolSuggestionContext,
			);
			if (!result.success && !result.error) {
				result = { ...result, error: firstError };
			}
			if (firstToolCalls.length > 0) {
				result = {
					...result,
					toolCalls: [...firstToolCalls, ...(result.toolCalls ?? [])],
				};
			}
		}

		const durationMs = Date.now() - startTime;

		// Update final progress state
		progress = {
			phase: "completed",
			message: "Workflow completed",
			progress: 100,
			toolCalls: result.toolCalls || [],
			responseText: result.responseText,
			pendingConfirmation: result.pendingConfirmation,
		};
		workflowStatus = "completed";

		log.info("Direct chat workflow completed", {
			executionId,
			success: result.success,
			durationMs,
			toolCallCount: result.toolCalls?.length ?? 0,
		});

		// Step 6: start the fire-and-forget child
		// workflow that persists the operation-result system message.
		//
		// Copilot review fix #1: branch on `result.success`.
		// `executeDirectChatActivity` catches its OWN errors internally
		// and returns `{ success: false, error }` WITHOUT throwing (see
		// `packages/temporal/src/activities/direct-chat/ai-execution.ts`
		// catch block, returns the falsy-success shape). When that
		// happens, control reaches HERE (the success branch of the outer
		// try/catch) — but the user has actually seen an error response
		// via the SSE route's `if (!result.success)` arm. Before this fix
		// we always posted `outcome: "success"`, so the persistent chat
		// row disagreed with what the user saw on screen. We now mirror
		// the activity's `success` field into the persisted outcome.
		//
		// Copilot review fix #2: `await startChild(...)` resolves on
		// child START (milliseconds), not on child COMPLETION. With
		// `ParentClosePolicy.PARENT_CLOSE_POLICY_ABANDON` the child
		// continues running independently even after this workflow
		// returns; the SSE route's `await handle.result()` is therefore
		// no longer coupled to the activity's `scheduleToCloseTimeout`.
		if (conversationId) {
			const persistedOutcome: "success" | "failure" = result.success
				? "success"
				: "failure";
			const persistedSummary: string = result.success
				? result.responseText || message
				: result.error || "Unknown error";

			const postOperationInput: DirectChatPostOperationInput = {
				conversationId,
				userId,
				organizationId: organizationId ?? null,
				operationKey: `${executionId}-result`,
				outcome: persistedOutcome,
				operationLabel: instanceId ? "Agent (direct)" : "Direct chat",
				summary: persistedSummary,
			};

			try {
				// `await` only suspends until the child STARTS — not its
				// completion. `PARENT_CLOSE_POLICY_ABANDON` decouples the
				// child's lifecycle from this parent so the SSE "done"
				// event is not held back by Step 6's activity latency.
				await startChild(directChatPostOperationWorkflow, {
					workflowId: `${executionId}-post-op`,
					parentClosePolicy:
						ParentClosePolicy.PARENT_CLOSE_POLICY_ABANDON,
					args: [postOperationInput],
				});
			} catch (postError) {
				// The only way this can throw is if the child workflow
				// failed to START (e.g. workflow already exists with the
				// same id — would happen on a retry of THIS parent
				// workflow against an already-created child). Log + move
				// on; the existing child has its own retry / idempotency
				// guarantees.
				log.warn(
					"Step 6 — failed to start post-operation child (non-fatal)",
					{
						executionId,
						conversationId,
						error:
							postError instanceof Error
								? postError.message
								: String(postError),
					},
				);
			}
		}

		return {
			...result,
			durationMs,
			sources: ragSources.length > 0 ? ragSources : undefined,
		};
	} catch (error) {
		// We delay the `ApplicationFailure` early-return so the failure
		// path's Step 6 call below sees BOTH error shapes uniformly. The
		// activity layer is the canonical source of `ApplicationFailure`
		// (e.g. the executeDirectChatActivity throws ApplicationFailure on
		// non-retryable AI failures); without firing Step 6 for those
		// cases the chat thread would silently lose AC-3 coverage for the
		// most common failure class.
		const errorMessage =
			error instanceof Error ? error.message : "Unknown error";

		// Update progress with error
		progress = {
			...progress,
			phase: "failed",
			message: `Workflow failed: ${errorMessage}`,
			error: errorMessage,
		};
		workflowStatus = "failed";

		log.error("Direct chat workflow failed", {
			executionId,
			error: errorMessage,
		});

		// Step 6: persist the operation-result system
		// message for the failure path. The pure formatter
		// (`buildOperationResultMessage`) masks any stack-trace shape and
		// truncates the body to 2 000 chars, so passing the raw
		// `errorMessage` here is safe. The activity itself swallows all
		// errors internally — the outer try/catch here exists only to
		// guard against the proxy itself failing (e.g. retry-limit
		// exceeded) and must NEVER swallow the original workflow failure.
		//
		// Codex review fix #1 — `isTerminal` guard.
		// `appendConversationMessage` dedups on `operationKey`. If we
		// post a "failure" message and the workflow then RETRIES and
		// succeeds, the dedup means the success message can never
		// replace the stale failure — the user would see a permanent
		// red ✕ for an operation that actually succeeded.
		//
		// `directChatWorkflow` is started with EXPLICIT
		// `retry: { maximumAttempts: 1 }` (see route layer at
		// `apps/web/app/api/agents/fabric-ai/stream/route.ts`,
		// `temporalClient.workflow.start("directChatWorkflow", …)`).
		// That lock makes the `isTerminal` check below permanently
		// sound: even if a future caller starts re-using the same
		// `executionId` (e.g. a "resume" feature), Temporal will not
		// auto-retry the failed workflow.
		//
		// IMPORTANT subtlety (Codex round-3): if the workflow-retry
		// lock is ever removed, this `isTerminal` check is NO LONGER
		// sufficient. An exhausted-retry activity surface as
		// `ActivityFailure` whose underlying `ApplicationFailure.cause`
		// is retryable — this code sees `ActivityFailure` (not an
		// `ApplicationFailure`) at the top level so the `!(error
		// instanceof ApplicationFailure)` arm fires and classifies it
		// as terminal. With workflow retry enabled, that is wrong —
		// the workflow WILL be retried by Temporal and a stale
		// "failure" row would result. To safely remove the workflow-
		// retry lock, replace the check below with one that unwraps
		// `ActivityFailure.cause` and reasons about the activity's
		// retry policy too.
		const isTerminal =
			!(error instanceof ApplicationFailure) ||
			error.nonRetryable === true;
		if (conversationId && isTerminal) {
			const postOperationInput: DirectChatPostOperationInput = {
				conversationId,
				userId,
				organizationId: organizationId ?? null,
				operationKey: `${executionId}-result`,
				outcome: "failure",
				operationLabel: instanceId ? "Agent (direct)" : "Direct chat",
				summary: errorMessage,
			};
			try {
				// Same fire-and-forget pattern as the success path
				// (Copilot review fix #2). The failure path is
				// particularly sensitive — the user has already SEEN the
				// error via SSE deltas before this catch runs, so any
				// inline activity await here would just compound the
				// user's bad experience with extra wait time before
				// the workflow's `await handle.result()` returns.
				await startChild(directChatPostOperationWorkflow, {
					workflowId: `${executionId}-post-op`,
					parentClosePolicy:
						ParentClosePolicy.PARENT_CLOSE_POLICY_ABANDON,
					args: [postOperationInput],
				});
			} catch (postError) {
				log.warn(
					"Step 6 — failed to start post-operation child (non-fatal)",
					{
						executionId,
						conversationId,
						error:
							postError instanceof Error
								? postError.message
								: String(postError),
					},
				);
			}
		} else if (conversationId && !isTerminal) {
			// Retryable failure — intentionally skip Step 6 so a later
			// successful retry can post the real outcome unimpeded. The
			// `errorMessage` is still in the workflow log above.
			log.info(
				"Step 6 — skipping operation-result for retryable failure",
				{ executionId, conversationId },
			);
		}

		if (error instanceof ApplicationFailure) {
			throw error;
		}
		throw ApplicationFailure.nonRetryable(
			errorMessage,
			"DIRECT_CHAT_FAILED",
		);
	}
}
