/**
 * Workflow Templates - SSE Streaming API
 *
 * Streams progress events for agent templates with dedicated Temporal workflows.
 * Templates without dedicated workflows should be routed to the Orchestrator.
 *
 * Events:
 * - started: Workflow has been started
 * - phase: Current execution phase changed
 * - progress: General progress update (sub-agents completed/total)
 * - sub_agent_start: A sub-agent has started
 * - sub_agent_complete: A sub-agent has completed
 * - iteration: Current iteration in goal-oriented execution
 * - completed: Workflow completed successfully
 * - error: An error occurred
 * - cancelled: Workflow was cancelled
 */

import { enterAiInteractiveContext } from "@repo/ai/lib/chatgpt-plan/interactive-context";
import type {
	DeepResearcherOutput,
	DeepResearcherProgress,
	SubAgentResult,
} from "@repo/temporal";
import { getTemporalClient } from "@repo/temporal";
import { getSession } from "@saas/auth/lib/server";
import type { NextRequest } from "next/server";
import {
	admitWorkflowTemplateRun,
	newWorkflowTemplateExecutionId,
	startDeepResearcherWorkflow,
} from "../workflow-template-run";

const POLL_INTERVAL = 200; // Poll every 200ms
const MAX_POLL_DURATION = 600000; // 10 minutes max
// SSE comment heartbeat so intermediaries don't idle-drop the stream during
// silent stretches between progress events; clients ignore `:` comment lines.
const HEARTBEAT_INTERVAL = 15000;

interface StreamEvent {
	type: string;
	[key: string]: unknown;
}

export async function POST(request: NextRequest) {
	try {
		const session = await getSession();
		if (!session) {
			return new Response(JSON.stringify({ error: "Unauthorized" }), {
				status: 401,
				headers: { "Content-Type": "application/json" },
			});
		}

		// This person's own request — or an admin acting as them, which no
		// ChatGPT plan may serve: the workflow start below reads this to clear
		// its plan flag (Fizzy #2770).
		enterAiInteractiveContext({
			userId: session.user.id,
			impersonated: Boolean(session.session.impersonatedBy),
		});

		const userId = session.user.id;
		const body = await request.json();

		// The request's checks and the workflow's input, shared with the
		// agent runtime's deep-researcher engine.
		const admitted = await admitWorkflowTemplateRun(userId, body);
		if (admitted instanceof Response) {
			return admitted;
		}
		const { templateSlug } = admitted;
		const executionId = newWorkflowTemplateExecutionId(
			userId,
			templateSlug,
		);

		// Get Temporal client
		const temporalClient = await getTemporalClient();

		// Set up streaming response
		const encoder = new TextEncoder();

		// Hoisted above `start()` so `cancel()` — a sibling method on the same
		// ReadableStream underlying source, not a nested closure — can share
		// it: mark the stream closed when the client disconnects (issue
		// #2269).
		let controllerClosed = false;

		const stream = new ReadableStream({
			async start(controller) {
				const sendEvent = (event: StreamEvent) => {
					if (controllerClosed) {
						return;
					}
					try {
						controller.enqueue(
							encoder.encode(
								`data: ${JSON.stringify(event)}\n\n`,
							),
						);
					} catch {
						controllerClosed = true;
					}
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

				try {
					// Build workflow input based on template type
					// Currently only supporting deep-researcher
					if (templateSlug === "deep-researcher") {
						// Start the workflow
						const handle = await startDeepResearcherWorkflow(
							temporalClient,
							admitted,
							executionId,
						);

						console.log(
							`[Workflow Template Stream] Started ${templateSlug} workflow: ${executionId}`,
						);

						// Send started event
						sendEvent({
							type: "started",
							executionId,
							workflowId: handle.workflowId,
							templateSlug,
						});

						// Track state for change detection
						let lastProgress: DeepResearcherProgress | null = null;
						let lastSubAgentCount = 0;
						let lastPhase = "";
						let lastIteration = 0;
						const sentSubAgentIds = new Set<string>();
						let isComplete = false;
						const startTime = Date.now();
						let lastHeartbeatAt = Date.now();

						// Poll for updates
						while (
							!isComplete &&
							!controllerClosed &&
							Date.now() - startTime < MAX_POLL_DURATION
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
									const result: DeepResearcherOutput =
										await handle.result();

									// Send any remaining sub-agent results
									if (result.subAgentResults) {
										for (const subResult of result.subAgentResults) {
											if (
												!sentSubAgentIds.has(
													subResult.subTaskId,
												)
											) {
												sendEvent({
													type: "sub_agent_complete",
													subTaskId:
														subResult.subTaskId,
													title: subResult.title,
													status: subResult.status,
													findings:
														subResult.findings,
													confidence:
														subResult.confidence,
													sources: subResult.sources,
													duration:
														subResult.duration,
												});
											}
										}
									}

									// Send completed event
									sendEvent({
										type: "completed",
										status: result.status,
										result: result.result,
										summary: result.summary,
										keyFindings: result.keyFindings,
										sources: result.sources,
										subAgentResults: result.subAgentResults,
										iterations: result.iterations,
										goalAchieved: result.goalAchieved,
										duration: result.duration,
										structuredReport:
											result.structuredReport,
									});

									isComplete = true;
								} else if (
									description.status.name === "FAILED"
								) {
									let errorMessage =
										"Workflow execution failed";
									try {
										const result: DeepResearcherOutput =
											await handle.result();
										if (result?.error) {
											errorMessage = result.error;
										}
									} catch (resultError: unknown) {
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
										type: "cancelled",
										message: "Workflow was cancelled",
									});
									isComplete = true;
								} else {
									// Query current progress
									try {
										const progress: DeepResearcherProgress =
											await handle.query("progress");

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
												complexity: progress.complexity,
												clarificationPrompt:
													progress.clarificationPrompt,
												subTaskTitles:
													progress.subTaskTitles,
											});
										}

										// Check for iteration change
										if (
											progress?.currentIteration &&
											progress.currentIteration !==
												lastIteration
										) {
											lastIteration =
												progress.currentIteration;
											sendEvent({
												type: "iteration",
												current:
													progress.currentIteration,
												max: progress.maxIterations,
												goalAchieved:
													progress.goalAchieved,
												clarificationPrompt:
													progress.clarificationPrompt,
												subTaskTitles:
													progress.subTaskTitles,
											});
										}

										// Check for sub-agent progress
										if (
											progress?.subAgentsCompleted !==
											lastSubAgentCount
										) {
											// Try to get sub-agent results
											try {
												const subResults: SubAgentResult[] =
													await handle.query(
														"subAgentResults",
													);
												for (const subResult of subResults) {
													if (
														!sentSubAgentIds.has(
															subResult.subTaskId,
														)
													) {
														sentSubAgentIds.add(
															subResult.subTaskId,
														);
														sendEvent({
															type: "sub_agent_complete",
															subTaskId:
																subResult.subTaskId,
															title: subResult.title,
															status: subResult.status,
															findings:
																subResult.findings,
															confidence:
																subResult.confidence,
															sources:
																subResult.sources,
															duration:
																subResult.duration,
														});
													}
												}
											} catch {
												// Sub-agent query may not be available yet
											}
											lastSubAgentCount =
												progress.subAgentsCompleted;
										}

										// Send progress update
										if (
											progress &&
											(progress.subAgentsCompleted !==
												lastProgress?.subAgentsCompleted ||
												progress.subAgentsTotal !==
													lastProgress?.subAgentsTotal ||
												progress.message !==
													lastProgress?.message)
										) {
											lastProgress = progress;
											sendEvent({
												type: "progress",
												phase: progress.phase,
												message: progress.message,
												subAgentsTotal:
													progress.subAgentsTotal,
												subAgentsCompleted:
													progress.subAgentsCompleted,
												subAgentsFailed:
													progress.subAgentsFailed,
												currentIteration:
													progress.currentIteration,
												maxIterations:
													progress.maxIterations,
												goalAchieved:
													progress.goalAchieved,
											});
										}
									} catch {
										// Queries might fail if workflow just started
									}
								}
							} catch (pollError) {
								console.error(
									"[Workflow Template Stream] Poll error:",
									pollError,
								);
							}

							// Wait before next poll
							await new Promise((resolve) =>
								setTimeout(resolve, POLL_INTERVAL),
							);
						}

						// Timeout handling
						if (!isComplete) {
							sendEvent({
								type: "error",
								message: "Execution timed out",
							});
						}
					} else {
						// Unknown template type
						sendEvent({
							type: "error",
							message: `Unsupported template: ${templateSlug}`,
						});
					}

					closeController();
				} catch (error) {
					console.error("[Workflow Template Stream] Error:", error);
					sendEvent({
						type: "error",
						message:
							error instanceof Error
								? error.message
								: "Stream failed",
					});
					closeController();
				}
			},
			cancel() {
				// Called when the client disconnects
				controllerClosed = true;
				console.log(
					"[Workflow Template Stream] Client disconnected, stream cancelled",
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
		console.error("[Workflow Template Stream] Error:", error);
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

// 600s poll deadline (MAX_POLL_DURATION) + ~60s headroom so the graceful
// "Execution timed out" event is delivered before Vercel's platform-level
// hard kill; the pre-poll work (auth/body/membership/Temporal connect) is
// seconds, not a meaningful share of the budget (issue #2269).
export const maxDuration = 660;
