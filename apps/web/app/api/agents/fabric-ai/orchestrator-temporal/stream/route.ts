/**
 * Fabric AI Orchestrator - Streaming API
 * SSE streaming endpoint for Temporal orchestrator workflow.
 * Starts the workflow and streams progress updates in real-time.
 * Events:
 * - started: Workflow has been started
 * - routing: Agent routing decision made
 * - planning: Task plan created
 * - step_start: A step has started executing
 * - step_complete: A step has completed
 * - tool_start: A tool is being called
 * - tool_result: A tool has returned a result
 * - approval_required: Approval is needed for a step
 * - progress: General progress update
 * - completed: Workflow completed successfully
 * - stream_timeout: The streaming window closed while the workflow is still
 *   running; the client reconnects by POSTing back the executionId
 * - error: An error occurred
 */

import { getDefaultEnabledMcpConfigIds } from "@repo/agent-core/backend";
import { getAIModelWithMetadata } from "@repo/ai";
import { CARRIED_OVER_MARKER_PREFIX, db } from "@repo/database";
import { metricsTracker } from "@repo/observability";
import { AiUsageLimitExceededError } from "@repo/payments";
import type {
	ExecutionMode,
	OrchestratorProgressUpdate,
	OrchestratorStepResult,
	OrchestratorWorkflowInput,
	RagContextRetrievalInput,
	RoutingDecision,
	TaskPlan,
} from "@repo/temporal";
import { getTemporalClient } from "@repo/temporal";
import { REDIS_KEEPALIVE_MS } from "@repo/utils/redis-connection";
import { getSession } from "@saas/auth/lib/server";
import type { NextRequest } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { unionDefaultMcpConfigIds } from "../../union-default-mcp-config-ids";

const POLL_INTERVAL = 200; // Poll every 200ms for faster updates
// Bounds the WHOLE request from entry (see `requestStartedAt` in POST),
// including the up-to-2m RAG pre-work (`ragContextRetrievalWorkflow`,
// `workflowExecutionTimeout: "2m"`) that runs before the poll loop starts —
// a poll-anchored deadline would understate wall clock by that much (issue
// #2269).
const MAX_STREAM_DURATION = 600000; // 10 minutes max
// SSE comment heartbeat so intermediaries don't idle-drop the stream during
// silent stretches between progress events; clients ignore `:` comment lines.
const HEARTBEAT_INTERVAL = 15000;

/**
 * Bounds on inline attachment text, mirroring the zod limits the direct-chat
 * stream route declares. Kept as named constants so the two routes can be
 * compared without reading two different enforcement styles.
 */
const MAX_INLINE_ATTACHMENTS = 20;
const MAX_INLINE_ATTACHMENT_CHARS = 200_000;

/**
 * Build a Redis URL from environment variables.
 * Tries REDIS_URL first, then falls back to CACHE_HOST/CACHE_PORT/CACHE_PASSWORD.
 */
function getRedisUrl(): string | null {
	// Prefer Aspire-injected CACHE_HOST/CACHE_PORT (dynamic port) over
	// static REDIS_URL which may point at a stale port.
	const cacheHost = process.env.CACHE_HOST;
	if (cacheHost) {
		const cachePort = process.env.CACHE_PORT || "6379";
		const password =
			process.env.CACHE_PASSWORD || process.env.REDIS_PASSWORD;
		if (password) {
			return `redis://:${encodeURIComponent(password)}@${cacheHost}:${cachePort}`;
		}
		return `redis://${cacheHost}:${cachePort}`;
	}

	const rawUrl = process.env.REDIS_URL;
	if (rawUrl) {
		try {
			const parsed = new URL(rawUrl);
			if (parsed.password) {
				return rawUrl;
			}
			const password =
				process.env.REDIS_PASSWORD || process.env.CACHE_PASSWORD;
			if (password) {
				parsed.password = password;
				return parsed.toString();
			}
			return rawUrl;
		} catch {
			return rawUrl;
		}
	}

	return null;
}

interface StreamEvent {
	type: string;
	[key: string]: unknown;
}

export async function POST(request: NextRequest) {
	try {
		// Anchors MAX_STREAM_DURATION at request entry, before the RAG
		// pre-work below, so the poll loop's deadline reflects true wall
		// clock rather than understating it by however long that took.
		const requestStartedAt = Date.now();

		const session = await getSession();
		if (!session) {
			return new Response(JSON.stringify({ error: "Unauthorized" }), {
				status: 401,
				headers: { "Content-Type": "application/json" },
			});
		}

		const userId = session.user.id;
		const body = await request.json();

		const {
			message,
			history = [],
			executionId: requestedExecutionId,
			organizationId,
			executionMode = "balanced", // All modes now use iterative execution with mode-specific limits
			enabledMcpConfigIds = null,
			enabledAgentIds = null,
			enabledFabricToolIds = null,
			enabledIntegrationIds = null,
			prioritizedToolIds,
			prioritizedAgentIds,
			prioritizedMcpConfigIds,
			prioritizedIntegrationIds,
			policyContext,
			replayTrajectoryId,
			workspaceIds: providedWorkspaceIds = [],
			projectId: providedProjectId,
			conversationId,
			systemPrompt,
			instanceId,
			chatId,
			attachedDocumentIds = [],
			inlineAttachmentContexts = [],
			attachedImageUrls = [],
			modelOverride,
			surface,
			organizationSlug,
		} = body;

		// Debug: Log workspace IDs received
		console.log(
			"[Orchestrator API] Received workspaceIds:",
			providedWorkspaceIds,
		);
		console.log(
			"[Orchestrator API] Received conversationId:",
			conversationId,
		);
		console.log(
			"[Orchestrator API] Received projectId:",
			providedProjectId,
		);
		console.log("[Orchestrator API] Received prioritization:", {
			prioritizedToolIds,
			prioritizedAgentIds,
			prioritizedMcpConfigIds,
		});
		// Fetch workspace IDs from database if not provided but conversation exists
		// This handles the race condition where frontend sends request before query returns
		let workspaceIds = providedWorkspaceIds;
		if (
			(!providedWorkspaceIds || providedWorkspaceIds.length === 0) &&
			conversationId
		) {
			console.log(
				"[Orchestrator API] Fetching attached workspaces for conversation:",
				conversationId,
			);
			const { getConversationWorkspaces } = await import(
				"@repo/database"
			);
			const attachedWorkspaces =
				await getConversationWorkspaces(conversationId);
			workspaceIds = attachedWorkspaces.map(
				(wc: { workspace: { id: string } }) => wc.workspace.id,
			);
			console.log(
				"[Orchestrator API] Fetched workspaceIds from DB:",
				workspaceIds,
			);
		}

		// Resolve project ID from conversation if not provided
		let projectId = providedProjectId;
		if (!projectId && conversationId) {
			try {
				const { getConversationProject } = await import(
					"@repo/database"
				);
				const conversationProject =
					await getConversationProject(conversationId);
				if (conversationProject?.project) {
					projectId = conversationProject.project.id;
					console.log(
						"[Orchestrator API] Resolved projectId from conversation:",
						projectId,
					);
				}
			} catch (err) {
				console.warn(
					"[Orchestrator API] Failed to resolve project from conversation:",
					err instanceof Error ? err.message : String(err),
				);
			}
		}

		// Seed history with the parent conversation's exhaustion-synthesis
		// summary on every launch of a continued chat. Idempotent — the marker
		// prefix lets us skip seeding when the client already round-tripped it.
		let effectiveHistory = history;
		if (conversationId) {
			try {
				const tenantFilter = organizationId
					? { id: conversationId, userId, organizationId }
					: { id: conversationId, userId, organizationId: null };
				const convo = await db.agentConversation.findFirst({
					where: tenantFilter,
					select: {
						parentConversationId: true,
						carriedOverSummary: true,
					},
				});
				if (convo?.carriedOverSummary) {
					const alreadyPresent = effectiveHistory.some(
						(h: { role?: string; content?: string }) =>
							typeof h?.content === "string" &&
							h.content.startsWith(CARRIED_OVER_MARKER_PREFIX),
					);
					if (!alreadyPresent) {
						effectiveHistory = [
							{
								role: "assistant",
								content: `${CARRIED_OVER_MARKER_PREFIX}\n\n${convo.carriedOverSummary}`,
							},
							...effectiveHistory,
						];
						console.log(
							"[Orchestrator API] Seeded carried-over summary from parent conversation:",
							{
								parentConversationId:
									convo.parentConversationId,
								summaryChars: convo.carriedOverSummary.length,
							},
						);
					}
				}
			} catch (err) {
				console.warn(
					"[Orchestrator API] Failed to load carried-over summary:",
					err instanceof Error ? err.message : String(err),
				);
			}
		}

		// ✅ Security: Verify project access before forwarding to workflow
		if (projectId) {
			try {
				const { hasProjectAccess } = await import("@repo/database");
				const canAccess = await hasProjectAccess(
					projectId,
					userId,
					organizationId ?? undefined,
				);
				if (!canAccess) {
					console.warn(
						"[Orchestrator API] User does not have access to project:",
						projectId,
					);
					projectId = undefined; // Strip unauthorized projectId
				}
			} catch (err) {
				console.warn(
					"[Orchestrator API] Failed to verify project access:",
					err instanceof Error ? err.message : String(err),
				);
				projectId = undefined;
			}
		}

		if (!requestedExecutionId && !message) {
			return new Response(
				JSON.stringify({ error: "message is required" }),
				{
					status: 400,
					headers: { "Content-Type": "application/json" },
				},
			);
		}

		// ✅ Security: Verify organization membership before proceeding
		if (organizationId) {
			const member = await db.member.findFirst({
				where: { userId, organizationId },
			});
			if (!member) {
				console.warn(
					`[Orchestrator Stream] User ${userId} not a member of organization ${organizationId}`,
				);
				return new Response(
					JSON.stringify({
						error: "Forbidden",
						message: "You are not a member of this organization",
					}),
					{
						status: 403,
						headers: { "Content-Type": "application/json" },
					},
				);
			}
		}

		// Get AI model and provider config using centralized entry point.
		// Skipped entirely when the body only carries an `executionId`: that
		// request is a reconnect to a workflow that already passed this
		// chokepoint and was already counted when it started (issue #2269).
		// Re-entering it would double-bill the same run, and worse, could
		// 429 the reconnect on a limit the run itself pushed over — leaving
		// a live Temporal workflow no client can attach to. The workflow
		// resolves its own model on the Temporal worker regardless.
		if (!requestedExecutionId) {
			let aiModelResult: Awaited<
				ReturnType<typeof getAIModelWithMetadata>
			>;
			try {
				// See the note in fabric-ai/stream: the returned model is
				// discarded (only trackUsage is used), so a featureKey here
				// would tag a call that never happens.
				aiModelResult = await getAIModelWithMetadata(
					{ taskType: "TOOL_CALLING" },
					{ userId, organizationId },
				);
			} catch (error) {
				// AI usage-limit chokepoint hit a HARD limit.
				// Surface the structured payload so the
				// orchestrator client renders the shared destructive toast
				// instead of the generic "AI gateway missing" error card.
				if (error instanceof AiUsageLimitExceededError) {
					return new Response(
						JSON.stringify({
							error: error.message,
							code: "AI_USAGE_LIMIT_EXCEEDED",
							data: {
								limitId: error.limitId,
								dimension: error.dimension,
								window: error.window,
								used: error.used.toString(),
								max: error.max.toString(),
								manageLimitsUrl: error.manageLimitsUrl,
							},
						}),
						{
							status: 429,
							headers: { "Content-Type": "application/json" },
						},
					);
				}
				console.error(
					"[Orchestrator Stream] Failed to get AI model:",
					error,
				);
				return new Response(
					JSON.stringify({
						error:
							error instanceof Error
								? error.message
								: "No AI provider configured. Please configure an AI provider in Settings → AI Providers.",
						code: "AI_GATEWAY_MISSING",
					}),
					{
						status: 400,
						headers: { "Content-Type": "application/json" },
					},
				);
			}

			const { trackUsage } = aiModelResult;

			// Track usage (fire-and-forget)
			trackUsage();
		}

		const executionId = requestedExecutionId || `orch-${uuidv4()}`;
		const executionIdPattern = /^orch-[a-f0-9-]{36}$/;
		if (
			typeof executionId !== "string" ||
			!executionIdPattern.test(executionId)
		) {
			return new Response(
				JSON.stringify({ error: "Invalid executionId format" }),
				{
					status: 400,
					headers: { "Content-Type": "application/json" },
				},
			);
		}

		// Get Temporal client
		const temporalClient = await getTemporalClient();

		let messageWithDocumentContext = message ?? "";

		// Files the user attached this turn, delivered whole.
		//
		// Additive to the retrieval below, not a replacement for it. Retrieval
		// returns the top five chunks above a similarity floor, so content
		// reaches the model only if embedding finished, the query matched
		// semantically, and the chunk ranked. Tab-joined spreadsheet rows embed
		// poorly, which makes that least reliable for exactly the format this
		// was built for. Inline gives completeness on a small file; retrieval
		// still covers the part a character budget had to cut.
		// This route parses its body by hand rather than through a zod schema,
		// so the bounds the sibling direct-chat route gets declaratively have
		// to be applied here. Count and per-entry length both: the client
		// already applies the character budget, and this is the server
		// declining to take its word for it.
		if (
			Array.isArray(inlineAttachmentContexts) &&
			inlineAttachmentContexts.length > 0
		) {
			const entries = inlineAttachmentContexts
				.filter(
					(entry: unknown): entry is string =>
						typeof entry === "string" &&
						entry.length > 0 &&
						entry.length <= MAX_INLINE_ATTACHMENT_CHARS,
				)
				.slice(0, MAX_INLINE_ATTACHMENTS);
			if (entries.length > 0) {
				messageWithDocumentContext = `${messageWithDocumentContext}\n\n${entries.join("\n\n")}`;
			}
		}

		if (
			chatId &&
			typeof message === "string" &&
			message.trim().length > 0 &&
			Array.isArray(attachedDocumentIds) &&
			attachedDocumentIds.length > 0
		) {
			try {
				const chatTenantFilter = organizationId
					? { id: chatId, userId, organizationId }
					: { id: chatId, userId, organizationId: null };
				const chat = await db.aiChat.findFirst({
					where: chatTenantFilter,
					select: { id: true, organizationId: true },
				});

				if (chat) {
					const workflowInput: RagContextRetrievalInput = {
						chatId: chat.id,
						userId,
						organizationId: chat.organizationId || undefined,
						query: message,
						topK: 5,
						minSimilarity: 0.5,
						documentIds: attachedDocumentIds,
					};
					const ragHandle = await temporalClient.workflow.start(
						"ragContextRetrievalWorkflow",
						{
							taskQueue: "document-processing",
							workflowId: `orchestrator-rag-${chat.id}-${Date.now()}-${uuidv4().slice(0, 8)}`,
							args: [workflowInput],
							workflowExecutionTimeout: "2m",
						},
					);
					const ragResult = await ragHandle.result();

					if (ragResult.success && ragResult.context) {
						// Append to what is already here rather than rebuilding from
						// `message`, which would drop the inline entries added
						// above — the same overwrite-instead-of-join shape that
						// discarded them inside the direct-chat workflow.
						messageWithDocumentContext = `${messageWithDocumentContext}\n\n${ragResult.context}`;
					}
				}
			} catch (error) {
				console.error(
					"[Orchestrator Stream] Failed to retrieve attached document context:",
					error,
				);
			}
		}

		// Union default-enabled MCP config ids into the caller-restricted set
		// so managed-default servers (e.g. Excalidraw, when `defaultEnabled`)
		// are eligible for eager-routing inside the orchestrator workflow.
		// On helper failure, log and proceed with the original array — the
		// workflow's defense-in-depth at `applyDefaultMcpEagerRouting`
		// still resolves via `findDefaultMcpConfigActivity`.
		//
		// `unionDefaultMcpConfigIds` guards the same three-state contract the
		// prioritized-ids union below already respects: `null` ("all configs
		// enabled") and `[]` ("explicitly none") pass through untouched, since
		// unioning into either would narrow it to the defaults alone.
		let effectiveEnabledMcpConfigIds: string[] | null = enabledMcpConfigIds;
		try {
			const defaultIds = await getDefaultEnabledMcpConfigIds(
				userId,
				organizationId ?? null,
			);
			effectiveEnabledMcpConfigIds = unionDefaultMcpConfigIds(
				enabledMcpConfigIds,
				defaultIds,
			);
		} catch (defaultIdsError) {
			console.warn(
				"[Orchestrator Stream] Failed to union default-enabled MCP config ids — proceeding with caller-supplied array",
				defaultIdsError,
			);
		}

		// Prioritizing implies enabling (issue #2182): the UI can star a
		// server without adding it to the conversation tool selection, which
		// leaves the planner biased toward tools the ToolIndex then excludes
		// as "config not enabled". Union the prioritized ids into the
		// effective set — but only when the caller restricted it: `null`
		// means "all configs enabled" and must stay null.
		if (
			Array.isArray(effectiveEnabledMcpConfigIds) &&
			Array.isArray(prioritizedMcpConfigIds) &&
			prioritizedMcpConfigIds.length > 0
		) {
			effectiveEnabledMcpConfigIds = Array.from(
				new Set([
					...effectiveEnabledMcpConfigIds,
					...prioritizedMcpConfigIds,
				]),
			);
		}

		// Build workflow input
		// SECURITY: Credentials are NOT passed in workflow inputs
		// Activities fetch credentials internally to avoid storing them in Temporal history
		const workflowInput: OrchestratorWorkflowInput = {
			executionId,
			message: messageWithDocumentContext,
			history: effectiveHistory,
			userId,
			organizationId,
			executionMode: executionMode as ExecutionMode,
			enabledMcpConfigIds: effectiveEnabledMcpConfigIds,
			enabledAgentIds,
			enabledFabricToolIds,
			enabledIntegrationIds,
			prioritizedToolIds,
			prioritizedAgentIds,
			prioritizedMcpConfigIds,
			prioritizedIntegrationIds,
			policyContext,
			replayTrajectoryId,
			workspaceIds,
			projectId,
			// Propagate the AgentConversation ID so the
			// completion phase's Step 6 (`postOperationResultActivity`) can
			// append a persistent operation-result system message. The
			// orchestrator already accepted this field for episodic memory
			// (Letta) on this surface (`workflow-io.types.ts:71`); PR2
			// merely starts forwarding it from the route layer too. When
			// `conversationId` is absent — e.g. a Nexus-CopilotPage caller
			// that hasn't been mapped to an `AgentConversation` yet — Step
			// 6 quietly no-ops (existing behaviour preserved).
			conversationId,
			systemPrompt,
			instanceId,
			attachedImageUrls:
				attachedImageUrls.length > 0 ? attachedImageUrls : undefined,
			// Forward the paperclip attachments so the agent loop can show
			// image-typed ones to vision-capable models as real pixels. The RAG
			// description (resolved above) still covers non-vision models.
			attachedDocumentIds:
				attachedDocumentIds.length > 0
					? attachedDocumentIds
					: undefined,
			modelOverride,
			surface,
			organizationSlug,
		};

		// Set up streaming response
		const encoder = new TextEncoder();

		// Hoisted above `start()` so `cancel()` — a sibling method on the same
		// ReadableStream underlying source, not a nested closure — can share
		// them: mark the stream closed and tear down the Redis subscriber when
		// the client disconnects (issue #2269).
		let controllerClosed = false;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- ioredis is dynamically imported
		let redisSubscriber: any = null;
		const cleanupRedis = () => {
			if (redisSubscriber) {
				try {
					redisSubscriber.unsubscribe();
					redisSubscriber.quit();
				} catch {
					// Ignore cleanup errors
				}
				redisSubscriber = null;
			}
		};

		const stream = new ReadableStream({
			async start(controller) {
				const sendEvent = (event: StreamEvent) => {
					if (controllerClosed) {
						return; // Don't send if controller is closed
					}
					try {
						controller.enqueue(
							encoder.encode(
								`data: ${JSON.stringify(event)}\n\n`,
							),
						);
					} catch {
						// Controller might be closed, mark it
						controllerClosed = true;
					}
				};

				const stableSerialize = (value: unknown): string => {
					try {
						return JSON.stringify(value) ?? "";
					} catch {
						return String(value);
					}
				};

				type StreamedToolCall = {
					id: string;
					name: string;
					serverName?: string;
					args?: Record<string, unknown>;
					result?: unknown;
					status: "pending" | "running" | "complete" | "error";
					durationMs?: number;
					error?: string;
					mcpAppResourceUri?: string;
					mcpAppConfigId?: string;
				};

				const lastToolSnapshots = new Map<
					string,
					{
						args: string;
						result: string;
						status: string;
						started: boolean;
					}
				>();

				const emitToolCallDelta = (toolCall: StreamedToolCall) => {
					const previous = lastToolSnapshots.get(toolCall.id);
					const nextArgs = stableSerialize(toolCall.args ?? null);
					const nextResult = stableSerialize(toolCall.result ?? null);

					if (!previous?.started) {
						sendEvent({
							type: "tool_start",
							toolCallId: toolCall.id,
							toolName: toolCall.name,
							serverName: toolCall.serverName,
							args: toolCall.args,
							status: toolCall.status,
							mcpAppResourceUri: toolCall.mcpAppResourceUri,
							mcpAppConfigId: toolCall.mcpAppConfigId,
						});
					}

					if (previous === undefined || nextArgs !== previous.args) {
						sendEvent({
							type: "tool_input",
							toolCallId: toolCall.id,
							toolName: toolCall.name,
							serverName: toolCall.serverName,
							args: toolCall.args,
							status: toolCall.status,
							mcpAppResourceUri: toolCall.mcpAppResourceUri,
							mcpAppConfigId: toolCall.mcpAppConfigId,
						});
					}

					if (
						(toolCall.status === "complete" ||
							toolCall.status === "error") &&
						(previous === undefined ||
							previous.status !== toolCall.status ||
							nextResult !== previous.result)
					) {
						sendEvent({
							type: "tool_result",
							toolCallId: toolCall.id,
							toolName: toolCall.name,
							serverName: toolCall.serverName,
							result: toolCall.result,
							status: toolCall.status,
							durationMs: toolCall.durationMs,
							error: toolCall.error,
							mcpAppResourceUri: toolCall.mcpAppResourceUri,
							mcpAppConfigId: toolCall.mcpAppConfigId,
						});
					}

					lastToolSnapshots.set(toolCall.id, {
						args: nextArgs,
						result: nextResult,
						status: toolCall.status,
						started: true,
					});
				};

				const closeController = () => {
					if (!controllerClosed) {
						controllerClosed = true;
						try {
							controller.close();
						} catch {
							// Already closed
						}
					}
				};

				// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Temporal WorkflowHandle from getHandle/start
				let handle: any;

				try {
					// =====================================================================
					// For resume: verify ownership BEFORE subscribing to Redis
					// =====================================================================
					if (requestedExecutionId) {
						handle = temporalClient.workflow.getHandle(executionId);
						const description = await handle.describe();

						// ✅ Security: Verify the caller owns this workflow
						const memo = description.memo as
							| Record<string, unknown>
							| undefined;
						const workflowUserId = memo?.userId;
						const workflowOrgId = memo?.organizationId;
						if (workflowUserId && workflowUserId !== userId) {
							sendEvent({
								type: "error",
								error: "You are not authorized to access this workflow",
							});
							controller.close();
							controllerClosed = true;
							return;
						}
						if (workflowOrgId) {
							const member = await db.member.findFirst({
								where: {
									userId,
									organizationId: workflowOrgId as string,
								},
							});
							if (!member) {
								sendEvent({
									type: "error",
									error: "You are not a member of this organization",
								});
								controller.close();
								controllerClosed = true;
								return;
							}
						}
					}

					// =====================================================================
					// Redis Subscriber (real-time text deltas from streamText)
					// IMPORTANT: Subscribe BEFORE starting the workflow to avoid missing
					// early events (Redis pub/sub does not buffer messages).
					// For resume, ownership was already verified above.
					// =====================================================================
					const redisUrl = getRedisUrl();
					if (redisUrl) {
						try {
							const Redis = (await import("ioredis")).default;
							redisSubscriber = new Redis(redisUrl, {
								maxRetriesPerRequest: 1,
								// Without this, ioredis disables TCP keepalive and an idle
								// connection is reaped upstream, surfacing as ECONNRESET on the
								// next write instead of a clean reconnect.
								keepAlive: REDIS_KEEPALIVE_MS,
								connectTimeout: 3000,
								lazyConnect: true,
								enableOfflineQueue: false,
							});

							// Attach the error listener BEFORE connect(). ioredis
							// emits `error` during the connection attempt itself, and
							// an `error` event with no listener is re-raised by Node
							// as "[ioredis] Unhandled error event" at process level —
							// 642 of them in production between 2026-06-17 and
							// 2026-08-07, all charged to this route. The publisher in
							// `@repo/temporal` already orders it this way; this route
							// registered the listener after connect() and so had no
							// listener during the only window that reliably throws.
							redisSubscriber.on("error", (err: Error) => {
								console.warn(
									"[Orchestrator Stream] Redis subscriber error:",
									err.message,
								);
								if (redisSubscriber) {
									redisSubscriber.disconnect();
									redisSubscriber = null;
								}
							});

							await redisSubscriber.connect();

							// Attach handlers BEFORE subscribing to avoid missing
							// messages between subscribe acknowledgement and handler registration
							redisSubscriber.on(
								"message",
								(_ch: string, message: string) => {
									if (controllerClosed) {
										return;
									}
									try {
										const event = JSON.parse(message);
										if (
											event.event ===
											"execution.text_delta"
										) {
											sendEvent({
												type: "text_delta",
												content: event.data?.text || "",
											});
										} else if (
											event.event ===
											"execution.iteration_start"
										) {
											sendEvent({
												type: "text_start",
												iteration:
													event.data?.iteration,
											});
										} else if (
											event.event ===
											"execution.tool_start"
										) {
											const toolCall = event.data
												?.toolCall as
												| StreamedToolCall
												| undefined;
											if (toolCall?.id && toolCall.name) {
												emitToolCallDelta(toolCall);
											}
										} else if (
											event.event ===
											"execution.tool_input"
										) {
											const toolCall = event.data
												?.toolCall as
												| StreamedToolCall
												| undefined;
											if (toolCall?.id && toolCall.name) {
												emitToolCallDelta(toolCall);
											}
										} else if (
											event.event ===
											"execution.tool_complete"
										) {
											const toolCall = event.data
												?.toolCall as
												| StreamedToolCall
												| undefined;
											if (toolCall?.id && toolCall.name) {
												emitToolCallDelta(toolCall);
											}
										} else if (
											event.event ===
											"execution.limit_signal"
										) {
											// Forward token-budget /
											// provider-limit signals so the UI can show
											// a banner + toast while the run continues.
											sendEvent({
												type: "limit_signal",
												signal: event.data,
											});
											const signalData = event.data as
												| {
														kind?: string;
														provider?: string;
												  }
												| undefined;
											if (signalData?.kind) {
												metricsTracker.trackAiLimitSignal(
													signalData.kind,
													signalData.provider,
												);
											}
										} else if (
											event.event ===
											"execution.context_compacted"
										) {
											sendEvent({
												type: "context_compacted",
												...(event.data as Record<
													string,
													unknown
												>),
											});
										} else if (
											event.event ===
											"execution.mcp_default_tool_invoked"
										) {
											// Forward the managed-default MCP
											// success signal to the client.
											// The consumer hook passes the
											// payload as the second arg to
											// `useAnalytics.trackEvent`.
											sendEvent({
												type: "mcp_default_tool_invoked",
												payload: event.data,
											});
										} else if (
											event.event ===
											"execution.mcp_default_tool_failed"
										) {
											// Failure counterpart of the
											// above. The `errorMessage` field
											// has already been run through
											// `sanitizeMcpErrorMessage` at
											// the emission site, so no further
											// redaction is needed.
											sendEvent({
												type: "mcp_default_tool_failed",
												payload: event.data,
											});
										}
									} catch {
										// Invalid message, skip
									}
								},
							);

							const channel = `execution:${executionId}`;
							await redisSubscriber.subscribe(channel);

							console.log(
								`[Orchestrator Stream] Redis subscriber connected for ${channel}`,
							);
						} catch (err) {
							console.warn(
								"[Orchestrator Stream] Redis unavailable, text will appear on completion:",
								err instanceof Error
									? err.message
									: String(err),
							);
							// Disconnect before dropping the reference. Nulling alone
							// leaks the instance and its background reconnect timers
							// for the life of the (reused) function instance, which is
							// what turned one bad URL into a repeating error stream.
							// The error listener above may already have done both.
							if (redisSubscriber) {
								try {
									redisSubscriber.disconnect();
								} catch {
									// already torn down
								}
								redisSubscriber = null;
							}
						}
					}

					if (requestedExecutionId) {
						// handle was already set and ownership verified above
						console.log(
							`[Orchestrator Stream] Attached to workflow: ${executionId}`,
						);
					} else {
						handle = await temporalClient.workflow.start(
							"orchestratorExecutionWorkflow",
							{
								taskQueue: "fabric-orchestrator",
								workflowId: executionId,
								args: [workflowInput],
								// Absolute wall-clock ceiling. Every activity in
								// this workflow already bounds itself
								// (`startToCloseTimeout` + `heartbeatTimeout`) and
								// every human-in-the-loop `condition()` wait is
								// bounded too, so no single step can hang — but
								// without this the RUN as a whole had no ceiling,
								// and a wedged one stayed RUNNING with nothing to
								// reclaim it. The weave caller of this very
								// workflow already passes one
								// (`start-execution.ts`), and the document-refresh
								// workflow uses an hour for the same reason.
								//
								// An hour is far above a normal run (the stream
								// itself caps at 11 minutes and reattaches on
								// resume) and far below "forever". A run that
								// exceeds it surfaces as TIMED_OUT, which the poll
								// loop below already renders as an error rather
								// than spinning to the stream deadline.
								workflowExecutionTimeout: "1 hour",
								memo: {
									userId,
									organizationId: organizationId ?? null,
								},
							},
						);

						console.log(
							`[Orchestrator Stream] Started workflow: ${executionId}`,
						);
					}

					// Send started event
					sendEvent({
						type: "started",
						executionId,
						workflowId: handle.workflowId,
						resumed: Boolean(requestedExecutionId),
					});

					// Track state for change detection
					let lastProgress: OrchestratorProgressUpdate | null = null;
					let lastPlan: TaskPlan | null = null;
					let lastStepResultsCount = 0;
					let lastPhase = "";
					let lastPendingApproval: {
						approvalId: string;
						stepId: string;
						reason: string;
					} | null = null;
					let lastPendingClarification: {
						clarificationId: string;
						question: string;
						options?: string[];
					} | null = null;
					let isComplete = false;
					let lastHeartbeatAt = Date.now();

					// Poll for updates
					while (
						!isComplete &&
						!controllerClosed &&
						Date.now() - requestStartedAt < MAX_STREAM_DURATION
					) {
						try {
							if (
								Date.now() - lastHeartbeatAt >=
								HEARTBEAT_INTERVAL
							) {
								lastHeartbeatAt = Date.now();
								if (!controllerClosed) {
									try {
										controller.enqueue(
											encoder.encode(": ping\n\n"),
										);
									} catch {
										controllerClosed = true;
									}
								}
							}

							const description = await handle.describe();

							if (description.status.name === "COMPLETED") {
								// Get final result
								const result = await handle.result();

								// Query progress one more time to get proper per-step results
								let workflowStepResults: OrchestratorStepResult[] =
									[];
								try {
									const finalProgress: OrchestratorProgressUpdate =
										await handle.query("progress");
									if (
										finalProgress?.stepResults &&
										finalProgress.stepResults.length > 0
									) {
										workflowStepResults =
											finalProgress.stepResults as OrchestratorStepResult[];
									}
								} catch {
									// Query might fail if workflow ended too quickly
								}

								// Send step_complete events for any steps not yet sent
								if (
									workflowStepResults.length >
									lastStepResultsCount
								) {
									for (
										let i = lastStepResultsCount;
										i < workflowStepResults.length;
										i++
									) {
										const stepResult =
											workflowStepResults[i];
										for (const toolCall of stepResult.toolCalls ||
											[]) {
											if (toolCall?.id && toolCall.name) {
												emitToolCallDelta(
													toolCall as StreamedToolCall,
												);
											}
										}
										sendEvent({
											type: "step_complete",
											stepId: stepResult.stepId,
											stepDescription:
												stepResult.stepDescription,
											status: stepResult.status,
											response: stepResult.response,
											toolCalls:
												stepResult.toolCalls || [],
											durationMs: stepResult.durationMs,
										});
									}
								}

								// Use workflow's per-step results if available, otherwise fallback to flat tool calls
								const stepResults: OrchestratorStepResult[] =
									workflowStepResults.length > 0
										? workflowStepResults
										: result.toolCalls?.length > 0
											? [
													{
														stepId: "execution",
														stepDescription:
															"Task execution",
														status: "complete" as const,
														response:
															result.response,
														toolCalls:
															result.toolCalls,
														durationMs:
															result.totalDurationMs ||
															0,
													},
												]
											: [];

								if (workflowStepResults.length === 0) {
									for (const toolCall of result.toolCalls ||
										[]) {
										if (toolCall?.id && toolCall.name) {
											emitToolCallDelta(
												toolCall as StreamedToolCall,
											);
										}
									}
								}

								// The workflow can soft-fail while Temporal still
								// reports COMPLETED (result.status === "failed",
								// e.g. the orchestrator's dropped tool-call guard
								// exhausting its retry and returning a persistent
								// stream_error). Forwarding that as a "completed"
								// SSE event renders the run as successful
								// client-side and can leave a partial stub as the
								// final response — this is exactly how staging
								// orch-9294c339 stayed silent. Surface it as
								// `error` instead; `cancelled` (and any other
								// non-"failed" status) still flows through the
								// normal `completed` emit below, unchanged.
								if (result.status === "failed") {
									sendEvent({
										type: "error",
										message:
											result.error ??
											"Workflow execution failed",
									});
								} else {
									// Send completed event with final response
									sendEvent({
										type: "completed",
										status: result.status,
										response: result.response,
										plan: result.taskPlan,
										variables: result.variables,
										stepResults,
										toolCalls: result.toolCalls || [],
										planningAudit: result.planningAudit,
										artifacts: result.artifacts,
										handoffRecommended:
											result.handoffRecommended,
									});
								}

								isComplete = true;
							} else if (description.status.name === "FAILED") {
								// Try to get the actual error from the workflow result
								let errorMessage = "Workflow execution failed";
								try {
									const result = await handle.result();
									if (result?.error) {
										errorMessage = result.error;
									}
								} catch (resultError: unknown) {
									// Extract error message from the failure
									if (resultError instanceof Error) {
										errorMessage = resultError.message;
									}
								}
								sendEvent({
									type: "error",
									message: errorMessage,
								});
								isComplete = true;
							} else if (
								description.status.name === "CANCELLED"
							) {
								sendEvent({
									type: "error",
									message: "Workflow was cancelled",
								});
								isComplete = true;
							} else if (
								description.status.name === "TERMINATED"
							) {
								// An operator/API terminate is as final as
								// FAILED, but reports its own status name. Left
								// unhandled the loop would spin to the deadline
								// and the client would spend resume windows
								// re-attaching to a workflow that can never
								// progress (issue #2269).
								sendEvent({
									type: "error",
									message: "Workflow was terminated",
								});
								isComplete = true;
							} else if (
								description.status.name === "TIMED_OUT"
							) {
								// Temporal's own execution/run timeout — same
								// reasoning as TERMINATED above.
								sendEvent({
									type: "error",
									message: "Workflow timed out on the server",
								});
								isComplete = true;
							} else {
								// Query current state
								try {
									const progress: OrchestratorProgressUpdate =
										await handle.query("progress");
									const plan: TaskPlan | null =
										await handle.query("plan");
									const pendingApproval: {
										approvalId: string;
										stepId: string;
										reason: string;
									} | null =
										await handle.query("pendingApproval");

									const pendingClarification: {
										clarificationId: string;
										stepId?: string;
										question: string;
										options?: string[];
									} | null = await handle.query(
										"pendingClarification",
									);

									// Try to get routing decision from a separate query
									let routingDecision: RoutingDecision | null =
										null;
									try {
										routingDecision =
											await handle.query(
												"routingDecision",
											);
									} catch {
										// Routing decision query may not be available
									}

									// Check for phase change
									if (
										progress?.phase &&
										progress.phase !== lastPhase
									) {
										lastPhase = progress.phase;
										sendEvent({
											type: "phase",
											phase: progress.phase,
											message: progress.message,
										});

										// Send routing decision when available
										if (
											progress.phase === "planning" &&
											routingDecision
										) {
											sendEvent({
												type: "routing",
												primaryAgent:
													routingDecision.primaryAgent,
												agentName:
													routingDecision.primaryAgent, // Use primaryAgent as name
												confidence:
													routingDecision.confidence,
												riskLevel:
													routingDecision.riskLevel,
												requiredConnections:
													routingDecision.requiredConnections,
												missingIntegrations:
													routingDecision.missingIntegrations,
												blockedOnConnections:
													routingDecision.blockedOnConnections,
											});
										}
									}

									// Check for new plan
									if (plan && !lastPlan) {
										lastPlan = plan;
										sendEvent({
											type: "planning",
											plan: {
												id: plan.id,
												description: plan.description,
												riskLevel: plan.riskLevel,
												steps: plan.steps.map((s) => ({
													id: s.id,
													description: s.description,
													order: s.order,
													status: s.status,
													riskLevel: s.riskLevel,
													requiresApproval:
														s.requiresApproval,
												})),
											},
										});
									}

									// Check for step progress
									if (progress?.stepResults) {
										const stepResults =
											progress.stepResults as OrchestratorStepResult[];

										// Send new step results with their tool calls
										if (
											stepResults.length >
											lastStepResultsCount
										) {
											for (
												let i = lastStepResultsCount;
												i < stepResults.length;
												i++
											) {
												const result = stepResults[i];
												for (const toolCall of result.toolCalls ||
													[]) {
													if (
														toolCall?.id &&
														toolCall.name
													) {
														emitToolCallDelta(
															toolCall as StreamedToolCall,
														);
													}
												}
												// Send step_complete with full data including tool calls
												sendEvent({
													type: "step_complete",
													stepId: result.stepId,
													stepDescription:
														result.stepDescription,
													status: result.status,
													response: result.response,
													toolCalls:
														result.toolCalls || [],
													durationMs:
														result.durationMs,
												});
											}
											lastStepResultsCount =
												stepResults.length;
										}
									}

									// Check for current step
									if (progress?.currentStep && lastPlan) {
										const currentStepId =
											progress.currentStep.id;
										const planStep = lastPlan.steps.find(
											(s) => s.id === currentStepId,
										);
										if (
											planStep &&
											planStep.status === "in_progress"
										) {
											sendEvent({
												type: "step_start",
												stepId: currentStepId,
												description:
													progress.currentStep
														.description,
												order: planStep.order,
											});
										}
									}

									// Check for pending approval changes
									// Handle three cases:
									// 1. New approval (no previous pending)
									// 2. Different approval (previous resolved, new one created)
									// 3. Approval resolved (previous pending, now none)
									if (pendingApproval) {
										// Check if this is a new or different approval
										const isNewApproval =
											!lastPendingApproval;
										const isDifferentApproval =
											lastPendingApproval &&
											lastPendingApproval.approvalId !==
												pendingApproval.approvalId;

										if (
											isNewApproval ||
											isDifferentApproval
										) {
											// If there was a previous approval that's now different, it was resolved
											if (
												isDifferentApproval &&
												lastPendingApproval
											) {
												sendEvent({
													type: "approval_resolved",
													approvalId:
														lastPendingApproval.approvalId,
													stepId: lastPendingApproval.stepId,
													message:
														"Approval granted - proceeding to next step",
												});
											}
											// Now send the new approval requirement
											lastPendingApproval =
												pendingApproval;
											sendEvent({
												type: "approval_required",
												approvalId:
													pendingApproval.approvalId,
												stepId: pendingApproval.stepId,
												reason: pendingApproval.reason,
											});
										}
									} else if (lastPendingApproval) {
										// Approval was resolved with no new approval pending
										const resolvedApproval =
											lastPendingApproval;
										lastPendingApproval = null;
										sendEvent({
											type: "approval_resolved",
											approvalId:
												resolvedApproval.approvalId,
											stepId: resolvedApproval.stepId,
											message:
												"Approval granted - execution resuming",
										});
									}

									// Clarifying-question HITL — sibling of approval above.
									if (pendingClarification) {
										const isNewClarification =
											!lastPendingClarification;
										const isDifferentClarification =
											lastPendingClarification &&
											lastPendingClarification.clarificationId !==
												pendingClarification.clarificationId;
										if (
											isNewClarification ||
											isDifferentClarification
										) {
											if (
												isDifferentClarification &&
												lastPendingClarification
											) {
												sendEvent({
													type: "clarifying_resolved",
													clarificationId:
														lastPendingClarification.clarificationId,
												});
											}
											lastPendingClarification =
												pendingClarification;
											sendEvent({
												type: "clarifying_question",
												clarificationId:
													pendingClarification.clarificationId,
												stepId: pendingClarification.stepId,
												question:
													pendingClarification.question,
												options:
													pendingClarification.options,
											});
										}
									} else if (lastPendingClarification) {
										const resolvedClarification =
											lastPendingClarification;
										lastPendingClarification = null;
										sendEvent({
											type: "clarifying_resolved",
											clarificationId:
												resolvedClarification.clarificationId,
										});
									}

									// Send progress update
									if (
										progress &&
										(progress.completedSteps !==
											lastProgress?.completedSteps ||
											progress.totalSteps !==
												lastProgress?.totalSteps ||
											progress.message !==
												lastProgress?.message)
									) {
										lastProgress = progress;
										sendEvent({
											type: "progress",
											completedSteps:
												progress.completedSteps,
											totalSteps: progress.totalSteps,
											message: progress.message,
											phase: progress.phase,
										});
									}
								} catch {
									// Queries might fail if workflow just started - this is normal, don't log
								}
							}
						} catch (pollError) {
							console.error(
								"[Orchestrator Stream] Poll error:",
								pollError,
							);
						}

						// Wait before next poll
						await new Promise((resolve) =>
							setTimeout(resolve, POLL_INTERVAL),
						);
					}

					// Streaming-window handoff (issue #2269 option 2). The
					// workflow is still running on Temporal — reaching this
					// point only means the HTTP stream has to end, because the
					// Vercel function budget (`maxDuration` below) is nearly
					// spent. Emitting `error` here would fail a healthy run;
					// instead hand the client the executionId so it reconnects
					// and the poll loop replays every completed step into the
					// next window.
					if (!isComplete) {
						sendEvent({
							type: "stream_timeout",
							executionId,
							message:
								"Streaming window closed; reconnect with this executionId to continue",
						});
					}

					cleanupRedis();
					closeController();
				} catch (error) {
					console.error("[Orchestrator Stream] Error:", error);
					sendEvent({
						type: "error",
						message:
							error instanceof Error
								? error.message
								: "Stream failed",
					});
					cleanupRedis();
					closeController();
				}
			},
			cancel() {
				// Called when the client disconnects
				controllerClosed = true;
				cleanupRedis();
				console.log(
					"[Orchestrator Stream] Client disconnected, stream cancelled",
				);
			},
		});

		return new Response(stream, {
			headers: {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
			},
		});
	} catch (error) {
		console.error("[Orchestrator Stream] Error:", error);
		return new Response(
			JSON.stringify({
				error: error instanceof Error ? error.message : "Stream failed",
			}),
			{
				status: 500,
				headers: { "Content-Type": "application/json" },
			},
		);
	}
}

export const runtime = "nodejs";

// MAX_STREAM_DURATION (600s) is anchored at request entry (requestStartedAt),
// so 660s gives ~60s of headroom for the graceful `stream_timeout` handoff
// event to be delivered before Vercel's platform-level hard kill (issue
// #2269).
export const maxDuration = 660;
