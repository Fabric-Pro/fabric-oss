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
		sessionFindUniqueOrThrow: vi.fn(),
		getSettings: vi.fn(),
		sendControl: vi.fn(),
		recordAudit: vi.fn(),
		log: vi.fn(),
	};
	return { procedures, mocks };
});

vi.mock("@repo/database", () => ({
	db: {
		parlumeMeetingSession: {
			findFirst: (...args: unknown[]) => mocks.sessionFindFirst(...args),
			findUniqueOrThrow: (...args: unknown[]) =>
				mocks.sessionFindUniqueOrThrow(...args),
		},
	},
}));

vi.mock("../../../../../lib/audit", () => ({
	recordAuditFromRequest: (...args: unknown[]) => mocks.recordAudit(...args),
}));

vi.mock("../../../lib/parlume-attendee", () => ({
	getParlumeBridgeSettings: () => mocks.getSettings(),
	sendParlumeLiveControl: (...args: unknown[]) => mocks.sendControl(...args),
}));

vi.mock("../../../lib/parlume-log", () => ({
	parlumeLog: (...args: unknown[]) => mocks.log(...args),
}));

vi.mock("../../../lib/parlume-start", () => ({
	sessionSelect: { id: true, pausedAt: true, pausedBy: true },
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
		Permissions: { PROJECT_READ: "project:read" },
		requireProjectPermission:
			(permission: string): Middleware =>
			({ context, input }) =>
				mocks.permission(permission, context.user.id, input.projectId),
	};
});

await import("../live-controls");

const member: Caller = {
	user: { id: "user-1", email: "member@example.com", name: "Dana Member" },
	session: {},
};
const outsider: Caller = {
	user: { id: "user-9", email: "outsider@example.com", name: "Out Sider" },
	session: {},
};
const input = { projectId: "project-1", sessionId: "session-1" };
const settings = { bridgeUrl: "https://bridge.example", serviceSecret: "s" };

const PATHS = {
	"stop-speech":
		"/projects/{projectId}/parlume/sessions/{sessionId}/stop-speech",
	pause: "/projects/{projectId}/parlume/sessions/{sessionId}/pause",
	resume: "/projects/{projectId}/parlume/sessions/{sessionId}/resume",
	"continue-reading":
		"/projects/{projectId}/parlume/sessions/{sessionId}/continue-reading",
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

beforeEach(() => {
	vi.resetAllMocks();
	mocks.permission.mockImplementation((_permission, userId: string) => {
		if (userId !== member.user.id) {
			throw new ORPCError("FORBIDDEN");
		}
	});
	mocks.requireProject.mockResolvedValue({
		id: "project-1",
		organizationId: "org-1",
	});
	mocks.sessionFindFirst.mockResolvedValue({ id: "session-1" });
	mocks.sessionFindUniqueOrThrow.mockResolvedValue({
		id: "session-1",
		pausedAt: null,
		pausedBy: null,
	});
	mocks.getSettings.mockReturnValue(settings);
	mocks.sendControl.mockResolvedValue({ changed: true });
});

describe("Parlume live controls", () => {
	it.each([
		["stop-speech", "project.parlume.speech_stopped"],
		["pause", "project.parlume.listening_paused"],
		["resume", "project.parlume.listening_resumed"],
		["continue-reading", "project.parlume.reading_continued"],
	] as const)(
		"a project reader can use %s on Parlume in a live meeting, named in the bridge and the audit log",
		async (control, action) => {
			const result = await call(control);

			expect(mocks.permission).toHaveBeenCalledWith(
				"project:read",
				"user-1",
				"project-1",
			);
			expect(mocks.sessionFindFirst).toHaveBeenCalledWith({
				where: {
					id: "session-1",
					projectId: "project-1",
					status: "ACTIVE",
				},
				select: { id: true },
			});
			expect(mocks.sendControl).toHaveBeenCalledWith({
				settings,
				sessionId: "session-1",
				control,
				actor: { id: "user-1", name: "Dana Member" },
			});
			expect(mocks.recordAudit).toHaveBeenCalledWith(member, {
				action,
				category: "project",
				organizationId: "org-1",
				projectId: "project-1",
				resource: { type: "parlume_meeting_session", id: "session-1" },
			});
			expect(result).toEqual({
				changed: true,
				session: { id: "session-1", pausedAt: null, pausedBy: null },
			});
		},
	);

	it.each(["stop-speech", "pause", "resume", "continue-reading"] as const)(
		"someone who cannot read the project gets FORBIDDEN for %s, and the bridge is never called",
		async (control) => {
			await expect(call(control, outsider)).rejects.toMatchObject({
				code: "FORBIDDEN",
			});
			expect(mocks.sendControl).not.toHaveBeenCalled();
			expect(mocks.recordAudit).not.toHaveBeenCalled();
		},
	);

	it("refuses a session of another project, or one Parlume is no longer in", async () => {
		mocks.sessionFindFirst.mockResolvedValue(null);

		await expect(call("pause")).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		expect(mocks.sendControl).not.toHaveBeenCalled();
	});

	it("says the bridge did not answer, and records nothing, when the control fails", async () => {
		mocks.sendControl.mockRejectedValue(new Error("bridge down"));

		await expect(call("stop-speech")).rejects.toMatchObject({
			code: "INTERNAL_SERVER_ERROR",
			message: "Parlume's media bridge did not answer. Try again.",
		});
		expect(mocks.recordAudit).not.toHaveBeenCalled();
	});

	it("reports no change when there was nothing to stop", async () => {
		mocks.sendControl.mockResolvedValue({ changed: false });

		const result = await call("stop-speech");

		expect(result).toMatchObject({ changed: false });
	});
});
