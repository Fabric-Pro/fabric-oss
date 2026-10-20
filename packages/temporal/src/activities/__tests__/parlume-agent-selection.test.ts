import { logger } from "@repo/logs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeParlumeMeetingTurn } from "../parlume";
import {
	observeAgentText,
	prepareAgentTools,
} from "../shared/agent-tool-runtime";
import {
	recordTurnSpeechSentence,
	recordTurnValue,
} from "../shared/turn-timing";

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
	stop: vi.fn(),
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
	speakParlumeResponse: mocks.speak,
	postParlumeMeetingChat: mocks.chat,
	requestParlumeMeetingStop: mocks.stop,
}));
vi.mock("../project-metadata", () => ({
	retrieveProjectContextsActivity: mocks.retrieve,
}));

async function spokenSentences(callIndex = 0): Promise<string[]> {
	const { sentences } = mocks.speak.mock.calls[callIndex]?.[0] as {
		sentences: AsyncIterable<string>;
	};
	const spoken: string[] = [];
	for await (const sentence of sentences) {
		spoken.push(sentence);
	}
	return spoken;
}

function turn(agentKind = "FABRIC_AGENT", toolsReadOnly = true) {
	return {
		id: "turn",
		status: "PENDING",
		voiceGeneration: 3,
		speakerId: "speaker",
		speakerName: "Alex",
		requestText: "What is the plan?",
		session: {
			id: "session",
			projectId: "project",
			organizationId: "org",
			userId: "user",
			agentKind,
			status: "ACTIVE",
			toolsReadOnly,
			voiceGeneration: 3,
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
	mocks.segments.mockResolvedValue([
		{ text: "Meeting context", speakerName: "Alex" },
	]);
	mocks.history.mockResolvedValue([]);
	mocks.speak.mockResolvedValue({
		played: true,
		interrupted: false,
		firstAudioAt: new Date().toISOString(),
	});
});

function timingLog() {
	const call = vi
		.mocked(logger.info)
		.mock.calls.find(([message]) => message === "[Parlume] turn.timing");
	return call?.[1] as Record<string, unknown> | undefined;
}

describe("Parlume meeting turns", () => {
	it("uses the selected current agent, project knowledge and transcript", async () => {
		await executeParlumeMeetingTurn({ turnId: "turn" });
		expect(mocks.load).toHaveBeenCalledWith(turn().session);
		expect(mocks.execute).toHaveBeenCalledWith(
			expect.objectContaining({
				agent: { kind: "FABRIC_AGENT", revision: "current-revision" },
				knowledgeContext:
					"Project knowledge\n\nRecent meeting transcript:\nAlex: Meeting context",
			}),
		);
		expect(mocks.speak).toHaveBeenCalledWith(
			expect.objectContaining({ voiceGeneration: 3 }),
		);
		await expect(spokenSentences()).resolves.toEqual(["The plan."]);
		expect(mocks.updateMany).toHaveBeenLastCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: "COMPLETED",
					spokenAt: expect.any(Date),
				}),
			}),
		);
	});
	it("carries the acting grant its web route minted into the agent run", async () => {
		await executeParlumeMeetingTurn({
			turnId: "turn",
			actingGrant: "grant-for-this-turn",
		});
		expect(mocks.execute).toHaveBeenCalledWith(
			expect.objectContaining({ actingGrant: "grant-for-this-turn" }),
		);
	});
	it("keeps the acting grant out of the turn's logs and database writes", async () => {
		await executeParlumeMeetingTurn({
			turnId: "turn",
			actingGrant: "grant-for-this-turn",
		});
		const everything = JSON.stringify([
			vi.mocked(logger.info).mock.calls,
			vi.mocked(logger.warn).mock.calls,
			vi.mocked(logger.error).mock.calls,
			mocks.update.mock.calls,
			mocks.updateMany.mock.calls,
			mocks.session.mock.calls,
			mocks.actions.mock.calls,
		]);
		expect(everything).not.toContain("grant-for-this-turn");
	});
	it.each(["FABRIC_AGENT", "TEMPLATE_INSTANCE"])(
		"stops %s before any context or execution when access is revoked",
		async (kind) => {
			mocks.turn.mockResolvedValue(turn(kind));
			mocks.hasAccess.mockResolvedValue(false);
			await executeParlumeMeetingTurn({ turnId: "turn" });
			expect(mocks.stop).toHaveBeenCalledWith({ sessionId: "session" });
			expect(mocks.session).toHaveBeenCalledWith(
				expect.objectContaining({
					data: expect.objectContaining({ status: "LEAVING" }),
				}),
			);
			expect(mocks.load).not.toHaveBeenCalled();
			expect(mocks.retrieve).not.toHaveBeenCalled();
			expect(mocks.execute).not.toHaveBeenCalled();
			expect(mocks.speak).not.toHaveBeenCalled();
		},
	);
	it("does not execute a duplicate or interrupted turn", async () => {
		mocks.updateMany.mockResolvedValue({ count: 0 });
		await executeParlumeMeetingTurn({ turnId: "turn" });
		expect(mocks.load).not.toHaveBeenCalled();
	});
	it("speaks a read-only answer while the agent is still writing it", async () => {
		let speechStartedBeforeAnswer = false;
		mocks.execute.mockImplementation(async () => {
			speechStartedBeforeAnswer = mocks.speak.mock.calls.length === 1;
			observeAgentText("The roadmap has two hundred items. ");
			observeAgentText("Forty are done.");
			return { success: true, response: "Ignored when streamed." };
		});
		await executeParlumeMeetingTurn({ turnId: "turn" });
		expect(speechStartedBeforeAnswer).toBe(true);
		expect(mocks.speak).toHaveBeenCalledTimes(1);
		await expect(spokenSentences()).resolves.toEqual([
			"The roadmap has two hundred items.",
			"Forty are done.",
		]);
	});
	it("speaks an actions-meeting answer while the agent is still writing it, with no wait to confirm", async () => {
		mocks.turn.mockResolvedValue(turn("FABRIC_AGENT", false));
		let speechStartedBeforeAnswer = false;
		mocks.execute.mockImplementation(async () => {
			speechStartedBeforeAnswer = mocks.speak.mock.calls.length === 1;
			observeAgentText("Created F-251, Parlume test.");
			return { success: true, response: "Created F-251, Parlume test." };
		});
		await executeParlumeMeetingTurn({ turnId: "turn" });
		expect(speechStartedBeforeAnswer).toBe(true);
		await expect(spokenSentences()).resolves.toEqual([
			"Created F-251, Parlume test.",
		]);
		expect(mocks.execute).toHaveBeenCalledWith(
			expect.not.objectContaining({ confirmation: expect.anything() }),
		);
	});
	async function runToolCall(preamble?: string) {
		mocks.turn.mockResolvedValue(turn("FABRIC_AGENT", false));
		mocks.execute.mockImplementation(async () => {
			if (preamble) {
				observeAgentText(preamble);
			}
			const tools: Record<string, unknown> = {
				fabric_create_story: { inputSchema: {}, execute: vi.fn() },
			};
			await prepareAgentTools(tools);
			await (
				tools.fabric_create_story as {
					execute: (args: unknown) => Promise<unknown>;
				}
			).execute({ title: "Parlume test" });
			observeAgentText("Created F-251, Parlume test.");
			return { success: true, response: "Created F-251, Parlume test." };
		});
		await executeParlumeMeetingTurn({ turnId: "turn" });
		return spokenSentences();
	}
	it("says what it is doing when a tool starts and the agent said nothing first", async () => {
		await expect(runToolCall()).resolves.toEqual([
			"Creating that now.",
			"Created F-251, Parlume test.",
		]);
	});
	it("does not add its own line when the agent already said a preamble", async () => {
		await expect(
			runToolCall("Creating the work item now."),
		).resolves.toEqual([
			"Creating the work item now.",
			"Created F-251, Parlume test.",
		]);
	});
	it("tells the agent to say a short sentence before it calls a tool", async () => {
		await executeParlumeMeetingTurn({ turnId: "turn" });
		const { voiceInstructions } = mocks.execute.mock.calls[0]?.[0] as {
			voiceInstructions: string;
		};
		expect(voiceInstructions).toContain("Before you call any tool");
		expect(voiceInstructions).toContain("at most eight words");
	});
	it("posts an answer that cannot be spoken to the meeting chat and records it as answered", async () => {
		mocks.speak.mockRejectedValue(
			new Error("Parlume speech generation failed (HTTP 401)."),
		);
		mocks.chat.mockResolvedValue(true);
		await executeParlumeMeetingTurn({ turnId: "turn" });
		expect(mocks.chat).toHaveBeenCalledWith({
			sessionId: "session",
			message: "The plan.",
		});
		expect(mocks.updateMany).toHaveBeenLastCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: "COMPLETED",
					spokenAt: null,
					error: expect.stringContaining(
						"posted to the meeting chat",
					),
				}),
			}),
		);
		expect(mocks.update).not.toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ status: "FAILED" }),
			}),
		);
	});
	it("fails the turn with its cause when neither voice nor chat can deliver it", async () => {
		mocks.speak.mockRejectedValue(
			new Error("Parlume speech generation failed (HTTP 401)."),
		);
		mocks.chat.mockResolvedValue(false);
		await executeParlumeMeetingTurn({ turnId: "turn" });
		expect(mocks.updateMany).not.toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ status: "COMPLETED" }),
			}),
		);
	});

	it("reads a voice-sized slice of the meeting: three project passages, three minutes, four earlier answers", async () => {
		await executeParlumeMeetingTurn({ turnId: "turn" });
		expect(mocks.retrieve).toHaveBeenCalledWith(
			"What is the plan?",
			"project",
			"user",
			"org",
			3,
		);
		const segmentQuery = mocks.segments.mock.calls[0]?.[0];
		const windowMs =
			Date.now() - segmentQuery.where.createdAt.gte.getTime();
		expect(windowMs).toBeGreaterThanOrEqual(3 * 60 * 1000);
		expect(windowMs).toBeLessThan(3 * 60 * 1000 + 5_000);
		expect(segmentQuery.orderBy).toEqual({ createdAt: "desc" });
		expect(mocks.history).toHaveBeenCalledWith(
			expect.objectContaining({ take: 4 }),
		);
	});
	it("keeps the most recent 4,000 characters of the transcript", async () => {
		mocks.segments.mockResolvedValue([
			{ text: `newest ${"n".repeat(3_000)}`, speakerName: "Alex" },
			{ text: `older ${"o".repeat(3_000)}`, speakerName: "Sam" },
		]);
		await executeParlumeMeetingTurn({ turnId: "turn" });
		const { knowledgeContext } = mocks.execute.mock.calls[0]?.[0] as {
			knowledgeContext: string;
		};
		const transcript = knowledgeContext.split(
			"Recent meeting transcript:\n",
		)[1];
		expect(transcript).toHaveLength(4_000);
		expect(transcript.endsWith("n".repeat(3_000))).toBe(true);
		expect(transcript).toContain("Alex: newest");
		expect(transcript).not.toContain("Sam: older");
	});
	it("logs one turn.timing record with every step of the turn", async () => {
		mocks.execute.mockImplementation(async () => {
			recordTurnValue("llm.firstTextMs", 321);
			recordTurnValue("llm.reasoningTokens", 0);
			return { success: true, response: "The plan." };
		});
		mocks.speak.mockImplementation(async () => {
			recordTurnSpeechSentence({
				chars: 9,
				route: "gateway",
				startedAtMs: 40,
				firstByteMs: 900,
				totalMs: 900,
			});
			return {
				played: true,
				interrupted: false,
				firstAudioAt: Date.now(),
			};
		});
		await executeParlumeMeetingTurn({ turnId: "turn" });

		const timingLogs = vi
			.mocked(logger.info)
			.mock.calls.filter(
				([message]) => message === "[Parlume] turn.timing",
			);
		expect(timingLogs).toHaveLength(1);
		const log = timingLog();
		expect(log).toMatchObject({
			component: "parlume",
			event: "parlume.turn.timing",
			sessionId: "session",
			turnId: "turn",
			outcome: "completed",
			speech: [
				{
					chars: 9,
					route: "gateway",
					startedAtMs: 40,
					firstByteMs: 900,
					totalMs: 900,
				},
			],
		});
		expect(Object.keys(log?.timings as object).sort()).toEqual(
			[
				"agentLoadMs",
				"agentRevisionWriteMs",
				"agentRunMs",
				"contextGatherMs",
				"historyQueryMs",
				"llm.firstTextMs",
				"llm.reasoningTokens",
				"projectRagMs",
				"segmentsQueryMs",
			].sort(),
		);
		expect(log?.firstAudioMs).toEqual(expect.any(Number));
		expect(log?.totalMs).toEqual(expect.any(Number));
	});
	it("logs the timing of a turn that failed, with its outcome", async () => {
		mocks.execute.mockResolvedValue({ success: false, error: "No model." });
		await executeParlumeMeetingTurn({ turnId: "turn" });
		expect(timingLog()).toMatchObject({ outcome: "agent_failed" });

		vi.mocked(logger.info).mockClear();
		mocks.turn.mockResolvedValue(turn());
		mocks.load.mockRejectedValue(new Error("Database unavailable"));
		await executeParlumeMeetingTurn({ turnId: "turn" });
		expect(timingLog()).toMatchObject({ outcome: "failed" });
	});
	it.each([true, false])(
		"tells the agent to post to the meeting chat and never read an address aloud (read-only: %s)",
		async (toolsReadOnly) => {
			mocks.turn.mockResolvedValue(turn("FABRIC_AGENT", toolsReadOnly));
			await executeParlumeMeetingTurn({ turnId: "turn" });
			const { voiceInstructions } = mocks.execute.mock.calls[0]?.[0] as {
				voiceInstructions: string;
			};
			expect(voiceInstructions).toContain("post_to_meeting_chat");
			expect(voiceInstructions).toContain("F-123");
			expect(voiceInstructions).toContain("Never read URLs aloud.");
		},
	);
	it("tells an actions meeting's agent that a change takes effect at once, with nothing to confirm", async () => {
		mocks.turn.mockResolvedValue(turn("FABRIC_AGENT", false));
		await executeParlumeMeetingTurn({ turnId: "turn" });
		const { voiceInstructions } = mocks.execute.mock.calls[0]?.[0] as {
			voiceInstructions: string;
		};
		expect(voiceInstructions).toContain("takes effect as soon as you call");
		expect(voiceInstructions).not.toMatch(/confirm|awaiting/i);
	});
	it("tells a read-only meeting's agent it cannot make changes", async () => {
		await executeParlumeMeetingTurn({ turnId: "turn" });
		const { voiceInstructions } = mocks.execute.mock.calls[0]?.[0] as {
			voiceInstructions: string;
		};
		expect(voiceInstructions).toContain("cannot make changes");
	});
});
