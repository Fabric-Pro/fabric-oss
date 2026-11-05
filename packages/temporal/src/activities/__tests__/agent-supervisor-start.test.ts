import { isDeepStrictEqual } from "node:util";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	read: vi.fn(),
	write: vi.fn(),
	deployment: vi.fn(),
	scope: vi.fn(),
	deploymentWrite: vi.fn(),
	quotaWrite: vi.fn(),
	transaction: vi.fn(),
	start: vi.fn(),
	describe: vi.fn(),
	create: vi.fn(),
	status: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	db: {
		agentDeploymentExecution: { findFirst: m.read, updateMany: m.write },
		$transaction: m.transaction,
	},
	getAgentDeploymentById: m.deployment,
	getAgentTemplateInstanceForExecution: m.scope,
	createAgentDeploymentExecution: m.create,
	updateExecutionStatus: m.status,
	cancelExecution: vi.fn(),
	updateDeploymentHealth: vi.fn(),
	updateDeploymentStatus: vi.fn(),
}));
vi.mock("../../client", () => ({
	getTemporalClient: async () => ({
		workflow: {
			start: m.start,
			getHandle: () => ({ describe: m.describe }),
		},
	}),
}));

import { startAgentExecution } from "../agent-supervisor";

const input = {
	workflowId: "agent-exec-example-execution",
	deploymentId: "example-deployment",
	instanceId: "example-instance",
	executionId: "example-execution",
	userId: "example-user",
	organizationId: "example-org",
	input: { message: "Example task" },
	triggerType: "MANUAL",
	timeoutMs: 60000,
};
function initialRow() {
	return {
		id: "example-row",
		executionId: "example-execution",
		deploymentId: "example-deployment",
		userId: "example-user",
		organizationId: "example-org",
		input: { message: "Example task" },
		triggerType: "MANUAL",
		triggerId: null as string | null,
		status: "PENDING",
		workflowId: null as string | null,
		runId: null as string | null,
		metadata: null as Record<string, unknown> | null,
		output: null as unknown,
	};
}
let row: ReturnType<typeof initialRow> | null;
let counters = { deployment: 0, quota: 0, current: 0 };
let remote: {
	runId: string;
	type: string;
	memo: Record<string, unknown>;
} | null;
let behavior = "normal";
let receiptFails = false;
const record = (value: unknown) => value as Record<string, unknown>;
function matches(where: Record<string, unknown>) {
	return (
		!!row &&
		Object.entries(where).every(([key, value]) =>
			isDeepStrictEqual(
				record(row)[key],
				key === "metadata" ? record(value).equals : value,
			),
		)
	);
}
beforeEach(() => {
	vi.clearAllMocks();
	row = initialRow();
	counters = { deployment: 0, quota: 0, current: 0 };
	remote = null;
	behavior = "normal";
	receiptFails = false;
	m.read.mockImplementation(
		async ({ where }: { where: Record<string, unknown> }) =>
			matches(where) ? structuredClone(row) : null,
	);
	m.write.mockImplementation(
		async ({
			where,
			data,
		}: {
			where: Record<string, unknown>;
			data: Record<string, unknown>;
		}) => {
			if (receiptFails && data.runId) {
				receiptFails = false;
				throw new Error("Receipt connection failed");
			}
			if (!matches(where)) {
				return { count: 0 };
			}
			if (!row) {
				throw new Error("Missing fixture row");
			}
			Object.assign(row, structuredClone(data));
			return { count: 1 };
		},
	);
	m.deployment.mockResolvedValue({
		id: "example-deployment",
		instanceId: "example-instance",
		userId: "example-user",
		organizationId: "example-org",
	});
	m.scope.mockResolvedValue({
		projectId: "example-project",
		instance: {
			id: "example-instance",
			organizationId: "example-org",
			customInstructions: {},
			executionMode: "single_turn",
			goal: null,
			successCriteria: null,
			maxIterations: 10,
		},
	});
	m.deploymentWrite.mockImplementation(
		async ({ data }: { data: Record<string, unknown> }) => {
			if (data.dailyExecutionCount) {
				counters.deployment++;
			}
			if (data.currentExecutions) {
				counters.current++;
			}
			return { count: 1 };
		},
	);
	m.quotaWrite.mockImplementation(async () => {
		counters.quota++;
		return { count: 1 };
	});
	m.transaction.mockImplementation(async (fn) => {
		const saved = structuredClone(row);
		const counts = { ...counters };
		try {
			return await fn({
				agentDeploymentExecution: {
					findFirst: m.read,
					updateMany: m.write,
				},
				agentDeployment: { updateMany: m.deploymentWrite },
				organizationDeploymentQuota: { updateMany: m.quotaWrite },
			});
		} catch (error) {
			row = saved;
			counters = counts;
			throw error;
		}
	});
	m.start.mockImplementation(
		async (type: string, options: { memo: Record<string, unknown> }) => {
			if (remote) {
				throw new Error("Already started");
			}
			remote = { runId: "example-real-run", type, memo: options.memo };
			if (behavior === "lost-response") {
				throw new Error("Response lost after acceptance");
			}
			if (behavior === "fast-completed" && row) {
				row.status = "COMPLETED";
				row.output = { summary: "Finished" };
			}
			return { firstExecutionRunId: remote.runId };
		},
	);
	m.describe.mockImplementation(async () => {
		if (!remote || behavior === "unavailable-description") {
			throw new Error("Receipt unavailable");
		}
		return structuredClone(remote);
	});
});
describe("supervisor receiver scoped execution reuse", () => {
	it("reuses a precreated row, stores the real stable receipt and charges once across activity retries", async () => {
		await expect(startAgentExecution(input)).resolves.toEqual({
			success: true,
			childWorkflowId: "deployment-exec-example-execution",
		});
		expect(row?.id).toBe("example-row");
		expect(row?.workflowId).toBe("deployment-exec-example-execution");
		expect(row?.runId).toBe("example-real-run");
		expect(m.start).toHaveBeenCalledWith(
			"deploymentExecutionWorkflow",
			expect.objectContaining({
				workflowId: "deployment-exec-example-execution",
				taskQueue: "agents",
				workflowIdReusePolicy: "REJECT_DUPLICATE",
				workflowIdConflictPolicy: "FAIL",
				args: [
					expect.objectContaining({
						executionId: "example-execution",
						organizationId: "example-org",
						instanceId: "example-instance",
					}),
				],
			}),
		);
		expect(await startAgentExecution(input)).toMatchObject({
			success: true,
		});
		expect(m.start).toHaveBeenCalledTimes(1);
		expect(m.create).not.toHaveBeenCalled();
		expect(counters).toEqual({ deployment: 1, quota: 1, current: 1 });
	});
	it("does not dispatch two physical workflows when activities race on the same precreated identity", async () => {
		const results = await Promise.all([
			startAgentExecution(input),
			startAgentExecution(input),
		]);
		expect(results.some((value) => value.success)).toBe(true);
		expect(m.start).toHaveBeenCalledTimes(1);
		expect(counters.deployment).toBe(1);
		expect(counters.quota).toBe(1);
		expect(m.create).not.toHaveBeenCalled();
	});
	it("reattaches a lost response using verified Temporal memo/type without a fresh run", async () => {
		behavior = "lost-response";
		expect(await startAgentExecution(input)).toMatchObject({
			success: true,
		});
		expect(m.describe).toHaveBeenCalledTimes(1);
		expect(m.start).toHaveBeenCalledTimes(1);
		expect(row?.runId).toBe("example-real-run");
		expect(counters.quota).toBe(1);
	});
	it("leaves uncertain starts pending and retries only receipt lookup, never another start or a false failure write", async () => {
		m.start.mockImplementation(
			async (
				type: string,
				options: { memo: Record<string, unknown> },
			) => {
				remote = {
					runId: "example-real-run",
					type,
					memo: options.memo,
				};
				throw new Error("Transport lost");
			},
		);
		behavior = "unavailable-description";
		await expect(startAgentExecution(input)).rejects.toBeInstanceOf(Error);
		expect(row?.status).toBe("PENDING");
		expect(counters).toEqual({ deployment: 0, quota: 0, current: 0 });
		expect(m.status).not.toHaveBeenCalled();
		behavior = "normal";
		expect(await startAgentExecution(input)).toMatchObject({
			success: true,
		});
		expect(m.start).toHaveBeenCalledTimes(1);
		expect(counters.quota).toBe(1);
	});
	it("does not start again when a durable attempted intent has no recoverable Temporal receipt", async () => {
		m.start.mockRejectedValue(new Error("Unknown start outcome"));
		await expect(startAgentExecution(input)).rejects.toBeInstanceOf(Error);
		await expect(startAgentExecution(input)).rejects.toBeInstanceOf(Error);
		expect(m.start).toHaveBeenCalledTimes(1);
		expect(m.status).not.toHaveBeenCalled();
		expect(counters.quota).toBe(0);
	});
	it("recovers a receipt persistence failure without charging or starting twice", async () => {
		receiptFails = true;
		await expect(startAgentExecution(input)).rejects.toBeInstanceOf(Error);
		expect(row?.status).toBe("PENDING");
		expect(counters.quota).toBe(0);
		expect(await startAgentExecution(input)).toMatchObject({
			success: true,
		});
		expect(m.start).toHaveBeenCalledTimes(1);
		expect(counters.quota).toBe(1);
	});
	it("preserves a worker's fast terminal output/status and does not add a running count", async () => {
		behavior = "fast-completed";
		expect(await startAgentExecution(input)).toMatchObject({
			success: true,
		});
		expect(row?.status).toBe("COMPLETED");
		expect(row?.output).toEqual({ summary: "Finished" });
		expect(counters).toEqual({ deployment: 1, quota: 1, current: 0 });
	});
	it("does not charge an execution already reserved by the saved-invocation admission transaction", async () => {
		if (!row) {
			throw new Error("Missing fixture row");
		}
		row.metadata = { fabricAdmission: { executionCountReserved: true } };
		counters = { deployment: 1, quota: 1, current: 0 };
		expect(await startAgentExecution(input)).toMatchObject({
			success: true,
		});
		expect(counters.deployment).toBe(1);
		expect(counters.quota).toBe(1);
	});
	it.each([
		{ userId: "other-user" },
		{ organizationId: "other-org" },
		{ deploymentId: "other-deployment" },
		{ input: { message: "Changed input" } },
		{ triggerType: "WEBHOOK" },
		{ triggerId: "other-trigger" },
	])(
		"refuses conflicting persisted identity/input/trigger %j without mutation",
		async (changed) => {
			if (!row) {
				throw new Error("Missing fixture row");
			}
			Object.assign(row, changed);
			await expect(startAgentExecution(input)).rejects.toMatchObject({
				type: "SUPERVISOR_EXECUTION_REFUSED",
				nonRetryable: true,
			});
			expect(m.write).not.toHaveBeenCalled();
			expect(m.start).not.toHaveBeenCalled();
			expect(m.status).not.toHaveBeenCalled();
		},
	);
	it("rejects a missing organization or unpersisted execution without fabricating a row", async () => {
		await expect(
			startAgentExecution({ ...input, organizationId: undefined }),
		).rejects.toMatchObject({
			type: "SUPERVISOR_EXECUTION_REFUSED",
			nonRetryable: true,
		});
		row = null;
		await expect(startAgentExecution(input)).rejects.toBeInstanceOf(Error);
		expect(m.create).not.toHaveBeenCalled();
		expect(m.start).not.toHaveBeenCalled();
	});
	it("checks current native instance/project rights before binding a child workflow", async () => {
		m.scope.mockResolvedValue(null);
		await expect(startAgentExecution(input)).rejects.toBeInstanceOf(Error);
		expect(m.write).not.toHaveBeenCalled();
		expect(m.start).not.toHaveBeenCalled();
	});
	it("rejects a mismatching existing Temporal memo rather than attaching an unrelated workflow", async () => {
		m.start.mockImplementation(
			async (
				type: string,
				options: { memo: Record<string, unknown> },
			) => {
				const memo = structuredClone(options.memo);
				record(memo.fabricSupervisorExecution).organizationId =
					"other-org";
				remote = { runId: "example-real-run", type, memo };
				throw new Error("Already started");
			},
		);
		await expect(startAgentExecution(input)).rejects.toBeInstanceOf(Error);
		expect(row?.runId).toBeNull();
		expect(counters.quota).toBe(0);
		expect(m.status).not.toHaveBeenCalled();
	});
	it("keeps goal-oriented dispatch scoped and pinned through the same safe start contract", async () => {
		m.scope.mockResolvedValue({
			projectId: "example-project",
			instance: {
				id: "example-instance",
				organizationId: "example-org",
				customInstructions: {},
				executionMode: "goal_oriented",
				goal: "Produce a report",
				maxIterations: 3,
				successCriteria: {
					type: "output_contains",
					requiredOutputs: ["Done"],
				},
			},
		});
		expect(await startAgentExecution(input)).toMatchObject({
			success: true,
		});
		expect(m.start).toHaveBeenCalledWith(
			"goalOrientedAgentWorkflow",
			expect.objectContaining({
				args: [
					expect.objectContaining({
						goal: "Produce a report",
						maxIterations: 3,
						organizationId: "example-org",
					}),
				],
			}),
		);
	});
});

it("throws retryable uncertainty instead of a normal false return to the supervisor", async () => {
	m.start.mockRejectedValue(new Error("Transport unknown"));
	await expect(startAgentExecution(input)).rejects.toMatchObject({
		type: "SUPERVISOR_EXECUTION_UNRESOLVED",
		nonRetryable: false,
	});
	expect(row?.status).toBe("PENDING");
	expect(m.status).not.toHaveBeenCalled();
});

it.each(["input", "trigger", "project grant"])(
	"rechecks current %s before describing an uncertain workflow",
	async (changed) => {
		m.start.mockImplementation(
			async (
				type: string,
				options: { memo: Record<string, unknown> },
			) => {
				remote = {
					runId: "example-real-run",
					type,
					memo: options.memo,
				};
				if (changed === "project grant") {
					m.scope.mockResolvedValue(null);
				} else if (row && changed === "input") {
					row.input = { message: "Changed after dispatch" };
				} else if (row) {
					row.triggerId = "different-trigger";
				}
				throw new Error("Response lost");
			},
		);
		await expect(startAgentExecution(input)).rejects.toMatchObject({
			type: "SUPERVISOR_EXECUTION_REFUSED",
			nonRetryable: true,
		});
		expect(m.describe).not.toHaveBeenCalled();
		expect(counters.quota).toBe(0);
	},
);
