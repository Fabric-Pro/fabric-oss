import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	sessionFindMany: vi.fn(),
	sessionUpdateMany: vi.fn(),
	sessionUpdate: vi.fn(),
	segmentCreateMany: vi.fn(),
	segmentUpdateMany: vi.fn(),
	segmentAggregate: vi.fn(),
	hasPermission: vi.fn(),
	bridgeSettings: vi.fn(),
	fetch: vi.fn(),
}));

vi.mock("@repo/database", () => {
	const db = {
		parlumeMeetingSession: {
			findMany: (...args: unknown[]) => mocks.sessionFindMany(...args),
			updateMany: (...args: unknown[]) =>
				mocks.sessionUpdateMany(...args),
			update: (...args: unknown[]) => mocks.sessionUpdate(...args),
		},
		parlumeMeetingSegment: {
			createMany: (...args: unknown[]) =>
				mocks.segmentCreateMany(...args),
			updateMany: (...args: unknown[]) =>
				mocks.segmentUpdateMany(...args),
			aggregate: (...args: unknown[]) => mocks.segmentAggregate(...args),
		},
		$transaction: async (work: unknown) =>
			typeof work === "function"
				? work(db)
				: Promise.all(work as unknown[]),
	};
	return { db };
});

vi.mock("@repo/permissions", () => ({
	Permissions: {
		PROJECT_READ: "project:read",
		PROJECT_MEMBERS_MANAGE: "project:members:manage",
	},
}));

vi.mock("../../../../orpc/middleware/require-permission", () => ({
	userHasProjectPermission: (...args: unknown[]) =>
		mocks.hasPermission(...args),
}));

vi.mock("../parlume-attendee", () => ({
	getParlumeBridgeSettings: () => mocks.bridgeSettings(),
	bridgeControlUrlForSession: (bridgeUrl: string, sessionId: string) =>
		`${bridgeUrl.replace("wss:", "https:")}/${sessionId}`,
}));

vi.mock("../parlume-log", () => ({ parlumeLog: vi.fn() }));

const {
	isParlumeConfidentialReader,
	markParlumeSessionConfidential,
	mayReadParlumeSessionContent,
	parlumeTurnAudience,
	postParlumeConfidentialNotice,
	recordParlumeAttendee,
	setParlumeConfidentialRange,
	withheldConfidentialParlumeSessions,
	withoutParlumeNotes,
} = await import("../parlume-confidential");

const MANAGE = "project:members:manage";

function grants(...permissions: string[]) {
	mocks.hasPermission.mockImplementation(
		async ({ permission }: { permission: string }) =>
			permissions.includes(permission),
	);
}

function liveSession(overrides: Record<string, unknown> = {}) {
	return {
		id: "session-1",
		projectId: "project-1",
		organizationId: "org-1",
		userId: "inviter-1",
		confidentialSince: null,
		externalInvitees: false,
		guestJoinedAt: null,
		...overrides,
	};
}

beforeEach(() => {
	vi.resetAllMocks();
	vi.stubGlobal("fetch", mocks.fetch);
	grants();
	mocks.sessionFindMany.mockResolvedValue([]);
	mocks.sessionUpdateMany.mockResolvedValue({ count: 1 });
	mocks.segmentCreateMany.mockResolvedValue({ count: 1 });
	mocks.segmentAggregate.mockResolvedValue({
		_max: { utteranceStartMs: null },
	});
});

describe("isParlumeConfidentialReader", () => {
	it("lets a verified attendee who still reads the project read a confidential meeting", async () => {
		grants("project:read");
		await expect(
			isParlumeConfidentialReader({
				projectId: "project-1",
				userId: "attendee-1",
				attendeeUserIds: ["attendee-1"],
			}),
		).resolves.toBe(true);
	});

	it("keeps it from an attendee who lost project access", async () => {
		await expect(
			isParlumeConfidentialReader({
				projectId: "project-1",
				userId: "attendee-1",
				attendeeUserIds: ["attendee-1"],
			}),
		).resolves.toBe(false);
	});

	it("keeps it from a project reader who was not in the meeting", async () => {
		grants("project:read");
		await expect(
			isParlumeConfidentialReader({
				projectId: "project-1",
				userId: "absent-reader",
				attendeeUserIds: ["attendee-1"],
			}),
		).resolves.toBe(false);
	});

	it("lets a project manager who was absent read it", async () => {
		grants(MANAGE, "project:read");
		await expect(
			isParlumeConfidentialReader({
				projectId: "project-1",
				userId: "manager-1",
				attendeeUserIds: [],
			}),
		).resolves.toBe(true);
	});
});

describe("mayReadParlumeSessionContent", () => {
	it("leaves a meeting that is not confidential to every project reader, asking nothing", async () => {
		await expect(
			mayReadParlumeSessionContent({
				projectId: "project-1",
				userId: "reader",
				session: { confidential: false, attendeeUserIds: [] },
			}),
		).resolves.toBe(true);
		expect(mocks.hasPermission).not.toHaveBeenCalled();
	});
});

describe("withheldConfidentialParlumeSessions", () => {
	it("names the confidential meetings a reader was not in, by session and transcript", async () => {
		mocks.sessionFindMany.mockResolvedValue([
			{ id: "session-1", transcriptContextId: "ctx-1" },
			{ id: "session-2", transcriptContextId: null },
		]);

		const withheld = await withheldConfidentialParlumeSessions({
			projectId: "project-1",
			userId: "absent-reader",
		});

		expect(mocks.sessionFindMany).toHaveBeenCalledWith({
			where: {
				projectId: "project-1",
				confidential: true,
				NOT: { attendeeUserIds: { has: "absent-reader" } },
			},
			select: { id: true, transcriptContextId: true },
		});
		expect([...withheld.sessionIds]).toEqual(["session-1", "session-2"]);
		expect([...withheld.contextIds]).toEqual(["ctx-1"]);
	});

	it("withholds nothing from a project manager", async () => {
		grants(MANAGE);
		mocks.sessionFindMany.mockResolvedValue([
			{ id: "session-1", transcriptContextId: "ctx-1" },
		]);

		const withheld = await withheldConfidentialParlumeSessions({
			projectId: "project-1",
			userId: "manager-1",
		});

		expect(withheld.sessionIds.size).toBe(0);
		expect(withheld.contextIds.size).toBe(0);
	});
});

describe("parlumeTurnAudience", () => {
	it("reads a turn as the confirmed participant who asked, never as the inviter", () => {
		expect(
			parlumeTurnAudience({
				requester: "member-2",
				attendees: ["inviter-1", "member-2"],
				attendeeUserIds: ["inviter-1", "member-2"],
				guests: false,
			}),
		).toEqual({ requesterUserId: "member-2", withConfidential: true });
	});

	it("leaves out the confidential part while a guest is or was expected, though no guest is among the attendees", () => {
		expect(
			parlumeTurnAudience({
				requester: "member-2",
				attendees: ["inviter-1", "member-2"],
				attendeeUserIds: ["inviter-1", "member-2"],
				guests: true,
			}),
		).toEqual({ requesterUserId: "member-2", withConfidential: false });
	});

	it("places no asker the bridge names who Fabric did not confirm in this meeting", () => {
		expect(
			parlumeTurnAudience({
				requester: "someone-else",
				attendees: ["inviter-1", "someone-else"],
				attendeeUserIds: ["inviter-1"],
				guests: false,
			}),
		).toEqual({ requesterUserId: null, withConfidential: false });
	});

	it("places no asker who is not present now, and no asker at all from a bridge that names none", () => {
		expect(
			parlumeTurnAudience({
				requester: "member-2",
				attendees: ["inviter-1"],
				attendeeUserIds: ["inviter-1", "member-2"],
				guests: false,
			}).requesterUserId,
		).toBeNull();
		expect(
			parlumeTurnAudience({
				requester: undefined,
				attendees: [],
				attendeeUserIds: ["inviter-1"],
				guests: false,
			}),
		).toEqual({ requesterUserId: null, withConfidential: false });
	});
});

describe("recordParlumeAttendee", () => {
	it("adds a confirmed participant to the meeting's verified attendees once", async () => {
		await recordParlumeAttendee({
			sessionId: "session-1",
			userId: "member-2",
		});

		expect(mocks.sessionUpdateMany).toHaveBeenCalledWith({
			where: {
				id: "session-1",
				NOT: { attendeeUserIds: { has: "member-2" } },
			},
			data: { attendeeUserIds: { push: "member-2" } },
		});
	});
});

describe("setParlumeConfidentialRange", () => {
	it("starts the confidential part and marks where it starts in the transcript", async () => {
		const result = await setParlumeConfidentialRange({
			session: liveSession(),
			switch: "on",
			by: "Dana Member",
			offsetMs: 42_000,
		});

		expect(result).toEqual({ changed: true, open: true });
		expect(mocks.sessionUpdateMany).toHaveBeenCalledWith({
			where: { id: "session-1", confidentialSince: null },
			data: expect.objectContaining({
				confidential: true,
				confidentialSince: expect.any(Date),
				confidentialBy: "Dana Member",
			}),
		});
		expect(mocks.segmentCreateMany).toHaveBeenCalledWith({
			data: expect.objectContaining({
				source: "EVENT",
				text: "Confidential from here, marked by Dana Member.",
				utteranceStartMs: 42_000,
				confidential: true,
			}),
			skipDuplicates: true,
		});
		expect(mocks.segmentAggregate).not.toHaveBeenCalled();
	});

	it("places a mark with no meeting time after the last thing captured", async () => {
		mocks.segmentAggregate.mockResolvedValue({
			_max: { utteranceStartMs: 95_000 },
		});

		await setParlumeConfidentialRange({
			session: liveSession(),
			switch: "on",
			by: "Dana Member",
			force: true,
		});

		expect(mocks.segmentAggregate).toHaveBeenCalledWith({
			where: { sessionId: "session-1" },
			_max: { utteranceStartMs: true },
		});
		expect(mocks.segmentCreateMany).toHaveBeenCalledWith({
			data: expect.objectContaining({
				utteranceStartMs: 95_000,
				utteranceEndMs: 95_000,
			}),
			skipDuplicates: true,
		});
	});

	it("changes nothing when the part already runs", async () => {
		mocks.sessionUpdateMany.mockResolvedValue({ count: 0 });

		const result = await setParlumeConfidentialRange({
			session: liveSession({ confidentialSince: new Date() }),
			switch: "on",
			by: "Dana Member",
		});

		expect(result).toEqual({ changed: false, open: true });
		expect(mocks.segmentCreateMany).not.toHaveBeenCalled();
	});

	it("ends the part, keeping the meeting confidential", async () => {
		const result = await setParlumeConfidentialRange({
			session: liveSession({ confidentialSince: new Date() }),
			switch: "off",
			by: "Dana Member",
		});

		expect(result).toEqual({ changed: true, open: false });
		expect(mocks.sessionUpdateMany).toHaveBeenCalledWith({
			where: { id: "session-1", confidentialSince: { not: null } },
			data: { confidentialSince: null, confidentialBy: "Dana Member" },
		});
	});

	it("refuses to end it from the meeting while a guest is or was expected there", async () => {
		for (const guest of [
			{ externalInvitees: true },
			{ guestJoinedAt: new Date() },
		]) {
			const result = await setParlumeConfidentialRange({
				session: liveSession({
					confidentialSince: new Date(),
					...guest,
				}),
				switch: "off",
				by: "Visitor",
			});
			expect(result).toEqual({ changed: false, open: true });
		}
		expect(mocks.sessionUpdateMany).not.toHaveBeenCalled();
	});

	it("lets the Parlume page end it whoever was in the meeting", async () => {
		const result = await setParlumeConfidentialRange({
			session: liveSession({
				confidentialSince: new Date(),
				externalInvitees: true,
			}),
			switch: "off",
			by: "Project Manager",
			force: true,
		});

		expect(result).toEqual({ changed: true, open: false });
	});
});

describe("markParlumeSessionConfidential", () => {
	it("marks a finished meeting and every segment of it", async () => {
		await markParlumeSessionConfidential({
			sessionId: "session-1",
			confidential: true,
			by: "Dana Member",
		});

		expect(mocks.sessionUpdate).toHaveBeenCalledWith({
			where: { id: "session-1" },
			data: {
				confidential: true,
				confidentialSince: null,
				confidentialBy: "Dana Member",
			},
		});
		expect(mocks.segmentUpdateMany).toHaveBeenCalledWith({
			where: { sessionId: "session-1" },
			data: { confidential: true },
		});
	});
});

describe("postParlumeConfidentialNotice", () => {
	it("hands the bridge an ordinary chat post, which waits while anyone is unconfirmed", async () => {
		mocks.bridgeSettings.mockReturnValue({
			bridgeUrl: "wss://bridge.example/parlume",
			serviceSecret: "secret",
		});
		mocks.fetch.mockResolvedValue(new Response("{}", { status: 200 }));

		await expect(
			postParlumeConfidentialNotice({
				sessionId: "session-1",
				switch: "on",
				by: "Dana Member",
			}),
		).resolves.toBe(true);

		const [url, init] = mocks.fetch.mock.calls[0] ?? [];
		expect(String(url)).toBe(
			"https://bridge.example/parlume/session-1?action=chat",
		);
		const body = JSON.parse(String(init.body));
		expect(body.final).toBe(false);
		expect(body.message).toContain(
			"**Confidential** · marked by Dana Member",
		);
		expect(body).not.toHaveProperty("essential");
	});

	it("posts nothing without a bridge", async () => {
		mocks.bridgeSettings.mockReturnValue(null);

		await expect(
			postParlumeConfidentialNotice({
				sessionId: "session-1",
				switch: "off",
				by: null,
			}),
		).resolves.toBe(false);
		expect(mocks.fetch).not.toHaveBeenCalled();
	});
});

describe("withoutParlumeNotes", () => {
	it("drops the notes and keeps the rest of the metadata", () => {
		expect(
			withoutParlumeNotes({
				parlumeNotes: "Decided to ship.",
				parlumeNotesStatus: "COMPLETED",
				meetingSubject: "Planning",
			}),
		).toEqual({
			parlumeNotesStatus: "COMPLETED",
			meetingSubject: "Planning",
		});
		expect(withoutParlumeNotes(null)).toBeNull();
	});

	it("drops the anchored notes too", () => {
		expect(
			withoutParlumeNotes({
				parlumeNotes: "### Decisions\n- Ship the draft.",
				parlumeNotesItems: {
					version: 1,
					items: [
						{
							kind: "decision",
							text: "Ship the draft.",
							anchorLine: 2,
						},
					],
				},
				parlumeNotesStatus: "COMPLETED",
			}),
		).toEqual({ parlumeNotesStatus: "COMPLETED" });
	});
});
