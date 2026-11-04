import { jsonSchema } from "@repo/ai";
import { getDispatchGuard } from "@repo/utils/dispatch-guard";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const m = vi.hoisted(() => ({
	organization: vi.fn(),
	execution: vi.fn(),
	scoped: vi.fn(),
	execute: vi.fn(),
	turn: vi.fn(),
	access: vi.fn(),
	allowed: vi.fn(),
	deleted: vi.fn(),
	project: vi.fn(),
	info: {
		attempt: 1,
		workflowExecution: {
			workflowId: "example-workflow",
			runId: "example-run",
		},
		activityId: "saved-agent:example-workflow:turn:0:example-call",
		workflowType: "nativeDeploymentExecutionWorkflow",
	},
	tools: {} as Record<string, unknown>,
}));
vi.mock("@repo/database", async (original) => ({
	...(await original<typeof import("@repo/database")>()),
	db: {
		organization: { findFirst: m.organization },
		agentDeploymentExecution: { findFirst: m.execution },
	},
	getAgentTemplateInstanceForExecution: m.scoped,
	canExecuteOrganizationAgents: m.allowed,
	hasProjectAccess: m.access,
	isProjectSoftDeleted: m.deleted,
}));
vi.mock("@repo/rag/lib/context-quality/project-access", () => ({
	resolveEffectiveProjectPermissions: m.project,
}));
vi.mock("@temporalio/activity", () => ({
	Context: {
		current: () => ({
			info: m.info,
			cancellationSignal: new AbortController().signal,
		}),
	},
	heartbeat: vi.fn(),
}));
vi.mock("../agent-execution-core/agent-executor", () => ({
	executeAgentTurn: m.turn,
	isErrorResult: (v: unknown) => v == null,
}));
vi.mock("../../lib/redis-publisher", () => ({
	publishExecutionEvent: vi.fn(async () => {}),
}));

import {
	executeSavedAgentModelStep,
	executeSavedAgentToolStep,
} from "../agent-execution-core/durable-steps";
import { prepareAgentTools } from "../shared/agent-tool-runtime";

const turn = {
	executionId: "example-execution",
	systemPrompt: "Saved prompt",
	userMessage: "Task",
	userId: "example-user",
	organizationId: "example-org",
	projectId: "example-project",
	agentInstanceId: "example-instance",
};
const tool = {
	...turn,
	stepIndex: 0,
	decision: {
		id: "example-call",
		name: "get_item",
		args: { id: "example-item" },
		source: { configId: "example-config", originalName: "get_item" },
	},
	effectId: "saved-agent:example-workflow:turn:0:example-call",
};
beforeEach(() => {
	vi.resetAllMocks();
	m.info.attempt = 1;
	m.info.activityId = tool.effectId;
	m.organization.mockResolvedValue({ id: turn.organizationId });
	m.execution.mockResolvedValue({
		metadata: null,
		status: "RUNNING",
		workflowId: "example-workflow",
		runId: null,
		deployment: {
			instanceId: turn.agentInstanceId,
			userId: turn.userId,
			organizationId: turn.organizationId,
		},
	});
	m.scoped.mockResolvedValue({
		instance: { status: "ACTIVE" },
		projectId: turn.projectId,
	});
	m.allowed.mockResolvedValue(true);
	m.access.mockResolvedValue(true);
	m.deleted.mockResolvedValue(false);
	m.project.mockResolvedValue({
		organizationId: turn.organizationId,
		permissions: ["context:read"],
	});
	m.execute.mockResolvedValue({ id: "example-result" });
	m.tools = {
		get_item: {
			inputSchema: z.object({ id: z.string() }),
			execute: m.execute,
		},
		other_tool: { inputSchema: z.object({}), execute: vi.fn() },
	};
	m.turn.mockImplementation(async () => {
		try {
			return {
				response: await prepareAgentTools(m.tools, {
					get_item: {
						configId: "example-config",
						originalName: "get_item",
					},
				}),
				toolCalls: [],
				success: true,
			};
		} catch {
			return { response: "", toolCalls: [], success: false };
		}
	});
});
describe("isolated saved-agent durable activities", () => {
	const executionWithDeploymentStatus = (status: string) => ({
		metadata: null,
		status: "RUNNING",
		workflowId: "example-workflow",
		runId: null,
		deployment: {
			status,
			instanceId: turn.agentInstanceId,
			userId: turn.userId,
			organizationId: turn.organizationId,
		},
	});
	it.each(["model", "tool"])(
		"refuses a terminated deployment before %s dispatch",
		async (kind) => {
			m.execution.mockResolvedValue(
				executionWithDeploymentStatus("TERMINATED"),
			);
			await expect(
				kind === "model"
					? executeSavedAgentModelStep({
							...turn,
							stepIndex: 0,
							continuationMessages: [],
						})
					: executeSavedAgentToolStep(tool),
			).rejects.toMatchObject({
				type: "SAVED_AGENT_STEP_FORBIDDEN",
				nonRetryable: true,
			});
			expect(m.turn).not.toHaveBeenCalled();
			expect(m.execute).not.toHaveBeenCalled();
		},
	);
	it("refuses termination at the factory physical-request gate after asynchronous preparation", async () => {
		m.execution
			.mockResolvedValueOnce(executionWithDeploymentStatus("ACTIVE"))
			.mockResolvedValue(executionWithDeploymentStatus("TERMINATED"));
		m.turn.mockImplementation(async () => {
			await getDispatchGuard()?.assertDispatchable();
			throw Error("Provider must not be reached");
		});
		await expect(
			executeSavedAgentModelStep({
				...turn,
				stepIndex: 0,
				continuationMessages: [],
			}),
		).rejects.toMatchObject({ type: "SAVED_AGENT_STEP_FORBIDDEN" });
		expect(m.execute).not.toHaveBeenCalled();
	});
	it("permits already accepted work to finish when the deployment is paused", async () => {
		m.execution.mockResolvedValue(executionWithDeploymentStatus("PAUSED"));
		expect(await executeSavedAgentToolStep(tool)).toMatchObject({
			status: "success",
		});
		expect(m.execute).toHaveBeenCalledTimes(1);
	});
	it("executes only the recorded tool with stable correlation and current schema", async () => {
		expect(await executeSavedAgentToolStep(tool)).toMatchObject({
			id: "example-call",
			name: "get_item",
			status: "success",
			result: { id: "example-result" },
			effectId: tool.effectId,
		});
		expect(m.execute).toHaveBeenCalledTimes(1);
		expect(m.execute).toHaveBeenCalledWith(
			{ id: "example-item" },
			expect.objectContaining({ toolCallId: tool.effectId }),
		);
		expect(m.scoped).toHaveBeenCalledTimes(3);
	});
	it("validates JSON-schema MCP tools as well as native Zod tools", async () => {
		m.tools.get_item = {
			inputSchema: jsonSchema({
				type: "object",
				properties: { id: { type: "string" } },
				required: ["id"],
				additionalProperties: false,
			}),
			execute: m.execute,
		};
		expect(await executeSavedAgentToolStep(tool)).toHaveProperty(
			"status",
			"success",
		);
	});
	it.each([2, 3])(
		"refuses activity attempt %s before dispatch",
		async (attempt) => {
			m.info.attempt = attempt;
			await expect(executeSavedAgentToolStep(tool)).rejects.toMatchObject(
				{
					type: "SAVED_AGENT_TOOL_INSPECTION_REQUIRED",
					nonRetryable: true,
				},
			);
			expect(m.turn).not.toHaveBeenCalled();
			expect(m.execute).not.toHaveBeenCalled();
		},
	);
	it("binds effect identity to logical workflow, decision and activity ID", async () => {
		await expect(
			executeSavedAgentToolStep({ ...tool, effectId: "example-forged" }),
		).rejects.toMatchObject({ type: "SAVED_AGENT_MODEL_INVALID_DECISION" });
		expect(m.turn).not.toHaveBeenCalled();
	});
	it("refuses current instance or project revocation before model dispatch", async () => {
		m.scoped.mockResolvedValue(null);
		await expect(
			executeSavedAgentModelStep({
				...turn,
				stepIndex: 0,
				continuationMessages: [],
			}),
		).rejects.toMatchObject({ type: "SAVED_AGENT_STEP_FORBIDDEN" });
		expect(m.turn).not.toHaveBeenCalled();
	});
	it("rechecks current grants after asynchronous tool preparation", async () => {
		m.scoped
			.mockResolvedValueOnce({
				instance: { status: "ACTIVE" },
				projectId: turn.projectId,
			})
			.mockResolvedValue(null);
		await expect(executeSavedAgentToolStep(tool)).rejects.toMatchObject({
			type: "SAVED_AGENT_TOOL_REFUSED",
		});
		expect(m.execute).not.toHaveBeenCalled();
	});
	it("does not execute persisted arguments that no longer satisfy the current schema", async () => {
		m.tools.get_item = {
			inputSchema: z.object({ id: z.literal("different-id") }),
			execute: m.execute,
		};
		await expect(executeSavedAgentToolStep(tool)).rejects.toMatchObject({
			type: "SAVED_AGENT_TOOL_REFUSED",
		});
		expect(m.execute).not.toHaveBeenCalled();
	});
	it("refuses a same-named tool from a different enabled MCP source before dispatch", async () => {
		await expect(
			executeSavedAgentToolStep({
				...tool,
				decision: {
					...tool.decision,
					source: {
						configId: "example-other-config",
						originalName: "get_item",
					},
				},
			}),
		).rejects.toMatchObject({ type: "SAVED_AGENT_TOOL_REFUSED" });
		expect(m.execute).not.toHaveBeenCalled();
	});
	it("never retries a thrown external call and reports ambiguous completion", async () => {
		m.execute.mockRejectedValue(
			new Error("example transport lost acknowledgement"),
		);
		await expect(executeSavedAgentToolStep(tool)).rejects.toMatchObject({
			type: "SAVED_AGENT_TOOL_INSPECTION_REQUIRED",
		});
		expect(m.execute).toHaveBeenCalledTimes(1);
		expect(m.turn).toHaveBeenCalledTimes(1);
	});
	it("returns an explicit bounded inspection-required receipt when output is oversized", async () => {
		m.execute.mockResolvedValue({ text: "x".repeat(100000) });
		const result = await executeSavedAgentToolStep(tool);
		expect(result).toMatchObject({
			status: "error",
			inspectionRequired: true,
			result: { outputOmitted: true },
		});
		expect(JSON.stringify(result).length).toBeLessThan(2000);
		expect(m.execute).toHaveBeenCalledTimes(1);
	});
	it.each([
		{ authorityRequired: true },
		{
			isError: true,
			content: [
				{ type: "text", text: "Example external acknowledgement lost" },
			],
		},
		{ error: "Example request failed" },
	])(
		"marks authority and MCP error results inspection-required with one dispatch: %j",
		async (result) => {
			m.execute.mockResolvedValue(result);
			expect(await executeSavedAgentToolStep(tool)).toMatchObject({
				status: "error",
				inspectionRequired: true,
			});
			expect(m.execute).toHaveBeenCalledTimes(1);
		},
	);
	it("refuses a conflicting stored run or execution owner before a model or tool dispatch", async () => {
		m.execution.mockResolvedValue({
			metadata: null,
			status: "RUNNING",
			workflowId: "example-workflow",
			runId: "example-other-run",
			deployment: {
				instanceId: turn.agentInstanceId,
				userId: turn.userId,
				organizationId: turn.organizationId,
			},
		});
		await expect(
			executeSavedAgentModelStep({
				...turn,
				stepIndex: 0,
				continuationMessages: [],
			}),
		).rejects.toMatchObject({ type: "SAVED_AGENT_STEP_FORBIDDEN" });
		expect(m.turn).not.toHaveBeenCalled();
	});
	it("rechecks permission at the factory physical-request gate after tool preparation", async () => {
		m.turn.mockImplementation(async () => {
			const guard = getDispatchGuard();
			expect(guard).toBeDefined();
			await guard?.assertDispatchable();
			throw new Error("Provider must not be reached");
		});
		m.project
			.mockResolvedValueOnce({
				organizationId: turn.organizationId,
				permissions: ["context:read"],
			})
			.mockResolvedValue({
				organizationId: turn.organizationId,
				permissions: [],
			});
		await expect(
			executeSavedAgentModelStep({
				...turn,
				stepIndex: 0,
				continuationMessages: [],
			}),
		).rejects.toMatchObject({ type: "SAVED_AGENT_STEP_FORBIDDEN" });
	});
	it("records a model decision only after a post-read current access check", async () => {
		m.turn.mockResolvedValue({
			success: true,
			response: "Exact",
			toolCalls: [],
			modelStep: {
				messages: [{ role: "assistant", content: "Exact" }],
				toolCalls: [],
			},
		});
		m.project
			.mockResolvedValueOnce({
				organizationId: turn.organizationId,
				permissions: ["context:read"],
			})
			.mockResolvedValue({
				organizationId: turn.organizationId,
				permissions: [],
			});
		await expect(
			executeSavedAgentModelStep({
				...turn,
				stepIndex: 0,
				continuationMessages: [],
			}),
		).rejects.toMatchObject({ type: "SAVED_AGENT_STEP_FORBIDDEN" });
		expect(m.turn).toHaveBeenCalledTimes(1);
	});
});
