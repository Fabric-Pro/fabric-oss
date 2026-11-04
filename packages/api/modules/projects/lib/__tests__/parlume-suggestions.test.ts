import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	session: vi.fn(),
	segments: vi.fn(),
	hasAccess: vi.fn(),
	boundPrompt: vi.fn(),
	model: vi.fn(),
	trackUsage: vi.fn(),
	generate: vi.fn(),
	retrieve: vi.fn(),
	stories: vi.fn(),
	storyCount: vi.fn(),
	users: vi.fn(),
	agenda: vi.fn(),
	priorTranscripts: vi.fn(),
	log: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		parlumeMeetingSession: { findFirst: mocks.session },
		parlumeMeetingSegment: { findMany: mocks.segments },
		projectMeetingAgenda: { findFirst: mocks.agenda },
		userStory: { findMany: mocks.stories, count: mocks.storyCount },
		user: { findMany: mocks.users },
	},
	getBoundPromptForAgent: mocks.boundPrompt,
	hasProjectAccess: mocks.hasAccess,
	tenantWhere: vi.fn(),
}));
vi.mock("@repo/temporal/prior-series-transcripts", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@repo/temporal/prior-series-transcripts")
	>()),
	findPriorSeriesTranscripts: mocks.priorTranscripts,
}));
vi.mock("@repo/ai", () => ({
	generateObject: mocks.generate,
	getAIModelWithMetadata: mocks.model,
}));
vi.mock("@repo/rag", () => ({
	retrieveProjectContexts: mocks.retrieve,
	formatContextsForPrompt: (contexts: Array<{ content: string }>) =>
		contexts.map((context) => context.content).join("\n"),
}));
vi.mock("../parlume-log", () => ({ parlumeLog: mocks.log }));

import {
	formatParlumeWorkItems,
	normalizeParlumeSuggestion,
	suggestParlumeMeetingContribution,
} from "../parlume-suggestions";

const input = { sessionId: "session-1", botId: "bot-1", previous: [] };

beforeEach(() => {
	vi.resetAllMocks();
	mocks.session.mockResolvedValue({
		id: "session-1",
		projectId: "project-1",
		organizationId: "org-1",
		userId: "user-1",
		suggestionsEnabled: true,
		suggestionAudience: "MEETING",
		linkedMeetingId: null,
		occurrenceStart: null,
		createdAt: new Date("2026-11-04T10:00:00Z"),
	});
	mocks.hasAccess.mockResolvedValue(true);
	mocks.segments.mockImplementation(async ({ where }) =>
		where.source === "CHAT"
			? [{ text: "Link to the spec?", speakerName: "Sam" }]
			: where.createdAt.lt
				? earlierSpeech
				: [
						{ text: "Who owns the export?", speakerName: "Alex" },
						{ text: "We said Friday.", speakerName: "Sam" },
					],
	);
	mocks.agenda.mockResolvedValue(null);
	mocks.priorTranscripts.mockResolvedValue([]);
	mocks.retrieve.mockResolvedValue([
		{ type: "TEXT", content: "F-12 Export the roadmap" },
	]);
	mocks.stories.mockResolvedValue([
		{
			identifier: "F-12",
			title: "Export the roadmap",
			priority: "P1_HIGH",
			assigneeId: "user-2",
			status: { name: "In Progress" },
		},
		{
			identifier: "F-14",
			title: "Archive old sprints",
			priority: "P3_LOW",
			assigneeId: null,
			status: { name: "Backlog" },
		},
	]);
	mocks.storyCount.mockResolvedValue(2);
	mocks.users.mockResolvedValue([{ id: "user-2", name: "Dana" }]);
	mocks.boundPrompt.mockResolvedValue(null);
	mocks.model.mockResolvedValue({
		model: "fast-model",
		trackUsage: mocks.trackUsage,
	});
	mocks.generate.mockResolvedValue({
		object: anchored,
	});
});

const anchored = {
	suggest: true,
	text: "F-12 covers the export.",
	speaker: "Alex",
	quote: "who owns the export",
	topic: "Export ownership",
};

/** What the service answers for `anchored`: an answer, for the whole meeting. */
const answered = { ...anchored, kind: "answer", audience: "MEETING" };

const speech = [
	{ text: "Who owns the export?", speakerName: "Alex" },
	{ text: "We said Friday.", speakerName: "Sam" },
];

/** Said before the live window. */
const earlierSpeech = [
	{ text: "Next we cover the data migration.", speakerName: "Dana" },
	{ text: "Welcome, everyone.", speakerName: "Alex" },
];

describe("normalizeParlumeSuggestion", () => {
	it.each([
		[
			{
				...anchored,
				text: "  Ask   who owns it.  ",
				quote: '"Who owns the export?"',
			},
			{
				...anchored,
				kind: "answer",
				text: "Ask who owns it.",
				quote: "Who owns the export?",
			},
		],
		[{ ...anchored, text: "   " }, { suggest: false }],
		[{ suggest: true }, { suggest: false }],
		[{ ...anchored, suggest: false }, { suggest: false }],
		[{}, { suggest: false }],
	])("reads %j leniently", (output, expected) => {
		expect(normalizeParlumeSuggestion(output, speech)).toEqual(expected);
	});

	// Anchored in the meeting, or nothing: the room must be able to tell which
	// remark a suggestion answers, and an invented one points at nothing.
	it.each([
		["no quote", { ...anchored, quote: "" }],
		["no topic", { ...anchored, topic: " " }],
		["words nobody said", { ...anchored, quote: "the export is late" }],
		["words put to the wrong speaker", { ...anchored, speaker: "Sam" }],
	])("drops a suggestion with %s", (_label, output) => {
		expect(normalizeParlumeSuggestion(output, speech)).toEqual({
			suggest: false,
		});
	});

	// An organization's edited prompt may never mention kind.
	it.each([
		[undefined, "answer"],
		["answer", "answer"],
		["something else", "answer"],
		["missed_question", "missed_question"],
		["Missed question", "missed_question"],
	])("reads kind %j as %s", (kind, expected) => {
		const result = normalizeParlumeSuggestion(
			{ ...anchored, kind },
			speech,
		);
		expect(result.suggest && result.kind).toBe(expected);
	});

	// A missed question points at the remark that opened its topic, which
	// may come before the live window; an answer answers a recent remark.
	it("anchors a missed question in the earlier meeting, an answer only in the window", () => {
		const opener = {
			...anchored,
			speaker: "Dana",
			quote: "we cover the data migration",
			topic: "Data migration",
			text: "Who signs off the migration?",
		};

		expect(
			normalizeParlumeSuggestion(
				{ ...opener, kind: "missed_question" },
				speech,
				earlierSpeech,
			),
		).toEqual({ ...opener, suggest: true, kind: "missed_question" });
		expect(
			normalizeParlumeSuggestion(
				{ ...opener, kind: "answer" },
				speech,
				earlierSpeech,
			),
		).toEqual({ suggest: false });
		expect(
			normalizeParlumeSuggestion(
				{ ...opener, kind: "missed_question", quote: "nobody said it" },
				speech,
				earlierSpeech,
			),
		).toEqual({ suggest: false });
	});

	it("caps a long suggestion", () => {
		const result = normalizeParlumeSuggestion(
			{ ...anchored, text: "x".repeat(900) },
			speech,
		);
		expect(result.suggest && result.text).toHaveLength(500);
	});
});

describe("formatParlumeWorkItems", () => {
	const item = {
		identifier: "F-3",
		title: "  Ship   billing ",
		priority: "P0_CRITICAL",
		status: "In Progress",
		owner: null,
	};

	it("says when there is nothing open and when the list is cut", () => {
		expect(formatParlumeWorkItems([], 0)).toBe("No open work items.");
		expect(formatParlumeWorkItems([item], 3)).toBe(
			"F-3 | Ship billing | In Progress | p0 critical | owner: unassigned\n(2 more open work items not shown)",
		);
	});
});

describe("suggestParlumeMeetingContribution", () => {
	it("asks a fast model with the meeting fenced as untrusted data, billed to the session", async () => {
		await expect(
			suggestParlumeMeetingContribution({
				...input,
				previous: ["Earlier idea"],
			}),
		).resolves.toEqual(answered);

		expect(mocks.model).toHaveBeenCalledWith(
			{ taskType: "SIMPLE", complexity: "simple" },
			expect.objectContaining({
				featureKey: "parlume",
				conversationId: "session-1",
				projectId: "project-1",
				organizationId: "org-1",
			}),
		);
		expect(mocks.trackUsage).toHaveBeenCalledTimes(1);
		expect(mocks.generate).toHaveBeenCalledTimes(1);
		const [{ prompt, instructions }] = mocks.generate.mock.calls[0];
		expect(instructions).toContain("You are Parlume");
		expect(prompt).toContain(
			'<meeting_input source="transcript" trust="untrusted">\nSam: We said Friday.\nAlex: Who owns the export?\n</meeting_input>',
		);
		expect(prompt).toContain('source="chat"');
		expect(prompt).toContain("Sam: Link to the spec?");
		expect(prompt).toContain("F-12 Export the roadmap");
		expect(prompt).toContain(
			'<meeting_input source="work_items" trust="untrusted">\nF-12 | Export the roadmap | In Progress | p1 high | owner: Dana\nF-14 | Archive old sprints | Backlog | p3 low | owner: unassigned\n</meeting_input>',
		);
		expect(prompt).toContain('source="earlier_suggestions"');
		expect(mocks.stories).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { projectId: "project-1", status: { isFinal: false } },
			}),
		);
	});

	it("gives the meeting before the window, oldest first, fenced as untrusted data", async () => {
		await suggestParlumeMeetingContribution(input);

		const [{ prompt }] = mocks.generate.mock.calls[0];
		expect(prompt).toContain(
			'<meeting_input source="earlier_meeting" trust="untrusted">\nAlex: Welcome, everyone.\nDana: Next we cover the data migration.\n</meeting_input>',
		);
		expect(mocks.segments).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					source: "SPEECH",
					createdAt: { lt: expect.any(Date) },
				}),
			}),
		);
	});

	it("keeps the most recent part of a long earlier meeting", async () => {
		const long = Array.from({ length: 300 }, (_, index) => ({
			text: `Remark number ${index} about the plan.`,
			speakerName: "Alex",
		}));
		mocks.segments.mockImplementation(async ({ where }) =>
			where.source === "CHAT" ? [] : where.createdAt.lt ? long : speech,
		);

		await suggestParlumeMeetingContribution(input);

		const [{ prompt }] = mocks.generate.mock.calls[0];
		// Newest first from the database: index 0 is the latest remark.
		expect(prompt).toContain("Remark number 0 about the plan.");
		expect(prompt).not.toContain("Remark number 299 about the plan.");
	});

	it("leaves out the agenda and previous questions for a session outside a series", async () => {
		await suggestParlumeMeetingContribution(input);

		const [{ prompt }] = mocks.generate.mock.calls[0];
		expect(prompt).not.toContain('source="agenda"');
		expect(prompt).not.toContain('source="previous_meeting_questions"');
		expect(mocks.agenda).not.toHaveBeenCalled();
		expect(mocks.priorTranscripts).not.toHaveBeenCalled();
	});

	it("gives a series session its occurrence's ready agenda and the previous meeting's open questions", async () => {
		mocks.session.mockResolvedValue({
			id: "session-1",
			projectId: "project-1",
			organizationId: "org-1",
			userId: "user-1",
			suggestionsEnabled: true,
			suggestionAudience: "MEETING",
			linkedMeetingId: "series-1",
			occurrenceStart: new Date("2026-11-04T09:00:00Z"),
			createdAt: new Date("2026-11-04T08:59:00Z"),
		});
		mocks.agenda.mockResolvedValue({
			content: "1. Data migration\n2. Training plan",
		});
		mocks.priorTranscripts.mockResolvedValue([
			{
				extractedQuestions: [
					{ text: "Who owns the training plan?" },
					{ nope: true },
				],
			},
		]);

		await suggestParlumeMeetingContribution(input);

		const [{ prompt }] = mocks.generate.mock.calls[0];
		expect(prompt).toContain(
			'<meeting_input source="agenda" trust="untrusted">\n1. Data migration\n2. Training plan\n</meeting_input>',
		);
		expect(prompt).toContain(
			'<meeting_input source="previous_meeting_questions" trust="untrusted">\n- Who owns the training plan?\n</meeting_input>',
		);
		expect(mocks.agenda).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					projectId: "project-1",
					linkedMeetingId: "series-1",
					status: "READY",
					occurrenceStart: {
						gte: new Date("2026-11-04T00:00:00Z"),
						lt: new Date("2026-11-05T00:00:00Z"),
					},
				},
			}),
		);
		expect(mocks.priorTranscripts).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "project-1",
				organizationId: "org-1",
				linkedMeetingId: "series-1",
				before: new Date("2026-11-04T09:00:00Z"),
				take: 1,
			}),
		);
	});

	it("still asks when the agenda or previous meeting cannot be read", async () => {
		mocks.session.mockResolvedValue({
			id: "session-1",
			projectId: "project-1",
			organizationId: "org-1",
			userId: "user-1",
			suggestionsEnabled: true,
			suggestionAudience: "MEETING",
			linkedMeetingId: "series-1",
			occurrenceStart: null,
			createdAt: new Date("2026-11-04T08:59:00Z"),
		});
		mocks.agenda.mockRejectedValue(new Error("database unavailable"));
		mocks.priorTranscripts.mockRejectedValue(new Error("timeout"));

		await expect(suggestParlumeMeetingContribution(input)).resolves.toEqual(
			answered,
		);
	});

	it("answers with the session's current audience", async () => {
		mocks.session.mockResolvedValue({
			id: "session-1",
			projectId: "project-1",
			organizationId: "org-1",
			userId: "user-1",
			suggestionsEnabled: true,
			suggestionAudience: "TEAM",
			linkedMeetingId: null,
			occurrenceStart: null,
			createdAt: new Date("2026-11-04T08:59:00Z"),
		});

		await expect(
			suggestParlumeMeetingContribution({ ...input, teamAudience: true }),
		).resolves.toEqual({ ...answered, audience: "TEAM" });
	});

	// A bridge that cannot keep a suggestion off the chat would post a
	// team-only one to every participant.
	it("offers a team-only session nothing through a bridge that would post it", async () => {
		mocks.session.mockResolvedValue({
			id: "session-1",
			projectId: "project-1",
			organizationId: "org-1",
			userId: "user-1",
			suggestionsEnabled: true,
			suggestionAudience: "TEAM",
			linkedMeetingId: null,
			occurrenceStart: null,
			createdAt: new Date("2026-11-04T08:59:00Z"),
		});

		await expect(suggestParlumeMeetingContribution(input)).resolves.toEqual(
			{ suggest: false },
		);
		expect(mocks.generate).not.toHaveBeenCalled();
	});

	it("passes a missed question through with its kind", async () => {
		mocks.generate.mockResolvedValue({
			object: {
				suggest: true,
				kind: "missed_question",
				text: "Who signs off the migration?",
				speaker: "Dana",
				quote: "we cover the data migration",
				topic: "Data migration",
			},
		});

		await expect(suggestParlumeMeetingContribution(input)).resolves.toEqual(
			{
				suggest: true,
				kind: "missed_question",
				text: "Who signs off the migration?",
				speaker: "Dana",
				quote: "we cover the data migration",
				topic: "Data migration",
				audience: "MEETING",
			},
		);
	});

	// On staging a project's passages were all transcripts of earlier meetings
	// with the same remarks: what people said, not the project's state.
	it("leaves earlier meetings' transcripts out of the project passages", async () => {
		mocks.retrieve.mockResolvedValue([
			{
				type: "MEETING_TRANSCRIPT",
				content: "Last week: nobody owns the export",
			},
			{ type: "TEXT", content: "Release plan: ship on Friday" },
		]);

		await suggestParlumeMeetingContribution(input);

		const [{ prompt }] = mocks.generate.mock.calls[0];
		expect(prompt).toContain("Release plan: ship on Friday");
		expect(prompt).not.toContain("Last week: nobody owns the export");
		expect(mocks.retrieve).toHaveBeenCalledWith(
			expect.objectContaining({ diversify: true }),
		);
	});

	it("uses the prompt bound for the organization when there is one", async () => {
		mocks.boundPrompt.mockResolvedValue({
			version: { id: "version-1", content: "Bound instructions" },
		});

		await suggestParlumeMeetingContribution(input);

		expect(mocks.boundPrompt).toHaveBeenCalledWith(
			expect.objectContaining({
				agentName: "parlume_meeting_suggestion",
				documentType: "GENERAL",
				storyKind: null,
			}),
		);
		expect(mocks.generate.mock.calls[0]?.[0].instructions).toBe(
			"Bound instructions",
		);
		expect(mocks.model).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ promptVersionId: "version-1" }),
		);
	});

	it.each([
		["the session turned suggestions off", { suggestionsEnabled: false }],
		["the session is not live", null],
	])("offers nothing when %s", async (_label, session) => {
		mocks.session.mockResolvedValue(
			session && {
				id: "session-1",
				projectId: "project-1",
				organizationId: "org-1",
				userId: "user-1",
				...session,
			},
		);

		await expect(suggestParlumeMeetingContribution(input)).resolves.toEqual(
			{
				suggest: false,
			},
		);
		expect(mocks.generate).not.toHaveBeenCalled();
	});

	it("offers nothing once the inviter has lost project access", async () => {
		mocks.hasAccess.mockResolvedValue(false);

		await expect(suggestParlumeMeetingContribution(input)).resolves.toEqual(
			{
				suggest: false,
			},
		);
		expect(mocks.generate).not.toHaveBeenCalled();
	});

	it("offers nothing when nobody has spoken in the window", async () => {
		mocks.segments.mockResolvedValue([]);

		await expect(suggestParlumeMeetingContribution(input)).resolves.toEqual(
			{
				suggest: false,
			},
		);
		expect(mocks.generate).not.toHaveBeenCalled();
	});

	it("treats a failed model call as no suggestion and logs no meeting text", async () => {
		mocks.generate.mockRejectedValue(new Error("No object generated"));

		await expect(suggestParlumeMeetingContribution(input)).resolves.toEqual(
			{
				suggest: false,
			},
		);
		expect(mocks.log).toHaveBeenCalledWith(
			"warn",
			"suggestion.failed",
			expect.objectContaining({ sessionId: "session-1" }),
		);
		expect(JSON.stringify(mocks.log.mock.calls)).not.toContain("Friday");
	});

	it("still asks without project passages when retrieval fails", async () => {
		mocks.retrieve.mockRejectedValue(new Error("No embeddings"));

		await expect(suggestParlumeMeetingContribution(input)).resolves.toEqual(
			answered,
		);
		expect(mocks.generate.mock.calls[0]?.[0].prompt).not.toContain(
			'source="project"',
		);
	});

	it("logs, without meeting text, a suggestion it dropped as unanchored", async () => {
		mocks.generate.mockResolvedValue({
			object: { ...anchored, quote: "nobody said this" },
		});

		await expect(suggestParlumeMeetingContribution(input)).resolves.toEqual(
			{
				suggest: false,
				audience: "MEETING",
			},
		);
		expect(mocks.log).toHaveBeenCalledWith(
			"info",
			"suggestion.unanchored",
			{
				sessionId: "session-1",
			},
		);
	});
});

it.each([true, false])(
	"searches transcript then chat (optional=%s)",
	async (optional) => {
		mocks.segments.mockImplementation(async ({ where }) =>
			where.source === "CHAT"
				? optional
					? [{ text: "Chat", speakerName: "Sam" }]
					: []
				: [{ text: "Speech", speakerName: "Alex" }],
		);
		await suggestParlumeMeetingContribution(input);
		expect(mocks.retrieve).toHaveBeenCalledWith(
			expect.objectContaining({
				query: optional ? "Alex: Speech Sam: Chat" : "Alex: Speech",
			}),
		);
	},
);
it("bounds the query and preserves the transcript tail", async () => {
	mocks.segments.mockImplementation(async ({ where }) => [
		{
			text: where.source === "CHAT" ? "Chat" : `${"x".repeat(1200)}TAIL`,
			speakerName: "Alex",
		},
	]);
	await suggestParlumeMeetingContribution(input);
	expect(mocks.retrieve.mock.calls[0][0].query).toBe(
		`${"x".repeat(996)}TAIL`,
	);
});

it("fits the newest chat into the budget after the transcript", async () => {
	const transcript = `A: ${"s".repeat(977)}`;
	mocks.segments.mockImplementation(async ({ where }) =>
		where.source === "CHAT"
			? [
					{ text: "Newest", speakerName: "A" },
					{ text: "Middle", speakerName: "A" },
					{ text: "Oldest", speakerName: "A" },
				]
			: [{ text: "s".repeat(977), speakerName: "A" }],
	);
	await suggestParlumeMeetingContribution(input);
	const query = mocks.retrieve.mock.calls[0][0].query;
	expect(query).toBe(`${transcript} A: Middle\nA: Newest`);
	expect(query).not.toContain("Oldest");
	expect(query.length).toBeLessThanOrEqual(1000);
});

it.each([999, 1000])(
	"omits chat when the transcript uses %i characters",
	async (length) => {
		const text = "s".repeat(length - 3);
		mocks.segments.mockImplementation(async ({ where }) => [
			{
				text: where.source === "CHAT" ? "Newest" : text,
				speakerName: "A",
			},
		]);
		await suggestParlumeMeetingContribution(input);
		expect(mocks.retrieve.mock.calls[0][0].query).toBe(`A: ${text}`);
	},
);
