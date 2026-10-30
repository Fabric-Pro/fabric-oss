import { enterAiInteractiveContext } from "@repo/ai/lib/chatgpt-plan/interactive-context";
import {
	type ChatGptPlanChatPreflight,
	withChatGptPlanApiBilling,
} from "@repo/ai/lib/chatgpt-plan/plan-spent-response";
import {
	abandonConversationTurnStart,
	type ConversationTurn,
	getConversationTurnForExecution,
	getConversationTurnOwnerForExecution,
} from "@repo/database";
import { getTemporalClient } from "@repo/temporal";
import type { AssertAssignable } from "@saas/agents/lib/chat-stream-protocol";
import { limitSchema } from "@saas/agents/lib/direct-stream-protocol";
import type { OrchestratorStreamInput } from "@saas/agents/lib/orchestrator-stream-protocol";
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

import { encodeOrchestratorStreamEvent } from "@saas/agents/lib/orchestrator-stream-protocol";
import { getAuthorizedChatRun } from "@saas/agents/lib/server/chat-run-control";
import { subscribeExecutionEvents } from "@saas/agents/lib/server/execution-event-subscriber";
import { getSession } from "@saas/auth/lib/server";
import type { NextRequest } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { buildWorkflowErrorEvent } from "../../stream/turn-events";
import { InvalidBudgetContinuationError } from "../budget-continuation";
import { createOrchestratorExecutionObserver } from "../execution-observer";
import {
	billOrchestratorTurn,
	buildOrchestratorWorkflowInput,
	filterOrchestratorTurnWorkspaces,
	refuseOversizedOrchestratorInput,
	resolveOrchestratorTurnRequest,
} from "../orchestrator-turn";
import {
	isOrchestratorOrganizationMember,
	refuseUnlessRunOwner,
} from "../run-access";
import {
	admitChatTurn,
	cancelledBeforeStartResponse,
	cancelTurnBeforeStart,
	executionModeUsesTurns,
	isCancelledBeforeStart,
	isTerminalTurnStatus,
	resultStatusForTurn,
	settleAbandonedTurn,
	startLegacyChatWorkflow,
	startTurnWorkflow,
	TurnStartAmbiguousError,
	TurnStoppedBeforeStartError,
	turnBudgetStopForStream,
	turnPendingResponse,
	turnStateUnavailableResponse,
	waitForTurnWorkflow,
} from "../turn-admission";

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

export async function POST(request: NextRequest) {
	// The turn this request admitted and must start. Until it is handed to
	// the SSE stream (which starts it), any early return or throw abandons
	// it — and an abandoned START_PENDING turn would hold the conversation
	// until a reconcile, so the `finally` below ends it FAILED.
	let turnToStart: ConversationTurn | null = null;
	let turnSettled = false;
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
		// This person's own request — or an admin acting as them, which no
		// ChatGPT plan may serve (Fizzy #2939).
		enterAiInteractiveContext({
			userId: session.user.id,
			impersonated: Boolean(session.session.impersonatedBy),
		});

		const userId = session.user.id;
		const body = await request.json();

		// The hand parser, organization tie, conversation, key, budget
		// continuation, workspaces, project, usage frame and history: see
		// ../orchestrator-turn.ts, shared with the agent runtime.
		const turnRequest = await resolveOrchestratorTurnRequest({
			session,
			body,
		});
		if (turnRequest instanceof Response) {
			return turnRequest;
		}
		const {
			organizationId,
			conversationId,
			continueFromTurnId,
			executionMode,
			message,
			requestedExecutionId,
			projectId,
		} = turnRequest;

		// Get Temporal client
		const temporalClient = await getTemporalClient();

		// =====================================================================
		// Turn admission (Advisor chat turns). A new message is admitted
		// through the durable turn record BEFORE any billed or slow pre-work:
		// a retry of the same message (same clientRequestKey) attaches to the
		// turn it already created, a second live turn in the conversation is
		// refused with its executionId, and a key Stop already cancelled is
		// refused. See ../turn-admission.ts.
		// =====================================================================
		let newTurn = false;
		// A Weave message gets no turn and the legacy start (the Planner,
		// `save_reuse`, runs as a turn like every other mode): see
		// `executionModeUsesTurns`.
		let legacyExecutionId: string | undefined;
		let resumeExecutionId: string | undefined =
			typeof requestedExecutionId === "string" && requestedExecutionId
				? requestedExecutionId
				: undefined;
		if (!resumeExecutionId && !executionModeUsesTurns(executionMode)) {
			legacyExecutionId = `orch-${uuidv4()}`;
		} else if (!resumeExecutionId) {
			const admission = await admitChatTurn({
				userId,
				organizationId,
				conversationId: conversationId ?? null,
				clientRequestKey: turnRequest.clientRequestKey,
				executionMode,
				question: typeof message === "string" ? message : "",
				temporalClient,
			});
			if (admission.kind === "refused") {
				return admission.response;
			}
			if (isCancelledBeforeStart(admission.turn)) {
				return cancelledBeforeStartResponse();
			}
			if (admission.kind === "created") {
				// A new turn: this request owns its startup (it alone holds
				// the start token) — run the pre-work and start it.
				turnToStart = admission.turn;
				newTurn = true;
			} else {
				// A retry of the key. Whether the turn is still being started
				// by the request that created it, already running, or ended,
				// this request neither starts it nor cleans it up: it
				// reattaches, waiting within a bound for a pending start (see
				// the reattach section below).
				resumeExecutionId = admission.turn.executionId ?? undefined;
			}
		}

		// A client that disconnects before its turn is started gets the turn
		// cancelled (DISCONNECT_BEFORE_START) and no workflow. Once the SSE
		// stream exists, a disconnect detaches instead (the turn keeps
		// running and the client reattaches with its key or executionId).
		const disconnectedBeforeStart = async (): Promise<boolean> => {
			if (!turnToStart || !request.signal?.aborted) {
				return false;
			}
			console.warn(
				"[Orchestrator Stream] Client disconnected before the turn started; cancelling it",
				{ turnId: turnToStart.id },
			);
			await cancelTurnBeforeStart({
				turn: turnToStart,
				reason: "client disconnected before start",
			});
			turnSettled = true;
			return true;
		};
		const disconnectedResponse = () =>
			new Response(null, {
				status: 499,
				statusText: "Client Closed Request",
			});

		// Only the workspaces the caller can open in this organization, now
		// that membership of it is established (../orchestrator-turn.ts).
		const workspaceIds = await filterOrchestratorTurnWorkspaces({
			userId,
			organizationId,
			requestedWorkspaceIds: turnRequest.workspaceIds,
		});

		// The plan preflight and usage-limit chokepoint, entered only for a
		// NEW turn (see `billOrchestratorTurn`).
		let planPreflight: ChatGptPlanChatPreflight = null;
		if (newTurn || legacyExecutionId) {
			const billed = await billOrchestratorTurn({
				userId,
				organizationId,
			});
			if (billed instanceof Response) {
				return billed;
			}
			planPreflight = billed.planPreflight;
		}
		if (await disconnectedBeforeStart()) {
			return disconnectedResponse();
		}

		const executionId =
			resumeExecutionId ?? turnToStart?.executionId ?? legacyExecutionId;
		if (!executionId) {
			return new Response(
				JSON.stringify({ error: "No execution to attach to" }),
				{
					status: 409,
					headers: { "Content-Type": "application/json" },
				},
			);
		}

		// =====================================================================
		// Reattach: the turn record answers first. A turn that already ended
		// returns its stored result without asking Temporal; another user's
		// (or organization's) turn is refused.
		// =====================================================================
		let storedTerminalTurn: ConversationTurn | null = null;
		let activeTurnId = turnToStart?.id;
		let activeTurnGeneration = turnToStart?.generation;
		if (resumeExecutionId) {
			const ownTurn = await getConversationTurnForExecution({
				executionId: resumeExecutionId,
				userId,
				organizationId,
			});
			if (ownTurn) {
				activeTurnId = ownTurn.id;
				activeTurnGeneration = ownTurn.generation;
			}
			if (!ownTurn) {
				const owner =
					await getConversationTurnOwnerForExecution(
						resumeExecutionId,
					);
				if (owner) {
					return new Response(
						JSON.stringify({
							error: "Forbidden",
							message:
								"You are not authorized to access this workflow",
						}),
						{
							status: 403,
							headers: { "Content-Type": "application/json" },
						},
					);
				}
			} else if (
				conversationId &&
				(ownTurn.scopeConversationId ?? null) !== conversationId
			) {
				// The caller's own turn, but from another conversation:
				// attaching would show its result in the wrong chat.
				return new Response(
					JSON.stringify({
						error: "Forbidden",
						message:
							"This turn belongs to a different conversation",
					}),
					{
						status: 403,
						headers: { "Content-Type": "application/json" },
					},
				);
			} else if (isTerminalTurnStatus(ownTurn.status)) {
				storedTerminalTurn = ownTurn;
			} else if (ownTurn.status === "START_PENDING") {
				// Its starter may still be doing pre-work (a reconnect after a
				// 409, or a retry racing the first request): wait, within a
				// bound, for the workflow to exist rather than attach to
				// nothing and report an error.
				const appeared = await waitForTurnWorkflow({
					temporalClient,
					executionId: resumeExecutionId,
				});
				if (appeared === "unavailable") {
					return turnStateUnavailableResponse();
				}
				if (appeared === "absent") {
					// Still no workflow. Re-read the turn — it may have been
					// cancelled or finalized meanwhile — then settle it the
					// way admission settles a conflicting turn: within the
					// orphan grace period it is still pending; past it, with
					// the workflow proven missing, it is terminalized and its
					// stored result is the answer.
					const settled = await settleAbandonedTurn({
						temporalClient,
						executionId: resumeExecutionId,
						userId,
						organizationId,
					});
					if (settled.kind === "unavailable") {
						return turnStateUnavailableResponse();
					}
					if (settled.kind === "pending") {
						return turnPendingResponse(resumeExecutionId);
					}
					storedTerminalTurn = settled.turn;
				}
			}
		}

		// Inline attachments, document retrieval (up to two minutes of RAG
		// pre-work), the effective tool sets and the input literal: see
		// ../orchestrator-turn.ts. A client that went away during that
		// pre-work is caught by the check below, before the start.
		const workflowInput = await buildOrchestratorWorkflowInput({
			request: turnRequest,
			workspaceIds,
			executionId,
			temporalClient,
		});

		// A new run's input must fit Temporal's start frame (review F38). A
		// reattach starts nothing, so it is not measured.
		if (turnToStart || legacyExecutionId) {
			const oversized = refuseOversizedOrchestratorInput(workflowInput);
			if (oversized) {
				return oversized;
			}
		}

		if (await disconnectedBeforeStart()) {
			return disconnectedResponse();
		}

		// Set up streaming response
		const encoder = new TextEncoder();

		// A turn that already ended: replay its stored result and close.
		if (storedTerminalTurn) {
			const turn = storedTerminalTurn;
			const status = resultStatusForTurn(turn.status);
			const storedBudgetStop = turnBudgetStopForStream(turn.budgetStop);
			const storedHandoff =
				status === "completed" &&
				(storedBudgetStop?.kind === "time_limit" ||
					storedBudgetStop?.kind === "round_limit" ||
					storedBudgetStop?.kind === "token_budget")
					? {
							reason:
								storedBudgetStop.kind === "time_limit"
									? `Time limit reached: ${storedBudgetStop.used}/${storedBudgetStop.limit} seconds`
									: storedBudgetStop.kind === "round_limit"
										? `Iteration limit reached: ${storedBudgetStop.used}/${storedBudgetStop.limit}`
										: `Token budget exceeded: ${storedBudgetStop.used}/${storedBudgetStop.maxTokens}`,
							summary: turn.responseText ?? "",
						}
					: undefined;
			const events = [
				{
					type: "started" as const,
					turnId: turn.id,
					executionId,
					workflowId: executionId,
					resumed: true,
				},
				status === "failed"
					? {
							...buildWorkflowErrorEvent(
								turn.terminalReason ??
									"Workflow execution failed",
							),
							// The row's stored stop, whatever the status,
							// exactly as the live event carried it.
							budgetStop: storedBudgetStop,
						}
					: {
							type: "completed" as const,
							status,
							response: turn.responseText ?? undefined,
							toolCalls: [],
							stepResults: [],
							limitSignals: Array.isArray(turn.limitSignalSummary)
								? limitSchema
										.array()
										.parse(turn.limitSignalSummary)
								: undefined,
							// Structured stop plus the older bundle's handoff signal.
							budgetStop: storedBudgetStop,
							handoffRecommended: storedHandoff,
							fromTurnRecord: true,
						},
			];
			return new Response(
				encoder.encode(
					events
						.map((event) => {
							if (event.type === "error") {
								type StoredTurnErrorEvent = typeof event;
								return encodeOrchestratorStreamEvent(
									event satisfies AssertAssignable<
										StoredTurnErrorEvent,
										OrchestratorStreamInput
									>,
								);
							}
							const payload = {
								...event,
								turnId: activeTurnId,
								turnGeneration: activeTurnGeneration,
							};
							type StoredTurnEvent = typeof payload;
							return encodeOrchestratorStreamEvent(
								payload satisfies AssertAssignable<
									StoredTurnEvent,
									OrchestratorStreamInput
								>,
							);
						})
						.join(""),
				),
				{
					headers: {
						"Content-Type": "text/event-stream",
						"Cache-Control": "no-cache",
						Connection: "keep-alive",
					},
				},
			);
		}

		// Hoisted above `start()` so `cancel()` — a sibling method on the same
		// ReadableStream underlying source, not a nested closure — can share
		// them: mark the stream closed and tear down the Redis subscriber when
		// the client disconnects (issue #2269).
		let controllerClosed = false;
		let heartbeat: ReturnType<typeof setInterval> | undefined;
		let unsubscribeEvents: () => void = () => {};
		const cleanupRedis = () => {
			unsubscribeEvents();
			unsubscribeEvents = () => {};
		};

		// Delay the continuation's HTTP response until startup is checked. Redis
		// subscribes first, so the continuation keeps its initial streamed text.
		let startupFailureResponse: Response | undefined;
		let resolveStartup: () => void = () => {};
		const startupReady = new Promise<void>((resolve) => {
			resolveStartup = resolve;
		});

		const stream = new ReadableStream({
			async start(controller) {
				const sendEvent = (event: OrchestratorStreamInput) => {
					if (controllerClosed) {
						return; // Don't send if controller is closed
					}
					try {
						controller.enqueue(
							encoder.encode(
								encodeOrchestratorStreamEvent({
									...event,
									...(event.type === "started" ||
									event.type === "completed"
										? {
												turnId: activeTurnId,
												turnGeneration:
													activeTurnGeneration,
											}
										: {}),
								}),
							),
						);
					} catch {
						// Controller might be closed, mark it
						controllerClosed = true;
					}
				};

				// The Redis events and the Temporal poll, diffed into stream
				// events (../execution-observer.ts, shared with the agent
				// runtime). A continue-as-new pins the newest run with the same
				// authorization as the first attach.
				const observer = createOrchestratorExecutionObserver({
					emit: sendEvent,
					reattach: async () =>
						(
							await getAuthorizedChatRun({
								executionId,
								userId,
								engine: "orchestrator",
								action: "reattach",
								expectedOrganizationId:
									organizationId ?? undefined,
							})
						).handle,
				});

				const closeController = () => {
					resolveStartup();
					clearInterval(heartbeat);
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
					if (resumeExecutionId) {
						handle = temporalClient.workflow.getHandle(executionId);
						const description = await handle.describe();

						// ✅ Security: Verify the caller owns this workflow.
						// Fails closed: a memo with no owner is refused.
						const memo = description.memo as
							| Record<string, unknown>
							| undefined;
						const workflowOrgId = memo?.organizationId;
						const refusal = await refuseUnlessRunOwner({
							executionId,
							userId,
							memo,
							notOwnerMessage:
								"You are not authorized to access this workflow",
						});
						if (refusal) {
							{
								const payload = {
									type: "error" as const,
									error: "You are not authorized to access this workflow",
								};
								type Emitted1387 = typeof payload;
								sendEvent(
									payload satisfies AssertAssignable<
										Emitted1387,
										OrchestratorStreamInput
									>,
								);
							}
							controller.close();
							controllerClosed = true;
							return;
						}
						if (workflowOrgId) {
							// Membership, as the start applied (one helper
							// for every paired route, ../run-access.ts).
							const isMember =
								await isOrchestratorOrganizationMember(
									userId,
									workflowOrgId as string,
								);
							if (!isMember) {
								{
									const payload = {
										type: "error" as const,
										error: "You are not a member of this organization",
									};
									type Emitted1404 = typeof payload;
									sendEvent(
										payload satisfies AssertAssignable<
											Emitted1404,
											OrchestratorStreamInput
										>,
									);
								}
								controller.close();
								controllerClosed = true;
								return;
							}
						}
						if (
							memo?.projectId !== undefined ||
							memo?.approvalProtocol === 2
						) {
							handle = (
								await getAuthorizedChatRun({
									executionId,
									userId,
									engine: "orchestrator",
									action: "reattach",
									expectedOrganizationId:
										organizationId ?? undefined,
								})
							).handle;
						}
					}

					// =====================================================================
					// Redis Subscriber (real-time text deltas from streamText)
					// IMPORTANT: Subscribe BEFORE starting the workflow to avoid missing
					// early events (Redis pub/sub does not buffer messages).
					// For resume, ownership was already verified above.
					// =====================================================================
					unsubscribeEvents = await subscribeExecutionEvents({
						executionId,
						onEvent: (event) => {
							if (!controllerClosed) {
								observer.onExecutionEvent(event);
							}
						},
						logPrefix: "[Orchestrator Stream]",
					});

					let resumed = Boolean(resumeExecutionId);
					if (legacyExecutionId) {
						// A Weave run: no turn, the legacy start.
						handle = await startLegacyChatWorkflow({
							temporalClient,
							executionId,
							workflowInput,
							memo: {
								userId,
								organizationId,
								projectId: projectId ?? null,
							},
						});
						console.log(
							"[Orchestrator Stream] Started workflow (no turn)",
							{ executionId },
						);
					} else if (resumeExecutionId || !turnToStart) {
						// handle was already set and ownership verified above
						console.log(
							"[Orchestrator Stream] Attached to workflow",
							{ executionId },
						);
					} else {
						let started: Awaited<
							ReturnType<typeof startTurnWorkflow>
						>;
						try {
							started = await startTurnWorkflow({
								temporalClient,
								turn: turnToStart,
								workflowInput,
								...(continueFromTurnId
									? { continueFromTurnId }
									: {}),
								memo: {
									userId,
									organizationId,
									projectId: projectId ?? null,
								},
							});
						} catch (startError) {
							if (
								startError instanceof
								TurnStoppedBeforeStartError
							) {
								// Stop landed between admission and start: the
								// turn ended cancelled and nothing runs.
								{
									const payload = {
										type: "completed" as const,
										status: "cancelled",
										response: "",
										toolCalls: [],
										stepResults: [],
									};
									type Emitted1679 = typeof payload;
									sendEvent(
										payload satisfies AssertAssignable<
											Emitted1679,
											OrchestratorStreamInput
										>,
									);
								}
								cleanupRedis();
								closeController();
								return;
							}
							if (startError instanceof TurnStartAmbiguousError) {
								// The start may have applied; the turn stays
								// START_PENDING. Not an error: the client
								// retries the same message key, and that
								// request's reattach finds the workflow or
								// reconciles the turn.
								{
									const payload = {
										type: "start_pending" as const,
										retryable: true,
										executionId,
									};
									type Emitted1696 = typeof payload;
									sendEvent(
										payload satisfies AssertAssignable<
											Emitted1696,
											OrchestratorStreamInput
										>,
									);
								}
								cleanupRedis();
								closeController();
								return;
							}
							throw startError;
						}
						handle = started.handle;
						// A retry whose first start's response was lost
						// attaches to the workflow that start created.
						resumed = started.attached;

						console.log("[Orchestrator Stream] Workflow ready", {
							executionId,
							attached: started.attached,
						});
					}

					// Send started event
					const handleWorkflowId: unknown = handle.workflowId;
					resolveStartup();
					{
						const payload = {
							type: "started" as const,
							executionId,
							workflowId:
								typeof handleWorkflowId === "string"
									? handleWorkflowId
									: executionId,
							resumed,
						};
						type Emitted1720 = typeof payload;
						sendEvent(
							payload satisfies AssertAssignable<
								Emitted1720,
								OrchestratorStreamInput
							>,
						);
					}

					let isComplete = false;

					// The ping keeps its own clock, so a poll waiting on a slow
					// Temporal call (a worker restarting) never reads to the
					// client as a dead connection: it reconnects after three
					// missed pings. Stops once the stream is closed.
					heartbeat = setInterval(() => {
						if (controllerClosed) {
							clearInterval(heartbeat);
							return;
						}
						try {
							controller.enqueue(encoder.encode(": ping\n\n"));
						} catch {
							controllerClosed = true;
						}
					}, HEARTBEAT_INTERVAL);

					// Poll for updates
					while (
						!isComplete &&
						!controllerClosed &&
						Date.now() - requestStartedAt < MAX_STREAM_DURATION
					) {
						const polled = await observer.poll(handle);
						handle = polled.handle;
						isComplete = polled.complete;

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
						{
							const payload = {
								type: "stream_timeout" as const,
								executionId,
								message:
									"Streaming window closed; reconnect with this executionId to continue",
							};
							type Emitted2308 = typeof payload;
							sendEvent(
								payload satisfies AssertAssignable<
									Emitted2308,
									OrchestratorStreamInput
								>,
							);
						}
					}

					cleanupRedis();
					closeController();
				} catch (error) {
					if (error instanceof InvalidBudgetContinuationError) {
						startupFailureResponse = error.response();
					}
					console.error("[Orchestrator Stream] Error:", error);
					{
						const payload = {
							type: "error" as const,
							message:
								error instanceof Error
									? error.message
									: "Stream failed",
						};
						type Emitted2323 = typeof payload;
						sendEvent(
							payload satisfies AssertAssignable<
								Emitted2323,
								OrchestratorStreamInput
							>,
						);
					}
					cleanupRedis();
					closeController();
				}
			},
			cancel() {
				// Called when the client disconnects
				controllerClosed = true;
				clearInterval(heartbeat);
				cleanupRedis();
				console.log(
					"[Orchestrator Stream] Client disconnected, stream cancelled",
				);
			},
		});

		if (continueFromTurnId && turnToStart) {
			await startupReady;
			if (startupFailureResponse) {
				return startupFailureResponse;
			}
		}

		// The stream owns the turn from here: it starts the workflow (or
		// marks the turn failed if the start definitely fails).
		turnSettled = true;
		return withChatGptPlanApiBilling(
			new Response(stream, {
				headers: {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
					Connection: "keep-alive",
				},
			}),
			planPreflight,
		);
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
	} finally {
		// Owner-only (the start token), START_PENDING-only: never ends a turn
		// another request started.
		const abandoned = turnToStart as ConversationTurn | null;
		if (abandoned?.executionId && abandoned.startToken && !turnSettled) {
			await abandonConversationTurnStart({
				turnId: abandoned.id,
				executionId: abandoned.executionId,
				startToken: abandoned.startToken,
				cancelled: false,
				reason: "refused before start",
			}).catch((markError: unknown) => {
				console.error(
					"[Orchestrator Stream] Failed to end an abandoned turn",
					markError,
				);
			});
		}
	}
}

export const runtime = "nodejs";

// MAX_STREAM_DURATION (600s) is anchored at request entry (requestStartedAt),
// so 660s gives ~60s of headroom for the graceful `stream_timeout` handoff
// event to be delivered before Vercel's platform-level hard kill (issue
// #2269).
export const maxDuration = 660;
