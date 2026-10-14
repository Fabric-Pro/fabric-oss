/**
 * PM-sync writes that end a sync are scoped to the run's attempt.
 *
 * Every enqueue stamps the row PENDING with a fresh `lastPmSyncAttemptId` and
 * hands that id to the run it starts. A run that carries an attempt id may
 * change the row's status fields only while the row still names that
 * attempt, so a late write from an older run cannot overwrite a newer
 * attempt's PENDING. Fields recording what already happened at the PM tool
 * (the link and the drift baseline) are still written, because that push did
 * happen. A run without an attempt id (a batch or auto sync) must not
 * overwrite a row that is PENDING for an attempt: that attempt's own run
 * records the outcome. It still writes any other row by id.
 *
 * The activities run for real over a simulated `user_story` / `test_case`
 * store.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown> & { id: string };

const h = vi.hoisted(() => ({
	stories: new Map<string, Record<string, unknown> & { id: string }>(),
	testCases: new Map<string, Record<string, unknown> & { id: string }>(),
	recordPmSyncLog: vi.fn(),
	fetchPmTicket: vi.fn(),
}));

/** Prisma `where` semantics for the shapes these writes use. */
function matches(row: Row, where: Record<string, unknown>): boolean {
	return Object.entries(where).every(([key, value]) => {
		if (key === "OR") {
			return (value as Record<string, unknown>[]).some((w) =>
				matches(row, w),
			);
		}
		const cell = row[key] ?? null;
		if (value && typeof value === "object" && "not" in value) {
			// SQL: `col <> x` is never true for a NULL cell.
			return cell !== null && cell !== (value as { not: unknown }).not;
		}
		return cell === value;
	});
}

function table(rows: Map<string, Row>) {
	return {
		findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
			const row = rows.get(where.id);
			return row
				? {
						...row,
						project: { organizationId: "org-1", userId: "u-1" },
					}
				: null;
		}),
		findFirst: vi.fn(
			async ({ where }: { where: Record<string, unknown> }) =>
				[...rows.values()].find((row) => matches(row, where)) ?? null,
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
	};
}

vi.mock("@temporalio/activity", async () => {
	const actual = await vi.importActual<object>("@temporalio/activity");
	return {
		...actual,
		Context: { current: () => ({ heartbeat: vi.fn() }) },
	};
});

vi.mock("@repo/agent-core/backend", () => ({
	getMcpClient: vi.fn(),
	closeMcpClientSafe: vi.fn().mockResolvedValue(undefined),
	getDetailedMcpToolInfo: vi.fn().mockResolvedValue([]),
}));

vi.mock("@repo/storage", () => ({
	getStorageProvider: vi.fn(() => ({ getSignedUrl: vi.fn() })),
}));

vi.mock("@repo/config", () => ({
	config: { storage: { bucketNames: { projectContexts: "test-bucket" } } },
}));

vi.mock("@repo/logs", () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@repo/database", () => ({
	// The claim stamp is read from the database clock (`takeClaim`).
	readDatabaseClock: vi.fn(async () => new Date()),
	db: {
		userStory: table(h.stories),
		testCase: table(h.testCases),
		mCPServer: { findUnique: vi.fn(async () => null) },
		mCPConfig: { findFirst: vi.fn(async () => null) },
	},
	PmSyncStatus: {
		PENDING: "PENDING",
		SUCCESS: "SUCCESS",
		CONFLICT: "CONFLICT",
		FAILED: "FAILED",
	},
	getMcpConfigById: async () => null,
	setAiUsageRecorder: vi.fn(),
	isProjectReadOnly: vi.fn(async () => false),
	getStoryById: vi.fn(async (id: string) => h.stories.get(id) ?? null),
	updateStory: vi.fn(),
	upsertPendingChange: vi.fn(),
	HTML_BACK_LINK_RE: /$^/,
	formatBackLinkForProvider: (d: string | null | undefined) => d ?? "",
}));

vi.mock("../src/activities/orchestrator/execution/execute-mcp-tool", () => ({
	executeMcpTool: vi.fn(),
}));

vi.mock("../src/activities/pm-integration/record-pm-sync-log", () => ({
	recordPmSyncLog: h.recordPmSyncLog,
}));

vi.mock("../src/activities/pm-integration/fetch-pm-ticket", () => ({
	fetchPmTicket: h.fetchPmTicket,
}));

vi.mock("../src/activities/lib/job-progress", () => ({
	jobHeartbeat: vi.fn(async () => undefined),
}));

vi.mock("../src/activities/pm-integration/story-sync", () => ({
	discoverPMToolCapabilities: vi.fn(),
	fetchPMItemsByIds: vi.fn(),
	HTML_DESCRIPTION_TOOLS: new Set<string>(),
	MARKDOWN_DESCRIPTION_TOOLS: new Set<string>(),
	markdownToSimpleHtml: (s: string) => s,
}));

const {
	clearPmSyncPendingIfLeaked,
	recordPmSyncFailure,
	recordPmSyncSuccessState,
} = await import("../src/activities/pm-integration/record-pm-sync-state");
const { stampPmSyncConflict, stampPmSyncSuccess, syncWorkItemToPM } =
	await import("../src/activities/pm-integration/hierarchy-sync");
const { db, updateStory } = await import("@repo/database");
const { executeMcpTool } = await import(
	"../src/activities/orchestrator/execution/execute-mcp-tool"
);
const { discoverPMToolCapabilities } = await import(
	"../src/activities/pm-integration/story-sync"
);
const { updateTestCaseExternalRefs } = await import(
	"../src/activities/pm-integration/test-case-sync"
);
const { detectAndStampPmPushConflict } = await import(
	"../src/activities/pm-integration/detect-pm-push-conflict"
);
const { computePmHash } = await import(
	"../src/activities/pm-integration/pm-sync-hash"
);
const { recordCreateUnconfirmed } = await import(
	"../src/activities/pm-integration/pm-create-orphan"
);

/** A row a newer enqueue stamped PENDING with attempt `attemptId`. */
function pendingRow(id: string, attemptId: string | null): Row {
	return {
		id,
		projectId: "project-1",
		title: "Example",
		externalId: "PM-1",
		externalUrl: null,
		externalMcpServerId: null,
		lastSyncedPmHash: "old-hash",
		lastSyncedAt: null,
		lastPmSyncStatus: "PENDING",
		lastPmSyncError: null,
		lastPmSyncAttemptAt: new Date("2026-01-01T00:00:00Z"),
		lastPmSyncAttemptId: attemptId,
		pmSyncPendingSince: new Date("2026-01-01T00:00:00Z"),
	};
}

beforeEach(() => {
	h.stories.clear();
	h.testCases.clear();
	h.recordPmSyncLog.mockReset();
	h.fetchPmTicket.mockReset();
});

describe("an older run's terminal write after a newer attempt stamped PENDING", () => {
	it("FAILED: leaves the newer PENDING alone and writes no FAILURE audit row", async () => {
		h.stories.set("s1", pendingRow("s1", "attempt-B"));

		const wrote = await recordPmSyncFailure({
			itemId: "s1",
			itemType: "story",
			errorMessage: "boom",
			errorClass: "PmUpdateError",
			triggerSource: "manual-edit",
			onlyIfAttempt: "attempt-A",
		});

		expect(wrote).toBe(false);
		expect(h.stories.get("s1")).toMatchObject({
			lastPmSyncStatus: "PENDING",
			lastPmSyncAttemptId: "attempt-B",
			lastPmSyncError: null,
		});
		expect(h.recordPmSyncLog).not.toHaveBeenCalled();
	});

	it("FAILED: still lands, with its audit row, while the row names the run's attempt", async () => {
		h.stories.set("s1", pendingRow("s1", "attempt-A"));

		const wrote = await recordPmSyncFailure({
			itemId: "s1",
			itemType: "story",
			errorMessage: "boom",
			errorClass: "PmUpdateError",
			triggerSource: "manual-edit",
			onlyIfAttempt: "attempt-A",
		});

		expect(wrote).toBe(true);
		expect(h.stories.get("s1")?.lastPmSyncStatus).toBe("FAILED");
		expect(h.recordPmSyncLog).toHaveBeenCalledWith(
			expect.objectContaining({ status: "FAILURE" }),
		);
	});

	it("SUCCESS (auto-push stamp): keeps the newer PENDING but writes the drift baseline", async () => {
		h.stories.set("s1", pendingRow("s1", "attempt-B"));

		await stampPmSyncSuccess({
			itemType: "story",
			itemId: "s1",
			title: "Pushed title",
			description: "Pushed body",
			pmSyncAttemptId: "attempt-A",
		});

		const row = h.stories.get("s1");
		expect(row).toMatchObject({
			lastPmSyncStatus: "PENDING",
			lastPmSyncAttemptId: "attempt-B",
			lastSyncedPmHash: computePmHash("Pushed title", "Pushed body"),
		});
		expect(row?.lastSyncedAt).toBeInstanceOf(Date);
	});

	it("SUCCESS (auto-push stamp): lands while the row names the run's attempt", async () => {
		h.stories.set("s1", pendingRow("s1", "attempt-A"));

		await stampPmSyncSuccess({
			itemType: "story",
			itemId: "s1",
			title: "Pushed title",
			description: "Pushed body",
			pmSyncAttemptId: "attempt-A",
		});

		expect(h.stories.get("s1")?.lastPmSyncStatus).toBe("SUCCESS");
	});

	it("SUCCESS (single-story push stamp): keeps the newer PENDING but records lastSyncedAt", async () => {
		h.stories.set("s1", pendingRow("s1", "attempt-B"));

		await recordPmSyncSuccessState({
			itemId: "s1",
			itemType: "story",
			pmSyncAttemptId: "attempt-A",
		});

		const row = h.stories.get("s1");
		expect(row?.lastPmSyncStatus).toBe("PENDING");
		expect(row?.lastSyncedAt).toBeInstanceOf(Date);
	});

	it("CONFLICT: leaves the newer PENDING alone", async () => {
		h.stories.set("s1", pendingRow("s1", "attempt-B"));

		await stampPmSyncConflict("story", "s1", "attempt-A");

		expect(h.stories.get("s1")?.lastPmSyncStatus).toBe("PENDING");
	});

	it("CONFLICT: lands while the row names the run's attempt", async () => {
		h.stories.set("s1", pendingRow("s1", "attempt-A"));

		await stampPmSyncConflict("story", "s1", "attempt-A");

		expect(h.stories.get("s1")?.lastPmSyncStatus).toBe("CONFLICT");
	});

	it("CONFLICT via the bulk drift guard: leaves the newer PENDING alone", async () => {
		h.testCases.set("tc1", pendingRow("tc1", "attempt-B"));
		h.fetchPmTicket.mockResolvedValue({
			title: "Edited in the PM tool",
			description: "x",
		});

		const result = await detectAndStampPmPushConflict({
			itemId: "tc1",
			itemType: "testCase",
			projectId: "project-1",
			mcpConfigId: "config-1",
			containerId: "board-1",
			userId: "u-1",
			externalId: "PM-1",
			capabilities: { taskGet: {} } as never,
			pmSyncAttemptId: "attempt-A",
		});

		expect(result.hasConflict).toBe(true);
		expect(h.testCases.get("tc1")?.lastPmSyncStatus).toBe("PENDING");
	});
});

describe("a run without an attempt id finishing after an attempt stamped PENDING", () => {
	it("SUCCESS (test case): keeps the retry's PENDING but writes the link and baseline", async () => {
		h.testCases.set("tc1", {
			...pendingRow("tc1", "attempt-R"),
			externalId: null,
		});
		h.fetchPmTicket.mockResolvedValue({
			title: "Stored title",
			description: "Stored body",
		});

		await updateTestCaseExternalRefs({
			testCaseId: "tc1",
			projectId: "project-1",
			externalId: "PM-9",
			externalUrl: "https://pm.example.com/9",
			externalMcpServerId: "server-1",
			baseline: {
				mcpConfigId: "config-1",
				capabilities: { taskGet: {} } as never,
				userId: "u-1",
				containerId: "board-1",
			},
		});

		const row = h.testCases.get("tc1");
		expect(row).toMatchObject({
			externalId: "PM-9",
			externalUrl: "https://pm.example.com/9",
			externalMcpServerId: "server-1",
			lastSyncedPmHash: computePmHash("Stored title", "Stored body"),
			lastPmSyncStatus: "PENDING",
			lastPmSyncAttemptId: "attempt-R",
			lastPmSyncAttemptAt: new Date("2026-01-01T00:00:00Z"),
		});
		expect(row?.lastSyncedAt).toBeInstanceOf(Date);
	});

	it("FAILED (test case): keeps the retry's PENDING and writes no FAILURE audit row", async () => {
		h.testCases.set("tc1", pendingRow("tc1", "attempt-R"));

		const wrote = await recordPmSyncFailure({
			itemId: "tc1",
			itemType: "testCase",
			errorMessage: "batch push failed",
			errorClass: "push_failed",
			triggerSource: "manual-edit",
		});

		expect(wrote).toBe(false);
		expect(h.testCases.get("tc1")).toMatchObject({
			lastPmSyncStatus: "PENDING",
			lastPmSyncError: null,
			lastPmSyncAttemptId: "attempt-R",
		});
		expect(h.recordPmSyncLog).not.toHaveBeenCalled();
	});

	it("CONFLICT (test case, bulk drift guard): keeps the retry's PENDING and still reports the drift", async () => {
		h.testCases.set("tc1", pendingRow("tc1", "attempt-R"));
		h.fetchPmTicket.mockResolvedValue({
			title: "Edited in the PM tool",
			description: "x",
		});

		const result = await detectAndStampPmPushConflict({
			itemId: "tc1",
			itemType: "testCase",
			projectId: "project-1",
			mcpConfigId: "config-1",
			containerId: "board-1",
			userId: "u-1",
			externalId: "PM-1",
			capabilities: { taskGet: {} } as never,
		});

		expect(result.hasConflict).toBe(true);
		expect(h.testCases.get("tc1")?.lastPmSyncStatus).toBe("PENDING");
	});

	it("SUCCESS (story auto-push stamp): keeps the PENDING but writes the drift baseline", async () => {
		h.stories.set("s1", pendingRow("s1", "attempt-B"));

		await stampPmSyncSuccess({
			itemType: "story",
			itemId: "s1",
			title: "Pushed title",
			description: "Pushed body",
		});

		const row = h.stories.get("s1");
		expect(row).toMatchObject({
			lastPmSyncStatus: "PENDING",
			lastPmSyncAttemptId: "attempt-B",
			lastSyncedPmHash: computePmHash("Pushed title", "Pushed body"),
		});
		expect(row?.lastSyncedAt).toBeInstanceOf(Date);
	});

	it("SUCCESS (story push stamp): keeps the PENDING but records lastSyncedAt", async () => {
		h.stories.set("s1", pendingRow("s1", "attempt-B"));

		await recordPmSyncSuccessState({ itemId: "s1", itemType: "story" });

		const row = h.stories.get("s1");
		expect(row?.lastPmSyncStatus).toBe("PENDING");
		expect(row?.lastSyncedAt).toBeInstanceOf(Date);
	});

	it("FAILED (story): keeps the PENDING", async () => {
		h.stories.set("s1", pendingRow("s1", "attempt-B"));

		const wrote = await recordPmSyncFailure({
			itemId: "s1",
			itemType: "story",
			errorMessage: "boom",
			errorClass: "PmUpdateError",
			triggerSource: "ai-update",
		});

		expect(wrote).toBe(false);
		expect(h.stories.get("s1")?.lastPmSyncStatus).toBe("PENDING");
	});

	it("CONFLICT (story): keeps the PENDING", async () => {
		h.stories.set("s1", pendingRow("s1", "attempt-B"));

		expect(await stampPmSyncConflict("story", "s1")).toBe(false);
		expect(h.stories.get("s1")?.lastPmSyncStatus).toBe("PENDING");
	});

	it("the orphaned-create FAILED still overrides the PENDING (no second ticket)", async () => {
		h.stories.set("s1", pendingRow("s1", "attempt-B"));

		const wrote = await recordPmSyncFailure({
			itemId: "s1",
			itemType: "story",
			errorMessage: "created but not linked",
			errorClass: "create_orphan",
			triggerSource: "manual-edit",
			overridePendingAttempt: true,
		});

		expect(wrote).toBe(true);
		expect(h.stories.get("s1")?.lastPmSyncStatus).toBe("FAILED");
	});
});

describe("a run without an attempt id on a row no attempt is pending for", () => {
	/** Rows the unattempted write must still land on, by id. */
	const writable: Array<[string, Partial<Row>]> = [
		["SUCCESS", { lastPmSyncStatus: "SUCCESS" }],
		["FAILED", { lastPmSyncStatus: "FAILED" }],
		["CONFLICT", { lastPmSyncStatus: "CONFLICT" }],
		// A leaked-PENDING clear sets the status back to NULL but keeps the
		// attempt id: SQL's `status <> 'PENDING'` alone would skip this row.
		["NULL-status (attempt id kept)", { lastPmSyncStatus: null }],
		// Stamped before attempt ids existed: no attempted run will settle it.
		["PENDING-without-attempt-id", { lastPmSyncAttemptId: null }],
	];

	it.each(writable)("SUCCESS lands on a %s test case", async (_, over) => {
		h.testCases.set("tc1", { ...pendingRow("tc1", "attempt-R"), ...over });

		await updateTestCaseExternalRefs({
			testCaseId: "tc1",
			projectId: "project-1",
			externalId: "PM-1",
		});

		expect(h.testCases.get("tc1")).toMatchObject({
			lastPmSyncStatus: "SUCCESS",
			lastPmSyncError: null,
		});
	});

	it.each(writable)(
		"FAILED lands on a %s test case, with its audit row",
		async (_, over) => {
			h.testCases.set("tc1", {
				...pendingRow("tc1", "attempt-R"),
				...over,
			});

			const wrote = await recordPmSyncFailure({
				itemId: "tc1",
				itemType: "testCase",
				errorMessage: "batch push failed",
				errorClass: "push_failed",
				triggerSource: "manual-edit",
			});

			expect(wrote).toBe(true);
			expect(h.testCases.get("tc1")).toMatchObject({
				lastPmSyncStatus: "FAILED",
				lastPmSyncError: "batch push failed",
			});
			expect(h.recordPmSyncLog).toHaveBeenCalledWith(
				expect.objectContaining({ status: "FAILURE" }),
			);
		},
	);

	it.each(writable)("CONFLICT lands on a %s test case", async (_, over) => {
		h.testCases.set("tc1", { ...pendingRow("tc1", "attempt-R"), ...over });

		expect(await stampPmSyncConflict("testCase", "tc1")).toBe(true);
		expect(h.testCases.get("tc1")?.lastPmSyncStatus).toBe("CONFLICT");
	});

	it.each(writable)(
		"SUCCESS, FAILED and CONFLICT land on a %s story",
		async (_, over) => {
			h.stories.set("s1", { ...pendingRow("s1", "attempt-B"), ...over });
			await stampPmSyncSuccess({
				itemType: "story",
				itemId: "s1",
				title: "t",
				description: "d",
			});
			expect(h.stories.get("s1")?.lastPmSyncStatus).toBe("SUCCESS");

			h.stories.set("s1", { ...pendingRow("s1", "attempt-B"), ...over });
			await recordPmSyncSuccessState({ itemId: "s1", itemType: "story" });
			expect(h.stories.get("s1")?.lastPmSyncStatus).toBe("SUCCESS");

			h.stories.set("s1", { ...pendingRow("s1", "attempt-B"), ...over });
			await recordPmSyncFailure({
				itemId: "s1",
				itemType: "story",
				errorMessage: "boom",
				errorClass: "PmUpdateError",
				triggerSource: "ai-update",
			});
			expect(h.stories.get("s1")?.lastPmSyncStatus).toBe("FAILED");

			h.stories.set("s1", { ...pendingRow("s1", "attempt-B"), ...over });
			await stampPmSyncConflict("story", "s1");
			expect(h.stories.get("s1")?.lastPmSyncStatus).toBe("CONFLICT");
		},
	);
});

describe("an orphaned create after a newer attempt stamped PENDING", () => {
	it("still records FAILED by id, so the watchdog does not create a second ticket", async () => {
		h.stories.set("s1", {
			...pendingRow("s1", "attempt-B"),
			externalId: null,
			description: "Body",
			acceptanceCriteria: null,
			identifier: "US-1",
		});
		vi.mocked(discoverPMToolCapabilities).mockResolvedValue({
			hasPMCapabilities: true,
			detectedType: "fizzy",
			taskCreation: {
				toolName: "create_card",
				containerParam: "board_id",
				titleParam: "title",
				descriptionParam: "description",
				allParams: [],
			},
		} as never);
		// Created, but the response carries no id: the ticket is orphaned.
		vi.mocked(executeMcpTool).mockResolvedValue({
			success: true,
			output: {},
		} as never);

		const result = await syncWorkItemToPM({
			itemType: "story",
			itemId: "s1",
			projectId: "project-1",
			mcpConfigId: "config-1",
			containerId: "board-1",
			userId: "u-1",
			pmSyncAttemptId: "attempt-A",
		});

		expect(result.status).toBe("FAILED");
		expect(h.stories.get("s1")).toMatchObject({
			lastPmSyncStatus: "FAILED",
			lastPmSyncError: expect.stringContaining("could not read its id"),
		});
	});
});

describe("an unconfirmed create after a newer attempt stamped PENDING", () => {
	it("still records FAILED (create_unconfirmed) by id, so the user sees a ticket may exist", async () => {
		h.stories.set("s1", {
			...pendingRow("s1", "attempt-B"),
			externalId: null,
			pmCreateClaimId: "held",
		});

		const recording = await recordCreateUnconfirmed({
			itemId: "s1",
			itemType: "story",
			errorMessage: "A ticket may already exist for this item.",
			triggerSource: "manual-edit",
		});

		expect(recording).toEqual({ outcome: "recorded" });
		expect(h.stories.get("s1")).toMatchObject({
			lastPmSyncStatus: "FAILED",
			lastPmSyncError: expect.stringContaining("may already exist"),
			lastPmSyncAttemptId: "attempt-B",
		});
		expect(h.recordPmSyncLog).toHaveBeenCalledWith(
			expect.objectContaining({
				status: "FAILURE",
				errorPayload: expect.objectContaining({
					errorClass: "create_unconfirmed",
				}),
			}),
		);
	});

	it("writes nothing on a row linked since the claim attempt, and reports it linked", async () => {
		h.stories.set("s1", {
			...pendingRow("s1", "attempt-C"),
			externalId: "88",
			externalUrl: "https://pm.example.com/88",
			pmCreateClaimId: null,
		});

		const recording = await recordCreateUnconfirmed({
			itemId: "s1",
			itemType: "story",
			errorMessage: "A ticket may already exist for this item.",
			triggerSource: "manual-edit",
		});

		expect(recording).toEqual({
			outcome: "linked",
			externalId: "88",
			externalUrl: "https://pm.example.com/88",
		});
		expect(h.stories.get("s1")).toMatchObject({
			lastPmSyncStatus: "PENDING",
			lastPmSyncAttemptId: "attempt-C",
			lastPmSyncError: null,
		});
		expect(h.recordPmSyncLog).not.toHaveBeenCalled();
	});

	it("writes nothing on an unlinked row whose claim is no longer held", async () => {
		h.stories.set("s1", {
			...pendingRow("s1", "attempt-C"),
			externalId: null,
			pmCreateClaimId: null,
		});

		const recording = await recordCreateUnconfirmed({
			itemId: "s1",
			itemType: "story",
			errorMessage: "A ticket may already exist for this item.",
			triggerSource: "manual-edit",
		});

		expect(recording).toEqual({ outcome: "not-recorded" });
		expect(h.stories.get("s1")).toMatchObject({
			lastPmSyncStatus: "PENDING",
			lastPmSyncAttemptId: "attempt-C",
		});
		expect(h.recordPmSyncLog).not.toHaveBeenCalled();
	});
});

describe("test-case path: an older run's success after a newer retry stamped", () => {
	it("keeps the newer PENDING and still writes the link", async () => {
		h.testCases.set("tc1", {
			...pendingRow("tc1", "attempt-B"),
			externalId: null,
		});

		await updateTestCaseExternalRefs({
			testCaseId: "tc1",
			projectId: "project-1",
			externalId: "PM-9",
			externalUrl: "https://pm.example.com/9",
			externalMcpServerId: "server-1",
			pmSyncAttemptId: "attempt-A",
		});

		const row = h.testCases.get("tc1");
		expect(row).toMatchObject({
			externalId: "PM-9",
			externalUrl: "https://pm.example.com/9",
			externalMcpServerId: "server-1",
			lastPmSyncStatus: "PENDING",
			lastPmSyncAttemptId: "attempt-B",
		});
		expect(row?.lastSyncedAt).toBeInstanceOf(Date);
	});

	it("stamps SUCCESS while the row names the run's attempt", async () => {
		h.testCases.set("tc1", pendingRow("tc1", "attempt-A"));

		await updateTestCaseExternalRefs({
			testCaseId: "tc1",
			projectId: "project-1",
			externalId: "PM-1",
			pmSyncAttemptId: "attempt-A",
		});

		expect(h.testCases.get("tc1")?.lastPmSyncStatus).toBe("SUCCESS");
	});
});

describe("clearPmSyncPendingIfLeaked", () => {
	it("an older run's clear leaves a newer attempt's PENDING alone", async () => {
		h.stories.set("s1", pendingRow("s1", "attempt-B"));

		await clearPmSyncPendingIfLeaked({
			itemId: "s1",
			itemType: "story",
			attemptId: "attempt-A",
		});

		expect(h.stories.get("s1")?.lastPmSyncStatus).toBe("PENDING");
	});

	it("clears the run's own leaked PENDING", async () => {
		h.stories.set("s1", pendingRow("s1", "attempt-A"));

		await clearPmSyncPendingIfLeaked({
			itemId: "s1",
			itemType: "story",
			attemptId: "attempt-A",
		});

		expect(h.stories.get("s1")?.lastPmSyncStatus).toBeNull();
	});

	it("without an attempt id it clears only a PENDING no attempt owns", async () => {
		h.stories.set("legacy", pendingRow("legacy", null));
		h.stories.set("owned", pendingRow("owned", "attempt-B"));

		await clearPmSyncPendingIfLeaked({
			itemId: "legacy",
			itemType: "story",
		});
		await clearPmSyncPendingIfLeaked({
			itemId: "owned",
			itemType: "story",
		});

		expect(h.stories.get("legacy")?.lastPmSyncStatus).toBeNull();
		expect(h.stories.get("owned")?.lastPmSyncStatus).toBe("PENDING");
	});

	it("after an orphaned create (anyAttempt) it clears a PENDING whatever attempt stamped it", async () => {
		h.stories.set("s1", pendingRow("s1", "attempt-B"));
		h.stories.set("legacy", pendingRow("legacy", null));

		await clearPmSyncPendingIfLeaked({
			itemId: "s1",
			itemType: "story",
			attemptId: "attempt-A",
			anyAttempt: true,
		});
		await clearPmSyncPendingIfLeaked({
			itemId: "legacy",
			itemType: "story",
			anyAttempt: true,
		});

		expect(h.stories.get("s1")?.lastPmSyncStatus).toBeNull();
		expect(h.stories.get("legacy")?.lastPmSyncStatus).toBeNull();
	});

	it("anyAttempt still leaves a settled row alone", async () => {
		h.stories.set("s1", {
			...pendingRow("s1", "attempt-B"),
			lastPmSyncStatus: "FAILED",
		});

		await clearPmSyncPendingIfLeaked({
			itemId: "s1",
			itemType: "story",
			attemptId: "attempt-A",
			anyAttempt: true,
		});

		expect(h.stories.get("s1")?.lastPmSyncStatus).toBe("FAILED");
	});
});

describe("a legacy-link failure from a run without an attempt id (onlyIfRowUnchanged)", () => {
	/** The row as Sync now read it: an unstamped link, no attempt. */
	const legacyRead = {
		externalId: "77",
		externalMcpServerId: null,
		lastPmSyncAttemptId: null,
	};
	const legacyFailure = () =>
		recordPmSyncFailure({
			itemId: "s1",
			itemType: "story",
			errorMessage:
				"This item is linked to a ticket in a different PM tool, so Fabric did not create a new one in GitLab.",
			errorClass: "PM_TOOL_MISMATCH_LEGACY",
			triggerSource: "manual-edit",
			onlyIfRowUnchanged: legacyRead,
		});
	const legacyRow = (): Row => ({
		...pendingRow("s1", null),
		externalId: "77",
		lastPmSyncStatus: null,
	});

	afterEach(() => {
		// Drops a queued one-off rejection a case did not consume.
		vi.mocked(db.userStory.updateMany).mockReset();
	});

	it("after a relink and a newer success, leaves the newer state and writes no audit row", async () => {
		// Read by the delayed run, then relinked to 88 and synced by a newer
		// attempt before its failure is written.
		h.stories.set("s1", {
			...legacyRow(),
			externalId: "88",
			externalMcpServerId: "srv-gitlab",
			lastPmSyncStatus: "SUCCESS",
			lastPmSyncAttemptId: "attempt-newer",
		});

		await expect(legacyFailure()).resolves.toBe(false);

		expect(h.stories.get("s1")).toMatchObject({
			externalId: "88",
			lastPmSyncStatus: "SUCCESS",
			lastPmSyncError: null,
			lastPmSyncAttemptId: "attempt-newer",
		});
		expect(h.recordPmSyncLog).not.toHaveBeenCalled();
	});

	it("a newer enqueue on the same link keeps its PENDING, with no audit row", async () => {
		h.stories.set("s1", {
			...legacyRow(),
			lastPmSyncStatus: "PENDING",
			lastPmSyncAttemptId: "attempt-newer",
		});

		await expect(legacyFailure()).resolves.toBe(false);

		expect(h.stories.get("s1")?.lastPmSyncStatus).toBe("PENDING");
		expect(h.recordPmSyncLog).not.toHaveBeenCalled();
	});

	it("an attempt already PENDING when the row was read keeps its PENDING, with no audit row", async () => {
		// The snapshot's attempt id matches, but that attempt's own run
		// settles the row: a write without an attempt id never overwrites a
		// PENDING attempt (`writePmSyncStatusUnattempted`).
		h.stories.set("s1", {
			...legacyRow(),
			lastPmSyncStatus: "PENDING",
			lastPmSyncAttemptId: "attempt-A",
		});

		await expect(
			recordPmSyncFailure({
				itemId: "s1",
				itemType: "story",
				errorMessage: "boom",
				errorClass: "PM_TOOL_MISMATCH_LEGACY",
				triggerSource: "manual-edit",
				onlyIfRowUnchanged: {
					...legacyRead,
					lastPmSyncAttemptId: "attempt-A",
				},
			}),
		).resolves.toBe(false);

		expect(h.stories.get("s1")?.lastPmSyncStatus).toBe("PENDING");
		expect(h.recordPmSyncLog).not.toHaveBeenCalled();
	});

	it("a settled row read with an attempt id still gets FAILED", async () => {
		h.stories.set("s1", {
			...legacyRow(),
			lastPmSyncStatus: "SUCCESS",
			lastPmSyncAttemptId: "attempt-A",
		});

		await expect(
			recordPmSyncFailure({
				itemId: "s1",
				itemType: "story",
				errorMessage: "boom",
				errorClass: "PM_TOOL_MISMATCH_LEGACY",
				triggerSource: "manual-edit",
				onlyIfRowUnchanged: {
					...legacyRead,
					lastPmSyncAttemptId: "attempt-A",
				},
			}),
		).resolves.toBe(true);

		expect(h.stories.get("s1")?.lastPmSyncStatus).toBe("FAILED");
	});

	it("a row still as read gets FAILED and its audit row", async () => {
		h.stories.set("s1", legacyRow());

		await expect(legacyFailure()).resolves.toBe(true);

		expect(h.stories.get("s1")).toMatchObject({
			externalId: "77",
			lastPmSyncStatus: "FAILED",
			lastPmSyncError: expect.stringContaining("different PM tool"),
		});
		expect(h.recordPmSyncLog).toHaveBeenCalledTimes(1);
		expect(h.recordPmSyncLog).toHaveBeenCalledWith(
			expect.objectContaining({ status: "FAILURE" }),
		);
	});

	it("a failed state write writes no audit row and does not throw", async () => {
		h.stories.set("s1", legacyRow());
		vi.mocked(db.userStory.updateMany).mockRejectedValueOnce(
			new Error("deadlock"),
		);

		await expect(legacyFailure()).resolves.toBe(false);
		expect(h.recordPmSyncLog).not.toHaveBeenCalled();
	});

	it("a call with an attempt id keeps its attempt fence", async () => {
		h.stories.set("s1", {
			...legacyRow(),
			lastPmSyncAttemptId: "attempt-A",
		});

		await expect(
			recordPmSyncFailure({
				itemId: "s1",
				itemType: "story",
				errorMessage: "boom",
				errorClass: "PM_TOOL_MISMATCH_LEGACY",
				triggerSource: "manual-edit",
				onlyIfAttempt: "attempt-A",
				// Ignored: the attempt decides.
				onlyIfRowUnchanged: legacyRead,
			}),
		).resolves.toBe(true);
		expect(h.stories.get("s1")?.lastPmSyncStatus).toBe("FAILED");
	});
});

describe("recordPmSyncFailure: the audit row is best effort", () => {
	it("a throwing audit-context read does not fail the call; FAILED is written", async () => {
		h.stories.set("s1", pendingRow("s1", null));
		vi.mocked(db.userStory.findUnique).mockRejectedValueOnce(
			new Error("connection reset"),
		);

		await expect(
			recordPmSyncFailure({
				itemId: "s1",
				itemType: "story",
				errorMessage: "boom",
				errorClass: "PmUpdateError",
				triggerSource: "manual-edit",
			}),
		).resolves.toBe(true);
		expect(h.stories.get("s1")?.lastPmSyncStatus).toBe("FAILED");
	});

	it("a throwing log write does not fail the call", async () => {
		h.stories.set("s1", pendingRow("s1", null));
		h.recordPmSyncLog.mockRejectedValueOnce(new Error("log table locked"));

		await expect(
			recordPmSyncFailure({
				itemId: "s1",
				itemType: "story",
				errorMessage: "boom",
				errorClass: "PmUpdateError",
				triggerSource: "manual-edit",
			}),
		).resolves.toBe(true);
		expect(h.stories.get("s1")?.lastPmSyncStatus).toBe("FAILED");
	});

	it("under the watchdog's fence, a throwing audit read is swallowed too", async () => {
		h.stories.set("s1", pendingRow("s1", "attempt-A"));
		vi.mocked(db.userStory.findUnique).mockRejectedValueOnce(
			new Error("connection reset"),
		);

		await expect(
			recordPmSyncFailure({
				itemId: "s1",
				itemType: "story",
				errorMessage: "stuck",
				errorClass: "stuck_pending",
				triggerSource: "retry",
				onlyIfPendingAttempt: { attemptId: "attempt-A" },
			}),
		).resolves.toBe(true);
		expect(h.stories.get("s1")?.lastPmSyncStatus).toBe("FAILED");
	});

	it("under the watchdog's fence, a failed state write is still rethrown", async () => {
		h.stories.set("s1", pendingRow("s1", "attempt-A"));
		vi.mocked(db.userStory.updateMany).mockRejectedValueOnce(
			new Error("deadlock"),
		);

		await expect(
			recordPmSyncFailure({
				itemId: "s1",
				itemType: "story",
				errorMessage: "stuck",
				errorClass: "stuck_pending",
				triggerSource: "retry",
				onlyIfPendingAttempt: { attemptId: "attempt-A" },
			}),
		).rejects.toThrow("deadlock");
	});
});

describe("an orphaned create whose recording also fails", () => {
	it("returns the create_orphan FAILED result instead of throwing (the link write and the audit read both fail)", async () => {
		h.stories.set("s1", {
			...pendingRow("s1", "attempt-A"),
			externalId: null,
			description: "Body",
			acceptanceCriteria: null,
			identifier: "US-1",
		});
		vi.mocked(discoverPMToolCapabilities).mockResolvedValue({
			hasPMCapabilities: true,
			detectedType: "fizzy",
			taskCreation: {
				toolName: "create_card",
				containerParam: "board_id",
				titleParam: "title",
				descriptionParam: "description",
				allParams: [],
			},
		} as never);
		vi.mocked(executeMcpTool).mockClear();
		vi.mocked(executeMcpTool).mockImplementation(async () => {
			// From the moment the ticket exists, every read of the row fails.
			vi.mocked(db.userStory.findUnique).mockRejectedValue(
				new Error("connection reset"),
			);
			return { success: true, output: { id: "1075" } } as never;
		});
		// The link write retries three times before giving up.
		vi.mocked(updateStory).mockRejectedValue(
			new Error("database unavailable"),
		);

		try {
			const result = await syncWorkItemToPM({
				itemType: "story",
				itemId: "s1",
				projectId: "project-1",
				mcpConfigId: "config-1",
				containerId: "board-1",
				userId: "u-1",
				pmSyncAttemptId: "attempt-A",
			});

			expect(result.status).toBe("FAILED");
			expect(result.status === "FAILED" && result.error).toEqual(
				expect.stringContaining("1075"),
			);
			expect(executeMcpTool).toHaveBeenCalledTimes(1);
			// The FAILED itself landed by id; only the audit row was lost.
			expect(h.stories.get("s1")?.lastPmSyncStatus).toBe("FAILED");
		} finally {
			vi.mocked(db.userStory.findUnique).mockReset();
			vi.mocked(updateStory).mockReset();
			vi.mocked(executeMcpTool).mockReset();
		}
	});
});
