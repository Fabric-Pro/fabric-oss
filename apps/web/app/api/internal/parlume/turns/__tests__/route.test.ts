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
	attendeeWithoutRead: vi.fn(),
	departureNotice: vi.fn(),
	leave: vi.fn(),
	audience: vi.fn(),
	setRange: vi.fn(),
	postNotice: vi.fn(),
}));

vi.mock("@repo/api/modules/projects/lib/parlume-confidential", () => ({
	confidentialRangeSelect: { id: true, confidentialSince: true },
	parlumeTurnAudience: mocks.audience,
	setParlumeConfidentialRange: mocks.setRange,
	postParlumeConfidentialNotice: mocks.postNotice,
}));

vi.mock("@repo/api/modules/projects/lib/parlume-attendee-standing", () => ({
	findParlumeAttendeeWithoutRead: mocks.attendeeWithoutRead,
	parlumeDepartureNotice: mocks.departureNotice,
}));

vi.mock("@repo/api/modules/projects/lib/parlume-leave", () => ({
	requestParlumeLeave: mocks.leave,
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

vi.mock("@repo/temporal/client", () => ({
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
				attendees: ["user-1"],
				requester: "user-1",
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
		streamGeneration: 3,
		toolsReadOnly: false,
		attendeeUserIds: ["user-1"],
		confidentialSince: null,
		externalInvitees: false,
		guestJoinedAt: null,
	});
	mocks.attendeeWithoutRead.mockResolvedValue(null);
	mocks.sessionUpdateMany.mockResolvedValue({ count: 1 });
	mocks.workflowStart.mockResolvedValue(undefined);
	mocks.mintGrant.mockReturnValue("grant-for-this-turn");
	mocks.audience.mockReturnValue({
		requesterUserId: "user-1",
		withConfidential: true,
	});
	mocks.setRange.mockResolvedValue({ changed: true, open: true });
	mocks.postNotice.mockResolvedValue(true);
});

describe("Parlume acting grant", () => {
	it("deduplicates a stable Graph message after more than 200 intervening chat requests", async () => {
		const keys = new Set<string>();
		mocks.turnCreateMany.mockImplementation(
			async ({ data }: { data: { dedupeKey: string } }) => {
				const count = keys.has(data.dedupeKey) ? 0 : 1;
				keys.add(data.dedupeKey);
				return { count };
			},
		);
		mocks.turnFindUnique.mockResolvedValue({
			id: "example-turn",
			status: "COMPLETED",
			error: null,
		});
		const original = {
			chatMessageId: "graph:1700000000000",
			replyChannel: "CHAT",
		};
		await POST(request(original));
		for (let index = 1; index <= 201; index++) {
			await POST(
				request({
					chatMessageId: `graph:${1700000000000 + index}`,
					replyChannel: "CHAT",
				}),
			);
		}
		const duplicate = await POST(request(original));
		expect(await duplicate.json()).toEqual({ accepted: false });
		expect(mocks.workflowStart).toHaveBeenCalledTimes(202);
		expect(keys.size).toBe(202);
	});
	function acceptNewTurn() {
		mocks.turnCreateMany.mockResolvedValue({ count: 1 });
		mocks.turnFindUnique.mockResolvedValue({
			id: "turn-1",
			status: "PENDING",
			error: null,
		});
	}

	it("mints a grant for the participant who asked and hands it to the turn workflow", async () => {
		acceptNewTurn();

		const response = await POST(request());

		expect(response.status).toBe(200);
		expect(mocks.mintGrant).toHaveBeenCalledWith({
			userId: "user-1",
			organizationId: "org-1",
			projectId: "project-1",
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

	it("reads a turn with the asker's access, not the inviter's, and records who asked", async () => {
		acceptNewTurn();
		mocks.sessionFindFirst.mockResolvedValue({
			id: "session-1",
			projectId: "project-1",
			organizationId: "org-1",
			userId: "user-1",
			activeTurnId: null,
			streamGeneration: 3,
			attendeeUserIds: ["user-1", "user-2"],
			confidentialSince: null,
			externalInvitees: false,
			guestJoinedAt: null,
		});
		mocks.audience.mockReturnValue({
			requesterUserId: "user-2",
			withConfidential: true,
		});

		await POST(
			request({ attendees: ["user-1", "user-2"], requester: "user-2" }),
		);

		expect(mocks.audience).toHaveBeenCalledWith({
			requester: "user-2",
			attendees: ["user-1", "user-2"],
			attendeeUserIds: ["user-1", "user-2"],
			guests: false,
		});
		expect(mocks.mintGrant).toHaveBeenCalledWith({
			userId: "user-2",
			organizationId: "org-1",
			projectId: "project-1",
		});
		expect(mocks.mintGrant).not.toHaveBeenCalledWith(
			expect.objectContaining({ userId: "user-1" }),
		);
		expect(mocks.turnCreateMany.mock.calls[0]?.[0].data).toMatchObject({
			userId: "user-1",
			requesterUserId: "user-2",
		});
	});

	it("mints no grant and records no asker when Fabric cannot place who asked", async () => {
		acceptNewTurn();
		mocks.audience.mockReturnValue({
			requesterUserId: null,
			withConfidential: false,
		});

		const response = await POST(request({ requester: undefined }));

		expect(await response.json()).toMatchObject({ accepted: true });
		expect(mocks.mintGrant).not.toHaveBeenCalled();
		expect(mocks.turnCreateMany.mock.calls[0]?.[0].data).toMatchObject({
			requesterUserId: null,
		});
		const args = mocks.workflowStart.mock.calls[0]?.[1].args[0];
		expect(args).not.toHaveProperty("actingGrant");
		expect(args).toMatchObject({ withConfidential: false });
	});

	it("tells the turn whether everyone present may hear the confidential part", async () => {
		acceptNewTurn();
		mocks.audience
			.mockReturnValueOnce({
				requesterUserId: "user-1",
				withConfidential: true,
			})
			.mockReturnValueOnce({
				requesterUserId: "user-1",
				withConfidential: false,
			});

		await POST(request());
		await POST(request());

		expect(
			mocks.workflowStart.mock.calls.map(
				([, options]) => options.args[0].withConfidential,
			),
		).toEqual([true, false]);
	});

	it("tells the audience a guest is or was expected in the meeting", async () => {
		acceptNewTurn();
		const session = {
			id: "session-1",
			projectId: "project-1",
			organizationId: "org-1",
			userId: "user-1",
			activeTurnId: null,
			streamGeneration: 3,
			attendeeUserIds: ["user-1"],
			confidentialSince: null,
		};
		mocks.sessionFindFirst
			.mockResolvedValueOnce({
				...session,
				externalInvitees: false,
				guestJoinedAt: new Date("2026-01-01T10:00:00Z"),
			})
			.mockResolvedValueOnce({
				...session,
				externalInvitees: true,
				guestJoinedAt: null,
			});

		await POST(request());
		await POST(request());

		expect(
			mocks.audience.mock.calls.map(([input]) => input.guests),
		).toEqual([true, true]);
	});

	it("checks every confirmed attendee again before the turn starts", async () => {
		acceptNewTurn();

		const response = await POST(
			request({ attendees: ["user-1", "user-2"] }),
		);

		expect(await response.json()).toMatchObject({ accepted: true });
		expect(mocks.attendeeWithoutRead).toHaveBeenCalledWith({
			projectId: "project-1",
			userIds: ["user-1", "user-2"],
		});
		expect(mocks.leave).not.toHaveBeenCalled();
	});

	it("checks no one for a bridge that names no attendees", async () => {
		acceptNewTurn();

		await POST(request({ attendees: undefined, requester: undefined }));

		expect(mocks.attendeeWithoutRead).toHaveBeenCalledWith({
			projectId: "project-1",
			userIds: [],
		});
		expect(mocks.workflowStart).toHaveBeenCalled();
	});

	it("runs no turn and leaves, saying who, when an attendee can no longer read the project", async () => {
		acceptNewTurn();
		mocks.attendeeWithoutRead.mockResolvedValue({ name: "Dana Member" });
		mocks.departureNotice.mockReturnValue("I'm leaving: example.");

		const response = await POST(request({ attendees: ["user-2"] }));

		expect(await response.json()).toEqual({ accepted: false });
		expect(mocks.departureNotice).toHaveBeenCalledWith({
			kind: "attendee",
			name: "Dana Member",
		});
		expect(mocks.leave).toHaveBeenCalledWith({
			session: {
				id: "session-1",
				providerBotId: "bot-1",
				streamGeneration: 3,
			},
			reason: "ATTENDEE_NOT_AUTHORIZED",
			lastError: null,
			captureStopped: true,
			notice: "I'm leaving: example.",
		});
		expect(mocks.turnCreateMany).not.toHaveBeenCalled();
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});

	it("mints the same read-only grant for an Actions meeting as for a read-only one", async () => {
		acceptNewTurn();
		for (const toolsReadOnly of [false, true]) {
			mocks.sessionFindFirst.mockResolvedValue({
				id: "session-1",
				projectId: "project-1",
				organizationId: "org-1",
				userId: "user-1",
				activeTurnId: null,
				toolsReadOnly,
			});

			await POST(request());
		}

		expect(mocks.mintGrant.mock.calls).toEqual([
			[
				{
					userId: "user-1",
					organizationId: "org-1",
					projectId: "project-1",
				},
			],
			[
				{
					userId: "user-1",
					organizationId: "org-1",
					projectId: "project-1",
				},
			],
		]);
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
		expect(await response.json()).toEqual({
			accepted: true,
			// Each step's milliseconds since the handler started, for the
			// bridge's dispatch log.
			timing: {
				sessionMs: expect.any(Number),
				attendeesMs: expect.any(Number),
				audienceMs: expect.any(Number),
				turnMs: expect.any(Number),
				claimMs: expect.any(Number),
				temporalClientMs: expect.any(Number),
				workflowStartMs: expect.any(Number),
			},
		});
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

describe("Parlume confidential requests", () => {
	beforeEach(() => {
		mocks.turnCreateMany.mockResolvedValue({ count: 1 });
		mocks.turnFindUnique.mockResolvedValue({
			id: "turn-1",
			status: "PENDING",
			error: null,
		});
	});

	it("starts the confidential part, tells the chat, and still runs the turn that answers it", async () => {
		const response = await POST(request({ text: "off the record" }));

		expect(await response.json()).toMatchObject({ accepted: true });
		expect(mocks.setRange).toHaveBeenCalledWith(
			expect.objectContaining({
				switch: "on",
				by: "Alice",
				offsetMs: 1_000,
			}),
		);
		expect(mocks.setRange.mock.calls[0]?.[0]).not.toHaveProperty("force");
		expect(mocks.postNotice).toHaveBeenCalledWith({
			sessionId: "session-1",
			switch: "on",
			by: "Alice",
		});
		expect(mocks.workflowStart).toHaveBeenCalled();
	});

	it("posts no second notice when the request's segment already set the mark", async () => {
		mocks.setRange.mockResolvedValue({ changed: false, open: true });

		await POST(request({ text: "Confidential from now on." }));

		expect(mocks.setRange).toHaveBeenCalled();
		expect(mocks.postNotice).not.toHaveBeenCalled();
	});

	it("does not switch the mark again for a retried delivery of the request", async () => {
		mocks.turnCreateMany.mockResolvedValue({ count: 0 });

		await POST(request({ text: "off the record" }));

		expect(mocks.setRange).not.toHaveBeenCalled();
		expect(mocks.postNotice).not.toHaveBeenCalled();
	});

	it("changes nothing for a question that only mentions confidentiality", async () => {
		await POST(request({ text: "Is the roadmap confidential?" }));

		expect(mocks.setRange).not.toHaveBeenCalled();
		expect(mocks.postNotice).not.toHaveBeenCalled();
	});
});
