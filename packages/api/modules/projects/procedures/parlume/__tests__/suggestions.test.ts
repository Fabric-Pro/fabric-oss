import { beforeEach, describe, expect, it, vi } from "vitest";

type SuggestionsInput = { projectId: string; sessionId: string };
type SuggestionsArgs = {
	input: SuggestionsInput;
	context: { user: { id: string } };
};
const LIST_PATH =
	"/projects/{projectId}/parlume/sessions/{sessionId}/suggestions";
const mocks = vi.hoisted(() => ({
	project: vi.fn(),
	suggestions: vi.fn(),
	session: vi.fn(),
	canRead: vi.fn(),
	mayRead: vi.fn(),
	permission: vi.fn(),
	handlers: {} as Record<string, (args: SuggestionsArgs) => Promise<unknown>>,
}));
vi.mock("@repo/database", () => ({
	db: {
		parlumeSuggestion: { findMany: mocks.suggestions },
		parlumeMeetingSession: { findFirst: mocks.session },
	},
}));
vi.mock("../sessions", () => ({ requireParlumeProject: mocks.project }));
vi.mock("../../../lib/parlume-transcript-access", () => ({
	canReadParlumeTranscript: mocks.canRead,
}));
vi.mock("../../../lib/parlume-confidential", () => ({
	mayReadParlumeSessionContent: mocks.mayRead,
}));
vi.mock("../../../lib/parlume-attendee", () => ({
	getParlumeBridgeSettings: vi.fn(),
}));
vi.mock("../../../lib/parlume-page-controls", () => ({
	sendParlumeReadAloud: vi.fn(),
}));
vi.mock("../../../lib/parlume-log", () => ({ parlumeLog: vi.fn() }));
vi.mock("../../../../../lib/audit", () => ({
	recordAuditFromRequest: vi.fn(),
}));
vi.mock("../../../../../orpc/procedures", () => {
	type Handler = (args: SuggestionsArgs) => Promise<unknown>;
	const chain = (path = ""): Record<string, unknown> => ({
		use: () => chain(path),
		route: (route: { path: string }) => chain(route.path),
		input: () => chain(path),
		handler: (handler: Handler) => {
			mocks.handlers[path] = handler;
			return handler;
		},
	});
	return {
		tenantProtectedProcedure: chain(),
		requireProjectPermission: mocks.permission,
		Permissions: {
			PROJECT_READ: "project:read",
			PROJECT_UPDATE: "project:update",
		},
	};
});
await import("../suggestions");

const row = {
	id: "suggestion-1",
	kind: "MISSED_QUESTION",
	audience: "TEAM",
	text: "Who signs off the migration?",
	speaker: "Dana",
	quote: "we cover the data migration",
	topic: "Data migration",
	chatTag: null,
	createdAt: new Date("2026-11-04T10:00:00Z"),
};

const list = (userId = "inviter") =>
	mocks.handlers[LIST_PATH]?.({
		input: { projectId: "project", sessionId: "session-1" },
		context: { user: { id: userId } },
	});

beforeEach(() => {
	mocks.project
		.mockReset()
		.mockResolvedValue({ id: "project", organizationId: "org" });
	mocks.suggestions.mockReset().mockResolvedValue([]);
	mocks.session.mockReset().mockResolvedValue({
		userId: "inviter",
		inviteeEmails: ["dev@example.com"],
		confidential: false,
		attendeeUserIds: [],
	});
	mocks.canRead.mockReset().mockResolvedValue(true);
	mocks.mayRead.mockReset().mockResolvedValue(true);
});

describe("Parlume session suggestions", () => {
	it("needs the Requests list's project read permission and scopes to the authorized project and tenant, newest first", async () => {
		expect(mocks.permission).toHaveBeenCalledWith("project:read");
		mocks.suggestions.mockResolvedValue([row]);

		await expect(list()).resolves.toEqual({ items: [row] });
		expect(mocks.project).toHaveBeenCalledWith("project");
		expect(mocks.suggestions).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					projectId: "project",
					organizationId: "org",
					sessionId: "session-1",
					dismissedAt: null,
				},
				orderBy: [{ createdAt: "desc" }, { id: "desc" }],
				take: 50,
			}),
		);
		expect(mocks.session).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					id: "session-1",
					projectId: "project",
					organizationId: "org",
				},
			}),
		);
		expect(mocks.canRead).toHaveBeenCalledWith({
			projectId: "project",
			userId: "inviter",
			inviterId: "inviter",
			inviteeEmails: ["dev@example.com"],
			confidential: false,
			attendeeUserIds: [],
		});
	});

	it("shows none of a confidential meeting's suggestions to a reader who was not in it", async () => {
		mocks.suggestions.mockResolvedValue([row]);
		mocks.session.mockResolvedValue({
			userId: "inviter",
			inviteeEmails: [],
			confidential: true,
			attendeeUserIds: ["attendee"],
		});
		mocks.mayRead.mockResolvedValue(false);

		await expect(list("absent-member")).resolves.toEqual({ items: [] });
		expect(mocks.mayRead).toHaveBeenCalledWith({
			projectId: "project",
			userId: "absent-member",
			session: expect.objectContaining({
				confidential: true,
				attendeeUserIds: ["attendee"],
			}),
		});
	});

	it("withholds the quote, what someone said word for word, from a reader who may not read the transcript", async () => {
		mocks.suggestions.mockResolvedValue([row]);
		mocks.canRead.mockResolvedValue(false);

		await expect(list("reader")).resolves.toEqual({
			items: [{ ...row, quote: null }],
		});
		expect(mocks.canRead).toHaveBeenCalledWith({
			projectId: "project",
			userId: "reader",
			inviterId: "inviter",
			inviteeEmails: ["dev@example.com"],
			confidential: false,
			attendeeUserIds: [],
		});
	});

	it("shows nothing when the session is not the project's", async () => {
		mocks.suggestions.mockResolvedValue([row]);
		mocks.session.mockResolvedValue(null);

		await expect(list()).resolves.toEqual({ items: [] });
		expect(mocks.canRead).not.toHaveBeenCalled();
	});

	it("refuses when the project or feature is unavailable", async () => {
		mocks.project.mockRejectedValueOnce(new Error("Not found"));

		await expect(
			mocks.handlers[LIST_PATH]?.({
				input: { projectId: "other", sessionId: "session-1" },
				context: { user: { id: "inviter" } },
			}),
		).rejects.toThrow("Not found");
		expect(mocks.suggestions).not.toHaveBeenCalled();
	});
});
