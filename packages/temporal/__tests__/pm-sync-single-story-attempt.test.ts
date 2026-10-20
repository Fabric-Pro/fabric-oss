/**
 * `pmSyncSingleStoryWorkflow` runs one sync per run, under its own attempt.
 *
 * The workflow id is one per item with USE_EXISTING, so an enqueue that
 * stamps attempt B while run A is in flight attaches to run A. A's status
 * writes are scoped to attempt A and skip a row that now names B; the run
 * does not sync again for B (it cannot know B's destination, config, actor
 * or force flag). B stays PENDING for the stuck-sync watchdog, which retries
 * it as the project owner without forcing. The run schedules exactly the
 * commands origin/staging schedules: the sync, the failure stamp on a throw,
 * and the PENDING clear in `finally`.
 *
 * One exception in the clear: after an orphaned create (a ticket created but
 * not linked) the clear removes any PENDING on the row, as staging did, so the
 * watchdog cannot retry B against an unlinked row and create a second ticket.
 * `create_unconfirmed` is not that exception: its FAILED stamp overrode any
 * PENDING present when it was written, so a later PENDING belongs to a newer
 * push and survives; the clear removes only this run's own PENDING.
 *
 * The workflow body runs with its real state activities over a simulated
 * `user_story` store; `syncWorkItemToPM` is a fake that writes its outcome
 * scoped to the attempt it was given, as the real activity does.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown> & { id: string };

const h = vi.hoisted(() => ({
	stories: new Map<string, Record<string, unknown> & { id: string }>(),
	/** Activity names in the order the workflow scheduled them. */
	calls: [] as string[],
	/** Each scheduled activity with its argument. */
	args: [] as Array<{ name: string; arg: Record<string, unknown> }>,
	sync: vi.fn(),
}));

function matches(row: Row, where: Record<string, unknown>): boolean {
	return Object.entries(where).every(
		([key, value]) => (row[key] ?? null) === value,
	);
}

vi.mock("@temporalio/workflow", () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
	proxyActivities: () =>
		new Proxy(
			{},
			{
				get:
					(_target, name: string) =>
					async (...args: unknown[]) => {
						h.calls.push(name);
						h.args.push({
							name,
							arg: args[0] as Record<string, unknown>,
						});
						if (name === "syncWorkItemToPM") {
							return h.sync(...args);
						}
						const activities = (await import(
							"../src/activities/pm-integration/record-pm-sync-state"
						)) as unknown as Record<
							string,
							(...a: unknown[]) => Promise<unknown>
						>;
						const activity = activities[name];
						if (!activity) {
							throw new Error(`no activity ${name}`);
						}
						return activity(...args);
					},
			},
		),
}));

vi.mock("@repo/logs", () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@repo/database", () => {
	const rows = h.stories;
	return {
		db: {
			userStory: {
				findUnique: vi.fn(
					async ({ where }: { where: { id: string } }) => {
						const row = rows.get(where.id);
						return row
							? {
									...row,
									project: {
										organizationId: "org-1",
										userId: "u-1",
									},
								}
							: null;
					},
				),
				update: vi.fn(
					async ({
						where,
						data,
					}: {
						where: { id: string };
						data: Record<string, unknown>;
					}) => {
						const row = rows.get(where.id);
						if (!row) {
							throw new Error("Record to update not found.");
						}
						Object.assign(row, data);
						return { ...row };
					},
				),
				updateMany: vi.fn(
					async ({
						where,
						data,
					}: {
						where: Record<string, unknown>;
						data: Record<string, unknown>;
					}) => {
						let count = 0;
						for (const row of rows.values()) {
							if (matches(row, where)) {
								Object.assign(row, data);
								count++;
							}
						}
						return { count };
					},
				),
			},
			mCPServer: { findUnique: vi.fn(async () => null) },
		},
		PmSyncStatus: {
			PENDING: "PENDING",
			SUCCESS: "SUCCESS",
			CONFLICT: "CONFLICT",
			FAILED: "FAILED",
		},
	};
});

vi.mock("../src/activities/pm-integration/record-pm-sync-log", () => ({
	recordPmSyncLog: vi.fn(),
}));

const { pmSyncSingleStoryWorkflow } = await import(
	"../src/workflows/pm-sync-single-story-workflow"
);

const ITEM = "story-1";

/** What an enqueue writes: PENDING for a fresh attempt. */
function stamp(attemptId: string | null): void {
	const row = h.stories.get(ITEM) ?? { id: ITEM };
	Object.assign(row, {
		lastPmSyncStatus: "PENDING",
		lastPmSyncAttemptId: attemptId,
	});
	h.stories.set(ITEM, row);
}

/** The real activity's terminal write: scoped to the attempt it carries. */
function settle(
	input: { pmSyncAttemptId?: string },
	status: "SUCCESS" | "CONFLICT",
): void {
	const row = h.stories.get(ITEM) as Row;
	if (
		input.pmSyncAttemptId === undefined ||
		row.lastPmSyncAttemptId === input.pmSyncAttemptId
	) {
		row.lastPmSyncStatus = status;
	}
}

/** The real activity's orphan record: FAILED by id, whatever the attempt. */
function recordOrphan(): void {
	const row = h.stories.get(ITEM) as Row;
	row.lastPmSyncStatus = "FAILED";
	row.lastPmSyncError = "Card created but not linked";
}

function input(
	pmSyncAttemptId?: string,
	overrides: Record<string, unknown> = {},
) {
	return {
		itemId: ITEM,
		itemType: "story" as const,
		projectId: "project-1",
		mcpConfigId: "config-1",
		containerId: "board-1",
		userId: "u-1",
		organizationId: "org-1",
		triggerSource: "manual-edit" as const,
		...(pmSyncAttemptId ? { pmSyncAttemptId } : {}),
		...overrides,
	};
}

function argOf(name: string): Record<string, unknown> | undefined {
	return h.args.find((a) => a.name === name)?.arg;
}

const SUCCESS = { status: "SUCCESS", pushedAt: "t" };
const CONFLICT = {
	status: "CONFLICT",
	externalId: "PM-1",
	pmCurrent: { title: "", description: "" },
};
const ORPHAN = { status: "FAILED", error: "orphan", pushedAt: "t" };

beforeEach(() => {
	h.stories.clear();
	h.calls.length = 0;
	h.args.length = 0;
	h.sync.mockReset();
});

describe("one sync per run, even when a newer attempt is waiting", () => {
	it("syncs once under its own attempt and leaves the newer PENDING for the watchdog", async () => {
		stamp("attempt-A");
		h.sync.mockImplementation(
			async (args: { pmSyncAttemptId?: string }) => {
				// Another user's enqueue lands while A is pushing.
				stamp("attempt-B");
				settle(args, "SUCCESS");
				return SUCCESS;
			},
		);

		const result = await pmSyncSingleStoryWorkflow(input("attempt-A"));

		expect(result).toEqual({ status: "SUCCESS" });
		expect(h.sync).toHaveBeenCalledTimes(1);
		expect(argOf("syncWorkItemToPM")?.pmSyncAttemptId).toBe("attempt-A");
		expect(h.calls).toEqual([
			"syncWorkItemToPM",
			"clearPmSyncPendingIfLeaked",
		]);
		// A's SUCCESS and A's clear both skipped B's stamp.
		expect(h.stories.get(ITEM)).toMatchObject({
			lastPmSyncStatus: "PENDING",
			lastPmSyncAttemptId: "attempt-B",
		});
	});

	it("a legacy link to another PM tool (PmToolMismatchError) is persisted FAILED with its message", async () => {
		// The failure panel offers Unlink & re-create only for a persisted
		// FAILED row whose error carries this phrase.
		const message =
			"This item is linked to a ticket in a different PM tool, so Fabric did not create a new one in fizzy. To make a new ticket in fizzy, use Unlink & re-create (the old ticket is not deleted).";
		stamp("attempt-A");
		h.sync.mockRejectedValue(
			Object.assign(new Error(message), {
				type: "PmToolMismatchError",
				nonRetryable: true,
			}),
		);

		const result = await pmSyncSingleStoryWorkflow(input("attempt-A"));

		expect(result).toMatchObject({
			status: "FAILED",
			errorClass: "PmToolMismatchError",
		});
		expect(h.stories.get(ITEM)).toMatchObject({
			lastPmSyncStatus: "FAILED",
			lastPmSyncError: message,
		});
	});

	it("after a throw, A's failure write skips B's row and nothing syncs again", async () => {
		stamp("attempt-A");
		h.sync.mockImplementation(async () => {
			stamp("attempt-B");
			throw Object.assign(new Error("PM tool timed out"), {
				type: "PmUpdateError",
			});
		});

		const result = await pmSyncSingleStoryWorkflow(input("attempt-A"));

		expect(result.status).toBe("FAILED");
		expect(h.sync).toHaveBeenCalledTimes(1);
		expect(h.stories.get(ITEM)).toMatchObject({
			lastPmSyncStatus: "PENDING",
			lastPmSyncAttemptId: "attempt-B",
		});
		expect(h.stories.get(ITEM)?.lastPmSyncError).toBeUndefined();
	});
});

describe("the commands are origin/staging's", () => {
	const cases: Array<{
		name: string;
		run: () => void;
		calls: string[];
		status: string;
	}> = [
		{
			name: "success",
			run: () =>
				h.sync.mockImplementation(async (a) => {
					settle(a, "SUCCESS");
					return SUCCESS;
				}),
			calls: ["syncWorkItemToPM", "clearPmSyncPendingIfLeaked"],
			status: "SUCCESS",
		},
		{
			name: "conflict",
			run: () =>
				h.sync.mockImplementation(async (a) => {
					settle(a, "CONFLICT");
					return CONFLICT;
				}),
			calls: ["syncWorkItemToPM", "clearPmSyncPendingIfLeaked"],
			status: "CONFLICT",
		},
		{
			name: "throw",
			run: () => h.sync.mockRejectedValue(new Error("boom")),
			calls: [
				"syncWorkItemToPM",
				"recordPmSyncFailure",
				"clearPmSyncPendingIfLeaked",
			],
			status: "FAILED",
		},
		{
			name: "orphaned create",
			run: () =>
				h.sync.mockImplementation(async () => {
					recordOrphan();
					return ORPHAN;
				}),
			calls: ["syncWorkItemToPM", "clearPmSyncPendingIfLeaked"],
			status: "FAILED",
		},
		{
			name: "unconfirmed create",
			run: () =>
				h.sync.mockImplementation(async () => {
					recordOrphan();
					return { ...ORPHAN, errorClass: "create_unconfirmed" };
				}),
			calls: ["syncWorkItemToPM", "clearPmSyncPendingIfLeaked"],
			status: "FAILED",
		},
	];

	for (const attemptId of ["attempt-A", undefined]) {
		for (const c of cases) {
			it(`${c.name}, ${attemptId ? "with" : "without"} an attempt id`, async () => {
				stamp(attemptId ?? null);
				c.run();

				const result = await pmSyncSingleStoryWorkflow(
					input(attemptId),
				);

				expect(result.status).toBe(c.status);
				expect(h.calls).toEqual(c.calls);
			});
		}
	}
});

describe("activity arguments", () => {
	it("threads the attempt id into the sync, the failure stamp and the clear", async () => {
		stamp("attempt-A");
		h.sync.mockRejectedValue(new Error("boom"));

		await pmSyncSingleStoryWorkflow(input("attempt-A"));

		expect(argOf("syncWorkItemToPM")?.pmSyncAttemptId).toBe("attempt-A");
		expect(argOf("recordPmSyncFailure")?.onlyIfAttempt).toBe("attempt-A");
		expect(argOf("clearPmSyncPendingIfLeaked")).toEqual({
			itemId: ITEM,
			itemType: "story",
			attemptId: "attempt-A",
		});
	});

	it("passes pushAnyway from the input", async () => {
		for (const pushAnyway of [true, false, undefined]) {
			h.args.length = 0;
			stamp("attempt-A");
			h.sync.mockImplementation(async (a) => {
				settle(a, "SUCCESS");
				return SUCCESS;
			});

			await pmSyncSingleStoryWorkflow(
				input(
					"attempt-A",
					pushAnyway === undefined ? {} : { pushAnyway },
				),
			);

			expect(argOf("syncWorkItemToPM")?.pushAnyway).toBe(pushAnyway);
		}
	});
});

describe("the clear after an orphaned create", () => {
	it("clears a PENDING another attempt stamped meanwhile, so the watchdog cannot create a second ticket", async () => {
		stamp("attempt-A");
		h.sync.mockImplementation(async () => {
			recordOrphan();
			// B's enqueue lands after the orphan was recorded and attaches.
			stamp("attempt-B");
			return { ...ORPHAN, errorClass: "create_orphan" };
		});

		const result = await pmSyncSingleStoryWorkflow(input("attempt-A"));

		expect(result).toMatchObject({
			status: "FAILED",
			errorClass: "create_orphan",
		});
		expect(h.stories.get(ITEM)?.lastPmSyncStatus).toBeNull();
		expect(argOf("clearPmSyncPendingIfLeaked")).toMatchObject({
			attemptId: "attempt-A",
			anyAttempt: true,
		});
	});

	it("treats a FAILED result without a class (an older activity) as an orphan", async () => {
		stamp("attempt-A");
		h.sync.mockImplementation(async () => {
			recordOrphan();
			stamp("attempt-B");
			// `ORPHAN` carries no errorClass, as before the field existed.
			return ORPHAN;
		});

		const result = await pmSyncSingleStoryWorkflow(input("attempt-A"));

		expect(result).toMatchObject({
			status: "FAILED",
			errorClass: "create_orphan",
		});
		expect(h.stories.get(ITEM)?.lastPmSyncStatus).toBeNull();
		expect(argOf("clearPmSyncPendingIfLeaked")?.anyAttempt).toBe(true);
	});
	it("does the same for a run without an attempt id", async () => {
		stamp(null);
		h.sync.mockImplementation(async () => {
			recordOrphan();
			stamp("attempt-B");
			return ORPHAN;
		});

		await pmSyncSingleStoryWorkflow(input());

		expect(h.stories.get(ITEM)?.lastPmSyncStatus).toBeNull();
	});

	it("is not used after a success: B's PENDING is left alone", async () => {
		stamp("attempt-A");
		h.sync.mockImplementation(async (a) => {
			stamp("attempt-B");
			settle(a, "SUCCESS");
			return SUCCESS;
		});

		await pmSyncSingleStoryWorkflow(input("attempt-A"));

		expect(h.stories.get(ITEM)).toMatchObject({
			lastPmSyncStatus: "PENDING",
			lastPmSyncAttemptId: "attempt-B",
		});
		expect(argOf("clearPmSyncPendingIfLeaked")?.anyAttempt).toBeUndefined();
	});

	it("is not used after a thrown failure: B's PENDING is left alone", async () => {
		stamp("attempt-A");
		h.sync.mockImplementation(async () => {
			stamp("attempt-B");
			throw new Error("boom");
		});

		await pmSyncSingleStoryWorkflow(input("attempt-A"));

		expect(h.stories.get(ITEM)?.lastPmSyncStatus).toBe("PENDING");
		expect(argOf("clearPmSyncPendingIfLeaked")?.anyAttempt).toBeUndefined();
	});
});

describe("the clear after an unconfirmed create", () => {
	it("leaves a PENDING a newer push stamped after the FAILED stamp", async () => {
		// A stamps create_unconfirmed; the claim holder then links the row,
		// and C's push stamps PENDING. A's clear must not remove C's PENDING.
		stamp("attempt-A");
		h.sync.mockImplementation(async () => {
			recordOrphan();
			const row = h.stories.get(ITEM) as Row;
			row.externalId = "88";
			stamp("attempt-C");
			return { ...ORPHAN, errorClass: "create_unconfirmed" };
		});

		const result = await pmSyncSingleStoryWorkflow(input("attempt-A"));

		expect(result).toMatchObject({
			status: "FAILED",
			errorClass: "create_unconfirmed",
		});
		expect(h.stories.get(ITEM)).toMatchObject({
			lastPmSyncStatus: "PENDING",
			lastPmSyncAttemptId: "attempt-C",
		});
		expect(argOf("clearPmSyncPendingIfLeaked")).toEqual({
			itemId: ITEM,
			itemType: "story",
			attemptId: "attempt-A",
		});
	});

	it("still clears this run's own PENDING when its conditional stamp did not apply", async () => {
		stamp("attempt-A");
		// The claim was released before the stamp, so the row keeps A's
		// PENDING while the result is still FAILED create_unconfirmed.
		h.sync.mockImplementation(async () => ({
			...ORPHAN,
			errorClass: "create_unconfirmed",
		}));

		await pmSyncSingleStoryWorkflow(input("attempt-A"));

		expect(h.stories.get(ITEM)?.lastPmSyncStatus).toBeNull();
		expect(argOf("clearPmSyncPendingIfLeaked")?.anyAttempt).toBeUndefined();
	});

	it("without an attempt id, leaves a newer attempt's PENDING", async () => {
		stamp(null);
		h.sync.mockImplementation(async () => {
			recordOrphan();
			stamp("attempt-C");
			return { ...ORPHAN, errorClass: "create_unconfirmed" };
		});

		await pmSyncSingleStoryWorkflow(input());

		expect(h.stories.get(ITEM)).toMatchObject({
			lastPmSyncStatus: "PENDING",
			lastPmSyncAttemptId: "attempt-C",
		});
	});
});

it("redacts a serialized database failure in the workflow result and row without changing scheduled activities", async () => {
	stamp("attempt-a");
	h.sync.mockRejectedValue({
		message: "Activity task failed",
		cause: {
			type: "PrismaClientInitializationError",
			message: "database server path and query text",
		},
	});
	const result = await pmSyncSingleStoryWorkflow(input("attempt-a"));
	expect(result.message).toBe("database error");
	expect(h.stories.get(ITEM)?.lastPmSyncError).toBe("database error");
	expect(argOf("recordPmSyncFailure")?.errorMessage).toBe(
		"database server path and query text",
	);
	expect(h.calls).toEqual([
		"syncWorkItemToPM",
		"recordPmSyncFailure",
		"clearPmSyncPendingIfLeaked",
	]);
});
