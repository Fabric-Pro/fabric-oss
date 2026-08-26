import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
	completeTestCaseDraftJob: vi.fn(async () => true),
	markTestCaseDraftJobRunning: vi.fn(),
	parseFeatureOutcomes: vi.fn(() => []),
	recordTestCaseDraftFeatureOutcome: vi.fn(),
}));
vi.mock("@repo/database/prisma/client", () => ({
	db: {
		testCaseDraftJob: { findUnique: vi.fn() },
		notification: { create: vi.fn(), updateMany: vi.fn() },
		organization: { findUnique: vi.fn(async () => ({ slug: "acme" })) },
	},
}));
vi.mock("@repo/database/prisma/generated/enums", () => ({
	NotificationCategory: { PROJECT: "PROJECT" },
	NotificationType: { TEST_CASES_DRAFTED: "TEST_CASES_DRAFTED" },
}));
vi.mock("@repo/database/prisma/queries/notification-preferences", () => ({
	getNotificationPreferences: vi.fn(async () => null),
	isCategoryEnabled: vi.fn(() => true),
}));
vi.mock("@repo/logs", () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import {
	completeTestCaseDraftJob,
	parseFeatureOutcomes,
	type TestCaseDraftFeatureOutcome,
} from "@repo/database";
import { db } from "@repo/database/prisma/client";
import {
	describeFailedDraftRun,
	finalizeTestCaseDraftJob,
} from "../test-case-draft-job";

const outcome = (
	overrides: Partial<TestCaseDraftFeatureOutcome> = {},
): TestCaseDraftFeatureOutcome => ({
	storyId: "s1",
	storyIdentifier: "3",
	storyTitle: "Move core data storage",
	status: "NO_ACCEPTANCE_CRITERIA",
	caseIds: [],
	...overrides,
});

describe("describeFailedDraftRun", () => {
	it("names the feature and the actionable reason for a single skip", () => {
		expect(describeFailedDraftRun([outcome()])).toBe(
			"Feature 3 has no acceptance criteria — add criteria, then draft again.",
		);
	});

	it("surfaces the recorded provider error for a single failure", () => {
		expect(
			describeFailedDraftRun([
				outcome({ status: "FAILED", error: "credit balance too low" }),
			]),
		).toBe("Feature 3 failed to generate: credit balance too low.");
	});

	it("collapses a shared cause into one collective sentence", () => {
		expect(
			describeFailedDraftRun([
				outcome(),
				outcome({ storyId: "s2", storyIdentifier: "5" }),
			]),
		).toBe(
			"None of the selected features have acceptance criteria — add criteria, then draft again.",
		);
	});

	it("surfaces the shared upstream error once for an all-FAILED batch", () => {
		expect(
			describeFailedDraftRun([
				outcome({ status: "FAILED", error: "rate limited" }),
				outcome({
					storyId: "s2",
					storyIdentifier: "5",
					status: "FAILED",
					error: "rate limited",
				}),
			]),
		).toBe("AI generation failed for every selected feature: rate limited");
	});

	it("lists mixed causes per feature", () => {
		expect(
			describeFailedDraftRun([
				outcome(),
				outcome({
					storyId: "s2",
					storyIdentifier: "5",
					status: "FAILED",
					error: "rate limited",
				}),
			]),
		).toBe(
			"Feature 3 has no acceptance criteria — add criteria, then draft again; Feature 5 failed to generate: rate limited",
		);
	});

	it("ignores DRAFTED outcomes when composing the reason", () => {
		expect(
			describeFailedDraftRun([
				outcome({ status: "DRAFTED", caseIds: ["tc1"] }),
				outcome({ storyId: "s2", storyIdentifier: "5" }),
			]),
		).toBe(
			"Feature 5 has no acceptance criteria — add criteria, then draft again.",
		);
	});

	it("labels a NOT_FOUND row without identifier or title neutrally", () => {
		expect(
			describeFailedDraftRun([
				outcome({
					storyIdentifier: "",
					storyTitle: "",
					status: "NOT_FOUND",
				}),
			]),
		).toBe("A selected feature was not found in this project.");
	});

	it("falls back to the generic text for an empty ledger", () => {
		expect(describeFailedDraftRun([])).toBe(
			"No test cases could be drafted.",
		);
	});

	it("bounds an over-long mixed listing", () => {
		const many = Array.from({ length: 20 }, (_, i) =>
			outcome({
				storyId: `s${i}`,
				storyIdentifier: `${i}`,
				status: i % 2 ? "NO_CASES" : "NO_ACCEPTANCE_CRITERIA",
			}),
		);
		const reason = describeFailedDraftRun(many);
		expect(reason.length).toBeLessThanOrEqual(301);
		expect(reason.endsWith("…")).toBe(true);
	});
});

describe("finalizeTestCaseDraftJob", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(completeTestCaseDraftJob).mockResolvedValue(true as never);
	});

	it("lands the composed reason as the job error and notification snippet", async () => {
		vi.mocked(db.testCaseDraftJob.findUnique).mockResolvedValue({
			status: "RUNNING",
			createdCaseIds: [],
			totalFeatures: 1,
			featureOutcomes: [],
		} as never);
		vi.mocked(parseFeatureOutcomes).mockReturnValue([outcome()]);

		await finalizeTestCaseDraftJob({
			jobId: "job1",
			projectId: "p1",
			userId: "u1",
		});

		const expected =
			"Feature 3 has no acceptance criteria — add criteria, then draft again.";
		expect(completeTestCaseDraftJob).toHaveBeenCalledWith({
			jobId: "job1",
			status: "FAILED",
			error: expected,
		});
		expect(db.notification.create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ snippet: expected }),
			}),
		);
	});

	it("keeps the success path's error null and snippet unchanged", async () => {
		vi.mocked(db.testCaseDraftJob.findUnique).mockResolvedValue({
			status: "RUNNING",
			createdCaseIds: ["tc1", "tc2"],
			totalFeatures: 2,
			featureOutcomes: [],
		} as never);

		await finalizeTestCaseDraftJob({
			jobId: "job1",
			projectId: "p1",
			userId: "u1",
		});

		expect(parseFeatureOutcomes).not.toHaveBeenCalled();
		expect(completeTestCaseDraftJob).toHaveBeenCalledWith({
			jobId: "job1",
			status: "SUCCEEDED",
			error: null,
		});
		expect(db.notification.create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					snippet:
						"Drafted from 2 features — review and mark them ready",
				}),
			}),
		);
	});
});
