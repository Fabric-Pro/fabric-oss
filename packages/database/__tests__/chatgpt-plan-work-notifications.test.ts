/**
 * Notices for background work paused or stopped by spent ChatGPT plans
 * (Fizzy #3050): one in-app row per recipient — the member who started the
 * work plus the organization's owners and admins — deduped per run and
 * recipient; never throws.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
	projectScan: { findUnique: vi.fn() },
	scanFindingReview: { findUnique: vi.fn() },
	scanFindingGrouping: { findUnique: vi.fn() },
	agentTask: { findUnique: vi.fn() },
	atlasAnalysisRun: { findUnique: vi.fn() },
	project: { findFirst: vi.fn() },
	member: { findMany: vi.fn() },
	notification: { create: vi.fn() },
}));

vi.mock("../prisma/client", () => ({
	db,
	NotificationCategory: { SYSTEM: "SYSTEM" },
	NotificationType: {
		CHATGPT_PLAN_WORK_PAUSED: "CHATGPT_PLAN_WORK_PAUSED",
		CHATGPT_PLAN_WORK_STOPPED: "CHATGPT_PLAN_WORK_STOPPED",
	},
}));

import {
	describeDelay,
	notifyBulkRunPlanPaused,
	notifyBulkRunPlanStopped,
	notifyPlanWaitWorkStopped,
	PLAN_WORK_PAUSED_TITLE,
	PLAN_WORK_STOPPED_TITLE,
	resolvePlanWorkRecipients,
} from "../prisma/queries/chatgpt-plan-work-notifications";

const NOW = new Date("2026-10-15T12:00:00.000Z");

function rows() {
	return db.notification.create.mock.calls.map((call) => call[0].data);
}

function recipients() {
	return rows()
		.map((row) => row.userId)
		.sort();
}

beforeEach(() => {
	vi.clearAllMocks();
	db.member.findMany.mockResolvedValue([
		{ userId: "owner-1", role: "owner" },
		{ userId: "admin-1", role: "admin" },
		{ userId: "member-1", role: "member" },
		{ userId: "member-2", role: "member" },
	]);
	db.project.findFirst.mockResolvedValue({ id: "proj-1", name: "Atlas Web" });
	db.notification.create.mockResolvedValue({});
	db.projectScan.findUnique.mockResolvedValue({
		userId: "member-1",
		organizationId: "org-1",
		projectId: "proj-1",
		trigger: "MANUAL",
	});
});

describe("resolvePlanWorkRecipients", () => {
	it("is the initiator plus owners and admins, each once", async () => {
		await expect(
			resolvePlanWorkRecipients({
				organizationId: "org-1",
				initiatorUserId: "member-1",
			}),
		).resolves.toEqual(["owner-1", "admin-1", "member-1"]);
	});

	it("does not list an admin twice when the admin started the work", async () => {
		await expect(
			resolvePlanWorkRecipients({
				organizationId: "org-1",
				initiatorUserId: "admin-1",
			}),
		).resolves.toEqual(["owner-1", "admin-1"]);
	});

	it("is owners and admins alone for scheduled work", async () => {
		await expect(
			resolvePlanWorkRecipients({
				organizationId: "org-1",
				initiatorUserId: null,
			}),
		).resolves.toEqual(["owner-1", "admin-1"]);
	});

	it("leaves out an initiator who is no longer a member", async () => {
		await expect(
			resolvePlanWorkRecipients({
				organizationId: "org-1",
				initiatorUserId: "former-1",
			}),
		).resolves.toEqual(["owner-1", "admin-1"]);
	});

	it("reaches only the initiator for work with no organization", async () => {
		await expect(
			resolvePlanWorkRecipients({
				organizationId: null,
				initiatorUserId: "member-1",
			}),
		).resolves.toEqual(["member-1"]);
		expect(db.member.findMany).not.toHaveBeenCalled();
	});
});

describe("notifyBulkRunPlanPaused", () => {
	it("tells the initiator and the admins when the run continues, and links its tab", async () => {
		await notifyBulkRunPlanPaused({
			kind: "PROJECT_SCAN",
			runId: "scan-1",
			resumesAt: new Date(NOW.getTime() + 2 * 60 * 60_000),
			now: NOW,
		});

		expect(recipients()).toEqual(["admin-1", "member-1", "owner-1"]);
		expect(db.project.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "proj-1", organizationId: "org-1" },
			}),
		);
		expect(rows()[0]).toMatchObject({
			organizationId: "org-1",
			projectId: "proj-1",
			type: "CHATGPT_PLAN_WORK_PAUSED",
			category: "SYSTEM",
			title: PLAN_WORK_PAUSED_TITLE,
			snippet:
				'A security and accessibility scan in "Atlas Web" is paused until about 2 hours from now, waiting for a ChatGPT plan to reset. It continues automatically.',
			link: "projects/proj-1?tab=security",
			payload: {
				work: "PROJECT_SCAN",
				runId: "scan-1",
				projectId: "proj-1",
				projectName: "Atlas Web",
				resumesAt: "2026-10-15T14:00:00.000Z",
			},
		});
		expect(rows().map((row) => row.dedupeKey)).toContain(
			"chatgptPlanWorkPaused:scan-1:member-1",
		);
	});

	it("tells only the admins about a scan nobody clicked", async () => {
		db.projectScan.findUnique.mockResolvedValue({
			userId: "member-1",
			organizationId: "org-1",
			projectId: "proj-1",
			trigger: "MATURATION_GATE",
		});
		await notifyBulkRunPlanPaused({
			kind: "PROJECT_SCAN",
			runId: "scan-1",
			resumesAt: NOW,
			now: NOW,
		});
		expect(recipients()).toEqual(["admin-1", "owner-1"]);
	});

	it("reads an Atlas run's initiator from who triggered it, not its owner", async () => {
		db.atlasAnalysisRun.findUnique.mockResolvedValue({
			triggeredByUserId: "member-2",
			organizationId: "org-1",
			projectId: "proj-1",
		});
		await notifyBulkRunPlanPaused({
			kind: "ATLAS_ANALYSIS",
			runId: "atlas-1",
			resumesAt: NOW,
			now: NOW,
		});
		expect(recipients()).toEqual(["admin-1", "member-2", "owner-1"]);
		expect(rows()[0].link).toBe("projects/proj-1?tab=atlas");
	});

	it("reads an AgentTask run's project from its input", async () => {
		db.agentTask.findUnique.mockResolvedValue({
			userId: "member-1",
			organizationId: "org-1",
			input: { projectId: "proj-1" },
		});
		await notifyBulkRunPlanPaused({
			kind: "PROJECT_SETUP",
			runId: "task-1",
			resumesAt: NOW,
			now: NOW,
		});
		expect(rows()[0].link).toBe("projects/proj-1");
	});

	it("writes nothing for a run that is gone", async () => {
		db.projectScan.findUnique.mockResolvedValue(null);
		await notifyBulkRunPlanPaused({
			kind: "PROJECT_SCAN",
			runId: "scan-1",
			resumesAt: NOW,
		});
		expect(db.notification.create).not.toHaveBeenCalled();
	});
});

describe("notifyBulkRunPlanStopped", () => {
	it("says the plans stayed spent and what to do, past the pause cap", async () => {
		await notifyBulkRunPlanStopped({
			kind: "PROJECT_SCAN",
			runId: "scan-1",
			reason: "PLAN_SPENT",
		});
		expect(rows()[0]).toMatchObject({
			type: "CHATGPT_PLAN_WORK_STOPPED",
			title: PLAN_WORK_STOPPED_TITLE,
			snippet:
				'A security and accessibility scan in "Atlas Web" stopped because every ChatGPT plan it may use stayed spent. Run it again later, or ask an admin to let background work use the organization\'s AI provider.',
			link: "projects/proj-1?tab=security",
			payload: { reason: "PLAN_SPENT", runId: "scan-1" },
			dedupeKey: expect.stringMatching(/^chatgptPlanWorkStopped:scan-1:/),
		});
	});

	it("says the resume never started when the sweep failed the run", async () => {
		await notifyBulkRunPlanStopped({
			kind: "PROJECT_SCAN",
			runId: "scan-1",
			reason: "RESUME_LOST",
		});
		expect(rows()[0].snippet).toBe(
			'A security and accessibility scan in "Atlas Web" stopped: it was waiting for a ChatGPT plan to reset, but its resume never started. Run it again.',
		);
		expect(rows()[0].payload.reason).toBe("RESUME_LOST");
	});
});

describe("notifyPlanWaitWorkStopped", () => {
	it("tells the initiator and admins, linking the project by default", async () => {
		await notifyPlanWaitWorkStopped({
			work: "DAILY_BRIEF",
			runId: "wf-1:run-1",
			organizationId: "org-1",
			initiatorUserId: "member-2",
			projectId: "proj-1",
		});
		expect(recipients()).toEqual(["admin-1", "member-2", "owner-1"]);
		expect(rows()[0]).toMatchObject({
			snippet: expect.stringMatching(
				/^A daily brief in "Atlas Web" stopped because every ChatGPT plan/,
			),
			link: "projects/proj-1",
			payload: { work: "DAILY_BRIEF", runId: "wf-1:run-1" },
		});
	});

	it("keeps a caller's link, and works without a project", async () => {
		await notifyPlanWaitWorkStopped({
			work: "SCHEDULED_REPORT",
			runId: "wf-2:run-1",
			organizationId: "org-1",
			initiatorUserId: null,
			link: "workflows/wf-2",
		});
		expect(db.project.findFirst).not.toHaveBeenCalled();
		expect(rows()[0]).toMatchObject({
			snippet: expect.stringMatching(/^A scheduled report stopped/),
			link: "workflows/wf-2",
		});
		expect(rows()[0].projectId).toBeUndefined();
	});
});

describe("never throws", () => {
	it("leaves an unread duplicate standing and survives a failed row or lookup", async () => {
		db.notification.create.mockRejectedValueOnce(
			Object.assign(new Error("dup"), { code: "P2002" }),
		);
		db.notification.create.mockRejectedValueOnce(new Error("db down"));
		await expect(
			notifyBulkRunPlanStopped({
				kind: "PROJECT_SCAN",
				runId: "scan-1",
				reason: "PLAN_SPENT",
			}),
		).resolves.toBeUndefined();
		expect(db.notification.create).toHaveBeenCalledTimes(3);

		db.member.findMany.mockRejectedValueOnce(new Error("db down"));
		await expect(
			notifyPlanWaitWorkStopped({
				work: "NEWSLETTER",
				runId: "wf-3:run-1",
				organizationId: "org-1",
				initiatorUserId: null,
			}),
		).resolves.toBeUndefined();

		db.projectScan.findUnique.mockRejectedValueOnce(new Error("db down"));
		await expect(
			notifyBulkRunPlanPaused({
				kind: "PROJECT_SCAN",
				runId: "scan-1",
				resumesAt: NOW,
			}),
		).resolves.toBeUndefined();
	});
});

describe("describeDelay", () => {
	it("rounds to minutes under an hour and hours above", () => {
		expect(describeDelay(30_000)).toBe("1 minute");
		expect(describeDelay(45 * 60_000)).toBe("45 minutes");
		expect(describeDelay(60 * 60_000)).toBe("1 hour");
		expect(describeDelay(5.4 * 60 * 60_000)).toBe("5 hours");
	});
});
