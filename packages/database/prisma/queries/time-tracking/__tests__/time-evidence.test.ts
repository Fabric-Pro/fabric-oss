/**
 * What `collectUnclaimedTimeEvidence` reads.
 *
 * Prisma's delegates are mocked, so this pins the WHERE each source is read
 * with: the member as the author, the organization, the allowed projects and
 * the window; meetings the agent joined on its own and results synced from a
 * project-management tool left out; and evidence a suggestion already claimed
 * dropped from the result.
 *
 * Run with:
 *   pnpm --filter @repo/database test time-evidence
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	parlumeMeetingSession: { findMany: vi.fn() },
	testAgenticRun: { findMany: vi.fn() },
	featureVersion: { findMany: vi.fn() },
	testResultEvent: { findMany: vi.fn() },
	testCaseActivity: { findMany: vi.fn() },
	credential: { findMany: vi.fn() },
	pullRequestReview: { findMany: vi.fn() },
	timeSuggestionEvidence: { findMany: vi.fn() },
}));

vi.mock("../../../client", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return { ...actual, db: mocks };
});

const { collectUnclaimedTimeEvidence } = await import("../time-evidence");

const FROM = new Date("2026-11-02T00:00:00.000Z");
const TO = new Date("2026-11-09T00:00:00.000Z");
const params = {
	organizationId: "org-1",
	userId: "user-1",
	projectIds: ["project-a", "project-b"],
	from: FROM,
	to: TO,
};
const window = { gte: FROM, lt: TO };

function whereOf(delegate: { findMany: ReturnType<typeof vi.fn> }) {
	return delegate.findMany.mock.calls[0][0].where;
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.parlumeMeetingSession.findMany.mockResolvedValue([]);
	mocks.testAgenticRun.findMany.mockResolvedValue([]);
	mocks.featureVersion.findMany.mockResolvedValue([]);
	mocks.testResultEvent.findMany.mockResolvedValue([]);
	mocks.testCaseActivity.findMany.mockResolvedValue([]);
	// Reset, not just cleared: a test that stops after the member's own
	// logins leaves its queued second answer behind for the next test.
	mocks.credential.findMany.mockReset().mockResolvedValue([]);
	mocks.pullRequestReview.findMany.mockResolvedValue([]);
	mocks.timeSuggestionEvidence.findMany.mockResolvedValue([]);
});

/** The member's own credentials first, then other members' with the same login. */
function githubLogins(own: string[], heldByOthers: string[] = []) {
	mocks.credential.findMany
		.mockResolvedValueOnce(
			own.map((login) => ({ externalAccountLogin: login })),
		)
		.mockResolvedValueOnce(
			heldByOthers.map((login) => ({ externalAccountLogin: login })),
		);
}

describe("collectUnclaimedTimeEvidence", () => {
	it("reads nothing without an allowed project", async () => {
		await expect(
			collectUnclaimedTimeEvidence({ ...params, projectIds: [] }),
		).resolves.toEqual([]);
		expect(mocks.parlumeMeetingSession.findMany).not.toHaveBeenCalled();
	});

	it("reads only meetings the member had the agent join themselves", async () => {
		await collectUnclaimedTimeEvidence(params);
		expect(whereOf(mocks.parlumeMeetingSession)).toEqual({
			organizationId: "org-1",
			userId: "user-1",
			projectId: { in: ["project-a", "project-b"] },
			trigger: "MANUAL",
			joinedAt: window,
			endedAt: { not: null },
		});
	});

	it("reads test runs by the member who started them", async () => {
		await collectUnclaimedTimeEvidence(params);
		expect(whereOf(mocks.testAgenticRun)).toEqual({
			organizationId: "org-1",
			triggeredByUserId: "user-1",
			projectId: { in: ["project-a", "project-b"] },
			startedAt: window,
			finishedAt: { not: null },
		});
	});

	it("takes a finished test run as an instant at its start, never a span", async () => {
		// The run's length is machine runtime, not the member's working time.
		const startedAt = new Date("2026-11-03T09:00:00.000Z");
		mocks.testAgenticRun.findMany.mockResolvedValue([
			{
				id: "run-1",
				projectId: "project-a",
				startedAt,
				finishedAt: new Date("2026-11-03T13:00:00.000Z"),
			},
		]);

		const evidence = await collectUnclaimedTimeEvidence(params);

		expect(evidence).toEqual([
			{
				kind: "TEST_RUN",
				sourceId: "run-1",
				projectId: "project-a",
				storyId: null,
				storyIdentifier: null,
				storyTitle: null,
				occurredAt: startedAt,
				startAt: null,
				endAt: null,
			},
		]);
	});

	it("reads feature versions the member wrote, through the story's project and organization", async () => {
		// `changedBy` must equal the member's id exactly, so an agent's
		// sentinel author never counts as the member's work.
		await collectUnclaimedTimeEvidence(params);
		expect(whereOf(mocks.featureVersion)).toEqual({
			changedBy: "user-1",
			createdAt: window,
			story: {
				projectId: { in: ["project-a", "project-b"] },
				project: { organizationId: "org-1" },
			},
		});
	});

	it("reads results the member recorded, never ones synced from a PM tool", async () => {
		await collectUnclaimedTimeEvidence(params);
		expect(whereOf(mocks.testResultEvent)).toEqual({
			changedByUserId: "user-1",
			source: { not: "PM_SYNC" },
			occurredAt: window,
			testCase: {
				projectId: { in: ["project-a", "project-b"] },
				deletedAt: null,
				project: { organizationId: "org-1" },
			},
		});
	});

	it("reads test case changes the member made", async () => {
		await collectUnclaimedTimeEvidence(params);
		expect(whereOf(mocks.testCaseActivity)).toEqual({
			actorUserId: "user-1",
			occurredAt: window,
			testCase: {
				projectId: { in: ["project-a", "project-b"] },
				deletedAt: null,
				project: { organizationId: "org-1" },
			},
		});
	});

	it("maps each source to its kind, spans with their times", async () => {
		const joinedAt = new Date("2026-11-03T09:00:00.000Z");
		const endedAt = new Date("2026-11-03T10:00:00.000Z");
		const editedAt = new Date("2026-11-03T11:00:00.000Z");
		mocks.parlumeMeetingSession.findMany.mockResolvedValue([
			{ id: "meeting-1", projectId: "project-a", joinedAt, endedAt },
		]);
		mocks.featureVersion.findMany.mockResolvedValue([
			{
				id: "version-1",
				createdAt: editedAt,
				story: {
					id: "story-1",
					projectId: "project-b",
					identifier: "F-001",
					title: "Checkout",
				},
			},
		]);

		const evidence = await collectUnclaimedTimeEvidence(params);

		expect(evidence).toEqual([
			{
				kind: "MEETING_SESSION",
				sourceId: "meeting-1",
				projectId: "project-a",
				storyId: null,
				storyIdentifier: null,
				storyTitle: null,
				occurredAt: joinedAt,
				startAt: joinedAt,
				endAt: endedAt,
			},
			{
				kind: "FEATURE_EDIT",
				sourceId: "version-1",
				projectId: "project-b",
				storyId: "story-1",
				storyIdentifier: "F-001",
				storyTitle: "Checkout",
				occurredAt: editedAt,
				startAt: null,
				endAt: null,
			},
		]);
	});

	it("leaves out evidence a suggestion of the member already claimed", async () => {
		const occurredAt = new Date("2026-11-03T11:00:00.000Z");
		mocks.testResultEvent.findMany.mockResolvedValue([
			{ id: "event-1", occurredAt, testCase: { projectId: "project-a" } },
			{ id: "event-2", occurredAt, testCase: { projectId: "project-a" } },
		]);
		mocks.timeSuggestionEvidence.findMany.mockResolvedValue([
			{ kind: "TEST_RESULT", sourceId: "event-1" },
		]);

		const evidence = await collectUnclaimedTimeEvidence(params);

		expect(evidence.map((item) => item.sourceId)).toEqual(["event-2"]);
		expect(mocks.timeSuggestionEvidence.findMany).toHaveBeenCalledWith({
			where: {
				userId: "user-1",
				sourceId: { in: ["event-1", "event-2"] },
			},
			select: { kind: true, sourceId: true },
		});
	});

	it("matches a claim by kind as well as id", async () => {
		const occurredAt = new Date("2026-11-03T11:00:00.000Z");
		mocks.testCaseActivity.findMany.mockResolvedValue([
			{
				id: "shared-id",
				occurredAt,
				testCase: { projectId: "project-a" },
			},
		]);
		mocks.timeSuggestionEvidence.findMany.mockResolvedValue([
			{ kind: "TEST_RESULT", sourceId: "shared-id" },
		]);

		const evidence = await collectUnclaimedTimeEvidence(params);

		expect(evidence).toHaveLength(1);
		expect(evidence[0].kind).toBe("TEST_CASE_ACTIVITY");
	});

	describe("pull requests", () => {
		const readAt = new Date("2026-11-03T15:00:00.000Z");

		it("reads github.com pull requests whose author is the member's login, ignoring case", async () => {
			githubLogins(["Octo-Example"]);

			await collectUnclaimedTimeEvidence(params);

			expect(whereOf(mocks.pullRequestReview)).toEqual({
				organizationId: "org-1",
				projectId: { in: ["project-a", "project-b"] },
				provider: "GITHUB",
				prUrl: { startsWith: "https://github.com/" },
				createdAt: window,
				OR: [
					{
						authorLabel: {
							equals: "octo-example",
							mode: "insensitive",
						},
					},
				],
			});
		});

		it("reads only the member's own verified github.com credentials", async () => {
			githubLogins(["octo-example"]);

			await collectUnclaimedTimeEvidence(params);

			expect(mocks.credential.findMany.mock.calls[0][0].where).toEqual({
				organizationId: "org-1",
				userId: "user-1",
				provider: "GITHUB",
				kind: { not: "APP_INSTALLATION" },
				status: { not: "REVOKED" },
				origin: "https://github.com",
				externalAccountLogin: { not: null },
			});
		});

		it("reads no pull request when the member has no linked login", async () => {
			githubLogins([]);

			const evidence = await collectUnclaimedTimeEvidence(params);

			expect(evidence).toEqual([]);
			expect(mocks.pullRequestReview.findMany).not.toHaveBeenCalled();
		});

		it("reads no pull request under a login another member also holds", async () => {
			githubLogins(["octo-example"], ["OCTO-EXAMPLE"]);

			await collectUnclaimedTimeEvidence(params);

			expect(mocks.pullRequestReview.findMany).not.toHaveBeenCalled();
		});

		it("keeps a login of the member that nobody else holds", async () => {
			githubLogins(["octo-example", "example-user"], ["octo-example"]);

			await collectUnclaimedTimeEvidence(params);

			expect(whereOf(mocks.pullRequestReview).OR).toEqual([
				{
					authorLabel: {
						equals: "example-user",
						mode: "insensitive",
					},
				},
			]);
		});

		it("takes a pull request as an instant at the read, never a span", async () => {
			githubLogins(["octo-example"]);
			mocks.pullRequestReview.findMany.mockResolvedValue([
				{ id: "review-1", projectId: "project-a", createdAt: readAt },
			]);

			const evidence = await collectUnclaimedTimeEvidence(params);

			expect(evidence).toEqual([
				{
					kind: "PULL_REQUEST",
					sourceId: "review-1",
					projectId: "project-a",
					storyId: null,
					storyIdentifier: null,
					storyTitle: null,
					occurredAt: readAt,
					startAt: null,
					endAt: null,
				},
			]);
		});

		it("leaves out a pull request a suggestion already claimed", async () => {
			githubLogins(["octo-example"]);
			mocks.pullRequestReview.findMany.mockResolvedValue([
				{ id: "review-1", projectId: "project-a", createdAt: readAt },
				{ id: "review-2", projectId: "project-a", createdAt: readAt },
			]);
			mocks.timeSuggestionEvidence.findMany.mockResolvedValue([
				{ kind: "PULL_REQUEST", sourceId: "review-1" },
			]);

			const evidence = await collectUnclaimedTimeEvidence(params);

			expect(evidence.map((item) => item.sourceId)).toEqual(["review-2"]);
		});
	});
});
