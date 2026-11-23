import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	integration: vi.fn(),
	ownIntegration: vi.fn(),
	connection: vi.fn(),
	graph: vi.fn(),
	userFindFirst: vi.fn(),
	mayRead: vi.fn(),
	log: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		user: {
			findFirst: (...args: unknown[]) => mocks.userFindFirst(...args),
		},
		workflowIntegration: {
			findUnique: (...args: unknown[]) => mocks.connection(...args),
		},
	},
	resolveWorkflowIntegrationForProvider: (...args: unknown[]) =>
		mocks.integration(...args),
	resolveOwnWorkflowIntegrationForProvider: (...args: unknown[]) =>
		mocks.ownIntegration(...args),
}));

// Only the two pure helpers are real; loading the whole Microsoft module
// would pull in AI and payments setup that this test does not need.
vi.mock("@repo/integrations/microsoft", async () => ({
	isShortTeamsMeetingUrl: (
		await import(
			"../../../../../integrations/src/microsoft/parlume-channel"
		)
	).isShortTeamsMeetingUrl,
	extractChannelThreadId: (
		await import(
			"../../../../../integrations/src/microsoft/stream-transcript"
		)
	).extractChannelThreadId,
	executeMicrosoftTeamsTool: (...args: unknown[]) => mocks.graph(...args),
}));

vi.mock("../parlume-attendee-standing", () => ({
	mayReadParlumeProject: (...args: unknown[]) => mocks.mayRead(...args),
}));

vi.mock("../parlume-log", () => ({
	parlumeLog: (...args: unknown[]) => mocks.log(...args),
}));

const { confirmParlumeAttendee, isParlumeChannelMeeting } = await import(
	"../parlume-attendee-access"
);

const session = {
	projectId: "project-1",
	organizationId: "org-1",
	userId: "inviter-1",
};
const objectId = "00000000-0000-4000-8000-000000000001";
const inviterObjectId = "00000000-0000-4000-8000-0000000000aa";
const signedIn = {
	id: `8:orgid:${objectId}`,
	userId: null,
	name: "Dev One",
};

beforeEach(() => {
	vi.resetAllMocks();
	mocks.integration.mockResolvedValue({ id: "integration-1" });
	mocks.ownIntegration.mockResolvedValue({ id: "integration-1" });
	mocks.connection.mockResolvedValue({
		settings: { oderId: inviterObjectId, login: "dev@example.com" },
	});
	mocks.graph.mockResolvedValue({ emails: ["dev@example.com"] });
	mocks.userFindFirst.mockResolvedValue({ id: "user-2" });
	mocks.mayRead.mockResolvedValue(true);
});

describe("confirmParlumeAttendee", () => {
	it("confirms a signed-in participant through the inviter's Teams connection and project read", async () => {
		await expect(
			confirmParlumeAttendee({ session, participant: signedIn }),
		).resolves.toBe("user-2");
		expect(mocks.integration).toHaveBeenCalledWith(
			"MICROSOFT_GRAPH",
			"inviter-1",
			"org-1",
		);
		expect(mocks.graph).toHaveBeenCalledWith(
			"parlume_channel",
			{ kind: "user", userId: objectId },
			"inviter-1",
			"org-1",
			"integration-1",
		);
		expect(mocks.userFindFirst).toHaveBeenCalledWith({
			where: {
				emailVerified: true,
				OR: [
					{
						email: {
							equals: "dev@example.com",
							mode: "insensitive",
						},
					},
				],
			},
			select: { id: true },
		});
		expect(mocks.mayRead).toHaveBeenCalledWith({
			userId: "user-2",
			projectId: "project-1",
		});
	});

	it("reads the object id from Attendee's user id when the participant id is not one", async () => {
		await confirmParlumeAttendee({
			session,
			participant: {
				id: "participant-7",
				userId: `8:orgid:${objectId}`,
				name: "Dev One",
			},
		});

		expect(mocks.graph).toHaveBeenCalledWith(
			"parlume_channel",
			{ kind: "user", userId: objectId },
			"inviter-1",
			"org-1",
			"integration-1",
		);
	});

	// An expired Teams token must not make Parlume refuse its own inviter.
	it("knows the inviter by their own Teams connection, without a Graph call, and still checks project read", async () => {
		mocks.graph.mockRejectedValue(new Error("token expired"));

		await expect(
			confirmParlumeAttendee({
				session,
				participant: {
					id: `8:orgid:${inviterObjectId.toUpperCase()}`,
					userId: null,
					name: "Dev One",
				},
			}),
		).resolves.toBe("inviter-1");
		expect(mocks.ownIntegration).toHaveBeenCalledWith(
			"MICROSOFT_GRAPH",
			"inviter-1",
			"org-1",
		);
		expect(mocks.connection).toHaveBeenCalledWith({
			where: { id: "integration-1" },
			select: { settings: true },
		});
		expect(mocks.graph).not.toHaveBeenCalled();
		expect(mocks.mayRead).toHaveBeenCalledWith({
			userId: "inviter-1",
			projectId: "project-1",
		});
	});

	it("looks the participant up when the inviter has no own connection on record", async () => {
		mocks.ownIntegration.mockResolvedValue(null);

		await expect(
			confirmParlumeAttendee({ session, participant: signedIn }),
		).resolves.toBe("user-2");
		expect(mocks.connection).not.toHaveBeenCalled();
		expect(mocks.graph).toHaveBeenCalled();
	});

	it("refuses a Fabric user without project read", async () => {
		mocks.mayRead.mockResolvedValue(false);

		await expect(
			confirmParlumeAttendee({ session, participant: signedIn }),
		).resolves.toBeNull();
	});

	it.each([
		[
			"an anonymous participant",
			{ id: "8:teamsvisitor:guest-1", userId: null, name: "Visitor" },
		],
		[
			"a participant Teams labels as a guest",
			{ id: `8:orgid:${objectId}`, userId: null, name: "Sam (Guest)" },
		],
		[
			"a participant without an object id",
			{ id: "participant-7", userId: null, name: "Dev One" },
		],
	])("refuses %s without a lookup", async (_, participant) => {
		await expect(
			confirmParlumeAttendee({ session, participant }),
		).resolves.toBeNull();
		expect(mocks.graph).not.toHaveBeenCalled();
	});

	it("refuses when the inviter has no Teams connection", async () => {
		mocks.integration.mockResolvedValue(null);

		await expect(
			confirmParlumeAttendee({ session, participant: signedIn }),
		).resolves.toBeNull();
		expect(mocks.graph).not.toHaveBeenCalled();
	});

	it("refuses someone who is no Fabric user with a verified address", async () => {
		mocks.userFindFirst.mockResolvedValue(null);

		await expect(
			confirmParlumeAttendee({ session, participant: signedIn }),
		).resolves.toBeNull();

		mocks.graph.mockResolvedValue({ emails: [] });
		await expect(
			confirmParlumeAttendee({ session, participant: signedIn }),
		).resolves.toBeNull();
		expect(mocks.mayRead).not.toHaveBeenCalled();
	});

	it("fails closed when the lookup fails, and logs no address", async () => {
		mocks.graph.mockRejectedValue(
			new Error("Microsoft user lookup failed (HTTP 404)."),
		);

		await expect(
			confirmParlumeAttendee({ session, participant: signedIn }),
		).resolves.toBeNull();
		expect(mocks.log).toHaveBeenCalledWith(
			"warn",
			"attendee.lookup_failed",
			{ error: "Microsoft user lookup failed (HTTP 404)." },
		);
	});
});

describe("isParlumeChannelMeeting", () => {
	const ordinary = {
		meetingUrl:
			"https://teams.microsoft.com/l/meetup-join/19%3Ameeting_example%40thread.v2/0",
		channelId: null,
		channelRootMessageId: null,
		channelChatStatus: "ATTENDEE",
	};

	it("counts a channel thread, a bound channel and an unresolved short link", () => {
		expect(isParlumeChannelMeeting(ordinary)).toBe(false);
		expect(
			isParlumeChannelMeeting({
				...ordinary,
				meetingUrl:
					"https://teams.microsoft.com/l/meetup-join/19%3Aexample%40thread.tacv2/1700000000000",
				channelChatStatus: "PENDING",
			}),
		).toBe(true);
		expect(
			isParlumeChannelMeeting({
				...ordinary,
				channelId: "19:example@thread.tacv2",
			}),
		).toBe(true);
		expect(
			isParlumeChannelMeeting({
				...ordinary,
				meetingUrl: "https://teams.microsoft.com/meet/1234567890123",
				channelChatStatus: "UNRESOLVED",
			}),
		).toBe(true);
		expect(
			isParlumeChannelMeeting({
				...ordinary,
				meetingUrl: "https://teams.microsoft.com/meet/1234567890123",
			}),
		).toBe(false);
	});
});
