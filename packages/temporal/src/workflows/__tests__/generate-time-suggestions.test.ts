import { beforeEach, describe, expect, it, vi } from "vitest";

const activityStubs = vi.hoisted(() => ({
	collectTimeSuggestionCandidatesActivity: vi.fn(),
	draftTimeSuggestionsActivity: vi.fn(),
	persistTimeSuggestionsActivity: vi.fn(),
	markTimeSuggestionRunFailedActivity: vi.fn(),
}));

vi.mock("@temporalio/workflow", () => ({
	proxyActivities: vi.fn(() => activityStubs),
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
	generateTimeSuggestionsWorkflow,
	TIME_SUGGESTION_RUN_FAILED_MESSAGE,
} from "../generate-time-suggestions";

const INPUT = {
	runId: "run-1",
	organizationId: "org-1",
	userId: "user-1",
	fromDate: "2026-11-04",
	toDate: "2026-11-10",
	timezone: "Europe/Berlin",
	projects: [{ id: "project-a", name: "Project A" }],
};

const CANDIDATE = {
	workDate: "2026-11-05",
	projectId: "project-a",
	projectName: "Project A",
	storyId: null,
	storyIdentifier: null,
	storyTitle: null,
	activity: "TESTING",
	durationMinutes: null,
	startAt: null,
	stopAt: null,
	evidence: [],
};
const DRAFT = { description: "Testing", activity: "TESTING" };

beforeEach(() => {
	vi.clearAllMocks();
	activityStubs.collectTimeSuggestionCandidatesActivity.mockResolvedValue([
		CANDIDATE,
	]);
	activityStubs.draftTimeSuggestionsActivity.mockResolvedValue([DRAFT]);
	activityStubs.persistTimeSuggestionsActivity.mockResolvedValue({
		persisted: true,
		createdCount: 1,
	});
	activityStubs.markTimeSuggestionRunFailedActivity.mockResolvedValue(
		undefined,
	);
});

describe("generateTimeSuggestionsWorkflow", () => {
	it("collects, drafts and stores, in that order", async () => {
		const result = await generateTimeSuggestionsWorkflow(INPUT);

		expect(result).toEqual({ status: "DONE", createdCount: 1 });
		expect(
			activityStubs.collectTimeSuggestionCandidatesActivity,
		).toHaveBeenCalledWith({
			organizationId: "org-1",
			userId: "user-1",
			fromDate: "2026-11-04",
			toDate: "2026-11-10",
			timezone: "Europe/Berlin",
			projects: [{ id: "project-a", name: "Project A" }],
		});
		expect(
			activityStubs.persistTimeSuggestionsActivity,
		).toHaveBeenCalledWith({
			runId: "run-1",
			organizationId: "org-1",
			userId: "user-1",
			timezone: "Europe/Berlin",
			candidates: [CANDIDATE],
			drafts: [DRAFT],
		});
		expect(
			activityStubs.markTimeSuggestionRunFailedActivity,
		).not.toHaveBeenCalled();
	});

	it("never throws to the fire-and-forget caller; marks the run FAILED instead", async () => {
		activityStubs.collectTimeSuggestionCandidatesActivity.mockRejectedValue(
			new Error("database unreachable"),
		);

		const result = await generateTimeSuggestionsWorkflow(INPUT);

		expect(result).toEqual({ status: "FAILED", createdCount: 0 });
		expect(
			activityStubs.persistTimeSuggestionsActivity,
		).not.toHaveBeenCalled();
		expect(
			activityStubs.markTimeSuggestionRunFailedActivity,
		).toHaveBeenCalledWith({
			runId: "run-1",
			organizationId: "org-1",
			userId: "user-1",
			message: TIME_SUGGESTION_RUN_FAILED_MESSAGE,
		});
	});

	it("marks the run FAILED when storing fails", async () => {
		activityStubs.persistTimeSuggestionsActivity.mockRejectedValue(
			new Error("transaction timed out"),
		);

		await expect(generateTimeSuggestionsWorkflow(INPUT)).resolves.toEqual({
			status: "FAILED",
			createdCount: 0,
		});
		expect(
			activityStubs.markTimeSuggestionRunFailedActivity,
		).toHaveBeenCalledTimes(1);
	});

	it("stays silent when even the failure marker cannot be written", async () => {
		activityStubs.draftTimeSuggestionsActivity.mockRejectedValue(
			new Error("activity timed out"),
		);
		activityStubs.markTimeSuggestionRunFailedActivity.mockRejectedValue(
			new Error("database unreachable"),
		);

		await expect(generateTimeSuggestionsWorkflow(INPUT)).resolves.toEqual({
			status: "FAILED",
			createdCount: 0,
		});
	});

	it("does not mark a reclaimed run failed", async () => {
		activityStubs.persistTimeSuggestionsActivity.mockResolvedValue({
			persisted: false,
			createdCount: 0,
		});

		await expect(generateTimeSuggestionsWorkflow(INPUT)).resolves.toEqual({
			status: "SUPERSEDED",
			createdCount: 0,
		});
		expect(
			activityStubs.markTimeSuggestionRunFailedActivity,
		).not.toHaveBeenCalled();
	});
});
