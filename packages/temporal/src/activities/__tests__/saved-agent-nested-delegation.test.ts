import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	turn: vi.fn(),
	generate: vi.fn(),
	registered: vi.fn(),
	scope: vi.fn(),
	unselected: vi.fn(),
	parentTools: {} as Record<string, unknown>,
	depth: 0,
}));
vi.mock("@repo/agent-core", () => ({
	globalAgentRegistry: { get: () => undefined },
}));
vi.mock("@repo/ai", async (original) => ({
	...(await original<typeof import("@repo/ai")>()),
	getAIModelWithMetadata: vi.fn(async () => ({
		model: {},
		metadata: { provider: "openai", modelString: "example-model" },
	})),
}));
vi.mock("ai", async (original) => ({
	...(await original<typeof import("ai")>()),
	generateText: m.generate,
}));
vi.mock("@repo/database", async (original) => ({
	...(await original<typeof import("@repo/database")>()),
	db: {
		organization: { findFirst: vi.fn(async () => ({ id: "example-org" })) },
		agentDeploymentExecution: {
			findFirst: vi.fn(async () => ({
				metadata: null,
				status: "RUNNING",
				workflowId: "example-workflow",
				runId: null,
				deployment: {
					instanceId: "example-parent",
					userId: "example-user",
					organizationId: "example-org",
				},
			})),
		},
		registeredAgent: { findFirst: m.registered },
	},
	getAgentTemplateInstanceForExecution: m.scope,
	hasProjectAccess: vi.fn(async () => true),
	isProjectSoftDeleted: vi.fn(async () => false),
}));
vi.mock("@repo/rag/lib/context-quality/project-access", () => ({
	resolveEffectiveProjectPermissions: vi.fn(async () => ({
		organizationId: "example-org",
		permissions: ["context:read"],
	})),
}));
vi.mock("@temporalio/activity", () => ({
	Context: {
		current: () => ({
			info: {
				attempt: 1,
				workflowExecution: {
					workflowId: "example-workflow",
					runId: "example-run",
				},
				workflowType: "deploymentExecutionWorkflow",
				activityId: "saved-agent:example-workflow:turn:0:example-call",
			},
			cancellationSignal: new AbortController().signal,
		}),
	},
	heartbeat: vi.fn(),
}));
vi.mock("../agent-execution-core/agent-executor", () => ({
	executeAgentTurn: m.turn,
	isErrorResult: (value: unknown) => value == null,
}));
vi.mock("../agent-execution-core", () => ({
	loadMcpToolsForAgent: vi.fn(async () => {
		throw new Error("Unexpected child MCP grant");
	}),
}));
vi.mock("../../lib/redis-publisher", () => ({
	publishExecutionEvent: vi.fn(async () => {}),
}));

import { executeSavedAgentToolStep } from "../agent-execution-core/durable-steps";
import { createRunAgentTool } from "../agentic-loop/run-agent";
import {
	agentToolAbortSignal,
	agentToolProjectScope,
	prepareAgentTools,
} from "../shared/agent-tool-runtime";

const input = {
	systemPrompt: "Parent saved prompt",
	userMessage: "Delegate selected work",
	executionId: "example-execution",
	userId: "example-user",
	organizationId: "example-org",
	projectId: "example-project",
	agentInstanceId: "example-parent",
	workspaceIds: [],
	workspaceDocumentFilters: [],
	stepIndex: 0,
	effectId: "saved-agent:example-workflow:turn:0:example-call",
	decision: {
		id: "example-call",
		name: "run_agent",
		source: { configId: "builtin", originalName: "run_agent" },
		args: {
			agentId: "example-child",
			goal: "Example delegated goal",
			mode: "delegate",
		},
	},
};
beforeEach(() => {
	vi.resetAllMocks();
	m.scope.mockResolvedValue({
		instance: { status: "ACTIVE" },
		projectId: input.projectId,
	});
	m.registered.mockImplementation(async ({ where }) =>
		where.id === "example-forbidden"
			? null
			: {
					id: where.id,
					name: where.id,
					displayName: "Example agent",
					config: { instructions: where.id },
				},
	);
	m.parentTools = {
		run_agent: createRunAgentTool(
			input.agentInstanceId,
			0,
			input.userId,
			input.organizationId,
			[],
		),
		unselected_write: { inputSchema: {}, execute: m.unselected },
	};
	m.turn.mockImplementation(async () => {
		try {
			return {
				success: true,
				response: await prepareAgentTools(m.parentTools, {
					run_agent: {
						configId: "builtin",
						originalName: "run_agent",
					},
				}),
				toolCalls: [],
			};
		} catch {
			return { success: false, response: "", toolCalls: [] };
		}
	});
	m.generate.mockImplementation(async (request) => {
		expect(agentToolProjectScope()).toEqual({
			projectId: input.projectId,
			userId: input.userId,
			organizationId: input.organizationId,
		});
		expect(agentToolAbortSignal()).toBeDefined();
		expect(Object.keys(request.tools)).toEqual(["run_agent"]);
		if (request.instructions.startsWith("example-child")) {
			const result = await request.tools.run_agent.execute({
				agentId: "example-grandchild",
				goal: "Example nested lookup",
				mode: "inline",
			});
			expect(result.success).toBe(true);
		}
		return {
			text: "EXAMPLE_NESTED_DELEGATION_VERIFIED",
			usage: { inputTokens: 1, outputTokens: 2 },
			steps: [],
		};
	});
});
describe("durable selected run_agent preparation boundary", () => {
	it("executes real child and grandchild delegation without re-entering the parent's selected-tool hook", async () => {
		const result = await executeSavedAgentToolStep(input);
		expect(result).toMatchObject({
			status: "success",
			result: {
				success: true,
				result: "EXAMPLE_NESTED_DELEGATION_VERIFIED",
			},
		});
		expect(m.turn).toHaveBeenCalledTimes(1);
		expect(m.generate).toHaveBeenCalledTimes(2);
		expect(m.registered).toHaveBeenCalledTimes(2);
		expect(m.unselected).not.toHaveBeenCalled();
		for (const [{ where }] of m.registered.mock.calls)
			expect(where.OR).toEqual([
				{ scope: "SYSTEM", organizationId: null },
				{ scope: "USER", userId: input.userId },
				{ scope: "ORGANIZATION", organizationId: input.organizationId },
			]);
	});
	it("retains current parent authority at nested tool invocation", async () => {
		m.generate.mockImplementation(async (request) => {
			m.scope.mockResolvedValue(null);
			await request.tools.run_agent.execute({
				agentId: "example-grandchild",
				goal: "Example denied nested work",
				mode: "inline",
			});
			throw Error("Nested dispatch must be refused");
		});
		await expect(executeSavedAgentToolStep(input)).rejects.toMatchObject({
			type: "SAVED_AGENT_TOOL_INSPECTION_REQUIRED",
		});
		expect(m.registered).toHaveBeenCalledTimes(1);
		expect(m.generate).toHaveBeenCalledTimes(1);
		expect(m.unselected).not.toHaveBeenCalled();
	});
	it("retains delegated agent accessibility checks", async () => {
		const result = await executeSavedAgentToolStep({
			...input,
			decision: {
				...input.decision,
				args: { ...input.decision.args, agentId: "example-forbidden" },
			},
		});
		expect(result).toMatchObject({
			status: "error",
			inspectionRequired: true,
		});
		expect(m.generate).not.toHaveBeenCalled();
		expect(m.unselected).not.toHaveBeenCalled();
	});
	it("retains the actual run_agent recursion-depth refusal", async () => {
		m.parentTools.run_agent = createRunAgentTool(
			input.agentInstanceId,
			4,
			input.userId,
			input.organizationId,
			[],
		);
		expect(await executeSavedAgentToolStep(input)).toMatchObject({
			status: "error",
			inspectionRequired: true,
		});
		expect(m.registered).not.toHaveBeenCalled();
		expect(m.generate).not.toHaveBeenCalled();
	});
});
