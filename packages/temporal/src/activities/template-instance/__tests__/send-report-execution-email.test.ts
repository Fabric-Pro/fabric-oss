import { beforeEach, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({ claimReportExecutionEmail: vi.fn() }));
vi.mock("@repo/mail", () => ({
	isMailConfigured: vi.fn(() => true),
	sendEmail: vi.fn(() => Promise.resolve(true)),
}));
vi.mock("@repo/utils", () => ({
	getBaseUrl: vi.fn(() => "https://fabric.pro"),
}));

import { claimReportExecutionEmail } from "@repo/database";
import { isMailConfigured, sendEmail } from "@repo/mail";
import { getBaseUrl } from "@repo/utils";
import { sendReportExecutionEmail } from "../send-report-execution-email";

const ctx = {
	recipientEmail: "o@x.com",
	instanceName: "Q3",
	instanceId: "i1",
	organizationId: null,
	organizationSlug: null,
	status: "COMPLETED" as const,
};

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(isMailConfigured).mockReturnValue(true);
	vi.mocked(sendEmail).mockResolvedValue(true);
	vi.mocked(getBaseUrl).mockReturnValue("https://fabric.pro");
});

it("throws (pre-claim) when mail is not configured", async () => {
	vi.mocked(isMailConfigured).mockReturnValue(false);
	await expect(
		sendReportExecutionEmail({ executionId: "e1", status: "COMPLETED" }),
	).rejects.toThrow();
	expect(claimReportExecutionEmail).not.toHaveBeenCalled();
});

it("does nothing when the gate returns null", async () => {
	vi.mocked(claimReportExecutionEmail).mockResolvedValue(null);
	await sendReportExecutionEmail({ executionId: "e1", status: "COMPLETED" });
	expect(sendEmail).not.toHaveBeenCalled();
});

it("sends the ready template with personal overview URL + idempotency key", async () => {
	vi.mocked(claimReportExecutionEmail).mockResolvedValue(ctx);
	await sendReportExecutionEmail({ executionId: "e1", status: "COMPLETED" });
	expect(sendEmail).toHaveBeenCalledWith(
		expect.objectContaining({
			to: "o@x.com",
			templateId: "reportExecutionReady",
			idempotencyKey: "report-email-e1-COMPLETED",
			context: {
				instanceName: "Q3",
				url: "https://fabric.pro/app/report-templates/instances/i1?tab=overview",
			},
		}),
	);
});

it("uses the org slug + history tab on failure", async () => {
	vi.mocked(claimReportExecutionEmail).mockResolvedValue({
		...ctx,
		status: "FAILED",
		organizationId: "org1",
		organizationSlug: "acme",
	});
	await sendReportExecutionEmail({ executionId: "e1", status: "FAILED" });
	expect(sendEmail).toHaveBeenCalledWith(
		expect.objectContaining({
			templateId: "reportExecutionFailed",
			context: {
				instanceName: "Q3",
				url: "https://fabric.pro/app/acme/report-templates/instances/i1?tab=history",
			},
		}),
	);
});

it("does not throw when sendEmail returns false (drop, claim already taken)", async () => {
	vi.mocked(claimReportExecutionEmail).mockResolvedValue(ctx);
	vi.mocked(sendEmail).mockResolvedValue(false);
	await expect(
		sendReportExecutionEmail({ executionId: "e1", status: "COMPLETED" }),
	).resolves.toBeUndefined();
});

it("normalizes a trailing slash in the base URL (no double slash)", async () => {
	vi.mocked(getBaseUrl).mockReturnValue("https://fabric.pro/");
	vi.mocked(claimReportExecutionEmail).mockResolvedValue(ctx);
	await sendReportExecutionEmail({ executionId: "e1", status: "COMPLETED" });
	expect(sendEmail).toHaveBeenCalledWith(
		expect.objectContaining({
			context: {
				instanceName: "Q3",
				url: "https://fabric.pro/app/report-templates/instances/i1?tab=overview",
			},
		}),
	);
});
