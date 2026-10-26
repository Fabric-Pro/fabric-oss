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
 * with no recovery or later step scheduled after it. The Weave scenario skips
 * turn-state writes when handed a turnId.
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
let legacyRoutingBundle: WorkflowBundleWithSourceMap;

beforeAll(async () => {
	env = await TestWorkflowEnvironment.createTimeSkipping();
	workflowBundle = await bundleWorkflowCode({
		workflowsPath: WORKFLOWS_PATH,
	});
	// Replace only the new decision in the test bundle to record the old path.
	// The production bundle is used unchanged for new runs and replay.
	const decision =
		/\(0,\s*[\w.$]+\.patched\)\("orch-skip-unused-routing-v1"\)/g;
	const matches = workflowBundle.code.match(decision) ?? [];
	if (matches.length !== 1) {
		throw new Error(
			"Expected one routing patch call in the workflow bundle",
		);
	}
	legacyRoutingBundle = {
		...workflowBundle,
		code: workflowBundle.code.replace(decision, "false"),
	};
}, 240_000);

afterAll(async () => {
	await env?.teardown();
});

const USAGE = { inputTokens: 10, outputTokens: 5 };

type RoundBehaviour =
	| "real_round_hanging_provider"
	| "answer"
	| "refuse_dispatch"
	/** The main round's request does not fit the turn's token allowance. */
	| "budget_exhausted";

/** How the finalization synthesis behaves after a budget stop. */
type FinalizationBehaviour = "answer" | "denied" | "hang_until_cancelled";

/** The ledger reading a budget refusal carries (turn-dispatch.ts). */
const REFUSAL_SNAPSHOT = {
	allowance: 500_000,
	finalizationReserve: 8_000,
	measured: 470_000,
	outstanding: 25_000,
	enforcement: "ENFORCED",
};

function budgetRefusal() {
	return ApplicationFailure.create({
		type: "TurnBudgetExhausted",
		message: "Turn has used its token allowance",
		nonRetryable: true,
		details: [
			{
				kind: "EXPLORATION",
				room: 2_000,
				needed: 40_000,
				snapshot: REFUSAL_SNAPSHOT,
			},
		],
	});
}

/** A synthesis long enough to pass the degenerate-answer check. */
const FINAL_ANSWER = `## Summary\n\nThe launch is on the 12th. ${"Evidence. ".repeat(30)}`;

interface Recorder {
	rounds: Array<Record<string, unknown>>;
	finalized: Array<Record<string, unknown>>;
	otherModelCalls: string[];
	preloadStarted: boolean;
	/** Planner-path activity inputs, by activity name. */
	planner: Record<string, Array<Record<string, unknown>>>;
	/** Set once a hanging planner activity has started. */
	hangingStarted: boolean;
	/** Set once the finalization synthesis has started. */
	finalizationStarted: boolean;
	toolInvocations: number;
	deadlineInterrupted?: boolean;
}

/** How a planner-path activity behaves in a scenario. */
type PlannerBehaviour = "hang_until_cancelled" | "refuse_dispatch";

type DeadlineSite = "round" | "tool" | "compaction" | "approval";

interface ScenarioOptions {
	legacyRouting?: boolean;
	routingEmpty?: boolean;
	memoryPrompt?: string;
	historyRetention?: "bounded";
	deadlineSite?: DeadlineSite;
	deadlineStop?: "before" | "after" | "summary";
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
	/** The plan needs approval; cancel after its pendingApproval query is set. */
	planNeedsApproval?: boolean;
	/** The step fails (not a stop), recovery classifies it retryable and
	 * waits out a back-off (marks hanging) before retrying. */
	stepFailsRetryably?: boolean;
	/** The starter's `turnGeneration`. */
	turnGeneration?: number | null;
	/** After a budget stop: how the FINALIZATION synthesis behaves. */
	finalization?: FinalizationBehaviour;
	/** Cancel the run once the finalization synthesis has started. */
	cancelDuringFinalization?: boolean;
	/** The ledger reading the finalization returns (merged over defaults). */
	finalizationLedger?: Record<string, unknown>;
	/** The budget stop the terminal write reports it persisted. */
	/**
	 * What the fake turn row stores as `budgetStop`: by default the stop the
	 * terminal write sent; `null` for a row that stores none.
	 */
	persistedBudgetStop?: Record<string, unknown> | null;
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
		// stop; the Stop scenarios assert that recovery is not called.
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

function buildActivities(opts: ScenarioOptions, rec: Recorder, testEnv = env) {
	const advance = async (seconds: number) => {
		const ctx = Context.current();
		for (let elapsed = 0; elapsed < seconds; elapsed += 15) {
			ctx.heartbeat();
			// Context.heartbeat queues delivery through the worker. Wait for a
			// server acknowledgement before skipping towards the 30-second
			// heartbeat timeout; a short wall-clock sleep cannot ensure delivery
			// under load. Keep the worker heartbeat so cancellation reaches ctx.
			await testEnv.connection.workflowService.recordActivityTaskHeartbeat(
				{
					taskToken: ctx.info.taskToken,
				},
			);
			await testEnv.sleep("15 seconds");
		}
	};
	const hang = async () => {
		rec.hangingStarted = true;
		const ctx = Context.current();
		ctx.heartbeat();
		for (
			let elapsed = 0;
			elapsed < 120 && !ctx.cancellationSignal.aborted;
			elapsed += 15
		) {
			await advance(15);
			ctx.heartbeat();
			await new Promise((resolveTick) => setTimeout(resolveTick, 5));
		}
		// A removed deadline guard lets the activity return after two minutes;
		// the assertions then fail on the missing cancellation command.
		if (!ctx.cancellationSignal.aborted) {
			return;
		}
		if (opts.deadlineStop === "after") {
			rec.deadlineInterrupted = true;
			await new Promise((resolveTick) => setTimeout(resolveTick, 100));
		}
		throw new CancelledFailure("deadline activity interrupted");
	};
	const behaviour = opts.behaviour;
	const modelCall = (name: string) =>
		vi.fn(async () => {
			rec.otherModelCalls.push(name);
			throw new Error(`${name} should not run in this scenario`);
		});
	return {
		// These scenarios answer factual questions without claiming a write.
		checkCompletionClaimActivity: vi.fn(async () => ({
			unbackedClaim: false,
			judgedBy: "decision",
			usage: { inputTokens: 0, outputTokens: 0 },
		})),
		// Finish the abandoned completion child before its test worker exits.
		embedAndStoreTrajectory: vi.fn(async () => undefined),
		recordExecution: vi.fn(async () => undefined),
		createEpisodeFromExecutionActivity: vi.fn(async () => undefined),
		extractAndLearnPatternsActivity: vi.fn(async () => ({ count: 0 })),
		preloadMcpToolsForConfigsActivity: vi.fn(async () => []),
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
				mcpTools: opts.deadlineSite
					? [
							{
								toolName: "example_read",
								description: "Read example data",
								inputSchema: { type: "object", properties: {} },
								serverName: "Example",
								configId: "example-config",
							},
						]
					: [],
				agents: [],
				integrations: [],
				loadDurationMs: 1,
			};
		}),
		loadOrchestratorMemoryActivity: vi.fn(async () => ({
			memoryContextPrompt: opts.memoryPrompt ?? "",
			preferences: {},
			recentEpisodes: [],
			relevantEpisodes: [],
		})),
		updateRecentActivityActivity: vi.fn(async () => undefined),
		initializeLettaMemory: vi.fn(async () => null),
		getHybridRoutingSuggestions: vi.fn(async () => ({
			suggestions: opts.routingEmpty
				? []
				: [
						{
							source: "qdrant",
							confidence: 0.9,
							agents: [],
							tools: [],
						},
						{
							source: "letta",
							confidence: 0.8,
							agents: [],
							tools: [],
						},
					],
			warnings: opts.routingEmpty
				? []
				: [
						{
							failedTask: "Example task",
							similarity: 0.8,
							errorSummary: "Example error",
						},
					],
			fromCache: false,
		})),
		applyPolicyEnrichment: vi.fn(async () => ({ blocked: false })),
		applyFabricPatternEnrichment: vi.fn(async () => ({})),
		loadInstanceMemoryActivity: vi.fn(async () => null),
		getProjectMetadataActivity: vi.fn(async () => null),
		listDefaultEnabledMcpServersActivity: vi.fn(async () => []),
		findDefaultMcpConfigActivity: vi.fn(async () => null),
		publishMcpDefaultToolSignalActivity: vi.fn(async () => undefined),
		// The up-front check (the request itself) returns no question; a per-step
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
			if (req.budgetAttemptKind === "FINALIZATION") {
				rec.finalizationStarted = true;
				if (opts.deadlineStop === "summary") {
					await hang();
				}
				if (opts.finalization === "denied") {
					throw budgetRefusal();
				}
				if (opts.finalization === "hang_until_cancelled") {
					const ctx = Context.current();
					ctx.heartbeat();
					await new Promise<void>((resolveWait) => {
						const tick = setInterval(() => ctx.heartbeat(), 500);
						ctx.cancellationSignal.addEventListener("abort", () => {
							clearInterval(tick);
							resolveWait();
						});
					});
					throw new CancelledFailure("finalization aborted");
				}
				return {
					type: "response",
					content:
						opts.deadlineSite === "tool"
							? `${FINAL_ANSWER}\nexample_read: interrupted at the time limit — outcome unknown; verify before retrying.`
							: FINAL_ANSWER,
					usage: USAGE,
					ledger: {
						...REFUSAL_SNAPSHOT,
						measured: 476_000,
						outstanding: 0,
						...opts.finalizationLedger,
					},
				};
			}
			if (opts.deadlineSite && rec.rounds.length <= 11) {
				return {
					type: "tool_calls",
					toolCalls: [
						{
							id: `example-progress-${rec.rounds.length}`,
							name: "example_read",
							args: {},
						},
					],
					usage: USAGE,
				};
			}
			if (opts.deadlineSite === "round") {
				await hang();
			}
			if (
				opts.deadlineSite === "approval" ||
				opts.deadlineSite === "tool" ||
				opts.deadlineSite === "compaction"
			) {
				return {
					type: "tool_calls",
					toolCalls: Array.from(
						{ length: opts.deadlineSite === "tool" ? 4 : 1 },
						(_, i) => ({
							id: `example-call-${rec.rounds.length}-${i}`,
							name:
								opts.deadlineSite === "approval"
									? "delete_records"
									: "example_read",
							args: {},
						}),
					),
					usage:
						opts.deadlineSite === "compaction"
							? { inputTokens: 800000, outputTokens: 5 }
							: USAGE,
				};
			}
			if (behaviour === "budget_exhausted") {
				throw budgetRefusal();
			}
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
		compactConversationHistoryActivity:
			opts.deadlineSite === "compaction"
				? vi.fn(async () => {
						await hang();
						return {
							summaryText: "Earlier example findings",
							usage: USAGE,
						};
					})
				: modelCall("compactConversationHistoryActivity"),
		executeMcpTool: vi.fn(async () => {
			rec.toolInvocations++;
			if (rec.rounds.length <= 11) {
				await advance(240);
			} else if (opts.deadlineSite === "tool") {
				await hang();
			}
			return { success: true, output: "Example data", durationMs: 1 };
		}),
		createOrchestratorApprovalRequest: vi.fn(async () => {
			rec.hangingStarted = true;
			return { approvalId: "example-approval" };
		}),
		updateApprovalTaskStatus: vi.fn(async () => undefined),
		executeAgentAsTool: modelCall("executeAgentAsTool"),

		finalizeConversationTurnActivity: vi.fn(
			async (req: Record<string, unknown>) => {
				rec.finalized.push(req);
				return {
					status: opts.finalizedStatus ?? req.outcome,
					wrote: true,
					...(opts.persistedBudgetStop === null
						? {}
						: opts.persistedBudgetStop
							? { budgetStop: opts.persistedBudgetStop }
							: req.budgetStop
								? { budgetStop: req.budgetStop }
								: {}),
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
	const testEnv = opts.deadlineSite
		? await TestWorkflowEnvironment.createTimeSkipping()
		: env;
	const rec: Recorder = {
		rounds: [],
		finalized: [],
		otherModelCalls: [],
		preloadStarted: false,
		planner: {},
		hangingStarted: false,
		finalizationStarted: false,
		toolInvocations: 0,
	};
	if (opts.behaviour === "real_round_hanging_provider") {
		installHangingProvider();
	}
	const taskQueue = `orchestrator-turn-cancel-${taskQueueSeq++}`;
	const workflowId = `orch-00000000-0000-4000-8000-${String(taskQueueSeq).padStart(12, "0")}`;
	const input: OrchestratorWorkflowInput = {
		executionId: workflowId,
		message: "What is the launch date?",
		history:
			opts.deadlineSite === "compaction"
				? Array.from({ length: 30 }, (_, i) => ({
						role:
							i % 2 === 0
								? ("user" as const)
								: ("assistant" as const),
						content: "Earlier example finding",
					}))
				: [],
		enabledMcpConfigIds: opts.deadlineSite ? ["example-config"] : undefined,
		userId: "user-example-1",
		organizationId: "org-example-1",
		executionMode: opts.executionMode ?? "balanced",
		...(opts.historyRetention
			? { historyRetention: opts.historyRetention }
			: {}),
		...(opts.surface ? { surface: opts.surface } : {}),
		...(opts.withTurn
			? { turnId: "turn-example-1", turnContractVersion: 1 }
			: {}),
		...(opts.turnGeneration !== undefined
			? { turnGeneration: opts.turnGeneration }
			: {}),
	};
	const cacheLogs: Array<{
		event: string;
		details: Record<string, unknown>;
	}> = [];
	const worker = await Worker.create({
		connection: testEnv.nativeConnection,
		taskQueue,
		workflowBundle: opts.legacyRouting
			? legacyRoutingBundle
			: workflowBundle,
		activities: buildActivities(opts, rec, testEnv),
		sinks: {
			defaultWorkerLogger: {
				info: {
					fn: (
						_info: unknown,
						event: string,
						details: Record<string, unknown>,
					) => {
						if (event.startsWith("advisor.")) {
							cacheLogs.push({ event, details });
						}
					},
				},
				trace: { fn: () => {} },
				debug: { fn: () => {} },
				warn: { fn: () => {} },
				error: { fn: () => {} },
			},
		},
		// As the production orchestrator queue (worker.ts).
		maxHeartbeatThrottleInterval: opts.deadlineSite ? "1ms" : "1s",
	});
	let cancelRequestedAt: number | undefined;
	const result = await worker.runUntil(async () => {
		const handle = await testEnv.client.workflow.start(WORKFLOW_NAME, {
			args: [input],
			taskQueue,
			workflowId,
			workflowExecutionTimeout: "2 hours",
		});
		const deadlineResult = opts.deadlineSite ? handle.result() : undefined;
		if (opts.deadlineSite && opts.deadlineStop) {
			await vi.waitFor(() => expect(rec.hangingStarted).toBe(true), {
				timeout: 60000,
				interval: 5,
			});
			if (opts.deadlineStop === "after") {
				await vi.waitFor(
					() => expect(rec.deadlineInterrupted).toBe(true),
					{ timeout: 30000, interval: 5 },
				);
			}
			if (opts.deadlineStop === "summary") {
				await vi.waitFor(
					() => expect(rec.finalizationStarted).toBe(true),
					{ timeout: 30000, interval: 5 },
				);
			}
			await handle.cancel();
		}
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
				async () => {
					if (opts.planNeedsApproval) {
						// The activity-side flag precedes completion delivery. This
						// query observes the workflow after it consumes that result
						// and enters waitForApproval. Time skipping stays locked until
						// handle.result() below, keeping the approval timer pending.
						expect(
							await handle.query("pendingApproval"),
						).toMatchObject({
							approvalId: "example-approval",
							stepId: "plan-approval",
						});
					} else {
						expect(rec.hangingStarted).toBe(true);
					}
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
		if (opts.cancelDuringFinalization) {
			await vi.waitFor(
				() => {
					expect(rec.finalizationStarted).toBe(true);
				},
				{ timeout: 30_000, interval: 25 },
			);
			await handle.cancel();
		}
		const output = await (deadlineResult ?? handle.result())
			.then((value) => ({ ok: true as const, value }))
			.catch((error: unknown) => ({ ok: false as const, error }));
		if (
			opts.deadlineSite &&
			output.ok &&
			output.value.status === "completed"
		) {
			await testEnv.client.workflow
				.getHandle(`${workflowId}-completion`)
				.result();
		}
		const description = await handle.describe();
		// The recorded history must replay against the same code: the new
		// cancellation path is deterministic.
		const history = await handle.fetchHistory();
		await Worker.runReplayHistory({ workflowBundle }, history, workflowId);
		return {
			output,
			temporalStatus: description.status.name,
			patchIds: recordedPatchIds(history),
			history,
		};
	});
	const cancelLatencyMs =
		cancelRequestedAt !== undefined && provider.abortedAt !== undefined
			? provider.abortedAt - cancelRequestedAt
			: undefined;
	if (opts.deadlineSite) {
		await testEnv.teardown();
	}
	return { ...result, rec, workflowId, cancelLatencyMs, cacheLogs };
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
		// The round carried its turn scope, with the budget contract a new
		// run records (`orch-turn-budget-v1`); the input sent no generation.
		expect(rec.rounds[0]?.turnScope).toEqual({
			turnId: "turn-example-1",
			executionId: workflowId,
			userId: "user-example-1",
			organizationId: "org-example-1",
			budgetContractVersion: 1,
		});
		// The terminal state was written, as a cancellation.
		expect(rec.finalized).toHaveLength(1);
		expect(rec.finalized[0]).toMatchObject({
			outcome: "CANCELLED",
			turnScope: { turnId: "turn-example-1" },
		});
	}, 120_000);

	it("a refused dispatch (cancel recorded without a Temporal cancel) ends the turn 'cancelled', not failed", async () => {
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
			budgetContractVersion: 1,
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
		// Both tested modes record these markers on a new run.
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
			budgetContractVersion: 1,
		});
		expect(rec.planner.executeStep).toBeUndefined();
		expect(rec.finalized[0]).toMatchObject({ outcome: "CANCELLED" });
	}, 120_000);

	it("Planner: a native cancel while the plan waits for approval ends 'cancelled', not 'Plan not approved'", async () => {
		const { output, temporalStatus, rec, history } = await runScenario({
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
		// History enforces cancellation at the approval wait, after the
		// request activity completed, rather than during its setup.
		const events = history.events ?? [];
		const requested = events.find(
			(event) => event.workflowExecutionCancelRequestedEventAttributes,
		);
		const approvalTimer = events.find(
			(event) => event.timerStartedEventAttributes,
		);
		expect(approvalTimer).toBeDefined();
		expect(requested).toBeDefined();
		expect(Number(approvalTimer?.eventId)).toBeLessThan(
			Number(requested?.eventId),
		);
		expect(events.some((event) => event.timerFiredEventAttributes)).toBe(
			false,
		);
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
			finalizationStarted: false,
			toolInvocations: 0,
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

/**
 * The history with its completion result rewritten to drop `budgetStop`, as
 * a run recorded before the stop survived normalization returned it.
 * Throws when the history has no completion result to rewrite.
 */
function withResultWithoutBudgetStop<T>(history: T): T {
	const copy = structuredClone(history) as {
		events?: Array<{
			workflowExecutionCompletedEventAttributes?: {
				result?: {
					payloads?: Array<{
						data?: Uint8Array | string | null;
					}> | null;
				} | null;
			} | null;
		}> | null;
	};
	let rewritten = 0;
	for (const event of copy.events ?? []) {
		const payload =
			event.workflowExecutionCompletedEventAttributes?.result
				?.payloads?.[0];
		if (!payload?.data) {
			continue;
		}
		const isString = typeof payload.data === "string";
		const bytes = isString
			? Buffer.from(payload.data as string, "base64")
			: Buffer.from(payload.data as Uint8Array);
		const parsed = JSON.parse(bytes.toString("utf8")) as Record<
			string,
			unknown
		>;
		if (!("budgetStop" in parsed)) {
			throw new Error("the recorded result carries no budgetStop");
		}
		delete parsed.budgetStop;
		const encoded = Buffer.from(JSON.stringify(parsed), "utf8");
		payload.data = isString
			? encoded.toString("base64")
			: new Uint8Array(encoded);
		rewritten++;
	}
	if (rewritten !== 1) {
		throw new Error(`expected one completion result, found ${rewritten}`);
	}
	return copy as T;
}

/**
 * The history with the `orch-turn-budget-v1` marker turned into a deprecated
 * marker of an id no code asks about, which replay skips (as it skips the
 * markers of a removed `deprecatePatch`): to the code under test the history
 * holds no budget marker, as one recorded by a worker that predates the
 * token ledger would. (Deleting the event instead would renumber the
 * history.)
 */
function withoutBudgetMarker<T>(
	history: T,
	markerId = "orch-turn-budget-v1",
): T {
	const copy = structuredClone(history) as {
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
	};
	let renamed = 0;
	for (const event of copy.events ?? []) {
		const marker = event.markerRecordedEventAttributes;
		const payload = marker?.details?.["patch-data"]?.payloads?.[0];
		if (marker?.markerName !== "core_patch" || !payload?.data) {
			continue;
		}
		const isString = typeof payload.data === "string";
		const bytes = isString
			? Buffer.from(payload.data as string, "base64")
			: Buffer.from(payload.data as Uint8Array);
		const parsed = JSON.parse(bytes.toString("utf8")) as {
			id?: string;
			deprecated?: boolean;
		};
		if (parsed.id !== markerId) {
			continue;
		}
		parsed.id = "orch-unrelated-example-v1";
		parsed.deprecated = true;
		const encoded = Buffer.from(JSON.stringify(parsed), "utf8");
		payload.data = isString
			? encoded.toString("base64")
			: new Uint8Array(encoded);
		renamed++;
	}
	expect(renamed).toBe(1);
	return copy as T;
}

describe("orchestratorExecutionWorkflow — token allowance on a chat turn", () => {
	it("records the budget marker right after the Planner marker, and carries the generation and contract in the scope", async () => {
		const { patchIds, rec, workflowId } = await runScenario({
			behaviour: "answer",
			withTurn: true,
			turnGeneration: 3,
		});
		expect(patchIds.slice(0, 3)).toEqual([
			"orch-turn-cancellation-v1",
			"orch-planner-turn-v1",
			"orch-turn-budget-v1",
		]);
		expect(rec.rounds[0]?.turnScope).toEqual({
			turnId: "turn-example-1",
			executionId: workflowId,
			userId: "user-example-1",
			organizationId: "org-example-1",
			generation: 3,
			budgetContractVersion: 1,
		});
		// A main round, for the ledger.
		expect(rec.rounds[0]?.budgetAttemptKind).toBe("EXPLORATION");
	}, 120_000);

	it("answers a budget refusal with the FINALIZATION synthesis and ends LIMITED with the structured stop", async () => {
		const { output, rec } = await runScenario({
			behaviour: "budget_exhausted",
			withTurn: true,
			turnGeneration: null,
			finalization: "answer",
		});
		expect(output.ok).toBe(true);
		const value = (output as { value: OrchestratorWorkflowOutput }).value;
		expect(value.status).toBe("completed");
		expect(value.response).toBe(FINAL_ANSWER);
		// toHaveLength(2) enforces a refused round and one finalization, with no tools.
		expect(rec.rounds).toHaveLength(2);
		expect(rec.rounds[1]).toMatchObject({
			budgetAttemptKind: "FINALIZATION",
			availableTools: {},
		});
		expect(rec.rounds[0]?.turnScope).toMatchObject({ generation: null });
		// The ledger as it stands after the finalization (476,000 measured,
		// nothing outstanding), not the reading taken at the refusal.
		expect(value.budgetStop).toEqual({
			version: 1,
			kind: "token_allowance",
			allowance: 500_000,
			measured: 476_000,
			outstanding: 0,
			enforcement: "ENFORCED",
			stopReason: "allowance_exhausted",
		});
		// No new-chat handoff for a token-allowance stop.
		expect(value.handoffRecommended).toBeUndefined();
		// The limit signal reports measured usage, excluding reservations.
		expect(value.limitSignals).toEqual([
			expect.objectContaining({
				kind: "internal_budget",
				budgetLimit: "tokens",
				budget: expect.objectContaining({
					used: 476_000,
					total: 500_000,
				}),
			}),
		]);
		expect(rec.finalized).toHaveLength(1);
		expect(rec.finalized[0]).toMatchObject({
			outcome: "LIMITED",
			terminalReason: "token allowance used",
			responseText: FINAL_ANSWER,
			budgetStop: value.budgetStop,
		});
		expect(rec.otherModelCalls).toEqual([]);
	}, 120_000);

	it("reports MEASURED_ONLY when the finalization ran on a model that cannot be capped", async () => {
		const { output, rec } = await runScenario({
			behaviour: "budget_exhausted",
			withTurn: true,
			turnGeneration: 1,
			finalization: "answer",
			finalizationLedger: { enforcement: "MEASURED_ONLY" },
		});
		const value = (output as { value: OrchestratorWorkflowOutput }).value;
		expect(value.budgetStop).toMatchObject({
			measured: 476_000,
			enforcement: "MEASURED_ONLY",
		});
		expect(rec.finalized[0]).toMatchObject({
			budgetStop: expect.objectContaining({
				enforcement: "MEASURED_ONLY",
			}),
		});
	}, 120_000);

	it("returns the stop persisted by the terminal write (totals refreshed from the ledger)", async () => {
		const persisted = {
			kind: "token_allowance",
			allowance: 500_000,
			measured: 480_000,
			outstanding: 1_000,
			enforcement: "MEASURED_ONLY",
			stopReason: "allowance_exhausted",
		};
		const { output } = await runScenario({
			behaviour: "budget_exhausted",
			withTurn: true,
			turnGeneration: 1,
			finalization: "answer",
			persistedBudgetStop: persisted,
		});
		const value = (output as { value: OrchestratorWorkflowOutput }).value;
		expect(value.budgetStop).toEqual(persisted);
		expect(value.limitSignals).toEqual([
			expect.objectContaining({
				kind: "internal_budget",
				budget: expect.objectContaining({
					used: 480_000,
					total: 500_000,
				}),
			}),
		]);
	}, 120_000);

	it("drops the run's own stop when the turn row stores none, so live output omits the payload the row lacks", async () => {
		const { output, rec } = await runScenario({
			behaviour: "budget_exhausted",
			withTurn: true,
			turnGeneration: 1,
			finalization: "answer",
			persistedBudgetStop: null,
		});
		const value = (output as { value: OrchestratorWorkflowOutput }).value;
		expect(rec.finalized[0]).toHaveProperty("budgetStop");
		expect(value).not.toHaveProperty("budgetStop");
	}, 120_000);

	it("falls back to the static summary when the finalization is refused too", async () => {
		const { output, rec } = await runScenario({
			behaviour: "budget_exhausted",
			withTurn: true,
			turnGeneration: 1,
			finalization: "denied",
		});
		expect(output.ok).toBe(true);
		const value = (output as { value: OrchestratorWorkflowOutput }).value;
		expect(value.status).toBe("completed");
		expect(value.response).toContain("token allowance");
		expect(value.response).toContain("continue in this chat");
		expect(value.response).not.toMatch(/new chat/i);
		expect(value.budgetStop).toMatchObject({
			kind: "token_allowance",
			stopReason: "finalization_unavailable",
		});
		expect(value.handoffRecommended).toBeUndefined();
		// The refusal is not retried as a degenerate answer.
		expect(
			rec.rounds.filter((r) => r.budgetAttemptKind === "FINALIZATION"),
		).toHaveLength(1);
		expect(rec.finalized[0]).toMatchObject({
			outcome: "LIMITED",
			budgetStop: expect.objectContaining({
				stopReason: "finalization_unavailable",
			}),
		});
	}, 120_000);

	it("keeps the stored stop when a Stop recorded after the finalization wins the terminal write: status CANCELLED, payload the row's", async () => {
		const stored = {
			kind: "token_allowance",
			allowance: 500_000,
			measured: 476_000,
			outstanding: 0,
			enforcement: "ENFORCED",
			stopReason: "allowance_exhausted",
		};
		const { output, rec, history, workflowId } = await runScenario({
			behaviour: "budget_exhausted",
			withTurn: true,
			turnGeneration: 1,
			finalization: "answer",
			// The finalization finished; the terminal write then found the
			// Stop recorded meanwhile, stored CANCELLED with the refreshed
			// stop, and returned what it stored.
			finalizedStatus: "CANCELLED",
			persistedBudgetStop: stored,
		});
		expect(output.ok).toBe(true);
		const value = (output as { value: OrchestratorWorkflowOutput }).value;
		expect(rec.finalized[0]).toMatchObject({ outcome: "LIMITED" });
		expect(value.status).toBe("cancelled");
		expect(value.budgetStop).toEqual(stored);
		expect(value.handoffRecommended).toBeUndefined();

		// Replay safety of the change: the same history with the result the
		// previous code returned (the stop dropped) replays cleanly, so the
		// result is not something replay compares.
		await Worker.runReplayHistory(
			{ workflowBundle },
			withResultWithoutBudgetStop(history),
			workflowId,
		);
	}, 180_000);

	it("lets a Stop during the finalization win over LIMITED", async () => {
		const { output, temporalStatus, rec } = await runScenario({
			behaviour: "budget_exhausted",
			withTurn: true,
			turnGeneration: 1,
			finalization: "hang_until_cancelled",
			cancelDuringFinalization: true,
		});
		expect(output.ok).toBe(true);
		const value = (output as { value: OrchestratorWorkflowOutput }).value;
		expect(value.status).toBe("cancelled");
		expect(temporalStatus).toBe("COMPLETED");
		expect(rec.finalized[0]).toMatchObject({ outcome: "CANCELLED" });
	}, 120_000);

	it("replays a history without the budget marker as the legacy run: the budget exit is not taken", async () => {
		// A normal turn recorded without the marker replays cleanly…
		const plain = await runScenario({
			behaviour: "answer",
			withTurn: true,
			turnGeneration: 1,
		});
		await Worker.runReplayHistory(
			{ workflowBundle },
			withoutBudgetMarker(plain.history),
			plain.workflowId,
		);
		// …while a budget stop recorded under the marker does not: without
		// it the scope has no contract, so the refusal is not routed to the
		// budget exit and the finalization activity the history holds is
		// not scheduled. The marker gates the ledger behaviour.
		const stopped = await runScenario({
			behaviour: "budget_exhausted",
			withTurn: true,
			turnGeneration: 1,
			finalization: "answer",
		});
		await expect(
			Worker.runReplayHistory(
				{ workflowBundle },
				withoutBudgetMarker(stopped.history),
				stopped.workflowId,
			),
		).rejects.toThrow(/[Nn]ondetermin/);
	}, 180_000);
});

describe("Advisor deadline cancellation boundary", () => {
	it.each(["round", "tool", "compaction", "approval"] as const)(
		"saves a time stop when interrupted during %s",
		async (deadlineSite) => {
			const { output, temporalStatus, rec, history } = await runScenario({
				behaviour: "answer",
				withTurn: true,
				deadlineSite,
			});
			const events = history.events ?? [];
			const target =
				deadlineSite === "round"
					? "runAgentIteration"
					: deadlineSite === "tool"
						? "executeMcpTool"
						: "compactConversationHistoryActivity";
			if (deadlineSite !== "approval") {
				const cancelledIds = new Set(
					events.flatMap((event) =>
						event.activityTaskCancelRequestedEventAttributes
							? [
									Number(
										event
											.activityTaskCancelRequestedEventAttributes
											.scheduledEventId,
									),
								]
							: [],
					),
				);
				expect(
					events.some(
						(event) =>
							event.activityTaskScheduledEventAttributes
								?.activityType?.name === target &&
							cancelledIds.has(Number(event.eventId)),
					),
					`deadline requests cancellation of ${target}`,
				).toBe(true);
			} else {
				// The capped approval timer and scope timer can expire in the
				// same task. Check the outer deadline timer as well as the saved
				// stop; a removed scope leaves only the approval's one-minute cap.
				expect(
					events.some((event) => {
						const seconds = Number(
							event.timerStartedEventAttributes
								?.startToFireTimeout?.seconds,
						);
						return seconds >= 2698 && seconds <= 2700;
					}),
					"deadline scope schedules its 45-minute timer",
				).toBe(true);
			}
			expect(output).toMatchObject({
				ok: true,
				value: {
					status: "completed",
					budgetStop: { version: 1, kind: "time_limit" },
				},
			});
			expect(temporalStatus).toBe("COMPLETED");
			expect(rec.finalized.at(-1)).toMatchObject({
				outcome: "LIMITED",
				responseText: expect.stringContaining("## Summary"),
				budgetStop: { kind: "time_limit" },
			});
			const started = events[0].eventTime;
			const ended = events.at(-1)?.eventTime;
			expect(
				Number(ended?.seconds) - Number(started?.seconds),
			).toBeLessThan(7200);
			if (deadlineSite === "tool") {
				expect(rec.toolInvocations).toBe(12);
				expect(
					JSON.stringify(
						rec.rounds.find(
							(r) => r.budgetAttemptKind === "FINALIZATION",
						)?.conversationHistory,
					),
				).toContain("interrupted at the time limit — outcome unknown");
				expect(output).toMatchObject({
					ok: true,
					value: {
						response: expect.stringContaining("example_read"),
					},
				});
			}
		},
		120_000,
	);
	it.each(["before", "after", "summary"] as const)(
		"lets Stop win %s the deadline summary",
		async (deadlineStop) => {
			const { output, rec } = await runScenario({
				behaviour: "answer",
				withTurn: true,
				deadlineSite: "round",
				deadlineStop,
			});
			expect(output).toMatchObject({
				ok: true,
				value: { status: "cancelled" },
			});
			expect(rec.finalized.at(-1)).toMatchObject({
				outcome: "CANCELLED",
			});
		},
		120_000,
	);
});

it.each(["bounded", undefined] as const)(
	"records the production history-retention arm %s from the workflow input",
	async (historyRetention) => {
		const { output, rec, patchIds, cacheLogs } = await runScenario({
			behaviour: "answer",
			withTurn: true,
			historyRetention,
		});
		expect(output.ok).toBe(true);
		expect(
			(output as { value: OrchestratorWorkflowOutput }).value.status,
		).toBe("completed");
		expect(rec.rounds).toHaveLength(1);
		const summaries = cacheLogs.filter(
			(line) => line.event === "advisor.turn_cache_summary",
		);
		expect(summaries).toHaveLength(1);
		expect(summaries[0].details).toMatchObject({
			historyRetention: historyRetention ? "bounded-v2" : "age",
			mainRounds: 1,
			answerFinished: true,
		});
		expect(
			patchIds.filter((id) => id === "orch-bounded-history-v1"),
		).toHaveLength(1);
		expect(
			patchIds.filter((id) => id === "orch-bounded-history-v2"),
		).toHaveLength(1);
		expect(
			patchIds.filter((id) => id === "orch-cache-weighted-allowance-v1"),
		).toHaveLength(1);
	},
);

it("replays without the weighted and v2 markers using the retained v1 path", async () => {
	const run = await runScenario({
		behaviour: "answer",
		withTurn: true,
		historyRetention: "bounded",
	});
	await Worker.runReplayHistory(
		{ workflowBundle },
		withoutBudgetMarker(
			withoutBudgetMarker(run.history, "orch-bounded-history-v2"),
			"orch-cache-weighted-allowance-v1",
		),
		run.workflowId,
	);
}, 180_000);

describe("Advisor routing lookup patch", () => {
	const routingLabels = [
		"Past Executions",
		"Keyword Memory",
		"Failure Avoidance",
	];
	const activityNames = (history: {
		events?: Array<{
			activityTaskScheduledEventAttributes?: {
				activityType?: { name?: string | null } | null;
			} | null;
		}> | null;
	}) =>
		(history.events ?? []).flatMap(
			(event) =>
				event.activityTaskScheduledEventAttributes?.activityType
					?.name ?? [],
		);

	it("skips routing lookup through the recorded marker on a new turn", async () => {
		const { output, history, patchIds } = await runScenario({
			behaviour: "answer",
			withTurn: true,
		});
		expect(output.ok && output.value.status).toBe("completed");
		expect(activityNames(history)).not.toContain(
			"getHybridRoutingSuggestions",
		);
		expect(
			patchIds.filter((id) => id === "orch-skip-unused-routing-v1"),
		).toHaveLength(1);
		expect(
			(output.ok ? output.value.planningAudit : undefined)?.sourcesUsed,
		).toEqual([]);
		expect(
			output.ok ? output.value.planningAudit : undefined,
		).toMatchObject({
			usedMemory: false,
			totalSourcesConsulted: 1,
			headline: "Created from analysis",
		});
	});

	it("keeps the prompt memory block in the summary without routing sources", async () => {
		const { output, rec } = await runScenario({
			behaviour: "answer",
			withTurn: true,
			memoryPrompt: "Example preference: concise answers.",
		});
		expect(JSON.stringify(rec.rounds[0])).toContain(
			"Example preference: concise answers.",
		);
		expect(
			output.ok ? output.value.planningAudit : undefined,
		).toMatchObject({
			usedMemory: true,
			sourcesUsed: ["Orchestrator Memory"],
			headline: "Created with memory context",
			totalSourcesConsulted: 1,
		});
	});

	it.each([false, true])(
		"schedules the legacy lookup and replays its pre-marker history (empty=%s)",
		async (routingEmpty) => {
			const { output, history, patchIds } = await runScenario({
				behaviour: "answer",
				withTurn: true,
				legacyRouting: true,
				routingEmpty,
			});
			expect(output.ok && output.value.status).toBe("completed");
			expect(patchIds).not.toContain("orch-skip-unused-routing-v1");
			expect(
				activityNames(history).filter(
					(name) => name === "getHybridRoutingSuggestions",
				),
			).toHaveLength(1);
			expect(
				output.ok ? output.value.planningAudit : undefined,
			).toMatchObject({
				sourcesUsed: routingEmpty ? [] : routingLabels,
				usedMemory: !routingEmpty,
				totalSourcesConsulted: routingEmpty ? 2 : 4,
				headline: routingEmpty
					? "Created from analysis"
					: "Created using past experience with avoiding past failures",
			});
			await Worker.runReplayHistory({ workflowBundle }, history);
			const corrupt = structuredClone(history);
			const command = corrupt.events?.find(
				(event) =>
					event.activityTaskScheduledEventAttributes?.activityType
						?.name === "getHybridRoutingSuggestions",
			)?.activityTaskScheduledEventAttributes?.activityType;
			expect(command).toBeDefined();
			if (command) {
				command.name = "exampleWrongRoutingActivity";
			}
			await expect(
				Worker.runReplayHistory({ workflowBundle }, corrupt),
			).rejects.toThrow(/nondeterminism|TMPRL1100/i);
		},
	);
});
