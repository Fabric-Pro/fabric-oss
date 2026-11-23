import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findFirst: vi.fn(),
	updateMany: vi.fn(),
	settings: vi.fn(),
	leave: vi.fn(),
	bridge: vi.fn(),
	noteLeaving: vi.fn(),
	sendChat: vi.fn(),
	inCall: vi.fn(),
	log: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		parlumeMeetingSession: {
			findFirst: (...args: unknown[]) => mocks.findFirst(...args),
			updateMany: (...args: unknown[]) => mocks.updateMany(...args),
		},
	},
}));

vi.mock("../parlume-attendee", async (importOriginal) => ({
	...(await importOriginal<typeof import("../parlume-attendee")>()),
	getParlumeBridgeSettings: () => mocks.bridge(),
	leaveParlumeMeetingBot: (...args: unknown[]) => mocks.leave(...args),
	noteParlumeLeaving: (...args: unknown[]) => mocks.noteLeaving(...args),
	sendParlumeMeetingChat: (...args: unknown[]) => mocks.sendChat(...args),
	waitForParlumeBotInCall: (...args: unknown[]) => mocks.inCall(...args),
}));

vi.mock("../parlume-provider-settings", () => ({
	resolveParlumeAttendeeSettingsForSession: (...args: unknown[]) =>
		mocks.settings(...args),
}));

vi.mock("../parlume-log", () => ({
	parlumeLog: (...args: unknown[]) => mocks.log(...args),
}));

import { PARLUME_CHAT_SETTLE_MS, requestParlumeLeave } from "../parlume-leave";

const session = {
	id: "session-1",
	providerBotId: "bot-1",
	streamGeneration: 2,
};

const attendee = {
	apiKey: "org-key",
	baseUrl: "https://attendee.example.com",
	teamsLoginMode: null,
	source: "organization",
};

const bridge = {
	bridgeUrl: "wss://bridge.example.com/live",
	callbackUrl: "https://fabric.example.com/api/internal/parlume/callback",
	serviceSecret: "service-secret",
};

beforeEach(() => {
	vi.resetAllMocks();
	mocks.updateMany.mockResolvedValue({ count: 1 });
	mocks.settings.mockResolvedValue(attendee);
	mocks.leave.mockResolvedValue({ kind: "LEAVE_REQUESTED" });
	mocks.bridge.mockReturnValue(bridge);
	mocks.noteLeaving.mockResolvedValue(true);
	mocks.findFirst.mockResolvedValue(null);
	mocks.sendChat.mockResolvedValue(undefined);
	mocks.inCall.mockResolvedValue("in_call");
});

const notice =
	"I'm leaving: I could not confirm that Guest B can see this project in Fabric. I answer only when everyone in the meeting can.";

// The meeting chat has not shown the join notice; the bot came into the call
// long enough ago for its chat to have settled.
const admitting = {
	joinedAt: new Date(0),
	channelId: null,
	channelRootMessageId: null,
	channelChatStatus: "ATTENDEE",
};

describe("requestParlumeLeave", () => {
	it("records the reason, stops capture, and asks the provider to leave", async () => {
		const result = await requestParlumeLeave({
			session,
			reason: "IDLE",
			lastError: null,
			captureStopped: true,
		});

		expect(result).toEqual({ kind: "LEAVE_REQUESTED" });
		expect(mocks.updateMany).toHaveBeenCalledWith({
			where: {
				id: "session-1",
				streamGeneration: 2,
				status: { in: ["JOINING", "ACTIVE", "LEAVING", "STOP_FAILED"] },
				finalizedAt: null,
				OR: [
					{ status: { not: "LEAVING" } },
					{ joinNoticeAt: { not: null } },
					{ leaveRequestedAt: null },
					{ leaveRequestedAt: { lte: expect.any(Date) } },
				],
			},
			data: {
				status: "LEAVING",
				endReason: "IDLE",
				leaveRequestedAt: expect.any(Date),
				captureStoppedAt: expect.any(Date),
			},
		});
		expect(mocks.settings).toHaveBeenCalledWith("session-1");
		expect(mocks.leave).toHaveBeenCalledWith({
			attendee,
			providerBotId: "bot-1",
		});
	});

	it("marks the stop failed when no Attendee settings resolve for the session", async () => {
		mocks.settings.mockResolvedValue(null);

		await expect(
			requestParlumeLeave({
				session,
				reason: "STOPPED",
				lastError: null,
				captureStopped: true,
			}),
		).rejects.toThrow("Parlume provider configuration is unavailable.");
		expect(mocks.leave).not.toHaveBeenCalled();
		expect(mocks.updateMany).toHaveBeenLastCalledWith({
			where: { id: "session-1", status: "LEAVING" },
			data: { status: "STOP_FAILED" },
		});
	});

	it("writes the detail only when the caller has one", async () => {
		await requestParlumeLeave({
			session,
			reason: "ACCESS_REVOKED",
			lastError: "The inviter no longer has access to this project.",
			captureStopped: true,
		});

		expect(mocks.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					lastError:
						"The inviter no longer has access to this project.",
				}),
			}),
		);
	});

	it("does nothing for a session another path already finished", async () => {
		mocks.updateMany.mockResolvedValue({ count: 0 });

		const result = await requestParlumeLeave({
			session,
			reason: "IDLE",
			lastError: null,
			captureStopped: true,
		});

		expect(result).toBeNull();
		expect(mocks.leave).not.toHaveBeenCalled();
	});

	it("has the bridge tell the meeting chat before the session leaves ACTIVE", async () => {
		const order: string[] = [];
		mocks.noteLeaving.mockImplementation(async () => {
			order.push("notice");
		});
		mocks.updateMany.mockImplementation(async () => {
			order.push("claim");
			return { count: 1 };
		});
		mocks.leave.mockImplementation(async () => {
			order.push("leave");
			return { kind: "LEAVE_REQUESTED" };
		});

		await requestParlumeLeave({
			session,
			reason: "IDLE",
			lastError: null,
			captureStopped: true,
		});

		expect(mocks.noteLeaving).toHaveBeenCalledWith({
			settings: bridge,
			sessionId: "session-1",
		});
		expect(order).toEqual(["notice", "claim", "leave"]);
	});

	it("hands the bridge why Parlume is leaving with the leaving line", async () => {
		await requestParlumeLeave({
			session,
			reason: "ATTENDEE_NOT_AUTHORIZED",
			lastError: null,
			captureStopped: true,
			notice: "I'm leaving: example.",
		});

		expect(mocks.noteLeaving).toHaveBeenCalledWith({
			settings: bridge,
			sessionId: "session-1",
			notice: "I'm leaving: example.",
		});
		expect(mocks.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					endReason: "ATTENDEE_NOT_AUTHORIZED",
				}),
			}),
		);
	});

	it("leaves even when the bridge cannot post the notice", async () => {
		mocks.noteLeaving.mockRejectedValue(new Error("bridge down"));

		const result = await requestParlumeLeave({
			session,
			reason: "EXTERNAL_GUEST",
			lastError: null,
			captureStopped: true,
		});

		expect(result).toEqual({ kind: "LEAVE_REQUESTED" });
		expect(mocks.log).toHaveBeenCalledWith(
			"warn",
			"leave.notice_failed",
			expect.objectContaining({ sessionId: "session-1" }),
		);
	});

	it("records a notice the bridge could not post", async () => {
		mocks.noteLeaving.mockResolvedValue(false);

		await requestParlumeLeave({
			session,
			reason: "ATTENDEE_NOT_AUTHORIZED",
			lastError: null,
			captureStopped: true,
			notice,
		});

		expect(mocks.log).toHaveBeenCalledWith(
			"warn",
			"leave.notice_failed",
			expect.objectContaining({ sessionId: "session-1" }),
		);
		expect(mocks.leave).toHaveBeenCalled();
	});

	it("records no failure for a leaving line without a notice", async () => {
		mocks.noteLeaving.mockResolvedValue(false);

		await requestParlumeLeave({
			session,
			reason: "IDLE",
			lastError: null,
			captureStopped: true,
		});

		expect(mocks.log).not.toHaveBeenCalledWith(
			"warn",
			"leave.notice_failed",
			expect.anything(),
		);
	});

	// Two guests were in the meeting as the bot came in. The bridge posted
	// the notice 1.4 seconds after the stream was verified, Attendee took
	// it, the chat never showed it, and Parlume left in silence.
	it("posts the notice through Attendee, not the bridge, then leaves, when the meeting chat has not shown the join notice", async () => {
		const order: string[] = [];
		mocks.findFirst.mockResolvedValue(admitting);
		mocks.updateMany.mockImplementation(async () => {
			order.push("claim");
			return { count: 1 };
		});
		mocks.sendChat.mockImplementation(async () => {
			order.push("notice");
		});
		mocks.leave.mockImplementation(async () => {
			order.push("leave");
			return { kind: "LEAVE_REQUESTED" };
		});

		await requestParlumeLeave({
			session,
			reason: "ATTENDEE_NOT_AUTHORIZED",
			lastError: null,
			captureStopped: true,
			notice,
		});

		expect(mocks.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "session-1", joinNoticeAt: null },
			}),
		);
		expect(mocks.noteLeaving).toHaveBeenCalledWith({
			settings: bridge,
			sessionId: "session-1",
		});
		expect(mocks.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ leaveRequestedAt: null }),
			}),
		);
		expect(mocks.sendChat).toHaveBeenCalledWith({
			attendee,
			providerBotId: "bot-1",
			message: notice,
			plain: true,
		});
		expect(order).toEqual(["claim", "notice", "leave"]);
		expect(mocks.log).not.toHaveBeenCalledWith(
			"warn",
			"leave.notice_failed",
			expect.anything(),
		);
	});

	it("leaves the notice to the bridge once the meeting chat showed the join notice", async () => {
		await requestParlumeLeave({
			session,
			reason: "ATTENDEE_NOT_AUTHORIZED",
			lastError: null,
			captureStopped: true,
			notice,
		});

		expect(mocks.noteLeaving).toHaveBeenCalledWith({
			settings: bridge,
			sessionId: "session-1",
			notice,
		});
		expect(mocks.sendChat).not.toHaveBeenCalled();
		expect(mocks.inCall).not.toHaveBeenCalled();
		expect(mocks.leave).toHaveBeenCalled();
	});

	it("leaves the notice to the bridge for an open channel thread", async () => {
		mocks.findFirst.mockResolvedValue({
			...admitting,
			channelId: "channel-1",
		});

		await requestParlumeLeave({
			session,
			reason: "ATTENDEE_NOT_AUTHORIZED",
			lastError: null,
			captureStopped: true,
			notice,
		});

		expect(mocks.noteLeaving).toHaveBeenCalledWith({
			settings: bridge,
			sessionId: "session-1",
			notice,
		});
		expect(mocks.sendChat).not.toHaveBeenCalled();
	});

	// The notice posted as the bot came into the call never showed either.
	it("waits until the bot has been in the call long enough for its chat to settle before it posts the notice", async () => {
		vi.useFakeTimers();
		try {
			mocks.findFirst.mockResolvedValue({
				...admitting,
				joinedAt: new Date(),
			});

			const leaving = requestParlumeLeave({
				session,
				reason: "ATTENDEE_NOT_AUTHORIZED",
				lastError: null,
				captureStopped: true,
				notice,
			});
			await vi.advanceTimersByTimeAsync(PARLUME_CHAT_SETTLE_MS - 1_000);
			expect(mocks.sendChat).not.toHaveBeenCalled();
			expect(mocks.leave).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(1_000);
			await leaving;

			expect(mocks.sendChat).toHaveBeenCalledWith(
				expect.objectContaining({ message: notice }),
			);
			expect(mocks.leave).toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("counts the settle from when the bot came into the call when its stream is not yet verified", async () => {
		vi.useFakeTimers();
		try {
			mocks.findFirst.mockResolvedValue({ ...admitting, joinedAt: null });
			mocks.inCall.mockImplementation(async () => {
				await new Promise((resolve) => setTimeout(resolve, 4_000));
				return "in_call";
			});

			const leaving = requestParlumeLeave({
				session,
				reason: "ATTENDEE_NOT_AUTHORIZED",
				lastError: null,
				captureStopped: true,
				notice,
			});
			await vi.advanceTimersByTimeAsync(
				4_000 + PARLUME_CHAT_SETTLE_MS - 1,
			);
			expect(mocks.sendChat).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(1);
			await leaving;

			expect(mocks.sendChat).toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("posts the early notice through Attendee without a media bridge", async () => {
		mocks.bridge.mockReturnValue(null);
		mocks.findFirst.mockResolvedValue(admitting);

		await requestParlumeLeave({
			session,
			reason: "ATTENDEE_NOT_AUTHORIZED",
			lastError: null,
			captureStopped: true,
			notice,
		});

		expect(mocks.sendChat).toHaveBeenCalledWith(
			expect.objectContaining({ message: notice }),
		);
	});

	// A retry after a provider refusal, or a second unconfirmed attendee at
	// the same time, found the leave already requested and posted again.
	it("posts the early notice only for the first request to leave", async () => {
		mocks.noteLeaving.mockResolvedValue(false);
		mocks.findFirst.mockResolvedValue(admitting);
		mocks.updateMany
			.mockResolvedValueOnce({ count: 0 })
			.mockResolvedValueOnce({ count: 1 });

		const result = await requestParlumeLeave({
			session,
			reason: "ATTENDEE_NOT_AUTHORIZED",
			lastError: null,
			captureStopped: true,
			notice,
		});

		expect(result).toEqual({ kind: "LEAVE_REQUESTED" });
		expect(mocks.updateMany).toHaveBeenLastCalledWith(
			expect.objectContaining({
				where: expect.not.objectContaining({ leaveRequestedAt: null }),
			}),
		);
		expect(mocks.sendChat).not.toHaveBeenCalled();
		expect(mocks.leave).toHaveBeenCalled();
		// The request that claimed the leave owns the notice: no failure here.
		expect(mocks.log).toHaveBeenCalledWith(
			"info",
			"leave.notice_claimed_elsewhere",
			{ sessionId: "session-1" },
		);
		expect(mocks.log).not.toHaveBeenCalledWith(
			"warn",
			"leave.notice_failed",
			expect.anything(),
		);
	});

	it("records an early notice it claimed but could not post before the leave failed", async () => {
		mocks.noteLeaving.mockResolvedValue(false);
		mocks.findFirst.mockResolvedValue(admitting);
		mocks.settings.mockResolvedValue(null);

		await expect(
			requestParlumeLeave({
				session,
				reason: "ATTENDEE_NOT_AUTHORIZED",
				lastError: null,
				captureStopped: true,
				notice,
			}),
		).rejects.toThrow("Parlume provider configuration is unavailable.");
		expect(mocks.sendChat).not.toHaveBeenCalled();
		expect(mocks.log).toHaveBeenCalledWith(
			"warn",
			"leave.notice_failed",
			expect.objectContaining({
				sessionId: "session-1",
				error: "Parlume provider configuration is unavailable.",
			}),
		);
	});

	it("posts the early notice when the bridge did not answer", async () => {
		mocks.noteLeaving.mockRejectedValue(new Error("timed out"));
		mocks.findFirst.mockResolvedValue(admitting);

		await requestParlumeLeave({
			session,
			reason: "ATTENDEE_NOT_AUTHORIZED",
			lastError: null,
			captureStopped: true,
			notice,
		});

		expect(mocks.sendChat).toHaveBeenCalledWith(
			expect.objectContaining({ message: notice }),
		);
	});

	it("posts the early notice only from the call that claimed the leave", async () => {
		mocks.noteLeaving.mockResolvedValue(false);
		mocks.findFirst.mockResolvedValue(admitting);
		mocks.updateMany.mockResolvedValue({ count: 0 });

		const result = await requestParlumeLeave({
			session,
			reason: "ATTENDEE_NOT_AUTHORIZED",
			lastError: null,
			captureStopped: true,
			notice,
		});

		expect(result).toBeNull();
		expect(mocks.sendChat).not.toHaveBeenCalled();
	});

	it("records an early notice Attendee refused, and still leaves", async () => {
		mocks.noteLeaving.mockResolvedValue(false);
		mocks.findFirst.mockResolvedValue(admitting);
		mocks.sendChat.mockRejectedValue(new Error("bot not in the call"));

		const result = await requestParlumeLeave({
			session,
			reason: "ATTENDEE_NOT_AUTHORIZED",
			lastError: null,
			captureStopped: true,
			notice,
		});

		expect(result).toEqual({ kind: "LEAVE_REQUESTED" });
		expect(mocks.log).toHaveBeenCalledWith(
			"warn",
			"leave.notice_failed",
			expect.objectContaining({
				sessionId: "session-1",
				error: "bot not in the call",
			}),
		);
	});

	// A guest already in the meeting was seen while the bot was still
	// joining; Attendee refused the notice and Parlume left in silence.
	it("waits for the bot to be in the call before it posts the early notice and leaves", async () => {
		const order: string[] = [];
		mocks.noteLeaving.mockResolvedValue(false);
		mocks.findFirst.mockResolvedValue(admitting);
		mocks.inCall.mockImplementation(async () => {
			order.push("in_call");
			return "in_call";
		});
		mocks.sendChat.mockImplementation(async () => {
			order.push("notice");
		});
		mocks.leave.mockImplementation(async () => {
			order.push("leave");
			return { kind: "LEAVE_REQUESTED" };
		});

		await requestParlumeLeave({
			session,
			reason: "ATTENDEE_NOT_AUTHORIZED",
			lastError: null,
			captureStopped: true,
			notice,
		});

		expect(mocks.inCall).toHaveBeenCalledWith({
			attendee,
			providerBotId: "bot-1",
		});
		expect(order).toEqual(["in_call", "notice", "leave"]);
	});

	// Two people Fabric could not confirm were seen while the bot was joining.
	// The second request found the leave claimed, had the bot leave at once,
	// and the first request's wait found the bot gone: no notice was posted.
	it("posts one early notice when two requests arrive together, and has the bot leave only after it", async () => {
		const order: string[] = [];
		const row: { status: string; leaveRequestedAt: Date | null } = {
			status: "JOINING",
			leaveRequestedAt: null,
		};
		mocks.noteLeaving.mockResolvedValue(false);
		mocks.findFirst.mockResolvedValue(admitting);
		mocks.updateMany.mockImplementation(
			async (query: {
				where: { leaveRequestedAt?: null; OR?: unknown[] };
				data: { status: string; leaveRequestedAt?: Date };
			}) => {
				await Promise.resolve();
				if (query.data.status === "STOP_FAILED") {
					row.status = "STOP_FAILED";
					return { count: 1 };
				}
				const taken =
					query.where.leaveRequestedAt === null &&
					row.leaveRequestedAt !== null;
				// The early notice's claim is a few milliseconds old.
				const held =
					query.where.OR !== undefined &&
					row.status === "LEAVING" &&
					row.leaveRequestedAt !== null;
				if (taken || held) {
					return { count: 0 };
				}
				row.status = query.data.status;
				row.leaveRequestedAt = query.data.leaveRequestedAt ?? null;
				return { count: 1 };
			},
		);
		mocks.inCall.mockImplementation(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
			return order.includes("leave") ? "gone" : "in_call";
		});
		mocks.sendChat.mockImplementation(async () => {
			order.push("notice");
		});
		mocks.leave.mockImplementation(async () => {
			order.push("leave");
			return { kind: "LEAVE_REQUESTED" };
		});
		const leave = (name: string) =>
			requestParlumeLeave({
				session,
				reason: "ATTENDEE_NOT_AUTHORIZED",
				lastError: null,
				captureStopped: true,
				notice: `I'm leaving: I could not confirm that ${name} can see this project in Fabric.`,
			});

		const results = await Promise.all([leave("Guest A"), leave("Guest B")]);

		expect(order).toEqual(["notice", "leave"]);
		expect(mocks.sendChat).toHaveBeenCalledTimes(1);
		expect(results).toEqual([{ kind: "LEAVE_REQUESTED" }, null]);
		expect(row.status).toBe("LEAVING");
	});

	it("leaves without the early notice, and records why, when the bot is not in the call within the bound", async () => {
		mocks.noteLeaving.mockResolvedValue(false);
		mocks.findFirst.mockResolvedValue(admitting);
		mocks.inCall.mockResolvedValue("timeout");

		const result = await requestParlumeLeave({
			session,
			reason: "ATTENDEE_NOT_AUTHORIZED",
			lastError: null,
			captureStopped: true,
			notice,
		});

		expect(result).toEqual({ kind: "LEAVE_REQUESTED" });
		expect(mocks.sendChat).not.toHaveBeenCalled();
		expect(mocks.log).toHaveBeenCalledWith(
			"warn",
			"leave.notice_failed",
			expect.objectContaining({
				sessionId: "session-1",
				error: "The bot was not in the call within 30 seconds, so it could not post the notice.",
			}),
		);
	});

	it("records an early notice a channel thread cannot take yet, and still leaves", async () => {
		mocks.noteLeaving.mockResolvedValue(false);
		mocks.findFirst.mockResolvedValue({
			...admitting,
			joinedAt: null,
			channelId: "channel-1",
		});

		const result = await requestParlumeLeave({
			session,
			reason: "ATTENDEE_NOT_AUTHORIZED",
			lastError: null,
			captureStopped: true,
			notice,
		});

		expect(result).toEqual({ kind: "LEAVE_REQUESTED" });
		expect(mocks.sendChat).not.toHaveBeenCalled();
		expect(mocks.log).toHaveBeenCalledWith(
			"warn",
			"leave.notice_failed",
			expect.objectContaining({ sessionId: "session-1" }),
		);
	});

	it("posts no notice without a media bridge", async () => {
		mocks.bridge.mockReturnValue(null);

		await requestParlumeLeave({
			session,
			reason: "IDLE",
			lastError: null,
			captureStopped: true,
		});

		expect(mocks.noteLeaving).not.toHaveBeenCalled();
		expect(mocks.leave).toHaveBeenCalled();
	});

	it("leaves the session retryable when the provider refuses", async () => {
		mocks.leave.mockRejectedValue(new Error("provider outage"));

		await expect(
			requestParlumeLeave({
				session,
				reason: "STREAM_ERROR",
				lastError: null,
				captureStopped: false,
			}),
		).rejects.toThrow("provider outage");
		expect(mocks.updateMany).toHaveBeenLastCalledWith({
			where: { id: "session-1", status: "LEAVING" },
			data: { status: "STOP_FAILED" },
		});
		expect(mocks.log).toHaveBeenCalledWith(
			"error",
			"leave.failed",
			expect.objectContaining({ reason: "STREAM_ERROR" }),
		);
	});
});
