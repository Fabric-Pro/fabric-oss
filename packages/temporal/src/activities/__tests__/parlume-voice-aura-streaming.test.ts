import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeParlumeMeetingTurn } from "../parlume";
import { ParlumeSentenceQueue } from "../parlume-spoken-text";
import { speakParlumeResponse } from "../parlume-voice";
import {
	observeAgentText,
	prepareAgentTools,
} from "../shared/agent-tool-runtime";

const mocks = vi.hoisted(() => ({
	turn: vi.fn(),
	updateMany: vi.fn(),
	execute: vi.fn(),
}));
vi.mock("@repo/ai", () => ({
	AUDIO_PROVIDER_REQUIRED: { parlumeVoice: "voice required" },
	getAISpeechModel: vi.fn(),
	resolveOpenAiApiKey: vi.fn(),
}));
vi.mock("ai", () => ({ generateSpeech: vi.fn() }));
vi.mock("@repo/database", () => ({
	db: {
		parlumeMeetingTurn: {
			findUnique: mocks.turn,
			findMany: async () => [],
			update: async () => ({}),
			updateMany: mocks.updateMany,
		},
		parlumeMeetingSession: { updateMany: async () => ({ count: 1 }) },
		parlumeMeetingSegment: { findMany: async () => [] },
		parlumeAction: { updateMany: async () => ({ count: 0 }) },
		$transaction: (operations: Promise<unknown>[]) =>
			Promise.all(operations),
	},
	hasProjectAccess: async () => true,
	logAiUsageAsync: vi.fn(),
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
	loadParlumeAgent: async () => ({
		kind: "FABRIC_AGENT",
		revision: "revision",
	}),
	gatherParlumeAgentContext: () => undefined,
	executeParlumeAgent: mocks.execute,
}));
vi.mock("../parlume-actions", () => ({
	createParlumeToolRuntime: () => ({ invoke: vi.fn() }),
}));
vi.mock("../project-metadata", () => ({
	retrieveProjectContextsActivity: async () => null,
}));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Every sentence the bridge has been handed, in arrival order.
let heard: string[] = [];
let sentenceHeard: () => void = () => {};

function nextSentence(): Promise<void> {
	return new Promise((resolve) => {
		sentenceHeard = resolve;
	});
}

/**
 * The bridge behind an edge that forwards a request only once its body has
 * ended, as the edge in front of the real bridge does. The first part of a
 * reply is answered once the part marked last has come.
 */
function stubBufferingEdge() {
	let answerReply: (() => void) | null = null;
	let replyEnded = false;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: RequestInit) => {
			const body = await new Response(init?.body ?? null).text();
			const action = new URL(url).searchParams.get("action");
			if (action === "verify-generation") {
				return Response.json({
					current: true,
					muted: false,
					chatAvailable: true,
				});
			}
			if (action !== "say") {
				return Response.json({ sent: true, tag: "P1" });
			}
			for (const line of body.split("\n").filter(Boolean)) {
				heard.push((JSON.parse(line) as { text: string }).text);
				sentenceHeard();
			}
			const headers = new Headers(init?.headers);
			const part = headers.get("x-parlume-reply-part");
			// A body that is the whole reply has ended with it.
			replyEnded ||=
				part === null || headers.get("x-parlume-reply-last") === "1";
			const answer =
				part === null || part === "0"
					? new Promise<Response>((resolve) => {
							answerReply = () =>
								resolve(
									Response.json({
										played: true,
										interrupted: false,
										firstAudioAt: Date.now(),
										sentences: [],
									}),
								);
						})
					: Response.json({ accepted: true });
			if (replyEnded) {
				answerReply?.();
			}
			return answer;
		}),
	);
}

const speaker = {
	sessionId: "session-1",
	userId: "user-1",
	organizationId: "org-1",
	projectId: "project-1",
};

beforeEach(() => {
	vi.clearAllMocks();
	heard = [];
	process.env.NEXT_PUBLIC_PARTYKIT_HOST = "bridge.example.com";
	process.env.AGENT_SERVICE_SECRET = "service-secret";
	stubBufferingEdge();
});

describe("Parlume speech through an edge that holds request bodies", () => {
	it("hands the bridge each sentence as soon as it exists, while the agent is still writing", async () => {
		const queue = new ParlumeSentenceQueue(800);
		const first = nextSentence();

		const playback = speakParlumeResponse({
			...speaker,
			sentences: queue,
			voiceGeneration: 1,
		});
		queue.narrate("Let me check the roadmap's open features.");

		await expect(
			Promise.race([first.then(() => "heard"), sleep(1_000)]),
		).resolves.toBe("heard");
		expect(heard).toEqual(["Let me check the roadmap's open features."]);

		const second = nextSentence();
		queue.push("There is one open feature on the project roadmap. ");
		await expect(
			Promise.race([second.then(() => "heard"), sleep(1_000)]),
		).resolves.toBe("heard");
		queue.end();

		await expect(playback).resolves.toMatchObject({ played: true });
		expect(heard).toEqual([
			"Let me check the roadmap's open features.",
			"There is one open feature on the project roadmap.",
		]);
	});

	it("starts speaking a meeting turn's narration while its tool is still running", async () => {
		mocks.turn.mockResolvedValue({
			id: "turn",
			status: "PENDING",
			createdAt: new Date(),
			voiceGeneration: 3,
			speakerId: "speaker",
			speakerName: "Alex",
			requestText: "What is open on the roadmap?",
			replyChannel: "VOICE",
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
		});
		mocks.updateMany.mockResolvedValue({ count: 1 });
		let heardDuringRun: string[] = [];
		mocks.execute.mockImplementation(async () => {
			const narration = nextSentence();
			observeAgentText("Let me check the roadmap's open features.");
			const tools: Record<string, unknown> = {
				fabric_list_stories: { inputSchema: {}, execute: vi.fn() },
			};
			await prepareAgentTools(tools);
			await (
				tools.fabric_list_stories as {
					execute: (args: unknown) => Promise<unknown>;
				}
			).execute({});
			// The run is not over: the narration must already be with the bridge.
			await Promise.race([narration, sleep(1_000)]);
			heardDuringRun = [...heard];
			observeAgentText(
				"There's one open feature on the project roadmap.",
			);
			return {
				success: true,
				response:
					"Let me check the roadmap's open features. There's one open feature on the project roadmap.",
			};
		});

		await executeParlumeMeetingTurn({ turnId: "turn" });

		expect(heardDuringRun).toEqual([
			"Let me check the roadmap's open features.",
		]);
		expect(heard).toEqual([
			"Let me check the roadmap's open features.",
			"There's one open feature on the project roadmap.",
		]);
	});
});
