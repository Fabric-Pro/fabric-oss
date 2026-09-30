/**
 * The meeting auto-assignment notification writer (Fizzy #2340).
 *
 * Prisma's `notification` delegate and the preference read are mocked, so this
 * file pins WHAT the writer inserts and every reason it inserts nothing: an
 * empty batch, a meeting the To Do page already age-hides, a notice this person
 * already had for this meeting (read or not), a recipient who has left the
 * organization, and a switched-off Assignments toggle. It also pins that the
 * writer never throws: it reports a failure, and the caller retries.
 *
 * It cannot prove the partial unique index exists; that needs a database.
 *
 * Run with:
 *   pnpm --filter @repo/database test todo-assignment-notifications
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	notification: {
		findFirst: vi.fn(),
		create: vi.fn(),
	},
	member: { findFirst: vi.fn() },
	getNotificationPreferences: vi.fn(),
}));

vi.mock("../../../client", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		db: { notification: mocks.notification, member: mocks.member },
	};
});

vi.mock("../../notification-preferences", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		getNotificationPreferences: mocks.getNotificationPreferences,
	};
});

const { DEFAULT_NOTIFICATION_PREFERENCES } = await import(
	"../../notification-preferences"
);
const {
	TODO_MEETING_NOTIFICATION_MAX_AGE_DAYS,
	buildTodoMeetingAssignmentPayload,
	createTodoMeetingAssignmentNotification,
} = await import("../todo-assignment-notifications");

const DAY_MS = 24 * 60 * 60 * 1000;
const MEETING_DATE = new Date("2026-09-10T09:00:00.000Z");
/** A few days after the meeting, so the fixture never ages out. */
const NOW = new Date("2026-09-13T12:00:00.000Z");

function baseArgs(
	overrides: Partial<
		Parameters<typeof createTodoMeetingAssignmentNotification>[0]
	> = {},
): Parameters<typeof createTodoMeetingAssignmentNotification>[0] {
	return {
		recipientUserId: "user-anna",
		organizationId: "org-example",
		projectId: "project-1",
		transcriptId: "transcript-1",
		meetingSubject: "Weekly sync",
		sourceDate: MEETING_DATE,
		items: [
			{ todoId: "todo-1", text: "Send the coverage report" },
			{ todoId: "todo-2", text: "Book the retro room" },
		],
		now: NOW,
		...overrides,
	};
}

/** The `data` of the one insert this run made. */
function inserted() {
	expect(mocks.notification.create).toHaveBeenCalledTimes(1);
	return mocks.notification.create.mock.calls[0][0].data;
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.notification.findFirst.mockResolvedValue(null);
	mocks.notification.create.mockResolvedValue({ id: "notification-1" });
	mocks.member.findFirst.mockResolvedValue({ id: "member-anna" });
	mocks.getNotificationPreferences.mockResolvedValue({
		...DEFAULT_NOTIFICATION_PREFERENCES,
	});
});

describe("what the notice says (Fizzy #2340)", () => {
	it("inserts one in-app row with a fixed title and the meeting in the snippet", async () => {
		const outcome = await createTodoMeetingAssignmentNotification(
			baseArgs(),
		);

		expect(outcome).toBe("created");
		expect(inserted()).toEqual({
			userId: "user-anna",
			organizationId: "org-example",
			type: "TODO_MEETING_ITEMS_ASSIGNED",
			category: "ASSIGNMENT",
			// Server-authored: the title becomes an email subject verbatim
			// wherever external delivery exists, so neither the subject nor the
			// item text may appear in it.
			title: "Action items from a meeting were assigned to you",
			snippet:
				'2 action items from "Weekly sync": Send the coverage report',
			link: "todos",
			// Carried so deleting the project cascades the row and the read-time
			// access re-check has something to check.
			projectId: "project-1",
			payload: {
				transcriptId: "transcript-1",
				projectId: "project-1",
				todoIds: ["todo-1", "todo-2"],
				itemCount: 2,
			},
			dedupeKey: "todoMeetingAssigned:transcript-1:user-anna",
		});
	});

	it("names no actor, because no person made the assignment", async () => {
		await createTodoMeetingAssignmentNotification(baseArgs());

		const data = inserted();
		expect(data).not.toHaveProperty("actorUserId");
		expect(data).not.toHaveProperty("storyId");
	});

	it("drops the quoted subject when the meeting has none", async () => {
		await createTodoMeetingAssignmentNotification(
			baseArgs({ meetingSubject: null }),
		);

		expect(inserted().snippet).toBe(
			"2 action items: Send the coverage report",
		);
	});

	it("treats a blank subject as no subject", async () => {
		await createTodoMeetingAssignmentNotification(
			baseArgs({ meetingSubject: "   \n\t " }),
		);

		expect(inserted().snippet).toBe(
			"2 action items: Send the coverage report",
		);
	});

	it("says '1 action item' for a single item", async () => {
		await createTodoMeetingAssignmentNotification(
			baseArgs({
				items: [{ todoId: "todo-1", text: "Send the report" }],
			}),
		);

		const data = inserted();
		expect(data.snippet).toBe(
			'1 action item from "Weekly sync": Send the report',
		);
		expect(data.payload).toMatchObject({
			todoIds: ["todo-1"],
			itemCount: 1,
		});
	});

	it("collapses whitespace in the subject and the item text", async () => {
		await createTodoMeetingAssignmentNotification(
			baseArgs({
				meetingSubject: "  Weekly\n\nsync  ",
				items: [
					{ todoId: "todo-1", text: "Send   the\ncoverage\treport " },
				],
			}),
		);

		expect(inserted().snippet).toBe(
			'1 action item from "Weekly sync": Send the coverage report',
		);
	});

	it("truncates a long first item to the 280-character snippet cap", async () => {
		await createTodoMeetingAssignmentNotification(
			baseArgs({
				items: [{ todoId: "todo-1", text: "word ".repeat(200) }],
			}),
		);

		const snippet = inserted().snippet as string;
		expect(snippet.length).toBeLessThanOrEqual(280);
		expect(snippet.endsWith("…")).toBe(true);
		expect(
			snippet.startsWith('1 action item from "Weekly sync": word'),
		).toBe(true);
	});
});

describe("when it writes nothing (Fizzy #2340)", () => {
	it("inserts nothing for an empty batch", async () => {
		const outcome = await createTodoMeetingAssignmentNotification(
			baseArgs({ items: [] }),
		);

		expect(outcome).toBe("no-items");
		expect(mocks.notification.findFirst).not.toHaveBeenCalled();
		expect(mocks.notification.create).not.toHaveBeenCalled();
	});

	it("inserts nothing when the recipient switched off Assignments", async () => {
		mocks.getNotificationPreferences.mockResolvedValue({
			...DEFAULT_NOTIFICATION_PREFERENCES,
			assignments: false,
		});

		const outcome = await createTodoMeetingAssignmentNotification(
			baseArgs(),
		);

		expect(outcome).toBe("preference-disabled");
		expect(mocks.getNotificationPreferences).toHaveBeenCalledWith(
			"user-anna",
		);
		expect(mocks.notification.create).not.toHaveBeenCalled();
	});

	it.each([
		["unread", { id: "notification-old" }],
		["read", { id: "notification-read" }],
	])(
		"inserts nothing when a %s notice for this meeting already exists",
		async (_state, prior) => {
			mocks.notification.findFirst.mockResolvedValue(prior);

			const outcome = await createTodoMeetingAssignmentNotification(
				baseArgs(),
			);

			expect(outcome).toBe("already-notified");
			expect(mocks.notification.create).not.toHaveBeenCalled();
		},
	);

	it("looks for a prior notice by key within the organization, whatever its read or archived state", async () => {
		// The matcher hands over everyone holding items on every run, so a
		// notice the person has already read must still count as told. Only a
		// lookup that ignores readAt/archivedAt keeps a re-run from becoming a
		// second notice for the same meeting.
		await createTodoMeetingAssignmentNotification(baseArgs());

		expect(mocks.notification.findFirst).toHaveBeenCalledWith({
			where: {
				userId: "user-anna",
				organizationId: "org-example",
				dedupeKey: "todoMeetingAssigned:transcript-1:user-anna",
			},
			select: { id: true },
		});
	});

	it("inserts nothing for someone who has left the organization", async () => {
		// The matcher read its member list before its writes; by the time the
		// notice is written the person may be gone, and the notice is this
		// organization's content.
		mocks.member.findFirst.mockResolvedValue(null);

		await expect(
			createTodoMeetingAssignmentNotification(baseArgs()),
		).resolves.toBe("not-a-member");

		expect(mocks.member.findFirst).toHaveBeenCalledWith({
			where: { organizationId: "org-example", userId: "user-anna" },
			select: { id: true },
		});
		expect(mocks.notification.create).not.toHaveBeenCalled();
	});

	it("inserts nothing for a meeting older than the To Do page's age cutoff", async () => {
		const outcome = await createTodoMeetingAssignmentNotification(
			baseArgs({
				sourceDate: new Date(
					NOW.getTime() -
						TODO_MEETING_NOTIFICATION_MAX_AGE_DAYS * DAY_MS -
						60_000,
				),
			}),
		);

		expect(outcome).toBe("stale");
		expect(mocks.notification.findFirst).not.toHaveBeenCalled();
		expect(mocks.notification.create).not.toHaveBeenCalled();
	});

	it("still notifies for a meeting just inside the window", async () => {
		const outcome = await createTodoMeetingAssignmentNotification(
			baseArgs({
				sourceDate: new Date(
					NOW.getTime() -
						TODO_MEETING_NOTIFICATION_MAX_AGE_DAYS * DAY_MS +
						60_000,
				),
			}),
		);

		expect(outcome).toBe("created");
		expect(mocks.notification.create).toHaveBeenCalledTimes(1);
	});

	it("reads the wall clock when no clock is passed", async () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date("2026-12-01T00:00:00.000Z"));

			const outcome = await createTodoMeetingAssignmentNotification(
				baseArgs({ now: undefined }),
			);

			expect(outcome).toBe("stale");
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("never throws (Fizzy #2340)", () => {
	it("treats a unique-index collision as the same notice racing itself", async () => {
		mocks.notification.create.mockRejectedValue(
			Object.assign(new Error("Unique constraint failed"), {
				code: "P2002",
			}),
		);

		await expect(
			createTodoMeetingAssignmentNotification(baseArgs()),
		).resolves.toBe("already-notified");
	});

	it("swallows any other insert error and reports it as failed", async () => {
		mocks.notification.create.mockRejectedValue(
			new Error("connection reset"),
		);

		await expect(
			createTodoMeetingAssignmentNotification(baseArgs()),
		).resolves.toBe("failed");
	});

	it("swallows a failing prior-notice lookup", async () => {
		mocks.notification.findFirst.mockRejectedValue(new Error("timeout"));

		await expect(
			createTodoMeetingAssignmentNotification(baseArgs()),
		).resolves.toBe("failed");
		expect(mocks.notification.create).not.toHaveBeenCalled();
	});

	it("swallows a failing preference read", async () => {
		mocks.getNotificationPreferences.mockRejectedValue(
			new Error("timeout"),
		);

		await expect(
			createTodoMeetingAssignmentNotification(baseArgs()),
		).resolves.toBe("failed");
		expect(mocks.notification.create).not.toHaveBeenCalled();
	});
});

describe("buildTodoMeetingAssignmentPayload (Fizzy #2340)", () => {
	it("counts the to-dos it names", () => {
		expect(
			buildTodoMeetingAssignmentPayload({
				transcriptId: "transcript-1",
				projectId: "project-1",
				todoIds: ["todo-1", "todo-2", "todo-3"],
			}),
		).toEqual({
			transcriptId: "transcript-1",
			projectId: "project-1",
			todoIds: ["todo-1", "todo-2", "todo-3"],
			itemCount: 3,
		});
	});
});
