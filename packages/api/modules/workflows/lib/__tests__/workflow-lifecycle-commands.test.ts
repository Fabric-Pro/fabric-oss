import { beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	read: vi.fn(),
	edit: vi.fn(),
	update: vi.fn(),
	createVersion: vi.fn(),
	version: vi.fn(),
	versions: vi.fn(),
	count: vi.fn(),
	latest: vi.fn(),
	schedule: vi.fn(),
	describe: vi.fn(),
	client: vi.fn(),
	publish: vi.fn(),
	unpublish: vi.fn(),
	pause: vi.fn(),
	resume: vi.fn(),
	audit: vi.fn(),
	problems: vi.fn(),
	commit: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	db: {
		workflow: { update: m.update },
		workflowVersion: {
			findFirst: m.version,
			findMany: m.versions,
			count: m.count,
			create: m.createVersion,
		},
	},
	isWorkflowLive: (s: string) => s === "PUBLISHED" || s === "ACTIVE",
	recordAudit: m.audit,
	Prisma: { JsonNull: null },
}));
vi.mock("../workflow-command-context", async () => {
	const actual = await vi.importActual<any>("../workflow-command-context");
	return {
		...actual,
		loadReadableWorkflow: m.read,
		loadEditableWorkflow: m.edit,
	};
});
vi.mock("../commit-workflow-version", () => ({
	commitWorkflowVersion: m.commit,
}));
vi.mock("../workflow-commands", () => ({
	applyWorkflowUpdateWithSchedule: m.update,
	publishWorkflowCommand: m.publish,
	unpublishWorkflowCommand: m.unpublish,
	pauseWorkflowCommand: m.pause,
	resumeWorkflowCommand: m.resume,
}));
vi.mock("../sync-workflow-schedule", () => ({
	syncWorkflowSchedule: m.schedule,
}));
vi.mock("../agentic-publish-validation", () => ({
	findAgenticPublishProblems: m.problems,
}));
vi.mock("@repo/temporal", () => ({
	getScheduleClient: m.client,
	buildWorkflowScheduleId: (id: string) => `workflow-builder-${id}`,
	isPlausibleCron: (s: string) => s.split(" ").length === 5,
	isValidScheduleTimeZone: (s: string) => s === "UTC",
	ScheduleNotFoundError: class ScheduleNotFoundError extends Error {},
}));

import {
	changeWorkflowLifecycleCommand,
	configureWorkflowScheduleCommand,
	getWorkflowScheduleCommand,
	listWorkflowVersionsCommand,
	rollbackWorkflowCommand,
} from "../workflow-lifecycle-commands";

const actor = { userId: "example-user", organizationId: "example-org" };
const nodes = [
	{
		id: "start",
		type: "trigger",
		data: { config: { triggerType: "manual" } },
	},
];
beforeEach(() => {
	vi.clearAllMocks();
	const row = {
		id: "example-workflow",
		userId: actor.userId,
		organizationId: actor.organizationId,
		status: "DRAFT",
		name: "Example",
		updatedAt: new Date("2026-01-01"),
		triggerType: "MANUAL",
		nodes,
		edges: [],
		version: 1,
		publishedAt: null,
		publishedVersion: null,
	};
	m.read.mockResolvedValue(row);
	m.edit.mockResolvedValue(row);
	m.client.mockResolvedValue({ getHandle: () => ({ describe: m.describe }) });
	m.describe.mockRejectedValue(new Error("engine unavailable"));
	m.update.mockResolvedValue(row);
	m.problems.mockResolvedValue({ problems: [] });
	m.versions.mockResolvedValue([]);
	m.count.mockResolvedValue(0);
	m.version.mockReset().mockResolvedValue(null);
	m.commit.mockResolvedValue(2);
	m.schedule.mockResolvedValue({ outcome: "none" });
});
it("reads the live schedule only after current object access and reports an outage honestly", async () => {
	m.read.mockRejectedValueOnce(new Error("not found"));
	await expect(
		getWorkflowScheduleCommand(actor, { workflowId: "other" }),
	).rejects.toThrow("not found");
	expect(m.client).not.toHaveBeenCalled();
	expect(
		(
			await getWorkflowScheduleCommand(actor, {
				workflowId: "example-workflow",
			})
		).state,
	).toBe("unavailable");
});
it("saves only the schedule draft, preserving other fields and leaving Temporal untouched", async () => {
	const r = await configureWorkflowScheduleCommand(actor, {
		workflowId: "example-workflow",
		cron: "0 9 * * 1",
		timezone: "UTC",
	});
	expect(r.publishRequired).toBe(true);
	expect(m.update).toHaveBeenCalledWith(
		actor,
		expect.objectContaining({ id: "example-workflow" }),
		{
			id: "example-workflow",
			nodes: [
				{
					id: "start",
					type: "trigger",
					data: {
						config: {
							triggerType: "schedule",
							scheduleCron: "0 9 * * 1",
							scheduleTimezone: "UTC",
						},
					},
				},
			],
		},
		{ expectedUpdatedAt: new Date("2026-01-01") },
	);
	expect(m.schedule).not.toHaveBeenCalled();
	expect(m.publish).not.toHaveBeenCalled();
	expect(m.audit).toHaveBeenCalled();
});
it("requires a valid schedule and unambiguous trigger before writing", async () => {
	await expect(
		configureWorkflowScheduleCommand(actor, {
			workflowId: "example-workflow",
			cron: "tomorrow",
		}),
	).rejects.toThrow();
	m.edit.mockResolvedValue({ nodes: [] });
	await expect(
		configureWorkflowScheduleCommand(actor, {
			workflowId: "example-workflow",
			cron: "0 9 * * 1",
		}),
	).rejects.toThrow("exactly one trigger");
	expect(m.update).not.toHaveBeenCalled();
});
it("lists only tenant-owned version metadata after current read authority", async () => {
	await listWorkflowVersionsCommand(actor, {
		workflowId: "example-workflow",
		limit: 10,
		offset: 20,
	});
	expect(m.versions).toHaveBeenCalledWith(
		expect.objectContaining({
			where: { workflowId: "example-workflow", ...actor },
			take: 10,
			skip: 20,
			select: expect.not.objectContaining({ nodes: true }),
		}),
	);
});
it("does not audit a refused publish as a successful mutation", async () => {
	m.publish.mockResolvedValue({
		success: false,
		validation: { errors: ["missing"] },
	});
	const result = await changeWorkflowLifecycleCommand(actor, "publish", {
		workflowId: "example-workflow",
	});
	expect(result.success).toBe(false);
	expect(m.audit).not.toHaveBeenCalled();
});
it("refuses cross-tenant or unpublished rollback targets before writing", async () => {
	m.version.mockResolvedValue(null);
	await expect(
		rollbackWorkflowCommand(actor, {
			workflowId: "example-workflow",
			targetVersion: 1,
		}),
	).rejects.toThrow("not found");
	expect(m.version).toHaveBeenCalledWith(
		expect.objectContaining({
			where: {
				workflowId: "example-workflow",
				version: 1,
				...actor,
				isPublished: true,
			},
		}),
	);
	expect(m.createVersion).not.toHaveBeenCalled();
});
it.each(["WEBHOOK", "MANUAL"])(
	"does not silently replace a webhook trigger (%s row)",
	async (triggerType) => {
		m.edit.mockResolvedValue({
			triggerType,
			nodes: [
				{
					id: "start",
					type: "trigger",
					data: { config: { triggerType: "webhook" } },
				},
			],
		});
		await expect(
			configureWorkflowScheduleCommand(actor, {
				workflowId: "example-workflow",
				cron: "0 9 * * 1",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(m.update).not.toHaveBeenCalled();
	},
);
it("reports an edit race as a conflict without auditing success", async () => {
	m.update.mockRejectedValueOnce({ code: "P2025" });
	await expect(
		configureWorkflowScheduleCommand(actor, {
			workflowId: "example-workflow",
			cron: "0 9 * * 1",
		}),
	).rejects.toMatchObject({ code: "CONFLICT" });
	expect(m.audit).not.toHaveBeenCalled();
});
it("does not request another publication for an already published cadence", async () => {
	const publishedNodes = [
		{
			id: "start",
			type: "trigger",
			data: {
				config: {
					triggerType: "schedule",
					scheduleCron: "0 9 * * 1",
					scheduleTimezone: "UTC",
				},
			},
		},
	];
	const row = await m.edit();
	m.edit.mockResolvedValue({
		...row,
		publishedAt: new Date(),
		publishedVersion: 1,
	});
	m.version.mockResolvedValue({ nodes: publishedNodes });
	expect(
		(
			await configureWorkflowScheduleCommand(actor, {
				workflowId: "example-workflow",
				cron: "0 9 * * 1",
			})
		).publishRequired,
	).toBe(false);
});
it.each(["PAUSED", "DRAFT"])(
	"rollback preserves %s state and current runtime bookkeeping",
	async (status) => {
		const currentSettings = {
			publishFrameIds: { publish: "example-frame" },
			consecutiveFailures: 3,
			pausedReason: "Example reason",
		};
		const row = await m.edit();
		m.edit.mockResolvedValue({ ...row, status, settings: currentSettings });
		m.version.mockResolvedValue({
			nodes: [
				{
					id: "start",
					type: "trigger",
					data: { config: { triggerType: "manual" } },
				},
			],
			edges: [],
			settings: null,
			variables: null,
			triggerConfig: null,
		});
		await rollbackWorkflowCommand(actor, {
			workflowId: "example-workflow",
			targetVersion: 1,
		});
		const input = m.commit.mock.calls[0][0];
		expect(input.patch).not.toHaveProperty("status");
		expect(input.patch).not.toHaveProperty("settings");
		expect(input.content.settings).toEqual(currentSettings);
		expect(m.schedule).toHaveBeenCalledWith(
			expect.objectContaining({ active: false }),
		);
	},
);
