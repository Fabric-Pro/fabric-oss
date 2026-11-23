import { beforeEach, describe, expect, it, vi } from "vitest";
import { notifyParlumeNotesReady } from "../parlume-notes-ready";

const mocks = vi.hoisted(() => ({
	sessionFindUnique: vi.fn(),
	sessionUpdateMany: vi.fn(),
	contextFindFirst: vi.fn(),
	userFindMany: vi.fn(),
	notificationCreate: vi.fn(),
	hasProjectAccess: vi.fn(),
	pageUrl: vi.fn(),
	preferences: vi.fn(),
	categoryEnabled: vi.fn(),
	mailConfigured: vi.fn(),
	sendEmail: vi.fn(),
	warn: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		parlumeMeetingSession: {
			findUnique: mocks.sessionFindUnique,
			updateMany: mocks.sessionUpdateMany,
		},
		projectContext: { findFirst: mocks.contextFindFirst },
		user: { findMany: mocks.userFindMany },
		notification: { create: mocks.notificationCreate },
	},
	hasProjectAccess: mocks.hasProjectAccess,
	buildParlumePageUrl: mocks.pageUrl,
}));

vi.mock("@repo/database/prisma/queries/notification-preferences", () => ({
	getNotificationPreferences: mocks.preferences,
	isCategoryEnabled: mocks.categoryEnabled,
}));

vi.mock("@repo/mail", () => ({
	isMailConfigured: mocks.mailConfigured,
	sendEmail: mocks.sendEmail,
}));

vi.mock("@repo/logs", () => ({
	logger: { warn: mocks.warn },
}));

const PAGE_URL =
	"https://fabric.example/app/example-org/projects/project-1/parlume";

function session(overrides: Record<string, unknown> = {}) {
	return {
		id: "session-1",
		projectId: "project-1",
		organizationId: "org-1",
		userId: "inviter",
		inviteeEmails: ["dev@example.com", "guest@partner.example"],
		confidential: false,
		attendeeUserIds: [],
		transcriptContextId: "context-1",
		notesNotifiedAt: null,
		linkedMeeting: { subject: "Weekly planning" },
		project: { name: "Example Project" },
		...overrides,
	};
}

beforeEach(() => {
	vi.resetAllMocks();
	mocks.sessionFindUnique.mockResolvedValue(session());
	mocks.contextFindFirst.mockResolvedValue({
		metadata: {
			parlumeNotes: "Decision: ship.",
			parlumeNotesStatus: "COMPLETED",
		},
	});
	mocks.sessionUpdateMany.mockResolvedValue({ count: 1 });
	// The guest's address has no Fabric account, so the lookup finds only the
	// inviter and the internal invitee.
	mocks.userFindMany.mockResolvedValue([
		{ id: "inviter", email: "inviter@example.com" },
		{ id: "dev", email: "Dev@Example.com" },
	]);
	mocks.hasProjectAccess.mockResolvedValue(true);
	mocks.pageUrl.mockResolvedValue(PAGE_URL);
	mocks.preferences.mockResolvedValue({});
	mocks.categoryEnabled.mockReturnValue(true);
	mocks.mailConfigured.mockReturnValue(true);
	mocks.sendEmail.mockResolvedValue(true);
	mocks.notificationCreate.mockResolvedValue({});
});

describe("Parlume notes-ready notice", () => {
	it("notifies and emails the inviter and each internal invitee once, with a link to the Parlume page", async () => {
		const result = await notifyParlumeNotesReady({
			sessionId: "session-1",
		});

		expect(result).toEqual({ notified: 2 });
		expect(mocks.sessionUpdateMany).toHaveBeenCalledWith({
			where: { id: "session-1", notesNotifiedAt: null },
			data: { notesNotifiedAt: expect.any(Date) },
		});
		expect(mocks.notificationCreate).toHaveBeenCalledTimes(2);
		expect(mocks.notificationCreate).toHaveBeenCalledWith({
			data: expect.objectContaining({
				userId: "dev",
				organizationId: "org-1",
				projectId: "project-1",
				type: "PARLUME_NOTES_READY",
				category: "PROJECT",
				link: "/app/example-org/projects/project-1/parlume",
				payload: { sessionId: "session-1", projectId: "project-1" },
				dedupeKey: "parlume-notes-ready:session-1",
			}),
		});
		expect(mocks.sendEmail).toHaveBeenCalledTimes(2);
		expect(mocks.sendEmail).toHaveBeenCalledWith({
			to: "Dev@Example.com",
			templateId: "parlumeNotesReady",
			idempotencyKey: "parlume-notes-session-1-dev",
			context: {
				meetingName: "Weekly planning",
				projectName: "Example Project",
				url: PAGE_URL,
			},
		});
		const recipients = mocks.sendEmail.mock.calls.map((call) => call[0].to);
		expect(recipients).not.toContain("guest@partner.example");
	});

	it("sends nothing before the notes are written", async () => {
		mocks.contextFindFirst.mockResolvedValue({
			metadata: { parlumeNotesStatus: "PENDING" },
		});

		await expect(
			notifyParlumeNotesReady({ sessionId: "session-1" }),
		).resolves.toEqual({ notified: 0 });
		expect(mocks.sessionUpdateMany).not.toHaveBeenCalled();
		expect(mocks.notificationCreate).not.toHaveBeenCalled();
		expect(mocks.sendEmail).not.toHaveBeenCalled();
	});

	it("sends nothing a second time, when another run already claimed the notice", async () => {
		mocks.sessionUpdateMany.mockResolvedValue({ count: 0 });

		await expect(
			notifyParlumeNotesReady({ sessionId: "session-1" }),
		).resolves.toEqual({ notified: 0 });
		expect(mocks.notificationCreate).not.toHaveBeenCalled();
		expect(mocks.sendEmail).not.toHaveBeenCalled();
	});

	it("leaves out an invitee who can no longer read the project", async () => {
		mocks.hasProjectAccess.mockImplementation(
			async (_projectId: string, userId: string) => userId !== "dev",
		);

		await notifyParlumeNotesReady({ sessionId: "session-1" });

		expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
		expect(mocks.sendEmail).toHaveBeenCalledWith(
			expect.objectContaining({ to: "inviter@example.com" }),
		);
	});

	it("tells only the people who were in a confidential meeting", async () => {
		mocks.sessionFindUnique.mockResolvedValue(
			session({ confidential: true, attendeeUserIds: ["dev"] }),
		);

		await notifyParlumeNotesReady({ sessionId: "session-1" });

		expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
		expect(mocks.sendEmail).toHaveBeenCalledWith(
			expect.objectContaining({ to: "Dev@Example.com" }),
		);
	});

	it("no email and no row when the invitee turned project notifications off", async () => {
		mocks.preferences.mockImplementation(async (userId: string) => ({
			userId,
		}));
		mocks.categoryEnabled.mockImplementation(
			(flags: { userId: string }) => flags.userId !== "dev",
		);

		await expect(
			notifyParlumeNotesReady({ sessionId: "session-1" }),
		).resolves.toEqual({ notified: 1 });

		expect(mocks.preferences).toHaveBeenCalledWith("dev");
		expect(mocks.categoryEnabled).toHaveBeenCalledWith(
			{ userId: "dev" },
			"PROJECT",
		);
		expect(mocks.notificationCreate).toHaveBeenCalledTimes(1);
		expect(mocks.notificationCreate).toHaveBeenCalledWith({
			data: expect.objectContaining({ userId: "inviter" }),
		});
		expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
		expect(mocks.sendEmail).toHaveBeenCalledWith(
			expect.objectContaining({ to: "inviter@example.com" }),
		);
	});
});
