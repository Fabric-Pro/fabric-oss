import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	sessionFindMany: vi.fn(),
	hasPermission: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		parlumeMeetingSession: {
			findMany: (...args: unknown[]) => mocks.sessionFindMany(...args),
		},
	},
}));

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
	getParlumeBridgeSettings: vi.fn(),
	bridgeControlUrlForSession: vi.fn(),
}));

vi.mock("../parlume-log", () => ({ parlumeLog: vi.fn() }));

const {
	isParlumeConfidentialReader,
	mayReadParlumeSessionContent,
	parlumeTurnAudience,
	withheldConfidentialParlumeSessions,
} = await import("../parlume-confidential");

const READ = "project:read";
const MANAGE = "project:members:manage";

// What each person may do in the project now, whatever meetings they were in.
const STANDING: Record<string, string[]> = {
	"inviter-a": [READ],
	"member-b": [READ],
	"member-c": [READ],
	"reader-d": [READ],
	"former-e": [],
	"manager-m": [READ, MANAGE],
};

const FIRST_CONFIDENTIAL = {
	id: "session-1",
	transcriptContextId: "ctx-1",
	confidential: true,
	attendeeUserIds: ["inviter-a", "member-b", "former-e"],
};
const SECOND_CONFIDENTIAL = {
	id: "session-2",
	transcriptContextId: "ctx-2",
	confidential: true,
	attendeeUserIds: ["member-c"],
};
const OPEN = {
	id: "session-3",
	transcriptContextId: "ctx-3",
	confidential: false,
	attendeeUserIds: ["inviter-a"],
};
const SESSIONS = [FIRST_CONFIDENTIAL, SECOND_CONFIDENTIAL, OPEN];

beforeEach(() => {
	vi.resetAllMocks();
	mocks.hasPermission.mockImplementation(
		async (input: { userId: string; permission: string }) =>
			STANDING[input.userId]?.includes(input.permission) ?? false,
	);
	mocks.sessionFindMany.mockImplementation(
		async (query: {
			where: {
				confidential: boolean;
				NOT: { attendeeUserIds: { has: string } };
			};
		}) =>
			SESSIONS.filter(
				(session) =>
					session.confidential === query.where.confidential &&
					!session.attendeeUserIds.includes(
						query.where.NOT.attendeeUserIds.has,
					),
			).map(({ id, transcriptContextId }) => ({
				id,
				transcriptContextId,
			})),
	);
});

describe("a meeting of several people", () => {
	it("reads each request as the person who asked, and uses the confidential part only while everyone present is verified", () => {
		const verified = ["inviter-a", "member-b", "member-c"];
		const audience = (requester: string, attendees: string[]) =>
			parlumeTurnAudience({
				requester,
				attendees,
				attendeeUserIds: verified,
				guests: false,
			});
		const room = ["inviter-a", "member-b", "member-c"];
		const withUnverified = [...room, "reader-d"];

		expect(audience("member-b", room)).toEqual({
			requesterUserId: "member-b",
			withConfidential: true,
		});
		expect(audience("member-c", room)).toEqual({
			requesterUserId: "member-c",
			withConfidential: true,
		});
		expect(audience("member-b", withUnverified)).toEqual({
			requesterUserId: "member-b",
			withConfidential: false,
		});
		expect(audience("reader-d", withUnverified)).toEqual({
			requesterUserId: null,
			withConfidential: false,
		});
		expect(audience("member-b", room)).toEqual({
			requesterUserId: "member-b",
			withConfidential: true,
		});
		expect(audience("member-b", ["inviter-a", "member-c"])).toEqual({
			requesterUserId: null,
			withConfidential: true,
		});
	});

	it("lets each person read a confidential meeting's notes, requests and transcript only as one of its readers", async () => {
		const people = Object.keys(STANDING);
		const reads = async (session: typeof OPEN) => {
			const readable: Record<string, boolean> = {};
			for (const userId of people) {
				readable[userId] = await mayReadParlumeSessionContent({
					projectId: "project-1",
					userId,
					session,
				});
			}
			return readable;
		};

		await expect(reads(FIRST_CONFIDENTIAL)).resolves.toEqual({
			"inviter-a": true,
			"member-b": true,
			"member-c": false,
			"reader-d": false,
			"former-e": false,
			"manager-m": true,
		});
		const open = await reads(OPEN);
		for (const reader of [
			"inviter-a",
			"member-b",
			"member-c",
			"reader-d",
		]) {
			expect(open[reader]).toBe(true);
		}
		await expect(
			isParlumeConfidentialReader({
				projectId: "project-1",
				userId: "member-c",
				attendeeUserIds: SECOND_CONFIDENTIAL.attendeeUserIds,
			}),
		).resolves.toBe(true);
	});

	it("withholds each confidential meeting, and its transcript, from every reader who was not in it", async () => {
		const withheld = async (userId: string) => {
			const result = await withheldConfidentialParlumeSessions({
				projectId: "project-1",
				userId,
			});
			return {
				sessionIds: [...result.sessionIds],
				contextIds: [...result.contextIds],
			};
		};

		await expect(withheld("inviter-a")).resolves.toEqual({
			sessionIds: ["session-2"],
			contextIds: ["ctx-2"],
		});
		await expect(withheld("member-c")).resolves.toEqual({
			sessionIds: ["session-1"],
			contextIds: ["ctx-1"],
		});
		await expect(withheld("reader-d")).resolves.toEqual({
			sessionIds: ["session-1", "session-2"],
			contextIds: ["ctx-1", "ctx-2"],
		});
		await expect(withheld("manager-m")).resolves.toEqual({
			sessionIds: [],
			contextIds: [],
		});
	});
});
