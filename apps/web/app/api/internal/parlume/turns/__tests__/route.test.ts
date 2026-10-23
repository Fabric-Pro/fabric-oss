import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	sessionFindFirst: vi.fn(),
	sessionUpdateMany: vi.fn(),
	turnCreateMany: vi.fn(),
	turnFindUnique: vi.fn(),
	turnUpdateMany: vi.fn(),
	turnUpdate: vi.fn(),
	workflowStart: vi.fn(),
	mintGrant: vi.fn(),
}));

vi.mock("@repo/api/lib/agent-service-auth", () => ({
	mintParlumeActingGrantForTurn: mocks.mintGrant,
}));

vi.mock("@repo/database", () => ({
	db: {
		parlumeMeetingSession: {
			findFirst: mocks.sessionFindFirst,
			updateMany: mocks.sessionUpdateMany,
		},
		parlumeMeetingTurn: {
			createMany: mocks.turnCreateMany,
			findUnique: mocks.turnFindUnique,
			updateMany: mocks.turnUpdateMany,
			update: mocks.turnUpdate,
		},
	},
}));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: async () => ({
		workflow: { start: mocks.workflowStart },
	}),
}));

vi.mock("@repo/api/modules/projects/lib/parlume-attendee", () => ({
	deleteParlumeMeetingBotData: vi.fn(),
	getParlumeBridgeSettings: vi.fn(),
}));

import { POST } from "../route";

function request(overrides: Record<string, unknown> = {}): NextRequest {
	return new NextRequest(
		"https://fabric.example/api/internal/parlume/turns",
		{
			method: "POST",
			headers: {
				"content-type": "application/json",
				"X-Agent-Service-Token": "service-secret",
			},
			body: JSON.stringify({
				sessionId: "session-1",
				botId: "bot-1",
				text: "What was decided?",
				speakerName: "Alice",
				speakerId: "1",
				utteranceStartMs: 1_000,
				utteranceEndMs: 2_000,
				...overrides,
			}),
		},
	);
}

beforeEach(() => {
	vi.resetAllMocks();
	process.env.AGENT_SERVICE_SECRET = "service-secret";
	mocks.sessionFindFirst.mockResolvedValue({
		id: "session-1",
		projectId: "project-1",
		organizationId: "org-1",
		userId: "user-1",
		activeTurnId: null,
		toolsReadOnly: false,
	});
	mocks.sessionUpdateMany.mockResolvedValue({ count: 1 });
	mocks.workflowStart.mockResolvedValue(undefined);
	mocks.mintGrant.mockReturnValue("grant-for-this-turn");
});

describe("Parlume acting grant", () => {
	function acceptNewTurn() {
		mocks.turnCreateMany.mockResolvedValue({ count: 1 });
		mocks.turnFindUnique.mockResolvedValue({
			id: "turn-1",
			status: "PENDING",
			error: null,
		});
	}

	it("mints a grant for the inviter and hands it to the turn workflow", async () => {
		acceptNewTurn();

		const response = await POST(request());

		expect(response.status).toBe(200);
		expect(mocks.mintGrant).toHaveBeenCalledWith({
			userId: "user-1",
			organizationId: "org-1",
			projectId: "project-1",
			readOnly: false,
		});
		expect(mocks.workflowStart).toHaveBeenCalledWith(
			"parlumeMeetingTurnWorkflow",
			expect.objectContaining({
				args: [
					expect.objectContaining({
						turnId: "turn-1",
						actingGrant: "grant-for-this-turn",
					}),
				],
			}),
		);
	});

	it("mints a read-only meeting's grant as read-only", async () => {
		acceptNewTurn();
		mocks.sessionFindFirst.mockResolvedValue({
			id: "session-1",
			projectId: "project-1",
			organizationId: "org-1",
			userId: "user-1",
			activeTurnId: null,
			toolsReadOnly: true,
		});

		await POST(request());

		expect(mocks.mintGrant).toHaveBeenCalledWith(
			expect.objectContaining({ readOnly: true }),
		);
	});

	it("mints a fresh grant for every turn instead of keeping one on the session", async () => {
		acceptNewTurn();
		mocks.mintGrant
			.mockReturnValueOnce("first-grant")
			.mockReturnValueOnce("second-grant");

		await POST(request());
		await POST(request());

		const grants = mocks.workflowStart.mock.calls.map(
			([, options]) => options.args[0].actingGrant,
		);
		expect(grants).toEqual(["first-grant", "second-grant"]);
	});

	it("never writes the grant to the turn or the session", async () => {
		acceptNewTurn();

		await POST(request());

		const written = JSON.stringify([
			mocks.turnCreateMany.mock.calls,
			mocks.turnUpdateMany.mock.calls,
			mocks.turnUpdate.mock.calls,
			mocks.sessionUpdateMany.mock.calls,
		]);
		expect(written).not.toContain("grant-for-this-turn");
	});
});

describe("Parlume interrupted turn dispatch", () => {
	it("asks the bridge to retry while a first spoken turn is active", async () => {
		mocks.sessionFindFirst.mockResolvedValueOnce({
			id: "session-1",
			activeTurnId: "first-turn",
		});

		const response = await POST(request());

		expect(response.status).toBe(409);
		expect(mocks.turnCreateMany).not.toHaveBeenCalled();
	});

	it("retries a deduplicated turn that lost the session claim", async () => {
		mocks.turnCreateMany.mockResolvedValue({ count: 0 });
		mocks.turnFindUnique.mockResolvedValue({
			id: "turn-2",
			status: "FAILED",
			error: "Another Parlume turn is already running.",
		});
		mocks.turnUpdateMany.mockResolvedValue({ count: 1 });

		const response = await POST(request());

		expect(response.status).toBe(200);
		expect(mocks.turnUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: {
					status: "PENDING",
					error: null,
					completedAt: null,
				},
			}),
		);
		expect(mocks.workflowStart).toHaveBeenCalledWith(
			"parlumeMeetingTurnWorkflow",
			expect.objectContaining({
				workflowId: "parlume-turn-turn-2",
			}),
		);
	});
});

describe("Parlume chat requests", () => {
	beforeEach(() => {
		mocks.turnCreateMany.mockResolvedValue({ count: 1 });
		mocks.turnFindUnique.mockResolvedValue({
			id: "turn-1",
			status: "PENDING",
			error: null,
		});
	});

	function createdTurn() {
		return mocks.turnCreateMany.mock.calls[0]?.[0].data;
	}

	it("answers a spoken request by voice", async () => {
		await POST(request());

		expect(createdTurn()).toMatchObject({ replyChannel: "VOICE" });
	});

	it("records where a typed request is answered", async () => {
		await POST(
			request({
				utteranceStartMs: null,
				utteranceEndMs: null,
				replyChannel: "CHAT",
				chatMessageId: "msg_1",
			}),
		);

		expect(createdTurn()).toMatchObject({
			replyChannel: "CHAT",
			requestText: "What was decided?",
		});
	});

	it("keeps two identical chat messages as two requests, and one message as one", async () => {
		const chat = {
			utteranceStartMs: null,
			utteranceEndMs: null,
			replyChannel: "CHAT",
		};
		await POST(request({ ...chat, chatMessageId: "msg_1" }));
		await POST(request({ ...chat, chatMessageId: "msg_2" }));
		await POST(request({ ...chat, chatMessageId: "msg_1" }));

		const keys = mocks.turnCreateMany.mock.calls.map(
			([args]) => args.data.dedupeKey,
		);
		expect(keys[0]).not.toBe(keys[1]);
		expect(keys[2]).toBe(keys[0]);
	});

	it("refuses an unknown reply channel", async () => {
		const response = await POST(request({ replyChannel: "EMAIL" }));

		expect(response.status).toBe(400);
		expect(mocks.turnCreateMany).not.toHaveBeenCalled();
	});
});

describe("Parlume realtime voice jobs", () => {
	beforeEach(() => {
		mocks.turnCreateMany.mockResolvedValue({ count: 1 });
		mocks.turnFindUnique.mockResolvedValue({
			id: "turn-1",
			status: "PENDING",
			error: null,
		});
	});

	const job = {
		speakerId: null,
		utteranceStartMs: null,
		utteranceEndMs: null,
		delivery: "realtime",
		job: "J3",
	};

	it("records the job as a meeting turn and tells the worker which job it answers", async () => {
		const response = await POST(request(job));

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ accepted: true });
		expect(mocks.turnCreateMany.mock.calls[0]?.[0].data).toMatchObject({
			replyChannel: "VOICE",
			requestText: "What was decided?",
		});
		expect(mocks.workflowStart).toHaveBeenCalledWith(
			"parlumeMeetingTurnWorkflow",
			expect.objectContaining({
				args: [
					expect.objectContaining({
						turnId: "turn-1",
						realtimeJob: "J3",
					}),
				],
			}),
		);
	});

	it("keeps a later job with the same number apart unless it is the same request", async () => {
		await POST(request(job));
		await POST(request({ ...job, text: "Something else?" }));
		await POST(request(job));

		const keys = mocks.turnCreateMany.mock.calls.map(
			([args]) => args.data.dedupeKey,
		);
		expect(keys[0]).not.toBe(keys[1]);
		expect(keys[2]).toBe(keys[0]);
	});

	it("starts a spoken turn without a job", async () => {
		await POST(request());

		expect(
			mocks.workflowStart.mock.calls[0]?.[1].args[0],
		).not.toHaveProperty("realtimeJob");
	});

	it.each([
		{ delivery: "realtime" },
		{ job: "J3" },
		{ delivery: "realtime", job: "3" },
	])("refuses a realtime delivery without its job: %j", async (body) => {
		const response = await POST(request(body));

		expect(response.status).toBe(400);
		expect(mocks.turnCreateMany).not.toHaveBeenCalled();
	});
});
