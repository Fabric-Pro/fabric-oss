/**
 * Suggesting time after a member's own meeting ends, and after Fabric reads
 * a new head commit of a pull request they authored.
 *
 * The `@repo/database` queries, `@repo/temporal` and the logger are mocked;
 * the access rules, the project-type rule and the shared run starter run for
 * real, so this covers the path finalization takes end to end.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findMemberByGitHubLogin: vi.fn(),
	listTimeAccessRows: vi.fn(),
	listMemberTimeZoneCandidates: vi.fn(),
	startTimeSuggestionRun: vi.fn(),
	failTimeSuggestionRun: vi.fn(),
	isTemporalAvailable: vi.fn(),
	workflowStart: vi.fn(),
	logInfo: vi.fn(),
	logWarn: vi.fn(),
}));

vi.mock("@repo/database", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		findMemberByGitHubLogin: mocks.findMemberByGitHubLogin,
		listTimeAccessRows: mocks.listTimeAccessRows,
		listMemberTimeZoneCandidates: mocks.listMemberTimeZoneCandidates,
		startTimeSuggestionRun: mocks.startTimeSuggestionRun,
		failTimeSuggestionRun: mocks.failTimeSuggestionRun,
	};
});

vi.mock("@repo/temporal", () => ({
	isTemporalAvailable: mocks.isTemporalAvailable,
	getTemporalClient: async () => ({
		workflow: { start: mocks.workflowStart },
	}),
}));

vi.mock("@repo/logs", () => ({
	logger: {
		info: mocks.logInfo,
		warn: mocks.logWarn,
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

vi.mock("../../../../orpc/middleware/project-visibility", () => ({
	PROJECT_NOT_FOUND_MESSAGE: "Project not found",
}));

const {
	startTimeSuggestionsAfterMeeting,
	startTimeSuggestionsAfterPullRequest,
} = await import("../automatic-suggestions");

const ORG_ID = "org-1";
const USER_ID = "user-1";
const policyOff = { timeRequireStartStop: false, timeDefaultBillable: null };
const activeMember = {
	role: "EDITOR",
	acceptedAt: new Date("2026-01-01T00:00:00Z"),
	expiresAt: null,
};

function accessRows(
	projects: {
		id: string;
		member: typeof activeMember | null;
		billingModel: "FIXED_BID" | "TIME_AND_MATERIALS";
	}[],
) {
	return {
		organizationRole: "member",
		organization: policyOff,
		projects: projects.map((p) => ({
			...p,
			name: `Name of ${p.id}`,
			...policyOff,
			ownedByCaller: false,
		})),
	};
}

/** 23:30 UTC on the 10th: already the 11th in Berlin. */
const meeting = {
	sessionId: "session-1",
	organizationId: ORG_ID,
	userId: USER_ID,
	projectId: "project-a",
	joinedAt: new Date("2026-11-10T23:30:00Z"),
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.listTimeAccessRows.mockResolvedValue(
		accessRows([
			{
				id: "project-a",
				member: activeMember,
				billingModel: "TIME_AND_MATERIALS",
			},
			{
				id: "project-b",
				member: activeMember,
				billingModel: "TIME_AND_MATERIALS",
			},
		]),
	);
	mocks.listMemberTimeZoneCandidates.mockResolvedValue(["Europe/Berlin"]);
	mocks.isTemporalAvailable.mockResolvedValue(true);
	mocks.startTimeSuggestionRun.mockResolvedValue({
		status: "started",
		runId: "run-1",
	});
	mocks.workflowStart.mockResolvedValue(undefined);
	mocks.findMemberByGitHubLogin.mockResolvedValue(USER_ID);
});

describe("startTimeSuggestionsAfterMeeting", () => {
	it("starts a run over the meeting's work date in the member's time zone, on its project only", async () => {
		await startTimeSuggestionsAfterMeeting(meeting);

		expect(mocks.listMemberTimeZoneCandidates).toHaveBeenCalledWith({
			organizationId: ORG_ID,
			userId: USER_ID,
		});
		expect(mocks.startTimeSuggestionRun).toHaveBeenCalledWith({
			organizationId: ORG_ID,
			userId: USER_ID,
			fromDate: "2026-11-11",
			toDate: "2026-11-11",
			timezone: "Europe/Berlin",
			automatic: true,
		});
		expect(mocks.workflowStart).toHaveBeenCalledWith(
			"generateTimeSuggestionsWorkflow",
			expect.objectContaining({
				workflowId: "time-suggestions:run-1",
				args: [
					expect.objectContaining({
						projects: [
							{ id: "project-a", name: "Name of project-a" },
						],
					}),
				],
			}),
		);
	});

	it("takes the first valid stored time zone", async () => {
		mocks.listMemberTimeZoneCandidates.mockResolvedValue([
			"Mars/Olympus",
			"America/New_York",
			"Europe/Berlin",
		]);

		await startTimeSuggestionsAfterMeeting(meeting);

		// 23:30 UTC is still the 10th in New York.
		expect(mocks.startTimeSuggestionRun).toHaveBeenCalledWith(
			expect.objectContaining({
				fromDate: "2026-11-10",
				toDate: "2026-11-10",
				timezone: "America/New_York",
			}),
		);
	});

	it("starts nothing for a fixed bid project", async () => {
		mocks.listTimeAccessRows.mockResolvedValue(
			accessRows([
				{
					id: "project-a",
					member: activeMember,
					billingModel: "FIXED_BID",
				},
				{
					id: "project-b",
					member: activeMember,
					billingModel: "TIME_AND_MATERIALS",
				},
			]),
		);

		await startTimeSuggestionsAfterMeeting(meeting);

		expect(mocks.startTimeSuggestionRun).not.toHaveBeenCalled();
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});

	it("starts nothing when the member can no longer log time on the project", async () => {
		mocks.listTimeAccessRows.mockResolvedValue(
			accessRows([
				{
					id: "project-a",
					member: null,
					billingModel: "TIME_AND_MATERIALS",
				},
			]),
		);

		await startTimeSuggestionsAfterMeeting(meeting);

		expect(mocks.startTimeSuggestionRun).not.toHaveBeenCalled();
	});

	it("starts nothing when the project is no longer active", async () => {
		// Only active projects are loggable, so an archived one is not listed.
		mocks.listTimeAccessRows.mockResolvedValue(accessRows([]));

		await startTimeSuggestionsAfterMeeting(meeting);

		expect(mocks.listTimeAccessRows).toHaveBeenCalledWith({
			organizationId: ORG_ID,
			userId: USER_ID,
			projects: "loggable",
		});
		expect(mocks.startTimeSuggestionRun).not.toHaveBeenCalled();
	});

	it("starts nothing, rather than guess, when no time zone is stored", async () => {
		mocks.listMemberTimeZoneCandidates.mockResolvedValue(["Mars/Olympus"]);

		await startTimeSuggestionsAfterMeeting(meeting);

		expect(mocks.startTimeSuggestionRun).not.toHaveBeenCalled();
		expect(mocks.logInfo).toHaveBeenCalledWith(
			"[time-suggestions] after-meeting skipped: no time zone",
			expect.objectContaining({ sessionId: "session-1" }),
		);
	});

	it("starts nothing for a bot that never got into the meeting", async () => {
		await startTimeSuggestionsAfterMeeting({ ...meeting, joinedAt: null });

		expect(mocks.listTimeAccessRows).not.toHaveBeenCalled();
		expect(mocks.startTimeSuggestionRun).not.toHaveBeenCalled();
	});

	it.each([
		["a run is already going", { status: "in_flight" }, true],
		["the worker cannot be reached", null, false],
	])(
		"logs and returns quietly when %s",
		async (_label, runResult, temporalUp) => {
			mocks.isTemporalAvailable.mockResolvedValue(temporalUp);
			if (runResult) {
				mocks.startTimeSuggestionRun.mockResolvedValue(runResult);
			}

			await expect(
				startTimeSuggestionsAfterMeeting(meeting),
			).resolves.toBeUndefined();
			expect(mocks.workflowStart).not.toHaveBeenCalled();
			expect(mocks.logWarn).not.toHaveBeenCalled();
		},
	);

	it.each([
		["the access query", () => mocks.listTimeAccessRows],
		["the time zone query", () => mocks.listMemberTimeZoneCandidates],
		["opening the run", () => mocks.startTimeSuggestionRun],
	])("never lets an error from %s escape", async (_label, failing) => {
		failing().mockRejectedValue(new Error("database is down"));

		await expect(
			startTimeSuggestionsAfterMeeting(meeting),
		).resolves.toBeUndefined();
		expect(mocks.logWarn).toHaveBeenCalledWith(
			"[time-suggestions] after-meeting start failed",
			expect.objectContaining({
				sessionId: "session-1",
				detail: "database is down",
			}),
		);
	});

	it("never lets a failed workflow start escape, and releases the run", async () => {
		mocks.workflowStart.mockRejectedValue(new Error("connection refused"));

		await expect(
			startTimeSuggestionsAfterMeeting(meeting),
		).resolves.toBeUndefined();
		expect(mocks.failTimeSuggestionRun).toHaveBeenCalledWith(
			expect.objectContaining({ runId: "run-1" }),
		);
		expect(mocks.logWarn).toHaveBeenCalledOnce();
	});
});

/** 23:30 UTC on the 10th: already the 11th in Berlin. */
const pullRequest = {
	reviewId: "review-1",
	organizationId: ORG_ID,
	projectId: "project-a",
	provider: "GITHUB",
	prUrl: "https://github.com/example-org/example-repo/pull/7",
	authorLabel: "Octo-Example",
	createdAt: new Date("2026-11-10T23:30:00Z"),
};

describe("startTimeSuggestionsAfterPullRequest", () => {
	it("starts a run for the author over the read's work date, on its project only", async () => {
		await startTimeSuggestionsAfterPullRequest(pullRequest);

		expect(mocks.findMemberByGitHubLogin).toHaveBeenCalledWith({
			organizationId: ORG_ID,
			login: "Octo-Example",
		});
		expect(mocks.startTimeSuggestionRun).toHaveBeenCalledWith({
			organizationId: ORG_ID,
			userId: USER_ID,
			fromDate: "2026-11-11",
			toDate: "2026-11-11",
			timezone: "Europe/Berlin",
			automatic: true,
		});
		expect(mocks.workflowStart).toHaveBeenCalledWith(
			"generateTimeSuggestionsWorkflow",
			expect.objectContaining({
				args: [
					expect.objectContaining({
						projects: [
							{ id: "project-a", name: "Name of project-a" },
						],
					}),
				],
			}),
		);
	});

	it("starts nothing for a fixed bid project", async () => {
		mocks.listTimeAccessRows.mockResolvedValue(
			accessRows([
				{
					id: "project-a",
					member: activeMember,
					billingModel: "FIXED_BID",
				},
				{
					id: "project-b",
					member: activeMember,
					billingModel: "TIME_AND_MATERIALS",
				},
			]),
		);

		await startTimeSuggestionsAfterPullRequest(pullRequest);

		expect(mocks.startTimeSuggestionRun).not.toHaveBeenCalled();
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});

	it("starts nothing when the author can no longer log time on the project", async () => {
		mocks.listTimeAccessRows.mockResolvedValue(
			accessRows([
				{
					id: "project-a",
					member: null,
					billingModel: "TIME_AND_MATERIALS",
				},
			]),
		);

		await startTimeSuggestionsAfterPullRequest(pullRequest);

		expect(mocks.startTimeSuggestionRun).not.toHaveBeenCalled();
	});

	it("starts nothing when the login names no single member", async () => {
		mocks.findMemberByGitHubLogin.mockResolvedValue(null);

		await startTimeSuggestionsAfterPullRequest(pullRequest);

		expect(mocks.listTimeAccessRows).not.toHaveBeenCalled();
		expect(mocks.startTimeSuggestionRun).not.toHaveBeenCalled();
		expect(mocks.logInfo).toHaveBeenCalledWith(
			"[time-suggestions] after-pull-request skipped: author is not one member",
			expect.objectContaining({ reviewId: "review-1" }),
		);
	});

	it.each([
		["a GitLab merge request", { provider: "GITLAB" }],
		["an Azure DevOps pull request", { provider: "AZURE_DEVOPS" }],
		[
			"a GitHub Enterprise pull request",
			{
				prUrl: "https://git.example.com/example-org/example-repo/pull/7",
			},
		],
		["a pull request with no web address", { prUrl: null }],
		["a pull request with no author", { authorLabel: null }],
		["a personal project", { organizationId: null }],
	])("never attributes %s", async (_label, change) => {
		await startTimeSuggestionsAfterPullRequest({
			...pullRequest,
			...change,
		});

		expect(mocks.findMemberByGitHubLogin).not.toHaveBeenCalled();
		expect(mocks.startTimeSuggestionRun).not.toHaveBeenCalled();
	});

	it.each([
		["the login lookup", () => mocks.findMemberByGitHubLogin],
		["the access query", () => mocks.listTimeAccessRows],
		["the time zone query", () => mocks.listMemberTimeZoneCandidates],
		["opening the run", () => mocks.startTimeSuggestionRun],
	])("never lets an error from %s escape", async (_label, failing) => {
		failing().mockRejectedValue(new Error("database is down"));

		await expect(
			startTimeSuggestionsAfterPullRequest(pullRequest),
		).resolves.toBeUndefined();
		expect(mocks.logWarn).toHaveBeenCalledWith(
			"[time-suggestions] after-pull-request start failed",
			expect.objectContaining({
				reviewId: "review-1",
				detail: "database is down",
			}),
		);
	});

	it("never lets a failed workflow start escape", async () => {
		mocks.workflowStart.mockRejectedValue(new Error("connection refused"));

		await expect(
			startTimeSuggestionsAfterPullRequest(pullRequest),
		).resolves.toBeUndefined();
		expect(mocks.failTimeSuggestionRun).toHaveBeenCalledWith(
			expect.objectContaining({ runId: "run-1" }),
		);
		expect(mocks.logWarn).toHaveBeenCalledOnce();
	});
});
