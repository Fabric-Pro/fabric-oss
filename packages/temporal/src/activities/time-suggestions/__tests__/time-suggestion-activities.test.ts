import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	collectUnclaimedTimeEvidence: vi.fn(),
	listAuthorLoggedTime: vi.fn(),
	getBoundPromptForAgent: vi.fn(),
	generateText: vi.fn(),
	getAIModelWithMetadata: vi.fn(),
	logModelUsageAsync: vi.fn(),
	renderTemplate: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	collectUnclaimedTimeEvidence: mocks.collectUnclaimedTimeEvidence,
	listAuthorLoggedTime: mocks.listAuthorLoggedTime,
	getBoundPromptForAgent: mocks.getBoundPromptForAgent,
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
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
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
});
