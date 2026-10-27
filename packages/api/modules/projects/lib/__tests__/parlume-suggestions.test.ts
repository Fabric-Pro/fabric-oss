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
	log: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		parlumeMeetingSession: { findFirst: mocks.session },
		parlumeMeetingSegment: { findMany: mocks.segments },
		userStory: { findMany: mocks.stories, count: mocks.storyCount },
		user: { findMany: mocks.users },
	},
	getBoundPromptForAgent: mocks.boundPrompt,
	hasProjectAccess: mocks.hasAccess,
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
	});
	mocks.hasAccess.mockResolvedValue(true);
	mocks.segments.mockImplementation(async ({ where }) =>
		where.source === "CHAT"
			? [{ text: "Link to the spec?", speakerName: "Sam" }]
			: [
					{ text: "Who owns the export?", speakerName: "Alex" },
					{ text: "We said Friday.", speakerName: "Sam" },
				],
	);
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

const speech = [
	{ text: "Who owns the export?", speakerName: "Alex" },
	{ text: "We said Friday.", speakerName: "Sam" },
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
		).resolves.toEqual(anchored);

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
			anchored,
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
