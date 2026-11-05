import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	turn: vi.fn(),
	externalSignal: vi.fn(),
	cancelAtPatch: false,
	candidatePatch: true,
	cancelHook: undefined as undefined | (() => void),
	acts: {
		registerNativeAgentExecutionReceipt: vi.fn(),
		completeNativeAgentExecution: vi.fn(),
		loadDeploymentConfiguration: vi.fn(),
		buildExecutionContext: vi.fn(),
		prepareDeploymentAgentTurn: vi.fn(),
		finishDeploymentAgentTurn: vi.fn(),
		invokeDeploymentAgent: vi.fn(),
		completeExecution: vi.fn(),
		completeDurableDeploymentProjection: vi.fn(),
		signalSupervisorCompletion: vi.fn(),
		prepareGoalStep: vi.fn(),
		finishGoalStep: vi.fn(),
		executeGoalStep: vi.fn(),
		createGoalOrientedPlan: vi.fn(),
		verifyGoalAchievement: vi.fn(),
		attemptStepRecovery: vi.fn(),
		completeGoalExecution: vi.fn(),
		completeDurableGoalProjection: vi.fn(),
	},
}));
vi.mock("@temporalio/workflow", async () => ({
	ApplicationFailure: (await import("@temporalio/common")).ApplicationFailure,
	defineQuery: (name: string) => name,
	defineSignal: (name: string) => name,
	setHandler: (name: string, handler: () => void) => {
		if (name === "cancel" || name === "cancelExecution") {
			m.cancelHook = handler;
		}
	},
	patched: (name: string) => {
		if (m.cancelAtPatch) {
			m.cancelHook?.();
		}
		return name === "saved-agent-goal-candidate-output-v1"
			? m.candidatePatch
			: true;
	},
	proxyActivities: () => m.acts,
	getExternalWorkflowHandle: () => ({ signal: m.externalSignal }),
	workflowInfo: () => ({
		workflowId: "example-workflow",
		runId: "example-run",
		workflowType: "nativeDeploymentExecutionWorkflow",
		memo: {},
	}),
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../src/workflows/saved-agent-durable-turn", () => ({
	SAVED_AGENT_DURABLE_STEPS_PATCH: "saved-agent-durable-steps-v1",
	executeDurableSavedAgentTurn: m.turn,
}));

import {
	deploymentExecutionWorkflow,
	nativeDeploymentExecutionWorkflow,
} from "../src/workflows/deployment-execution";
import {
	goalOrientedAgentWorkflow,
	nativeGoalOrientedAgentWorkflow,
} from "../src/workflows/goal-oriented-agent";

const input = {
	executionId: "example-execution",
	deploymentId: "example-deployment",
	instanceId: "example-instance",
	userId: "example-user",
	organizationId: "example-org",
	input: { message: "Example task" },
	triggerType: "SCHEDULE",
	timeoutMs: 300000,
};
function failedTurn(unknown = true) {
	return {
		success: false,
		response: "A tool step stopped",
		error: "Example tool refusal",
		toolCalls: [
			{
				id: "example-call",
				name: "example_tool",
				args: {},
				status: unknown ? "pending" : "error",
				result: {
					inspectionRequired: unknown,
					dispatchState: unknown ? "unknown" : "not_started",
				},
			},
		],
	};
}
beforeEach(() => {
	vi.clearAllMocks();
	m.externalSignal.mockResolvedValue(undefined);
	m.cancelAtPatch = false;
	m.candidatePatch = true;
	m.cancelHook = undefined;
	m.acts.loadDeploymentConfiguration.mockResolvedValue({
		template: { name: "Example", displayName: "Example" },
		instance: { name: "Example" },
		integrationConfigurations: [],
		toolConnections: {},
		workspaceIds: [],
	});
	m.acts.buildExecutionContext.mockResolvedValue({
		systemPrompt: "Example",
		model: "example-model",
		tools: [],
		mcpConfigIds: [],
		knowledgeSources: [],
		workspaceIds: [],
		integrationConfigurations: [],
		builtInToolNames: [],
		agentInstanceId: "example-instance",
		projectId: "example-project",
	});
	m.acts.prepareDeploymentAgentTurn.mockResolvedValue({});
	m.acts.prepareGoalStep.mockResolvedValue({});
	m.acts.createGoalOrientedPlan.mockResolvedValue({
		plan: {
			strategy: "sequential",
			steps: [{ id: "example-step", description: "Example", inputs: {} }],
		},
		routingDecision: {},
	});
	m.acts.completeDurableDeploymentProjection.mockResolvedValue(undefined);
	m.acts.completeDurableGoalProjection.mockResolvedValue(undefined);
	m.turn.mockResolvedValue(failedTurn());
});
describe("new saved-agent workflow control flow", () => {
	it.each([true, false])(
		"retains a deliverable across a final tool-only step (candidate patch %s)",
		async (candidate) => {
			m.candidatePatch = candidate;
			m.turn.mockResolvedValue({
				success: true,
				response: "Step output",
				toolCalls: [],
			});
			m.acts.createGoalOrientedPlan.mockResolvedValue({
				plan: {
					strategy: "sequential",
					steps: [
						{
							id: "answer",
							description: "Produce report",
							inputs: {},
						},
						{ id: "save", description: "Save report", inputs: {} },
					],
				},
				routingDecision: {},
			});
			m.acts.finishGoalStep
				.mockResolvedValueOnce({
					response: "Final report",
					outputs: { rawResponse: "Final report" },
					toolCalls: [],
				})
				.mockResolvedValueOnce({
					response: "",
					outputs: {},
					toolCalls: [],
				});
			m.acts.verifyGoalAchievement.mockResolvedValue({
				achieved: true,
				confidence: 1,
				reasoning: "Report saved",
			});
			const result = await goalOrientedAgentWorkflow({
				...input,
				goal: "Write and save a report",
				maxIterations: 1,
			});
			expect(result.response).toBe("Final report");
			const verification = m.acts.verifyGoalAchievement.mock.calls[0][0];
			expect(verification.accumulatedResponse).toBe(
				candidate ? "Final report" : "Final report\n\n",
			);
			expect(verification.outputMode).toBe(
				candidate ? "candidate" : undefined,
			);
		},
	);

	it("verifies the latest deliverable, retains the trace, and replaces a rejected draft when replanning", async () => {
		m.turn.mockResolvedValue({
			success: true,
			response: "Step output",
			toolCalls: [],
		});
		m.acts.createGoalOrientedPlan.mockResolvedValue({
			plan: {
				strategy: "sequential",
				steps: [
					{ id: "research", description: "Read sources", inputs: {} },
					{
						id: "deliver",
						description: "Produce the complete deliverable",
						inputs: {},
					},
				],
			},
			routingDecision: {},
		});
		for (const response of [
			"Research notes",
			"Rejected draft",
			"Updated research",
			"Final report",
		]) {
			m.acts.finishGoalStep.mockResolvedValueOnce({
				response,
				outputs: { rawResponse: response },
				toolCalls: [],
				variables: {
					[`step.${response}.response`]: {
						name: `step.${response}.response`,
						value: response,
						setBy: response,
						setAt: "2026-01-01",
						scope: "step",
					},
				},
			});
		}
		m.acts.verifyGoalAchievement
			.mockResolvedValueOnce({
				achieved: false,
				confidence: 1,
				reasoning: "Revise the draft",
			})
			.mockResolvedValueOnce({
				achieved: true,
				confidence: 1,
				reasoning: "Complete",
			});
		const result = await goalOrientedAgentWorkflow({
			...input,
			goal: "Write a complete report",
			maxIterations: 2,
		});
		expect(
			m.acts.verifyGoalAchievement.mock.calls.map(
				([value]) => value.accumulatedResponse,
			),
		).toEqual(["Rejected draft", "Final report"]);
		expect(result).toMatchObject({
			status: "COMPLETED",
			goalAchieved: true,
			response: "Final report",
			iterationsUsed: 2,
		});
		expect(
			m.acts.verifyGoalAchievement.mock.calls[1][0].variables,
		).not.toHaveProperty("step.Rejected draft.response");
		expect(m.acts.verifyGoalAchievement.mock.calls[1][0]).toMatchObject({
			outputMode: "candidate",
		});
		expect(m.acts.completeDurableGoalProjection).toHaveBeenCalledWith(
			expect.objectContaining({
				output: expect.objectContaining({
					response: "Final report",
					trajectorySteps: expect.arrayContaining([
						expect.objectContaining({
							output: { rawResponse: "Rejected draft" },
						}),
					]),
				}),
			}),
		);
		expect(result.stepsExecuted).toHaveLength(4);
		expect(result.output?.trajectorySteps).toHaveLength(4);
	});
	it("records failure when the goal limit is reached without an achieved goal", async () => {
		m.turn.mockResolvedValue({
			success: true,
			response: "Incomplete draft",
			toolCalls: [],
		});
		m.acts.finishGoalStep.mockResolvedValue({
			response: "Incomplete draft",
			outputs: {},
			toolCalls: [],
		});
		m.acts.verifyGoalAchievement.mockResolvedValue({
			achieved: false,
			confidence: 1,
			reasoning: "Missing required evidence",
		});
		const result = await goalOrientedAgentWorkflow({
			...input,
			goal: "Produce verified evidence",
			maxIterations: 1,
		});
		expect(result).toMatchObject({
			status: "MAX_ITERATIONS_REACHED",
			goalAchieved: false,
		});
		expect(m.acts.completeDurableGoalProjection).toHaveBeenCalledWith(
			expect.objectContaining({
				status: "FAILED",
				goalAchieved: false,
				error: "Goal not achieved after 1 iterations",
			}),
		);
	});
	it("uses durable steps for markerless supervisor work and releases the parent after an inspection stop", async () => {
		const result = await deploymentExecutionWorkflow({
			...input,
			supervisorWorkflowId: "example-supervisor",
		});
		expect(result.status).toBe("FAILED");
		expect(result.output).toMatchObject({
			inspectionRequired: true,
			toolCalls: [{ status: "pending" }],
		});
		expect(
			m.acts.registerNativeAgentExecutionReceipt,
		).not.toHaveBeenCalled();
		expect(m.turn).toHaveBeenCalledTimes(1);
		expect(m.acts.invokeDeploymentAgent).not.toHaveBeenCalled();
		expect(
			m.acts.completeDurableDeploymentProjection,
		).toHaveBeenCalledTimes(1);
		expect(m.externalSignal).toHaveBeenCalledWith("executionCompleted", {
			executionId: "example-execution",
			success: false,
		});
		expect(m.acts.signalSupervisorCompletion).not.toHaveBeenCalled();
		expect(m.externalSignal.mock.invocationCallOrder[0]).toBeGreaterThan(
			m.acts.completeDurableDeploymentProjection.mock
				.invocationCallOrder[0],
		);
	});
	it("retains a completed outcome when its Temporal-native parent signal is refused", async () => {
		m.turn.mockResolvedValue({
			success: true,
			response: "Example complete",
			toolCalls: [],
		});
		m.acts.finishDeploymentAgentTurn.mockResolvedValue({
			output: { response: "Example complete" },
			toolCalls: [],
		});
		m.externalSignal.mockRejectedValue(
			new Error("Example parent is closed"),
		);
		const result = await deploymentExecutionWorkflow({
			...input,
			supervisorWorkflowId: "example-parent",
		});
		expect(result.status).toBe("COMPLETED");
		expect(
			m.acts.completeDurableDeploymentProjection,
		).toHaveBeenCalledTimes(1);
		expect(m.acts.completeDurableDeploymentProjection).toHaveBeenCalledWith(
			expect.objectContaining({ status: "COMPLETED" }),
		);
		expect(m.acts.completeExecution).not.toHaveBeenCalled();
		expect(m.externalSignal).toHaveBeenCalledTimes(1);
	});
	it("retains earlier goal responses and completed steps when a later durable turn stops", async () => {
		m.acts.createGoalOrientedPlan.mockResolvedValue({
			plan: {
				strategy: "sequential",
				steps: [
					{ id: "example-first", description: "First", inputs: {} },
					{ id: "example-second", description: "Second", inputs: {} },
				],
			},
			routingDecision: {},
		});
		m.turn
			.mockResolvedValueOnce({
				success: true,
				response: "Earlier useful result",
				toolCalls: [],
			})
			.mockResolvedValueOnce(failedTurn());
		m.acts.finishGoalStep.mockResolvedValue({
			response: "Earlier useful result",
			outputs: {},
			toolCalls: [],
		});
		const result = await goalOrientedAgentWorkflow({
			...input,
			goal: "Produce answer",
			maxIterations: 1,
		});
		expect(result.output).toMatchObject({
			response: "Earlier useful result\n\nA tool step stopped",
			stepsExecuted: [{ id: "example-first", status: "completed" }],
			toolCalls: [{ status: "pending" }],
			inspectionRequired: true,
		});
		expect(m.acts.completeDurableGoalProjection).toHaveBeenCalledWith(
			expect.objectContaining({
				output: result.output,
				status: "FAILED",
			}),
		);
		expect(m.acts.attemptStepRecovery).not.toHaveBeenCalled();
	});
	it.each(["deployment", "goal"])(
		"projects %s cancellation with acknowledged and ambiguous partial effects retained",
		async (kind) => {
			const acknowledged = {
				id: "example-acknowledged",
				name: "example_write",
				args: {},
				result: { created: true },
				status: "success",
				durationMs: 1,
			};
			const ambiguous = failedTurn().toolCalls[0];
			m.turn.mockImplementationOnce(async (_input, options) => {
				expect(typeof options.isCancelled).toBe("function");
				return {
					...failedTurn(),
					cancelled: true,
					response: "Partial response",
					toolCalls: [acknowledged, ambiguous],
				};
			});
			const result =
				kind === "deployment"
					? await deploymentExecutionWorkflow({
							...input,
							supervisorWorkflowId: "example-parent",
						})
					: await goalOrientedAgentWorkflow({
							...input,
							goal: "Example",
							maxIterations: 1,
						});
			expect(result.status).toBe("CANCELLED");
			expect(result.output).toMatchObject({
				cancelled: true,
				response: "Partial response",
				inspectionRequired: true,
				toolCalls: [acknowledged, ambiguous],
			});
			const writer =
				kind === "deployment"
					? m.acts.completeDurableDeploymentProjection
					: m.acts.completeDurableGoalProjection;
			expect(writer).toHaveBeenCalledWith(
				expect.objectContaining({
					status: "CANCELLED",
					output: result.output,
				}),
			);
			expect(m.acts.attemptStepRecovery).not.toHaveBeenCalled();
			expect(m.acts.verifyGoalAchievement).not.toHaveBeenCalled();
			if (kind === "deployment")
				expect(m.externalSignal).toHaveBeenCalledWith(
					"executionCompleted",
					{ executionId: "example-execution", success: false },
				);
		},
	);
	it("returns the same combined goal token usage that cancellation persists, including earlier steps", async () => {
		m.acts.createGoalOrientedPlan.mockResolvedValue({
			plan: {
				strategy: "sequential",
				steps: [
					{ id: "example-first", description: "First", inputs: {} },
					{ id: "example-second", description: "Second", inputs: {} },
				],
			},
			routingDecision: {},
		});
		m.turn
			.mockResolvedValueOnce({
				success: true,
				response: "Earlier result",
				toolCalls: [],
				tokenUsage: { inputTokens: 3, outputTokens: 4 },
			})
			.mockResolvedValueOnce({
				...failedTurn(),
				cancelled: true,
				response: "Partial result",
				tokenUsage: { inputTokens: 5, outputTokens: 6 },
			});
		m.acts.finishGoalStep.mockResolvedValue({
			response: "Earlier result",
			outputs: {},
			toolCalls: [],
			tokenUsage: { inputTokens: 3, outputTokens: 4 },
		});
		const result = await goalOrientedAgentWorkflow({
			...input,
			goal: "Example",
			maxIterations: 1,
		});
		expect(result.status).toBe("CANCELLED");
		expect(result.tokenUsage).toEqual({ inputTokens: 8, outputTokens: 10 });
		expect(m.acts.completeDurableGoalProjection).toHaveBeenCalledWith(
			expect.objectContaining({
				status: "CANCELLED",
				tokenUsage: result.tokenUsage,
			}),
		);
	});
	it("does not enter the legacy failure writer after a durable terminal projection refusal", async () => {
		const failure = new Error("Example terminal projection refusal");
		m.acts.completeDurableDeploymentProjection.mockRejectedValue(failure);
		await expect(deploymentExecutionWorkflow(input)).rejects.toBe(failure);
		expect(
			m.acts.completeDurableDeploymentProjection,
		).toHaveBeenCalledTimes(1);
		expect(m.acts.completeExecution).not.toHaveBeenCalled();
		expect(m.turn).toHaveBeenCalledTimes(1);
	});
	it("stops a markerless goal after an uncertain effect without replanning or whole-step recovery", async () => {
		const result = await goalOrientedAgentWorkflow({
			...input,
			goal: "Produce answer",
			maxIterations: 2,
		});
		expect(result.status).toBe("FAILED");
		expect(result.output).toMatchObject({ inspectionRequired: true });
		expect(m.turn).toHaveBeenCalledTimes(1);
		expect(m.acts.executeGoalStep).not.toHaveBeenCalled();
		expect(m.acts.attemptStepRecovery).not.toHaveBeenCalled();
		expect(m.acts.verifyGoalAchievement).not.toHaveBeenCalled();
		expect(m.acts.createGoalOrientedPlan).toHaveBeenCalledTimes(1);
		expect(m.acts.completeDurableGoalProjection).toHaveBeenCalledTimes(1);
		expect(m.turn.mock.calls[0][1]).toMatchObject({
			effectScope: "goal:1:example-step",
		});
	});
	it.each(["deployment", "goal"])(
		"labels a known predispatch %s refusal without claiming an unknown external write",
		async (kind) => {
			m.turn.mockResolvedValue(failedTurn(false));
			const result =
				kind === "deployment"
					? await deploymentExecutionWorkflow(input)
					: await goalOrientedAgentWorkflow({
							...input,
							goal: "Produce answer",
							maxIterations: 2,
						});
			expect(result.status).toBe("FAILED");
			expect(result.output).toMatchObject({ inspectionRequired: false });
		},
	);
	it.each([
		[
			"deployment",
			"MCP isError",
			{
				isError: true,
				content: [{ type: "text", text: "Example tool error" }],
			},
		],
		[
			"goal",
			"MCP isError",
			{
				isError: true,
				content: [{ type: "text", text: "Example tool error" }],
			},
		],
		[
			"deployment",
			"oversized output",
			{ outputOmitted: true, error: "Example output omitted" },
		],
		[
			"goal",
			"oversized output",
			{ outputOmitted: true, error: "Example output omitted" },
		],
		[
			"deployment",
			"acknowledged error",
			{ success: false, error: "Example dispatched tool error" },
		],
		[
			"goal",
			"acknowledged error",
			{ success: false, error: "Example dispatched tool error" },
		],
	] as const)(
		"preserves top-level inspection for %s %s in the terminal output and projection",
		async (kind, _label, toolResult) => {
			const turn = failedTurn();
			const call = {
				...turn.toolCalls[0],
				status: "error",
				inspectionRequired: true,
				result: toolResult,
			};
			m.turn.mockResolvedValue({ ...turn, toolCalls: [call] });
			const result =
				kind === "deployment"
					? await deploymentExecutionWorkflow(input)
					: await goalOrientedAgentWorkflow({
							...input,
							goal: "Produce answer",
							maxIterations: 2,
						});
			expect(result.status).toBe("FAILED");
			expect(result.output).toMatchObject({
				inspectionRequired: true,
				toolCalls: [
					{
						status: "error",
						inspectionRequired: true,
						result: toolResult,
					},
				],
			});
			const writer =
				kind === "deployment"
					? m.acts.completeDurableDeploymentProjection
					: m.acts.completeDurableGoalProjection;
			expect(writer).toHaveBeenCalledWith(
				expect.objectContaining({
					status: "FAILED",
					output: expect.objectContaining({
						inspectionRequired: true,
					}),
				}),
			);
			expect(m.turn).toHaveBeenCalledTimes(1);
			expect(m.acts.attemptStepRecovery).not.toHaveBeenCalled();
		},
	);
	it("refuses new native entrypoints without a server admission marker before any Activity", async () => {
		await expect(
			nativeDeploymentExecutionWorkflow(input),
		).rejects.toMatchObject({
			type: "NATIVE_AGENT_ADMISSION_REQUIRED",
			nonRetryable: true,
		});
		await expect(
			nativeGoalOrientedAgentWorkflow({ ...input, goal: "Example" }),
		).rejects.toMatchObject({
			type: "NATIVE_AGENT_ADMISSION_REQUIRED",
			nonRetryable: true,
		});
		expect(m.acts.loadDeploymentConfiguration).not.toHaveBeenCalled();
		expect(m.turn).not.toHaveBeenCalled();
	});
});

it.each(["deployment", "goal"])(
	"projects an early %s cancellation without model work",
	async (kind) => {
		m.cancelAtPatch = true;
		const result =
			kind === "deployment"
				? await deploymentExecutionWorkflow(input)
				: await goalOrientedAgentWorkflow({
						...input,
						goal: "Example",
					});
		expect(result.status).toBe("CANCELLED");
		expect(m.turn).not.toHaveBeenCalled();
		const writer =
			kind === "deployment"
				? m.acts.completeDurableDeploymentProjection
				: m.acts.completeDurableGoalProjection;
		expect(writer).toHaveBeenCalledWith(
			expect.objectContaining({ status: "CANCELLED" }),
		);
	},
);
