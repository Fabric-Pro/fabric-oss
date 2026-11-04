import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	deployment: vi.fn(),
	rows: [] as Array<Record<string, any>>,
	find: vi.fn(),
	update: vi.fn(),
	signal: vi.fn(),
	pause: vi.fn(),
	unpause: vi.fn(),
	handle: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	Prisma: { JsonNull: null },
	getAgentDeploymentById: m.deployment,
	decrementDeploymentQuota: vi.fn(),
	db: { agentDeploymentTrigger: { findMany: m.find, updateMany: m.update } },
}));
vi.mock("@repo/temporal", () => ({
	getTemporalClient: async () => ({
		workflow: { getHandle: () => ({ signal: m.signal }) },
	}),
	getScheduleClient: async () => ({ getHandle: m.handle }),
}));
vi.mock("../../../organizations/lib/membership", () => ({
	verifyOrganizationMembership: async () => ({ role: "owner" }),
}));
vi.mock("../../../../orpc/procedures", () => {
	const chain = {
		use: () => chain,
		input: () => chain,
		handler: (run: unknown) => ({ _handler: run }),
	};
	return {
		tenantProtectedProcedure: chain,
		Permissions: { AGENT_UPDATE: "update", AGENT_DELETE: "delete" },
		requirePermission: () => () => {},
		resolveOrganizationId: (
			id: unknown,
			s: { activeOrganizationId: string },
		) => id ?? s.activeOrganizationId,
	};
});

import { managedAgentRunScheduleSchema } from "@repo/database/prisma/queries/lib/managed-agent-run-schedule";
import {
	pauseDeploymentProcedure,
	resumeDeploymentProcedure,
} from "../lifecycle";

const owner = {
	deploymentId: "example-deployment",
	userId: "example-user",
	organizationId: "example-org",
};
const managed = {
	id: "fabric-run-schedule-example-deployment",
	...owner,
	type: "SCHEDULE",
	isActive: true,
	config: {
		fabricManagedRunSchedule: 1,
		inputTemplate: { message: "Create weekly delivery report" },
	},
	cronExpression: "0 9 * * MON",
	timezone: "UTC",
};
const legacy = {
	id: "example-legacy",
	...owner,
	type: "WEBHOOK",
	isActive: true,
	config: {
		resource: "project",
		event: "updated",
		conditions: { status: "ACTIVE" },
		customPath: "example-path",
	},
};
const invoke = (procedure: unknown) =>
	(procedure as { _handler: (args: unknown) => Promise<unknown> })._handler({
		input: {
			deploymentId: owner.deploymentId,
			organizationId: owner.organizationId,
		},
		context: {
			user: { id: owner.userId },
			session: { activeOrganizationId: owner.organizationId },
		},
	});
beforeEach(() => {
	vi.resetAllMocks();
	m.rows = [
		structuredClone(managed),
		structuredClone(legacy),
		{
			...structuredClone(legacy),
			id: "example-manually-disabled",
			isActive: false,
		},
		{
			...structuredClone(legacy),
			id: "example-foreign",
			organizationId: "another-org",
		},
	];
	m.deployment.mockResolvedValue({
		...owner,
		id: owner.deploymentId,
		supervisorWorkflowId: "example-supervisor",
		status: "ACTIVE",
	});
	m.find.mockImplementation(async ({ where }) =>
		structuredClone(
			m.rows.filter((row) =>
				Object.entries(where).every(
					([key, value]) => row[key] === value,
				),
			),
		),
	);
	m.update.mockImplementation(async ({ where, data }) => {
		const matches = m.rows.filter((row) =>
			Object.entries(where).every(([key, value]) =>
				key === "config"
					? JSON.stringify(row.config) ===
						JSON.stringify((value as any).equals)
					: row[key] === value,
			),
		);
		matches.forEach((row) => {
			Object.assign(row, structuredClone(data));
		});
		return { count: matches.length };
	});
	m.handle.mockReturnValue({ pause: m.pause, unpause: m.unpause });
});
describe("deployment lifecycle configuration preservation", () => {
	it("does not overwrite configuration edited while the Temporal pause request is pending", async () => {
		const edited = {
			...managed.config,
			inputTemplate: { message: "New task saved concurrently" },
		};
		m.pause.mockImplementation(async () => {
			m.rows[0].config = edited;
		});
		await invoke(pauseDeploymentProcedure);
		expect(m.rows[0].config).toEqual(edited);
		expect(m.rows[0].isActive).toBe(true);
	});
	it("pauses/resumes native managed schedule without losing task, marker, cron or timezone", async () => {
		await invoke(pauseDeploymentProcedure);
		expect(m.rows[0]).toMatchObject({
			...managed,
			isActive: false,
			config: { ...managed.config, _pausedByLifecycle: true },
		});
		expect(
			managedAgentRunScheduleSchema.safeParse(m.rows[0].config).success,
		).toBe(true);
		expect(m.handle).toHaveBeenCalledWith(`trigger-schedule-${managed.id}`);
		expect(m.pause).toHaveBeenCalledOnce();
		m.deployment.mockResolvedValue({
			...owner,
			id: owner.deploymentId,
			supervisorWorkflowId: "example-supervisor",
			status: "PAUSED",
		});
		await invoke(resumeDeploymentProcedure);
		expect(m.rows[0]).toEqual(managed);
		expect(m.unpause).toHaveBeenCalledOnce();
	});
	it("preserves all legacy object fields and only restores lifecycle-paused rows", async () => {
		await invoke(pauseDeploymentProcedure);
		expect(m.rows[1].config).toEqual({
			...legacy.config,
			_pausedByLifecycle: true,
		});
		expect(m.rows[2].isActive).toBe(false);
		expect(m.rows[2].config).toEqual(legacy.config);
		expect(m.rows[3].isActive).toBe(true);
		expect(m.rows[3].config).toEqual(legacy.config);
		m.deployment.mockResolvedValue({
			...owner,
			id: owner.deploymentId,
			supervisorWorkflowId: "example-supervisor",
			status: "PAUSED",
		});
		await invoke(resumeDeploymentProcedure);
		expect(m.rows[1]).toEqual(legacy);
		expect(m.rows[2].isActive).toBe(false);
		expect(m.rows[3].config).toEqual(legacy.config);
		for (const call of m.update.mock.calls) {
			expect(call[0].where).toMatchObject(owner);
		}
	});
	it("accepts only the known internal pause flag in strict managed configuration", () => {
		expect(
			managedAgentRunScheduleSchema.safeParse({
				...managed.config,
				_pausedByLifecycle: true,
			}).success,
		).toBe(true);
		expect(
			managedAgentRunScheduleSchema.safeParse({
				...managed.config,
				_pausedByLifecycle: false,
			}).success,
		).toBe(false);
		expect(
			managedAgentRunScheduleSchema.safeParse({
				...managed.config,
				unrecognized: "value",
			}).success,
		).toBe(false);
	});
});
