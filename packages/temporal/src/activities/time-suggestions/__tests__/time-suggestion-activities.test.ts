import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	collectUnclaimedTimeEvidence: vi.fn(),
	listAuthorLoggedTime: vi.fn(),
	getBoundPromptForAgent: vi.fn(),
	listActiveLinkedTeamsMeetings: vi.fn(),
	resolveOwnWorkflowIntegrationForProvider: vi.fn(),
	listEndedAutoJoinSessions: vi.fn(),
	listMemberManualMeetingSessions: vi.fn(),
	filterUnclaimedTimeEvidence: vi.fn(),
	executeMicrosoftTeamsTool: vi.fn(),
	generateText: vi.fn(),
	getAIModelWithMetadata: vi.fn(),
	logModelUsageAsync: vi.fn(),
	renderTemplate: vi.fn(),
	warn: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	collectUnclaimedTimeEvidence: mocks.collectUnclaimedTimeEvidence,
	listAuthorLoggedTime: mocks.listAuthorLoggedTime,
	getBoundPromptForAgent: mocks.getBoundPromptForAgent,
	listActiveLinkedTeamsMeetings: mocks.listActiveLinkedTeamsMeetings,
	resolveOwnWorkflowIntegrationForProvider:
		mocks.resolveOwnWorkflowIntegrationForProvider,
	listEndedAutoJoinSessions: mocks.listEndedAutoJoinSessions,
	listMemberManualMeetingSessions: mocks.listMemberManualMeetingSessions,
	filterUnclaimedTimeEvidence: mocks.filterUnclaimedTimeEvidence,
}));
vi.mock("@repo/integrations/microsoft", () => ({
	executeMicrosoftTeamsTool: mocks.executeMicrosoftTeamsTool,
	isMicrosoftNotConnectedError: (message: string) =>
		message.includes("Microsoft not connected"),
}));
vi.mock("@repo/ai", () => ({
	generateText: mocks.generateText,
	getAIModelWithMetadata: mocks.getAIModelWithMetadata,
	logModelUsageAsync: mocks.logModelUsageAsync,
	Output: { object: (options: unknown) => options },
}));
vi.mock("@repo/ai/lib/structured-output", () => ({
	requireStructuredOutput: (pending: Promise<unknown>) => pending,
}));
vi.mock("@repo/utils", () => ({ renderTemplate: mocks.renderTemplate }));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: mocks.warn, error: vi.fn(), debug: vi.fn() },
}));

import {
	readTimeSuggestionDrafts,
	timeSuggestionEvidenceText,
} from "../build-time-suggestion-prompt";
import { collectTimeSuggestionCandidatesActivity } from "../collect-time-suggestion-candidates";
import { draftTimeSuggestionsActivity } from "../draft-time-suggestions";
import type { TimeSuggestionCandidate } from "../types";

const candidate: TimeSuggestionCandidate = {
	workDate: "2026-11-05",
	projectId: "project-a",
	projectName: "Project A",
	storyId: "story-1",
	storyIdentifier: "F-001",
	storyTitle: "Checkout",
	activity: "PLANNING_REQUIREMENTS",
	durationMinutes: null,
	startAt: null,
	stopAt: null,
	evidence: [
		{
			kind: "FEATURE_EDIT",
			sourceId: "version-1",
			occurredAt: "2026-11-05T08:10:00.000Z",
			startAt: null,
			endAt: null,
		},
		{
			kind: "FEATURE_EDIT",
			sourceId: "version-2",
			occurredAt: "2026-11-05T09:40:00.000Z",
			startAt: null,
			endAt: null,
		},
	],
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getBoundPromptForAgent.mockResolvedValue({
		format: "HANDLEBARS",
		version: { id: "prompt-version-1", content: "Describe the blocks." },
	});
	mocks.renderTemplate.mockImplementation(
		async ({ template }: { template: string }) => ({ rendered: template }),
	);
	mocks.getAIModelWithMetadata.mockResolvedValue({
		model: "model",
		metadata: {},
		trackUsage: vi.fn(),
	});
	mocks.listActiveLinkedTeamsMeetings.mockResolvedValue([]);
	mocks.resolveOwnWorkflowIntegrationForProvider.mockResolvedValue(null);
	mocks.listEndedAutoJoinSessions.mockResolvedValue([]);
	mocks.listMemberManualMeetingSessions.mockResolvedValue([]);
	mocks.filterUnclaimedTimeEvidence.mockImplementation(
		async (_userId: string, evidence: unknown[]) => evidence,
	);
	mocks.executeMicrosoftTeamsTool.mockResolvedValue({ events: [] });
});

describe("timeSuggestionEvidenceText", () => {
	it("gives the model facts in local time, never source ids", () => {
		const text = timeSuggestionEvidenceText([candidate], "Europe/Berlin");

		expect(text).toBe(
			[
				"Block 1",
				"Date: 2026-11-05",
				"Project: Project A",
				"Work item: F-001 Checkout",
				"Activity seen: PLANNING_REQUIREMENTS",
				"Evidence: 2 work item edits between 09:10 and 10:40",
			].join("\n"),
		);
		expect(text).not.toContain("version-1");
	});
});

describe("readTimeSuggestionDrafts", () => {
	const second = { ...candidate, storyId: null, storyIdentifier: null };

	it("takes the model's description and activity per block", () => {
		expect(
			readTimeSuggestionDrafts([candidate], {
				suggestions: [
					{
						group: 1,
						description: "  Refined the checkout feature  ",
						activity: "design_ux",
					},
				],
			}),
		).toEqual([
			{
				description: "Refined the checkout feature",
				activity: "DESIGN_UX",
			},
		]);
	});

	it("falls back for a missing block, a blank description or an unknown activity", () => {
		const drafts = readTimeSuggestionDrafts(
			[candidate, second, candidate],
			{
				suggestions: [
					{ group: 2, description: "   " },
					{
						group: 3,
						description: "Reviewed scope",
						activity: "NAPPING",
					},
				],
			},
		);

		expect(drafts).toEqual([
			{
				description: "Planning and requirements on F-001 Checkout",
				activity: "PLANNING_REQUIREMENTS",
			},
			{
				description: "Planning and requirements on Checkout",
				activity: "PLANNING_REQUIREMENTS",
			},
			{
				description: "Reviewed scope",
				activity: "PLANNING_REQUIREMENTS",
			},
		]);
	});
});

describe("draftTimeSuggestionsActivity", () => {
	const input = {
		organizationId: "org-1",
		userId: "user-1",
		timezone: "Europe/Berlin",
		candidates: [candidate],
	};

	it("calls no model when there is nothing to describe", async () => {
		await expect(
			draftTimeSuggestionsActivity({ ...input, candidates: [] }),
		).resolves.toEqual([]);
		expect(mocks.generateText).not.toHaveBeenCalled();
	});

	it("attributes the call to the member, the bound prompt and the job", async () => {
		mocks.generateText.mockResolvedValue({
			output: {
				suggestions: [
					{
						group: 1,
						description: "Checkout scope",
						activity: "OTHER",
					},
				],
			},
			usage: {},
		});

		await expect(draftTimeSuggestionsActivity(input)).resolves.toEqual([
			{ description: "Checkout scope", activity: "OTHER" },
		]);
		expect(mocks.getBoundPromptForAgent).toHaveBeenCalledWith(
			expect.objectContaining({
				agentName: "time_suggestion_drafter",
				documentType: "GENERAL",
				storyKind: null,
			}),
		);
		expect(mocks.getAIModelWithMetadata).toHaveBeenCalledWith(
			{ taskType: "SIMPLE" },
			expect.objectContaining({
				userId: "user-1",
				organizationId: "org-1",
				promptVersionId: "prompt-version-1",
				jobType: "time-suggestions",
			}),
		);
		const call = mocks.generateText.mock.calls[0][0];
		expect(call.prompt).toContain('trust="untrusted"');
		expect(call.system).toContain("Evidence Handling");
	});

	it("never throws: a failed model call gives every block the fallback", async () => {
		mocks.generateText.mockRejectedValue(new Error("provider down"));

		await expect(draftTimeSuggestionsActivity(input)).resolves.toEqual([
			{
				description: "Planning and requirements on F-001 Checkout",
				activity: "PLANNING_REQUIREMENTS",
			},
		]);
	});
});

describe("collectTimeSuggestionCandidatesActivity", () => {
	it("reads the member's evidence over the range in their time zone and groups it", async () => {
		mocks.collectUnclaimedTimeEvidence.mockResolvedValue([
			{
				kind: "MEETING_SESSION",
				sourceId: "meeting-1",
				projectId: "project-a",
				storyId: null,
				storyIdentifier: null,
				storyTitle: null,
				occurredAt: new Date("2026-11-05T09:00:00.000Z"),
				startAt: new Date("2026-11-05T09:00:00.000Z"),
				endAt: new Date("2026-11-05T10:00:00.000Z"),
			},
			{
				kind: "FEATURE_EDIT",
				sourceId: "version-1",
				projectId: "project-a",
				storyId: "story-1",
				storyIdentifier: "F-001",
				storyTitle: "Checkout",
				occurredAt: new Date("2026-11-06T09:00:00.000Z"),
				startAt: null,
				endAt: null,
			},
		]);
		mocks.listAuthorLoggedTime.mockResolvedValue({
			intervals: [],
			entries: [],
		});

		const candidates = await collectTimeSuggestionCandidatesActivity({
			organizationId: "org-1",
			userId: "user-1",
			fromDate: "2026-11-04",
			toDate: "2026-11-10",
			timezone: "Europe/Berlin",
			projects: [{ id: "project-a", name: "Project A" }],
		});

		expect(mocks.collectUnclaimedTimeEvidence).toHaveBeenCalledWith({
			organizationId: "org-1",
			userId: "user-1",
			projectIds: ["project-a"],
			from: new Date("2026-11-03T23:00:00.000Z"),
			to: new Date("2026-11-10T23:00:00.000Z"),
		});
		expect(candidates).toEqual([
			{
				workDate: "2026-11-06",
				projectId: "project-a",
				projectName: "Project A",
				storyId: "story-1",
				storyIdentifier: "F-001",
				storyTitle: "Checkout",
				activity: "PLANNING_REQUIREMENTS",
				durationMinutes: null,
				startAt: null,
				stopAt: null,
				evidence: [
					{
						kind: "FEATURE_EDIT",
						sourceId: "version-1",
						occurredAt: "2026-11-06T09:00:00.000Z",
						startAt: null,
						endAt: null,
					},
				],
			},
			{
				workDate: "2026-11-05",
				projectId: "project-a",
				projectName: "Project A",
				storyId: null,
				storyIdentifier: null,
				storyTitle: null,
				activity: "MEETINGS_COLLABORATION",
				durationMinutes: 60,
				startAt: "2026-11-05T09:00:00.000Z",
				stopAt: "2026-11-05T10:00:00.000Z",
				evidence: [
					{
						kind: "MEETING_SESSION",
						sourceId: "meeting-1",
						occurredAt: "2026-11-05T09:00:00.000Z",
						startAt: "2026-11-05T09:00:00.000Z",
						endAt: "2026-11-05T10:00:00.000Z",
					},
				],
			},
		]);
	});

	it("drops instant evidence a confirmed entry already represents, reading logged time once for the window", async () => {
		mocks.collectUnclaimedTimeEvidence.mockResolvedValue([
			{
				kind: "PULL_REQUEST",
				sourceId: "push-1",
				projectId: "project-a",
				storyId: "story-1",
				storyIdentifier: "F-001",
				storyTitle: "Checkout",
				occurredAt: new Date("2026-11-06T09:00:00.000Z"),
				startAt: null,
				endAt: null,
			},
		]);
		mocks.listAuthorLoggedTime.mockResolvedValue({
			intervals: [],
			entries: [
				{
					projectId: "project-a",
					workDate: "2026-11-06",
					storyId: "story-1",
				},
			],
		});

		const candidates = await collectTimeSuggestionCandidatesActivity({
			organizationId: "org-1",
			userId: "user-1",
			fromDate: "2026-11-04",
			toDate: "2026-11-10",
			timezone: "Europe/Berlin",
			projects: [{ id: "project-a", name: "Project A" }],
		});

		expect(candidates).toEqual([]);
		expect(mocks.listAuthorLoggedTime).toHaveBeenCalledTimes(1);
		expect(mocks.listAuthorLoggedTime).toHaveBeenCalledWith({
			organizationId: "org-1",
			userId: "user-1",
			from: new Date("2026-11-03T23:00:00.000Z"),
			to: new Date("2026-11-10T23:00:00.000Z"),
			fromDate: "2026-11-04",
			toDate: "2026-11-10",
		});
	});

	describe("calendar meetings", () => {
		const JOIN_URL =
			"https://teams.microsoft.com/l/meetup-join/example-series";
		const input = {
			organizationId: "org-1",
			userId: "user-1",
			fromDate: "2026-11-04",
			toDate: "2026-11-10",
			timezone: "Europe/Berlin",
			projects: [{ id: "project-a", name: "Project A" }],
		};
		const event = {
			id: "event-1",
			startAt: "2026-11-05T09:00:00.000Z",
			endAt: "2026-11-05T09:30:00.000Z",
			joinUrl: JOIN_URL,
			isAllDay: false,
			isCancelled: false,
			showAs: "busy",
			response: "accepted",
			isOrganizer: false,
		};
		const hash = createHash("sha256").update("event-1").digest("hex");
		const session = {
			kind: "MEETING_SESSION",
			sourceId: "session-own",
			projectId: "project-a",
			storyId: null,
			storyIdentifier: null,
			storyTitle: null,
			occurredAt: new Date("2026-11-05T09:02:00.000Z"),
			startAt: new Date("2026-11-05T09:02:00.000Z"),
			endAt: new Date("2026-11-05T09:28:00.000Z"),
		};

		beforeEach(() => {
			mocks.collectUnclaimedTimeEvidence.mockResolvedValue([]);
			mocks.listAuthorLoggedTime.mockResolvedValue({
				intervals: [],
				entries: [],
			});
			mocks.listActiveLinkedTeamsMeetings.mockResolvedValue([
				{ id: "series-1", projectId: "project-a", joinUrl: JOIN_URL },
			]);
			mocks.resolveOwnWorkflowIntegrationForProvider.mockResolvedValue({
				id: "integration-own",
			});
			mocks.executeMicrosoftTeamsTool.mockResolvedValue({
				events: [event],
			});
		});

		it("suggests an accepted meeting on its linked series with its start and end", async () => {
			const candidates =
				await collectTimeSuggestionCandidatesActivity(input);

			expect(candidates).toEqual([
				{
					workDate: "2026-11-05",
					projectId: "project-a",
					projectName: "Project A",
					storyId: null,
					storyIdentifier: null,
					storyTitle: null,
					activity: "MEETINGS_COLLABORATION",
					durationMinutes: 30,
					startAt: "2026-11-05T09:00:00.000Z",
					stopAt: "2026-11-05T09:30:00.000Z",
					evidence: [
						{
							kind: "CALENDAR_EVENT",
							sourceId: hash,
							occurredAt: "2026-11-05T09:00:00.000Z",
							startAt: "2026-11-05T09:00:00.000Z",
							endAt: "2026-11-05T09:30:00.000Z",
						},
					],
				},
			]);
		});

		it("reads the calendar over the run's range through the member's own connection only", async () => {
			await collectTimeSuggestionCandidatesActivity(input);

			expect(mocks.listActiveLinkedTeamsMeetings).toHaveBeenCalledWith({
				organizationId: "org-1",
				projectIds: ["project-a"],
			});
			expect(
				mocks.resolveOwnWorkflowIntegrationForProvider,
			).toHaveBeenCalledWith("MICROSOFT_GRAPH", "user-1", "org-1");
			expect(mocks.executeMicrosoftTeamsTool).toHaveBeenCalledWith(
				"list_calendar_time_evidence",
				{
					startDate: "2026-11-03T23:00:00.000Z",
					endDate: "2026-11-10T23:00:00.000Z",
					signal: expect.any(AbortSignal),
				},
				"user-1",
				"org-1",
				"integration-own",
			);
		});

		it("returns no subject, organizer or join URL, and no event id", async () => {
			mocks.executeMicrosoftTeamsTool.mockResolvedValue({
				events: [
					{
						...event,
						subject: "Weekly sync",
						organizer: "dev@example.com",
					},
				],
			});

			const candidates =
				await collectTimeSuggestionCandidatesActivity(input);

			const recorded = JSON.stringify(candidates);
			expect(candidates).toHaveLength(1);
			expect(recorded).not.toContain("Weekly sync");
			expect(recorded).not.toContain("dev@example.com");
			expect(recorded).not.toContain(JOIN_URL);
			expect(recorded).not.toContain('"event-1"');
		});

		it("reads no calendar without the member's own Microsoft connection", async () => {
			mocks.resolveOwnWorkflowIntegrationForProvider.mockResolvedValue(
				null,
			);

			await expect(
				collectTimeSuggestionCandidatesActivity(input),
			).resolves.toEqual([]);
			expect(mocks.executeMicrosoftTeamsTool).not.toHaveBeenCalled();
		});

		it("reads no calendar when no Teams series is linked to the projects", async () => {
			mocks.listActiveLinkedTeamsMeetings.mockResolvedValue([]);

			await collectTimeSuggestionCandidatesActivity(input);

			expect(
				mocks.resolveOwnWorkflowIntegrationForProvider,
			).not.toHaveBeenCalled();
			expect(mocks.executeMicrosoftTeamsTool).not.toHaveBeenCalled();
		});

		async function expectDatabaseEvidenceOnly(reason: string) {
			const candidates =
				await collectTimeSuggestionCandidatesActivity(input);

			expect(candidates).toHaveLength(1);
			expect(candidates[0].evidence).toEqual([
				expect.objectContaining({ sourceId: "session-own" }),
			]);
			expect(mocks.warn).toHaveBeenCalledWith(
				expect.stringContaining("calendar not read"),
				expect.objectContaining({ reason }),
			);
		}

		it("keeps the database evidence when Microsoft is not connected", async () => {
			mocks.collectUnclaimedTimeEvidence.mockResolvedValue([session]);
			mocks.executeMicrosoftTeamsTool.mockRejectedValue(
				new Error("Microsoft not connected."),
			);

			await expectDatabaseEvidenceOnly("not-connected");
		});

		it("keeps the database evidence when the calendar cannot be read", async () => {
			mocks.collectUnclaimedTimeEvidence.mockResolvedValue([session]);
			mocks.executeMicrosoftTeamsTool.mockRejectedValue(
				new Error("Microsoft Graph API error: 503"),
			);

			await expectDatabaseEvidenceOnly("unreadable");
		});

		it("suggests a meeting the member had the agent join once, from the session", async () => {
			mocks.collectUnclaimedTimeEvidence.mockResolvedValue([session]);
			mocks.listMemberManualMeetingSessions.mockResolvedValue([
				{
					id: "session-own",
					projectId: "project-a",
					joinedAt: session.startAt,
				},
			]);

			const candidates =
				await collectTimeSuggestionCandidatesActivity(input);

			expect(candidates).toHaveLength(1);
			expect(candidates[0].evidence).toEqual([
				expect.objectContaining({
					kind: "MEETING_SESSION",
					sourceId: "session-own",
				}),
			]);
		});

		it("credits the agent's own join of the occurrence with its times, in place of the calendar meeting", async () => {
			mocks.listEndedAutoJoinSessions.mockResolvedValue([
				{
					id: "session-auto",
					projectId: "project-a",
					linkedMeetingId: "series-1",
					occurrenceStart: new Date("2026-11-05T09:00:00.000Z"),
					joinedAt: new Date("2026-11-05T08:59:00.000Z"),
					endedAt: new Date("2026-11-05T09:41:00.000Z"),
				},
			]);

			const candidates =
				await collectTimeSuggestionCandidatesActivity(input);

			expect(mocks.listEndedAutoJoinSessions).toHaveBeenCalledWith({
				organizationId: "org-1",
				linkedMeetingIds: ["series-1"],
				from: new Date("2026-11-05T08:59:00.000Z"),
				to: new Date("2026-11-05T09:01:00.001Z"),
			});
			expect(candidates).toHaveLength(1);
			expect(candidates[0]).toMatchObject({
				durationMinutes: 42,
				startAt: "2026-11-05T08:59:00.000Z",
				stopAt: "2026-11-05T09:41:00.000Z",
				evidence: [
					{
						kind: "MEETING_SESSION",
						sourceId: "session-auto",
						startAt: "2026-11-05T08:59:00.000Z",
						endAt: "2026-11-05T09:41:00.000Z",
					},
				],
			});
		});

		it("gives a member who declined the occurrence nothing, even when the agent joined it", async () => {
			mocks.executeMicrosoftTeamsTool.mockResolvedValue({
				events: [{ ...event, response: "declined" }],
			});

			await expect(
				collectTimeSuggestionCandidatesActivity(input),
			).resolves.toEqual([]);
			expect(mocks.listEndedAutoJoinSessions).not.toHaveBeenCalled();
		});

		it("leaves out calendar evidence a suggestion of the member already claimed", async () => {
			mocks.filterUnclaimedTimeEvidence.mockResolvedValue([]);

			await expect(
				collectTimeSuggestionCandidatesActivity(input),
			).resolves.toEqual([]);
			expect(mocks.filterUnclaimedTimeEvidence).toHaveBeenCalledWith(
				"user-1",
				[
					expect.objectContaining({
						kind: "CALENDAR_EVENT",
						sourceId: hash,
					}),
				],
			);
		});
	});
});
