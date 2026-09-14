/**
 * `fanOut.cliConnectionRequested` — the write half of the CLI-connection ask
 * (Fizzy #2457).
 *
 * Four properties carry this helper and the tests are built around them:
 *
 *  - the asker is never written to, however they arrive in the list;
 *  - a person already holding an UNREAD ask about a project is not asked again,
 *    no matter who asks or how often — the dedupe key carries the project and
 *    the recipient and nothing else, so a second colleague pressing the button
 *    does not stack a second row, and a row coalesced by a raced INSERT is
 *    neither counted as a delivery nor re-attributed to the racer;
 *  - the returned breakdown keeps written, skipped and FAILED apart, because
 *    the panel turns it into a sentence and "they already had one" is the wrong
 *    sentence for a write that broke;
 *  - the title — and so the email SUBJECT — is server-authored and carries
 *    nothing its actor typed, while the SNIPPET carries the attribution,
 *    clamped: bounded, stripped of the characters that reorder or hide the
 *    line around them, and never dropped, because an unattributed ask is worse.
 *
 * Mocks `db.notification.*`, `getNotificationPreferences`, the unread-count
 * cache and external delivery at the boundary, so the real `createNotification`
 * path — including `CATEGORY_TO_TOGGLE` and `isCategoryEnabled` — is exercised.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { getPrefsMock } = vi.hoisted(() => ({ getPrefsMock: vi.fn() }));

const ALL_ENABLED = {
	mentions: true,
	replies: true,
	assignments: true,
	status: true,
	syncProject: true,
	aiAgent: true,
};
const MENTIONS_OFF = { ...ALL_ENABLED, mentions: false };

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
	dispatchExternalDelivery: vi.fn().mockResolvedValue(undefined),
}));

async function getMockDb() {
	const mod = await import("@repo/database");
	return mod.db as unknown as {
		notification: {
			findFirst: ReturnType<typeof vi.fn>;
			create: ReturnType<typeof vi.fn>;
			updateMany: ReturnType<typeof vi.fn>;
		};
	};
}

/** Every write succeeds and echoes the row back, as Prisma would. */
async function withWritesSucceeding() {
	const db = await getMockDb();
	db.notification.findFirst.mockResolvedValue(null);
	db.notification.create.mockImplementation(
		async ({ data }: { data: { userId: string } }) => ({
			id: `n-${data.userId}`,
			...data,
		}),
	);
	return db;
}

const baseArgs = {
	projectId: "proj-1",
	projectName: "Atlas",
	organizationId: "org-1",
	actorUserId: "user-1",
	actorName: "Alice",
	link: "projects/proj-1",
};

beforeEach(() => {
	vi.clearAllMocks();
	getPrefsMock.mockResolvedValue(ALL_ENABLED);
});

describe("fanOut.cliConnectionRequested", () => {
	it("writes one row per recipient and returns that count", async () => {
		const db = await withWritesSucceeding();
		const { fanOut } = await import("../notification-service");

		const count = await fanOut.cliConnectionRequested({
			...baseArgs,
			recipientUserIds: ["user-2", "user-3"],
		});

		expect(count).toEqual({ notified: 2, skipped: 0, failed: 0 });
		const written = db.notification.create.mock.calls.map(
			(call) =>
				(
					call[0] as {
						data: {
							userId: string;
							type: string;
							category: string;
							title: string;
							link: string;
							payload: Record<string, unknown>;
						};
					}
				).data,
		);
		expect(written.map((d) => d.userId).sort()).toEqual([
			"user-2",
			"user-3",
		]);
		expect(written[0].type).toBe("CLI_CONNECTION_REQUESTED");
		// Silenceable: MENTION is in CATEGORY_TO_TOGGLE, the always-on
		// categories are not.
		expect(written[0].category).toBe("MENTION");
		expect(written[0].title).toBe(
			"A teammate asked you to connect a coding tool to Fabric",
		);
		expect(written[0].snippet).toBe(
			"Alice asked about Atlas. It takes a key and a single configuration block to let a coding tool read its context.",
		);
		expect(written[0].link).toBe("projects/proj-1");
		expect(written[0].payload).toEqual({
			projectId: "proj-1",
			projectName: "Atlas",
			requestedByUserId: "user-1",
		});
	});

	it("never writes to the asker, even when they name themselves", async () => {
		const db = await withWritesSucceeding();
		const { fanOut } = await import("../notification-service");

		const count = await fanOut.cliConnectionRequested({
			...baseArgs,
			recipientUserIds: ["user-1", "user-2"],
		});

		expect(count).toEqual({ notified: 1, skipped: 0, failed: 0 });
		const writtenIds = db.notification.create.mock.calls.map(
			(call) => (call[0] as { data: { userId: string } }).data.userId,
		);
		expect(writtenIds).toEqual(["user-2"]);
	});

	it("writes nothing and returns an all-zero breakdown when the asker is the only recipient", async () => {
		const db = await withWritesSucceeding();
		const { fanOut } = await import("../notification-service");

		const count = await fanOut.cliConnectionRequested({
			...baseArgs,
			recipientUserIds: ["user-1"],
		});

		expect(count).toEqual({ notified: 0, skipped: 0, failed: 0 });
		expect(db.notification.create).not.toHaveBeenCalled();
	});

	it("keys the dedupe on the project and the recipient, with no actor in it", async () => {
		const db = await withWritesSucceeding();
		const { fanOut } = await import("../notification-service");

		await fanOut.cliConnectionRequested({
			...baseArgs,
			recipientUserIds: ["user-2"],
		});

		const { data } = db.notification.create.mock.calls[0][0] as {
			data: { dedupeKey: string };
		};
		expect(data.dedupeKey).toBe("cliConnectionRequested:proj-1:user-2");
		// A second colleague asking must collide with the first ask, so the
		// actor must not appear in the key.
		expect(data.dedupeKey).not.toContain("user-1");
	});

	it("does not re-ask, or re-count, somebody holding an unread ask", async () => {
		const db = await withWritesSucceeding();
		const { fanOut } = await import("../notification-service");

		// First ask lands.
		const first = await fanOut.cliConnectionRequested({
			...baseArgs,
			recipientUserIds: ["user-2"],
		});
		expect(first).toEqual({ notified: 1, skipped: 0, failed: 0 });
		expect(db.notification.create).toHaveBeenCalledTimes(1);

		// The row from the first ask is still unread and un-archived — the
		// `unreadOnly` pre-read finds it.
		db.notification.findFirst.mockResolvedValue({ id: "n-user-2" });

		const second = await fanOut.cliConnectionRequested({
			...baseArgs,
			// A different colleague pressing the same button.
			actorUserId: "user-9",
			actorName: "Bob",
			recipientUserIds: ["user-2"],
		});

		// No second row, and the caller is told nobody was notified rather
		// than being handed the coalesced row as a fresh delivery.
		expect(second).toEqual({ notified: 0, skipped: 1, failed: 0 });
		expect(db.notification.create).toHaveBeenCalledTimes(1);
		expect(db.notification.findFirst).toHaveBeenLastCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					userId: "user-2",
					dedupeKey: "cliConnectionRequested:proj-1:user-2",
					readAt: null,
					archivedAt: null,
				}),
			}),
		);
	});

	it("deduplicates only the recipient who already holds an unread ask", async () => {
		const db = await withWritesSucceeding();
		db.notification.findFirst.mockImplementation(
			async ({ where }: { where: { userId: string } }) =>
				where.userId === "user-2" ? { id: "n-user-2" } : null,
		);
		const { fanOut } = await import("../notification-service");

		const count = await fanOut.cliConnectionRequested({
			...baseArgs,
			recipientUserIds: ["user-2", "user-3"],
		});

		expect(count).toEqual({ notified: 1, skipped: 1, failed: 0 });
		const writtenIds = db.notification.create.mock.calls.map(
			(call) => (call[0] as { data: { userId: string } }).data.userId,
		);
		expect(writtenIds).toEqual(["user-3"]);
	});

	it("does not count a recipient who has silenced the MENTION category", async () => {
		getPrefsMock.mockImplementation(async (userId: string) =>
			userId === "user-3" ? MENTIONS_OFF : ALL_ENABLED,
		);
		const db = await withWritesSucceeding();
		const { fanOut } = await import("../notification-service");

		const count = await fanOut.cliConnectionRequested({
			...baseArgs,
			recipientUserIds: ["user-2", "user-3"],
		});

		expect(count).toEqual({ notified: 1, skipped: 1, failed: 0 });
		expect(db.notification.create).toHaveBeenCalledTimes(1);
	});

	it("reports a failed write as FAILED, not as a skip", async () => {
		const db = await getMockDb();
		db.notification.findFirst.mockResolvedValue(null);
		db.notification.create.mockImplementation(
			async ({ data }: { data: { userId: string } }) => {
				if (data.userId === "user-3") {
					throw new Error("connection reset");
				}
				return { id: `n-${data.userId}`, ...data };
			},
		);
		const { fanOut } = await import("../notification-service");

		const count = await fanOut.cliConnectionRequested({
			...baseArgs,
			recipientUserIds: ["user-2", "user-3"],
		});

		// Two attempted, one written. The failure is swallowed — never thrown
		// at the asker's request — and reported in its own bucket. Folded into
		// the skips it would have the caller tell the asker that user-3 was
		// already holding an unread ask, about a row that does not exist.
		expect(db.notification.create).toHaveBeenCalledTimes(2);
		expect(count).toEqual({ notified: 1, skipped: 0, failed: 1 });
	});

	it("does not count, or re-attribute, a row a raced INSERT collided with", async () => {
		// The pre-read misses and the INSERT loses a race with a colleague
		// asking the same person in the same second. Before this, both askers
		// were told "Asked 1 teammate" for one row, and the coalesce rewrote
		// `title` and `actorUserId` — so the recipient's pending ask silently
		// changed author to whoever LOST.
		const db = await getMockDb();
		db.notification.findFirst.mockResolvedValue(null);
		db.notification.create.mockRejectedValue(
			Object.assign(new Error("unique constraint"), { code: "P2002" }),
		);
		const { fanOut } = await import("../notification-service");

		const count = await fanOut.cliConnectionRequested({
			...baseArgs,
			actorUserId: "user-9",
			actorName: "Bob",
			recipientUserIds: ["user-2"],
		});

		// Not a delivery: nothing new reached user-2.
		expect(count).toEqual({ notified: 0, skipped: 1, failed: 0 });
		// And not a failure either — nothing is broken, the ask simply already
		// existed a millisecond earlier.
		expect(db.notification.updateMany).not.toHaveBeenCalled();
	});

	it("bounds an over-long display name before it reaches the snippet", async () => {
		const db = await withWritesSucceeding();
		const { fanOut } = await import("../notification-service");

		await fanOut.cliConnectionRequested({
			...baseArgs,
			actorName: "A".repeat(500),
			recipientUserIds: ["user-2"],
		});

		const { data } = db.notification.create.mock.calls[0][0] as {
			data: { snippet: string };
		};
		// The sentence the recipient needs survives, which is the whole reason
		// the name is bounded rather than the snippet truncated.
		expect(data.snippet).toBe(
			`${"A".repeat(47)}… asked about Atlas. It takes a key and a single configuration block to let a coding tool read its context.`,
		);
	});

	it("strips what a display name could smuggle into the line around it", async () => {
		const db = await withWritesSucceeding();
		const { fanOut } = await import("../notification-service");

		await fanOut.cliConnectionRequested({
			...baseArgs,
			// A newline splits a one-line snippet, and is header injection on
			// any surface that later reuses the string as a header; the bidi
			// and zero-width characters reorder or hide the honest clause
			// after the name without a single visible glyph.
			// The zero-width sits inside an ordinary WORD, not inside the
			// address. Both spellings prove the same thing — a stripped
			// character leaves nothing behind, not even a space — but putting
			// it mid-address welds a bogus domain onto the end of a real one,
			// and the relay's publication scan reads that as an unsanctioned
			// email address and refuses to publish the branch.
			actorName: "Ada\r\nBcc: attacker@example.com very\u200Bone\u202E",
			recipientUserIds: ["user-2"],
		});

		const { data } = db.notification.create.mock.calls[0][0] as {
			data: { snippet: string };
		};
		expect(data.snippet).not.toMatch(/[\r\n]/);
		expect(data.snippet).not.toMatch(
			// biome-ignore lint/suspicious/noControlCharactersInRegex: asserting that none of them survived is the assertion.
			/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/,
		);
		// The stripped characters leave nothing behind — a hostile name is not
		// owed tidy spacing — and the honest clause is still intact.
		expect(data.snippet).toBe(
			"AdaBcc: attacker@example.com veryone asked about Atlas. It takes a key and a single configuration block to let a coding tool read its context.",
		);
	});

	it("falls back to an attribution rather than dropping it", async () => {
		const db = await withWritesSucceeding();
		const { fanOut } = await import("../notification-service");

		await fanOut.cliConnectionRequested({
			...baseArgs,
			// Nothing legible survives the strip.
			actorName: "\u200B\u200B\u202E",
			recipientUserIds: ["user-2"],
		});

		const { data } = db.notification.create.mock.calls[0][0] as {
			data: { snippet: string };
		};
		// A snippet with no subject reads as if Fabric itself asked. Say
		// "Someone" instead — the same word the callers use for a missing name.
		expect(data.snippet).toBe(
			"Someone asked about Atlas. It takes a key and a single configuration block to let a coding tool read its context.",
		);
	});

	/**
	 * The regression guard for the finding that a clamp could not answer.
	 *
	 * `notification.title` is the email subject verbatim. A clamped name is
	 * still a name its owner chose, so a member who calls themselves after a
	 * team or a product would have had Fabric put that identity, unqualified,
	 * into fifty inboxes. Nothing this actor typed may appear there — not the
	 * hostile fragment, and not the innocent name either, because the property
	 * being asserted is that the subject is server-authored, not that it is
	 * well-filtered.
	 */
	it("puts nothing the asker typed into the email subject", async () => {
		const db = await withWritesSucceeding();
		const { fanOut } = await import("../notification-service");

		await fanOut.cliConnectionRequested({
			...baseArgs,
			actorName: "Fabric Security",
			projectName: "Atlas",
			recipientUserIds: ["user-2"],
		});

		const { data } = db.notification.create.mock.calls[0][0] as {
			data: { title: string; snippet: string };
		};
		expect(data.title).toBe(
			"A teammate asked you to connect a coding tool to Fabric",
		);
		expect(data.title).not.toContain("Fabric Security");
		expect(data.title).not.toContain("Atlas");
		// Not dropped — relocated. The recipient still learns who asked, in
		// the line they read inside the app or inside the mail body.
		expect(data.snippet).toContain("Fabric Security");
	});

	/**
	 * The second thing this row must not carry: a fact about the organization.
	 *
	 * The prompt that sends the asker here says nobody is using Fabric's MCP
	 * yet, and that is true only while `organizationCliConnected` is false —
	 * a present-tense signal derived from live credentials, which flips back as
	 * soon as anyone connects, and which this procedure deliberately does not
	 * re-read. A notification is read whenever its recipient gets to it. An
	 * organization-wide negative copied into it is a claim with a shelf life,
	 * sent to up to fifty people, with nothing to refresh it.
	 *
	 * Asserting on the vocabulary rather than on one sentence, so that a future
	 * edit reintroducing the claim in different words still fails.
	 */
	it.each([
		"nobody",
		"no one",
		"this organization",
		"yet",
		"has used",
		"has ever",
	])("claims nothing about the organization's history (%s)", async (word) => {
		const db = await withWritesSucceeding();
		const { fanOut } = await import("../notification-service");

		await fanOut.cliConnectionRequested({
			...baseArgs,
			recipientUserIds: ["user-2"],
		});

		const { data } = db.notification.create.mock.calls[0][0] as {
			data: { title: string; snippet: string };
		};
		expect(`${data.title} ${data.snippet}`.toLowerCase()).not.toContain(
			word,
		);
	});
});
