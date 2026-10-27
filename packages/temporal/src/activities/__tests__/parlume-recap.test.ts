import { PARLUME_RECAP_FALLBACK_BODY } from "@repo/utils/parlume-recap-prompt";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	sessionFindUnique: vi.fn(),
	sessionFindMany: vi.fn(),
	contextFindMany: vi.fn(),
	transcriptFindMany: vi.fn(),
	boundPrompt: vi.fn(),
	getModel: vi.fn(),
	generateText: vi.fn(),
	trackUsage: vi.fn(),
	collectStories: vi.fn(),
	postChat: vi.fn(),
	log: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		parlumeMeetingSession: {
			findUnique: mocks.sessionFindUnique,
			findMany: mocks.sessionFindMany,
		},
		projectContext: { findMany: mocks.contextFindMany },
		projectMeetingTranscript: { findMany: mocks.transcriptFindMany },
	},
	getBoundPromptForAgent: mocks.boundPrompt,
	tenantWhere: (userId: string, organizationId?: string | null) =>
		organizationId ? { organizationId } : { userId, organizationId: null },
}));
vi.mock("@repo/ai", () => ({
	getAIModelWithMetadata: mocks.getModel,
	generateText: mocks.generateText,
}));
vi.mock("../daily-brief/collect-story-activity", () => ({
	collectStoryActivity: mocks.collectStories,
}));
vi.mock("../parlume-voice", () => ({
	postParlumeMeetingChat: mocks.postChat,
}));
vi.mock("../parlume-log", () => ({ parlumeActivityLog: mocks.log }));

import { postParlumeSeriesRecap } from "../parlume-recap";

const NOW = new Date("2026-10-27T09:00:00.000Z");
const RECAP = "Since last time\n- The team decided to ship the export.";

function notesContext(id: string, notes: string, status = "COMPLETED") {
	return {
		id,
		metadata: { parlumeNotes: notes, parlumeNotesStatus: status },
	};
}

function priorSession(input: {
	contextId: string;
	occurrenceStart?: string | null;
	joinedAt: string;
	endedAt?: string;
}) {
	return {
		transcriptContextId: input.contextId,
		occurrenceStart: input.occurrenceStart
			? new Date(input.occurrenceStart)
			: null,
		joinedAt: new Date(input.joinedAt),
		endedAt: input.endedAt ? new Date(input.endedAt) : null,
	};
}

function prompt(): string {
	return mocks.generateText.mock.calls[0]?.[0]?.prompt ?? "";
}

function skipped(reason: string) {
	return ["info", "recap.skipped", { sessionId: "s-now", reason }];
}

beforeEach(() => {
	vi.resetAllMocks();
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(NOW);
	mocks.sessionFindUnique.mockResolvedValue({
		id: "s-now",
		status: "ACTIVE",
		projectId: "p1",
		organizationId: "o1",
		userId: "u1",
		linkedMeetingId: "lm1",
		suggestionsEnabled: true,
	});
	mocks.sessionFindMany.mockResolvedValue([]);
	mocks.contextFindMany.mockResolvedValue([]);
	mocks.transcriptFindMany.mockResolvedValue([]);
	mocks.boundPrompt.mockResolvedValue(null);
	mocks.getModel.mockResolvedValue({
		model: { modelId: "test-model" },
		trackUsage: mocks.trackUsage,
	});
	mocks.generateText.mockResolvedValue({ text: `  ${RECAP}\n` });
	mocks.collectStories.mockResolvedValue({ stories: [], tasks: [] });
	mocks.postChat.mockResolvedValue({ sent: true, tag: "P1" });
});

afterEach(() => {
	vi.useRealTimers();
});

describe("postParlumeSeriesRecap: the previous meeting", () => {
	it("recaps the latest earlier Parlume session of the series from its notes", async () => {
		mocks.sessionFindMany.mockResolvedValue([
			priorSession({
				contextId: "c1",
				occurrenceStart: "2026-10-20T09:00:00.000Z",
				joinedAt: "2026-10-20T09:01:00.000Z",
				endedAt: "2026-10-20T09:40:00.000Z",
			}),
		]);
		mocks.contextFindMany.mockResolvedValue([
			notesContext("c1", "## Decisions\n- Ship the export."),
		]);

		await postParlumeSeriesRecap({ sessionId: "s-now" });

		expect(mocks.sessionFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					linkedMeetingId: "lm1",
					projectId: "p1",
					organizationId: "o1",
					id: { not: "s-now" },
					status: "ENDED",
					transcriptContextId: { not: null },
					joinedAt: {
						gte: new Date("2026-07-29T09:00:00.000Z"),
						lt: NOW,
					},
				},
			}),
		);
		expect(mocks.contextFindMany).toHaveBeenCalledWith({
			where: {
				id: { in: ["c1"] },
				projectId: "p1",
				organizationId: "o1",
			},
			select: { id: true, metadata: true },
		});
		expect(prompt()).toContain("Ship the export.");
		expect(prompt()).toContain("Previous meeting on 2026-10-20");
		expect(mocks.transcriptFindMany).not.toHaveBeenCalled();
		expect(mocks.collectStories).toHaveBeenCalledWith({
			projectId: "p1",
			organizationId: "o1",
			timeWindowStart: new Date("2026-10-20T09:40:00.000Z"),
			timeWindowEnd: NOW,
		});
		expect(mocks.postChat).toHaveBeenCalledExactlyOnceWith({
			sessionId: "s-now",
			message: RECAP,
		});
		expect(mocks.log).toHaveBeenCalledWith("info", "recap.posted", {
			sessionId: "s-now",
			source: "parlume_notes",
			workItems: 0,
			chars: RECAP.length,
			sent: true,
			tag: "P1",
		});
	});

	it("takes the latest meeting whose notes were written, a hand-joined one included", async () => {
		mocks.sessionFindMany.mockResolvedValue([
			priorSession({
				contextId: "c-failed",
				occurrenceStart: "2026-10-23T09:00:00.000Z",
				joinedAt: "2026-10-23T09:00:30.000Z",
			}),
			priorSession({
				contextId: "c-manual",
				occurrenceStart: null,
				joinedAt: "2026-10-21T15:00:00.000Z",
			}),
			priorSession({
				contextId: "c-auto",
				occurrenceStart: "2026-10-13T09:00:00.000Z",
				joinedAt: "2026-10-13T09:00:30.000Z",
			}),
		]);
		mocks.contextFindMany.mockResolvedValue([
			notesContext("c-auto", "Older notes."),
			notesContext("c-failed", "", "FAILED"),
			notesContext("c-manual", "Hand-joined notes."),
		]);

		await postParlumeSeriesRecap({ sessionId: "s-now" });

		expect(mocks.sessionFindMany.mock.calls[0]?.[0].orderBy).toEqual({
			joinedAt: "desc",
		});
		expect(prompt()).toContain("Hand-joined notes.");
		expect(prompt()).not.toContain("Older notes.");
		expect(mocks.collectStories).toHaveBeenCalledWith(
			expect.objectContaining({
				timeWindowStart: new Date("2026-10-21T15:00:00.000Z"),
			}),
		);
	});

	it("falls back to the series' latest transcript when no Parlume notes were written", async () => {
		mocks.sessionFindMany.mockResolvedValue([
			priorSession({
				contextId: "c1",
				joinedAt: "2026-10-20T09:00:00.000Z",
			}),
		]);
		mocks.contextFindMany.mockResolvedValue([
			notesContext("c1", "", "PENDING"),
		]);
		mocks.transcriptFindMany.mockResolvedValue([
			{
				id: "t1",
				meetingSubject: "Weekly sync",
				meetingDate: new Date("2026-10-20T09:00:00.000Z"),
				summary: "Discussed the export.",
				extractedDecisions: [{ text: "Ship the export on Friday" }],
				extractedQuestions: [{ text: "Who reviews the copy?" }],
				actionItems: [
					{
						id: "a1",
						text: "Draft the release note",
						tentativeOwnerName: "Dev Example",
						dueHint: null,
					},
				],
			},
		]);

		await postParlumeSeriesRecap({ sessionId: "s-now" });

		const [query] = mocks.transcriptFindMany.mock.calls[0] ?? [];
		expect(query.where).toEqual({
			projectId: "p1",
			linkedMeetingId: "lm1",
			project: { organizationId: "o1" },
			meetingDate: { gte: new Date("2026-07-29T09:00:00.000Z"), lt: NOW },
		});
		expect(query.take).toBe(1);
		expect(prompt()).toContain(
			'Previous meeting "Weekly sync" on 2026-10-20',
		);
		expect(prompt()).toContain("- Ship the export on Friday");
		expect(prompt()).toContain("- Who reviews the copy?");
		expect(prompt()).toContain(
			"- Draft the release note · owner: Dev Example",
		);
		expect(mocks.collectStories).toHaveBeenCalledWith(
			expect.objectContaining({
				timeWindowStart: new Date("2026-10-20T09:00:00.000Z"),
			}),
		);
		expect(mocks.log).toHaveBeenCalledWith(
			"info",
			"recap.posted",
			expect.objectContaining({ source: "transcript" }),
		);
	});

	it("uses only sessions of the same project and organization", async () => {
		mocks.sessionFindMany.mockResolvedValue([
			priorSession({
				contextId: "c1",
				joinedAt: "2026-10-20T09:00:00.000Z",
			}),
		]);
		// The context lookup is scoped to the session's project, so another
		// project's transcript is not returned.
		mocks.contextFindMany.mockResolvedValue([]);

		await postParlumeSeriesRecap({ sessionId: "s-now" });

		const [sessions] = mocks.sessionFindMany.mock.calls[0] ?? [];
		expect(sessions.where).toMatchObject({
			projectId: "p1",
			organizationId: "o1",
			id: { not: "s-now" },
		});
		expect(mocks.contextFindMany.mock.calls[0]?.[0].where).toMatchObject({
			projectId: "p1",
			organizationId: "o1",
		});
		expect(mocks.generateText).not.toHaveBeenCalled();
		expect(mocks.postChat).not.toHaveBeenCalled();
		expect(mocks.log).toHaveBeenCalledWith(
			...skipped("no_previous_meeting"),
		);
	});

	it("posts nothing when the series has no earlier meeting", async () => {
		await postParlumeSeriesRecap({ sessionId: "s-now" });

		expect(mocks.contextFindMany).not.toHaveBeenCalled();
		expect(mocks.getModel).not.toHaveBeenCalled();
		expect(mocks.postChat).not.toHaveBeenCalled();
		expect(mocks.log).toHaveBeenCalledWith(
			...skipped("no_previous_meeting"),
		);
	});

	it("posts nothing for a transcript with no content", async () => {
		mocks.transcriptFindMany.mockResolvedValue([
			{
				id: "t1",
				meetingSubject: null,
				meetingDate: new Date("2026-10-20T09:00:00.000Z"),
				summary: null,
				extractedDecisions: null,
				extractedQuestions: "malformed",
				actionItems: [],
			},
		]);

		await postParlumeSeriesRecap({ sessionId: "s-now" });

		expect(mocks.postChat).not.toHaveBeenCalled();
		expect(mocks.log).toHaveBeenCalledWith(
			...skipped("no_previous_meeting"),
		);
	});

	it.each([
		[
			"a meeting that is not a linked series",
			{ linkedMeetingId: null, status: "ACTIVE" },
			"not_series",
		],
		[
			"a meeting Parlume has already left",
			{ linkedMeetingId: "lm1", status: "ENDED" },
			"not_live",
		],
		[
			"a session invited with Chat suggestions off",
			{
				linkedMeetingId: "lm1",
				status: "ACTIVE",
				suggestionsEnabled: false,
			},
			"suggestions_off",
		],
	])("posts nothing for %s", async (_label, session, reason) => {
		mocks.sessionFindUnique.mockResolvedValue({
			id: "s-now",
			projectId: "p1",
			organizationId: "o1",
			userId: "u1",
			suggestionsEnabled: true,
			...session,
		});

		await postParlumeSeriesRecap({ sessionId: "s-now" });

		expect(mocks.sessionFindMany).not.toHaveBeenCalled();
		expect(mocks.contextFindMany).not.toHaveBeenCalled();
		expect(mocks.transcriptFindMany).not.toHaveBeenCalled();
		expect(mocks.collectStories).not.toHaveBeenCalled();
		expect(mocks.getModel).not.toHaveBeenCalled();
		expect(mocks.postChat).not.toHaveBeenCalled();
		expect(mocks.log).toHaveBeenCalledWith(...skipped(reason));
	});
});

describe("postParlumeSeriesRecap: the recap", () => {
	beforeEach(() => {
		mocks.sessionFindMany.mockResolvedValue([
			priorSession({
				contextId: "c1",
				joinedAt: "2026-10-20T09:00:00.000Z",
			}),
		]);
		mocks.contextFindMany.mockResolvedValue([
			notesContext("c1", "Decided to ship the export."),
		]);
	});

	it("uses the seeded default instructions when no prompt is bound", async () => {
		await postParlumeSeriesRecap({ sessionId: "s-now" });

		expect(mocks.boundPrompt).toHaveBeenCalledWith({
			agentName: "parlume_series_recap",
			documentType: "GENERAL",
			storyKind: null,
			userId: "u1",
			organizationId: "o1",
			projectId: "p1",
		});
		expect(mocks.generateText.mock.calls[0]?.[0].instructions).toBe(
			PARLUME_RECAP_FALLBACK_BODY,
		);
		expect(mocks.getModel).toHaveBeenCalledWith(
			{ taskType: "SIMPLE", complexity: "simple" },
			{
				userId: "u1",
				organizationId: "o1",
				projectId: "p1",
				featureKey: "parlume",
				conversationId: "s-now",
				jobType: "parlume-live-turn",
				promptVersionId: undefined,
			},
		);
		expect(mocks.trackUsage).toHaveBeenCalledOnce();
	});

	it("uses the default instructions when the bound prompt is blank", async () => {
		mocks.boundPrompt.mockResolvedValue({
			version: { id: "v-blank", content: "   " },
		});

		await postParlumeSeriesRecap({ sessionId: "s-now" });

		expect(mocks.generateText.mock.calls[0]?.[0].instructions).toBe(
			PARLUME_RECAP_FALLBACK_BODY,
		);
	});

	it("uses the bound prompt and records its version on the usage", async () => {
		mocks.boundPrompt.mockResolvedValue({
			version: { id: "v1", content: "Edited recap instructions." },
		});

		await postParlumeSeriesRecap({ sessionId: "s-now" });

		expect(mocks.generateText.mock.calls[0]?.[0].instructions).toBe(
			"Edited recap instructions.",
		);
		expect(mocks.getModel.mock.calls[0]?.[1]).toMatchObject({
			promptVersionId: "v1",
		});
	});

	it("fences the material as untrusted data and lists each changed work item once", async () => {
		mocks.collectStories.mockResolvedValue({
			stories: [
				{
					kind: "content_changed",
					storyCuid: "st1",
					storyIdentifier: "F-12",
					title: "Export",
					toValue: "In Progress",
				},
				{
					kind: "created",
					storyCuid: "st2",
					storyIdentifier: "F-13",
					title: "Import",
					toValue: "Backlog",
				},
				{
					kind: "content_changed",
					storyCuid: "st1",
					storyIdentifier: "F-12",
					title: "Export",
					toValue: "v3",
				},
			],
			tasks: [],
		});

		await postParlumeSeriesRecap({ sessionId: "s-now" });

		expect(prompt()).toContain(
			'<recap_input source="previous_meeting" trust="untrusted">',
		);
		expect(prompt()).toContain(
			'<recap_input source="work_items" trust="untrusted">',
		);
		expect(prompt()).toContain("F-12 · Export · edited · In Progress");
		expect(prompt()).toContain("F-13 · Import · created · Backlog");
		expect(prompt()).not.toContain("v3");
		expect(mocks.log).toHaveBeenCalledWith(
			"info",
			"recap.posted",
			expect.objectContaining({ workItems: 2 }),
		);
	});

	it("posts nothing when the model finds nothing to recap", async () => {
		mocks.generateText.mockResolvedValue({ text: "  \n" });

		await postParlumeSeriesRecap({ sessionId: "s-now" });

		expect(mocks.postChat).not.toHaveBeenCalled();
		expect(mocks.log).toHaveBeenCalledWith(...skipped("nothing_to_recap"));
	});

	it("logs a failure instead of throwing", async () => {
		mocks.generateText.mockRejectedValue(new Error("model unavailable"));

		await expect(
			postParlumeSeriesRecap({ sessionId: "s-now" }),
		).resolves.toBeUndefined();

		expect(mocks.postChat).not.toHaveBeenCalled();
		expect(mocks.log).toHaveBeenCalledWith("warn", "recap.failed", {
			sessionId: "s-now",
			error: "Error: model unavailable",
		});
	});

	it("logs a post the chat could not take", async () => {
		mocks.postChat.mockResolvedValue({
			sent: false,
			reason: "chat_unavailable",
		});

		await postParlumeSeriesRecap({ sessionId: "s-now" });

		expect(mocks.log).toHaveBeenCalledWith(
			"warn",
			"recap.posted",
			expect.objectContaining({
				sent: false,
				reason: "chat_unavailable",
			}),
		);
	});
});
