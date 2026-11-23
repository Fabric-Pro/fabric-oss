import { ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Caller = {
	user: { id: string; email: string; name: string };
	session: Record<string, never>;
};
type Middleware = (options: {
	context: Caller;
	input: Record<string, unknown>;
}) => void;
type Procedure = {
	middlewares: Middleware[];
	handler: (options: {
		context: Caller;
		input: Record<string, unknown>;
	}) => Promise<unknown>;
};

const { procedures, mocks } = vi.hoisted(() => {
	const procedures: Record<string, Procedure> = {};
	const mocks = {
		permission: vi.fn(),
		requireProject: vi.fn(),
		sessionFindFirst: vi.fn(),
		turnFindFirst: vi.fn(),
		turnCreate: vi.fn(),
		turnUpdate: vi.fn(),
		mayRead: vi.fn(),
		workflowStart: vi.fn(),
		mintGrant: vi.fn(),
		log: vi.fn(),
	};
	return { procedures, mocks };
});

vi.mock("@repo/database", () => ({
	db: {
		parlumeMeetingSession: {
			findFirst: (...args: unknown[]) => mocks.sessionFindFirst(...args),
		},
		parlumeMeetingTurn: {
			findFirst: (...args: unknown[]) => mocks.turnFindFirst(...args),
			create: (...args: unknown[]) => mocks.turnCreate(...args),
			update: (...args: unknown[]) => mocks.turnUpdate(...args),
		},
	},
}));

vi.mock("@repo/temporal/client", () => ({
	getTemporalClient: async () => ({
		workflow: {
			start: (...args: unknown[]) => mocks.workflowStart(...args),
		},
	}),
}));

vi.mock("../../../../../lib/agent-service-auth", () => ({
	mintParlumeActingGrantForTurn: (...args: unknown[]) =>
		mocks.mintGrant(...args),
}));

vi.mock("../../../lib/parlume-confidential", () => ({
	mayReadParlumeSessionContent: (...args: unknown[]) =>
		mocks.mayRead(...args),
}));

vi.mock("../../../lib/parlume-log", () => ({
	parlumeLog: (...args: unknown[]) => mocks.log(...args),
}));

vi.mock("../sessions", () => ({
	requireParlumeProject: (...args: unknown[]) =>
		mocks.requireProject(...args),
}));

// The procedure chain, run as oRPC runs it: each middleware, then the handler.
vi.mock("../../../../../orpc/procedures", () => {
	type State = { middlewares: Middleware[]; path?: string };
	const chain = (state: State): Record<string, unknown> => ({
		use: (middleware: Middleware) =>
			chain({
				...state,
				middlewares: [...state.middlewares, middleware],
			}),
		route: (route: { path: string }) =>
			chain({ ...state, path: route.path }),
		input: () => chain(state),
		handler: (handler: Procedure["handler"]) => {
			procedures[state.path ?? ""] = {
				middlewares: state.middlewares,
				handler,
			};
			return {};
		},
	});
	return {
		tenantProtectedProcedure: chain({ middlewares: [] }),
		Permissions: { PROJECT_UPDATE: "project:update" },
		requireProjectPermission:
			(permission: string): Middleware =>
			({ context, input }) =>
				mocks.permission(permission, context.user.id, input.projectId),
	};
});

await import("../ask");

const PATH = "/projects/{projectId}/parlume/sessions/{sessionId}/ask";

const member: Caller = {
	user: { id: "user-1", email: "member@example.com", name: "Dana Member" },
	session: {},
};
const viewer: Caller = {
	user: { id: "user-9", email: "viewer@example.com", name: "Vic Viewer" },
	session: {},
};

async function ask(text: string, context: Caller = member) {
	const procedure = procedures[PATH];
	if (!procedure) {
		throw new Error("No ask procedure");
	}
	const input = { projectId: "project-1", sessionId: "session-1", text };
	for (const middleware of procedure.middlewares) {
		middleware({ context, input });
	}
	return procedure.handler({ context, input });
}

beforeEach(() => {
	vi.resetAllMocks();
	mocks.permission.mockImplementation(
		(_permission: string, userId: string) => {
			if (userId !== member.user.id) {
				throw new ORPCError("FORBIDDEN");
			}
		},
	);
	mocks.requireProject.mockResolvedValue({
		id: "project-1",
		organizationId: "org-1",
	});
	mocks.sessionFindFirst.mockResolvedValue({
		id: "session-1",
		userId: "inviter",
		voiceGeneration: 3,
		confidential: false,
		attendeeUserIds: [],
	});
	mocks.mayRead.mockResolvedValue(true);
	mocks.turnFindFirst.mockResolvedValue(null);
	mocks.turnCreate.mockResolvedValue({ id: "turn-1" });
	mocks.mintGrant.mockReturnValue("grant-for-asker");
	mocks.workflowStart.mockResolvedValue({});
});

describe("Parlume page questions", () => {
	it("starts a page turn that reads as the member who asked, and never takes the voice's turn", async () => {
		await expect(
			ask("What did we decide about the release?"),
		).resolves.toEqual({ turnId: "turn-1" });

		expect(mocks.permission).toHaveBeenCalledWith(
			"project:update",
			"user-1",
			"project-1",
		);
		expect(mocks.sessionFindFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					id: "session-1",
					projectId: "project-1",
					organizationId: "org-1",
					status: "ACTIVE",
				},
			}),
		);
		expect(mocks.turnCreate).toHaveBeenCalledWith({
			data: {
				sessionId: "session-1",
				projectId: "project-1",
				organizationId: "org-1",
				userId: "inviter",
				requesterUserId: "user-1",
				dedupeKey: expect.stringMatching(/^page:/),
				requestText: "What did we decide about the release?",
				speakerName: "Dana Member",
				speakerId: null,
				voiceGeneration: 3,
				replyChannel: "PAGE",
			},
			select: { id: true },
		});
		expect(mocks.mintGrant).toHaveBeenCalledWith({
			userId: "user-1",
			organizationId: "org-1",
			projectId: "project-1",
		});
		expect(mocks.workflowStart).toHaveBeenCalledWith(
			"parlumeMeetingTurnWorkflow",
			expect.objectContaining({
				taskQueue: "fabric-worker",
				workflowId: "parlume-turn-turn-1",
				args: [
					{
						turnId: "turn-1",
						jobType: "parlume-live-turn",
						actingGrant: "grant-for-asker",
						withConfidential: true,
					},
				],
			}),
		);
	});

	it("refuses a project reader who is not a member, and starts nothing", async () => {
		await expect(ask("Status?", viewer)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		expect(mocks.turnCreate).not.toHaveBeenCalled();
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});

	it("refuses when Parlume is not in the meeting", async () => {
		mocks.sessionFindFirst.mockResolvedValue(null);

		await expect(ask("Status?")).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		expect(mocks.turnCreate).not.toHaveBeenCalled();
	});

	it("refuses a member who may not read a confidential meeting", async () => {
		mocks.sessionFindFirst.mockResolvedValue({
			id: "session-1",
			userId: "inviter",
			voiceGeneration: 0,
			confidential: true,
			attendeeUserIds: ["someone-else"],
		});
		mocks.mayRead.mockResolvedValue(false);

		await expect(ask("Status?")).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		expect(mocks.turnCreate).not.toHaveBeenCalled();
	});

	it.each(["Off the record", "Parlume, end confidential"])(
		"points the confidential command %j to the page control instead of answering it",
		async (text) => {
			await expect(ask(text)).rejects.toMatchObject({
				code: "BAD_REQUEST",
			});
			expect(mocks.turnCreate).not.toHaveBeenCalled();
		},
	);

	it("takes one question at a time from each member", async () => {
		mocks.turnFindFirst.mockResolvedValue({ id: "turn-0" });

		await expect(ask("And the budget?")).rejects.toMatchObject({
			code: "CONFLICT",
		});
		expect(mocks.turnFindFirst).toHaveBeenCalledWith({
			where: {
				sessionId: "session-1",
				replyChannel: "PAGE",
				requesterUserId: "user-1",
				status: { in: ["PENDING", "RUNNING"] },
				createdAt: { gte: expect.any(Date) },
			},
			select: { id: true },
		});
		expect(mocks.turnCreate).not.toHaveBeenCalled();
	});

	it("marks the turn failed when the worker cannot be reached", async () => {
		mocks.workflowStart.mockRejectedValue(new Error("temporal down"));

		await expect(ask("Status?")).rejects.toMatchObject({
			code: "INTERNAL_SERVER_ERROR",
		});
		expect(mocks.turnUpdate).toHaveBeenCalledWith({
			where: { id: "turn-1" },
			data: {
				status: "FAILED",
				error: "Parlume turn dispatch failed.",
				completedAt: expect.any(Date),
			},
		});
	});
});
