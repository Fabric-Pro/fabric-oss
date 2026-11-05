import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ turn: vi.fn(), update: vi.fn() }));
vi.mock("../agent-execution-core", async (original) => ({
	...(await original<typeof import("../agent-execution-core")>()),
	executeAgentTurn: m.turn,
}));
vi.mock("@repo/database", async (original) => ({
	...(await original<typeof import("@repo/database")>()),
	updateExecutionStatus: m.update,
}));

import {
	completeDurableDeploymentProjection,
	type ExecutionContext,
	finishDeploymentAgentTurn,
	invokeDeploymentAgent,
	prepareDeploymentAgentTurn,
} from "../deployment-execution";
import { completeDurableGoalProjection } from "../goal-oriented-agent/completion";
import {
	type ExecuteGoalStepInput,
	executeGoalStep,
	finishGoalStep,
	prepareGoalStep,
} from "../goal-oriented-agent/execution";

const context: ExecutionContext = {
	agentInstanceId: "example-instance",
	systemPrompt: "Exact saved instructions",
	model: "example-model",
	tools: [],
	knowledgeSources: [],
	integrationConfigurations: [
		{
			integrationId: "example-connection",
			integrationType: "EXAMPLE",
			allowedResources: { ids: ["example-resource"] },
		},
	],
	workspaceIds: ["example-workspace"],
	workspaceDocumentFilters: [
		{ workspaceId: "example-workspace", documentIds: ["example-document"] },
	],
	mcpConfigIds: ["example-mcp"],
	builtInToolNames: ["project-context"],
	projectId: "example-project",
};
const deployment = {
	executionId: "example-execution",
	context,
	input: { message: "Exact task", extra: "Exact additional input" },
	userId: "example-user",
	organizationId: "example-org",
	timeoutMs: 1000,
	conversationHistory: [{ role: "user" as const, content: "Exact history" }],
};
const goal: ExecuteGoalStepInput = {
	step: {
		id: "example-step",
		description: "Exact goal task",
		type: "agent",
		status: "pending",
		order: 0,
		inputs: { value: "Exact step input" },
	},
	systemPrompt: "Exact saved instructions",
	knowledgeContext: "Exact goal knowledge",
	variables: {},
	previousStepResults: [],
	userId: "example-user",
	organizationId: "example-org",
	mcpConfigIds: ["example-mcp"],
	workspaceIds: context.workspaceIds,
	workspaceDocumentFilters: context.workspaceDocumentFilters,
	executionId: "example-execution",
};
const result = {
	success: true,
	response: '```json\n{"delivered":true}\n```',
	toolCalls: [
		{
			id: "example-call",
			name: "example-image",
			args: {},
			result: { storagePath: "example/image.png", mimeType: "image/png" },
			status: "success" as const,
			durationMs: 1,
		},
	],
	tokenUsage: { inputTokens: 3, outputTokens: 5 },
};
beforeEach(() => {
	vi.clearAllMocks();
	m.turn.mockResolvedValue(result);
	m.update.mockResolvedValue({});
});
describe("saved agent preparation/result projection parity", () => {
	it("reuses identical prepared deployment prompt/model/context/tools/history and artifact result in the legacy executor", async () => {
		const prepared = await prepareDeploymentAgentTurn(deployment);
		expect(m.turn).not.toHaveBeenCalled();
		expect(prepared).toMatchObject({
			systemPrompt: context.systemPrompt,
			model: context.model,
			mcpConfigIds: context.mcpConfigIds,
			integrationConfigurations: context.integrationConfigurations,
			projectId: context.projectId,
			agentInstanceId: context.agentInstanceId,
			conversationHistory: deployment.conversationHistory,
			workspaceIds: context.workspaceIds,
			workspaceDocumentFilters: context.workspaceDocumentFilters,
		});
		expect(prepared.userMessage).toContain("Exact task");
		const expected = await finishDeploymentAgentTurn({
			executionId: deployment.executionId,
			result,
		});
		expect(expected.artifacts).toMatchObject([
			{ storagePath: "example/image.png" },
		]);
		expect(await invokeDeploymentAgent(deployment)).toEqual(expected);
		expect(m.turn).toHaveBeenCalledExactlyOnceWith(prepared);
	});
	it("reuses identical goal step instructions and structured output/variables without model work in prepare or finish", async () => {
		const prepared = await prepareGoalStep(goal);
		expect(prepared.userMessage).toContain(goal.step.description);
		expect(prepared.userMessage).toContain("Exact step input");
		expect(prepared.knowledgeContext).toBe(goal.knowledgeContext);
		expect(prepared.workspaceIds).toEqual(goal.workspaceIds);
		expect(prepared.workspaceDocumentFilters).toEqual(
			goal.workspaceDocumentFilters,
		);
		expect(m.turn).not.toHaveBeenCalled();
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
		try {
			const expected = await finishGoalStep({ step: goal.step, result });
			expect(expected.outputs).toMatchObject({ delivered: true });
			expect(await executeGoalStep(goal)).toEqual(expected);
			expect(m.turn).toHaveBeenCalledExactlyOnceWith(prepared);
		} finally {
			vi.useRealTimers();
		}
	});
	it.each(["deployment", "goal"])(
		"retains completed effects while only %s projection retries on storage errors",
		async (kind) => {
			const transient = Object.assign(
				new Error("Example storage unavailable"),
				{ code: "P1001" },
			);
			m.update.mockRejectedValueOnce(transient).mockResolvedValue({});
			const input = {
				executionId: "example-execution",
				status: "COMPLETED" as const,
				output: { response: "Example output" },
				durationMs: 1,
			};
			const project = () =>
				kind === "deployment"
					? completeDurableDeploymentProjection(input)
					: completeDurableGoalProjection({
							...input,
							goalAchieved: true,
						});
			await expect(project()).rejects.toBe(transient);
			await project();
			expect(m.update).toHaveBeenCalledTimes(2);
			expect(m.turn).not.toHaveBeenCalled();
		},
	);
	it.each(["deployment", "goal"])(
		"classifies only P2025 as a non-retryable missing-row %s projection",
		async (kind) => {
			m.update.mockRejectedValue(
				Object.assign(new Error("Example row missing"), {
					code: "P2025",
				}),
			);
			const input = {
				executionId: "example-execution",
				status: "FAILED" as const,
				durationMs: 1,
			};
			await expect(
				kind === "deployment"
					? completeDurableDeploymentProjection(input)
					: completeDurableGoalProjection({
							...input,
							goalAchieved: false,
						}),
			).rejects.toMatchObject({
				type: "SAVED_AGENT_EXECUTION_ROW_MISSING",
				nonRetryable: true,
			});
			expect(m.turn).not.toHaveBeenCalled();
		},
	);
});
