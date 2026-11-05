import { call } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	search: vi.fn(),
	membership: vi.fn(),
	scope: vi.fn(),
	resolve: vi.fn(),
	deployment: vi.fn(),
	query: vi.fn(),
	find: vi.fn(),
	read: vi.fn(),
	get: vi.fn(),
	start: vi.fn(),
	native: vi.fn(),
	schedule: vi.fn(),
	save: vi.fn(),
	signal: vi.fn(),
	describe: vi.fn(),
	handle: vi.fn(),
	audit: vi.fn(),
	create: vi.fn(),
}));
vi.mock("@repo/database", async () => ({
	Prisma: {
		sql: (strings: unknown, ...values: unknown[]) => ({ strings, values }),
	},
	db: {
		$queryRaw: m.query,
		agentDeploymentExecution: { findFirst: m.find },
		member: { findFirst: m.membership },
	},
	getAgentTemplateInstanceForExecution: m.scope,
	getOrganizationMembership: m.membership,
	getTenantContext: () => ({}),
}));
vi.mock("@repo/temporal", () => ({
	getTemporalClient: async () => ({ workflow: { getHandle: m.handle } }),
}));
vi.mock("../../../../orpc/procedures", async () => {
	const { os } = await import("@orpc/server");
	const { Permissions } = await import("@repo/permissions");
	const { requireInputOrgPermission } = await import(
		"../../../../orpc/middleware/require-permission"
	);
	return {
		tenantProtectedProcedure: os,
		Permissions,
		requireInputOrgPermission,
		resolveOrganizationId: (
			id: unknown,
			session: { activeOrganizationId: string },
		) => id ?? session.activeOrganizationId,
	};
});
vi.mock("../../../../lib/audit", () => ({ recordAuditFromRequest: m.audit }));
vi.mock("../../lib/run-history", () => ({ searchAgentRunCommand: m.search }));
vi.mock("../../lib/run-control-access", () => ({
	resolveRunControlInstance: m.resolve,
	getOwnedRunDeployment: m.deployment,
}));
vi.mock("../../../external-api/procedures/execute-agent", () => ({
	executeAgentFromPortal: m.start,
	getOrCreateDeployment: m.create,
}));
vi.mock("../../../external-api/procedures/get-execution", () => ({
	canReadAgentExecution: m.read,
	getExecution: m.get,
}));
vi.mock("../../../external-api/lib/native-execution-state", () => ({
	readNativeExecutionState: m.native,
}));
vi.mock("../../lib/managed-run-schedule", () => ({
	buildManagedRunCalendar: vi.fn(),
	readManagedRunSchedule: m.schedule,
	saveManagedRunSchedule: m.save,
}));

import {
	cancelAgentRunProcedure,
	getAgentRunProcedure,
	listAgentRunsProcedure,
	searchAgentRunsProcedure,
	startAgentRunProcedure,
} from "../run-controls";

const context = {
	user: { id: "example-user", email: "dev@example.com", name: "Example" },
	session: { activeOrganizationId: "example-org" },
	activeOrganizationRole: "owner",
	allowedProjectIds: [],
	tenantContext: {
		type: "organization" as const,
		userId: "example-user",
		organizationId: "example-org",
	},
	headers: new Headers(),
};
const base = { organizationId: "example-org" };
const instance = {
	id: "example-instance",
	name: "Example",
	userId: "example-user",
	organizationId: "example-org",
};
const row = {
	id: "example-row",
	executionId: "example-channel",
	deploymentId: "example-deployment",
	...instance,
	userId: "example-user",
	status: "RUNNING",
	queuedAt: new Date(0),
	createdAt: new Date(0),
	completedAt: null,
	duration: null,
	error: null,
	triggerType: "MANUAL",
	workflowId: "example-workflow",
	runId: "example-run",
};
row.id = "example-row";
const run = () =>
	call(
		startAgentRunProcedure,
		{
			...base,
			instanceId: instance.id,
			input: { message: "Create a report" },
			idempotencyKey: "example-key",
		},
		{ context },
	);
const list = () =>
	call(
		listAgentRunsProcedure,
		{ ...base, instanceId: instance.id },
		{ context },
	);
const cancel = () =>
	call(
		cancelAgentRunProcedure,
		{ ...base, executionId: row.id },
		{ context },
	);
beforeEach(() => {
	vi.resetAllMocks();
	m.membership.mockResolvedValue({ role: "owner" });
	m.resolve.mockResolvedValue(instance);
	m.deployment.mockResolvedValue({
		id: "example-deployment",
		status: "ACTIVE",
	});
	m.query.mockResolvedValue([row]);
	m.read.mockResolvedValue(true);
	m.native.mockResolvedValue({
		status: "RUNNING",
		nativeReadStatus: "AVAILABLE",
		runId: row.runId,
	});
	m.schedule.mockResolvedValue({
		schedule: null,
		schedulingState: "UNKNOWN",
	});
	m.start.mockResolvedValue({
		status: 202,
		data: { executionId: row.id, status: "PENDING" },
	});
	m.get.mockResolvedValue({ ...row, nativeStateAvailable: true });
	m.find.mockResolvedValue({
		...row,
		deployment: {
			instanceId: instance.id,
			userId: instance.userId,
			organizationId: instance.organizationId,
		},
	});
	m.scope.mockResolvedValue({ instance });
	m.handle.mockReturnValue({ describe: m.describe, signal: m.signal });
	m.describe.mockResolvedValue({
		runId: row.runId,
		type: "nativeDeploymentExecutionWorkflow",
	});
});
describe("Portal saved agent background controls", () => {
	it("returns native admission row receipt unwrapped and keeps request key unchanged", async () => {
		expect(await run()).toEqual({ executionId: row.id, status: "PENDING" });
		expect(m.start).toHaveBeenCalledWith(
			instance.id,
			{
				input: { message: "Create a report" },
				idempotencyKey: "example-key",
			},
			{ userId: "example-user", organizationId: "example-org" },
		);
	});
	it("preserves same-key unresolved recovery detail", async () => {
		m.start.mockResolvedValue({
			status: 503,
			error: {
				code: "ADMISSION_UNRESOLVED",
				message: "Reconcile this request",
				data: { retryable: true, executionId: row.id },
			},
		});
		await expect(run()).rejects.toMatchObject({
			code: "SERVICE_UNAVAILABLE",
			data: {
				code: "ADMISSION_UNRESOLVED",
				data: { executionId: row.id },
			},
		});
	});
	it("does not create deployments or schedule records for an empty list", async () => {
		m.deployment.mockResolvedValue(null);
		expect(await list()).toEqual({
			deployment: null,
			executions: [],
			schedule: null,
			schedulingState: "UNKNOWN",
		});
		expect(m.create).not.toHaveBeenCalled();
		expect(m.query).not.toHaveBeenCalled();
	});
	it("filters project access revoked while querying native status", async () => {
		m.read.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
		expect(await list()).toMatchObject({ executions: [] });
	});
	it("selects bounded metadata without model input/output bodies", async () => {
		await list();
		const query = m.query.mock.calls[0][0];
		expect(query.values).toEqual([
			"example-deployment",
			"example-user",
			"example-org",
			20,
		]);
		expect(query.strings.join("")).toContain("left(error,1000)");
		expect(query.strings.join("")).not.toMatch(
			/SELECT.*(?:"input"|"output")/,
		);
	});
	it("inspects through the shared native DTO reader", async () => {
		expect(
			await call(
				getAgentRunProcedure,
				{ ...base, executionId: row.id },
				{ context },
			),
		).toMatchObject({ id: row.id, nativeStateAvailable: true });
	});
	it("pins cancellation to exact verified native run and only reports requested", async () => {
		expect(await cancel()).toMatchObject({
			requested: true,
			status: "RUNNING",
		});
		expect(m.handle).toHaveBeenCalledWith(row.workflowId, row.runId, {
			followRuns: false,
		});
		expect(m.signal).toHaveBeenCalledWith("cancelExecution");
		expect(m.scope).toHaveBeenCalledTimes(2);
		expect(m.audit).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				action: "org.agent_execution.cancel_requested",
			}),
		);
	});
	it("uses goal cancel signal while preserving terminal execution status", async () => {
		m.describe.mockResolvedValue({
			runId: row.runId,
			type: "nativeGoalOrientedAgentWorkflow",
		});
		await cancel();
		expect(m.signal).toHaveBeenCalledWith("cancel");
	});
	it("does not dispatch cancellation after permission changed during describe", async () => {
		m.scope.mockResolvedValueOnce({ instance }).mockResolvedValueOnce(null);
		await expect(cancel()).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(m.signal).not.toHaveBeenCalled();
	});
	it("refuses cancellation when exact native identity cannot be confirmed", async () => {
		m.describe.mockResolvedValue({
			runId: "another-run",
			type: "nativeDeploymentExecutionWorkflow",
		});
		await expect(cancel()).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(m.signal).not.toHaveBeenCalled();
	});
	it("terminal cancellation is a harmless noop without another signal", async () => {
		m.get.mockResolvedValue({ ...row, status: "COMPLETED" });
		expect(await cancel()).toMatchObject({
			requested: false,
			status: "COMPLETED",
		});
		expect(m.signal).not.toHaveBeenCalled();
	});
});

describe("fresh native cancellation identity", () => {
	it("accepts a stale stored receipt only after fresh shared verification recovers the same pinned native run", async () => {
		m.find.mockResolvedValue({
			...row,
			runId: "example-stale-run",
			deployment: {
				instanceId: instance.id,
				userId: instance.userId,
				organizationId: instance.organizationId,
			},
		});
		expect(await cancel()).toMatchObject({
			requested: true,
			status: "RUNNING",
		});
		expect(m.native).toHaveBeenCalledWith(
			expect.objectContaining({ id: row.id, runId: "example-stale-run" }),
		);
		expect(m.handle).toHaveBeenCalledWith(row.workflowId, row.runId, {
			followRuns: false,
		});
		expect(m.signal).toHaveBeenCalledWith("cancelExecution");
	});
	it.each([
		{ nativeReadStatus: "IDENTITY_UNVERIFIED" },
		{ nativeReadStatus: "AVAILABLE", runId: "example-foreign-run" },
	])(
		"refuses changed/foreign admission or recovered identity after an earlier successful read",
		async (current) => {
			m.native.mockResolvedValue(current);
			await expect(cancel()).rejects.toMatchObject({ code: "NOT_FOUND" });
			expect(m.signal).not.toHaveBeenCalled();
			expect(m.audit).not.toHaveBeenCalled();
		},
	);
});

describe("Portal paged saved-agent history", () => {
	it("passes the resolved user and organization to the same shared query", async () => {
		m.search.mockResolvedValue({ executions: [], nextCursor: null });
		const filters = {
			instanceId: instance.id,
			status: "ACTIVE" as const,
			query: "Report",
			limit: 25,
		};
		expect(
			await call(
				searchAgentRunsProcedure,
				{ ...base, ...filters },
				{ context },
			),
		).toEqual({ executions: [], nextCursor: null });
		expect(m.search).toHaveBeenCalledWith(
			{ userId: context.user.id, organizationId: base.organizationId },
			filters,
		);
	});
	it("retains live organization membership verification", async () => {
		m.membership.mockResolvedValue(null);
		await expect(
			call(searchAgentRunsProcedure, base, { context }),
		).rejects.toThrow();
		expect(m.search).not.toHaveBeenCalled();
	});
	it("rejects actor injection and unbounded input before shared I/O", async () => {
		for (const input of [
			{ ...base, limit: 51 },
			{ ...base, userId: "other-user" },
		]) {
			await expect(
				call(searchAgentRunsProcedure, input, { context }),
			).rejects.toThrow();
		}
		expect(m.search).not.toHaveBeenCalled();
	});
});
