/**
 * The push half of the customer status page.
 *
 * These assertions are mostly about what must NOT happen. A notification cannot be
 * recalled, so the expensive failures here are over-sending: notifying about an
 * informational announcement, notifying twice for one announcement, or notifying
 * when the operator has not switched the feature on.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const statusUpdateFindMany = vi.fn();
const organizationFindMany = vi.fn();
const organizationCount = vi.fn();
const memberFindMany = vi.fn();
const notificationCreateMany = vi.fn();
const notificationFindMany = vi.fn();

vi.mock("../prisma/client", () => ({
	db: {
		statusUpdate: {
			findMany: (...a: unknown[]) => statusUpdateFindMany(...a),
		},
		organization: {
			findMany: (...a: unknown[]) => organizationFindMany(...a),
			count: (...a: unknown[]) => organizationCount(...a),
		},
		member: { findMany: (...a: unknown[]) => memberFindMany(...a) },
		notification: {
			createMany: (...a: unknown[]) => notificationCreateMany(...a),
			findMany: (...a: unknown[]) => notificationFindMany(...a),
		},
	},
}));

const { dispatchStatusAnnouncementNotifications } = await import(
	"../prisma/queries/status-announcement-notifications"
);

type NotificationRow = {
	userId: string;
	organizationId: string;
	dedupeKey: string;
	type?: string;
	category?: string;
	title?: string;
	snippet?: string;
	link?: string;
	payload?: unknown;
};

/** Every row ever written — including ones the recipient later read or archived. */
const rows: NotificationRow[] = [];
/**
 * The subset the PARTIAL unique index actually covers. The real index is
 *   ON (userId, dedupeKey) WHERE readAt IS NULL AND archivedAt IS NULL
 * so it stops constraining a row the moment the recipient reads it.
 */
const live = new Set<string>();

/** Every row handed to `createMany`, flattened across chunks. */
function written(): NotificationRow[] {
	return notificationCreateMany.mock.calls.flatMap(
		(c) => c[0].data as NotificationRow[],
	);
}

/** What a recipient does in the product: opens the bell and reads the row. */
function markRead(userId: string, dedupeKey: string): void {
	live.delete(`${userId}::${dedupeKey}`);
}

const NOW = new Date("2026-08-07T12:00:00.000Z");

const ANNOUNCEMENT = {
	id: "su_1",
	title: "Degraded AI generation",
	body: "Some generations are failing. We are investigating.",
	impact: "MAJOR",
	lifecycle: "INVESTIGATING",
	startedAt: new Date("2026-08-07T11:00:00.000Z"),
};

beforeEach(() => {
	// resetAllMocks, not clearAllMocks: `mockResolvedValueOnce` queues survive
	// `clear`, so a per-test page sequence would leak into the next test and serve
	// extra organization pages.
	vi.resetAllMocks();
	process.env.FABRIC_STATUS_ANNOUNCEMENT_NOTIFICATIONS_ENABLED = "true";
	statusUpdateFindMany.mockResolvedValue([ANNOUNCEMENT]);
	// One page, then exhausted — the paging loop stops on an empty page.
	// Cursor-driven rather than `mockResolvedValueOnce`: a once-queue is consumed by
	// the FIRST dispatch, so a test that dispatches twice would silently get an
	// empty organization page on the second pass and write nothing — passing for the
	// wrong reason. This models paging, so repeated dispatches behave alike.
	organizationFindMany.mockImplementation(
		async (args: { cursor?: { id: string } }) =>
			args?.cursor ? [] : [{ id: "org_1" }, { id: "org_2" }],
	);
	organizationCount.mockResolvedValue(0);
	memberFindMany.mockResolvedValue([
		{ userId: "u1", organizationId: "org_1" },
		{ userId: "u2", organizationId: "org_2" },
	]);
	// Model the REAL constraint, not a permissive stub: the partial unique index
	// `notification_userId_dedupeKey_live_uq` on (userId, dedupeKey) for unread+live
	// rows. A mock that accepts every insert cannot reproduce a dedupe-key defect —
	// which is exactly why the multi-organization bug reached a deployed environment
	// with 33 unit tests passing.
	rows.length = 0;
	live.clear();
	// Answers from every row ever written, read or not — which is what the
	// non-partial (userId, dedupeKey) index supports.
	notificationFindMany.mockImplementation(
		async (args: { where: { dedupeKey: { in: string[] } } }) => {
			const wanted = new Set(args.where.dedupeKey.in);
			return rows.filter((r) => wanted.has(r.dedupeKey));
		},
	);
	// Models `createMany({ skipDuplicates: true })` → ON CONFLICT DO NOTHING: it does
	// not throw on a conflict, and `count` is the number of rows ACTUALLY inserted.
	// The conflict target is the partial index, so `live` (unread + unarchived) is
	// what constrains — not `rows`.
	notificationCreateMany.mockImplementation(
		async (args: { data: NotificationRow[] }) => {
			let count = 0;
			for (const row of args.data) {
				const key = `${row.userId}::${row.dedupeKey}`;
				if (live.has(key)) {
					continue;
				}
				live.add(key);
				rows.push({ ...row });
				count++;
			}
			return { count };
		},
	);
});

describe("the flag gates everything", () => {
	it("writes nothing and reads nothing when the flag is unset", async () => {
		delete process.env.FABRIC_STATUS_ANNOUNCEMENT_NOTIFICATIONS_ENABLED;

		const out = await dispatchStatusAnnouncementNotifications(NOW);

		expect(out).toMatchObject({
			skipped: true,
			skipReason: "flag-disabled",
		});
		// Not even a query — enabling must be the only thing that starts this.
		expect(statusUpdateFindMany).not.toHaveBeenCalled();
		expect(notificationCreateMany).not.toHaveBeenCalled();
	});

	it.each(["false", "off", "no", "0", "", "  "])(
		"stays off for the falsey flag value %o",
		async (value) => {
			process.env.FABRIC_STATUS_ANNOUNCEMENT_NOTIFICATIONS_ENABLED =
				value;

			const out = await dispatchStatusAnnouncementNotifications(NOW);

			expect(out.skipped).toBe(true);
			expect(notificationCreateMany).not.toHaveBeenCalled();
		},
	);

	it.each(["true", "TRUE", " True ", "1", "on", "yes"])(
		"turns on for the canonical truthy flag value %o",
		async (value) => {
			// Matches `parseOptInFlag`, the repo-wide opt-in reader. An operator
			// who sets `=1` HAS enabled it; a stricter reader would leave the
			// sweeper inert while looking enabled — the failure mode this
			// feature is otherwise careful to avoid.
			process.env.FABRIC_STATUS_ANNOUNCEMENT_NOTIFICATIONS_ENABLED =
				value;

			const out = await dispatchStatusAnnouncementNotifications(NOW);

			expect(out.skipped).toBe(false);
			expect(notificationCreateMany).toHaveBeenCalled();
		},
	);
});

describe("who gets notified", () => {
	it("writes one row per owner/admin per announcement", async () => {
		const out = await dispatchStatusAnnouncementNotifications(NOW);

		expect(rows).toHaveLength(2);
		expect(out).toMatchObject({
			announcementsConsidered: 1,
			announcementsNotified: 1,
			recipientsNotified: 2,
		});
	});

	it("asks only for owners and admins", async () => {
		await dispatchStatusAnnouncementNotifications(NOW);

		expect(memberFindMany.mock.calls[0]?.[0]).toMatchObject({
			where: { role: { in: ["owner", "admin"] } },
		});
	});

	it("attributes each row to the recipient's own organization", async () => {
		// Cross-tenant attribution would put a notification in the wrong workspace.
		await dispatchStatusAnnouncementNotifications(NOW);

		const rows = notificationCreateMany.mock.calls.flatMap(
			(c) => c[0].data,
		);
		expect(rows).toEqual([
			expect.objectContaining({ userId: "u1", organizationId: "org_1" }),
			expect.objectContaining({ userId: "u2", organizationId: "org_2" }),
		]);
	});
});

describe("which announcements qualify", () => {
	it("asks the database for MAJOR/CRITICAL, live, platform-wide only", async () => {
		await dispatchStatusAnnouncementNotifications(NOW);

		expect(statusUpdateFindMany.mock.calls[0]?.[0]).toMatchObject({
			where: {
				impact: { in: ["MAJOR", "CRITICAL"] },
				lifecycle: { notIn: ["RESOLVED", "COMPLETED"] },
				affectedProviderKeys: { isEmpty: true },
			},
		});
	});

	it("bounds the scan to a lookback window", async () => {
		await dispatchStatusAnnouncementNotifications(NOW);

		const where = statusUpdateFindMany.mock.calls[0]?.[0]?.where;
		// 24h before NOW — re-enabling the flag must not notify about old incidents.
		expect(where.startedAt.gte).toEqual(
			new Date("2026-08-06T12:00:00.000Z"),
		);
	});

	it("does nothing when there is nothing live to announce", async () => {
		statusUpdateFindMany.mockResolvedValue([]);

		const out = await dispatchStatusAnnouncementNotifications(NOW);

		expect(out).toMatchObject({
			skipped: true,
			skipReason: "no-notifiable-announcements",
		});
		expect(organizationFindMany).not.toHaveBeenCalled();
		expect(notificationCreateMany).not.toHaveBeenCalled();
	});
});

describe("a recipient who READS the notification while the announcement is live", () => {
	// The partial unique index is this sweeper's ONLY dedupe mechanism, and it stops
	// covering a row once readAt is set. Harmless for an event-driven writer — the
	// event happens once. This is a SWEEPER: it re-attempts the same write every
	// five minutes for as long as the announcement stays live, so "unique among
	// unread rows" is not idempotence at all.
	it("is not notified a second time on the next tick", async () => {
		await dispatchStatusAnnouncementNotifications(NOW);
		expect(rows).toHaveLength(2);

		markRead("u1", "status-announcement:su_1:org_1:u1");

		const second = await dispatchStatusAnnouncementNotifications(NOW);

		// Without a read-state-independent check this writes a duplicate — 288 a day
		// at a five-minute cadence, across the 24-hour lookback window.
		expect(second.recipientsNotified).toBe(0);
		expect(rows).toHaveLength(2);
	});

	it("is not notified again after archiving it either", async () => {
		await dispatchStatusAnnouncementNotifications(NOW);
		markRead("u2", "status-announcement:su_1:org_2:u2");

		const second = await dispatchStatusAnnouncementNotifications(NOW);

		expect(second.recipientsNotified).toBe(0);
	});
});

describe("a person who is owner/admin in several organizations", () => {
	// Found on staging, not by a test: the logged-in user was `admin` of one
	// organization and `owner` of another, and the bell showed the announcement in
	// only the first. Every unit fixture had given each member a distinct userId,
	// so "one membership per user" was baked in as though it were a fact — and the
	// dedupeKey assertion passed precisely because it asserted the wrong shape.
	beforeEach(() => {
		memberFindMany.mockResolvedValue([
			{ userId: "multi", organizationId: "org_1" },
			{ userId: "multi", organizationId: "org_2" },
		]);
	});

	it("notifies them once per organization, not once in total", async () => {
		const out = await dispatchStatusAnnouncementNotifications(NOW);

		expect(out.recipientsNotified).toBe(2);
		expect(
			notificationCreateMany.mock.calls
				.flatMap((c) => c[0].data)
				.map((d) => d.organizationId),
		).toEqual(["org_1", "org_2"]);
	});

	it("scopes the dedupe key to the organization as well as the recipient", async () => {
		// The row carries `organizationId` and the bell filters on it, so a key
		// without the organization is coarser than the thing it guards: the partial
		// unique index on (userId, dedupeKey) then makes the second row impossible,
		// and P2002 is read as "already sent" so nothing looks wrong.
		await dispatchStatusAnnouncementNotifications(NOW);

		expect(
			notificationCreateMany.mock.calls
				.flatMap((c) => c[0].data)
				.map((d) => d.dedupeKey),
		).toEqual([
			"status-announcement:su_1:org_1:multi",
			"status-announcement:su_1:org_2:multi",
		]);
	});

	it("still dedupes a repeat within the same organization", async () => {
		// The fix must not cost idempotence, which is the whole basis for running
		// this on a schedule. Dispatch twice: the second pass must write nothing.
		await dispatchStatusAnnouncementNotifications(NOW);
		const out = await dispatchStatusAnnouncementNotifications(NOW);

		expect(out.recipientsNotified).toBe(0);
		expect(out.writeFailures).toBe(0);
		expect(rows).toHaveLength(2);
	});
});

describe("re-running must not re-notify", () => {
	it("keys each row to (announcement, organization, recipient)", async () => {
		await dispatchStatusAnnouncementNotifications(NOW);

		const keys = written().map((d) => d.dedupeKey);
		expect(keys).toEqual([
			"status-announcement:su_1:org_1:u1",
			"status-announcement:su_1:org_2:u2",
		]);
	});

	it("absorbs an already-sent row instead of erroring", async () => {
		// Mechanism changed deliberately: `createMany({ skipDuplicates: true })`
		// compiles to ON CONFLICT DO NOTHING, so a repeat is a `count` of 0 rather
		// than a thrown P2002. Same guarantee, one round trip instead of N, and it
		// cannot poison an enclosing transaction.
		await dispatchStatusAnnouncementNotifications(NOW);
		const out = await dispatchStatusAnnouncementNotifications(NOW);

		expect(out).toMatchObject({
			announcementsNotified: 0,
			recipientsNotified: 0,
			writeFailures: 0,
			skipped: false,
		});
	});

	it("reports a failed batch as failures rather than swallowing it", async () => {
		// Writes are chunked, so a statement-level failure costs that chunk and is
		// counted — never absorbed into a clean-looking run.
		notificationCreateMany.mockRejectedValueOnce(new Error("deadlock"));

		const out = await dispatchStatusAnnouncementNotifications(NOW);

		expect(out.recipientsNotified).toBe(0);
		expect(out.writeFailures).toBe(2);
	});

	it("keeps going for later announcements after one batch fails", async () => {
		statusUpdateFindMany.mockResolvedValue([
			ANNOUNCEMENT,
			{ ...ANNOUNCEMENT, id: "su_2", title: "Second" },
		]);
		notificationCreateMany.mockRejectedValueOnce(new Error("deadlock"));

		const out = await dispatchStatusAnnouncementNotifications(NOW);

		expect(out.writeFailures).toBe(2);
		expect(out.recipientsNotified).toBe(2);
		expect(written().map((d) => d.dedupeKey)).toContain(
			"status-announcement:su_2:org_1:u1",
		);
	});

	it("does not count an already-sent row as a failure", async () => {
		await dispatchStatusAnnouncementNotifications(NOW);
		const out = await dispatchStatusAnnouncementNotifications(NOW);

		expect(out.writeFailures).toBe(0);
	});

	it("batches a page into one statement per announcement", async () => {
		// The point of the change: 2 recipients cost 1 round trip, not 2. At a page
		// of 500 organizations that is ~1,500 collapsed into one.
		await dispatchStatusAnnouncementNotifications(NOW);

		expect(notificationCreateMany).toHaveBeenCalledTimes(1);
		expect(notificationCreateMany.mock.calls[0]?.[0]).toMatchObject({
			skipDuplicates: true,
		});
	});
});

describe("the row it writes is one the product can actually render", () => {
	// The bug this guards: SYSTEM_INCIDENT was the obvious type to reuse, and the
	// bell excludes incident types unless the dedupe key starts with
	// `weekly-digest`, while the row renderer marks them admin-only. Rows would
	// have been written, counted, and invisible to every customer they addressed.
	it("uses STATUS_ANNOUNCEMENT, not an incident type", async () => {
		await dispatchStatusAnnouncementNotifications(NOW);

		for (const row of written()) {
			expect(row.type).toBe("STATUS_ANNOUNCEMENT");
		}
	});

	it("stores the link context-relative so it resolves per workspace", async () => {
		// `resolveNotificationLink` prepends the notification's own base, so a
		// leading slash would send every org recipient to the personal page.
		await dispatchStatusAnnouncementNotifications(NOW);

		const link = notificationCreateMany.mock.calls[0]?.[0].data[0].link;
		expect(link).toBe("system-health");
		expect(link.startsWith("/")).toBe(false);
	});

	it("writes the payload the STATUS_ANNOUNCEMENT schema declares", async () => {
		await dispatchStatusAnnouncementNotifications(NOW);

		expect(
			notificationCreateMany.mock.calls[0]?.[0].data[0].payload,
		).toEqual({
			statusUpdateId: "su_1",
			impact: "MAJOR",
			lifecycle: "INVESTIGATING",
			startedAt: "2026-08-07T11:00:00.000Z",
		});
	});

	it("carries the always-on SYSTEM category", async () => {
		// SYSTEM is absent from CATEGORY_TO_TOGGLE, so an outage notice is not
		// suppressible by a preference toggle — which is why writing the row
		// directly bypasses no preference check.
		await dispatchStatusAnnouncementNotifications(NOW);

		expect(notificationCreateMany.mock.calls[0]?.[0].data[0].category).toBe(
			"SYSTEM",
		);
	});

	it("uses the announcement body as the snippet, bounded", async () => {
		statusUpdateFindMany.mockResolvedValue([
			{ ...ANNOUNCEMENT, body: "x".repeat(400) },
		]);

		await dispatchStatusAnnouncementNotifications(NOW);

		expect(
			notificationCreateMany.mock.calls[0]?.[0].data[0].snippet,
		).toHaveLength(280);
	});
});

describe("every organization is reached, not just the first page", () => {
	/** `n` organizations served in pages of `size`, then an empty page. */
	function paginate(n: number, size: number): void {
		organizationFindMany.mockReset();
		for (let start = 0; start < n; start += size) {
			organizationFindMany.mockResolvedValueOnce(
				Array.from({ length: Math.min(size, n - start) }, (_, i) => ({
					id: `org_${String(start + i).padStart(6, "0")}`,
				})),
			);
		}
		organizationFindMany.mockResolvedValue([]);
	}

	it("keeps paging past the page size until organizations run out", async () => {
		// The bug this catches: a truncating `take: 500` with a stable `id asc`
		// ordering re-processes the SAME first page every run, so organization 501
		// is never notified — and a stateless sweeper has nowhere to record a
		// resume point, so "the rest next tick" never happens.
		paginate(1200, 500);
		memberFindMany.mockResolvedValue([]);

		const out = await dispatchStatusAnnouncementNotifications(NOW);

		expect(out.organizationsScanned).toBe(1200);
		expect(out.organizationsDeferred).toBe(0);
	});

	it("advances the cursor rather than re-reading page one", async () => {
		paginate(1000, 500);
		memberFindMany.mockResolvedValue([]);

		await dispatchStatusAnnouncementNotifications(NOW);

		const calls = organizationFindMany.mock.calls.map((c) => c[0]);
		expect(calls[0].cursor).toBeUndefined();
		// Second page resumes after the last id of the first, and skips it.
		expect(calls[1]).toMatchObject({
			cursor: { id: "org_000499" },
			skip: 1,
		});
	});

	it("notifies recipients found on a later page", async () => {
		paginate(1000, 500);
		memberFindMany
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([
				{ userId: "late_user", organizationId: "org_000600" },
			])
			.mockResolvedValue([]);

		const out = await dispatchStatusAnnouncementNotifications(NOW);

		expect(out.recipientsNotified).toBe(1);
		expect(notificationCreateMany.mock.calls[0]?.[0].data[0].userId).toBe(
			"late_user",
		);
	});

	it("reports the shortfall as a count when the page backstop trips", async () => {
		// 250 pages of 500 is the backstop. Serve more than that and the remainder
		// must arrive as a number — silence would read as full coverage.
		organizationFindMany.mockReset();
		organizationFindMany.mockImplementation(async () =>
			Array.from({ length: 500 }, (_, i) => ({
				id: `org_${String(i).padStart(6, "0")}`,
			})),
		);
		memberFindMany.mockResolvedValue([]);
		organizationCount.mockResolvedValue(42);

		const out = await dispatchStatusAnnouncementNotifications(NOW);

		expect(out.organizationsDeferred).toBe(42);
		expect(organizationFindMany).toHaveBeenCalledTimes(250);
	});

	it("handles a deployment with no organizations", async () => {
		organizationFindMany.mockReset();
		organizationFindMany.mockResolvedValue([]);

		const out = await dispatchStatusAnnouncementNotifications(NOW);

		expect(out.announcementsConsidered).toBe(1);
		expect(out.organizationsScanned).toBe(0);
		expect(notificationCreateMany).not.toHaveBeenCalled();
	});
});

describe("the write path is batched, measurably", () => {
	// The performance lens computed that a sequential write loop needs ~15,000 round
	// trips for 5,000 organizations at ~3 owners/admins each, which is what pushed a
	// large deployment past the activity's 5-minute budget. This pins the collapse so
	// a future refactor back to per-row `create` fails here rather than in production.
	it("costs one statement per (page, announcement), not one per recipient", async () => {
		const ORGS = 500;
		const ADMINS_PER_ORG = 3;

		organizationFindMany.mockImplementation(
			async (args: { cursor?: { id: string } }) =>
				args?.cursor
					? []
					: Array.from({ length: ORGS }, (_, i) => ({
							id: `org_${String(i).padStart(6, "0")}`,
						})),
		);
		memberFindMany.mockImplementation(
			async (args: { where: { organizationId: { in: string[] } } }) =>
				args.where.organizationId.in.flatMap((organizationId) =>
					Array.from({ length: ADMINS_PER_ORG }, (_, i) => ({
						userId: `${organizationId}_admin_${i}`,
						organizationId,
					})),
				),
		);

		const out = await dispatchStatusAnnouncementNotifications(NOW);

		const total = ORGS * ADMINS_PER_ORG; // 1,500
		expect(out.recipientsNotified).toBe(total);

		// 1,500 rows in chunks of WRITE_CHUNK_SIZE (500) — three round trips, not
		// 1,500. The chunking is deliberate: it bounds how much one failed statement
		// can lose and keeps the parameter count inside Postgres limits.
		expect(notificationCreateMany).toHaveBeenCalledTimes(3);
		expect(written()).toHaveLength(total);
		for (const call of notificationCreateMany.mock.calls) {
			expect(call[0].data.length).toBeLessThanOrEqual(500);
		}
	});

	it("heartbeats once per organization page so a superseded attempt can stop", async () => {
		// Without this the server times an attempt out and starts a retry while the
		// original loop keeps running, so two passes write against the same rows.
		const beats: unknown[] = [];
		organizationFindMany.mockImplementation(
			async (args: { cursor?: { id: string } }) =>
				args?.cursor === undefined
					? [{ id: "org_1" }]
					: args.cursor.id === "org_1"
						? [{ id: "org_2" }]
						: [],
		);
		memberFindMany.mockResolvedValue([]);

		await dispatchStatusAnnouncementNotifications(NOW, (p) => {
			beats.push(p);
		});

		expect(beats).toHaveLength(2);
		expect(beats[1]).toMatchObject({ organizationsScanned: 2 });
	});
});

describe("a future-scheduled maintenance window", () => {
	it("is excluded by the query, not treated as happening now", async () => {
		// `createStatusUpdate` defaults `startedAt` to publish time regardless of
		// `scheduledFor`, and SCHEDULED is not a terminal lifecycle — so without an
		// explicit filter a maintenance window announced today for next week would
		// notify every owner/admin today, as if the platform were degraded now.
		await dispatchStatusAnnouncementNotifications(NOW);

		const where = statusUpdateFindMany.mock.calls[0]?.[0]?.where;
		expect(where.OR).toEqual([
			{ scheduledFor: null },
			{ scheduledFor: { lte: NOW } },
		]);
	});
});

describe("the snippet is cut safely", () => {
	it("marks truncation with an ellipsis, like every sibling writer", async () => {
		statusUpdateFindMany.mockResolvedValue([
			{ ...ANNOUNCEMENT, body: "x".repeat(400) },
		]);

		await dispatchStatusAnnouncementNotifications(NOW);

		const snippet = written()[0]?.snippet as string;
		expect(Array.from(snippet)).toHaveLength(280);
		expect(snippet.endsWith("…")).toBe(true);
	});

	it("does not split an astral character into a lone surrogate", async () => {
		// Sliced by code point, not UTF-16 unit: a body whose 280th unit lands
		// mid-surrogate would otherwise end in a broken glyph. Asserted via
		// toWellFormed(), which is exactly the "no unpaired surrogate" property.
		const emoji = String.fromCodePoint(0x1f600);
		const body = `${"a".repeat(279)}${emoji}${"b".repeat(50)}`;
		statusUpdateFindMany.mockResolvedValue([{ ...ANNOUNCEMENT, body }]);

		await dispatchStatusAnnouncementNotifications(NOW);

		const snippet = written()[0]?.snippet as string;
		// A lone HIGH surrogate at the end is exactly what a UTF-16 slice leaves
		// behind. Checked by code unit rather than `toWellFormed()`, which needs an
		// ES2024 lib this package does not target.
		const last = snippet.charCodeAt(snippet.length - 1);
		expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
		// And the emoji is either wholly present or wholly absent, never halved.
		expect(snippet.includes(emoji.charAt(0))).toBe(snippet.includes(emoji));
	});

	it("leaves a short body untouched", async () => {
		await dispatchStatusAnnouncementNotifications(NOW);

		expect(written()[0]?.snippet).toBe(ANNOUNCEMENT.body);
	});
});

describe("a cancelled attempt stops writing", () => {
	// Heartbeating alone does NOT interrupt an activity — the SDK's own type doc says
	// "Cancellation is not propagated from this function". So the progress callback
	// returning false is the only thing that actually stops the sweep, and without it
	// a superseded attempt kept writing to natural completion while its retry ran
	// concurrently against the same rows.
	beforeEach(() => {
		organizationFindMany.mockImplementation(
			async (args: { cursor?: { id: string } }) =>
				args?.cursor === undefined
					? [{ id: "org_1" }]
					: args.cursor.id === "org_1"
						? [{ id: "org_2" }]
						: [],
		);
		memberFindMany.mockImplementation(
			async (args: { where: { organizationId: { in: string[] } } }) =>
				args.where.organizationId.in.map((organizationId) => ({
					userId: `${organizationId}_admin`,
					organizationId,
				})),
		);
	});

	it("stops paging once the caller reports cancellation", async () => {
		let calls = 0;
		const out = await dispatchStatusAnnouncementNotifications(NOW, () => {
			calls++;
			return false; // superseded on the very first batch
		});

		// One page's writes happened; the second page was never fetched.
		expect(out.organizationsScanned).toBe(1);
		expect(calls).toBe(1);
	});

	it("keeps going while the caller reports it is still current", async () => {
		const out = await dispatchStatusAnnouncementNotifications(
			NOW,
			() => true,
		);

		expect(out.organizationsScanned).toBe(2);
		expect(out.recipientsNotified).toBe(2);
	});

	it("treats a void return as 'still current', so the hook stays optional", async () => {
		const out = await dispatchStatusAnnouncementNotifications(
			NOW,
			() => {},
		);

		expect(out.organizationsScanned).toBe(2);
	});
});
