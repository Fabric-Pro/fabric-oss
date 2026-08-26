import { beforeEach, expect, it, vi } from "vitest";

vi.mock("../prisma/client", () => ({
	db: {
		templateInstanceExecution: { findUnique: vi.fn(), updateMany: vi.fn() },
		user: { findUnique: vi.fn() },
		member: { findUnique: vi.fn() },
		organization: { findUnique: vi.fn() },
	},
}));
vi.mock("../prisma/queries/notification-preferences", () => ({
	getNotificationPreferences: vi.fn(),
}));

import { db } from "../prisma/client";
import { getNotificationPreferences } from "../prisma/queries/notification-preferences";
import { claimReportExecutionEmail } from "../prisma/queries/report-execution-email";

const baseExec = {
	status: "COMPLETED",
	userId: "u1",
	organizationId: null,
	instanceId: "inst1",
	emailSentAt: null,
	instance: { name: "Q3 Report" },
};

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(db.templateInstanceExecution.findUnique).mockResolvedValue({
		...baseExec,
	} as any);
	vi.mocked(db.user.findUnique).mockResolvedValue({
		email: "owner@x.com",
	} as any);
	vi.mocked(getNotificationPreferences).mockResolvedValue({
		reportEmails: true,
	} as any);
	vi.mocked(db.templateInstanceExecution.updateMany).mockResolvedValue({
		count: 1,
	} as any);
});

it("returns context and claims on the happy personal path", async () => {
	const ctx = await claimReportExecutionEmail({
		executionId: "e1",
		status: "COMPLETED",
	});
	expect(ctx).toMatchObject({
		recipientEmail: "owner@x.com",
		instanceName: "Q3 Report",
		organizationSlug: null,
	});
	expect(db.templateInstanceExecution.updateMany).toHaveBeenCalledWith(
		expect.objectContaining({
			where: { id: "e1", emailSentAt: null, status: "COMPLETED" },
		}),
	);
});

it("skips when the persisted status no longer matches", async () => {
	vi.mocked(db.templateInstanceExecution.findUnique).mockResolvedValue({
		...baseExec,
		status: "RUNNING",
	} as any);
	expect(
		await claimReportExecutionEmail({
			executionId: "e1",
			status: "COMPLETED",
		}),
	).toBeNull();
	expect(db.templateInstanceExecution.updateMany).not.toHaveBeenCalled();
});

it("skips when already claimed (emailSentAt set)", async () => {
	vi.mocked(db.templateInstanceExecution.findUnique).mockResolvedValue({
		...baseExec,
		emailSentAt: new Date(),
	} as any);
	expect(
		await claimReportExecutionEmail({
			executionId: "e1",
			status: "COMPLETED",
		}),
	).toBeNull();
});

it("skips when reportEmails is off", async () => {
	vi.mocked(getNotificationPreferences).mockResolvedValue({
		reportEmails: false,
	} as any);
	expect(
		await claimReportExecutionEmail({
			executionId: "e1",
			status: "COMPLETED",
		}),
	).toBeNull();
	expect(db.templateInstanceExecution.updateMany).not.toHaveBeenCalled();
});

it("skips an org run whose owner is no longer a member (no leak, no claim)", async () => {
	vi.mocked(db.templateInstanceExecution.findUnique).mockResolvedValue({
		...baseExec,
		organizationId: "org1",
	} as any);
	vi.mocked(db.member.findUnique).mockResolvedValue(null as any);
	expect(
		await claimReportExecutionEmail({
			executionId: "e1",
			status: "COMPLETED",
		}),
	).toBeNull();
	expect(db.templateInstanceExecution.updateMany).not.toHaveBeenCalled();
});

it("resolves the org slug for a still-member org run", async () => {
	vi.mocked(db.templateInstanceExecution.findUnique).mockResolvedValue({
		...baseExec,
		organizationId: "org1",
	} as any);
	vi.mocked(db.member.findUnique).mockResolvedValue({ id: "m1" } as any);
	vi.mocked(db.organization.findUnique).mockResolvedValue({
		slug: "acme",
	} as any);
	const ctx = await claimReportExecutionEmail({
		executionId: "e1",
		status: "COMPLETED",
	});
	expect(ctx?.organizationSlug).toBe("acme");
});

it("skips an org run whose organization has no slug (cannot build org link, no claim)", async () => {
	vi.mocked(db.templateInstanceExecution.findUnique).mockResolvedValue({
		...baseExec,
		organizationId: "org1",
	} as any);
	vi.mocked(db.member.findUnique).mockResolvedValue({ id: "m1" } as any);
	vi.mocked(db.organization.findUnique).mockResolvedValue({
		slug: null,
	} as any);
	expect(
		await claimReportExecutionEmail({
			executionId: "e1",
			status: "COMPLETED",
		}),
	).toBeNull();
	expect(db.templateInstanceExecution.updateMany).not.toHaveBeenCalled();
});

it("skips when the atomic claim is lost (count===0)", async () => {
	vi.mocked(db.templateInstanceExecution.updateMany).mockResolvedValue({
		count: 0,
	} as any);
	expect(
		await claimReportExecutionEmail({
			executionId: "e1",
			status: "COMPLETED",
		}),
	).toBeNull();
});
