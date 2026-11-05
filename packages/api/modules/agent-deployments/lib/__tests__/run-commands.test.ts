import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	member: vi.fn(),
	exposed: vi.fn(),
	resolve: vi.fn(),
	deployment: vi.fn(),
	create: vi.fn(),
	save: vi.fn(),
	readSchedule: vi.fn(),
	get: vi.fn(),
	query: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	db: {
		member: { findFirst: m.member },
		agentTemplateInstance: { findFirst: m.exposed },
		$queryRaw: m.query,
	},
	Prisma: { sql: vi.fn() },
	getAgentTemplateInstanceForExecution: vi.fn(),
}));
vi.mock("@repo/temporal", () => ({ getTemporalClient: vi.fn() }));
vi.mock("../run-control-access", () => ({
	resolveRunControlInstance: m.resolve,
	getOwnedRunDeployment: m.deployment,
}));
vi.mock("../managed-run-schedule", () => ({
	buildManagedRunCalendar: vi.fn(),
	readManagedRunSchedule: m.readSchedule,
	saveManagedRunSchedule: m.save,
}));
vi.mock("../../../external-api/procedures/execute-agent", () => ({
	getOrCreateDeployment: m.create,
}));
vi.mock("../../../external-api/procedures/get-execution", () => ({
	getExecution: m.get,
	canReadAgentExecution: vi.fn(),
}));
vi.mock("../../../external-api/lib/native-execution-state", () => ({
	readNativeExecutionState: vi.fn(),
}));

import {
	cancelAgentRunCommand,
	getAgentRunCommand,
	listAgentRunCommand,
	readAgentRunScheduleCommand,
	scheduleAgentRunCommand,
} from "../run-commands";

const actor = {
	userId: "example-user",
	organizationId: "example-org",
	external: true,
};
const input = {
	instanceId: "example-instance",
	cronExpression: "0 9 * * *",
	timezone: "UTC",
	input: { message: "Create progress report" },
	enabled: true,
};
const deployment = { id: "example-deployment", ...actor, status: "ACTIVE" };
beforeEach(() => {
	vi.resetAllMocks();
	m.member.mockResolvedValue({ role: "owner" });
	m.resolve.mockResolvedValue({ id: input.instanceId, name: "Example" });
	m.create.mockResolvedValue(deployment);
	m.deployment.mockResolvedValue(deployment);
	m.exposed.mockResolvedValue({ id: input.instanceId });
	m.save.mockImplementation(async (value) => {
		await value.onSaved();
		return {
			schedule: { ...input, id: "example-schedule" },
			schedulingState: "ACTIVE",
		};
	});
	m.readSchedule.mockResolvedValue({
		schedule: null,
		schedulingState: "UNKNOWN",
	});
});
describe("one authorized run command service", () => {
	it.each([null, { role: "unknown" }])(
		"refuses removed or unrecognized membership before any object or engine I/O",
		async (member) => {
			m.member.mockResolvedValue(member);
			for (const op of [
				() =>
					listAgentRunCommand(actor, {
						instanceId: input.instanceId,
					}),
				() => getAgentRunCommand(actor, { executionId: "example-row" }),
				() =>
					cancelAgentRunCommand(
						actor,
						{ executionId: "example-row" },
						vi.fn(),
					),
				() =>
					readAgentRunScheduleCommand(actor, {
						instanceId: input.instanceId,
					}),
				() => scheduleAgentRunCommand(actor, input, vi.fn()),
			]) {
				await expect(op()).rejects.toMatchObject({ code: "FORBIDDEN" });
			}
			expect(m.resolve).not.toHaveBeenCalled();
			expect(m.get).not.toHaveBeenCalled();
			expect(m.save).not.toHaveBeenCalled();
		},
	);
	it("rechecks live update and execute permission, independent of a wildcard credential", async () => {
		m.member.mockResolvedValue({ role: "viewer" });
		await expect(
			scheduleAgentRunCommand(actor, input, vi.fn()),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			cancelAgentRunCommand(
				actor,
				{ executionId: "example-row" },
				vi.fn(),
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(m.get).not.toHaveBeenCalled();
	});
	it("rejects raw actor/tenant/scope injection and invalid page limits", async () => {
		await expect(
			listAgentRunCommand(actor, {
				instanceId: input.instanceId,
				organizationId: "another-org",
				scopes: ["*"],
			}),
		).rejects.toThrow();
		await expect(
			listAgentRunCommand(actor, {
				instanceId: input.instanceId,
				limit: 51,
			}),
		).rejects.toThrow();
		expect(m.query).not.toHaveBeenCalled();
	});
	it("does not open private agents to recurring external invocation", async () => {
		m.exposed.mockResolvedValue(null);
		await expect(
			scheduleAgentRunCommand(actor, input, vi.fn()),
		).rejects.toThrow(/Enable API access/);
		expect(m.create).not.toHaveBeenCalled();
		expect(m.save).not.toHaveBeenCalled();
		expect(m.exposed).toHaveBeenCalledWith({
			where: {
				id: input.instanceId,
				userId: actor.userId,
				organizationId: actor.organizationId,
				isApiExposed: true,
			},
			select: { id: true },
		});
	});
	it("allows owner-scoped pause without exposure or creating a deployment/trigger", async () => {
		m.exposed.mockResolvedValue(null);
		const audit = vi.fn();
		await scheduleAgentRunCommand(
			actor,
			{ ...input, enabled: false },
			audit,
		);
		expect(m.exposed).not.toHaveBeenCalled();
		expect(m.create).not.toHaveBeenCalled();
		expect(m.save).toHaveBeenCalledWith(
			expect.objectContaining({
				requireExisting: true,
				enabled: false,
				userId: actor.userId,
				organizationId: actor.organizationId,
			}),
		);
		expect(audit).toHaveBeenCalledWith(
			expect.objectContaining({ action: "org.agent_schedule.updated" }),
		);
	});
	it("refuses pause when no owned deployment exists", async () => {
		m.deployment.mockResolvedValue(null);
		await expect(
			scheduleAgentRunCommand(
				actor,
				{ ...input, enabled: false },
				vi.fn(),
			),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(m.create).not.toHaveBeenCalled();
		expect(m.save).not.toHaveBeenCalled();
	});
	it("preserves interactive scheduling while keeping external transport flags out of ORM/worker inputs", async () => {
		await scheduleAgentRunCommand(
			{ ...actor, external: false },
			input,
			vi.fn(),
		);
		expect(m.exposed).not.toHaveBeenCalled();
		expect(m.create).toHaveBeenCalledWith(input.instanceId, "Example", {
			userId: actor.userId,
			organizationId: actor.organizationId,
		});
		expect(m.save.mock.calls[0][0]).not.toHaveProperty("external");
	});
	it("propagates revoked project/owner access without spending or creating work", async () => {
		m.resolve.mockRejectedValue(new Error("Project access revoked"));
		await expect(
			scheduleAgentRunCommand(actor, input, vi.fn()),
		).rejects.toThrow("Project access revoked");
		expect(m.create).not.toHaveBeenCalled();
	});
});

it("checks runnable capability only when enabling, retaining current execution authority for pause", async () => {
	await scheduleAgentRunCommand(actor, { ...input, enabled: false }, vi.fn());
	expect(m.resolve).toHaveBeenCalledWith(
		input.instanceId,
		{ userId: actor.userId, organizationId: actor.organizationId },
		true,
		{ requireRunnable: false },
	);
	await scheduleAgentRunCommand(actor, input, vi.fn());
	expect(m.resolve).toHaveBeenLastCalledWith(
		input.instanceId,
		{ userId: actor.userId, organizationId: actor.organizationId },
		true,
		{ requireRunnable: true },
	);
});
