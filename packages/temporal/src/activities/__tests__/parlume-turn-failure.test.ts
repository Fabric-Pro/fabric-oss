/**
 * A request Parlume could not answer is said in the meeting chat: one error
 * post, with who asked and what, a plain reason and the Parlume page link,
 * never the internal error. A request someone stopped stays quiet.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeParlumeMeetingTurn, failParlumeMeetingTurn } from "../parlume";

const PAGE_URL =
	"https://fabric.example.com/app/example-org/example-project/parlume";
const INTERNAL_ERROR =
	"PrismaClientKnownRequestError: connection reset at db.example.internal:5432";

const mocks = vi.hoisted(() => ({
	activity: vi.fn(),
	turn: vi.fn(),
	segments: vi.fn(),
	history: vi.fn(),
	update: vi.fn(),
	updateMany: vi.fn(),
	session: vi.fn(),
	hasAccess: vi.fn(),
	pageUrl: vi.fn(),
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
	buildParlumePageUrl: mocks.pageUrl,
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
vi.mock("../parlume-actions", () => ({
	createParlumeToolRuntime: () => ({ invoke: vi.fn() }),
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
		projectId: "project",
		organizationId: "org",
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

beforeEach(() => {
	vi.resetAllMocks();
	controller = new AbortController();
	mocks.activity.mockReturnValue({
		cancellationSignal: controller.signal,
		heartbeat: vi.fn(),
	});
	mocks.turn.mockResolvedValue(typedTurn());
	mocks.hasAccess.mockResolvedValue(true);
	mocks.updateMany.mockResolvedValue({ count: 1 });
	mocks.pageUrl.mockResolvedValue(PAGE_URL);
	mocks.load.mockResolvedValue({
		kind: "FABRIC_AGENT",
		revision: "current-revision",
	});
	mocks.retrieve.mockResolvedValue({ context: "Project knowledge" });
	mocks.segments.mockResolvedValue([]);
	mocks.history.mockResolvedValue([]);
	mocks.chat.mockResolvedValue({ sent: true, tag: "P4" });
});

describe("a Parlume request that fails", () => {
	it("posts one error line with who asked, a plain reason and the Parlume page, never the internal error", async () => {
		mocks.execute.mockResolvedValue({
			success: false,
			error: INTERNAL_ERROR,
		});

		await executeParlumeMeetingTurn({ turnId: "turn" });

		expect(mocks.chat).toHaveBeenCalledTimes(1);
		const [post] = mocks.chat.mock.calls[0] ?? [];
		expect(post).toEqual({
			sessionId: "session",
			turnId: "turn",
			voiceGeneration: 3,
			final: true,
			message: `I could not finish the answer. Ask again in a minute.\n[Parlume page](${PAGE_URL})`,
			header: {
				kind: "error",
				asker: "Alex",
				request: "What changed since Monday?",
			},
		});
		expect(JSON.stringify(post)).not.toContain("Prisma");
		expect(JSON.stringify(post)).not.toContain("db.example.internal");
		// The internal error stays on the request, for the Parlume page.
		expect(mocks.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: "FAILED",
					error: INTERNAL_ERROR,
				}),
			}),
		);
		expect(mocks.pageUrl).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "project",
				organizationId: "org",
			}),
		);
	});

	it("posts the error line when the agent throws", async () => {
		mocks.execute.mockRejectedValue(new Error(INTERNAL_ERROR));

		await executeParlumeMeetingTurn({ turnId: "turn" });

		expect(mocks.chat).toHaveBeenCalledTimes(1);
		expect(mocks.chat.mock.calls[0]?.[0].header.kind).toBe("error");
		expect(mocks.chat.mock.calls[0]?.[0].message).not.toContain(
			"connection reset",
		);
	});

	it("says a request that ran out of time took too long", async () => {
		await failParlumeMeetingTurn({
			turnId: "turn",
			error: "Parlume meeting turn timed out or the worker stopped.",
			chatReason: "timed_out",
		});

		expect(mocks.chat).toHaveBeenCalledTimes(1);
		expect(mocks.chat.mock.calls[0]?.[0].message).toMatch(
			/^The answer took too long\. Ask again in a minute\./,
		);
	});

	// The failure record changed nothing: the turn was stopped, or ended
	// otherwise, first.
	it("posts nothing for a request that no longer runs", async () => {
		mocks.updateMany.mockResolvedValue({ count: 0 });

		await failParlumeMeetingTurn({
			turnId: "turn",
			error: "Parlume meeting turn timed out or the worker stopped.",
			chatReason: "timed_out",
		});

		expect(mocks.chat).not.toHaveBeenCalled();
	});

	it("posts nothing for a request someone stopped while its answer was being prepared", async () => {
		mocks.execute.mockImplementation(async () => {
			controller.abort(new Error("cancelled"));
			throw new Error("aborted");
		});

		await executeParlumeMeetingTurn({ turnId: "turn" });

		expect(mocks.chat).not.toHaveBeenCalled();
	});

	it("keeps the failure recorded when the error line cannot be posted", async () => {
		mocks.execute.mockResolvedValue({ success: false, error: "No model." });
		mocks.pageUrl.mockRejectedValue(new Error("Project not found"));

		await expect(
			executeParlumeMeetingTurn({ turnId: "turn" }),
		).resolves.toBeUndefined();

		expect(mocks.chat).not.toHaveBeenCalled();
		expect(mocks.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ status: "FAILED" }),
			}),
		);
	});
});
