import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeParlumeMeetingTurn } from "../parlume";

const mocks = vi.hoisted(() => ({
	turn: vi.fn(),
	segments: vi.fn(),
	history: vi.fn(),
	update: vi.fn(),
	updateMany: vi.fn(),
	session: vi.fn(),
	hasAccess: vi.fn(),
	load: vi.fn(),
	gather: vi.fn(),
	execute: vi.fn(),
	retrieve: vi.fn(),
	speak: vi.fn(),
	chat: vi.fn(),
	stop: vi.fn(),
	actions: vi.fn(),
	voiceState: vi.fn(),
	toolContext: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	db: {
		parlumeMeetingTurn: {
			findUnique: mocks.turn,
			findMany: mocks.history,
			update: mocks.update,
			updateMany: mocks.updateMany,
		},
		parlumeMeetingSession: { updateMany: mocks.session },
		parlumeMeetingSegment: { findMany: mocks.segments },
		parlumeAction: { updateMany: mocks.actions },
		$transaction: (operations: Promise<unknown>[]) =>
			Promise.all(operations),
	},
	hasProjectAccess: mocks.hasAccess,
}));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@temporalio/activity", () => ({
	Context: {
		current: () => ({
			cancellationSignal: new AbortController().signal,
			heartbeat: vi.fn(),
		}),
	},
}));
vi.mock("../parlume-agent", () => ({
	loadParlumeAgent: mocks.load,
	gatherParlumeAgentContext: mocks.gather,
	executeParlumeAgent: mocks.execute,
}));
vi.mock("../parlume-actions", () => ({
	createParlumeToolRuntime: (context: { proposalTags?: string[] }) => {
		mocks.toolContext(context);
		return { invoke: vi.fn() };
	},
}));
vi.mock("../parlume-voice", () => ({
	PARLUME_MAX_SPOKEN_CHARS: 675,
	PARLUME_HEADLINE_SPOKEN_CHARS: 350,
	readParlumeVoiceState: mocks.voiceState,
	speakParlumeResponse: mocks.speak,
	postParlumeMeetingChat: mocks.chat,
	postParlumeRealtimeResult: vi.fn(),
	requestParlumeMeetingStop: mocks.stop,
}));
vi.mock("../project-metadata", () => ({
	retrieveProjectContextsActivity: mocks.retrieve,
}));
vi.mock("../parlume-turn-audit", () => ({
	recordParlumeTurnAnswered: vi.fn(),
}));

// A confidential meeting of several people: Alex invited Parlume, Bo asks,
// and Cy spoke in the confidential part.
const SEGMENTS = [
	{
		source: "SPEECH",
		confidential: false,
		speakerName: "Alex",
		text: "The launch moves to May.",
	},
	{
		source: "SPEECH",
		confidential: true,
		speakerName: "Cy",
		text: "The buyer is Example Holdings.",
	},
	{
		source: "CHAT",
		confidential: false,
		speakerName: "Bo",
		text: "Slides are in the shared drive.",
	},
	{
		source: "CHAT",
		confidential: true,
		speakerName: "Cy",
		text: "The offer is forty million.",
	},
];

const CONFIDENTIAL_WORDS = /Example Holdings|forty million/;

function turn() {
	return {
		id: "turn",
		status: "PENDING",
		voiceGeneration: 3,
		speakerId: "speaker-bo",
		speakerName: "Bo",
		requesterUserId: "member-bo",
		requestText: "Summarize what we decided about the launch.",
		replyChannel: "VOICE",
		session: {
			id: "session",
			projectId: "project",
			organizationId: "org",
			userId: "inviter-alex",
			agentKind: "FABRIC_AGENT",
			status: "ACTIVE",
			toolsReadOnly: true,
			voiceGeneration: 3,
			confidential: true,
			confidentialSince: null,
		},
	};
}

beforeEach(() => {
	vi.resetAllMocks();
	mocks.turn.mockResolvedValue(turn());
	mocks.hasAccess.mockResolvedValue(true);
	mocks.updateMany.mockResolvedValue({ count: 1 });
	mocks.load.mockResolvedValue({
		kind: "FABRIC_AGENT",
		revision: "current-revision",
	});
	mocks.execute.mockResolvedValue({ success: true, response: "The plan." });
	mocks.retrieve.mockResolvedValue({ context: "Project knowledge" });
	mocks.segments.mockImplementation(
		async (query: { where: { source: string; confidential?: boolean } }) =>
			SEGMENTS.filter(
				(segment) =>
					segment.source === query.where.source &&
					(query.where.confidential === undefined ||
						segment.confidential === query.where.confidential),
			).map(({ text, speakerName }) => ({ text, speakerName })),
	);
	mocks.history.mockResolvedValue([
		{
			requestText: "Who is the buyer?",
			responseText: "The buyer is Example Holdings.",
		},
	]);
	mocks.speak.mockResolvedValue({
		played: true,
		interrupted: false,
		firstAudioAt: new Date().toISOString(),
	});
	mocks.voiceState.mockResolvedValue({
		current: true,
		chatAvailable: true,
	});
});

/** Everything the agent was given for the turn, as one string. */
function agentInput(): string {
	expect(mocks.execute).toHaveBeenCalledTimes(1);
	return JSON.stringify(mocks.execute.mock.calls[0]?.[0]);
}

describe("a confidential meeting of several people", () => {
	it("answers a room with anyone unverified from the project and the open discussion only, with no quote, paraphrase or earlier answer of the confidential part", async () => {
		await executeParlumeMeetingTurn({ turnId: "turn" });

		expect(mocks.retrieve).toHaveBeenCalledTimes(1);
		expect(mocks.retrieve.mock.calls[0]?.[2]).toBe("member-bo");
		expect(mocks.execute).toHaveBeenCalledWith(
			expect.objectContaining({ requesterUserId: "member-bo" }),
		);
		const given = agentInput();
		expect(given).toContain("Project knowledge");
		expect(given).toContain("The launch moves to May.");
		expect(given).toContain("Slides are in the shared drive.");
		expect(given).not.toMatch(CONFIDENTIAL_WORDS);
		expect(mocks.history).not.toHaveBeenCalled();
	});

	it("answers a room where everyone present is verified from the confidential part too, still with the asker's access", async () => {
		await executeParlumeMeetingTurn({
			turnId: "turn",
			withConfidential: true,
		});

		expect(mocks.retrieve.mock.calls[0]?.[2]).toBe("member-bo");
		const given = agentInput();
		expect(given).toContain("The launch moves to May.");
		expect(given).toContain("Example Holdings");
		expect(given).toContain("forty million");
		expect(mocks.history).toHaveBeenCalled();
	});

	it("never reads with the inviter's access for an asker who cannot read the project, though the inviter and the room can", async () => {
		mocks.hasAccess.mockImplementation(
			async (_projectId: string, userId: string) =>
				userId !== "member-bo",
		);

		await executeParlumeMeetingTurn({
			turnId: "turn",
			withConfidential: true,
		});

		expect(mocks.hasAccess).toHaveBeenCalledWith(
			"project",
			"inviter-alex",
			"org",
		);
		expect(mocks.hasAccess).toHaveBeenCalledWith(
			"project",
			"member-bo",
			"org",
		);
		expect(mocks.retrieve).not.toHaveBeenCalled();
		expect(mocks.segments).not.toHaveBeenCalled();
		expect(mocks.gather).not.toHaveBeenCalled();
		expect(mocks.execute).not.toHaveBeenCalled();
		const written = JSON.stringify(mocks.update.mock.calls);
		expect(written).not.toMatch(CONFIDENTIAL_WORDS);
	});
});
