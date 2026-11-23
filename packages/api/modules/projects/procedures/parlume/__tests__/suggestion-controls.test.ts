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
		suggestionFindFirst: vi.fn(),
		suggestionUpdateMany: vi.fn(),
		mayRead: vi.fn(),
		getSettings: vi.fn(),
		readAloud: vi.fn(),
		recordAudit: vi.fn(),
		log: vi.fn(),
	};
	return { procedures, mocks };
});

vi.mock("@repo/database", () => ({
	db: {
		parlumeSuggestion: {
			findFirst: (...args: unknown[]) =>
				mocks.suggestionFindFirst(...args),
			updateMany: (...args: unknown[]) =>
				mocks.suggestionUpdateMany(...args),
			findMany: vi.fn(),
		},
		parlumeMeetingSession: { findFirst: vi.fn() },
	},
}));

vi.mock("../../../../../lib/audit", () => ({
	recordAuditFromRequest: (...args: unknown[]) => mocks.recordAudit(...args),
}));

vi.mock("../../../lib/parlume-attendee", () => ({
	getParlumeBridgeSettings: () => mocks.getSettings(),
}));

vi.mock("../../../lib/parlume-page-controls", () => ({
	sendParlumeReadAloud: (...args: unknown[]) => mocks.readAloud(...args),
}));

vi.mock("../../../lib/parlume-confidential", () => ({
	mayReadParlumeSessionContent: (...args: unknown[]) =>
		mocks.mayRead(...args),
}));

vi.mock("../../../lib/parlume-transcript-access", () => ({
	canReadParlumeTranscript: vi.fn(),
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
		Permissions: {
			PROJECT_READ: "project:read",
			PROJECT_UPDATE: "project:update",
		},
		requireProjectPermission:
			(permission: string): Middleware =>
			({ context, input }) =>
				mocks.permission(permission, context.user.id, input.projectId),
	};
});

await import("../suggestions");

const member: Caller = {
	user: { id: "user-1", email: "member@example.com", name: "Dana Member" },
	session: {},
};
const viewer: Caller = {
	user: { id: "user-9", email: "viewer@example.com", name: "Vic Viewer" },
	session: {},
};
const input = {
	projectId: "project-1",
	sessionId: "session-1",
	suggestionId: "suggestion-1",
};
const settings = { bridgeUrl: "wss://bridge.example", serviceSecret: "s" };

const PATHS = {
	say: "/projects/{projectId}/parlume/sessions/{sessionId}/suggestions/{suggestionId}/say",
	dismiss:
		"/projects/{projectId}/parlume/sessions/{sessionId}/suggestions/{suggestionId}/dismiss",
} as const;

async function call(control: keyof typeof PATHS, context: Caller = member) {
	const procedure = procedures[PATHS[control]];
	if (!procedure) {
		throw new Error(`No procedure for ${control}`);
	}
	for (const middleware of procedure.middlewares) {
		middleware({ context, input });
	}
	return procedure.handler({ context, input });
}

function suggestion(
	overrides: { kind?: string; session?: Record<string, unknown> } = {},
) {
	return {
		id: "suggestion-1",
		kind: overrides.kind ?? "ANSWER",
		text: "The release is planned for Thursday.",
		session: {
			id: "session-1",
			status: "ACTIVE",
			confidential: false,
			attendeeUserIds: [],
			externalInvitees: false,
			guestJoinedAt: null,
			...overrides.session,
		},
	};
}

beforeEach(() => {
	vi.resetAllMocks();
	// Only a member holds project:update; a viewer reads the project.
	mocks.permission.mockImplementation(
		(permission: string, userId: string) => {
			if (permission === "project:update" && userId !== member.user.id) {
				throw new ORPCError("FORBIDDEN");
			}
		},
	);
	mocks.requireProject.mockResolvedValue({
		id: "project-1",
		organizationId: "org-1",
	});
	mocks.suggestionFindFirst.mockResolvedValue(suggestion());
	mocks.suggestionUpdateMany.mockResolvedValue({ count: 1 });
	mocks.mayRead.mockResolvedValue(true);
	mocks.getSettings.mockReturnValue(settings);
	mocks.readAloud.mockResolvedValue({ spoken: true });
});

describe("Parlume suggestion buttons", () => {
	it.each(["say", "dismiss"] as const)(
		"refuses %s to a project reader who is not a member, before anything is read or said",
		async (control) => {
			await expect(call(control, viewer)).rejects.toMatchObject({
				code: "FORBIDDEN",
			});
			expect(mocks.permission).toHaveBeenCalledWith(
				"project:update",
				"user-9",
				"project-1",
			);
			expect(mocks.suggestionFindFirst).not.toHaveBeenCalled();
			expect(mocks.readAloud).not.toHaveBeenCalled();
			expect(mocks.suggestionUpdateMany).not.toHaveBeenCalled();
			expect(mocks.recordAudit).not.toHaveBeenCalled();
		},
	);

	it("has the bridge say a member's chosen suggestion, named in the audit log", async () => {
		await expect(call("say")).resolves.toEqual({ spoken: true });

		expect(mocks.suggestionFindFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					id: "suggestion-1",
					sessionId: "session-1",
					projectId: "project-1",
					organizationId: "org-1",
					dismissedAt: null,
				},
			}),
		);
		expect(mocks.readAloud).toHaveBeenCalledWith({
			settings,
			sessionId: "session-1",
			suggestionId: "suggestion-1",
			text: "The release is planned for Thursday.",
			actor: { id: "user-1", name: "Dana Member" },
		});
		expect(mocks.recordAudit).toHaveBeenCalledWith(member, {
			action: "project.parlume.suggestion_spoken",
			category: "project",
			organizationId: "org-1",
			projectId: "project-1",
			resource: { type: "parlume_suggestion", id: "suggestion-1" },
			metadata: { sessionId: "session-1" },
		});
	});

	it.each([
		["an invited guest", { externalInvitees: true }],
		["a guest who joined", { guestJoinedAt: new Date() }],
	])(
		"says nothing from the page while %s is in the meeting",
		async (_label, session) => {
			mocks.suggestionFindFirst.mockResolvedValue(
				suggestion({ session }),
			);

			await expect(call("say")).rejects.toMatchObject({
				code: "CONFLICT",
			});
			expect(mocks.readAloud).not.toHaveBeenCalled();
		},
	);

	it("does not say the recap, only an answer or a missed question", async () => {
		mocks.suggestionFindFirst.mockResolvedValue(
			suggestion({ kind: "RECAP" }),
		);

		await expect(call("say")).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
		expect(mocks.readAloud).not.toHaveBeenCalled();
	});

	it("does not say anything once Parlume has left the meeting", async () => {
		mocks.suggestionFindFirst.mockResolvedValue(
			suggestion({ session: { status: "COMPLETED" } }),
		);

		await expect(call("say")).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.readAloud).not.toHaveBeenCalled();
	});

	it("says the bridge did not answer, and records nothing, when it fails", async () => {
		mocks.readAloud.mockRejectedValue(new Error("bridge down"));

		await expect(call("say")).rejects.toMatchObject({
			code: "INTERNAL_SERVER_ERROR",
			message: "Parlume's media bridge did not answer. Try again.",
		});
		expect(mocks.recordAudit).not.toHaveBeenCalled();
	});

	it("records nothing when the bridge held the suggestion back", async () => {
		mocks.readAloud.mockResolvedValue({ spoken: false });

		await expect(call("say")).resolves.toEqual({ spoken: false });
		expect(mocks.recordAudit).not.toHaveBeenCalled();
	});

	it("dismisses a suggestion for every reader, by the member who pressed it", async () => {
		await expect(call("dismiss")).resolves.toEqual({ dismissed: true });

		expect(mocks.suggestionUpdateMany).toHaveBeenCalledWith({
			where: { id: "suggestion-1", dismissedAt: null },
			data: { dismissedAt: expect.any(Date), dismissedById: "user-1" },
		});
		expect(mocks.recordAudit).toHaveBeenCalledWith(member, {
			action: "project.parlume.suggestion_dismissed",
			category: "project",
			organizationId: "org-1",
			projectId: "project-1",
			resource: { type: "parlume_suggestion", id: "suggestion-1" },
			metadata: { sessionId: "session-1" },
		});
	});

	it.each(["say", "dismiss"] as const)(
		"treats a suggestion of a confidential meeting the member was not in as not there, for %s",
		async (control) => {
			mocks.suggestionFindFirst.mockResolvedValue(
				suggestion({
					session: { confidential: true, attendeeUserIds: ["other"] },
				}),
			);
			mocks.mayRead.mockResolvedValue(false);

			await expect(call(control)).rejects.toMatchObject({
				code: "NOT_FOUND",
			});
			expect(mocks.readAloud).not.toHaveBeenCalled();
			expect(mocks.suggestionUpdateMany).not.toHaveBeenCalled();
		},
	);

	it("refuses a suggestion that is already dismissed or not in this session", async () => {
		mocks.suggestionFindFirst.mockResolvedValue(null);

		await expect(call("dismiss")).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		expect(mocks.suggestionUpdateMany).not.toHaveBeenCalled();
	});
});
