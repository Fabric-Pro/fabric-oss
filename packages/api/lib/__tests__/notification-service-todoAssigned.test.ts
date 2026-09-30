/**
 * Verifies fanOut.todoAssigned (Fizzy #2340):
 * - writes one TODO_ASSIGNED row with a server-authored title, and puts the
 *   assigner's (clamped) name and the to-do's text in the snippet
 * - links to the To Do page and carries the to-do's project, or none
 * - skips the actor and anyone no longer in the organization, honours the
 *   `assignments` toggle, and swallows failures
 *
 * Mocks `db.notification.*`, `getNotificationPreferences`, the cache, and
 * external delivery at the boundary so the test exercises the fan-out plus the
 * real `createNotification` and payload validation.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { getPrefsMock, dispatchMock } = vi.hoisted(() => ({
	getPrefsMock: vi.fn(),
	dispatchMock: vi.fn(),
}));

const ALL_ENABLED = {
	mentions: true,
	replies: true,
	assignments: true,
	status: true,
	syncProject: true,
	aiAgent: true,
};

vi.mock("@repo/database", async () => {
	const actual = (await vi.importActual("@repo/database")) as Record<
		string,
		unknown
	>;
	return {
		...actual,
		getNotificationPreferences: getPrefsMock,
		db: {
			notification: {
				findFirst: vi.fn(),
				create: vi.fn(),
				updateMany: vi.fn(),
			},
			member: { findFirst: vi.fn() },
		},
	};
});

vi.mock("@repo/logs", () => ({
	logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("../notification-cache", () => ({
	invalidateUnreadCount: vi.fn().mockResolvedValue(undefined),
	getCachedUnreadCount: vi.fn().mockResolvedValue(null),
	setCachedUnreadCount: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../notification-delivery", () => ({
	dispatchExternalDelivery: dispatchMock,
}));

async function getMockDb() {
	const mod = await import("@repo/database");
	return mod.db as unknown as {
		notification: { create: ReturnType<typeof vi.fn> };
		member: { findFirst: ReturnType<typeof vi.fn> };
	};
}

const baseArgs = {
	recipientUserId: "user-assignee",
	todoId: "todo-1",
	todoText: "Send the revised scope",
	projectId: "proj-1",
	organizationId: "org-1",
	actorUserId: "user-actor",
	actorName: "Dana",
	previousAssigneeUserId: "user-before",
};

beforeEach(async () => {
	vi.clearAllMocks();
	getPrefsMock.mockResolvedValue(ALL_ENABLED);
	dispatchMock.mockResolvedValue(undefined);
	const db = await getMockDb();
	db.member.findFirst.mockResolvedValue({ id: "member-assignee" });
});

describe("fanOut.todoAssigned", () => {
	it("writes one assignment row about the to-do", async () => {
		const db = await getMockDb();
		db.notification.create.mockImplementation(
			async ({ data }: { data: Record<string, unknown> }) => ({
				id: "n-1",
				...data,
			}),
		);
		const { fanOut } = await import("../notification-service");

		await fanOut.todoAssigned(baseArgs);

		expect(db.notification.create).toHaveBeenCalledTimes(1);
		const data = db.notification.create.mock.calls[0][0].data;
		expect(data).toMatchObject({
			userId: "user-assignee",
			organizationId: "org-1",
			type: "TODO_ASSIGNED",
			category: "ASSIGNMENT",
			title: "You were assigned a to-do",
			snippet: "Dana assigned you: Send the revised scope",
			link: "todos",
			projectId: "proj-1",
			actorUserId: "user-actor",
			dedupeKey: "todoAssigned:todo-1:user-assignee",
			payload: {
				todoId: "todo-1",
				projectId: "proj-1",
				assignedByUserId: "user-actor",
				previousAssigneeUserId: "user-before",
			},
		});
		// External delivery is the recipient's own opt-in, decided downstream.
		expect(dispatchMock).toHaveBeenCalledTimes(1);
	});

	it("keeps the assigner's name out of the title, which becomes an email subject", async () => {
		const db = await getMockDb();
		db.notification.create.mockImplementation(
			async ({ data }: { data: Record<string, unknown> }) => ({
				id: "n-1",
				...data,
			}),
		);
		const { fanOut } = await import("../notification-service");

		await fanOut.todoAssigned({
			...baseArgs,
			actorName: "Fabric Security‮\nurgent",
		});

		const data = db.notification.create.mock.calls[0][0].data;
		expect(data.title).toBe("You were assigned a to-do");
		// Clamped: no bidi override, no line break.
		expect(data.snippet).toBe(
			"Fabric Securityurgent assigned you: Send the revised scope",
		);
	});

	it("writes a to-do with no project and no text as an organization-level row", async () => {
		const db = await getMockDb();
		db.notification.create.mockImplementation(
			async ({ data }: { data: Record<string, unknown> }) => ({
				id: "n-1",
				...data,
			}),
		);
		const { fanOut } = await import("../notification-service");

		await fanOut.todoAssigned({
			...baseArgs,
			projectId: null,
			todoText: null,
			previousAssigneeUserId: null,
		});

		const data = db.notification.create.mock.calls[0][0].data;
		expect(data.projectId).toBeUndefined();
		expect(data.snippet).toBe("Dana assigned you a to-do.");
		expect(data.payload).toMatchObject({
			projectId: null,
			previousAssigneeUserId: null,
		});
	});

	it("collapses a multi-line to-do into one snippet line", async () => {
		const db = await getMockDb();
		db.notification.create.mockImplementation(
			async ({ data }: { data: Record<string, unknown> }) => ({
				id: "n-1",
				...data,
			}),
		);
		const { fanOut } = await import("../notification-service");

		await fanOut.todoAssigned({
			...baseArgs,
			todoText: "  Send the\n\nrevised   scope ",
		});

		expect(db.notification.create.mock.calls[0][0].data.snippet).toBe(
			"Dana assigned you: Send the revised scope",
		);
	});

	it("writes nothing when you assign yourself", async () => {
		const db = await getMockDb();
		const { fanOut } = await import("../notification-service");

		await fanOut.todoAssigned({
			...baseArgs,
			recipientUserId: "user-actor",
		});

		expect(db.notification.create).not.toHaveBeenCalled();
	});

	it("writes nothing when the recipient turned assignment notifications off", async () => {
		getPrefsMock.mockResolvedValue({ ...ALL_ENABLED, assignments: false });
		const db = await getMockDb();
		const { fanOut } = await import("../notification-service");

		await fanOut.todoAssigned(baseArgs);

		expect(db.notification.create).not.toHaveBeenCalled();
	});

	it("writes nothing, and sends nothing, to someone who has left the organization", async () => {
		// The assignment checked membership earlier in the request; the row
		// written here starts email/webhook delivery at once, so it asks again.
		const db = await getMockDb();
		db.member.findFirst.mockResolvedValue(null);
		const { fanOut } = await import("../notification-service");

		await fanOut.todoAssigned(baseArgs);

		expect(db.member.findFirst).toHaveBeenCalledWith({
			where: { organizationId: "org-1", userId: "user-assignee" },
			select: { id: true },
		});
		expect(db.notification.create).not.toHaveBeenCalled();
		expect(dispatchMock).not.toHaveBeenCalled();
	});

	it("logs and swallows a database failure", async () => {
		const db = await getMockDb();
		db.notification.create.mockRejectedValue(new Error("db down"));
		const { fanOut } = await import("../notification-service");

		await expect(fanOut.todoAssigned(baseArgs)).resolves.toBeUndefined();
	});
});
