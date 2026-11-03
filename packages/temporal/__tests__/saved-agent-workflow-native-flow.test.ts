import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	turn: vi.fn(),
	externalSignal: vi.fn(),
	cancelAtPatch: false,
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
	patched: () => {
		if (m.cancelAtPatch) {
			m.cancelHook?.();
		}
		return true;
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
