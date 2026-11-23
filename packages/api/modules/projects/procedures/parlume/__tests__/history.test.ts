import { beforeEach, describe, expect, it, vi } from "vitest";

type HistoryInput = {
	projectId: string;
	sessionId?: string;
	before?: { id: string; createdAt: Date };
};
type HistoryArgs = { input: HistoryInput; context: { user: { id: string } } };
const mocks = vi.hoisted(() => ({
	project: vi.fn(),
	turns: vi.fn(),
	turnCount: vi.fn(),
	permission: vi.fn(),
	withheld: vi.fn(),
	handler: undefined as ((args: HistoryArgs) => Promise<unknown>) | undefined,
}));
vi.mock("@repo/database", () => ({
	db: {
		parlumeMeetingTurn: { findMany: mocks.turns, count: mocks.turnCount },
	},
}));
vi.mock("../sessions", () => ({ requireParlumeProject: mocks.project }));
vi.mock("../../../lib/parlume-confidential", () => ({
	withheldConfidentialParlumeSessions: mocks.withheld,
}));
vi.mock("../../../../../orpc/procedures", () => {
	const chain = {
		use: () => chain,
		route: () => chain,
		input: () => chain,
		handler: (handler: NonNullable<typeof mocks.handler>) => {
			mocks.handler = handler;
			return handler;
		},
	};
	return {
		tenantProtectedProcedure: chain,
		requireProjectPermission: mocks.permission,
		Permissions: { PROJECT_READ: "project:read" },
	};
});
await import("../history");

const history = (input: HistoryInput, userId = "reader") =>
	mocks.handler?.({ input, context: { user: { id: userId } } });

// A request as the database returns it, with its session's speaker marks.
function storedTurn(overrides: Record<string, unknown> = {}) {
	return {
		id: "turn",
		createdAt: new Date("2026-09-30T12:00:00Z"),
		speakerId: "8:orgid:member",
		speakerName: "Dev One",
		requesterUserId: null as string | null,
		session: {
			agentLabel: "Fabric Agent",
			toolsReadOnly: true,
			memberSpeakerIds: ["8:orgid:member"],
			guestSpeakerIds: ["8:orgid:outside"],
		},
		actions: [] as unknown[],
		...overrides,
	};
}

// The same request as the page receives it: marked, without the Teams ids.
function listedTurn(row: ReturnType<typeof storedTurn>, mark = "member") {
	const { requesterUserId: _asker, session, ...turn } = row;
	return {
		...turn,
		session: {
			agentLabel: session.agentLabel,
			toolsReadOnly: session.toolsReadOnly,
		},
		speakerMark: mark,
	};
}

beforeEach(() => {
	mocks.project
		.mockReset()
		.mockResolvedValue({ id: "project", organizationId: "org" });
	mocks.turns.mockReset().mockResolvedValue([]);
	mocks.turnCount.mockReset().mockResolvedValue(0);
	mocks.withheld.mockReset().mockResolvedValue({
		sessionIds: new Set(),
		contextIds: new Set(),
	});
});

describe("Parlume project history", () => {
	it("requires project read permission and scopes every page to the authorized project and tenant", async () => {
		expect(mocks.permission).toHaveBeenCalledWith("project:read");
		await history({ projectId: "project", sessionId: "other-session" });
		expect(mocks.project).toHaveBeenCalledWith("project");
		expect(mocks.turns).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					projectId: "project",
					organizationId: "org",
					sessionId: "other-session",
				},
				take: 31,
			}),
		);
	});
	it("refuses history when the project or feature is unavailable", async () => {
		mocks.project.mockRejectedValueOnce(new Error("Not found"));
		await expect(history({ projectId: "other" })).rejects.toThrow(
			"Not found",
		);
		expect(mocks.turns).not.toHaveBeenCalled();
	});
	it("uses a stable timestamp and id cursor without dropping equal-time requests", async () => {
		const createdAt = new Date("2026-09-30T12:00:00Z");
		const rows = Array.from({ length: 31 }, (_, index) =>
			storedTurn({ id: `turn-${index}`, createdAt }),
		);
		mocks.turns.mockResolvedValue(rows);
		const response = await history({
			projectId: "project",
			before: { id: "prior", createdAt },
		});
		expect(response).toEqual({
			items: rows.slice(0, 30).map((row) => listedTurn(row)),
			total: null,
			nextCursor: { id: "turn-29", createdAt },
		});
		expect(mocks.turnCount).not.toHaveBeenCalled();
		expect(mocks.turns).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					OR: [
						{ createdAt: { lt: createdAt } },
						{ createdAt, id: { lt: "prior" } },
					],
				}),
				orderBy: [{ createdAt: "desc" }, { id: "desc" }],
			}),
		);
	});
	it("counts the project's requests on the first page whatever session is viewed", async () => {
		mocks.turnCount.mockResolvedValue(42);
		const response = await history({
			projectId: "project",
			sessionId: "other-session",
		});
		expect(response).toMatchObject({ total: 42 });
		expect(mocks.turnCount).toHaveBeenCalledWith({
			where: { projectId: "project", organizationId: "org" },
		});
	});
	it("leaves out the requests of a confidential meeting the reader was not in, from the list and the count", async () => {
		mocks.withheld.mockResolvedValue({
			sessionIds: new Set(["confidential-session"]),
			contextIds: new Set(),
		});
		await history({ projectId: "project" }, "absent-member");
		expect(mocks.withheld).toHaveBeenCalledWith({
			projectId: "project",
			userId: "absent-member",
		});
		const scope = {
			projectId: "project",
			organizationId: "org",
			sessionId: { notIn: ["confidential-session"] },
		};
		expect(mocks.turns).toHaveBeenCalledWith(
			expect.objectContaining({ where: scope }),
		);
		expect(mocks.turnCount).toHaveBeenCalledWith({ where: scope });
	});
	it("shows nothing of a confidential meeting the reader asks for by id", async () => {
		mocks.withheld.mockResolvedValue({
			sessionIds: new Set(["confidential-session"]),
			contextIds: new Set(),
		});
		await history({
			projectId: "project",
			sessionId: "confidential-session",
		});
		expect(mocks.turns).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ sessionId: { in: [] } }),
			}),
		);
	});
	it("marks each asker a member, a guest or unknown, and sends the page no Teams ids or asker account", async () => {
		const member = storedTurn({ id: "member" });
		const outside = storedTurn({
			id: "outside",
			speakerId: "8:orgid:outside",
			speakerName: "Pat",
		});
		const visitor = storedTurn({
			id: "visitor",
			speakerId: "8:teamsvisitor:guest-1",
			speakerName: "Visitor",
		});
		const unchecked = storedTurn({
			id: "unchecked",
			speakerId: "8:orgid:unchecked",
			speakerName: "Sam",
		});
		const unlabelled = storedTurn({
			id: "unlabelled",
			speakerId: null,
			speakerName: null,
		});
		// A realtime request names no speaker, only its confirmed asker.
		const realtime = storedTurn({
			id: "realtime",
			speakerId: null,
			speakerName: null,
			requesterUserId: "user-2",
		});
		mocks.turns.mockResolvedValue([
			member,
			outside,
			visitor,
			unchecked,
			unlabelled,
			realtime,
		]);

		const response = await history({ projectId: "project" });

		expect(response).toMatchObject({
			items: [
				listedTurn(member),
				listedTurn(outside, "guest"),
				listedTurn(visitor, "guest"),
				listedTurn(unchecked, "unknown"),
				listedTurn(unlabelled, "unknown"),
				listedTurn(realtime),
			],
		});
		expect(JSON.stringify(response)).not.toContain("guestSpeakerIds");
		expect(JSON.stringify(response)).not.toContain("user-2");
	});

	it("shows a proposal past its 24 hours as expired", async () => {
		const createdAt = new Date();
		mocks.turns.mockResolvedValue([
			storedTurn({
				id: "turn",
				createdAt,
				actions: [
					{
						id: "open",
						status: "PROPOSED",
						expiresAt: new Date(Date.now() + 60_000),
					},
					{
						id: "late",
						status: "PROPOSED",
						expiresAt: new Date(Date.now() - 60_000),
					},
				],
			}),
		]);
		const response = await history({ projectId: "project" });
		expect(response).toMatchObject({
			items: [
				{
					actions: [
						{ id: "open", status: "PROPOSED" },
						{ id: "late", status: "EXPIRED" },
					],
				},
			],
		});
	});
});
