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
	log: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		parlumeMeetingSession: { findFirst: mocks.session },
		parlumeMeetingSegment: { findMany: mocks.segments },
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
	mocks.retrieve.mockResolvedValue([{ content: "F-12 Export the roadmap" }]);
	mocks.boundPrompt.mockResolvedValue(null);
	mocks.model.mockResolvedValue({
		model: "fast-model",
		trackUsage: mocks.trackUsage,
	});
	mocks.generate.mockResolvedValue({
		object: { suggest: true, text: "F-12 covers the export." },
	});
});

describe("normalizeParlumeSuggestion", () => {
	it.each([
		[
			{ suggest: true, text: "  Ask   who owns it.  " },
			{ suggest: true, text: "Ask who owns it." },
		],
		[{ suggest: true, text: "   " }, { suggest: false }],
		[{ suggest: true }, { suggest: false }],
		[{ suggest: false, text: "Ignored" }, { suggest: false }],
		[{}, { suggest: false }],
	])("reads %j leniently", (output, expected) => {
		expect(normalizeParlumeSuggestion(output)).toEqual(expected);
	});

	it("caps a long suggestion", () => {
		const result = normalizeParlumeSuggestion({
			suggest: true,
			text: "x".repeat(900),
		});
		expect(result.suggest && result.text).toHaveLength(500);
	});
});

describe("suggestParlumeMeetingContribution", () => {
	it("asks a fast model with the meeting fenced as untrusted data, billed to the session", async () => {
		await expect(
			suggestParlumeMeetingContribution({
				...input,
				previous: ["Earlier idea"],
			}),
		).resolves.toEqual({ suggest: true, text: "F-12 covers the export." });

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
		expect(prompt).toContain('source="earlier_suggestions"');
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
			{
				suggest: true,
				text: "F-12 covers the export.",
			},
		);
		expect(mocks.generate.mock.calls[0]?.[0].prompt).not.toContain(
			'source="project"',
		);
	});
});
