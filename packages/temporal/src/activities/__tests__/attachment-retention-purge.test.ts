import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findMany: vi.fn(),
	deleteMany: vi.fn(),
	deleteObjects: vi.fn(),
	resolveOverrides: vi.fn(),
	minOverride: vi.fn(),
	heartbeat: vi.fn(),
	loggerInfo: vi.fn(),
	loggerWarn: vi.fn(),
	loggerError: vi.fn(),
}));

vi.mock("@repo/storage", () => ({
	deleteObjects: (...a: unknown[]) => mocks.deleteObjects(...a),
}));

// NOTE: `@repo/utils/attachment` is deliberately NOT mocked — the production
// constants (90 / 30 / 3650 / 7) stay live under test, which is the whole point
// of holding them in one place.
vi.mock("@repo/database", () => ({
	db: {
		storyAttachment: {
			findMany: (...a: unknown[]) => mocks.findMany(...a),
			deleteMany: (...a: unknown[]) => mocks.deleteMany(...a),
		},
	},
	resolveAttachmentRetentionOverrides: (...a: unknown[]) =>
		mocks.resolveOverrides(...a),
	getMinimumAttachmentRetentionOverride: (...a: unknown[]) =>
		mocks.minOverride(...a),
}));

vi.mock("@repo/config", () => ({
	config: {
		storage: { bucketNames: { projectContexts: "project-contexts" } },
	},
}));

vi.mock("@repo/logs", () => ({
	logger: {
		info: mocks.loggerInfo,
		warn: mocks.loggerWarn,
		error: mocks.loggerError,
		log: vi.fn(),
	},
}));

vi.mock("@temporalio/activity", () => ({ heartbeat: mocks.heartbeat }));

// Import AFTER the mocks so the activity captures them.
import {
	hasExpired,
	isPurgeable,
	parseProjectIdFromStorageKey,
	purgeExpiredAttachmentsActivity,
} from "../attachment-retention-purge";

const DAYS = "FABRIC_ATTACHMENT_RETENTION_DAYS";

/**
 * Old enough to be expired under every window these tests configure (the
 * longest is 365), yet still inside the 3650-day maximum — the "re-reads the
 * window" case needs a mid-run lengthening to 3650 to actually withhold the
 * row. Computed relative to now rather than written as a literal date so
 * neither half of that pair can silently stop holding as the calendar moves.
 */
const LONG_AGO = new Date(Date.now() - 2000 * 86_400_000);

const row = (id: string, key: string, deletedAt: Date = LONG_AGO) => ({
	id,
	storageKey: key,
	deletedAt,
});

function manyRows(n: number, startIdx = 0) {
	return Array.from({ length: n }, (_, i) =>
		row(
			`id${String(startIdx + i).padStart(6, "0")}`,
			`story-attachments/p/s/k${String(startIdx + i).padStart(6, "0")}.png`,
		),
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	delete process.env[DAYS];
	mocks.deleteObjects.mockResolvedValue({ deleted: 0, errors: [] });
	mocks.deleteMany.mockResolvedValue({ count: 0 });
	mocks.minOverride.mockResolvedValue(null);
	// Total map: every requested id resolves, none overridden. An unconfigured
	// vi.fn() would resolve undefined and `.get()` on it would throw.
	mocks.resolveOverrides.mockImplementation(
		async (ids: string[]) =>
			new Map(
				ids.map((id) => [id, { days: null, settingChangedAt: null }]),
			),
	);
});

afterEach(() => {
	delete process.env[DAYS];
});

describe("purgeExpiredAttachmentsActivity", () => {
	it("object-first: deletes objects then rows for a single page, then stops on empty next page", async () => {
		mocks.findMany
			.mockResolvedValueOnce([
				row("a", "story-attachments/p/s/1.png"),
				row("b", "story-attachments/p/s/2.png"),
			])
			.mockResolvedValueOnce([]);
		mocks.deleteObjects.mockResolvedValueOnce({ deleted: 2, errors: [] });
		mocks.deleteMany.mockResolvedValueOnce({ count: 2 });

		const r = await purgeExpiredAttachmentsActivity();

		// object delete happened BEFORE row delete
		const objOrder = mocks.deleteObjects.mock.invocationCallOrder[0];
		const rowOrder = mocks.deleteMany.mock.invocationCallOrder[0];
		expect(objOrder).toBeLessThan(rowOrder);
		expect(mocks.deleteObjects).toHaveBeenCalledWith(
			["story-attachments/p/s/1.png", "story-attachments/p/s/2.png"],
			{ bucket: "project-contexts" },
		);
		expect(mocks.deleteMany).toHaveBeenCalledWith({
			where: { id: { in: ["a", "b"] } },
		});
		expect(r).toMatchObject({ deletedObjects: 2, deletedRows: 2 });
	});

	it("only deletes rows whose object delete succeeded; keeps error rows", async () => {
		mocks.findMany
			.mockResolvedValueOnce([
				row("a", "story-attachments/p/s/ok.png"),
				row("b", "story-attachments/p/s/bad.png"),
			])
			.mockResolvedValueOnce([]);
		mocks.deleteObjects.mockResolvedValueOnce({
			deleted: 1,
			errors: [{ key: "story-attachments/p/s/bad.png", message: "boom" }],
		});
		mocks.deleteMany.mockResolvedValueOnce({ count: 1 });

		const r = await purgeExpiredAttachmentsActivity();

		expect(mocks.deleteMany).toHaveBeenCalledWith({
			where: { id: { in: ["a"] } },
		});
		expect(r).toMatchObject({
			deletedObjects: 1,
			deletedRows: 1,
			objectErrors: 1,
		});
	});

	it("all-errored page makes no row deletes yet terminates (keyset advances, no infinite loop)", async () => {
		mocks.findMany
			.mockResolvedValueOnce([
				row("a", "story-attachments/p/s/1.png"),
				row("b", "story-attachments/p/s/2.png"),
			]) // page 1
			.mockResolvedValueOnce([]); // keyset exhausted
		mocks.deleteObjects.mockResolvedValueOnce({
			deleted: 0,
			errors: [
				{ key: "story-attachments/p/s/1.png", message: "x" },
				{ key: "story-attachments/p/s/2.png", message: "x" },
			],
		});

		const r = await purgeExpiredAttachmentsActivity();

		expect(mocks.deleteMany).not.toHaveBeenCalled();
		// second findMany uses a KEYSET predicate after the last processed id ("b") —
		// NOT a Prisma `cursor` (which would require the boundary row to still exist).
		expect(mocks.findMany.mock.calls[1][0].where).toMatchObject({
			id: { gt: "b" },
		});
		expect(mocks.findMany.mock.calls[1][0]).not.toHaveProperty("cursor");
		expect(r.deletedRows).toBe(0);
	});

	it("successful page advances keyset (second query uses id.gt of the deleted boundary row)", async () => {
		// The boundary id "b" IS deleted on a successful page; the keyset predicate must
		// still work (regression for the Prisma-cursor-requires-live-row bug).
		mocks.findMany
			.mockResolvedValueOnce([
				row("a", "story-attachments/p/s/a.png"),
				row("b", "story-attachments/p/s/b.png"),
			])
			.mockResolvedValueOnce([]);
		mocks.deleteObjects.mockResolvedValueOnce({ deleted: 2, errors: [] });
		mocks.deleteMany.mockResolvedValueOnce({ count: 2 });

		await purgeExpiredAttachmentsActivity();

		expect(mocks.deleteMany).toHaveBeenCalledWith({
			where: { id: { in: ["a", "b"] } },
		});
		expect(mocks.findMany.mock.calls[1][0].where).toMatchObject({
			id: { gt: "b" },
		});
		expect(mocks.findMany.mock.calls[1][0]).not.toHaveProperty("cursor");
	});

	it("rows inside the window are not selected (cutoff respected)", async () => {
		process.env[DAYS] = "30";
		mocks.findMany.mockResolvedValueOnce([]);
		await purgeExpiredAttachmentsActivity();
		const whereArg = mocks.findMany.mock.calls[0][0].where;
		expect(whereArg.deletedAt.lt).toBeInstanceOf(Date);
		// cutoff ≈ now - 30d
		const cutoff = whereArg.deletedAt.lt.getTime();
		expect(Math.abs(cutoff - (Date.now() - 30 * 86_400_000))).toBeLessThan(
			60_000,
		);
	});

	it("readRetentionDays: unset/invalid/≤0/sub-1 fall back to 90", async () => {
		// "0.5" floors to 0 (< 1) → must fall back, never collapse the cutoff to "now".
		for (const v of [undefined, "0", "-5", "abc", "0.5"]) {
			vi.clearAllMocks();
			if (v === undefined) {
				delete process.env[DAYS];
			} else {
				process.env[DAYS] = v;
			}
			mocks.findMany.mockResolvedValueOnce([]);
			mocks.deleteObjects.mockResolvedValue({ deleted: 0, errors: [] });
			mocks.deleteMany.mockResolvedValue({ count: 0 });
			const r = await purgeExpiredAttachmentsActivity();
			expect(r.retentionDays).toBe(90);
		}
	});

	it("readRetentionDays floors fractional days to whole days (1.5 → 1)", async () => {
		process.env[DAYS] = "1.5";
		mocks.findMany.mockResolvedValueOnce([]);
		const r = await purgeExpiredAttachmentsActivity();
		expect(r.retentionDays).toBe(1);
	});

	it("keeps the whole slice (no row delete) when deleteObjects result is ambiguous (deleted + errors < slice)", async () => {
		mocks.findMany
			.mockResolvedValueOnce([
				row("a", "story-attachments/p/s/a.png"),
				row("b", "story-attachments/p/s/b.png"),
			])
			.mockResolvedValueOnce([]);
		// ambiguous: 1 deleted, 0 errors, but slice has 2 → 1 key unaccounted
		mocks.deleteObjects.mockResolvedValueOnce({ deleted: 1, errors: [] });
		const r = await purgeExpiredAttachmentsActivity();

		// PRECONDITION: the slice really did reach the object delete, so it is the
		// ambiguity guard keeping these rows — not an upstream eligibility filter.
		// Without this, "deleteMany not called" and "deletedRows === 0" hold
		// identically either way, and the guard could rot into dead code unnoticed.
		expect(mocks.deleteObjects).toHaveBeenCalledWith(
			["story-attachments/p/s/a.png", "story-attachments/p/s/b.png"],
			{ bucket: "project-contexts" },
		);
		expect(r.filteredOut).toBe(0);
		expect(r.skippedUnattributed).toBe(0);
		expect(r.skippedUnresolved).toBe(0);
		expect(mocks.deleteMany).not.toHaveBeenCalled();
		expect(r.deletedRows).toBe(0);
	});

	it("MAX_DELETIONS budget caps successful object deletes per run", async () => {
		// One page of 2000 rows; deleteObjects reports deleted: 2000.
		// After processing that page, remainingBudget drops to 0 → hitDeletionCap.
		// The loop must stop: second findMany is never called.
		const page = manyRows(2000, 0);
		mocks.findMany.mockResolvedValueOnce(page);
		mocks.deleteObjects.mockResolvedValueOnce({
			deleted: 2000,
			errors: [],
		});
		mocks.deleteMany.mockResolvedValueOnce({ count: 2000 });

		const r = await purgeExpiredAttachmentsActivity();

		expect(r.hitDeletionCap).toBe(true);
		expect(r.deletedObjects).toBe(2000);
		// The loop stopped — no second findMany call needed.
		expect(mocks.findMany).toHaveBeenCalledTimes(1);
	});

	it("does not delete a row that is still inside its window", async () => {
		// Without this, giving every fixture a long-past deletedAt would make the
		// whole suite pass even against an isPurgeable stubbed to `() => true` —
		// the constraint meant to prove "no regression" would be the thing
		// blinding the suite.
		const fresh = new Date(Date.now() - 5 * 86_400_000);
		mocks.findMany
			.mockResolvedValueOnce([
				row("old", "story-attachments/p/s/old.png"),
				row("new", "story-attachments/p/s/new.png", fresh),
			])
			.mockResolvedValueOnce([]);
		mocks.deleteObjects.mockResolvedValue({ deleted: 1, errors: [] });
		mocks.deleteMany.mockResolvedValue({ count: 1 });

		const r = await purgeExpiredAttachmentsActivity();

		expect(mocks.deleteObjects).toHaveBeenCalledWith(
			["story-attachments/p/s/old.png"],
			{ bucket: "project-contexts" },
		);
		expect(mocks.deleteMany).toHaveBeenCalledWith({
			where: { id: { in: ["old"] } },
		});
		expect(r.deletedRows).toBe(1);
		expect(r.filteredOut).toBe(1);
	});

	it("uses the smallest usable override as the scan bound", async () => {
		mocks.minOverride.mockResolvedValue(30);
		mocks.findMany.mockResolvedValueOnce([]);
		const r = await purgeExpiredAttachmentsActivity();
		expect(r.minWindowDays).toBe(30);
		const cutoff = mocks.findMany.mock.calls[0][0].where.deletedAt
			.lt as Date;
		expect(
			Math.abs(cutoff.getTime() - (Date.now() - 30 * 86_400_000)),
		).toBeLessThan(60_000);
	});

	it("uses the server default as the scan bound when it is the smaller of the two", async () => {
		// The previous test alone does NOT discriminate: with serverDefault 90 and
		// an override of 30, `Math.min(90, 30)` and "just use the override" both
		// yield 30. This case inverts the pair so only the min is correct — an
		// implementation that ignored serverDefault would report 90 here.
		process.env[DAYS] = "30";
		mocks.minOverride.mockResolvedValue(90);
		mocks.findMany.mockResolvedValueOnce([]);
		const r = await purgeExpiredAttachmentsActivity();
		expect(r.minWindowDays).toBe(30);
		expect(r.retentionDays).toBe(30);
	});

	it("never widens the scan past the server default when every override is longer", async () => {
		// The mutation this exists to catch is `minOverride ?? serverDefault`
		// (dropping the min). It is the worst failure the feature can have: ONE
		// tenant setting 3650 would move the cutoff to now-3650d, so every tenant
		// still on the default stops being scanned and the purge silently does
		// nothing, forever, with no error.
		mocks.minOverride.mockResolvedValue(3650);
		mocks.findMany.mockResolvedValueOnce([]);

		const r = await purgeExpiredAttachmentsActivity();

		expect(r.minWindowDays).toBe(90);
		const cutoff = mocks.findMany.mock.calls[0][0].where.deletedAt
			.lt as Date;
		expect(
			Math.abs(cutoff.getTime() - (Date.now() - 90 * 86_400_000)),
		).toBeLessThan(60_000);
	});

	it("applies the override's actual length (365), not merely 'longer than 90'", async () => {
		// Pinned from BOTH sides. Asserting only that a 120-day row survives would
		// also pass for `retentionDays = MAX` or "keep anything with an override".
		mocks.minOverride.mockResolvedValue(90);
		mocks.resolveOverrides.mockResolvedValue(
			new Map([["p", { days: 365, settingChangedAt: null }]]),
		);
		mocks.findMany
			.mockResolvedValueOnce([
				row(
					"keep",
					"story-attachments/p/s/keep.png",
					new Date(Date.now() - 364 * 86_400_000),
				),
				row(
					"purge",
					"story-attachments/p/s/purge.png",
					new Date(Date.now() - 366 * 86_400_000),
				),
			])
			.mockResolvedValueOnce([]);
		mocks.deleteObjects.mockResolvedValue({ deleted: 1, errors: [] });
		mocks.deleteMany.mockResolvedValue({ count: 1 });

		const r = await purgeExpiredAttachmentsActivity();

		expect(mocks.deleteObjects).toHaveBeenCalledWith(
			["story-attachments/p/s/purge.png"],
			{ bucket: "project-contexts" },
		);
		expect(mocks.deleteMany).toHaveBeenCalledWith({
			where: { id: { in: ["purge"] } },
		});
		expect(r.filteredOut).toBe(1);
	});

	it("uses the env server default verbatim, never re-sanitized", async () => {
		// readRetentionDays accepts 1..3650; the TENANT floor is 30. That asymmetry
		// is deliberate — the env var is an operator-level deployment control and
		// #1702's runbook documents lowering it to 1 as the emergency drain,
		// whereas a tenant setting is changed by an admin through a UI and needs a
		// floor that keeps the nightly scan selective. The mutation
		// `sanitizeRetentionDays(serverDefault)` would silently turn an operator's
		// emergency 1-day window into 90 — the sanitizer's floor is 30, so 1 maps
		// to null and falls back to the default.
		process.env[DAYS] = "1";
		const twoDays = new Date(Date.now() - 2 * 86_400_000);
		mocks.findMany
			.mockResolvedValueOnce([
				row("a", "story-attachments/p/s/a.png", twoDays),
			])
			.mockResolvedValueOnce([]);
		mocks.deleteObjects.mockResolvedValue({ deleted: 1, errors: [] });
		mocks.deleteMany.mockResolvedValue({ count: 1 });

		const r = await purgeExpiredAttachmentsActivity();

		expect(r.minWindowDays).toBe(1);
		expect(mocks.deleteMany).toHaveBeenCalledWith({
			where: { id: { in: ["a"] } },
		});
		expect(r.filteredOut).toBe(0);
	});

	it("skips a row whose storageKey cannot be attributed to a project", async () => {
		mocks.findMany
			.mockResolvedValueOnce([row("a", "k1")])
			.mockResolvedValueOnce([]);
		const r = await purgeExpiredAttachmentsActivity();
		expect(mocks.deleteObjects).not.toHaveBeenCalled();
		expect(mocks.deleteMany).not.toHaveBeenCalled();
		expect(r.skippedUnattributed).toBe(1);
	});

	it("skips a row whose project is absent from the resolver map", async () => {
		mocks.resolveOverrides.mockResolvedValue(new Map());
		mocks.findMany
			.mockResolvedValueOnce([row("a", "story-attachments/p/s/a.png")])
			.mockResolvedValueOnce([]);
		const r = await purgeExpiredAttachmentsActivity();
		// deleteObjects first: it is the IRREVERSIBLE half. A mutation that skipped
		// only at the row-delete stage would destroy the R2 object and keep the
		// row, and asserting deleteMany alone would not notice.
		expect(mocks.deleteObjects).not.toHaveBeenCalled();
		expect(mocks.deleteMany).not.toHaveBeenCalled();
		expect(r.skippedUnresolved).toBe(1);
	});

	it("advances the keyset past the PAGE's last row, not the purgeable subset's", async () => {
		// The realistic mutation is `slice.at(-1)?.id ?? page.at(-1)?.id`, which an
		// all-unpurgeable page cannot catch (it falls through to the page's last
		// row anyway). It needs a MIXED page whose filtered row is LAST — otherwise
		// every page's unexpired tail is re-fetched on every iteration, up to
		// MAX_PAGES.
		const fresh = new Date(Date.now() - 1 * 86_400_000);
		mocks.findMany
			.mockResolvedValueOnce([
				row("a", "story-attachments/p/s/a.png"),
				row("b", "story-attachments/p/s/b.png", fresh),
			])
			.mockResolvedValueOnce([]);
		mocks.deleteObjects.mockResolvedValue({ deleted: 1, errors: [] });
		mocks.deleteMany.mockResolvedValue({ count: 1 });

		const r = await purgeExpiredAttachmentsActivity();

		expect(mocks.findMany.mock.calls[1][0].where.id).toEqual({ gt: "b" });
		// `scanned` counts row VISITS, not deletions. Nothing else in the suite
		// asserts it, and Step 8 changes its meaning from slice to page length.
		expect(r.scanned).toBe(2);
	});

	it("terminates against a keyset-honouring store when a whole page is unpurgeable", async () => {
		// Every other test scripts findMany with mockResolvedValueOnce, so the mock
		// ignores `where` and the loop would terminate even if lastId never
		// advanced. Modelling the keyset makes a non-advancing lastId actually hang
		// instead of silently "passing".
		const fresh = new Date(Date.now() - 1 * 86_400_000);
		const all = [
			row("a", "story-attachments/p/s/a.png", fresh),
			row("b", "story-attachments/p/s/b.png", fresh),
		];
		mocks.findMany.mockImplementation(async (args: any) => {
			const gt = args?.where?.id?.gt;
			return gt === undefined ? all : all.filter((r) => r.id > gt);
		});

		const r = await purgeExpiredAttachmentsActivity();

		expect(r.filteredOut).toBe(2);
		expect(mocks.findMany).toHaveBeenCalledTimes(2);
		expect(mocks.deleteObjects).not.toHaveBeenCalled();
	});

	it("heartbeats on a page where nothing was purgeable", async () => {
		// The page consumes no budget and deletes nothing, so without an explicit
		// heartbeat on the continue path a long unexpired stretch trips the
		// 2-minute heartbeatTimeout and kills the run. Deleting that call is
		// otherwise invisible to every other test.
		const fresh = new Date(Date.now() - 1 * 86_400_000);
		mocks.findMany
			.mockResolvedValueOnce([
				row("a", "story-attachments/p/s/a.png", fresh),
			])
			.mockResolvedValueOnce([]);

		await purgeExpiredAttachmentsActivity();

		expect(mocks.heartbeat).toHaveBeenCalledTimes(1);
	});

	it("re-reads the window every page so a mid-run lengthening is honoured", async () => {
		// Asserting only the call COUNT would pass for a memoising implementation
		// that still calls the resolver with an empty id list for cached projects.
		// Assert the ARGUMENT and the effect.
		mocks.findMany
			.mockResolvedValueOnce([row("a", "story-attachments/p/s/a.png")])
			.mockResolvedValueOnce([row("b", "story-attachments/p/s/b.png")])
			.mockResolvedValueOnce([]);
		mocks.resolveOverrides
			.mockResolvedValueOnce(
				new Map([["p", { days: null, settingChangedAt: null }]]),
			)
			.mockResolvedValueOnce(
				new Map([["p", { days: 3650, settingChangedAt: null }]]),
			);
		mocks.deleteObjects.mockResolvedValue({ deleted: 1, errors: [] });
		mocks.deleteMany.mockResolvedValue({ count: 1 });

		const r = await purgeExpiredAttachmentsActivity();

		expect(mocks.minOverride).toHaveBeenCalledTimes(1);
		expect(mocks.resolveOverrides).toHaveBeenCalledTimes(2);
		expect(mocks.resolveOverrides.mock.calls[1][0]).toEqual(["p"]);
		expect(mocks.deleteMany).toHaveBeenCalledTimes(1);
		expect(mocks.deleteMany).toHaveBeenCalledWith({
			where: { id: { in: ["a"] } },
		});
		expect(r.filteredOut).toBe(1);
	});

	it("aborts the run when the minimum query fails", async () => {
		mocks.minOverride.mockRejectedValue(new Error("db down"));
		await expect(purgeExpiredAttachmentsActivity()).rejects.toThrow(
			"db down",
		);
		expect(mocks.deleteObjects).not.toHaveBeenCalled();
	});

	it("aborts the run when per-page resolution fails", async () => {
		mocks.resolveOverrides.mockRejectedValue(new Error("db down"));
		mocks.findMany.mockResolvedValueOnce([
			row("a", "story-attachments/p/s/a.png"),
		]);
		await expect(purgeExpiredAttachmentsActivity()).rejects.toThrow(
			"db down",
		);
		expect(mocks.deleteMany).not.toHaveBeenCalled();
	});

	it("re-fetches from the last PROCESSED id when the budget truncated a page", async () => {
		// Truncation with an all-errored slice consumes no budget, so the loop does
		// NOT break. Advancing to the page's last id here would pass over the
		// page's unprocessed remainder for the rest of the run.
		//
		// The budget must already be partly spent for truncation to occur at all,
		// so page 1 deliberately consumes 1500 of MAX_DELETIONS (2000), leaving 500.
		// Page 2 then has 2000 purgeable rows against a 500 budget. Without this
		// setup the assertion would hold under BOTH the correct and the buggy rule
		// and would prove nothing.
		const page1 = manyRows(1500, 0);
		const page2 = manyRows(2000, 10_000);
		mocks.findMany
			.mockResolvedValueOnce(page1)
			.mockResolvedValueOnce(page2)
			.mockResolvedValueOnce([]);
		mocks.deleteObjects
			.mockResolvedValueOnce({ deleted: 1500, errors: [] })
			.mockResolvedValueOnce({
				deleted: 0,
				errors: page2
					.slice(0, 500)
					.map((r) => ({ key: r.storageKey, message: "x" })),
			});
		mocks.deleteMany.mockResolvedValue({ count: 1500 });

		await purgeExpiredAttachmentsActivity();

		// The third fetch must resume at the last row we actually PROCESSED
		// (index 499 of page 2), not at page 2's last row (index 1999).
		const thirdWhere = mocks.findMany.mock.calls[2][0].where;
		expect(thirdWhere.id.gt).toBe(page2[499].id);
		expect(thirdWhere.id.gt).not.toBe(page2[1999].id);
	});

	it("breaks the deleted rows down by the window each was purged under, across pages", async () => {
		// Two tenants on two different windows in one run. Without the breakdown,
		// "deleted 3 rows" cannot be told apart from "every tenant is still on 90",
		// which is the one question a per-tenant policy has to be able to answer.
		mocks.minOverride.mockResolvedValue(30);
		mocks.resolveOverrides.mockImplementation(
			async (ids: string[]) =>
				new Map(
					ids.map(
						(
							id,
						): [
							string,
							{
								days: number | null;
								settingChangedAt: Date | null;
							},
						] => [
							id,
							id === "short"
								? { days: 30, settingChangedAt: null }
								: { days: null, settingChangedAt: null },
						],
					),
				),
		);
		// The 90 row comes FIRST on purpose: the breakdown is accumulated in a Map,
		// so encountering the windows in descending order is what makes the sort
		// load-bearing. Fixtures that happen to arrive ascending would let a
		// dropped `.sort()` pass.
		mocks.findMany
			.mockResolvedValueOnce([
				row("b", "story-attachments/long/s/b.png"),
				row("a", "story-attachments/short/s/a.png"),
			])
			.mockResolvedValueOnce([
				row("c", "story-attachments/short/s/c.png"),
			])
			.mockResolvedValueOnce([]);
		mocks.deleteObjects
			.mockResolvedValueOnce({ deleted: 2, errors: [] })
			.mockResolvedValueOnce({ deleted: 1, errors: [] });
		mocks.deleteMany
			.mockResolvedValueOnce({ count: 2 })
			.mockResolvedValueOnce({ count: 1 });

		const r = await purgeExpiredAttachmentsActivity();

		// Two pages, so this also pins that the 30-day tally ACCUMULATES rather
		// than being rebuilt per page. Ascending by window, so the nightly log line
		// has the same shape every night.
		expect(r.windowsApplied).toEqual([
			{ windowDays: 30, deleted: 2 },
			{ windowDays: 90, deleted: 1 },
		]);
		expect(r.expiredCandidates).toBe(3);
	});

	it("does not credit a window whose objects all failed to delete", async () => {
		// windowsApplied must count rows actually freed, not rows merely found
		// eligible. Attributing at the candidate stage would report a purge that
		// never happened — precisely the failure this telemetry exists to expose.
		mocks.findMany
			.mockResolvedValueOnce([row("a", "story-attachments/p/s/a.png")])
			.mockResolvedValueOnce([]);
		mocks.deleteObjects.mockResolvedValueOnce({
			deleted: 0,
			errors: [{ key: "story-attachments/p/s/a.png", message: "boom" }],
		});

		const r = await purgeExpiredAttachmentsActivity();

		expect(r.expiredCandidates).toBe(1);
		expect(r.deletedRows).toBe(0);
		expect(r.windowsApplied).toEqual([]);
	});

	it("accounts for every scanned visit in exactly one outcome bucket", async () => {
		// scanned === expiredCandidates + filteredOut + skippedUnattributed +
		// skippedUnresolved. A later edit that adds a fifth outcome without its own
		// counter, or double-counts an existing one, silently turns "scanned 500k"
		// into a number an operator cannot reconcile against anything.
		const fresh = new Date(Date.now() - 5 * 86_400_000);
		mocks.resolveOverrides.mockImplementation(
			async (ids: string[]) =>
				new Map(
					ids
						.filter((id) => id !== "ghost")
						.map(
							(
								id,
							): [
								string,
								{
									days: number | null;
									settingChangedAt: Date | null;
								},
							] => [id, { days: null, settingChangedAt: null }],
						),
				),
		);
		mocks.findMany
			.mockResolvedValueOnce([
				row("purge", "story-attachments/p/s/purge.png"),
				row("young", "story-attachments/p/s/young.png", fresh),
				row("nokey", "not-an-attachment-key"),
				row("noproj", "story-attachments/ghost/s/x.png"),
			])
			.mockResolvedValueOnce([]);
		mocks.deleteObjects.mockResolvedValueOnce({ deleted: 1, errors: [] });
		mocks.deleteMany.mockResolvedValueOnce({ count: 1 });

		const r = await purgeExpiredAttachmentsActivity();

		expect(r).toMatchObject({
			scanned: 4,
			expiredCandidates: 1,
			filteredOut: 1,
			skippedUnattributed: 1,
			skippedUnresolved: 1,
		});
		expect(
			r.expiredCandidates +
				r.filteredOut +
				r.skippedUnattributed +
				r.skippedUnresolved,
		).toBe(r.scanned);
	});
});

describe("parseProjectIdFromStorageKey", () => {
	it("extracts the project segment from a well-formed key", () => {
		expect(
			parseProjectIdFromStorageKey(
				"story-attachments/proj1/story1/a.png",
			),
		).toBe("proj1");
	});

	it("returns null for a key that is not a final attachment key", () => {
		for (const key of [
			"k1",
			"story-attachments/",
			"story-attachments//story1/a.png",
			"story-attachments-tmp/proj1/story1/a.png",
			"other-prefix/proj1/story1/a.png",
		]) {
			expect(parseProjectIdFromStorageKey(key)).toBeNull();
		}
	});
});

describe("hasExpired", () => {
	const now = Date.UTC(2026, 7, 17);
	const daysAgo = (n: number) => new Date(now - n * 86_400_000);

	it("is false strictly at the boundary and true past it", () => {
		expect(
			hasExpired({ deletedAt: daysAgo(90), retentionDays: 90, now }),
		).toBe(false);
		expect(
			hasExpired({
				deletedAt: new Date(now - 90 * 86_400_000 - 1),
				retentionDays: 90,
				now,
			}),
		).toBe(true);
	});
});

describe("isPurgeable", () => {
	const now = Date.UTC(2026, 7, 17);
	const daysAgo = (n: number) => new Date(now - n * 86_400_000);

	it("is false for a null deletedAt", () => {
		// The column is nullable. Coercing a null to epoch would mark the row
		// instantly expired, which is the one direction that loses data.
		expect(
			isPurgeable({
				deletedAt: null,
				retentionDays: 90,
				settingChangedAt: null,
				now,
			}),
		).toBe(false);
	});

	it("is true for an expired row with no recent settings change", () => {
		expect(
			isPurgeable({
				deletedAt: daysAgo(200),
				retentionDays: 90,
				settingChangedAt: null,
				now,
			}),
		).toBe(true);
	});

	it("withholds an expired row inside the grace window", () => {
		expect(
			isPurgeable({
				deletedAt: daysAgo(200),
				retentionDays: 90,
				settingChangedAt: daysAgo(3),
				now,
			}),
		).toBe(false);
	});

	it("releases the row once the grace window has passed", () => {
		expect(
			isPurgeable({
				deletedAt: daysAgo(200),
				retentionDays: 90,
				settingChangedAt: daysAgo(8),
				now,
			}),
		).toBe(true);
	});
});
