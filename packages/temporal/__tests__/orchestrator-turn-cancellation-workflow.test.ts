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
}

interface ScenarioOptions {
	behaviour: RoundBehaviour;
	withTurn: boolean;
	cancelDuringRound?: boolean;
	/** Preloading hangs (heartbeating) until cancelled; Stop lands there. */
	cancelDuringPreload?: boolean;
	/** What the terminal-state write reports it persisted. */
	finalizedStatus?: string;
	executionMode?: OrchestratorWorkflowInput["executionMode"];
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
		analyzeIntentClarityActivity: vi.fn(async () => ({
			needsClarification: false,
		})),

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

let taskQueueSeq = 0;

async function runScenario(opts: ScenarioOptions) {
	const rec: Recorder = {
		rounds: [],
		finalized: [],
		otherModelCalls: [],
		preloadStarted: false,
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
		return { output, temporalStatus: description.status.name };
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

	it("R1-4: a save_reuse run never writes turn state, even if handed a turnId", async () => {
		const { rec } = await runScenario({
			behaviour: "answer",
			withTurn: true,
			executionMode: "save_reuse",
		});
		expect(rec.finalized).toHaveLength(0);
	}, 120_000);

	it("R1-10: REJECT_DUPLICATE refuses a second execution of a closed workflow id (the default reuse policy does not)", async () => {
		const taskQueue = `orchestrator-turn-reuse-${taskQueueSeq++}`;
		const workflowId = "orch-00000000-0000-4000-8000-0000000000ff";
		const rec: Recorder = {
			rounds: [],
			finalized: [],
			otherModelCalls: [],
			preloadStarted: false,
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
