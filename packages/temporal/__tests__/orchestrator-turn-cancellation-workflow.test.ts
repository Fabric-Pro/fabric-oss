/**
 * Behavioral (TestWorkflowEnvironment) tests for Stop on an Advisor chat
 * turn: the REAL `orchestratorExecutionWorkflow`, bundled from the workflows
 * barrel and run by a real worker against Temporal's test server, with the
 * activities mocked.
 *
 * What a Stop must do to a turn whose round is in flight:
 *   - the round's activity is cancelled (it observes the cancel through its
 *     heartbeats and aborts), and no model activity is scheduled after it —
 *     no further round, no budget synthesis, no summary, no compaction;
 *   - the run returns a domain result of status "cancelled" and the Temporal
 *     execution COMPLETES (the workflow returns normally after a cancel);
 *   - the turn's terminal state is written (CANCELLED) by the final,
 *     non-cancellable activity.
 *
 * A turn the durable record refuses (`TurnNotDispatchable`) ends the same
 * way, and a run without a turn (legacy, non-chat) keeps the old behaviour.
 *
 * The mid-round cancel runs the REAL `runAgentIteration` activity (its own
 * heartbeat ticker, its abort-signal plumbing) against a controlled provider
 * whose request only ends when its abort signal fires, so the measured
 * latency is cancel → heartbeat delivery → provider request aborted.
 * Review round 1 adds: Stop during initialization, a cancel recorded between
 * the body's completion and the terminal write, and the workflow-id reuse
 * policy the chat starters rely on.
 *
 * The Planner (`save_reuse`) scenarios run the up-front path — routing,
 * planning, per-step clarification, step execution — with its activities
 * mocked: a Stop in any of them ends the turn "cancelled" (not "failed"),
 * with no recovery or later step scheduled after it. A Weave run never
 * writes turn state, even when handed a turnId.
 *
 * Offline note: `TestWorkflowEnvironment.createTimeSkipping()` downloads a
 * Temporal test-server binary on first use.
 *
 * Run with:
 *   pnpm --filter @repo/temporal test __tests__/orchestrator-turn-cancellation-workflow.test.ts
 */

import { resolve } from "node:path";
import { Context } from "@temporalio/activity";
import { WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import { ApplicationFailure, CancelledFailure } from "@temporalio/common";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import {
	bundleWorkflowCode,
	Worker,
	type WorkflowBundleWithSourceMap,
} from "@temporalio/worker";
import { MockLanguageModelV4 } from "ai/test";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type {
	OrchestratorWorkflowInput,
	OrchestratorWorkflowOutput,
} from "../src/workflows/orchestrator/types";

// The real round activity's collaborators: a controlled provider instead of
// a resolved model, no skills, no Redis, and a turn record that allows
// dispatch.
const provider = vi.hoisted(() => ({
	model: undefined as unknown,
	abortedAt: undefined as number | undefined,
	requests: 0,
}));
vi.mock("../src/activities/orchestrator/utils", () => ({
	getAiModelWithSelection: vi.fn(async () => ({
		model: provider.model,
		provider: "ANTHROPIC_DIRECT",
		modelString: "example-model",
		canonicalName: "example-model",
	})),
}));
vi.mock("@repo/ai/skills", () => ({
	listAvailableSkills: vi.fn(async () => []),
	createSkillTools: vi.fn(() => ({})),
	buildSkillsSystemBlock: vi.fn(() => ""),
}));
vi.mock("../src/lib/redis-publisher", () => ({
	publishExecutionEvent: vi.fn(),
}));
vi.mock("@repo/database", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	checkConversationTurnDispatchable: vi.fn(async () => ({ ok: true })),
}));

import { runAgentIteration } from "../src/activities/orchestrator/execution/run-agent-iteration";

/** A provider request that only ends when its abort signal fires. */
function installHangingProvider() {
	provider.abortedAt = undefined;
	provider.requests = 0;
	provider.model = new MockLanguageModelV4({
		doStream: async (options) => {
			provider.requests++;
			await new Promise<void>((_resolve, reject) => {
				options.abortSignal?.addEventListener("abort", () => {
					provider.abortedAt = Date.now();
					reject(options.abortSignal?.reason);
				});
			});
			throw new Error("unreachable");
		},
	});
}

const WORKFLOWS_PATH = resolve(__dirname, "..", "src", "workflows");
const WORKFLOW_NAME = "orchestratorExecutionWorkflow";

let env: TestWorkflowEnvironment;
let workflowBundle: WorkflowBundleWithSourceMap;

beforeAll(async () => {
	env = await TestWorkflowEnvironment.createTimeSkipping();
	workflowBundle = await bundleWorkflowCode({
		workflowsPath: WORKFLOWS_PATH,
	});
}, 240_000);

afterAll(async () => {
	await env?.teardown();
});

const USAGE = { inputTokens: 10, outputTokens: 5 };

type RoundBehaviour =
	| "real_round_hanging_provider"
	| "answer"
	| "refuse_dispatch";

interface Recorder {
	rounds: Array<Record<string, unknown>>;
	finalized: Array<Record<string, unknown>>;
	otherModelCalls: string[];
	preloadStarted: boolean;
	/** Planner-path activity inputs, by activity name. */
	planner: Record<string, Array<Record<string, unknown>>>;
	/** Set once a hanging planner activity has started. */
	hangingStarted: boolean;
}

/** How a planner-path activity behaves in a scenario. */
type PlannerBehaviour = "hang_until_cancelled" | "refuse_dispatch";

interface ScenarioOptions {
	behaviour: RoundBehaviour;
	withTurn: boolean;
	cancelDuringRound?: boolean;
	/** Preloading hangs (heartbeating) until cancelled; Stop lands there. */
	cancelDuringPreload?: boolean;
	/** What the terminal-state write reports it persisted. */
	finalizedStatus?: string;
	executionMode?: OrchestratorWorkflowInput["executionMode"];
	surface?: OrchestratorWorkflowInput["surface"];
	/** Planner path: how routing, a step, or a per-step clarity check behaves. */
	plannerRouting?: PlannerBehaviour;
	plannerStep?: PlannerBehaviour;
	plannerStepClarity?: PlannerBehaviour;
	/** Cancel the run once a `hang_until_cancelled` activity has started. */
	cancelWhenHanging?: boolean;
	/** The plan needs approval; the run waits for it (and marks hanging). */
	planNeedsApproval?: boolean;
	/** The step fails (not a stop), recovery classifies it retryable and
	 * waits out a back-off (marks hanging) before retrying. */
	stepFailsRetryably?: boolean;
}

function turnRefusal() {
	return ApplicationFailure.create({
		type: "TurnNotDispatchable",
		message: "Turn may not make another model request (cancelled)",
		nonRetryable: true,
		details: [{ reason: "cancelled" }],
	});
}

/** A planner activity mock: answers, hangs until cancelled, or is refused. */
function plannerActivity<T>(
	rec: Recorder,
	name: string,
	behaviour: PlannerBehaviour | undefined,
	answer: (req: Record<string, unknown>) => T,
) {
	return vi.fn(async (req: Record<string, unknown>) => {
		const calls = rec.planner[name] ?? [];
		calls.push(req);
		rec.planner[name] = calls;
		if (behaviour === "refuse_dispatch") {
			throw turnRefusal();
		}
		if (behaviour === "hang_until_cancelled") {
			rec.hangingStarted = true;
			const ctx = Context.current();
			ctx.heartbeat();
			await new Promise<void>((resolveWait) => {
				const tick = setInterval(() => ctx.heartbeat(), 500);
				ctx.cancellationSignal.addEventListener("abort", () => {
					clearInterval(tick);
					resolveWait();
				});
			});
			throw new CancelledFailure(`${name} aborted`);
		}
		return answer(req);
	});
}

function plannerActivities(opts: ScenarioOptions, rec: Recorder) {
	const step = {
		id: "step-1",
		description: "Look up the launch date",
		type: "generate",
		status: "pending",
		order: 1,
		capability: "llm",
		riskLevel: "low",
	};
	const record = (name: string) =>
		vi.fn(async (...args: unknown[]) => {
			const calls = rec.planner[name] ?? [];
			calls.push({ args });
			rec.planner[name] = calls;
			return undefined;
		});
	return {
		findSimilarTrajectory: vi.fn(async () => null),
		analyzeAndRoute: plannerActivity(
			rec,
			"analyzeAndRoute",
			opts.plannerRouting,
			() => ({
				primaryAgent: "llm",
				secondaryAgents: [],
				suggestedStrategy: "generate",
				riskLevel: "low",
				riskFactors: [],
				confidence: 0.9,
				reasoning: "A direct answer",
				useMcpDirect: false,
				matchedMcpTools: [],
			}),
		),
		createTaskPlan: plannerActivity(
			rec,
			"createTaskPlan",
			undefined,
			() => ({
				id: "plan-example-1",
				description: "Answer the question",
				steps: [step],
				riskLevel: "low",
				strategy: "generate",
				createdAt: "2026-01-01T00:00:00.000Z",
			}),
		),
		validatePlan: vi.fn(async () => ({
			isValid: true,
			issues: [],
			suggestions: [],
		})),
		inferAndValidateContractsActivity: vi.fn(async () => ({
			validation: { errors: [], warnings: [] },
		})),
		analyzePlanApprovalActivity: vi.fn(async () => ({
			requiresApproval: opts.planNeedsApproval === true,
			autoApprovedStepIds: opts.planNeedsApproval ? [] : ["step-1"],
			pendingApprovalStepIds: opts.planNeedsApproval ? ["step-1"] : [],
			summary: {
				overallRisk: opts.planNeedsApproval ? "high" : "low",
				highRiskSteps: [],
				plannedActions: [],
			},
		})),
		// The run then waits for the user's decision on the plan.
		createOrchestratorApprovalRequest: vi.fn(async () => {
			rec.hangingStarted = true;
			return { approvalId: "approval-example-1" };
		}),
		updateApprovalTaskStatus: record("updateApprovalTaskStatus"),
		recordApprovalOutcomeActivity: record("recordApprovalOutcomeActivity"),
		checkStepAuthorityActivity: vi.fn(async () => ({ allowed: true })),
		executeStep: plannerActivity(
			rec,
			"executeStep",
			opts.plannerStep,
			() => {
				if (opts.stepFailsRetryably) {
					throw ApplicationFailure.create({
						message: "provider overloaded",
						nonRetryable: true,
					});
				}
				return {
					stepId: "step-1",
					status: "completed",
					outputs: { response: "The 12th." },
					response: "The 12th.",
					toolCalls: [],
				};
			},
		),
		verifyOperation: vi.fn(async () => ({
			verified: true,
			operationType: "read",
			verificationMessage: "Operation completed successfully",
			details: { issues: [], notFoundOrRemaining: [] },
			shouldRetry: false,
		})),
		reflectOnOutput: vi.fn(async () => ({ satisfactory: true })),
		summarizeContextActivity: vi.fn(async () => ({
			compressionRatio: 1,
			keyFacts: [],
		})),
		// Recovery runs only after a step fails for a reason that is not a
		// stop; a stopped step must never reach it.
		classifyFailureActivity: opts.stepFailsRetryably
			? vi.fn(async () => {
					const calls = rec.planner.classifyFailureActivity ?? [];
					calls.push({});
					rec.planner.classifyFailureActivity = calls;
					return { type: "transient", isRetryable: true };
				})
			: record("classifyFailureActivity"),
		// Recovery sleeps this long before retrying the step.
		getRetryDelayActivity: opts.stepFailsRetryably
			? vi.fn(async () => {
					rec.hangingStarted = true;
					return 20_000;
				})
			: record("getRetryDelayActivity"),
		cleanupWeaveResourcesActivity: vi.fn(async () => undefined),
	};
}

function buildActivities(opts: ScenarioOptions, rec: Recorder) {
	const behaviour = opts.behaviour;
	const modelCall = (name: string) =>
		vi.fn(async () => {
			rec.otherModelCalls.push(name);
			throw new Error(`${name} should not run in this scenario`);
		});
	return {
		// Initialization — an empty, healthy environment.
		preloadResourcesActivity: vi.fn(async () => {
			rec.preloadStarted = true;
			if (opts.cancelDuringPreload) {
				const ctx = Context.current();
				ctx.heartbeat();
				await new Promise<void>((resolveWait) => {
					const tick = setInterval(() => ctx.heartbeat(), 500);
					ctx.cancellationSignal.addEventListener("abort", () => {
						clearInterval(tick);
						resolveWait();
					});
				});
				throw new CancelledFailure("preload aborted");
			}
			return {
				toolMap: {},
				mcpTools: [],
				agents: [],
				integrations: [],
				loadDurationMs: 1,
			};
		}),
		loadOrchestratorMemoryActivity: vi.fn(async () => ({
			memoryContextPrompt: "",
			preferences: {},
			recentEpisodes: [],
			relevantEpisodes: [],
		})),
		updateRecentActivityActivity: vi.fn(async () => undefined),
		initializeLettaMemory: vi.fn(async () => null),
		getHybridRoutingSuggestions: vi.fn(async () => ({
			suggestions: [],
			fromCache: false,
		})),
		applyPolicyEnrichment: vi.fn(async () => ({ blocked: false })),
		applyFabricPatternEnrichment: vi.fn(async () => ({})),
		loadInstanceMemoryActivity: vi.fn(async () => null),
		getProjectMetadataActivity: vi.fn(async () => null),
		listDefaultEnabledMcpServersActivity: vi.fn(async () => []),
		findDefaultMcpConfigActivity: vi.fn(async () => null),
		publishMcpDefaultToolSignalActivity: vi.fn(async () => undefined),
		// The up-front check (the request itself) never asks; a per-step
		// check (a plan step's description) behaves as the scenario says.
		analyzeIntentClarityActivity: vi.fn(
			async (req: Record<string, unknown>) => {
				if (req.message === "Look up the launch date") {
					const calls = rec.planner.stepClarity ?? [];
					calls.push(req);
					rec.planner.stepClarity = calls;
					if (opts.plannerStepClarity === "refuse_dispatch") {
						throw turnRefusal();
					}
				}
				return { needsClarification: false };
			},
		),
		...plannerActivities(opts, rec),

		// The round under test.
		runAgentIteration: vi.fn(async (req: Record<string, unknown>) => {
			rec.rounds.push(req);
			if (behaviour === "answer") {
				return { type: "response", content: "The 12th.", usage: USAGE };
			}
			if (behaviour === "refuse_dispatch") {
				throw ApplicationFailure.create({
					type: "TurnNotDispatchable",
					message:
						"Turn may not make another model request (cancelled)",
					nonRetryable: true,
					details: [{ reason: "cancelled" }],
				});
			}
			// The real activity, against the hanging provider.
			return runAgentIteration(
				req as unknown as Parameters<typeof runAgentIteration>[0],
			);
		}),
		summarizeLargeToolResult: modelCall("summarizeLargeToolResult"),
		compactConversationHistoryActivity: modelCall(
			"compactConversationHistoryActivity",
		),
		executeAgentAsTool: modelCall("executeAgentAsTool"),

		finalizeConversationTurnActivity: vi.fn(
			async (req: Record<string, unknown>) => {
				rec.finalized.push(req);
				return {
					status: opts.finalizedStatus ?? req.outcome,
					wrote: true,
				};
			},
		),
	};
}

/**
 * The ids of the `patched()` markers a history recorded, in order. The SDK
 * records each as a `core_patch` marker whose `patch-data` payload is JSON
 * carrying the id; `fetchHistory()` hands the payload bytes back base64
 * encoded.
 */
function recordedPatchIds(history: {
	events?: Array<{
		markerRecordedEventAttributes?: {
			markerName?: string | null;
			details?: Record<
				string,
				{
					payloads?: Array<{
						data?: Uint8Array | string | null;
					}> | null;
				}
			> | null;
		} | null;
	}> | null;
}): string[] {
	const ids: string[] = [];
	for (const event of history.events ?? []) {
		const marker = event.markerRecordedEventAttributes;
		if (marker?.markerName !== "core_patch") {
			continue;
		}
		const data = marker.details?.["patch-data"]?.payloads?.[0]?.data;
		if (data) {
			const bytes =
				typeof data === "string" ? Buffer.from(data, "base64") : data;
			const parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as {
				id?: string;
			};
			if (parsed.id) {
				ids.push(parsed.id);
			}
		}
	}
	return ids;
}

let taskQueueSeq = 0;

async function runScenario(opts: ScenarioOptions) {
	const rec: Recorder = {
		rounds: [],
		finalized: [],
		otherModelCalls: [],
		preloadStarted: false,
		planner: {},
		hangingStarted: false,
	};
	if (opts.behaviour === "real_round_hanging_provider") {
		installHangingProvider();
	}
	const taskQueue = `orchestrator-turn-cancel-${taskQueueSeq++}`;
	const workflowId = `orch-00000000-0000-4000-8000-${String(taskQueueSeq).padStart(12, "0")}`;
	const input: OrchestratorWorkflowInput = {
		executionId: workflowId,
		message: "What is the launch date?",
		history: [],
		userId: "user-example-1",
		organizationId: "org-example-1",
		executionMode: opts.executionMode ?? "balanced",
		...(opts.surface ? { surface: opts.surface } : {}),
		...(opts.withTurn
			? { turnId: "turn-example-1", turnContractVersion: 1 }
			: {}),
	};
	const worker = await Worker.create({
		connection: env.nativeConnection,
		taskQueue,
		workflowBundle,
		activities: buildActivities(opts, rec),
		// As the production orchestrator queue (worker.ts).
		maxHeartbeatThrottleInterval: "1s",
	});
	let cancelRequestedAt: number | undefined;
	const result = await worker.runUntil(async () => {
		const handle = await env.client.workflow.start(WORKFLOW_NAME, {
			args: [input],
			taskQueue,
			workflowId,
		});
		if (opts.cancelDuringRound) {
			await vi.waitFor(
				() => {
					expect(provider.requests).toBeGreaterThan(0);
				},
				{ timeout: 30_000, interval: 25 },
			);
			cancelRequestedAt = Date.now();
			await handle.cancel();
		}
		if (opts.cancelWhenHanging) {
			await vi.waitFor(
				() => {
					expect(rec.hangingStarted).toBe(true);
				},
				{ timeout: 30_000, interval: 25 },
			);
			await handle.cancel();
		}
		if (opts.cancelDuringPreload) {
			await vi.waitFor(
				() => {
					expect(rec.preloadStarted).toBe(true);
				},
				{ timeout: 30_000, interval: 25 },
			);
			await handle.cancel();
		}
		const output = await handle
			.result()
			.then((value) => ({ ok: true as const, value }))
			.catch((error: unknown) => ({ ok: false as const, error }));
		const description = await handle.describe();
		// The recorded history must replay against the same code: the new
		// cancellation path is deterministic.
		const history = await handle.fetchHistory();
		await Worker.runReplayHistory({ workflowBundle }, history, workflowId);
		return {
			output,
			temporalStatus: description.status.name,
			patchIds: recordedPatchIds(history),
		};
	});
	const cancelLatencyMs =
		cancelRequestedAt !== undefined && provider.abortedAt !== undefined
			? provider.abortedAt - cancelRequestedAt
			: undefined;
	return { ...result, rec, workflowId, cancelLatencyMs };
}

describe("orchestratorExecutionWorkflow — Stop on a chat turn", () => {
	it("a native cancel mid-round aborts the round, schedules no further model work, and returns 'cancelled'", async () => {
		const { output, temporalStatus, rec, workflowId, cancelLatencyMs } =
			await runScenario({
				behaviour: "real_round_hanging_provider",
				withTurn: true,
				cancelDuringRound: true,
			});
		// Target: an in-flight round is aborted within 10 s of the cancel
		// reaching Temporal.
		process.stderr.write(
			`[turn-cancel] cancel-to-abort latency: ${cancelLatencyMs} ms\n`,
		);
		expect(cancelLatencyMs).toBeDefined();
		expect(cancelLatencyMs as number).toBeLessThan(10_000);

		expect(output.ok).toBe(true);
		const value = (output as { value: OrchestratorWorkflowOutput }).value;
		expect(value.status).toBe("cancelled");
		// The execution completes: the workflow returns after a cancel.
		expect(temporalStatus).toBe("COMPLETED");
		// The provider request was aborted, and nothing model-shaped ran
		// after it — no retry, no second round, no synthesis.
		expect(provider.abortedAt).toBeDefined();
		expect(provider.requests).toBe(1);
		expect(rec.rounds).toHaveLength(1);
		expect(rec.otherModelCalls).toEqual([]);
		// The round carried its turn scope.
		expect(rec.rounds[0]?.turnScope).toEqual({
			turnId: "turn-example-1",
			executionId: workflowId,
			userId: "user-example-1",
			organizationId: "org-example-1",
		});
		// The terminal state was written, as a cancellation.
		expect(rec.finalized).toHaveLength(1);
		expect(rec.finalized[0]).toMatchObject({
			outcome: "CANCELLED",
			turnScope: { turnId: "turn-example-1" },
		});
	}, 120_000);

	it("a refused dispatch (cancel recorded, Temporal never told) ends the turn 'cancelled', not failed", async () => {
		const { output, temporalStatus, rec } = await runScenario({
			behaviour: "refuse_dispatch",
			withTurn: true,
			cancelDuringRound: false,
		});

		expect(output.ok).toBe(true);
		const value = (output as { value: OrchestratorWorkflowOutput }).value;
		expect(value.status).toBe("cancelled");
		expect(temporalStatus).toBe("COMPLETED");
		expect(rec.rounds).toHaveLength(1);
		expect(rec.otherModelCalls).toEqual([]);
		expect(rec.finalized[0]).toMatchObject({ outcome: "CANCELLED" });
	}, 120_000);

	it("a completed turn writes COMPLETED with its answer", async () => {
		const { output, rec } = await runScenario({
			behaviour: "answer",
			withTurn: true,
			cancelDuringRound: false,
		});

		expect(output.ok).toBe(true);
		const value = (output as { value: OrchestratorWorkflowOutput }).value;
		expect(value.status).toBe("completed");
		expect(rec.finalized).toHaveLength(1);
		expect(rec.finalized[0]).toMatchObject({
			outcome: "COMPLETED",
			responseText: "The 12th.",
		});
	}, 120_000);

	it("a run without a turn keeps the legacy behaviour and writes no turn state", async () => {
		const { output, rec } = await runScenario({
			behaviour: "answer",
			withTurn: false,
			cancelDuringRound: false,
		});

		expect(output.ok).toBe(true);
		const value = (output as { value: OrchestratorWorkflowOutput }).value;
		expect(value.status).toBe("completed");
		expect(rec.finalized).toHaveLength(0);
		expect(rec.rounds[0]).not.toHaveProperty("turnScope");
	}, 120_000);

	it("R1-6: Stop during initialization (preload) ends 'cancelled', not 'failed'", async () => {
		const { output, temporalStatus, rec } = await runScenario({
			behaviour: "answer",
			withTurn: true,
			cancelDuringPreload: true,
		});
		expect(output.ok).toBe(true);
		const value = (output as { value: OrchestratorWorkflowOutput }).value;
		expect(value.status).toBe("cancelled");
		expect(temporalStatus).toBe("COMPLETED");
		expect(rec.rounds).toHaveLength(0);
		expect(rec.finalized[0]).toMatchObject({ outcome: "CANCELLED" });
	}, 120_000);

	it("R1-7: a cancel recorded between the body's completion and the terminal write is what the run reports", async () => {
		const { output } = await runScenario({
			behaviour: "answer",
			withTurn: true,
			// The body completed; the finalizer found CANCEL_REQUESTED and
			// persisted CANCELLED (decision 1's ordering rule).
			finalizedStatus: "CANCELLED",
		});
		expect(output.ok).toBe(true);
		const value = (output as { value: OrchestratorWorkflowOutput }).value;
		expect(value.status).toBe("cancelled");
		// The answer is kept as the turn's partial text, with no handoff.
		expect(value.response).toBe("The 12th.");
		expect(value.handoffRecommended).toBeUndefined();
	}, 120_000);

	it("R1-4: a Planner (save_reuse) run with a turnId serves the turn: its activities carry the scope and the turn is finalized", async () => {
		const { output, rec, workflowId } = await runScenario({
			behaviour: "answer",
			withTurn: true,
			executionMode: "save_reuse",
		});
		expect(output.ok).toBe(true);
		const value = (output as { value: OrchestratorWorkflowOutput }).value;
		expect(value.status).toBe("completed");
		const scope = {
			turnId: "turn-example-1",
			executionId: workflowId,
			userId: "user-example-1",
			organizationId: "org-example-1",
		};
		expect(rec.planner.analyzeAndRoute?.[0]?.turnScope).toEqual(scope);
		expect(rec.planner.createTaskPlan?.[0]?.turnScope).toEqual(scope);
		expect(rec.planner.executeStep?.[0]?.turnScope).toEqual(scope);
		expect(rec.finalized).toHaveLength(1);
		expect(rec.finalized[0]).toMatchObject({
			outcome: "COMPLETED",
			responseText: "The 12th.",
		});
	}, 120_000);

	it("Planner: a run records the Planner turn marker right after the turn marker, so an older worker's Planner history (which lacks it) replays as legacy", async () => {
		const planner = await runScenario({
			behaviour: "answer",
			withTurn: true,
			executionMode: "save_reuse",
		});
		expect(planner.patchIds.slice(0, 2)).toEqual([
			"orch-turn-cancellation-v1",
			"orch-planner-turn-v1",
		]);
		// Recorded on every new run, whatever its mode.
		const iterative = await runScenario({
			behaviour: "answer",
			withTurn: false,
		});
		expect(iterative.patchIds.slice(0, 2)).toEqual([
			"orch-turn-cancellation-v1",
			"orch-planner-turn-v1",
		]);
	}, 120_000);

	it("Planner: a native cancel during planning (routing in flight) ends 'cancelled', not 'failed', and plans nothing further", async () => {
		const { output, temporalStatus, rec } = await runScenario({
			behaviour: "answer",
			withTurn: true,
			executionMode: "save_reuse",
			plannerRouting: "hang_until_cancelled",
			cancelWhenHanging: true,
		});
		expect(output.ok).toBe(true);
		const value = (output as { value: OrchestratorWorkflowOutput }).value;
		expect(value.status).toBe("cancelled");
		expect(temporalStatus).toBe("COMPLETED");
		expect(rec.planner.analyzeAndRoute).toHaveLength(1);
		expect(rec.planner.createTaskPlan).toBeUndefined();
		expect(rec.planner.executeStep).toBeUndefined();
		expect(rec.finalized).toHaveLength(1);
		expect(rec.finalized[0]).toMatchObject({ outcome: "CANCELLED" });
	}, 120_000);

	it("Planner: a refused dispatch during planning ends 'cancelled', not 'failed'", async () => {
		const { output, rec } = await runScenario({
			behaviour: "answer",
			withTurn: true,
			executionMode: "save_reuse",
			plannerRouting: "refuse_dispatch",
		});
		expect(output.ok).toBe(true);
		const value = (output as { value: OrchestratorWorkflowOutput }).value;
		expect(value.status).toBe("cancelled");
		expect(rec.planner.createTaskPlan).toBeUndefined();
		expect(rec.finalized[0]).toMatchObject({ outcome: "CANCELLED" });
	}, 120_000);

	it("Planner: a native cancel during step execution ends 'cancelled' with no recovery scheduled", async () => {
		const { output, temporalStatus, rec } = await runScenario({
			behaviour: "answer",
			withTurn: true,
			executionMode: "save_reuse",
			plannerStep: "hang_until_cancelled",
			cancelWhenHanging: true,
		});
		expect(output.ok).toBe(true);
		const value = (output as { value: OrchestratorWorkflowOutput }).value;
		expect(value.status).toBe("cancelled");
		expect(temporalStatus).toBe("COMPLETED");
		expect(rec.planner.executeStep).toHaveLength(1);
		expect(rec.planner.classifyFailureActivity).toBeUndefined();
		expect(rec.planner.getRetryDelayActivity).toBeUndefined();
		expect(rec.finalized[0]).toMatchObject({ outcome: "CANCELLED" });
	}, 120_000);

	it("Planner: a refused dispatch during step execution ends 'cancelled' with no recovery or retry", async () => {
		const { output, rec } = await runScenario({
			behaviour: "answer",
			withTurn: true,
			executionMode: "save_reuse",
			plannerStep: "refuse_dispatch",
		});
		expect(output.ok).toBe(true);
		const value = (output as { value: OrchestratorWorkflowOutput }).value;
		expect(value.status).toBe("cancelled");
		expect(rec.planner.executeStep).toHaveLength(1);
		expect(rec.planner.classifyFailureActivity).toBeUndefined();
		expect(rec.finalized[0]).toMatchObject({ outcome: "CANCELLED" });
	}, 120_000);

	it("Planner: a stop in a per-step clarification check ends 'cancelled' and runs no step", async () => {
		const { output, rec, workflowId } = await runScenario({
			behaviour: "answer",
			withTurn: true,
			executionMode: "save_reuse",
			surface: "loom-orchestrator",
			plannerStepClarity: "refuse_dispatch",
		});
		expect(output.ok).toBe(true);
		const value = (output as { value: OrchestratorWorkflowOutput }).value;
		expect(value.status).toBe("cancelled");
		// The per-step check carried the turn scope.
		expect(rec.planner.stepClarity?.[0]?.turnScope).toEqual({
			turnId: "turn-example-1",
			executionId: workflowId,
			userId: "user-example-1",
			organizationId: "org-example-1",
		});
		expect(rec.planner.executeStep).toBeUndefined();
		expect(rec.finalized[0]).toMatchObject({ outcome: "CANCELLED" });
	}, 120_000);

	it("Planner: a native cancel while the plan waits for approval ends 'cancelled', not 'Plan not approved'", async () => {
		const { output, temporalStatus, rec } = await runScenario({
			behaviour: "answer",
			withTurn: true,
			executionMode: "save_reuse",
			planNeedsApproval: true,
			cancelWhenHanging: true,
		});
		expect(output.ok).toBe(true);
		const value = (output as { value: OrchestratorWorkflowOutput }).value;
		expect(value.status).toBe("cancelled");
		expect(temporalStatus).toBe("COMPLETED");
		// No decision was recorded and no step ran.
		expect(rec.planner.recordApprovalOutcomeActivity).toBeUndefined();
		expect(rec.planner.executeStep).toBeUndefined();
		expect(rec.finalized[0]).toMatchObject({ outcome: "CANCELLED" });
	}, 120_000);

	it("Planner: a native cancel during a recovery back-off ends 'cancelled' and retries nothing", async () => {
		const { output, temporalStatus, rec } = await runScenario({
			behaviour: "answer",
			withTurn: true,
			executionMode: "save_reuse",
			stepFailsRetryably: true,
			cancelWhenHanging: true,
		});
		expect(output.ok).toBe(true);
		const value = (output as { value: OrchestratorWorkflowOutput }).value;
		expect(value.status).toBe("cancelled");
		expect(temporalStatus).toBe("COMPLETED");
		// The failed attempt only: the back-off was cut short, no retry.
		expect(rec.planner.executeStep).toHaveLength(1);
		expect(rec.finalized[0]).toMatchObject({ outcome: "CANCELLED" });
	}, 120_000);

	it("Weave: a run handed a turnId still writes no turn state and sends no scope", async () => {
		const { output, rec } = await runScenario({
			behaviour: "answer",
			withTurn: true,
			executionMode: "weave",
		});
		expect(output.ok).toBe(true);
		expect(rec.finalized).toHaveLength(0);
		expect(rec.planner.analyzeAndRoute?.[0]).not.toHaveProperty(
			"turnScope",
		);
		expect(rec.planner.executeStep?.[0]).not.toHaveProperty("turnScope");
	}, 120_000);

	it("Planner: a run without a turnId behaves as before (no scope, no turn state, a refused routing call fails the plan)", async () => {
		const answered = await runScenario({
			behaviour: "answer",
			withTurn: false,
			executionMode: "save_reuse",
		});
		expect(answered.output.ok).toBe(true);
		expect(
			(answered.output as { value: OrchestratorWorkflowOutput }).value
				.status,
		).toBe("completed");
		expect(answered.rec.finalized).toHaveLength(0);
		expect(answered.rec.planner.analyzeAndRoute?.[0]).not.toHaveProperty(
			"turnScope",
		);
		expect(answered.rec.planner.executeStep?.[0]).not.toHaveProperty(
			"turnScope",
		);

		// The legacy contract: a planning failure is a failed run.
		const refused = await runScenario({
			behaviour: "answer",
			withTurn: false,
			executionMode: "save_reuse",
			plannerRouting: "refuse_dispatch",
		});
		expect(
			(refused.output as { value: OrchestratorWorkflowOutput }).value
				.status,
		).toBe("failed");
		expect(refused.rec.finalized).toHaveLength(0);
	}, 120_000);

	it("R1-10: REJECT_DUPLICATE refuses a second execution of a closed workflow id (the default reuse policy does not)", async () => {
		const taskQueue = `orchestrator-turn-reuse-${taskQueueSeq++}`;
		const workflowId = "orch-00000000-0000-4000-8000-0000000000ff";
		const rec: Recorder = {
			rounds: [],
			finalized: [],
			otherModelCalls: [],
			preloadStarted: false,
			planner: {},
			hangingStarted: false,
		};
		const worker = await Worker.create({
			connection: env.nativeConnection,
			taskQueue,
			workflowBundle,
			activities: buildActivities(
				{ behaviour: "answer", withTurn: false },
				rec,
			),
		});
		const input: OrchestratorWorkflowInput = {
			executionId: workflowId,
			message: "What is the launch date?",
			history: [],
			userId: "user-example-1",
			organizationId: "org-example-1",
			executionMode: "balanced",
		};
		await worker.runUntil(async () => {
			await env.client.workflow.execute(WORKFLOW_NAME, {
				args: [input],
				taskQueue,
				workflowId,
			});
			await expect(
				env.client.workflow.start(WORKFLOW_NAME, {
					args: [input],
					taskQueue,
					workflowId,
					workflowIdReusePolicy: "REJECT_DUPLICATE",
				}),
			).rejects.toBeInstanceOf(WorkflowExecutionAlreadyStartedError);
			// Without the policy a delayed second start makes a new execution.
			const again = await env.client.workflow.start(WORKFLOW_NAME, {
				args: [input],
				taskQueue,
				workflowId,
			});
			await again.result();
		});
		expect(rec.rounds).toHaveLength(2);
	}, 120_000);
});
