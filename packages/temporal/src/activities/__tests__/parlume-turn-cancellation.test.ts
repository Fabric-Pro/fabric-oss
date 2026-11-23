/**
 * A stop or a pause ends the meeting turn: Fabric records it STOPPED and
 * cancels its workflow, and Temporal hands the running activity that
 * cancellation with its next heartbeat. The turn heartbeats from its first
 * step, ends once cancelled, posts nothing more, and never overwrites the
 * STOPPED status.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeParlumeMeetingTurn } from "../parlume";
import { agentToolAbortSignal } from "../shared/agent-tool-runtime";

const mocks = vi.hoisted(() => ({
	activity: vi.fn(),
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
	voiceState: vi.fn(),
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
		$transaction: (operations: Promise<unknown>[]) =>
			Promise.all(operations),
	},
	hasProjectAccess: mocks.hasAccess,
}));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@temporalio/activity", () => ({
	Context: { current: () => mocks.activity() },
}));
vi.mock("../parlume-agent", () => ({
	loadParlumeAgent: mocks.load,
	gatherParlumeAgentContext: () => undefined,
	executeParlumeAgent: mocks.execute,
}));
// As the real runtime does, the agent run aborts with the activity.
vi.mock("../parlume-actions", () => ({
	createParlumeToolRuntime: (context: { signal: AbortSignal }) => ({
		invoke: vi.fn(),
		abortSignal: context.signal,
	}),
}));
vi.mock("../parlume-voice", () => ({
	PARLUME_MAX_SPOKEN_CHARS: 675,
	PARLUME_HEADLINE_SPOKEN_CHARS: 350,
	readParlumeVoiceState: mocks.voiceState,
	speakParlumeResponse: mocks.speak,
	postParlumeMeetingChat: mocks.chat,
	postParlumeRealtimeResult: vi.fn(),
	requestParlumeMeetingStop: vi.fn(),
}));
vi.mock("../project-metadata", () => ({
	retrieveProjectContextsActivity: mocks.retrieve,
}));
vi.mock("../parlume-turn-audit", () => ({
	recordParlumeTurnAnswered: vi.fn(),
}));

function typedTurn() {
	return {
		id: "turn",
		sessionId: "session",
		status: "PENDING",
		voiceGeneration: 3,
		speakerId: "speaker",
		speakerName: "Alex",
		requesterUserId: "user",
		requestText: "What changed since Monday?",
		replyChannel: "CHAT",
		createdAt: new Date(),
		session: {
			id: "session",
			projectId: "project",
			organizationId: "org",
			userId: "user",
			agentKind: "FABRIC_AGENT",
			status: "ACTIVE",
			toolsReadOnly: true,
			voiceGeneration: 3,
		},
	};
}

let controller: AbortController;
const heartbeat = vi.fn();

beforeEach(() => {
	vi.resetAllMocks();
	vi.useFakeTimers();
	controller = new AbortController();
	mocks.activity.mockReturnValue({
		cancellationSignal: controller.signal,
		heartbeat,
	});
	mocks.turn.mockResolvedValue(typedTurn());
	mocks.hasAccess.mockResolvedValue(true);
	mocks.updateMany.mockResolvedValue({ count: 1 });
	mocks.load.mockResolvedValue({
		kind: "FABRIC_AGENT",
		revision: "current-revision",
	});
	mocks.retrieve.mockResolvedValue({ context: "Project knowledge" });
	mocks.segments.mockResolvedValue([]);
	mocks.history.mockResolvedValue([]);
	mocks.chat.mockResolvedValue({ sent: true, tag: "P1" });
	// The agent runs until its run is aborted, as the model call does.
	mocks.execute.mockImplementation(
		() =>
			new Promise((_resolve, reject) => {
				const signal = agentToolAbortSignal();
				signal?.addEventListener("abort", () => reject(signal.reason));
			}),
	);
});

afterEach(() => {
	vi.useRealTimers();
});

describe("a Parlume meeting turn someone stopped", () => {
	it("heartbeats while the agent runs, so Temporal can hand it the cancellation", async () => {
		const running = executeParlumeMeetingTurn({ turnId: "turn" });

		await vi.advanceTimersByTimeAsync(3_000);

		expect(heartbeat).toHaveBeenCalledTimes(3);
		controller.abort(new Error("cancelled"));
		await vi.advanceTimersByTimeAsync(0);
		await running;
	});

	it("ends once cancelled, posts nothing to the chat, and leaves the STOPPED status alone", async () => {
		const running = executeParlumeMeetingTurn({ turnId: "turn" });
		await vi.advanceTimersByTimeAsync(1_000);

		controller.abort(new Error("cancelled"));
		await vi.advanceTimersByTimeAsync(1_000);

		await expect(running).resolves.toBeUndefined();
		expect(mocks.chat).not.toHaveBeenCalled();
		// The claim, then the failure record: each changes only a turn still
		// PENDING or RUNNING, never one already STOPPED.
		expect(
			mocks.updateMany.mock.calls.map(([{ where }]) => where.status),
		).toEqual(["PENDING", { in: ["PENDING", "RUNNING"] }]);
		const beats = heartbeat.mock.calls.length;
		await vi.advanceTimersByTimeAsync(5_000);
		expect(heartbeat).toHaveBeenCalledTimes(beats);
	});

	it("does nothing for a turn already STOPPED when its activity starts", async () => {
		mocks.turn.mockResolvedValue({ ...typedTurn(), status: "STOPPED" });

		await executeParlumeMeetingTurn({ turnId: "turn" });

		expect(mocks.updateMany).not.toHaveBeenCalled();
		expect(mocks.execute).not.toHaveBeenCalled();
		expect(mocks.chat).not.toHaveBeenCalled();
	});
});
