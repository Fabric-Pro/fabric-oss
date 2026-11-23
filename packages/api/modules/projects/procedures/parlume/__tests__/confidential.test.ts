import { ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Caller = {
	user: { id: string; email: string; name: string };
	session: Record<string, never>;
};
type Handler = (options: {
	context: Caller;
	input: Record<string, unknown>;
}) => Promise<unknown>;

const { procedures, mocks } = vi.hoisted(() => {
	const procedures: Record<string, Handler> = {};
	const mocks = {
		requireProject: vi.fn(),
		sessionFindFirst: vi.fn(),
		sessionFindUniqueOrThrow: vi.fn(),
		manages: vi.fn(),
		setRange: vi.fn(),
		markSession: vi.fn(),
		postNotice: vi.fn(),
		recordAudit: vi.fn(),
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

vi.mock("../../../lib/parlume-confidential", () => ({
	confidentialRangeSelect: { id: true, confidentialSince: true },
	setParlumeConfidentialRange: (...args: unknown[]) =>
		mocks.setRange(...args),
	markParlumeSessionConfidential: (...args: unknown[]) =>
		mocks.markSession(...args),
	postParlumeConfidentialNotice: (...args: unknown[]) =>
		mocks.postNotice(...args),
}));

vi.mock("../../../lib/parlume-start", () => ({
	sessionSelect: { id: true, confidential: true },
}));

vi.mock("../sessions", () => ({
	requireParlumeProject: (...args: unknown[]) =>
		mocks.requireProject(...args),
}));

vi.mock("../../../../../orpc/procedures", () => {
	type State = { path?: string };
	const chain = (state: State): Record<string, unknown> => ({
		use: () => chain(state),
		route: (route: { path: string }) => chain({ path: route.path }),
		input: () => chain(state),
		handler: (handler: Handler) => {
			procedures[state.path ?? ""] = handler;
			return {};
		},
	});
	return {
		tenantProtectedProcedure: chain({}),
		Permissions: {
			PROJECT_READ: "project:read",
			PROJECT_MEMBERS_MANAGE: "members:manage",
		},
		requireProjectPermission: () => () => undefined,
		userHasProjectPermission: (...args: unknown[]) =>
			mocks.manages(...args),
	};
});

await import("../confidential");

const PATH = "/projects/{projectId}/parlume/sessions/{sessionId}/confidential";

function caller(id: string): Caller {
	return {
		user: { id, email: `${id}@example.com`, name: `Name ${id}` },
		session: {},
	};
}

function liveSession(overrides: Record<string, unknown> = {}) {
	return {
		id: "session-1",
		projectId: "project-1",
		organizationId: "org-1",
		userId: "inviter",
		status: "ACTIVE",
		confidentialSince: null,
		externalInvitees: false,
		guestJoinedAt: null,
		attendeeUserIds: ["inviter", "attendee"],
		...overrides,
	};
}

async function call(userId: string, confidential: boolean) {
	const handler = procedures[PATH];
	if (!handler) {
		throw new Error("No confidential procedure");
	}
	return handler({
		context: caller(userId),
		input: { projectId: "project-1", sessionId: "session-1", confidential },
	});
}

/** The code of the oRPC error the call is refused with. */
async function refusal(promise: Promise<unknown>): Promise<string> {
	const error = await promise.catch((caught: unknown) => caught);
	if (!(error instanceof ORPCError)) {
		throw new Error("Expected the call to be refused");
	}
	return error.code;
}

beforeEach(() => {
	vi.resetAllMocks();
	mocks.requireProject.mockResolvedValue({
		id: "project-1",
		organizationId: "org-1",
	});
	mocks.sessionFindFirst.mockResolvedValue(liveSession());
	mocks.sessionFindUniqueOrThrow.mockResolvedValue({
		id: "session-1",
		confidential: true,
	});
	mocks.manages.mockResolvedValue(false);
	mocks.setRange.mockResolvedValue({ changed: true, open: true });
	mocks.postNotice.mockResolvedValue(true);
});

describe("marking a Parlume meeting confidential from Fabric", () => {
	it("lets anyone Fabric confirmed in the meeting start its confidential part, and tells the chat", async () => {
		await call("attendee", true);

		expect(mocks.setRange).toHaveBeenCalledWith(
			expect.objectContaining({
				switch: "on",
				by: "Name attendee",
				force: false,
			}),
		);
		expect(mocks.postNotice).toHaveBeenCalledWith({
			sessionId: "session-1",
			switch: "on",
			by: "Name attendee",
		});
		expect(mocks.recordAudit).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				action: "project.parlume.confidential_marked",
				resource: { type: "parlume_meeting_session", id: "session-1" },
				metadata: { scope: "from_now" },
			}),
		);
	});

	it("refuses a project reader who was not in the meeting and did not invite Parlume", async () => {
		const code = await refusal(call("reader", true));

		expect(code).toBe("FORBIDDEN");
		expect(mocks.setRange).not.toHaveBeenCalled();
		expect(mocks.recordAudit).not.toHaveBeenCalled();
	});

	it("marks a finished meeting as a whole", async () => {
		mocks.sessionFindFirst.mockResolvedValue(
			liveSession({ status: "ENDED" }),
		);

		await call("inviter", true);

		expect(mocks.markSession).toHaveBeenCalledWith({
			sessionId: "session-1",
			confidential: true,
			by: "Name inviter",
		});
		expect(mocks.setRange).not.toHaveBeenCalled();
		expect(mocks.recordAudit).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ metadata: { scope: "whole_meeting" } }),
		);
	});

	it("keeps an attendee who did not invite Parlume from removing the mark", async () => {
		const code = await refusal(call("attendee", false));

		expect(code).toBe("FORBIDDEN");
		expect(mocks.setRange).not.toHaveBeenCalled();
		expect(mocks.markSession).not.toHaveBeenCalled();
	});

	it("keeps an inviter who was not in the meeting from removing the mark", async () => {
		mocks.sessionFindFirst.mockResolvedValue(
			liveSession({ status: "ENDED", attendeeUserIds: ["attendee"] }),
		);

		const code = await refusal(call("inviter", false));

		expect(code).toBe("FORBIDDEN");
		expect(mocks.markSession).not.toHaveBeenCalled();
	});

	it("lets the inviter who was in it remove the mark from a finished meeting", async () => {
		mocks.sessionFindFirst.mockResolvedValue(
			liveSession({ status: "ENDED" }),
		);

		await call("inviter", false);

		expect(mocks.markSession).toHaveBeenCalledWith({
			sessionId: "session-1",
			confidential: false,
			by: "Name inviter",
		});
		expect(mocks.recordAudit).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				action: "project.parlume.confidential_cleared",
			}),
		);
	});

	it("refuses the inviter ending a live part while a guest is expected, and audits nothing", async () => {
		mocks.sessionFindFirst.mockResolvedValue(
			liveSession({
				confidentialSince: new Date("2026-11-20T10:00:00Z"),
				externalInvitees: true,
			}),
		);
		mocks.setRange.mockResolvedValue({ changed: false, open: true });

		const code = await refusal(call("inviter", false));

		expect(code).toBe("FORBIDDEN");
		expect(mocks.setRange).toHaveBeenCalledWith(
			expect.objectContaining({ switch: "off", force: false }),
		);
		expect(mocks.postNotice).not.toHaveBeenCalled();
		expect(mocks.recordAudit).not.toHaveBeenCalled();
	});

	it("lets a project manager end a live part whoever is in the meeting", async () => {
		mocks.manages.mockResolvedValue(true);
		mocks.setRange.mockResolvedValue({ changed: true, open: false });

		await call("manager", false);

		expect(mocks.setRange).toHaveBeenCalledWith(
			expect.objectContaining({ switch: "off", force: true }),
		);
		expect(mocks.postNotice).toHaveBeenCalledWith(
			expect.objectContaining({ switch: "off" }),
		);
	});

	it("finds a session only within the caller's project and organization", async () => {
		mocks.sessionFindFirst.mockResolvedValue(null);

		const code = await refusal(call("inviter", true));

		expect(code).toBe("NOT_FOUND");
		expect(mocks.sessionFindFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					id: "session-1",
					projectId: "project-1",
					organizationId: "org-1",
				},
			}),
		);
	});
});
