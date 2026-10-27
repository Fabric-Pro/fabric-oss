import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findMany: vi.fn(),
	findFirst: vi.fn(),
	updateMany: vi.fn(),
	isFeatureEnabled: vi.fn(),
	teamsTool: vi.fn(),
	workflowStart: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		projectLinkedMeeting: {
			findMany: mocks.findMany,
			findFirst: mocks.findFirst,
			updateMany: mocks.updateMany,
		},
	},
	isFeatureEnabled: mocks.isFeatureEnabled,
}));

vi.mock("@repo/integrations/microsoft", () => ({
	executeMicrosoftTeamsTool: mocks.teamsTool,
	isMicrosoftNotConnectedError: (message: string) =>
		message.includes("Microsoft not connected"),
}));

vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn() }));

vi.mock("../../client", () => ({
	getTemporalClient: async () => ({
		workflow: { start: mocks.workflowStart },
	}),
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { WorkflowExecutionAlreadyStartedError } = await import(
	"@temporalio/common"
);
const {
	confirmParlumeAutoJoinOccurrence,
	groupAutoJoinSeries,
	isOccurrenceStillScheduled,
	matchAutoJoinOccurrences,
	PARLUME_AUTO_JOIN_CALENDAR_ERRORS,
	PARLUME_AUTO_JOIN_CONFIRM_UNREADABLE,
	parlumeAutoJoinWorkflowId,
	parseGraphStart,
	planParlumeAutoJoins,
	requestParlumeAutoJoin,
} = await import("../parlume-auto-join");

const NOW = Date.parse("2026-10-27T09:00:00Z");
const MINUTE = 60_000;
const JOIN_URL = "https://teams.microsoft.com/l/meetup-join/example-series";

/** Graph's calendarView start: UTC wall-clock time with no offset. */
function graphStart(ms: number): string {
	return new Date(ms).toISOString().replace("Z", "0000");
}

describe("matchAutoJoinOccurrences", () => {
	const series = [{ id: "lm-1", joinUrl: JOIN_URL }];

	it("plans an occurrence a minute before its start", () => {
		const start = NOW + 10 * MINUTE;
		expect(
			matchAutoJoinOccurrences({
				series,
				meetings: [{ start: graphStart(start), joinUrl: JOIN_URL }],
				now: NOW,
			}),
		).toEqual([
			{
				linkedMeetingId: "lm-1",
				occurrenceStart: new Date(start).toISOString(),
				startDelayMs: 9 * MINUTE,
			},
		]);
	});

	it("includes both window edges and nothing beyond them", () => {
		const starts = [
			NOW + 15 * MINUTE,
			NOW + 15 * MINUTE + 1,
			NOW - 10 * MINUTE,
			NOW - 10 * MINUTE - 1,
		];
		const planned = matchAutoJoinOccurrences({
			series,
			meetings: starts.map((start) => ({
				start: graphStart(start),
				joinUrl: JOIN_URL,
			})),
			now: NOW,
		});
		expect(planned.map((occurrence) => occurrence.occurrenceStart)).toEqual(
			[
				new Date(NOW + 15 * MINUTE).toISOString(),
				new Date(NOW - 10 * MINUTE).toISOString(),
			],
		);
	});

	it("joins straight away an occurrence already under way, up to the late cutoff", () => {
		const [late] = matchAutoJoinOccurrences({
			series,
			meetings: [
				{ start: graphStart(NOW - 8 * MINUTE), joinUrl: JOIN_URL },
			],
			now: NOW,
		});
		expect(late?.startDelayMs).toBe(0);
	});

	it("matches the join link however its case and spacing differ", () => {
		const planned = matchAutoJoinOccurrences({
			series,
			meetings: [
				{
					start: graphStart(NOW + 5 * MINUTE),
					joinUrl: `  ${JOIN_URL.toUpperCase()} `,
				},
			],
			now: NOW,
		});
		expect(planned).toHaveLength(1);
	});

	it("ignores another series, a meeting without a link and an unreadable start", () => {
		expect(
			matchAutoJoinOccurrences({
				series,
				meetings: [
					{
						start: graphStart(NOW + 5 * MINUTE),
						joinUrl:
							"https://teams.microsoft.com/l/meetup-join/other",
					},
					{ start: graphStart(NOW + 5 * MINUTE), joinUrl: null },
					{ start: "not a date", joinUrl: JOIN_URL },
				],
				now: NOW,
			}),
		).toEqual([]);
	});

	it("never plans a cancelled occurrence", () => {
		expect(
			matchAutoJoinOccurrences({
				series,
				meetings: [
					{
						start: graphStart(NOW + 5 * MINUTE),
						joinUrl: JOIN_URL,
						isCancelled: true,
					},
				],
				now: NOW,
			}),
		).toEqual([]);
	});

	it("reads Graph's offset-less start as UTC", () => {
		expect(parseGraphStart("2026-10-27T09:00:00.0000000")).toBe(NOW);
		expect(parseGraphStart("2026-10-27T11:00:00+02:00")).toBe(NOW);
		expect(parseGraphStart(null)).toBeNull();
	});
});

describe("groupAutoJoinSeries", () => {
	it("reads each enabler's calendar once per organization", () => {
		const groups = groupAutoJoinSeries([
			{
				id: "a",
				joinUrl: "u1",
				userId: "user-1",
				organizationId: "org-1",
			},
			{
				id: "b",
				joinUrl: "u2",
				userId: "user-1",
				organizationId: "org-1",
			},
			{
				id: "c",
				joinUrl: "u3",
				userId: "user-2",
				organizationId: "org-1",
			},
			{
				id: "d",
				joinUrl: "u4",
				userId: "user-1",
				organizationId: "org-2",
			},
		]);
		expect(
			groups.map((group) => ({
				userId: group.userId,
				organizationId: group.organizationId,
				ids: group.series.map((entry) => entry.id),
			})),
		).toEqual([
			{ userId: "user-1", organizationId: "org-1", ids: ["a", "b"] },
			{ userId: "user-2", organizationId: "org-1", ids: ["c"] },
			{ userId: "user-1", organizationId: "org-2", ids: ["d"] },
		]);
	});
});

describe("parlumeAutoJoinWorkflowId", () => {
	it("is the series and the occurrence's start, so every run names it the same", () => {
		const occurrence = {
			linkedMeetingId: "lm-1",
			occurrenceStart: "2026-10-27T09:00:00.000Z",
		};
		expect(parlumeAutoJoinWorkflowId(occurrence)).toBe(
			`parlume-autojoin-lm-1-${NOW}`,
		);
		expect(parlumeAutoJoinWorkflowId({ ...occurrence })).toBe(
			parlumeAutoJoinWorkflowId(occurrence),
		);
	});
});

describe("planParlumeAutoJoins", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	beforeEach(() => {
		vi.resetAllMocks();
		vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
		mocks.isFeatureEnabled.mockResolvedValue(true);
		mocks.updateMany.mockResolvedValue({ count: 1 });
		mocks.workflowStart.mockResolvedValue({});
		mocks.findMany.mockResolvedValue([
			{
				id: "lm-1",
				joinUrl: JOIN_URL,
				parlumeAutoJoinUserId: "user-1",
				project: { organizationId: "org-1" },
			},
		]);
	});

	it("schedules each matched occurrence under its deterministic id, delayed to a minute before", async () => {
		mocks.teamsTool.mockResolvedValue({
			meetings: [
				{ start: graphStart(NOW + 6 * MINUTE), joinUrl: JOIN_URL },
			],
		});

		const result = await planParlumeAutoJoins();

		expect(mocks.teamsTool).toHaveBeenCalledWith(
			"list_calendar_meetings",
			{
				startDate: new Date(NOW - 10 * MINUTE).toISOString(),
				endDate: new Date(NOW + 15 * MINUTE).toISOString(),
			},
			"user-1",
			"org-1",
		);
		expect(mocks.workflowStart).toHaveBeenCalledWith(
			"parlumeAutoJoinOccurrenceWorkflow",
			expect.objectContaining({
				workflowId: `parlume-autojoin-lm-1-${NOW + 6 * MINUTE}`,
				workflowIdReusePolicy: "REJECT_DUPLICATE",
				startDelay: 5 * MINUTE,
				args: [
					{
						linkedMeetingId: "lm-1",
						occurrenceStart: new Date(
							NOW + 6 * MINUTE,
						).toISOString(),
					},
				],
			}),
		);
		expect(result).toMatchObject({ groups: 1, scheduled: 1 });
	});

	it("ignores a duplicate start from an earlier run", async () => {
		mocks.teamsTool.mockResolvedValue({
			meetings: [
				{ start: graphStart(NOW + 6 * MINUTE), joinUrl: JOIN_URL },
			],
		});
		mocks.workflowStart.mockRejectedValue(
			new WorkflowExecutionAlreadyStartedError(
				"already started",
				"parlume-autojoin-lm-1",
				"parlumeAutoJoinOccurrenceWorkflow",
			),
		);

		const result = await planParlumeAutoJoins();

		expect(result).toMatchObject({ scheduled: 0, alreadyScheduled: 1 });
	});

	it("records a disconnected Microsoft account on the group's series and keeps planning", async () => {
		mocks.findMany.mockResolvedValue([
			{
				id: "lm-1",
				joinUrl: JOIN_URL,
				parlumeAutoJoinUserId: "user-1",
				project: { organizationId: "org-1" },
			},
			{
				id: "lm-2",
				joinUrl: "https://teams.microsoft.com/l/meetup-join/second",
				parlumeAutoJoinUserId: "user-2",
				project: { organizationId: "org-1" },
			},
		]);
		mocks.teamsTool.mockImplementation(async (_tool, _args, userId) => {
			if (userId === "user-1") {
				throw new Error(
					"Microsoft not connected. Please connect your Microsoft account in Settings > Integrations.",
				);
			}
			return {
				meetings: [
					{
						start: graphStart(NOW + 3 * MINUTE),
						joinUrl:
							"https://teams.microsoft.com/l/meetup-join/second",
					},
				],
			};
		});

		const result = await planParlumeAutoJoins();

		expect(result).toMatchObject({ calendarFailures: 1, scheduled: 1 });
		expect(mocks.updateMany).toHaveBeenCalledWith({
			where: { id: { in: ["lm-1"] } },
			data: {
				parlumeAutoJoinError:
					PARLUME_AUTO_JOIN_CALENDAR_ERRORS.notConnected,
				parlumeAutoJoinErrorAt: expect.any(Date),
			},
		});
	});

	it("records a calendar Graph could not read, answered as an error field", async () => {
		mocks.teamsTool.mockResolvedValue({
			error: "Microsoft Graph API error: 503",
		});

		await expect(planParlumeAutoJoins()).resolves.toMatchObject({
			calendarFailures: 1,
		});
		expect(mocks.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					parlumeAutoJoinError:
						PARLUME_AUTO_JOIN_CALENDAR_ERRORS.unreadable,
				}),
			}),
		);
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});

	it("clears only a calendar error once the calendar answers again", async () => {
		mocks.teamsTool.mockResolvedValue({ meetings: [] });

		await planParlumeAutoJoins();

		expect(mocks.updateMany).toHaveBeenCalledWith({
			where: {
				id: { in: ["lm-1"] },
				parlumeAutoJoinError: {
					in: Object.values(PARLUME_AUTO_JOIN_CALENDAR_ERRORS),
				},
			},
			data: { parlumeAutoJoinError: null, parlumeAutoJoinErrorAt: null },
		});
	});

	it("does not read a calendar for an organization with a flag off", async () => {
		mocks.isFeatureEnabled.mockImplementation(
			async (key: string) => key !== "MEETING_AGENDA",
		);

		await expect(planParlumeAutoJoins()).resolves.toMatchObject({
			groups: 0,
		});
		expect(mocks.teamsTool).not.toHaveBeenCalled();
	});
});

describe("isOccurrenceStillScheduled", () => {
	const occurrenceStartMs = NOW + MINUTE;

	it("finds the occurrence at its start, or within a minute of it", () => {
		for (const start of [
			occurrenceStartMs,
			occurrenceStartMs + MINUTE,
			occurrenceStartMs - MINUTE,
		]) {
			expect(
				isOccurrenceStillScheduled({
					joinUrl: JOIN_URL,
					occurrenceStartMs,
					meetings: [
						{
							start: graphStart(start),
							joinUrl: ` ${JOIN_URL.toUpperCase()}`,
						},
					],
				}),
			).toBe(true);
		}
	});

	it("does not find one that moved, was cancelled or is another meeting", () => {
		expect(
			isOccurrenceStillScheduled({
				joinUrl: JOIN_URL,
				occurrenceStartMs,
				meetings: [
					{
						start: graphStart(occurrenceStartMs + MINUTE + 1),
						joinUrl: JOIN_URL,
					},
					{
						start: graphStart(occurrenceStartMs),
						joinUrl: JOIN_URL,
						isCancelled: true,
					},
					{
						start: graphStart(occurrenceStartMs),
						joinUrl:
							"https://teams.microsoft.com/l/meetup-join/other",
					},
				],
			}),
		).toBe(false);
	});
});

describe("confirmParlumeAutoJoinOccurrence", () => {
	const occurrenceStart = new Date(NOW + MINUTE).toISOString();
	const input = { linkedMeetingId: "lm-1", occurrenceStart };

	afterEach(() => {
		vi.useRealTimers();
	});

	beforeEach(() => {
		vi.resetAllMocks();
		mocks.updateMany.mockResolvedValue({ count: 1 });
		mocks.findFirst.mockResolvedValue({
			joinUrl: JOIN_URL,
			parlumeAutoJoin: true,
			parlumeAutoJoinUserId: "user-1",
			deactivatedAt: null,
			project: { organizationId: "org-1" },
		});
	});

	it("reads the enabler's calendar two minutes either side of the start and goes ahead when the occurrence is there", async () => {
		mocks.teamsTool.mockResolvedValue({
			meetings: [{ start: graphStart(NOW + MINUTE), joinUrl: JOIN_URL }],
		});

		await expect(confirmParlumeAutoJoinOccurrence(input)).resolves.toEqual({
			proceed: true,
		});
		expect(mocks.teamsTool).toHaveBeenCalledWith(
			"list_calendar_meetings",
			{
				startDate: new Date(NOW - MINUTE).toISOString(),
				endDate: new Date(NOW + 3 * MINUTE).toISOString(),
			},
			"user-1",
			"org-1",
		);
		expect(mocks.updateMany).not.toHaveBeenCalled();
	});

	it("skips an occurrence that was cancelled after it was scheduled", async () => {
		mocks.teamsTool.mockResolvedValue({
			meetings: [
				{
					start: graphStart(NOW + MINUTE),
					joinUrl: JOIN_URL,
					isCancelled: true,
				},
			],
		});

		await expect(confirmParlumeAutoJoinOccurrence(input)).resolves.toEqual({
			proceed: false,
			outcome: "skipped",
			reason: "occurrence_moved_or_cancelled",
		});
		expect(mocks.updateMany).not.toHaveBeenCalled();
	});

	it("skips an occurrence that moved, leaving its new time to the planner", async () => {
		mocks.teamsTool.mockResolvedValue({ meetings: [] });

		await expect(
			confirmParlumeAutoJoinOccurrence(input),
		).resolves.toMatchObject({
			proceed: false,
			reason: "occurrence_moved_or_cancelled",
		});
	});

	it("records a disconnected Microsoft account and skips without retrying", async () => {
		mocks.teamsTool.mockRejectedValue(
			new Error("Microsoft not connected. Connect it in Settings."),
		);

		await expect(
			confirmParlumeAutoJoinOccurrence(input),
		).resolves.toMatchObject({
			proceed: false,
			reason: "calendar_not_connected",
		});
		expect(mocks.teamsTool).toHaveBeenCalledTimes(1);
		expect(mocks.updateMany).toHaveBeenCalledWith({
			where: { id: "lm-1" },
			data: {
				parlumeAutoJoinError:
					PARLUME_AUTO_JOIN_CALENDAR_ERRORS.notConnected,
				parlumeAutoJoinErrorAt: expect.any(Date),
			},
		});
	});

	it("retries a Graph error, then records that the occurrence was missed", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout"] });
		mocks.teamsTool.mockResolvedValue({
			error: "Microsoft Graph API error: 503",
		});

		const pending = confirmParlumeAutoJoinOccurrence(input);
		await vi.runAllTimersAsync();

		await expect(pending).resolves.toMatchObject({
			proceed: false,
			reason: "calendar_unreadable",
		});
		expect(mocks.teamsTool).toHaveBeenCalledTimes(3);
		expect(mocks.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					parlumeAutoJoinError: PARLUME_AUTO_JOIN_CONFIRM_UNREADABLE,
				}),
			}),
		);
	});

	it("goes ahead once a passing Graph error clears", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout"] });
		mocks.teamsTool
			.mockResolvedValueOnce({ error: "Microsoft Graph API error: 503" })
			.mockResolvedValueOnce({
				meetings: [
					{ start: graphStart(NOW + MINUTE), joinUrl: JOIN_URL },
				],
			});

		const pending = confirmParlumeAutoJoinOccurrence(input);
		await vi.runAllTimersAsync();

		await expect(pending).resolves.toEqual({ proceed: true });
		expect(mocks.updateMany).not.toHaveBeenCalled();
	});

	it("leaves a series that is no longer on to the web app, without reading a calendar", async () => {
		mocks.findFirst.mockResolvedValue({
			joinUrl: JOIN_URL,
			parlumeAutoJoin: false,
			parlumeAutoJoinUserId: null,
			deactivatedAt: null,
			project: { organizationId: "org-1" },
		});

		await expect(confirmParlumeAutoJoinOccurrence(input)).resolves.toEqual({
			proceed: true,
		});
		expect(mocks.teamsTool).not.toHaveBeenCalled();
	});
});

describe("requestParlumeAutoJoin", () => {
	const input = {
		linkedMeetingId: "lm-1",
		occurrenceStart: "2026-10-27T09:00:00.000Z",
	};

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});

	beforeEach(() => {
		vi.stubEnv("AGENT_SERVICE_SECRET", "example-secret");
		vi.stubEnv("FABRIC_INTERNAL_URL", "https://fabric.example.com");
	});

	it("posts the occurrence with the service token and returns the outcome", async () => {
		const fetchMock = vi.fn(
			async () => new Response(JSON.stringify({ outcome: "started" })),
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(requestParlumeAutoJoin(input)).resolves.toEqual({
			outcome: "started",
		});
		expect(fetchMock).toHaveBeenCalledWith(
			"https://fabric.example.com/api/internal/parlume/auto-join",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify(input),
				headers: expect.objectContaining({
					"X-Agent-Service-Token": "example-secret",
				}),
			}),
		);
	});

	it("does not retry a refusal the web app answered with a 4xx", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("{}", { status: 400 })),
		);

		await expect(requestParlumeAutoJoin(input)).rejects.toMatchObject({
			type: "ParlumeAutoJoinRejected",
			nonRetryable: true,
		});
	});

	it("leaves a 503 retryable", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("{}", { status: 503 })),
		);

		const failure = await requestParlumeAutoJoin(input).catch(
			(error: unknown) => error,
		);
		expect(failure).toBeInstanceOf(Error);
		expect(failure).not.toHaveProperty("nonRetryable", true);
	});
});
