/**
 * The test-case push's create under the PM create claim
 * (`createTestCaseInPmWithClaim`, used by `testCaseSyncWorkflow` behind
 * `patched("test-case-sync-create-claim-v1")`).
 *
 * The activity runs for real, with the real claim, orphan and failure
 * recording, over a simulated `test_case` store with Prisma's `where`
 * semantics. `db.$transaction` stages the writes made through its client and
 * applies them to the store together when the callback resolves, or drops
 * them all when it throws. `executeMcpTool` is the PM tool and
 * `fetchPmTicket` its read-back for the drift baseline.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PMToolCapabilities } from "../src/activities/pm-integration/tool-analyzer";

type Row = Record<string, unknown> & { id: string };

/** One write to the store: through a transaction client, or committed alone. */
type StoreWrite = { via: "tx" | "db"; data: Record<string, unknown> };

const h = vi.hoisted(() => ({
	cases: new Map<string, Record<string, unknown> & { id: string }>(),
	workflowActs: {} as Record<string, ReturnType<typeof vi.fn>>,
	recordPmSyncLog: vi.fn(),
	writes: [] as { via: "tx" | "db"; data: Record<string, unknown> }[],
	/** Runs once, right after the next transaction commits. */
	afterCommit: null as null | (() => Promise<void>),
	/** The next commit lands, but its caller gets an error. */
	loseNextCommitAck: false,
	/** Thrown once by the next `updateMany` through a transaction client. */
	failNextTxUpdateMany: null as null | Error,
}));

/** Prisma `where` semantics for the shapes these reads and writes use. */
function matches(row: Record<string, unknown>, where: object): boolean {
	return Object.entries(where).every(([key, value]) => {
		if (key === "OR") {
			return (value as object[]).some((arm) => matches(row, arm));
		}
		const cell = row[key] ?? null;
		if (value instanceof Date) {
			return cell instanceof Date && cell.getTime() === value.getTime();
		}
		if (value && typeof value === "object") {
			if ("not" in value) {
				// SQL: `<> x` and `IS NOT NULL` are never true for NULL.
				return (
					cell !== null && cell !== (value as { not: unknown }).not
				);
			}
			// A relation filter (`project: { organizationId }`).
			return (
				cell !== null &&
				matches(cell as Record<string, unknown>, value as object)
			);
		}
		return cell === value;
	});
}

interface StoreView {
	via: "tx" | "db";
	rows(): Row[];
	write(id: string, data: Record<string, unknown>): void;
}

function committedView(): StoreView {
	return {
		via: "db",
		rows: () => [...h.cases.values()],
		write: (id, data) => {
			h.writes.push({ via: "db", data });
			Object.assign(h.cases.get(id) ?? {}, data);
		},
	};
}

function transactionView(staged: Map<string, Record<string, unknown>>) {
	return {
		via: "tx" as const,
		rows: () =>
			[...h.cases.values()].map((row) => ({
				...row,
				...staged.get(row.id),
			})),
		write: (id: string, data: Record<string, unknown>) => {
			h.writes.push({ via: "tx", data });
			staged.set(id, { ...staged.get(id), ...data });
		},
	};
}

function commit(staged: Map<string, Record<string, unknown>>) {
	for (const [id, data] of staged) {
		const row = h.cases.get(id);
		if (row) {
			Object.assign(row, data);
		}
	}
}

function testCaseTable(view: StoreView) {
	return {
		findFirst: vi.fn(async ({ where }: { where: object }) => {
			const row = view.rows().find((r) => matches(r, where));
			return row ? { ...row } : null;
		}),
		findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
			const row = view.rows().find((r) => r.id === where.id);
			return row ? { ...row } : null;
		}),
		update: vi.fn(
			async ({
				where,
				data,
			}: {
				where: { id: string };
				data: Record<string, unknown>;
			}) => {
				const row = view.rows().find((r) => r.id === where.id);
				if (!row) {
					throw new Error("Record to update not found.");
				}
				view.write(row.id, data);
				return { ...row, ...data };
			},
		),
		updateMany: vi.fn(
			async ({
				where,
				data,
			}: {
				where: object;
				data: Record<string, unknown>;
			}) => {
				if (view.via === "tx" && h.failNextTxUpdateMany) {
					const error = h.failNextTxUpdateMany;
					h.failNextTxUpdateMany = null;
					throw error;
				}
				let count = 0;
				for (const row of view.rows()) {
					if (matches(row, where)) {
						view.write(row.id, data);
						count++;
					}
				}
				return { count };
			},
		),
	};
}

// Exercise the workflow with the real link guard and store; other activities
// are stubbed at the workflow boundary.
vi.mock("@temporalio/workflow", async () => {
	const actual = await vi.importActual<typeof import("@temporalio/workflow")>(
		"@temporalio/workflow",
	);
	return {
		...actual,
		defineQuery: (name: string) => name,
		defineSignal: (name: string) => name,
		setHandler: vi.fn(),
		patched: () => true,
		log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
		proxyActivities: () =>
			new Proxy(
				{},
				{
					get: (_target, name: string) => {
						h.workflowActs[name] ??= vi.fn();
						return h.workflowActs[name];
					},
				},
			),
	};
});

vi.mock("@repo/logs", () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@repo/database", () => ({
	// The claim stamp is read from the database clock (`takeClaim`).
	readDatabaseClock: vi.fn(async () => new Date()),
	db: {
		testCase: testCaseTable(committedView()),
		userStory: testCaseTable({
			via: "db",
			rows: () => [],
			write: () => undefined,
		}),
		mCPServer: { findUnique: vi.fn(async () => null) },
		mCPConfig: { findFirst: vi.fn() },
		$transaction: vi.fn(async (fn: (tx: object) => Promise<unknown>) => {
			const staged = new Map<string, Record<string, unknown>>();
			const result = await fn({
				testCase: testCaseTable(transactionView(staged)),
			});
			commit(staged);
			const after = h.afterCommit;
			h.afterCommit = null;
			await after?.();
			if (h.loseNextCommitAck) {
				h.loseNextCommitAck = false;
				throw new Error("connection reset after commit");
			}
			return result;
		}),
	},
	PmSyncStatus: {
		PENDING: "PENDING",
		SUCCESS: "SUCCESS",
		CONFLICT: "CONFLICT",
		FAILED: "FAILED",
	},
}));

vi.mock("../src/activities/orchestrator/execution/execute-mcp-tool", () => ({
	executeMcpTool: vi.fn(),
}));

vi.mock("../src/activities/pm-integration/fetch-pm-ticket", () => ({
	fetchPmTicket: vi.fn(),
}));

vi.mock("../src/activities/pm-integration/record-pm-sync-log", () => ({
	recordPmSyncLog: h.recordPmSyncLog,
}));

const { createTestCaseInPmWithClaim, checkTestCasePmLink } = await import(
	"../src/activities/pm-integration/create-test-case-in-pm-with-claim"
);
const { db } = await import("@repo/database");
const defaultFindFirst = vi
	.mocked(db.testCase.findFirst)
	.getMockImplementation();
const { testCaseSyncWorkflow } = await import(
	"../src/workflows/test-case-sync-workflow"
);
const defaultUpdateMany = vi
	.mocked(db.testCase.updateMany)
	.getMockImplementation();
const { executeMcpTool } = await import(
	"../src/activities/orchestrator/execution/execute-mcp-tool"
);
const { fetchPmTicket } = await import(
	"../src/activities/pm-integration/fetch-pm-ticket"
);
const { writePmSyncStatusForAttempt, writePmSyncStatusUnattempted } =
	await import("../src/activities/pm-integration/pm-sync-attempt-fence");
const { computePmHash } = await import(
	"../src/activities/pm-integration/pm-sync-hash"
);

function unlinkedRow(overrides: Record<string, unknown> = {}): Row {
	return {
		id: "tc1",
		projectId: "project-1",
		project: { organizationId: "org-1", userId: "u-1" },
		title: "Login works",
		deletedAt: null,
		externalId: null,
		externalUrl: null,
		externalMcpServerId: null,
		lastSyncedPmHash: null,
		lastPmSyncStatus: null,
		lastPmSyncError: null,
		lastPmSyncAttemptId: null,
		pmCreateClaimId: null,
		pmCreateClaimedAt: null,
		...overrides,
	};
}

const CAPABILITIES = {
	hasPMCapabilities: true,
	detectedType: "fizzy",
	taskGet: { toolName: "get_card", idParam: "card_id", allParams: [] },
} as unknown as PMToolCapabilities;

const common = {
	testCaseId: "tc1",
	projectId: "project-1",
	organizationId: "org-1",
	userId: "u-1",
	mcpConfigId: "config-1",
	mcpServerId: "server-1",
	pmTarget: { additionalContext: { account_slug: "example-org" } },
	pmTool: "fizzy",
	toolLabel: "fizzy",
	toolName: "create_card",
	createArgs: { board_id: "board-1", title: "Login works" },
};

function mcpText(value: unknown) {
	return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

const created = {
	success: true,
	durationMs: 5,
	output: mcpText({ id: "1075", url: "https://pm.example.com/cards/1075" }),
};

function row(): Row {
	const r = h.cases.get("tc1");
	if (!r) {
		throw new Error("row missing");
	}
	return r;
}

function failureLoggedWith(errorClass: string) {
	return expect.objectContaining({
		status: "FAILURE",
		errorPayload: expect.objectContaining({ errorClass }),
	});
}

function successWrites(): StoreWrite[] {
	return h.writes.filter((w) => w.data.lastPmSyncStatus === "SUCCESS");
}

beforeEach(() => {
	h.cases.clear();
	for (const activity of Object.values(h.workflowActs)) {
		activity.mockReset();
	}
	vi.mocked(db.testCase.findFirst).mockReset();
	vi.mocked(db.testCase.findFirst).mockImplementation(
		defaultFindFirst as never,
	);
	vi.mocked(db.testCase.updateMany).mockReset();
	vi.mocked(db.testCase.updateMany).mockImplementation(
		defaultUpdateMany as never,
	);
	h.recordPmSyncLog.mockReset();
	h.writes.length = 0;
	h.afterCommit = null;
	h.loseNextCommitAck = false;
	h.failNextTxUpdateMany = null;
	vi.mocked(executeMcpTool).mockReset();
	vi.mocked(fetchPmTicket).mockReset();
	vi.mocked(fetchPmTicket).mockResolvedValue(null);
	vi.mocked(db.$transaction).mockClear();
	vi.mocked(db.mCPServer.findUnique).mockReset();
	vi.mocked(db.mCPServer.findUnique).mockResolvedValue(null);
	vi.mocked(db.mCPConfig.findFirst).mockReset();
	vi.mocked(db.mCPConfig.findFirst).mockResolvedValue({
		baseUrl: "https://pm.example.com",
		mcpServer: { key: "azure-devops", defaultUrl: null },
	} as never);
});

describe("createTestCaseInPmWithClaim", () => {
	it("takes the claim, sends the create once, and links the case and its SUCCESS in one transaction that clears the claim", async () => {
		h.cases.set(
			"tc1",
			unlinkedRow({
				lastPmSyncStatus: "FAILED",
				lastPmSyncError: "earlier",
				lastSyncedPmHash: "stale-hash",
			}),
		);
		vi.mocked(executeMcpTool).mockImplementation((async () => {
			// The claim is held while the create is in flight.
			expect(row().pmCreateClaimId).toEqual(expect.any(String));
			return created;
		}) as never);

		const result = await createTestCaseInPmWithClaim(common);

		expect(result).toEqual({
			success: true,
			externalId: "1075",
			externalUrl: "https://pm.example.com/cards/1075",
			outcome: "created",
		});
		expect(executeMcpTool).toHaveBeenCalledTimes(1);
		expect(executeMcpTool).toHaveBeenCalledWith({
			pmTarget: common.pmTarget,
			toolName: "create_card",
			args: common.createArgs,
			userId: "u-1",
			organizationId: "org-1",
			projectId: "project-1",
			mcpConfigId: "config-1",
			sendAtMostOnce: true,
			// Cut off at the claim's send ceiling (PM_CREATE_SEND_TIMEOUT_MS).
			timeoutMs: 50_000,
			// Not sent past the deadline started before the claim.
			dispatchDeadline: expect.any(Number),
		});
		expect(row()).toMatchObject({
			externalId: "1075",
			externalUrl: "https://pm.example.com/cards/1075",
			externalMcpServerId: "server-1",
			// A baseline from an earlier link is not this item's.
			lastSyncedPmHash: null,
			pmCreateClaimId: null,
			pmCreateClaimedAt: null,
			lastPmSyncStatus: "SUCCESS",
			lastPmSyncError: null,
			lastSyncedAt: expect.any(Date),
		});
		expect(successWrites()).toEqual([
			expect.objectContaining({ via: "tx" }),
		]);
		expect(db.$transaction).toHaveBeenCalledTimes(1);
		expect(h.recordPmSyncLog).not.toHaveBeenCalled();
	});

	it("reads an Azure DevOps id and _links.web.href", async () => {
		h.cases.set("tc1", unlinkedRow());
		vi.mocked(executeMcpTool).mockResolvedValue({
			success: true,
			durationMs: 5,
			output: mcpText({
				id: 99,
				_links: {
					web: {
						href: "https://dev.azure.com/example-org/p/_workitems/edit/99",
					},
				},
			}),
		} as never);

		const result = await createTestCaseInPmWithClaim(common);

		expect(result).toMatchObject({
			success: true,
			externalId: "99",
			externalUrl:
				"https://dev.azure.com/example-org/p/_workitems/edit/99",
		});
		expect(row()).toMatchObject({
			externalId: "99",
			pmCreateClaimId: null,
		});
	});

	it("prefers the display number a tool keys its get and update on, as the old extraction did", async () => {
		h.cases.set("tc1", unlinkedRow());
		vi.mocked(executeMcpTool).mockResolvedValue({
			success: true,
			durationMs: 5,
			output: mcpText({
				id: "internal-id",
				card_number: 42,
				url: "https://pm.example.com/cards/42",
			}),
		} as never);

		const result = await createTestCaseInPmWithClaim(common);

		expect(result).toMatchObject({ success: true, externalId: "42" });
		expect(row()).toMatchObject({ externalId: "42" });
	});

	it.each([
		["alone", { id: 0 }],
		["ahead of a later candidate", { id: 0, card_id: "card-9" }],
	])('an id of 0 %s is read and linked as "0"', async (_label, body) => {
		h.cases.set("tc1", unlinkedRow());
		vi.mocked(executeMcpTool).mockResolvedValue({
			success: true,
			durationMs: 5,
			output: mcpText(body),
		} as never);

		const result = await createTestCaseInPmWithClaim(common);

		expect(result).toMatchObject({
			success: true,
			externalId: "0",
			outcome: "created",
		});
		expect(row()).toMatchObject({ externalId: "0", pmCreateClaimId: null });
	});

	it("an id that is neither a string nor a finite number reads as no id: orphan, claim kept", async () => {
		h.cases.set("tc1", unlinkedRow());
		vi.mocked(executeMcpTool).mockResolvedValue({
			success: true,
			durationMs: 5,
			output: mcpText({ id: { value: 1075 } }),
		} as never);

		const result = await createTestCaseInPmWithClaim(common);

		expect(db.$transaction).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			success: false,
			outcome: "create-orphan",
		});
		expect(row()).toMatchObject({
			externalId: null,
			pmCreateClaimId: expect.any(String),
			lastPmSyncStatus: "FAILED",
		});
	});

	describe("linked by another push since the workflow read it (no create sent)", () => {
		const LINK = {
			externalId: "88",
			externalUrl: "https://pm.example.com/cards/88",
		};

		it("a run with this attempt id settles its attempt to SUCCESS, scoped to the attempt and the link it saw", async () => {
			// A multi-case batch linked the case and, seeing the case PENDING
			// for this retry's attempt, left the status to it.
			h.cases.set(
				"tc1",
				unlinkedRow({
					...LINK,
					lastPmSyncStatus: "PENDING",
					lastPmSyncAttemptId: "attempt-A",
				}),
			);

			const result = await createTestCaseInPmWithClaim({
				...common,
				pmSyncAttemptId: "attempt-A",
			});

			expect(executeMcpTool).not.toHaveBeenCalled();
			expect(result).toEqual({
				success: true,
				...LINK,
				outcome: "already-linked",
			});
			expect(row()).toMatchObject({
				...LINK,
				lastPmSyncStatus: "SUCCESS",
				lastPmSyncError: null,
				lastPmSyncAttemptId: "attempt-A",
			});
			expect(db.testCase.updateMany).toHaveBeenCalledWith({
				where: {
					id: "tc1",
					projectId: "project-1",
					lastPmSyncAttemptId: "attempt-A",
					...LINK,
				},
				data: {
					lastPmSyncStatus: "SUCCESS",
					lastPmSyncError: null,
					lastPmSyncAttemptAt: expect.any(Date),
				},
			});
			expect(h.recordPmSyncLog).not.toHaveBeenCalled();
		});

		it("a newer attempt's PENDING is left alone", async () => {
			h.cases.set(
				"tc1",
				unlinkedRow({
					...LINK,
					lastPmSyncStatus: "PENDING",
					lastPmSyncAttemptId: "attempt-B",
				}),
			);

			await createTestCaseInPmWithClaim({
				...common,
				pmSyncAttemptId: "attempt-A",
			});

			expect(row()).toMatchObject({
				lastPmSyncStatus: "PENDING",
				lastPmSyncAttemptId: "attempt-B",
			});
		});

		it("a changed link is not used and this attempt is settled to FAILED", async () => {
			h.cases.set(
				"tc1",
				unlinkedRow({
					externalId: "99",
					externalUrl: "https://pm.example.com/cards/99",
					lastPmSyncStatus: "PENDING",
					lastPmSyncAttemptId: "attempt-A",
				}),
			);
			// The claim read saw link 88; the case now carries 99.
			vi.mocked(db.testCase.findUnique).mockResolvedValueOnce({
				...row(),
				...LINK,
			} as never);

			await createTestCaseInPmWithClaim({
				...common,
				pmSyncAttemptId: "attempt-A",
			});

			expect(row()).toMatchObject({
				externalId: "99",
				lastPmSyncStatus: "FAILED",
				lastPmSyncError: expect.stringContaining("PM link changed"),
			});
		});

		it("the claim-held path that finds the case linked settles the attempt too", async () => {
			h.cases.set(
				"tc1",
				unlinkedRow({
					pmCreateClaimId: "batch-claim",
					lastPmSyncStatus: "PENDING",
					lastPmSyncAttemptId: "attempt-A",
				}),
			);
			// The batch holding the claim links the case after the claim
			// read and before the claim-held stamp.
			const read = vi
				.mocked(db.testCase.findUnique)
				.getMockImplementation();
			vi.mocked(db.testCase.findUnique).mockImplementationOnce((async (
				...args: unknown[]
			) => {
				const seen = await (
					read as (...a: unknown[]) => Promise<unknown>
				)(...args);
				Object.assign(row(), {
					...LINK,
					pmCreateClaimId: null,
				});
				return seen;
			}) as never);

			const result = await createTestCaseInPmWithClaim({
				...common,
				pmSyncAttemptId: "attempt-A",
			});

			expect(result).toMatchObject({
				outcome: "already-linked",
				...LINK,
			});
			expect(row()).toMatchObject({
				...LINK,
				lastPmSyncStatus: "SUCCESS",
				lastPmSyncAttemptId: "attempt-A",
			});
		});
	});

	it("linked since the workflow read it: no create, no write, success with that link", async () => {
		h.cases.set(
			"tc1",
			unlinkedRow({
				externalId: "88",
				externalUrl: "https://pm.example.com/cards/88",
				lastPmSyncStatus: "SUCCESS",
			}),
		);

		const result = await createTestCaseInPmWithClaim(common);

		expect(executeMcpTool).not.toHaveBeenCalled();
		expect(result).toEqual({
			success: true,
			externalId: "88",
			externalUrl: "https://pm.example.com/cards/88",
			outcome: "already-linked",
		});
		expect(h.writes).toEqual([]);
		expect(h.recordPmSyncLog).not.toHaveBeenCalled();
	});

	it("a held claim: no create, create_unconfirmed recorded, the claim untouched", async () => {
		h.cases.set(
			"tc1",
			unlinkedRow({
				pmCreateClaimId: "earlier-run",
				lastPmSyncStatus: "PENDING",
				lastPmSyncAttemptId: "attempt-A",
			}),
		);

		const result = await createTestCaseInPmWithClaim({
			...common,
			pmSyncAttemptId: "attempt-A",
		});

		expect(executeMcpTool).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			success: false,
			outcome: "claim-held",
			error: expect.stringContaining("may already exist"),
		});
		expect(row()).toMatchObject({
			lastPmSyncStatus: "FAILED",
			lastPmSyncError: expect.stringContaining(
				"Fabric did not create this item in fizzy",
			),
			pmCreateClaimId: "earlier-run",
			externalId: null,
		});
		expect(result.error).toContain("Unlink & re-create");
		expect(h.recordPmSyncLog).toHaveBeenCalledWith(
			failureLoggedWith("create_unconfirmed"),
		);
	});

	it.each([
		["another project", { projectId: "project-2" }],
		[
			"another organization",
			{ project: { organizationId: "org-2", userId: "u-2" } },
		],
		["the bin (soft-deleted)", { deletedAt: new Date() }],
	])(
		"a case in %s: no claim, no create, no write",
		async (_label, overrides) => {
			h.cases.set("tc1", unlinkedRow(overrides));

			const result = await createTestCaseInPmWithClaim(common);

			expect(executeMcpTool).not.toHaveBeenCalled();
			expect(result).toMatchObject({
				success: false,
				outcome: "not-in-project",
			});
			expect(h.writes).toEqual([]);
			expect(h.recordPmSyncLog).not.toHaveBeenCalled();
		},
	);

	it.each([
		["a response with no id", mcpText({ ok: true })],
		["a response that cannot be read", null],
	])(
		"created, but %s: claim kept, create_orphan recorded, counted as a failure",
		async (_label, output) => {
			h.cases.set("tc1", unlinkedRow());
			vi.mocked(executeMcpTool).mockResolvedValue({
				success: true,
				durationMs: 5,
				output,
			} as never);

			const result = await createTestCaseInPmWithClaim(common);

			expect(result).toMatchObject({
				success: false,
				outcome: "create-orphan",
				error: expect.stringContaining("could not read its id"),
			});
			expect(result.error).toContain("Unlink & re-create");
			expect(row()).toMatchObject({
				externalId: null,
				pmCreateClaimId: expect.any(String),
				lastPmSyncStatus: "FAILED",
				lastPmSyncError: expect.stringContaining(
					"this test case is not linked to it",
				),
			});
			expect(h.recordPmSyncLog).toHaveBeenCalledWith(
				failureLoggedWith("create_orphan"),
			);
		},
	);

	it("a definite rejection: FAILED for this attempt with the old error text, then the claim is released", async () => {
		h.cases.set(
			"tc1",
			unlinkedRow({
				lastPmSyncStatus: "PENDING",
				lastPmSyncAttemptId: "attempt-A",
			}),
		);
		vi.mocked(executeMcpTool).mockResolvedValue({
			success: false,
			durationMs: 5,
			failureKind: "rejected",
			output: { error: "Invalid work item type" },
		} as never);

		const result = await createTestCaseInPmWithClaim({
			...common,
			pmSyncAttemptId: "attempt-A",
		});

		expect(result).toEqual({
			success: false,
			outcome: "create-rejected",
			error: "Failed to create work item: Invalid work item type",
		});
		expect(row()).toMatchObject({
			pmCreateClaimId: null,
			lastPmSyncStatus: "FAILED",
			lastPmSyncError:
				"Failed to create work item: Invalid work item type",
		});
		expect(h.recordPmSyncLog).toHaveBeenCalledWith(
			failureLoggedWith("push_failed"),
		);
	});

	describe("a late outcome after Unlink & re-create cleared this create's claim and a newer create took one", () => {
		/** Unlink & re-create, then a newer push claims the case (C2). */
		const newerCreate = (state: Record<string, unknown> = {}) =>
			Object.assign(row(), {
				pmCreateClaimId: "claim-C2",
				pmCreateClaimedAt: new Date(),
				lastPmSyncStatus: "PENDING",
				lastPmSyncError: null,
				lastPmSyncAttemptId: "attempt-B",
				...state,
			});

		it.each([
			[
				"a thrown create",
				() => Promise.reject(new Error("socket hang up")),
			],
			[
				"an indeterminate failure",
				() =>
					Promise.resolve({
						success: false,
						durationMs: 5,
						failureKind: "indeterminate",
						output: { error: "timed out" },
					}),
			],
		])(
			"%s: the newer create's state is kept, and the unconfirmed create goes to the sync log only",
			async (_label, outcome) => {
				h.cases.set("tc1", unlinkedRow());
				vi.mocked(executeMcpTool).mockImplementation((async () => {
					newerCreate();
					return outcome();
				}) as never);

				const result = await createTestCaseInPmWithClaim(common);

				expect(result).toMatchObject({
					success: false,
					outcome: "create-unconfirmed",
				});
				expect(row()).toMatchObject({
					pmCreateClaimId: "claim-C2",
					lastPmSyncStatus: "PENDING",
					lastPmSyncError: null,
					lastPmSyncAttemptId: "attempt-B",
				});
				expect(h.recordPmSyncLog).toHaveBeenCalledTimes(1);
				expect(h.recordPmSyncLog.mock.calls[0]?.[0]).toMatchObject({
					status: "FAILURE",
					errorPayload: { errorClass: "create_unconfirmed" },
				});
			},
		);

		it("an ambiguous failure after another push linked the case is not reported as synced", async () => {
			h.cases.set("tc1", unlinkedRow());
			vi.mocked(executeMcpTool).mockImplementation((async () => {
				Object.assign(row(), {
					pmCreateClaimId: null,
					externalId: "88",
					externalUrl: "https://pm.example.com/cards/88",
					lastPmSyncStatus: "SUCCESS",
				});
				throw new Error("socket hang up");
			}) as never);

			const result = await createTestCaseInPmWithClaim(common);

			expect(result).toMatchObject({
				success: false,
				outcome: "create-unconfirmed",
			});
			expect(row()).toMatchObject({
				externalId: "88",
				lastPmSyncStatus: "SUCCESS",
			});
			expect(h.recordPmSyncLog).toHaveBeenCalledTimes(1);
		});

		it("a definite rejection after the newer create linked the case: its SUCCESS is kept, the rejection goes to the log only", async () => {
			h.cases.set("tc1", unlinkedRow());
			vi.mocked(executeMcpTool).mockImplementation((async () => {
				newerCreate({
					pmCreateClaimId: null,
					externalId: "88",
					externalUrl: "https://pm.example.com/cards/88",
					lastPmSyncStatus: "SUCCESS",
					lastPmSyncAttemptId: null,
				});
				return {
					success: false,
					durationMs: 5,
					failureKind: "rejected",
					output: { error: "Invalid work item type" },
				};
			}) as never);

			const result = await createTestCaseInPmWithClaim(common);

			expect(result).toMatchObject({
				success: false,
				outcome: "create-rejected",
			});
			expect(row()).toMatchObject({
				externalId: "88",
				lastPmSyncStatus: "SUCCESS",
				lastPmSyncError: null,
			});
			expect(h.recordPmSyncLog).toHaveBeenCalledTimes(1);
			expect(h.recordPmSyncLog.mock.calls[0]?.[0]).toMatchObject({
				errorPayload: { errorClass: "push_failed" },
			});
		});

		it("a definite rejection while the newer create holds its claim: its PENDING and claim are kept", async () => {
			h.cases.set("tc1", unlinkedRow());
			vi.mocked(executeMcpTool).mockImplementation((async () => {
				newerCreate({ lastPmSyncAttemptId: null });
				return {
					success: false,
					durationMs: 5,
					failureKind: "rejected",
					output: { error: "Invalid work item type" },
				};
			}) as never);

			await createTestCaseInPmWithClaim(common);

			expect(row()).toMatchObject({
				pmCreateClaimId: "claim-C2",
				lastPmSyncStatus: "PENDING",
			});
		});

		it("a claim that kept slipping (no claim seen to fence on): nothing sent, nothing written, the claim-held outcome logged only", async () => {
			// Each claim UPDATE misses a held claim whose owner releases it
			// before the read, three times; then a newer retry claims the
			// case (C4) and stamps its PENDING.
			h.cases.set("tc1", unlinkedRow({ pmCreateClaimId: "claim-C3" }));
			for (let i = 0; i < 3; i++) {
				vi.mocked(db.testCase.findUnique).mockImplementationOnce(
					(async () => {
						const seen = { ...row(), pmCreateClaimId: null };
						if (i === 2) {
							newerCreate({ pmCreateClaimId: "claim-C4" });
						}
						return seen;
					}) as never,
				);
			}

			const result = await createTestCaseInPmWithClaim(common);

			expect(executeMcpTool).not.toHaveBeenCalled();
			expect(result).toMatchObject({
				success: false,
				outcome: "claim-held",
			});
			expect(row()).toMatchObject({
				pmCreateClaimId: "claim-C4",
				lastPmSyncStatus: "PENDING",
				lastPmSyncError: null,
				lastPmSyncAttemptId: "attempt-B",
			});
			expect(h.recordPmSyncLog).toHaveBeenCalledTimes(1);
			expect(h.recordPmSyncLog.mock.calls[0]?.[0]).toMatchObject({
				errorPayload: { errorClass: "create_unconfirmed" },
			});
		});

		it("the claim-held stamp is fenced on the claim it saw: a newer create's claim and PENDING are kept", async () => {
			h.cases.set("tc1", unlinkedRow({ pmCreateClaimId: "claim-C1" }));
			// Between the claim read and the stamp, Unlink & re-create clears
			// C1 and a newer create takes C2.
			const read = vi
				.mocked(db.testCase.findUnique)
				.getMockImplementation();
			vi.mocked(db.testCase.findUnique).mockImplementationOnce((async (
				...args: unknown[]
			) => {
				const seen = await (
					read as (...a: unknown[]) => Promise<unknown>
				)(...args);
				newerCreate();
				return seen;
			}) as never);

			const result = await createTestCaseInPmWithClaim(common);

			expect(result).toMatchObject({
				success: false,
				outcome: "claim-held",
			});
			expect(row()).toMatchObject({
				pmCreateClaimId: "claim-C2",
				lastPmSyncStatus: "PENDING",
				lastPmSyncError: null,
			});
		});
	});

	it("a definite rejection leaves a newer attempt's PENDING alone", async () => {
		h.cases.set(
			"tc1",
			unlinkedRow({
				lastPmSyncStatus: "PENDING",
				lastPmSyncAttemptId: "attempt-B",
			}),
		);
		vi.mocked(executeMcpTool).mockResolvedValue({
			success: false,
			durationMs: 5,
			failureKind: "rejected",
			output: { error: "Read-only" },
		} as never);

		await createTestCaseInPmWithClaim({
			...common,
			pmSyncAttemptId: "attempt-A",
		});

		expect(row()).toMatchObject({
			pmCreateClaimId: null,
			lastPmSyncStatus: "PENDING",
			lastPmSyncAttemptId: "attempt-B",
		});
		expect(h.recordPmSyncLog).not.toHaveBeenCalled();
	});

	it.each([
		["error_result", { error: "upstream 502" }],
		["indeterminate", { error: "timed out" }],
		[undefined, { error: "no failure kind" }],
	])(
		"failureKind %s: claim kept, create_unconfirmed recorded",
		async (failureKind, output) => {
			h.cases.set("tc1", unlinkedRow());
			vi.mocked(executeMcpTool).mockResolvedValue({
				success: false,
				durationMs: 5,
				...(failureKind ? { failureKind } : {}),
				output,
			} as never);

			const result = await createTestCaseInPmWithClaim(common);

			expect(result).toMatchObject({
				success: false,
				outcome: "create-unconfirmed",
				error: expect.stringContaining(output.error),
			});
			expect(row()).toMatchObject({
				pmCreateClaimId: expect.any(String),
				lastPmSyncStatus: "FAILED",
				lastPmSyncError: expect.stringContaining(
					"cannot tell whether fizzy created the item",
				),
			});
			expect(h.recordPmSyncLog).toHaveBeenCalledWith(
				failureLoggedWith("create_unconfirmed"),
			);
		},
	);

	it("a thrown create: claim kept, create_unconfirmed recorded, returned not thrown", async () => {
		h.cases.set("tc1", unlinkedRow());
		vi.mocked(executeMcpTool).mockRejectedValue(
			new Error("socket hang up"),
		);

		const result = await createTestCaseInPmWithClaim(common);

		expect(result).toMatchObject({
			success: false,
			outcome: "create-unconfirmed",
			error: expect.stringContaining("socket hang up"),
		});
		expect(row()).toMatchObject({
			pmCreateClaimId: expect.any(String),
			lastPmSyncStatus: "FAILED",
		});
	});

	it("the GitLab instance check refuses before sending: FAILED, and the claim is released", async () => {
		h.cases.set("tc1", unlinkedRow());
		const refusal = Object.assign(new Error("bound to another instance"), {
			type: "GitLabPmOriginMismatch",
		});
		vi.mocked(executeMcpTool).mockRejectedValue(refusal);

		const result = await createTestCaseInPmWithClaim(common);

		expect(result).toEqual({
			success: false,
			outcome: "create-rejected",
			error: "bound to another instance",
		});
		expect(row()).toMatchObject({
			pmCreateClaimId: null,
			lastPmSyncStatus: "FAILED",
			lastPmSyncError: "bound to another instance",
		});
	});

	it("a retry after an attempt whose create got no answer sends nothing", async () => {
		h.cases.set("tc1", unlinkedRow());
		vi.mocked(executeMcpTool).mockResolvedValue({
			success: false,
			durationMs: 5,
			failureKind: "indeterminate",
			output: { error: "timed out" },
		} as never);

		await createTestCaseInPmWithClaim(common);
		const retry = await createTestCaseInPmWithClaim(common);

		expect(executeMcpTool).toHaveBeenCalledTimes(1);
		expect(retry).toMatchObject({ success: false, outcome: "claim-held" });
	});

	it("a loser's create_unconfirmed, recorded while this create held the claim, is replaced by SUCCESS once linked", async () => {
		h.cases.set("tc1", unlinkedRow());
		let loser: Awaited<
			ReturnType<typeof createTestCaseInPmWithClaim>
		> | null = null;
		vi.mocked(executeMcpTool).mockImplementation((async () => {
			loser = await createTestCaseInPmWithClaim(common);
			expect(row()).toMatchObject({ lastPmSyncStatus: "FAILED" });
			return created;
		}) as never);

		const result = await createTestCaseInPmWithClaim(common);

		expect(executeMcpTool).toHaveBeenCalledTimes(1);
		expect(loser).toMatchObject({ outcome: "claim-held" });
		expect(result).toMatchObject({ success: true, outcome: "created" });
		expect(row()).toMatchObject({
			externalId: "1075",
			pmCreateClaimId: null,
			lastPmSyncStatus: "SUCCESS",
			lastPmSyncError: null,
		});
	});

	describe("attempt scoping of the SUCCESS", () => {
		it("a run with this attempt id writes SUCCESS while the case names that attempt", async () => {
			h.cases.set(
				"tc1",
				unlinkedRow({
					lastPmSyncStatus: "PENDING",
					lastPmSyncAttemptId: "attempt-A",
				}),
			);
			vi.mocked(executeMcpTool).mockResolvedValue(created as never);

			await createTestCaseInPmWithClaim({
				...common,
				pmSyncAttemptId: "attempt-A",
			});

			expect(row()).toMatchObject({
				externalId: "1075",
				lastPmSyncStatus: "SUCCESS",
				lastPmSyncAttemptId: "attempt-A",
			});
		});

		it("a run with an older attempt id links the case but leaves a newer attempt's PENDING", async () => {
			h.cases.set("tc1", unlinkedRow());
			vi.mocked(executeMcpTool).mockImplementation((async () => {
				Object.assign(row(), {
					lastPmSyncStatus: "PENDING",
					lastPmSyncAttemptId: "attempt-B",
				});
				return created;
			}) as never);

			const result = await createTestCaseInPmWithClaim({
				...common,
				pmSyncAttemptId: "attempt-A",
			});

			expect(result).toMatchObject({ success: true, outcome: "created" });
			expect(row()).toMatchObject({
				externalId: "1075",
				pmCreateClaimId: null,
				lastPmSyncStatus: "PENDING",
				lastPmSyncAttemptId: "attempt-B",
			});
		});

		it("a run with no attempt id links the case but leaves a row PENDING for an attempt", async () => {
			h.cases.set("tc1", unlinkedRow());
			vi.mocked(executeMcpTool).mockImplementation((async () => {
				Object.assign(row(), {
					lastPmSyncStatus: "PENDING",
					lastPmSyncAttemptId: "attempt-C",
				});
				return created;
			}) as never);

			const result = await createTestCaseInPmWithClaim(common);

			expect(result).toMatchObject({ success: true, outcome: "created" });
			expect(row()).toMatchObject({
				externalId: "1075",
				pmCreateClaimId: null,
				lastSyncedAt: expect.any(Date),
				lastPmSyncStatus: "PENDING",
				lastPmSyncAttemptId: "attempt-C",
			});
			expect(db.$transaction).toHaveBeenCalledTimes(1);
		});

		it.each(["FAILED", "CONFLICT"] as const)(
			"an attempt that stamps PENDING and then %s after the link commits keeps its state",
			async (terminal) => {
				h.cases.set("tc1", unlinkedRow());
				vi.mocked(executeMcpTool).mockResolvedValue(created as never);
				h.afterCommit = async () => {
					Object.assign(row(), {
						lastPmSyncStatus: "PENDING",
						lastPmSyncAttemptId: "attempt-B",
					});
					await writePmSyncStatusForAttempt({
						itemType: "testCase",
						itemId: "tc1",
						attemptId: "attempt-B",
						data: {
							lastPmSyncStatus: terminal,
							lastPmSyncError: `attempt B ${terminal}`,
						},
					});
				};

				const result = await createTestCaseInPmWithClaim(common);

				expect(result).toMatchObject({
					success: true,
					outcome: "created",
				});
				expect(row()).toMatchObject({
					externalId: "1075",
					lastPmSyncStatus: terminal,
					lastPmSyncError: `attempt B ${terminal}`,
				});
				expect(successWrites()).toEqual([
					expect.objectContaining({ via: "tx" }),
				]);
			},
		);
	});

	it("a status write that fails rolls the link back with it, and the next try commits both", async () => {
		h.cases.set("tc1", unlinkedRow({ lastPmSyncStatus: "FAILED" }));
		vi.mocked(executeMcpTool).mockResolvedValue(created as never);
		// The link write is the first updateMany in the transaction; the
		// status write is the second. Fail the second.
		const firstTx = vi.mocked(db.$transaction).getMockImplementation();
		vi.mocked(db.$transaction).mockImplementationOnce((async (
			fn: (tx: object) => Promise<unknown>,
		) =>
			(firstTx as (f: typeof fn) => Promise<unknown>)(async (tx) => {
				const client = tx as {
					testCase: { updateMany: (...a: unknown[]) => unknown };
				};
				const real = client.testCase.updateMany;
				let calls = 0;
				client.testCase.updateMany = async (...args: unknown[]) => {
					calls++;
					if (calls === 2) {
						throw new Error("deadlock detected");
					}
					return real(...args);
				};
				return fn(tx);
			})) as never);

		const result = await createTestCaseInPmWithClaim(common);

		expect(result).toMatchObject({ success: true, outcome: "created" });
		expect(db.$transaction).toHaveBeenCalledTimes(2);
		expect(row()).toMatchObject({
			externalId: "1075",
			pmCreateClaimId: null,
			lastPmSyncStatus: "SUCCESS",
		});
	});

	it("a link write that keeps failing while this claim is held: claim kept, create_orphan stamped on the row", async () => {
		h.cases.set("tc1", unlinkedRow());
		vi.mocked(executeMcpTool).mockResolvedValue(created as never);
		vi.mocked(db.$transaction).mockRejectedValueOnce(
			new Error("pool exhausted"),
		);
		vi.mocked(db.$transaction).mockRejectedValueOnce(
			new Error("pool exhausted"),
		);
		vi.mocked(db.$transaction).mockRejectedValueOnce(
			new Error("pool exhausted"),
		);

		const result = await createTestCaseInPmWithClaim(common);

		expect(db.$transaction).toHaveBeenCalledTimes(3);
		expect(result).toMatchObject({
			success: false,
			outcome: "create-orphan",
			externalId: "1075",
			error: expect.stringContaining("pool exhausted"),
		});
		expect(result.error).toContain("Unlink & re-create");
		expect(row()).toMatchObject({
			externalId: null,
			pmCreateClaimId: expect.any(String),
			lastPmSyncStatus: "FAILED",
			lastPmSyncError: expect.stringContaining("Item 1075 was created"),
		});
		expect(h.recordPmSyncLog).toHaveBeenCalledWith(
			failureLoggedWith("create_orphan"),
		);
	});

	it("the claim cleared by Unlink & re-create while the create was in flight: the link write is refused once, and the orphan goes to the log only", async () => {
		h.cases.set("tc1", unlinkedRow());
		vi.mocked(executeMcpTool).mockImplementation((async () => {
			Object.assign(row(), {
				pmCreateClaimId: null,
				pmCreateClaimedAt: null,
			});
			return created;
		}) as never);

		const result = await createTestCaseInPmWithClaim(common);

		expect(db.$transaction).toHaveBeenCalledTimes(1);
		expect(result).toMatchObject({
			success: false,
			outcome: "create-orphan",
			externalId: "1075",
			error: expect.stringContaining("Item 1075 was created in fizzy"),
		});
		expect(row()).toMatchObject({
			externalId: null,
			pmCreateClaimId: null,
			lastPmSyncStatus: null,
		});
		expect(h.recordPmSyncLog).toHaveBeenCalledTimes(1);
		expect(h.recordPmSyncLog.mock.calls[0]?.[0]).toMatchObject({
			status: "FAILURE",
			errorPayload: { errorClass: "create_orphan" },
			externalId: "1075",
			externalUrl: "https://pm.example.com/cards/1075",
		});
	});

	it("another create took a fresh claim after Unlink & re-create: this create's orphan is not stamped on the row", async () => {
		h.cases.set("tc1", unlinkedRow());
		vi.mocked(executeMcpTool).mockImplementation((async () => {
			Object.assign(row(), {
				pmCreateClaimId: "claim-of-another-create",
				lastPmSyncStatus: null,
			});
			return created;
		}) as never);

		const result = await createTestCaseInPmWithClaim(common);

		expect(result).toMatchObject({
			success: false,
			outcome: "create-orphan",
			externalId: "1075",
		});
		expect(row()).toMatchObject({
			externalId: null,
			pmCreateClaimId: "claim-of-another-create",
			lastPmSyncStatus: null,
		});
		expect(h.recordPmSyncLog).toHaveBeenCalledTimes(1);
	});

	describe("another push links the case after Unlink & re-create cleared this create's claim", () => {
		function linkOtherItem() {
			Object.assign(row(), {
				pmCreateClaimId: null,
				pmCreateClaimedAt: null,
				externalId: "88",
				externalUrl: "https://pm.example.com/cards/88",
				externalMcpServerId: "server-1",
				lastPmSyncStatus: "SUCCESS",
				lastPmSyncError: null,
			});
		}

		function expectOtherLinkKept() {
			expect(row()).toMatchObject({
				externalId: "88",
				externalUrl: "https://pm.example.com/cards/88",
				lastPmSyncStatus: "SUCCESS",
				lastPmSyncError: null,
			});
		}

		it("a create whose response has no readable id: the orphan goes to the log only", async () => {
			h.cases.set("tc1", unlinkedRow());
			vi.mocked(executeMcpTool).mockImplementation((async () => {
				linkOtherItem();
				return {
					success: true,
					durationMs: 5,
					output: mcpText({ ok: true }),
				};
			}) as never);

			const result = await createTestCaseInPmWithClaim(common);

			expect(result).toMatchObject({
				success: false,
				outcome: "create-orphan",
				error: expect.stringContaining("could not read its id"),
			});
			expectOtherLinkKept();
			expect(h.recordPmSyncLog).toHaveBeenCalledTimes(1);
			expect(h.recordPmSyncLog.mock.calls[0]?.[0]).toMatchObject({
				errorPayload: { errorClass: "create_orphan" },
				externalId: null,
				externalUrl: null,
			});
		});

		it("the re-read after the refused link write fails: the orphan goes to the log only", async () => {
			h.cases.set("tc1", unlinkedRow());
			vi.mocked(executeMcpTool).mockImplementation((async () => {
				linkOtherItem();
				// The tenant check has run; the next findFirst is the re-read.
				vi.mocked(db.testCase.findFirst).mockRejectedValueOnce(
					new Error("read timeout"),
				);
				return created;
			}) as never);

			const result = await createTestCaseInPmWithClaim(common);

			expect(result).toMatchObject({
				success: false,
				outcome: "create-orphan",
				externalId: "1075",
			});
			expectOtherLinkKept();
			expect(h.recordPmSyncLog).toHaveBeenCalledTimes(1);
			expect(h.recordPmSyncLog.mock.calls[0]?.[0]).toMatchObject({
				errorPayload: { errorClass: "create_orphan" },
				externalId: "1075",
			});
		});

		it("the other push links after the re-read saw the case unlinked: the orphan goes to the log only", async () => {
			h.cases.set("tc1", unlinkedRow());
			vi.mocked(executeMcpTool).mockImplementation((async () => {
				Object.assign(row(), {
					pmCreateClaimId: null,
					pmCreateClaimedAt: null,
				});
				const read = vi
					.mocked(db.testCase.findFirst)
					.getMockImplementation();
				vi.mocked(db.testCase.findFirst).mockImplementationOnce((async (
					...args: unknown[]
				) => {
					const seen = await (
						read as (...a: unknown[]) => Promise<unknown>
					)(...args);
					linkOtherItem();
					return seen;
				}) as never);
				return created;
			}) as never);

			const result = await createTestCaseInPmWithClaim(common);

			expect(result).toMatchObject({
				success: false,
				outcome: "create-orphan",
				externalId: "1075",
			});
			expectOtherLinkKept();
			expect(h.recordPmSyncLog).toHaveBeenCalledTimes(1);
		});
	});

	it("a link write that committed but lost its answer is confirmed on id, URL and server, with no second status write", async () => {
		h.cases.set("tc1", unlinkedRow());
		vi.mocked(executeMcpTool).mockResolvedValue(created as never);
		h.loseNextCommitAck = true;
		h.afterCommit = async () => {
			Object.assign(row(), {
				lastPmSyncStatus: "PENDING",
				lastPmSyncAttemptId: "attempt-B",
			});
			await writePmSyncStatusForAttempt({
				itemType: "testCase",
				itemId: "tc1",
				attemptId: "attempt-B",
				data: { lastPmSyncStatus: "CONFLICT" },
			});
		};

		const result = await createTestCaseInPmWithClaim(common);

		expect(db.$transaction).toHaveBeenCalledTimes(2);
		expect(result).toEqual({
			success: true,
			externalId: "1075",
			externalUrl: "https://pm.example.com/cards/1075",
			outcome: "created",
		});
		expect(row()).toMatchObject({
			externalId: "1075",
			externalMcpServerId: "server-1",
			pmCreateClaimId: null,
			lastPmSyncStatus: "CONFLICT",
			lastPmSyncAttemptId: "attempt-B",
		});
		expect(successWrites()).toEqual([
			expect.objectContaining({ via: "tx" }),
		]);
		expect(h.recordPmSyncLog).not.toHaveBeenCalled();
	});

	it.each([
		[
			"the same id and server on another URL",
			created.output,
			"https://pm-other.example.com/cards/1075",
			"server-1",
		],
		[
			"the same id and URL on another server",
			created.output,
			"https://pm.example.com/cards/1075",
			"server-2",
		],
		[
			"the same id and server, when the create returned no URL",
			mcpText({ id: "1075" }),
			null,
			"server-1",
		],
	])(
		"a link with %s, written after Unlink & re-create cleared the claim, is not taken as this create's",
		async (_label, output, otherUrl, otherServer) => {
			h.cases.set("tc1", unlinkedRow());
			vi.mocked(executeMcpTool).mockImplementation((async () => {
				Object.assign(row(), {
					pmCreateClaimId: null,
					pmCreateClaimedAt: null,
					externalId: "1075",
					externalUrl: otherUrl,
					externalMcpServerId: otherServer,
					lastPmSyncStatus: "SUCCESS",
					lastPmSyncError: null,
				});
				return { success: true, durationMs: 5, output };
			}) as never);

			const result = await createTestCaseInPmWithClaim(common);

			expect(result).toMatchObject({
				success: false,
				outcome: "create-orphan",
				externalId: "1075",
				error: expect.stringContaining(
					"Fabric could not link this test case to it",
				),
			});
			expect(row()).toMatchObject({
				externalId: "1075",
				externalUrl: otherUrl,
				externalMcpServerId: otherServer,
				lastPmSyncStatus: "SUCCESS",
				lastPmSyncError: null,
			});
			expect(
				h.writes.filter((w) => "lastPmSyncStatus" in w.data),
			).toEqual([]);
			expect(h.recordPmSyncLog).toHaveBeenCalledTimes(1);
			expect(h.recordPmSyncLog.mock.calls[0]?.[0]).toMatchObject({
				errorPayload: { errorClass: "create_orphan" },
				externalId: "1075",
			});
		},
	);

	describe("the drift baseline, after the link has committed", () => {
		const baseline = {
			mcpConfigId: "config-1",
			capabilities: CAPABILITIES,
			userId: "u-1",
			organizationId: "org-1",
			containerId: "board-1",
			containerName: "Board",
			additionalContext: { account_slug: "example-org" },
		};

		it("reads the new item back and stamps its hash on the link it wrote", async () => {
			h.cases.set("tc1", unlinkedRow());
			vi.mocked(executeMcpTool).mockResolvedValue(created as never);
			vi.mocked(fetchPmTicket).mockImplementation((async () => {
				// The link (and its SUCCESS) committed before the read-back.
				expect(row()).toMatchObject({
					externalId: "1075",
					lastPmSyncStatus: "SUCCESS",
				});
				return {
					title: "Login works",
					description: "<p>Steps</p>",
					lastChangedBy: null,
					lastChangedAt: null,
				};
			}) as never);

			const result = await createTestCaseInPmWithClaim({
				...common,
				baseline,
			});

			expect(result).toMatchObject({ success: true, outcome: "created" });
			expect(fetchPmTicket).toHaveBeenCalledWith({
				mcpConfigId: "config-1",
				userId: "u-1",
				organizationId: "org-1",
				capabilities: CAPABILITIES,
				externalId: "1075",
				containerId: "board-1",
				containerName: "Board",
				additionalContext: { account_slug: "example-org" },
			});
			expect(row().lastSyncedPmHash).toBe(
				computePmHash("Login works", "<p>Steps</p>"),
			);
		});

		it("a failed read-back keeps the link and its SUCCESS, with no baseline", async () => {
			h.cases.set("tc1", unlinkedRow({ lastSyncedPmHash: "stale" }));
			vi.mocked(executeMcpTool).mockResolvedValue(created as never);
			vi.mocked(fetchPmTicket).mockRejectedValue(new Error("502"));

			const result = await createTestCaseInPmWithClaim({
				...common,
				baseline,
			});

			expect(result).toMatchObject({ success: true, outcome: "created" });
			expect(row()).toMatchObject({
				externalId: "1075",
				lastPmSyncStatus: "SUCCESS",
				lastSyncedPmHash: null,
			});
		});

		it("is not stamped once the case carries another link, or a newer baseline", async () => {
			h.cases.set("tc1", unlinkedRow());
			vi.mocked(executeMcpTool).mockResolvedValue(created as never);
			vi.mocked(fetchPmTicket).mockImplementation((async () => {
				Object.assign(row(), { lastSyncedPmHash: "newer-push" });
				return {
					title: "t",
					description: "d",
					lastChangedBy: null,
					lastChangedAt: null,
				};
			}) as never);

			await createTestCaseInPmWithClaim({ ...common, baseline });

			expect(row().lastSyncedPmHash).toBe("newer-push");
		});

		it("is not read when the tool has no get, or there is no baseline input", async () => {
			h.cases.set("tc1", unlinkedRow());
			vi.mocked(executeMcpTool).mockResolvedValue(created as never);

			await createTestCaseInPmWithClaim({
				...common,
				baseline: { ...baseline, capabilities: { detectedType: "x" } },
			} as never);
			h.cases.set("tc1", unlinkedRow());
			await createTestCaseInPmWithClaim(common);

			expect(fetchPmTicket).not.toHaveBeenCalled();
		});
	});
});

const judgedLink = {
	externalId: "42",
	externalUrl: "https://linear.app/example-org/issue/42",
	externalMcpServerId: "server-old",
};
const checkInput = {
	...common,
	...judgedLink,
	pmTool: "azure-devops",
	toolLabel: "azure-devops",
};

describe("checkTestCasePmLink refusal", () => {
	it.each(["server-old", null])(
		"stamps a mismatched link (%s) FAILED with the UI recovery message",
		async (externalMcpServerId) => {
			h.cases.set(
				"tc1",
				unlinkedRow({ ...judgedLink, externalMcpServerId }),
			);
			const result = await checkTestCasePmLink({
				...checkInput,
				externalMcpServerId,
			});
			expect(result).toMatchObject({
				success: false,
				error: expect.stringMatching(
					/linked to a ticket in a different PM tool.*Unlink & re-create/,
				),
			});
			expect(row()).toMatchObject({
				...judgedLink,
				externalMcpServerId,
				lastPmSyncStatus: "FAILED",
				lastPmSyncError: "error" in result ? result.error : undefined,
			});
		},
	);

	it("allows a link stamped with the active server without changing its state", async () => {
		h.cases.set(
			"tc1",
			unlinkedRow({
				...judgedLink,
				externalMcpServerId: "server-1",
				lastPmSyncStatus: "SUCCESS",
			}),
		);
		expect(
			await checkTestCasePmLink({
				...checkInput,
				externalMcpServerId: "server-1",
			}),
		).toEqual({ success: true });
		expect(row().lastPmSyncStatus).toBe("SUCCESS");
		expect(h.writes).toHaveLength(0);
	});

	it.each(["externalId", "externalUrl", "externalMcpServerId"])(
		"does not judge a link whose %s changed before the activity read",
		async (field) => {
			h.cases.set(
				"tc1",
				unlinkedRow({
					...judgedLink,
					[field]: "replacement",
					lastPmSyncStatus: "SUCCESS",
				}),
			);
			const result = await checkTestCasePmLink(checkInput);
			expect(result).toMatchObject({
				success: false,
				outcome: "link-changed",
			});
			expect(row().lastPmSyncStatus).toBe("SUCCESS");
			expect(h.writes).toHaveLength(0);
		},
	);

	it.each([undefined, "attempt-A"])(
		"fences the refusal at the write on the complete link and attempt (%s)",
		async (pmSyncAttemptId) => {
			for (const field of [
				"externalId",
				"externalUrl",
				"externalMcpServerId",
				"lastPmSyncAttemptId",
			]) {
				h.cases.set(
					"tc1",
					unlinkedRow({
						...judgedLink,
						lastPmSyncAttemptId: pmSyncAttemptId ?? null,
						lastPmSyncStatus: pmSyncAttemptId
							? "PENDING"
							: "SUCCESS",
					}),
				);
				// The config read is an await between the row snapshot and the fenced write.
				vi.mocked(db.mCPConfig.findFirst).mockImplementationOnce(
					(() => {
						Object.assign(row(), { [field]: "replacement" });
						return {
							baseUrl: "https://pm.example.com",
							mcpServer: { key: "azure-devops" },
						} as never;
					}) as never,
				);
				const result = await checkTestCasePmLink({
					...checkInput,
					pmSyncAttemptId,
				});
				expect(result).toMatchObject({
					success: false,
					outcome:
						field === "lastPmSyncAttemptId"
							? "attempt-superseded"
							: "link-changed",
				});
				expect(row().lastPmSyncStatus).toBe(
					pmSyncAttemptId && field !== "lastPmSyncAttemptId"
						? "FAILED"
						: pmSyncAttemptId
							? "PENDING"
							: "SUCCESS",
				);
			}
		},
	);

	it("records refusal for the current single-case retry while it is PENDING", async () => {
		h.cases.set(
			"tc1",
			unlinkedRow({
				...judgedLink,
				lastPmSyncAttemptId: "attempt-A",
				lastPmSyncStatus: "PENDING",
			}),
		);
		const result = await checkTestCasePmLink({
			...checkInput,
			pmSyncAttemptId: "attempt-A",
		});
		expect(result.success).toBe(false);
		expect(row()).toMatchObject({
			lastPmSyncStatus: "FAILED",
			lastPmSyncError: expect.stringContaining("Unlink & re-create"),
		});
	});

	it("refuses an unstamped link on another self-hosted tool instance", async () => {
		const link = {
			externalId: "42",
			externalUrl: "https://old.example.com/issues/42",
			externalMcpServerId: null,
		};
		h.cases.set("tc1", unlinkedRow(link));
		const result = await checkTestCasePmLink({ ...checkInput, ...link });
		expect(result).toMatchObject({
			success: false,
			outcome: "legacy-other-tool",
		});
		expect(row().lastPmSyncStatus).toBe("FAILED");
	});
});

describe("test-case legacy GitLab link instance", () => {
	it.each(["https://gitlab.com", "https://gitlab.example.com:8443"])(
		"refuses link origin %s when the active GitLab has another origin",
		async (origin) => {
			const link = {
				externalId: "42",
				externalUrl: `${origin}/example-org/project/issues/42`,
				externalMcpServerId: null,
			};
			h.cases.set("tc1", unlinkedRow(link));
			vi.mocked(db.mCPConfig.findFirst).mockResolvedValue({
				baseUrl: "https://gitlab.example.com",
				mcpServer: { key: "gitlab", defaultUrl: null },
			} as never);
			const result = await checkTestCasePmLink({
				...checkInput,
				...link,
				pmTool: "gitlab",
				toolLabel: "gitlab",
			});
			expect(result).toMatchObject({
				success: false,
				outcome: "legacy-other-tool",
			});
			expect(row().lastPmSyncStatus).toBe("FAILED");
		},
	);
});

describe("a stale link discovered on the create path", () => {
	it.each(["server-old", null])(
		"does not report a link (%s) as synced for the execution push",
		async (externalMcpServerId) => {
			h.cases.set(
				"tc1",
				unlinkedRow({ ...judgedLink, externalMcpServerId }),
			);
			const result = await createTestCaseInPmWithClaim(common);
			expect(result).toMatchObject({
				success: false,
				error: expect.stringContaining("Unlink & re-create"),
			});
			expect(row().lastPmSyncStatus).toBe("FAILED");
			expect(executeMcpTool).not.toHaveBeenCalled();
		},
	);
});

describe("test-case link guard state settlement", () => {
	it.each([undefined, "attempt-A"])(
		"reports another attempt rather than a changed link (%s)",
		async (pmSyncAttemptId) => {
			h.cases.set(
				"tc1",
				unlinkedRow({
					...judgedLink,
					lastPmSyncAttemptId: "attempt-B",
					lastPmSyncStatus: "PENDING",
				}),
			);
			const result = await checkTestCasePmLink({
				...checkInput,
				pmSyncAttemptId,
			});
			expect(result).toMatchObject({
				success: false,
				outcome: "attempt-superseded",
				error: expect.stringContaining("Another PM sync attempt"),
			});
			expect(row()).toMatchObject({
				lastPmSyncStatus: "PENDING",
				lastPmSyncAttemptId: "attempt-B",
			});
		},
	);

	it.each(["guard", "already-linked"])(
		"throws on a failed refusal stamp with an unchanged link through %s",
		async (entry) => {
			h.cases.set(
				"tc1",
				unlinkedRow({
					...judgedLink,
					lastPmSyncAttemptId: "attempt-A",
					lastPmSyncStatus: "PENDING",
				}),
			);
			// Inject at the refusal boundary, after any create-claim acquisition.
			vi.mocked(db.mCPConfig.findFirst).mockImplementationOnce((() => {
				vi.mocked(db.testCase.updateMany).mockRejectedValueOnce(
					new Error("state write unavailable"),
				);
				return {
					baseUrl: "https://pm.example.com",
					mcpServer: { key: "azure-devops" },
				} as never;
			}) as never);
			const result =
				entry === "guard"
					? checkTestCasePmLink({
							...checkInput,
							pmSyncAttemptId: "attempt-A",
						})
					: createTestCaseInPmWithClaim({
							...common,
							pmSyncAttemptId: "attempt-A",
						});
			await expect(result).rejects.toThrow(
				/could not record.*PM link refusal/i,
			);
			expect(row().lastPmSyncStatus).toBe("PENDING");
		},
	);

	it.each(["externalId", "externalUrl", "externalMcpServerId"])(
		"settles its own attempt when %s changed before the guard read",
		async (field) => {
			h.cases.set(
				"tc1",
				unlinkedRow({
					...judgedLink,
					[field]: "replacement",
					lastPmSyncAttemptId: "attempt-A",
					lastPmSyncStatus: "PENDING",
				}),
			);
			const result = await checkTestCasePmLink({
				...checkInput,
				pmSyncAttemptId: "attempt-A",
			});
			expect(result).toMatchObject({
				success: false,
				outcome: "link-changed",
			});
			expect(row()).toMatchObject({
				[field]: "replacement",
				lastPmSyncAttemptId: "attempt-A",
				lastPmSyncStatus: "FAILED",
				lastPmSyncError: expect.stringContaining("PM link changed"),
			});
		},
	);

	it("does not overwrite a newer attempt that takes over during link-changed settlement", async () => {
		h.cases.set(
			"tc1",
			unlinkedRow({
				...judgedLink,
				externalUrl: "https://pm.example.com/replacement",
				lastPmSyncAttemptId: "attempt-A",
				lastPmSyncStatus: "PENDING",
			}),
		);
		const update = vi
			.mocked(db.testCase.updateMany)
			.getMockImplementation();
		vi.mocked(db.testCase.updateMany).mockImplementationOnce(((
			...args: unknown[]
		) => {
			Object.assign(row(), { lastPmSyncAttemptId: "attempt-B" });
			return (update as (...args: unknown[]) => unknown)(...args);
		}) as never);
		const result = await checkTestCasePmLink({
			...checkInput,
			pmSyncAttemptId: "attempt-A",
		});
		expect(result).toMatchObject({
			success: false,
			outcome: "attempt-superseded",
		});
		expect(row()).toMatchObject({
			lastPmSyncAttemptId: "attempt-B",
			lastPmSyncStatus: "PENDING",
		});
	});

	it("propagates a link-changed settlement write failure", async () => {
		h.cases.set(
			"tc1",
			unlinkedRow({
				...judgedLink,
				externalUrl: "https://pm.example.com/replacement",
				lastPmSyncAttemptId: "attempt-A",
				lastPmSyncStatus: "PENDING",
			}),
		);
		vi.mocked(db.testCase.updateMany).mockRejectedValueOnce(
			new Error("settlement unavailable"),
		);
		await expect(
			checkTestCasePmLink({
				...checkInput,
				pmSyncAttemptId: "attempt-A",
			}),
		).rejects.toThrow("settlement unavailable");
	});

	it.each(["same", "other"])(
		"judges an unstamped %s-instance link without an MCP config",
		async (instance) => {
			const link = {
				externalId: "42",
				externalUrl: `https://${instance === "same" ? "gitlab" : "old"}.example.com/example-org/project/issues/42`,
				externalMcpServerId: null,
			};
			h.cases.set("tc1", unlinkedRow(link));
			vi.mocked(db.mCPServer.findUnique).mockResolvedValue({
				key: "gitlab",
				defaultUrl: "https://gitlab.example.com",
			} as never);
			const result = await checkTestCasePmLink({
				...checkInput,
				...link,
				mcpConfigId: null,
				pmTool: "gitlab",
			});
			expect(result).toMatchObject(
				instance === "same"
					? { success: true }
					: { success: false, outcome: "legacy-other-tool" },
			);
			expect(row().lastPmSyncStatus).toBe(
				instance === "same" ? null : "FAILED",
			);
		},
	);

	it.each(["config-1", null])(
		"throws a non-retryable PM error when the configuration/server is missing (%s)",
		async (mcpConfigId) => {
			h.cases.set("tc1", unlinkedRow(judgedLink));
			vi.mocked(db.mCPConfig.findFirst).mockResolvedValue(null);
			await expect(
				checkTestCasePmLink({ ...checkInput, mcpConfigId }),
			).rejects.toMatchObject({
				nonRetryable: true,
				type: "PmConfigNotFoundError",
				message: expect.stringContaining(
					"PM configuration is no longer available",
				),
			});
		},
	);
});

describe("unattempted active-server pushes", () => {
	const link = {
		externalId: "42",
		externalUrl: "https://pm.example.com/cards/42",
		externalMcpServerId: "server-1",
	};

	it("sends the update while a different attempt owns the row's PENDING status", async () => {
		h.cases.set(
			"tc1",
			unlinkedRow({
				...link,
				lastPmSyncAttemptId: "attempt-B",
				lastPmSyncStatus: "PENDING",
			}),
		);
		h.workflowActs.checkTestCasePmLink.mockImplementation(
			checkTestCasePmLink,
		);
		h.workflowActs.getTestCasesToSync.mockResolvedValue([
			{
				...row(),
				identifier: "TC-1",
				steps: [],
				state: "READY",
				priority: "MEDIUM",
				tags: [],
			},
		]);
		h.workflowActs.discoverPMToolCapabilities.mockResolvedValue({
			hasPMCapabilities: true,
			detectedType: "fizzy",
			taskUpdate: {
				toolName: "update_card",
				idParam: "card_id",
				titleParam: "title",
				descriptionParam: "description",
				allParams: [],
			},
		});
		h.workflowActs.detectAndStampPmPushConflict.mockResolvedValue({
			hasConflict: false,
		});
		h.workflowActs.executeMcpTool.mockResolvedValue({
			success: true,
			output: {},
		});
		h.workflowActs.updateTestCaseExternalRefs.mockImplementation(() =>
			writePmSyncStatusUnattempted({
				itemId: "tc1",
				itemType: "testCase",
				data: { lastPmSyncStatus: "SUCCESS" },
			}),
		);
		const result = await testCaseSyncWorkflow({
			projectId: "project-1",
			organizationId: "org-1",
			userId: "u-1",
			mcpConfigId: "config-1",
			mcpServerId: "server-1",
			containerId: "board-1",
			direction: "push",
			unsyncedOnly: false,
		});
		expect(h.workflowActs.executeMcpTool).toHaveBeenCalledWith(
			expect.objectContaining({
				toolName: "update_card",
				args: expect.objectContaining({ card_id: "42" }),
			}),
		);
		expect(result).toMatchObject({
			success: true,
			syncedCount: 1,
			failedCount: 0,
		});
		expect(row()).toMatchObject({
			...link,
			lastPmSyncStatus: "PENDING",
			lastPmSyncAttemptId: "attempt-B",
		});
	});

	it("returns already-linked while a different attempt owns the row's PENDING status", async () => {
		h.cases.set(
			"tc1",
			unlinkedRow({
				...link,
				lastPmSyncAttemptId: "attempt-B",
				lastPmSyncStatus: "PENDING",
			}),
		);
		const result = await createTestCaseInPmWithClaim(common);
		expect(result).toMatchObject({
			success: true,
			outcome: "already-linked",
			externalId: "42",
		});
		expect(row()).toMatchObject({
			...link,
			lastPmSyncStatus: "PENDING",
			lastPmSyncAttemptId: "attempt-B",
		});
	});

	it("uses the guard's own server stamp instead of turning a separate link-read failure into FAILED", async () => {
		h.cases.set(
			"tc1",
			unlinkedRow({
				...link,
				lastPmSyncAttemptId: "attempt-A",
				lastPmSyncStatus: "PENDING",
			}),
		);
		vi.mocked(db.testCase.findFirst).mockImplementation(((args: {
			select?: Record<string, unknown>;
		}) => {
			// Only the removed readPersistedLink shape fails; the scoped guard
			// read includes attempt ownership and must supply the server stamp.
			if (args.select?.externalId && !args.select.lastPmSyncAttemptId) {
				throw new Error("separate link read unavailable");
			}
			return (defaultFindFirst as (...args: unknown[]) => unknown)(args);
		}) as never);
		const result = await createTestCaseInPmWithClaim({
			...common,
			pmSyncAttemptId: "attempt-A",
		});
		expect(result).toMatchObject({
			success: true,
			outcome: "already-linked",
			externalId: "42",
		});
		expect(row()).toMatchObject({
			...link,
			lastPmSyncStatus: "SUCCESS",
			lastPmSyncError: null,
		});
	});
});

describe("legacy link server-stamp backfill", () => {
	it("accepts a NULL snapshot stamp backfilled to the active server without failing a successful case", async () => {
		const link = {
			externalId: "42",
			externalUrl: "https://pm.example.com/cards/42",
			externalMcpServerId: "server-1",
		};
		h.cases.set(
			"tc1",
			unlinkedRow({
				...link,
				lastPmSyncAttemptId: "attempt-A",
				lastPmSyncStatus: "SUCCESS",
			}),
		);
		const result = await checkTestCasePmLink({
			...checkInput,
			...link,
			externalMcpServerId: null,
			pmSyncAttemptId: "attempt-A",
		});
		expect(result).toEqual({ success: true });
		expect(row()).toMatchObject({
			...link,
			lastPmSyncStatus: "SUCCESS",
			lastPmSyncError: null,
		});
	});

	it.each([undefined, "attempt-A"])(
		"accepts the same link backfilled during a refusal's fenced write (%s)",
		async (pmSyncAttemptId) => {
			const link = { ...judgedLink, externalMcpServerId: null };
			h.cases.set(
				"tc1",
				unlinkedRow({
					...link,
					lastPmSyncAttemptId: pmSyncAttemptId ?? null,
					lastPmSyncStatus: "SUCCESS",
				}),
			);
			vi.mocked(db.mCPConfig.findFirst).mockImplementationOnce((() => {
				Object.assign(row(), {
					externalMcpServerId: "server-1",
					lastPmSyncStatus: "SUCCESS",
				});
				return {
					baseUrl: "https://pm.example.com",
					mcpServer: { key: "azure-devops" },
				} as never;
			}) as never);
			const result = await checkTestCasePmLink({
				...checkInput,
				...link,
				pmSyncAttemptId,
			});
			expect(result).toEqual({ success: true });
			expect(row()).toMatchObject({
				...link,
				externalMcpServerId: "server-1",
				lastPmSyncStatus: "SUCCESS",
				lastPmSyncError: null,
			});
		},
	);
});
