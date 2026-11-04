import { randomUUID } from "node:crypto";
import { db, readAgentExecutionAdmission } from "@repo/database";
import { MockActivityEnvironment } from "@temporalio/testing";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

const dispatch = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/agent-execution-dispatch", () => ({
	dispatchAdmittedAgentExecution: dispatch,
}));

import { dispatchManagedAgentSchedule } from "../src/activities/lib/managed-agent-scheduled-dispatch";

// Real database/authorization/admission, controlled Temporal Activity context.
// Dispatch is the only mocked boundary: this suite never starts provider work.
const enabled =
	process.env.RUN_DB_INTEGRATION === "1" &&
	process.env.RUN_TEMPORAL_INTEGRATION === "1";
const prefix = `example-schedule-quota-${randomUUID()}`;
const organizationId = `${prefix}-org`;
const userId = `${prefix}-user`;
const projectId = `${prefix}-project`;
const templateId = `${prefix}-template`;
const instanceId = `${prefix}-instance`;
const deploymentId = `${prefix}-deployment`;
const triggerId = `fabric-run-schedule-${deploymentId}`;
let guarded = false;

async function purgeOwnedFixtureAudit() {
	if (!guarded || !organizationId.startsWith("example-schedule-quota-")) {
		throw Error("Only this guarded synthetic fixture may be purged");
	}
	// Match the existing audit integration suites: the maintenance permission is
	// transaction-local, and deletion is restricted to this owned test tenant.
	await db.$transaction(async (tx) => {
		await tx.$executeRaw`SET LOCAL app.audit_allow_delete = 'on'`;
		await tx.auditLog.deleteMany({ where: { organizationId } });
	});
}

const occurrence = {
	managedRunSchedule: 1 as const,
	deploymentId,
	triggerId,
	userId,
	organizationId,
	occurrenceWorkflowId: `${prefix}-occurrence`,
	occurrenceFirstRunId: `${prefix}-first-run`,
};

type DispatchResult = Awaited<ReturnType<typeof dispatchManagedAgentSchedule>>;

async function fire(input = occurrence): Promise<DispatchResult> {
	const deployment = await db.agentDeployment.findUniqueOrThrow({
		where: { id: deploymentId },
	});
	const trigger = await db.agentDeploymentTrigger.findUniqueOrThrow({
		where: { id: triggerId },
	});
	const environment = new MockActivityEnvironment({
		workflowType: "managedAgentRunScheduleWorkflow",
		workflowExecution: {
			workflowId: input.occurrenceWorkflowId,
			runId: input.occurrenceFirstRunId,
		},
	});
	return environment.run<
		Parameters<typeof dispatchManagedAgentSchedule>,
		DispatchResult,
		typeof dispatchManagedAgentSchedule
	>(dispatchManagedAgentSchedule, input, deployment, trigger);
}

describe.skipIf(!enabled)("schedule-first organization quota admission", () => {
	beforeAll(async () => {
		const url = new URL(process.env.DATABASE_URL ?? "");
		if (
			!["localhost", "127.0.0.1"].includes(url.hostname) ||
			url.port !== "55463" ||
			!/^\/example_[a-z0-9_]+$/.test(url.pathname)
		) {
			throw Error(
				"Only an explicitly configured loopback example_* database is allowed",
			);
		}
		guarded = true;
		await db.$transaction(async (tx) => {
			await tx.organization.create({
				data: {
					id: organizationId,
					slug: organizationId,
					name: "Example schedule-first team",
					createdAt: new Date(),
				},
			});
			await tx.user.create({
				data: {
					id: userId,
					name: "Example schedule owner",
					email: `${userId}@example.com`,
					emailVerified: true,
					createdAt: new Date(),
					updatedAt: new Date(),
				},
			});
			await tx.member.create({
				data: {
					organizationId,
					userId,
					role: "owner",
					createdAt: new Date(),
				},
			});
			await tx.project.create({
				data: {
					id: projectId,
					organizationId,
					userId,
					name: "Example scheduled delivery",
					status: "ACTIVE",
					techStack: [],
					features: [],
					tags: [],
				},
			});
			await tx.agentTemplate.create({
				data: {
					id: templateId,
					slug: templateId,
					organizationId,
					userId,
					scope: "ORGANIZATION",
					category: "GENERAL",
					name: "Example schedule-first agent",
					displayName: "Example schedule-first agent",
					description: "Synthetic quota admission fixture",
					instructions: "Return an example delivery update",
				},
			});
			await tx.agentTemplateInstance.create({
				data: {
					id: instanceId,
					templateId,
					organizationId,
					userId,
					name: "Example schedule-first agent",
					status: "ACTIVE",
					isApiExposed: false,
					customInstructions: { projectId },
					toolConnections: {},
					triggers: [],
				},
			});
			await tx.agentDeployment.create({
				data: {
					id: deploymentId,
					instanceId,
					organizationId,
					userId,
					name: "Example scheduled deployment",
					slug: deploymentId,
					status: "ACTIVE",
					taskQueue: "agents",
				},
			});
			await tx.agentDeploymentTrigger.create({
				data: {
					id: triggerId,
					deploymentId,
					organizationId,
					userId,
					projectId,
					type: "SCHEDULE",
					isActive: true,
					cronExpression: "0 9 * * 1-5",
					timezone: "UTC",
					config: {
						fabricManagedRunSchedule: 1,
						inputTemplate: {
							message: "Original scheduled delivery update",
						},
					},
				},
			});
		});
	});

	beforeEach(async () => {
		dispatch.mockReset();
		dispatch.mockImplementation(async (execution) => ({
			confirmed: true,
			execution,
		}));
		await purgeOwnedFixtureAudit();
		await db.agentDeploymentExecution.deleteMany({
			where: { deploymentId, organizationId, userId },
		});
		await db.organizationDeploymentQuota.deleteMany({
			where: { organizationId },
		});
		await db.agentDeployment.update({
			where: { id: deploymentId },
			data: { dailyExecutionCount: 0, monthlyExecutionCount: 0 },
		});
		await db.agentDeploymentTrigger.update({
			where: { id: triggerId },
			data: {
				totalExecutions: 0,
				lastExecutionId: null,
				lastRunAt: null,
				config: {
					fabricManagedRunSchedule: 1,
					inputTemplate: {
						message: "Original scheduled delivery update",
					},
				},
			},
		});
	});

	afterAll(async () => {
		if (guarded) {
			await purgeOwnedFixtureAudit();
			await db.organization.deleteMany({ where: { id: organizationId } });
			await db.user.deleteMany({ where: { id: userId } });
		}
	});

	it("initializes missing quota and recovers the original occurrence after quota exhaustion", async () => {
		expect(
			await db.organizationDeploymentQuota.findUnique({
				where: { organizationId },
			}),
		).toBeNull();
		const first = await fire();
		expect(first.success).toBe(true);
		if (!first.success || !first.executionId) {
			throw Error("Expected the first native admission");
		}
		const row = await db.agentDeploymentExecution.findUniqueOrThrow({
			where: { id: first.executionId },
		});
		expect(row).toMatchObject({
			organizationId,
			userId,
			deploymentId,
			triggerId,
			triggerType: "SCHEDULE",
			input: { message: "Original scheduled delivery update" },
		});
		expect(readAgentExecutionAdmission(row)).toMatchObject({
			executionCountReserved: true,
			receiptOwner: "workflow",
			dispatch: {
				instanceId,
				projectId,
				workflowType: "nativeDeploymentExecutionWorkflow",
			},
		});
		expect(
			await db.organizationDeploymentQuota.findUniqueOrThrow({
				where: { organizationId },
			}),
		).toMatchObject({ dailyExecutionCount: 1, monthlyExecutionCount: 1 });
		expect(
			await db.agentDeployment.findUniqueOrThrow({
				where: { id: deploymentId },
			}),
		).toMatchObject({ dailyExecutionCount: 1, monthlyExecutionCount: 1 });
		expect(
			await db.agentDeploymentTrigger.findUniqueOrThrow({
				where: { id: triggerId },
			}),
		).toMatchObject({ totalExecutions: 1, lastExecutionId: row.id });

		await db.organizationDeploymentQuota.update({
			where: { organizationId },
			data: { dailyExecutionLimit: 1, monthlyExecutionLimit: 1 },
		});
		await db.agentDeploymentTrigger.update({
			where: { id: triggerId },
			data: {
				config: {
					fabricManagedRunSchedule: 1,
					inputTemplate: {
						message: "Changed schedule for later occurrences",
					},
				},
			},
		});
		expect(await fire()).toEqual(first);
		expect(dispatch).toHaveBeenCalledTimes(2);
		expect(dispatch.mock.calls[1]?.[0]).toMatchObject({
			id: row.id,
			input: row.input,
		});
		expect(
			await db.agentDeploymentExecution.count({
				where: { deploymentId, organizationId, userId },
			}),
		).toBe(1);
		expect(
			await db.organizationDeploymentQuota.findUniqueOrThrow({
				where: { organizationId },
			}),
		).toMatchObject({ dailyExecutionCount: 1, monthlyExecutionCount: 1 });
		expect(
			await db.agentDeploymentTrigger.findUniqueOrThrow({
				where: { id: triggerId },
			}),
		).toMatchObject({ totalExecutions: 1, lastExecutionId: row.id });
		expect(
			await db.auditLog.count({
				where: {
					organizationId,
					resourceId: row.id,
					action: "org.agent_execution.admitted",
				},
			}),
		).toBe(1);
	});

	it("refuses a different occurrence at the limit without another dispatch or reservation", async () => {
		expect((await fire()).success).toBe(true);
		await db.organizationDeploymentQuota.update({
			where: { organizationId },
			data: { dailyExecutionLimit: 1, monthlyExecutionLimit: 1 },
		});
		expect(
			await fire({
				...occurrence,
				occurrenceWorkflowId: `${prefix}-other-occurrence`,
				occurrenceFirstRunId: `${prefix}-other-first-run`,
			}),
		).toMatchObject({ success: false });
		expect(dispatch).toHaveBeenCalledOnce();
		expect(
			await db.agentDeploymentExecution.count({
				where: { deploymentId, organizationId, userId },
			}),
		).toBe(1);
		expect(
			await db.organizationDeploymentQuota.findUniqueOrThrow({
				where: { organizationId },
			}),
		).toMatchObject({ dailyExecutionCount: 1, monthlyExecutionCount: 1 });
		expect(
			await db.agentDeploymentTrigger.findUniqueOrThrow({
				where: { id: triggerId },
			}),
		).toMatchObject({ totalExecutions: 1 });
	});
});
