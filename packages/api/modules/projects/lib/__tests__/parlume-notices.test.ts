import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findUnique: vi.fn(),
	findFirst: vi.fn(),
	deliveryPreferences: vi.fn(),
	createNotification: vi.fn(),
	sendEmail: vi.fn(),
	log: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		parlumeMeetingSession: {
			findUnique: mocks.findUnique,
			findFirst: mocks.findFirst,
		},
	},
	getDeliveryPreferences: mocks.deliveryPreferences,
	NotificationCategory: { SYSTEM: "SYSTEM" },
	NotificationType: {
		PARLUME_JOIN_FAILED: "PARLUME_JOIN_FAILED",
		PARLUME_WAITING_IN_LOBBY: "PARLUME_WAITING_IN_LOBBY",
	},
}));

vi.mock("@repo/mail", () => ({ sendEmail: mocks.sendEmail }));

vi.mock("@repo/utils", () => ({
	toAbsoluteUrl: (path: string) => `https://fabric.example.com${path}`,
}));

vi.mock("../../../../lib/notification-service", () => ({
	createNotification: mocks.createNotification,
}));

vi.mock("../parlume-log", () => ({ parlumeLog: mocks.log }));

const {
	formatParlumeAdmitBy,
	notifyParlumeJoinFailure,
	notifyParlumeWaitingInLobby,
} = await import("../parlume-notices");

const PAGE_URL =
	"https://fabric.example.com/app/example-org/projects/project-1/parlume";

function noticeSession(overrides: Record<string, unknown> = {}) {
	return {
		id: "session-1",
		projectId: "project-1",
		organizationId: "org-1",
		userId: "user-1",
		trigger: "AUTO",
		endReason: "NOT_ADMITTED",
		lastError: "Nobody admitted Parlume from the lobby within 5 minutes.",
		createdAt: new Date("2026-11-21T10:00:00.000Z"),
		linkedMeeting: { subject: "Weekly planning" },
		organization: { slug: "example-org" },
		user: { email: "dev@example.com", timezone: null },
		...overrides,
	};
}

beforeEach(() => {
	vi.resetAllMocks();
	mocks.findUnique.mockResolvedValue(noticeSession());
	mocks.findFirst.mockResolvedValue(noticeSession({ endReason: null }));
	mocks.deliveryPreferences.mockResolvedValue({ emailEnabled: false });
	mocks.createNotification.mockResolvedValue({ id: "notification-1" });
	mocks.sendEmail.mockResolvedValue(true);
});

afterEach(() => {
	vi.useRealTimers();
});

describe("notifyParlumeJoinFailure", () => {
	it("tells the enabler once, in the app and by email, that nobody admitted the bot, with the session's reason", async () => {
		await notifyParlumeJoinFailure("session-1");

		expect(mocks.findUnique).toHaveBeenCalledWith(
			expect.objectContaining({ where: { id: "session-1" } }),
		);
		expect(mocks.createNotification).toHaveBeenCalledWith({
			userId: "user-1",
			organizationId: "org-1",
			type: "PARLUME_JOIN_FAILED",
			category: "SYSTEM",
			title: "Parlume was not admitted to your meeting",
			snippet:
				"Weekly planning: Nobody admitted Parlume from the lobby within 5 minutes.",
			link: "projects/project-1/parlume",
			source: { projectId: "project-1" },
			payload: {
				sessionId: "session-1",
				projectId: "project-1",
				trigger: "AUTO",
				endReason: "NOT_ADMITTED",
			},
			dedupeKey: "parlume-join-failed:session-1",
			dedupePolicy: "unreadOnly",
		});
		expect(mocks.sendEmail).toHaveBeenCalledOnce();
		expect(mocks.sendEmail).toHaveBeenCalledWith({
			to: "dev@example.com",
			templateId: "parlumeJoinFailed",
			idempotencyKey: "parlume-join-failed-session-1",
			context: {
				meetingName: "Weekly planning",
				reason: "Nobody admitted Parlume from the lobby within 5 minutes.",
				url: PAGE_URL,
			},
		});
	});

	it("says the start failed, with its reason alone when the meeting is no linked series", async () => {
		mocks.findUnique.mockResolvedValue(
			noticeSession({
				trigger: "MANUAL",
				endReason: "START_FAILED",
				lastError:
					"Teams could not find this meeting. Check the meeting link.",
				linkedMeeting: null,
			}),
		);

		await notifyParlumeJoinFailure("session-1");

		expect(mocks.createNotification).toHaveBeenCalledWith(
			expect.objectContaining({
				title: "Parlume could not join your meeting",
				snippet:
					"Teams could not find this meeting. Check the meeting link.",
				payload: expect.objectContaining({
					trigger: "MANUAL",
					endReason: "START_FAILED",
				}),
			}),
		);
		expect(mocks.sendEmail).toHaveBeenCalledWith(
			expect.objectContaining({
				context: expect.objectContaining({ meetingName: null }),
			}),
		);
	});

	it.each(["PROVIDER_FAILED", "STOPPED", null])(
		"tells nobody about a session that ended as %s",
		async (endReason) => {
			mocks.findUnique.mockResolvedValue(noticeSession({ endReason }));

			await notifyParlumeJoinFailure("session-1");

			expect(mocks.createNotification).not.toHaveBeenCalled();
			expect(mocks.sendEmail).not.toHaveBeenCalled();
		},
	);

	it("sends no second email while the first notification is still unread", async () => {
		mocks.createNotification.mockResolvedValue({
			skipped: true,
			reason: "deduped-unread",
		});

		await notifyParlumeJoinFailure("session-1");

		expect(mocks.sendEmail).not.toHaveBeenCalled();
	});

	it("leaves the email to the person's email channel when it is on", async () => {
		mocks.deliveryPreferences.mockResolvedValue({ emailEnabled: true });

		await notifyParlumeJoinFailure("session-1");

		expect(mocks.createNotification).toHaveBeenCalledOnce();
		expect(mocks.deliveryPreferences).toHaveBeenCalledWith("user-1");
		expect(mocks.sendEmail).not.toHaveBeenCalled();
	});

	it("logs a notice it could not write instead of failing its caller", async () => {
		mocks.createNotification.mockRejectedValue(
			new Error("database unavailable"),
		);

		await expect(
			notifyParlumeJoinFailure("session-1"),
		).resolves.toBeUndefined();
		expect(mocks.log).toHaveBeenCalledWith(
			"warn",
			"notice.failed",
			expect.objectContaining({
				sessionId: "session-1",
				notice: "join_failed",
			}),
		);
		expect(mocks.sendEmail).not.toHaveBeenCalled();
	});
});

describe("notifyParlumeWaitingInLobby", () => {
	// Staging, 2026-11-21: a bot nobody admitted went from joining straight
	// to waiting_room_timeout_exceeded, with no waiting_room state between,
	// and no lobby notice was ever stored. The bridge now asks for it.
	it("tells the inviter, when the bridge asks, by when to admit the bot: five minutes from the invite", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-11-21T10:01:30.000Z"));

		await notifyParlumeWaitingInLobby({ sessionId: "session-1" });

		expect(mocks.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					id: "session-1",
					providerBotId: { not: null },
					status: "JOINING",
					joinedAt: null,
				},
			}),
		);
		const admitBy = formatParlumeAdmitBy(
			new Date("2026-11-21T10:05:00.000Z"),
			null,
		);
		expect(admitBy).toContain("10:05");
		expect(mocks.createNotification).toHaveBeenCalledWith({
			userId: "user-1",
			organizationId: "org-1",
			type: "PARLUME_WAITING_IN_LOBBY",
			category: "SYSTEM",
			title: `Parlume is waiting to join: admit Fabric Parlume from the lobby by ${admitBy}`,
			snippet:
				"Weekly planning: If nobody admits it by then, it leaves the meeting.",
			link: "projects/project-1/parlume",
			source: { projectId: "project-1" },
			payload: {
				sessionId: "session-1",
				projectId: "project-1",
				trigger: "AUTO",
				admitBy,
			},
			dedupeKey: "parlume-lobby:session-1",
			dedupePolicy: "unreadOnly",
		});
		expect(mocks.sendEmail).toHaveBeenCalledWith({
			to: "dev@example.com",
			templateId: "parlumeWaitingInLobby",
			idempotencyKey: "parlume-lobby-session-1",
			context: { meetingName: "Weekly planning", admitBy, url: PAGE_URL },
		});
	});

	it("matches a provider's own lobby report to the session's bot", async () => {
		await notifyParlumeWaitingInLobby({
			sessionId: "session-1",
			botId: "bot-1",
		});

		expect(mocks.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					id: "session-1",
					providerBotId: "bot-1",
					status: "JOINING",
					joinedAt: null,
				},
			}),
		);
		expect(mocks.createNotification).toHaveBeenCalledWith(
			expect.objectContaining({ dedupeKey: "parlume-lobby:session-1" }),
		);
	});

	it("writes the time in the recipient's own time zone", async () => {
		mocks.findFirst.mockResolvedValue(
			noticeSession({
				endReason: null,
				user: {
					email: "dev@example.com",
					timezone: "America/New_York",
				},
			}),
		);

		await notifyParlumeWaitingInLobby({
			sessionId: "session-1",
			botId: "bot-1",
		});

		expect(mocks.createNotification).toHaveBeenCalledWith(
			expect.objectContaining({
				title: expect.stringContaining("by 05:05"),
			}),
		);
	});

	it("tells nobody when the report is not for the session's joining bot", async () => {
		mocks.findFirst.mockResolvedValue(null);

		await notifyParlumeWaitingInLobby({
			sessionId: "session-1",
			botId: "bot-other",
		});

		expect(mocks.createNotification).not.toHaveBeenCalled();
		expect(mocks.sendEmail).not.toHaveBeenCalled();
	});
});

describe("formatParlumeAdmitBy", () => {
	const at = new Date("2026-11-21T10:10:59.000Z");

	it("cuts the seconds instead of rounding up", () => {
		expect(formatParlumeAdmitBy(at, null)).toContain("10:10");
	});

	it("reads an unknown time zone as UTC", () => {
		expect(formatParlumeAdmitBy(at, "Not/A_Zone")).toBe(
			formatParlumeAdmitBy(at, null),
		);
	});
});
