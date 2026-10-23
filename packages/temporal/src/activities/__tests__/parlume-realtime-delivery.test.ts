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
	execute: vi.fn(),
	retrieve: vi.fn(),
	speak: vi.fn(),
	chat: vi.fn(),
	result: vi.fn(),
	voiceState: vi.fn(),
	actions: vi.fn(),
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
		current: () => ({ cancellationSignal: new AbortController().signal }),
	},
}));
vi.mock("../parlume-agent", () => ({
	loadParlumeAgent: mocks.load,
	executeParlumeAgent: mocks.execute,
}));
vi.mock("../parlume-actions", () => ({
	createParlumeToolRuntime: () => ({ invoke: vi.fn() }),
}));
vi.mock("../parlume-voice", () => ({
	PARLUME_MAX_SPOKEN_CHARS: 800,
	PARLUME_HEADLINE_SPOKEN_CHARS: 350,
	readParlumeVoiceState: mocks.voiceState,
	speakParlumeResponse: mocks.speak,
	postParlumeMeetingChat: mocks.chat,
	postParlumeRealtimeResult: mocks.result,
	requestParlumeMeetingStop: vi.fn(),
}));
vi.mock("../project-metadata", () => ({
	retrieveProjectContextsActivity: mocks.retrieve,
}));

const SESSION = {
	id: "session",
	projectId: "project",
	organizationId: "org",
	userId: "user",
	agentKind: "FABRIC_AGENT",
	status: "ACTIVE",
	toolsReadOnly: false,
	voiceGeneration: 3,
};

beforeEach(() => {
	vi.resetAllMocks();
	mocks.turn.mockResolvedValue({
		id: "turn",
		status: "PENDING",
		voiceGeneration: 3,
		speakerId: null,
		speakerName: "Dev One",
		requestText: "File a bug for the export",
		replyChannel: "VOICE",
		createdAt: new Date(),
		session: SESSION,
	});
	mocks.hasAccess.mockResolvedValue(true);
	mocks.updateMany.mockResolvedValue({ count: 1 });
	mocks.session.mockResolvedValue({ count: 1 });
	mocks.load.mockResolvedValue({ kind: "FABRIC_AGENT", revision: "r1" });
	mocks.execute.mockResolvedValue({
		success: true,
		response: "Filed B-12, Export fails.",
	});
	mocks.retrieve.mockResolvedValue({ context: "Project knowledge" });
	mocks.segments.mockResolvedValue([]);
	mocks.history.mockResolvedValue([]);
	mocks.result.mockResolvedValue(true);
	mocks.chat.mockResolvedValue({ sent: true, tag: "P5" });
});

function lastStatusWrite() {
	return mocks.updateMany.mock.calls
		.map(([args]) => args)
		.filter((args) => args.data.status)
		.at(-1);
}

describe("Parlume turns for the realtime voice", () => {
	it("runs the agent as usual but speaks nothing, and hands the answer to the voice", async () => {
		await executeParlumeMeetingTurn({ turnId: "turn", realtimeJob: "J2" });

		expect(mocks.speak).not.toHaveBeenCalled();
		expect(mocks.voiceState).not.toHaveBeenCalled();
		const { voiceInstructions } = mocks.execute.mock.calls[0]?.[0] as {
			voiceInstructions: string;
		};
		expect(voiceInstructions).toContain("Parlume's realtime voice");
		expect(voiceInstructions).not.toContain("Before you call any tool");
		expect(mocks.result).toHaveBeenCalledWith({
			sessionId: "session",
			job: "J2",
			status: "completed",
			text: "Filed B-12, Export fails.",
			chatTags: [],
		});
		expect(mocks.chat).not.toHaveBeenCalled();
		expect(mocks.update).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					responseText: "Filed B-12, Export fails.",
				}),
			}),
		);
		expect(lastStatusWrite()?.data).toEqual(
			expect.objectContaining({ status: "COMPLETED" }),
		);
		expect(mocks.session).toHaveBeenCalledWith(
			expect.objectContaining({ data: { activeTurnId: null } }),
		);
	});

	it("releases the meeting's turn before the voice hears the answer", async () => {
		const order: string[] = [];
		mocks.session.mockImplementation(async () => {
			order.push("released");
			return { count: 1 };
		});
		mocks.result.mockImplementation(async () => {
			order.push("spoken");
			return true;
		});

		await executeParlumeMeetingTurn({ turnId: "turn", realtimeJob: "J2" });

		expect(order).toEqual(["released", "spoken"]);
	});

	it("posts a long answer to the chat in full and tells the voice where it is", async () => {
		const long = `Filed B-12. ${"Detail that matters. ".repeat(30)}`;
		mocks.execute.mockResolvedValue({ success: true, response: long });

		await executeParlumeMeetingTurn({ turnId: "turn", realtimeJob: "J2" });

		expect(mocks.chat).toHaveBeenCalledWith(
			expect.objectContaining({ final: true, voiceGeneration: 3 }),
		);
		expect(mocks.result).toHaveBeenCalledWith(
			expect.objectContaining({ job: "J2", chatTags: ["P5"] }),
		);
	});

	it("sends the answer to the chat when the realtime voice can no longer take it", async () => {
		mocks.result.mockResolvedValue(false);

		await executeParlumeMeetingTurn({ turnId: "turn", realtimeJob: "J2" });

		expect(mocks.chat).toHaveBeenCalledWith(
			expect.objectContaining({ message: "Filed B-12, Export fails." }),
		);
		expect(mocks.updateMany).not.toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ error: expect.any(String) }),
			}),
		);
	});

	it("records why an answer reached nobody", async () => {
		mocks.result.mockResolvedValue(false);
		mocks.chat.mockResolvedValue({
			sent: false,
			reason: "chat_unavailable",
		});

		await executeParlumeMeetingTurn({ turnId: "turn", realtimeJob: "J2" });

		expect(mocks.updateMany).toHaveBeenLastCalledWith(
			expect.objectContaining({
				data: {
					error: expect.stringContaining("chat is unavailable"),
				},
			}),
		);
	});

	it("tells the voice when the job fails", async () => {
		mocks.execute.mockResolvedValue({
			success: false,
			error: "No access.",
		});

		await executeParlumeMeetingTurn({ turnId: "turn", realtimeJob: "J2" });

		expect(mocks.result).toHaveBeenCalledWith({
			sessionId: "session",
			job: "J2",
			status: "failed",
			text: "",
			chatTags: [],
		});
		expect(lastStatusWrite()?.data).toEqual(
			expect.objectContaining({ status: "FAILED", error: "No access." }),
		);
	});

	it("leaves a classic spoken turn to the classic voice", async () => {
		mocks.speak.mockResolvedValue({ played: true, interrupted: false });
		mocks.voiceState.mockResolvedValue({
			current: true,
			muted: false,
			chatAvailable: true,
		});

		await executeParlumeMeetingTurn({ turnId: "turn" });

		expect(mocks.speak).toHaveBeenCalledTimes(1);
		expect(mocks.result).not.toHaveBeenCalled();
	});
});
