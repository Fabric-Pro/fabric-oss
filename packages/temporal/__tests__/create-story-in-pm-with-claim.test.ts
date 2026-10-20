/**
 * The bulk story sync's create under the PM create claim
 * (`createStoryInPmWithClaim`, used by `storySyncWorkflow` push).
 *
 * The activity runs for real, with the real claim, orphan and failure
 * recording, over a simulated `user_story` store with Prisma's `where`
 * semantics. `db.$transaction` stages the writes made through its client and
 * applies them to the store together when the callback resolves, or drops
 * them all when it throws. `updateStory` honours `settlesPmCreateClaim` the
 * way the real one does (its own tests are in @repo/database) and writes
 * through the transaction client it is given; `executeMcpTool` is the PM
 * tool.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	fixtureTarget,
	mutablePmSettings,
	pmTargetFixtures,
} from "../../utils/test-fixtures/pm-target";
import { checkTestCasePmLink } from "../src/activities/pm-integration/create-test-case-in-pm-with-claim";

type Row = Record<string, unknown> & { id: string };

/** One write to the store: through a transaction client, or committed alone. */
type StoreWrite = { via: "tx" | "db"; data: Record<string, unknown> };

const h = vi.hoisted(() => ({
	stories: new Map<string, Record<string, unknown> & { id: string }>(),
	recordPmSyncLog: vi.fn(),
	/** Every write, in order. */
	writes: [] as { via: "tx" | "db"; data: Record<string, unknown> }[],
	/** Runs once, right after the next link write is committed. */
	afterLinkCommit: null as null | (() => Promise<void>),
	/** The next link commit lands, but its caller gets an error. */
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

/**
 * The store as one client sees it. `staged` is a transaction's uncommitted
 * writes, by row id: its reads see them over the committed rows, and its
 * writes go there instead of the store.
 */
interface StoreView {
	via: "tx" | "db";
	rows(): Row[];
	write(id: string, data: Record<string, unknown>): void;
}

function committedView(): StoreView {
	return {
		via: "db",
		rows: () => [...h.stories.values()],
		write: (id, data) => {
			h.writes.push({ via: "db", data });
			Object.assign(h.stories.get(id) ?? {}, data);
		},
	};
}

function transactionView(staged: Map<string, Record<string, unknown>>) {
	return {
		via: "tx" as const,
		rows: () =>
			[...h.stories.values()].map((row) => ({
				...row,
				...staged.get(row.id),
			})),
		write: (id: string, data: Record<string, unknown>) => {
			h.writes.push({ via: "tx", data });
			staged.set(id, { ...staged.get(id), ...data });
		},
	};
}

/** Commit a transaction's staged writes to the store, all together. */
function commit(staged: Map<string, Record<string, unknown>>) {
	for (const [id, data] of staged) {
		const row = h.stories.get(id);
		if (row) {
			Object.assign(row, data);
		}
	}
}

/** After a link write commits: the scheduled interleaving, then the ack. */
async function linkCommitted() {
	const after = h.afterLinkCommit;
	h.afterLinkCommit = null;
	await after?.();
	if (h.loseNextCommitAck) {
		h.loseNextCommitAck = false;
		throw new Error("connection reset after commit");
	}
}

function userStoryTable(view: StoreView) {
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

const TX_VIEW = Symbol("txView");

vi.mock("@repo/logs", () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@repo/database", () => {
	class PmCreateClaimNotHeldError extends Error {
		constructor(storyId: string) {
			super(`The PM create claim is no longer held on ${storyId}.`);
			this.name = "PmCreateClaimNotHeldError";
		}
	}
	return {
		// The claim stamp is read from the database clock (`takeClaim`).
		readDatabaseClock: vi.fn(async () => new Date()),
		db: {
			userStory: userStoryTable(committedView()),
			testCase: userStoryTable(committedView()),
			mCPServer: { findUnique: vi.fn(async () => null) },
			mCPConfig: { findFirst: vi.fn() },
			$transaction: vi.fn(
				async (fn: (tx: object) => Promise<unknown>) => {
					const staged = new Map<string, Record<string, unknown>>();
					const view = transactionView(staged);
					const result = await fn({
						userStory: userStoryTable(view),
						[TX_VIEW]: view,
					});
					commit(staged);
					await linkCommitted();
					return result;
				},
			),
		},
		PmSyncStatus: {
			PENDING: "PENDING",
			SUCCESS: "SUCCESS",
			CONFLICT: "CONFLICT",
			FAILED: "FAILED",
		},
		PmCreateClaimNotHeldError,
		// The real `updateStory`'s claim scoping: with `settlesPmCreateClaim`
		// the write lands only while the row holds that claim, and clears it.
		// Given a transaction client, it writes through it; without one it
		// commits on its own.
		updateStory: vi.fn(
			async (
				id: string,
				projectId: string,
				data: Record<string, unknown>,
				context?: { settlesPmCreateClaim?: string },
				tx?: { [TX_VIEW]?: StoreView },
			) => {
				const view = tx?.[TX_VIEW] ?? committedView();
				const row = view.rows().find((r) => r.id === id);
				if (!row || row.projectId !== projectId) {
					throw new Error("Story not found");
				}
				const claim = context?.settlesPmCreateClaim;
				if (claim !== undefined && row.pmCreateClaimId !== claim) {
					throw new PmCreateClaimNotHeldError(id);
				}
				const written = {
					...data,
					...(claim !== undefined
						? { pmCreateClaimId: null, pmCreateClaimedAt: null }
						: {}),
				};
				view.write(id, written);
				if (!tx) {
					await linkCommitted();
				}
				return { ...row, ...written };
			},
		),
	};
});

vi.mock("../src/activities/orchestrator/execution/execute-mcp-tool", () => ({
	executeMcpTool: vi.fn(),
}));

vi.mock("../src/activities/pm-integration/record-pm-sync-log", () => ({
	recordPmSyncLog: h.recordPmSyncLog,
}));

const { createStoryInPmWithClaim, checkStoryPmLink } = await import(
	"../src/activities/pm-integration/create-story-in-pm-with-claim"
);
const { db, updateStory } = await import("@repo/database");
const { logger } = await import("@repo/logs");
const { executeMcpTool } = await import(
	"../src/activities/orchestrator/execution/execute-mcp-tool"
);
const { writePmSyncStatusForAttempt } = await import(
	"../src/activities/pm-integration/pm-sync-attempt-fence"
);

function unlinkedRow(overrides: Record<string, unknown> = {}): Row {
	return {
		id: "s1",
		projectId: "project-1",
		project: { organizationId: "org-1", userId: "u-1" },
		title: "Example",
		externalId: null,
		externalUrl: null,
		externalMcpServerId: null,
		lastPmSyncStatus: null,
		lastPmSyncError: null,
		lastPmSyncAttemptId: null,
		pmCreateClaimId: null,
		pmCreateClaimedAt: null,
		...overrides,
	};
}

const common = {
	storyId: "s1",
	projectId: "project-1",
	organizationId: "org-1",
	userId: "u-1",
	mcpConfigId: "config-1",
	pmTarget: { additionalContext: { account_slug: "example-org" } },
	pmTool: "fizzy",
	toolLabel: "fizzy",
};

const createInput = {
	...common,
	action: "create" as const,
	toolName: "create_card",
	createArgs: { board_id: "board-1", title: "Example" },
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
	const r = h.stories.get("s1");
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

/** The SUCCESS status writes made, and the client each went through. */
function successWrites(): StoreWrite[] {
	return h.writes.filter((w) => w.data.lastPmSyncStatus === "SUCCESS");
}

beforeEach(() => {
	h.stories.clear();
	vi.mocked(logger.info).mockClear();
	h.recordPmSyncLog.mockReset();
	h.writes.length = 0;
	h.afterLinkCommit = null;
	h.loseNextCommitAck = false;
	h.failNextTxUpdateMany = null;
	vi.mocked(executeMcpTool).mockReset();
	vi.mocked(updateStory).mockClear();
	vi.mocked(db.$transaction).mockClear();
	vi.mocked(db.mCPConfig.findFirst).mockReset();
	vi.mocked(db.mCPConfig.findFirst).mockResolvedValue({
		baseUrl: "https://pm.example.com",
		mcpServer: { key: "fizzy", defaultUrl: null },
	} as never);
	vi.mocked(db.mCPServer.findUnique).mockReset();
	vi.mocked(db.mCPServer.findUnique).mockResolvedValue(null);
});

describe("createStoryInPmWithClaim: create", () => {
	it("takes the claim, sends the create once, and links the row in the write that clears the claim", async () => {
		h.stories.set("s1", unlinkedRow());
		vi.mocked(executeMcpTool).mockImplementation((async () => {
			// The claim is held while the create is in flight.
			expect(row().pmCreateClaimId).toEqual(expect.any(String));
			return created;
		}) as never);

		const result = await createStoryInPmWithClaim(createInput);

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
			args: createInput.createArgs,
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
			pmCreateClaimId: null,
		});
		expect(h.recordPmSyncLog).not.toHaveBeenCalled();
	});

	it("stamps the MCP server the create went to on the new link", async () => {
		h.stories.set("s1", unlinkedRow());
		vi.mocked(executeMcpTool).mockResolvedValue(created as never);

		await createStoryInPmWithClaim({
			...createInput,
			mcpServerId: "server-1",
		});

		expect(row()).toMatchObject({
			externalId: "1075",
			externalMcpServerId: "server-1",
			pmCreateClaimId: null,
		});
	});

	it("reads an Azure DevOps id and _links.web.href, as the workflow did", async () => {
		h.stories.set("s1", unlinkedRow());
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

		const result = await createStoryInPmWithClaim(createInput);

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

	it("linked since the workflow read it: no create, no write, success with that link", async () => {
		h.stories.set(
			"s1",
			unlinkedRow({
				externalId: "88",
				externalUrl: "https://pm.example.com/cards/88",
				lastPmSyncStatus: "SUCCESS",
			}),
		);

		const result = await createStoryInPmWithClaim(createInput);

		expect(executeMcpTool).not.toHaveBeenCalled();
		expect(result).toEqual({
			success: true,
			externalId: "88",
			externalUrl: "https://pm.example.com/cards/88",
			outcome: "already-linked",
		});
		expect(row()).toMatchObject({
			externalId: "88",
			lastPmSyncStatus: "SUCCESS",
			pmCreateClaimId: null,
		});
		expect(h.recordPmSyncLog).not.toHaveBeenCalled();
	});

	it("a held claim: no create, create_unconfirmed recorded, the claim untouched", async () => {
		h.stories.set("s1", unlinkedRow({ pmCreateClaimId: "earlier-run" }));

		const result = await createStoryInPmWithClaim(createInput);

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
	])(
		"a story in %s: no claim, no create, no write",
		async (_label, overrides) => {
			h.stories.set("s1", unlinkedRow(overrides));

			const result = await createStoryInPmWithClaim(createInput);

			expect(executeMcpTool).not.toHaveBeenCalled();
			expect(result).toMatchObject({
				success: false,
				outcome: "not-in-project",
			});
			expect(row()).toMatchObject({
				pmCreateClaimId: null,
				lastPmSyncStatus: null,
			});
			expect(h.recordPmSyncLog).not.toHaveBeenCalled();
		},
	);

	it.each([
		["a response with no id", mcpText({ ok: true })],
		["a response that cannot be read", null],
	])(
		"created, but %s: claim kept, create_orphan recorded, counted as a failure",
		async (_label, output) => {
			h.stories.set("s1", unlinkedRow());
			vi.mocked(executeMcpTool).mockResolvedValue({
				success: true,
				durationMs: 5,
				output,
			} as never);

			const result = await createStoryInPmWithClaim(createInput);

			expect(result).toMatchObject({
				success: false,
				outcome: "create-orphan",
				error: expect.stringContaining("could not read its id"),
			});
			expect(row()).toMatchObject({
				externalId: null,
				pmCreateClaimId: expect.any(String),
				lastPmSyncStatus: "FAILED",
			});
			expect(h.recordPmSyncLog).toHaveBeenCalledWith(
				failureLoggedWith("create_orphan"),
			);
		},
	);

	it("a definite rejection: the claim is released and today's error text is returned", async () => {
		h.stories.set("s1", unlinkedRow());
		vi.mocked(executeMcpTool).mockResolvedValue({
			success: false,
			durationMs: 5,
			failureKind: "rejected",
			output: { error: 'Tool "create_card" not found' },
		} as never);

		const result = await createStoryInPmWithClaim(createInput);

		expect(result).toEqual({
			success: false,
			outcome: "create-rejected",
			error:
				'Failed to create work item: Tool "create_card" not found. ' +
				"Try changing Work Item Type in Project Settings " +
				"(Scrum = Product Backlog Item, Agile = User Story, Basic = Issue).",
		});
		expect(row()).toMatchObject({
			pmCreateClaimId: null,
			lastPmSyncStatus: null,
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
			h.stories.set("s1", unlinkedRow());
			vi.mocked(executeMcpTool).mockResolvedValue({
				success: false,
				durationMs: 5,
				...(failureKind ? { failureKind } : {}),
				output,
			} as never);

			const result = await createStoryInPmWithClaim(createInput);

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

	it("a thrown create: claim kept, create_unconfirmed recorded", async () => {
		h.stories.set("s1", unlinkedRow());
		vi.mocked(executeMcpTool).mockRejectedValue(
			new Error("socket hang up"),
		);

		const result = await createStoryInPmWithClaim(createInput);

		expect(result).toMatchObject({
			success: false,
			outcome: "create-unconfirmed",
		});
		expect(row()).toMatchObject({
			pmCreateClaimId: expect.any(String),
			lastPmSyncStatus: "FAILED",
		});
	});

	it("the GitLab instance check refuses before sending: the claim is released", async () => {
		h.stories.set("s1", unlinkedRow());
		const refusal = Object.assign(new Error("bound to another instance"), {
			type: "GitLabPmOriginMismatch",
		});
		vi.mocked(executeMcpTool).mockRejectedValue(refusal);

		const result = await createStoryInPmWithClaim(createInput);

		expect(result).toEqual({
			success: false,
			outcome: "create-rejected",
			error: "bound to another instance",
		});
		expect(row()).toMatchObject({
			pmCreateClaimId: null,
			lastPmSyncStatus: null,
		});
	});

	it("the claim cleared by Unlink & re-create while the create was in flight: the link write is refused once, and the orphan goes to the log only", async () => {
		h.stories.set("s1", unlinkedRow());
		vi.mocked(executeMcpTool).mockImplementation((async () => {
			Object.assign(row(), {
				pmCreateClaimId: null,
				pmCreateClaimedAt: null,
			});
			return created;
		}) as never);

		const result = await createStoryInPmWithClaim(createInput);

		expect(updateStory).toHaveBeenCalledTimes(1);
		expect(result).toMatchObject({
			success: false,
			outcome: "create-orphan",
			externalId: "1075",
			error: expect.stringContaining("Item 1075 was created in fizzy"),
		});
		// The row no longer holds this create's claim: its status is not
		// this create's to stamp.
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
		h.stories.set("s1", unlinkedRow({ lastPmSyncStatus: "PENDING" }));
		vi.mocked(executeMcpTool).mockImplementation((async () => {
			// Unlink & re-create, then another push claims the row and
			// is creating its own item.
			Object.assign(row(), {
				pmCreateClaimId: "claim-of-another-create",
				lastPmSyncStatus: null,
			});
			return created;
		}) as never);

		const result = await createStoryInPmWithClaim(createInput);

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
		expect(h.recordPmSyncLog.mock.calls[0]?.[0]).toMatchObject({
			errorPayload: { errorClass: "create_orphan" },
			externalId: "1075",
		});
	});

	it("a link write that keeps failing while this claim is held: claim kept, create_orphan stamped on the row", async () => {
		h.stories.set("s1", unlinkedRow());
		vi.mocked(executeMcpTool).mockResolvedValue(created as never);
		for (let i = 0; i < 3; i++) {
			vi.mocked(updateStory).mockRejectedValueOnce(
				new Error("pool exhausted"),
			);
		}

		const result = await createStoryInPmWithClaim(createInput);

		expect(updateStory).toHaveBeenCalledTimes(3);
		expect(result).toMatchObject({
			success: false,
			outcome: "create-orphan",
			error: expect.stringContaining("pool exhausted"),
		});
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

	it("keeps Prisma link-write details out of the returned and stored story error", async () => {
		h.stories.set("s1", unlinkedRow());
		vi.mocked(executeMcpTool).mockResolvedValue(created as never);
		for (let i = 0; i < 3; i++) {
			vi.mocked(updateStory).mockRejectedValueOnce(
				Object.assign(
					new Error(
						"Invalid `prisma.userStory.update()` invocation in\n/app/packages/database/x.ts:12:3\nquery text",
					),
					{ name: "PrismaClientKnownRequestError", code: "P2002" },
				),
			);
		}

		const result = await createStoryInPmWithClaim(createInput);

		expect(updateStory).toHaveBeenCalledTimes(3);
		for (const message of [result.error, row().lastPmSyncError]) {
			expect(message).toContain(
				"another story in this project is already linked to that item",
			);
			expect(message).not.toContain("/app/packages/database/x.ts");
			expect(message).not.toContain("prisma.");
		}
	});

	describe("another push links the row after Unlink & re-create cleared this create's claim", () => {
		/** Item 88, linked by another push with SUCCESS. */
		function linkOtherItem() {
			Object.assign(row(), {
				pmCreateClaimId: null,
				pmCreateClaimedAt: null,
				externalId: "88",
				externalUrl: "https://pm.example.com/cards/88",
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
			h.stories.set("s1", unlinkedRow());
			vi.mocked(executeMcpTool).mockImplementation((async () => {
				linkOtherItem();
				return {
					success: true,
					durationMs: 5,
					output: mcpText({ ok: true }),
				};
			}) as never);

			const result = await createStoryInPmWithClaim(createInput);

			expect(result).toMatchObject({
				success: false,
				outcome: "create-orphan",
				error: expect.stringContaining("could not read its id"),
			});
			expectOtherLinkKept();
			// The log does not name item 88, which is not this create's.
			expect(h.recordPmSyncLog).toHaveBeenCalledTimes(1);
			expect(h.recordPmSyncLog.mock.calls[0]?.[0]).toMatchObject({
				status: "FAILURE",
				errorPayload: { errorClass: "create_orphan" },
				externalId: null,
				externalUrl: null,
			});
		});

		it("the re-read after the refused link write fails: the orphan goes to the log only", async () => {
			h.stories.set("s1", unlinkedRow());
			vi.mocked(executeMcpTool).mockImplementation((async () => {
				linkOtherItem();
				// The tenant check has run; the next read is the re-read.
				vi.mocked(db.userStory.findFirst).mockRejectedValueOnce(
					new Error("read timeout"),
				);
				return created;
			}) as never);

			const result = await createStoryInPmWithClaim(createInput);

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
				externalUrl: "https://pm.example.com/cards/1075",
			});
		});

		it("the other push links after the re-read saw the row unlinked: the orphan goes to the log only", async () => {
			h.stories.set("s1", unlinkedRow());
			vi.mocked(executeMcpTool).mockImplementation((async () => {
				// Unlink & re-create only; the row is unlinked at the re-read.
				Object.assign(row(), {
					pmCreateClaimId: null,
					pmCreateClaimedAt: null,
				});
				const read = vi
					.mocked(db.userStory.findFirst)
					.getMockImplementation();
				vi.mocked(db.userStory.findFirst).mockImplementationOnce(
					(async (...args: unknown[]) => {
						const seen = await (
							read as (...a: unknown[]) => Promise<unknown>
						)(...args);
						linkOtherItem();
						return seen;
					}) as never,
				);
				return created;
			}) as never);

			const result = await createStoryInPmWithClaim(createInput);

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
				externalUrl: "https://pm.example.com/cards/1075",
			});
		});
	});

	it("a retry after an attempt whose create got no answer sends nothing", async () => {
		h.stories.set("s1", unlinkedRow());
		vi.mocked(executeMcpTool).mockResolvedValue({
			success: false,
			durationMs: 5,
			failureKind: "indeterminate",
			output: { error: "timed out" },
		} as never);

		await createStoryInPmWithClaim(createInput);
		const retry = await createStoryInPmWithClaim(createInput);

		expect(executeMcpTool).toHaveBeenCalledTimes(1);
		expect(retry).toMatchObject({ success: false, outcome: "claim-held" });
	});

	it("a loser's create_unconfirmed, recorded while this attempt held the claim, is replaced by SUCCESS once linked", async () => {
		h.stories.set("s1", unlinkedRow());
		let loser: Awaited<ReturnType<typeof createStoryInPmWithClaim>> | null =
			null;
		vi.mocked(executeMcpTool).mockImplementation((async () => {
			// A concurrent push (or a retry of this activity) misses the
			// claim and stamps FAILED while this create is in flight.
			loser = await createStoryInPmWithClaim(createInput);
			expect(row()).toMatchObject({
				lastPmSyncStatus: "FAILED",
				lastPmSyncError: expect.stringContaining("may already exist"),
			});
			return created;
		}) as never);

		const result = await createStoryInPmWithClaim(createInput);

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

	it.each(["FAILED", "CONFLICT"] as const)(
		"a single-row attempt that stamps PENDING and then %s after the link commits keeps its state",
		async (terminal) => {
			h.stories.set("s1", unlinkedRow());
			vi.mocked(executeMcpTool).mockResolvedValue(created as never);
			// Attempt B starts and finishes right after this create's link
			// commits. With the SUCCESS in that commit, B's state is newer.
			h.afterLinkCommit = async () => {
				Object.assign(row(), {
					lastPmSyncStatus: "PENDING",
					lastPmSyncAttemptId: "attempt-B",
				});
				await writePmSyncStatusForAttempt({
					itemType: "story",
					itemId: "s1",
					attemptId: "attempt-B",
					data: {
						lastPmSyncStatus: terminal,
						lastPmSyncError: `attempt B ${terminal}`,
					},
				});
			};

			const result = await createStoryInPmWithClaim(createInput);

			expect(result).toMatchObject({ success: true, outcome: "created" });
			expect(row()).toMatchObject({
				externalId: "1075",
				pmCreateClaimId: null,
				lastPmSyncStatus: terminal,
				lastPmSyncError: `attempt B ${terminal}`,
				lastPmSyncAttemptId: "attempt-B",
			});
			// The one SUCCESS went through the link's transaction.
			expect(successWrites()).toEqual([
				expect.objectContaining({ via: "tx" }),
			]);
			expect(db.$transaction).toHaveBeenCalledTimes(1);
		},
	);

	it("a row PENDING for another attempt keeps its status while the link lands in the same commit", async () => {
		h.stories.set("s1", unlinkedRow());
		vi.mocked(executeMcpTool).mockImplementation((async () => {
			Object.assign(row(), {
				lastPmSyncStatus: "PENDING",
				lastPmSyncAttemptId: "attempt-C",
			});
			return created;
		}) as never);

		const result = await createStoryInPmWithClaim(createInput);

		expect(result).toMatchObject({ success: true, outcome: "created" });
		expect(row()).toMatchObject({
			externalId: "1075",
			pmCreateClaimId: null,
			lastSyncedAt: expect.any(Date),
			lastPmSyncStatus: "PENDING",
			lastPmSyncAttemptId: "attempt-C",
		});
		// The link and `lastSyncedAt` committed in one transaction; its
		// status write matched no row.
		expect(db.$transaction).toHaveBeenCalledTimes(1);
		expect(h.writes).toEqual([
			// The claim taken before the create.
			expect.objectContaining({ via: "db" }),
			expect.objectContaining({
				via: "tx",
				data: expect.objectContaining({ externalId: "1075" }),
			}),
			expect.objectContaining({
				via: "tx",
				data: { lastSyncedAt: expect.any(Date) },
			}),
		]);
	});

	it("a status write that fails rolls the link back with it, and the next try commits both", async () => {
		h.stories.set("s1", unlinkedRow({ lastPmSyncStatus: "FAILED" }));
		vi.mocked(executeMcpTool).mockResolvedValue(created as never);
		h.failNextTxUpdateMany = new Error("deadlock detected");

		const result = await createStoryInPmWithClaim(createInput);

		expect(result).toMatchObject({ success: true, outcome: "created" });
		expect(db.$transaction).toHaveBeenCalledTimes(2);
		expect(updateStory).toHaveBeenCalledTimes(2);
		expect(row()).toMatchObject({
			externalId: "1075",
			pmCreateClaimId: null,
			lastPmSyncStatus: "SUCCESS",
		});
	});

	it("a link write that committed but lost its answer is reported as created, with no second status write", async () => {
		h.stories.set("s1", unlinkedRow());
		vi.mocked(executeMcpTool).mockResolvedValue(created as never);
		h.loseNextCommitAck = true;
		// Between the lost answer and the re-read, a single-row attempt
		// stamps PENDING and finishes CONFLICT.
		h.afterLinkCommit = async () => {
			Object.assign(row(), {
				lastPmSyncStatus: "PENDING",
				lastPmSyncAttemptId: "attempt-B",
			});
			await writePmSyncStatusForAttempt({
				itemType: "story",
				itemId: "s1",
				attemptId: "attempt-B",
				data: { lastPmSyncStatus: "CONFLICT" },
			});
		};

		const result = await createStoryInPmWithClaim({
			...createInput,
			mcpServerId: "server-1",
		});

		// The retry found the claim gone; the row carries this link (id,
		// URL and server stamp).
		expect(updateStory).toHaveBeenCalledTimes(2);
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
		],
		[
			"the same id and server, when the create returned no URL",
			mcpText({ id: "1075" }),
			null,
		],
	])(
		"a link with %s, written after Unlink & re-create cleared the claim, is not taken as this create's",
		async (_label, output, otherUrl) => {
			h.stories.set("s1", unlinkedRow());
			vi.mocked(executeMcpTool).mockImplementation((async () => {
				// Unlink & re-create clears this claim, and another create
				// links the row to an item on another instance.
				Object.assign(row(), {
					pmCreateClaimId: null,
					pmCreateClaimedAt: null,
					externalId: "1075",
					externalUrl: otherUrl,
					externalMcpServerId: "server-1",
					lastPmSyncStatus: "SUCCESS",
					lastPmSyncError: null,
				});
				return { success: true, durationMs: 5, output };
			}) as never);

			const result = await createStoryInPmWithClaim({
				...createInput,
				mcpServerId: "server-1",
			});

			expect(result).toMatchObject({
				success: false,
				outcome: "create-orphan",
				externalId: "1075",
				error: expect.stringContaining(
					"Fabric could not link this story to it",
				),
			});
			// The row's state belongs to the other link: untouched.
			expect(row()).toMatchObject({
				externalId: "1075",
				externalUrl: otherUrl,
				lastPmSyncStatus: "SUCCESS",
				lastPmSyncError: null,
			});
			expect(
				h.writes.filter((w) => "lastPmSyncStatus" in w.data),
			).toEqual([]);
			// The orphan is in the sync log, naming this create's item.
			expect(h.recordPmSyncLog).toHaveBeenCalledTimes(1);
			expect(h.recordPmSyncLog.mock.calls[0]?.[0]).toMatchObject({
				status: "FAILURE",
				errorPayload: { errorClass: "create_orphan" },
				externalId: "1075",
				externalUrl:
					otherUrl === null
						? null
						: "https://pm.example.com/cards/1075",
			});
		},
	);

	it.each([
		["alone", { id: 0 }],
		["ahead of a later candidate", { id: 0, card_id: "card-9" }],
	])('an id of 0 %s is read and linked as "0"', async (_label, body) => {
		h.stories.set("s1", unlinkedRow());
		vi.mocked(executeMcpTool).mockResolvedValue({
			success: true,
			durationMs: 5,
			output: mcpText(body),
		} as never);

		const result = await createStoryInPmWithClaim(createInput);

		expect(result).toMatchObject({
			success: true,
			externalId: "0",
			outcome: "created",
		});
		expect(row()).toMatchObject({ externalId: "0", pmCreateClaimId: null });
	});

	it("an id that is neither a string nor a finite number reads as no id: orphan, claim kept", async () => {
		h.stories.set("s1", unlinkedRow());
		vi.mocked(executeMcpTool).mockResolvedValue({
			success: true,
			durationMs: 5,
			output: mcpText({ id: { value: 1075 } }),
		} as never);

		const result = await createStoryInPmWithClaim(createInput);

		expect(updateStory).not.toHaveBeenCalled();
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
});

describe("createStoryInPmWithClaim: refuse-legacy-link", () => {
	const refuseInput = {
		...common,
		toolLabel: "azure-devops",
		pmTool: "azure-devops",
		action: "refuse-legacy-link" as const,
		externalId: "card-7",
		externalUrl: "https://app.fizzy.do/example-org/cards/7",
	};
	const legacyRow = () =>
		unlinkedRow({
			externalId: "card-7",
			externalUrl: "https://app.fizzy.do/example-org/cards/7",
			lastPmSyncStatus: "SUCCESS",
			lastPmSyncAttemptId: "attempt-A",
		});

	it("creates nothing, keeps the link, and stamps FAILED with the Unlink & re-create message", async () => {
		h.stories.set("s1", legacyRow());

		const result = await createStoryInPmWithClaim(refuseInput);

		expect(executeMcpTool).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			success: false,
			outcome: "legacy-other-tool",
			error: expect.stringContaining(
				"linked to a ticket in a different PM tool",
			),
		});
		expect(row()).toMatchObject({
			externalId: "card-7",
			pmCreateClaimId: null,
			lastPmSyncStatus: "FAILED",
			lastPmSyncError: expect.stringContaining("Unlink & re-create"),
		});
		expect(h.recordPmSyncLog).toHaveBeenCalledWith(
			failureLoggedWith("PM_TOOL_MISMATCH_LEGACY"),
		);
	});

	it("leaves a row that is PENDING for an attempt to that attempt", async () => {
		h.stories.set(
			"s1",
			unlinkedRow({
				externalId: "card-7",
				externalUrl: "https://app.fizzy.do/example-org/cards/7",
				lastPmSyncStatus: "PENDING",
				lastPmSyncAttemptId: "attempt-B",
			}),
		);

		const result = await createStoryInPmWithClaim(refuseInput);

		expect(result).toMatchObject({ outcome: "legacy-other-tool" });
		expect(row()).toMatchObject({ lastPmSyncStatus: "PENDING" });
		expect(h.recordPmSyncLog).not.toHaveBeenCalled();
	});

	it("a link changed since the workflow read it is reported, not stamped", async () => {
		h.stories.set("s1", legacyRow());
		Object.assign(row(), { externalId: "relinked-9" });

		const result = await createStoryInPmWithClaim(refuseInput);

		expect(executeMcpTool).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			success: false,
			outcome: "link-changed",
		});
		expect(row()).toMatchObject({ lastPmSyncStatus: "SUCCESS" });
	});

	it("a relink between this activity's read and its write keeps the new link's state", async () => {
		h.stories.set("s1", legacyRow());
		// The activity reads the legacy link; then a relink lands before
		// the FAILED write.
		vi.mocked(db.userStory.findFirst).mockImplementationOnce((async () => {
			const snapshot = { ...row() };
			Object.assign(row(), {
				externalId: "relinked-9",
				externalMcpServerId: "srv-ado",
				lastPmSyncStatus: "SUCCESS",
			});
			return snapshot;
		}) as never);

		const result = await createStoryInPmWithClaim(refuseInput);

		expect(result).toMatchObject({ outcome: "legacy-other-tool" });
		expect(row()).toMatchObject({
			externalId: "relinked-9",
			lastPmSyncStatus: "SUCCESS",
		});
		expect(h.recordPmSyncLog).not.toHaveBeenCalled();
	});

	it("a relink to another item with the same id but another URL is reported, not stamped", async () => {
		h.stories.set(
			"s1",
			unlinkedRow({
				externalId: "card-7",
				externalUrl:
					"https://dev.azure.com/example-org/p/_workitems/edit/7",
				lastPmSyncStatus: "SUCCESS",
			}),
		);

		const result = await createStoryInPmWithClaim(refuseInput);

		expect(result).toMatchObject({ outcome: "link-changed" });
		expect(row()).toMatchObject({ lastPmSyncStatus: "SUCCESS" });
		expect(h.recordPmSyncLog).not.toHaveBeenCalled();
	});

	it("a same-id relink to another URL between this activity's read and its write is not stamped", async () => {
		h.stories.set("s1", legacyRow());
		vi.mocked(db.userStory.findFirst).mockImplementationOnce((async () => {
			const snapshot = { ...row() };
			// Same id, no server stamp, same attempt id: only the URL moved.
			Object.assign(row(), {
				externalUrl:
					"https://dev.azure.com/example-org/p/_workitems/edit/7",
			});
			return snapshot;
		}) as never);

		const result = await createStoryInPmWithClaim(refuseInput);

		expect(result).toMatchObject({ outcome: "legacy-other-tool" });
		expect(row()).toMatchObject({ lastPmSyncStatus: "SUCCESS" });
		expect(h.recordPmSyncLog).not.toHaveBeenCalled();
	});
});

const judgedLink = {
	externalId: "42",
	externalUrl: "https://pm.example.com/cards/42",
	externalMcpServerId: "server-old",
};
const checkInput = { ...common, mcpServerId: "server-active", ...judgedLink };

describe("checkStoryPmLink", () => {
	it.each(["push", "pull"] as const)(
		"blocks the same server's different target for %s",
		async (verb) => {
			h.stories.set(
				"s1",
				unlinkedRow({
					...judgedLink,
					externalMcpServerId: checkInput.mcpServerId,
					externalPmTarget:
						'pmt1:["server-active","example-org","example-other-board"]',
				}),
			);
			const result = await checkStoryPmLink({
				...checkInput,
				externalMcpServerId: checkInput.mcpServerId,
				verb,
				pmTarget: {
					additionalContext: { account_slug: "example-org" },
					containerId: "example-board",
				},
			});
			expect(result).toMatchObject({ success: false, outcome: "block" });
			expect(executeMcpTool).not.toHaveBeenCalled();
		},
	);

	it.each(["push", "pull"] as const)(
		"accepts the recorded self-hosted REST GitLab instance for %s",
		async (verb) => {
			const link = {
				...judgedLink,
				externalMcpServerId: null,
				externalUrl:
					"https://gitlab.example.com/example/project/-/issues/42",
			};
			h.stories.set("s1", unlinkedRow(link));
			vi.mocked(db.mCPServer.findUnique).mockResolvedValue({
				key: "gitlab-official",
				defaultUrl: "https://gitlab.com",
			} as never);
			const result = await checkStoryPmLink({
				...checkInput,
				...link,
				mcpConfigId: null,
				pmTool: "gitlab",
				verb,
				pmTarget: {
					additionalContext: {
						gitlabOrigin: "https://gitlab.example.com",
					},
				},
			});
			expect(result).toMatchObject({ success: true, outcome: "link-ok" });
			expect(h.writes).toHaveLength(0);
			expect(h.recordPmSyncLog).not.toHaveBeenCalled();
		},
	);

	it("refuses a gitlab.com link when REST targets the recorded self-hosted instance", async () => {
		const link = {
			...judgedLink,
			externalMcpServerId: null,
			externalUrl: "https://gitlab.com/example/project/-/issues/42",
		};
		h.stories.set("s1", unlinkedRow(link));
		vi.mocked(db.mCPServer.findUnique).mockResolvedValue({
			key: "gitlab-official",
			defaultUrl: "https://gitlab.com",
		} as never);
		expect(
			await checkStoryPmLink({
				...checkInput,
				...link,
				mcpConfigId: null,
				pmTool: "gitlab",
				verb: "pull",
				pmTarget: {
					additionalContext: {
						gitlabOrigin: "https://gitlab.example.com",
					},
				},
			}),
		).toMatchObject({ success: false, outcome: "legacy-other-tool" });
	});

	it("records a refused pull as a pull with recovery wording", async () => {
		h.stories.set("s1", unlinkedRow(judgedLink));
		const result = await checkStoryPmLink({ ...checkInput, verb: "pull" });
		expect(result.error).toContain("did not pull");
		expect(result.error).toMatch(
			/linked to a ticket in a different PM tool/i,
		);
		expect(result.error).toContain("Unlink & re-create");
		expect(result.error).not.toContain("did not create");
		expect(h.recordPmSyncLog).toHaveBeenCalledWith(
			expect.objectContaining({ direction: "pull", status: "FAILURE" }),
		);
	});

	it.each(["missing", "changed", "superseded"] as const)(
		"uses pull wording when the story is %s",
		async (reason) => {
			if (reason !== "missing") {
				h.stories.set(
					"s1",
					unlinkedRow({
						...judgedLink,
						...(reason === "changed"
							? { externalId: "example-new-id" }
							: {
									lastPmSyncAttemptId: "example-attempt",
									lastPmSyncStatus: "PENDING",
								}),
					}),
				);
			}
			const result = await checkStoryPmLink({
				...checkInput,
				verb: "pull",
			});
			expect(result.success).toBe(false);
			expect(result.error).toContain("did not pull it");
			expect(result.error).not.toContain("push");
		},
	);

	it.each([
		["another server on the same tool", judgedLink, "block"],
		[
			"another known tool",
			{
				...judgedLink,
				externalMcpServerId: null,
				externalUrl: "https://linear.app/example-org/issue/42",
			},
			"legacy-other-tool",
		],
		[
			"another custom host",
			{
				...judgedLink,
				externalMcpServerId: null,
				externalUrl: "https://old.example.com/cards/42",
			},
			"legacy-other-tool",
		],
	] as const)(
		"refuses %s and records FAILED without changing the link",
		async (_name, link, outcome) => {
			h.stories.set("s1", unlinkedRow(link));
			const result = await checkStoryPmLink({ ...checkInput, ...link });
			expect(result).toMatchObject({
				success: false,
				outcome,
				error: expect.stringContaining("Unlink & re-create"),
			});
			expect(row()).toMatchObject({
				...link,
				lastPmSyncStatus: "FAILED",
				lastPmSyncError: result.error,
			});
			expect(h.recordPmSyncLog).toHaveBeenCalledWith(
				failureLoggedWith("PM_TOOL_MISMATCH_LEGACY"),
			);
			expect(executeMcpTool).not.toHaveBeenCalled();
		},
	);

	it("refuses a personal GitLab link on another instance", async () => {
		const link = {
			...judgedLink,
			externalMcpServerId: null,
			externalUrl: "https://gitlab.com/example-org/project/-/issues/42",
		};
		h.stories.set("s1", unlinkedRow(link));
		vi.mocked(db.mCPConfig.findFirst).mockResolvedValue({
			baseUrl: "https://gitlab.example.com",
			mcpServer: { key: "gitlab", defaultUrl: null },
		} as never);
		expect(
			await checkStoryPmLink({
				...checkInput,
				...link,
				pmTool: "gitlab",
			}),
		).toMatchObject({ success: false, outcome: "legacy-other-tool" });
		expect(row().lastPmSyncStatus).toBe("FAILED");
	});

	it.each(["server-active", null])(
		"accepts the active stamp when the snapshot stamp is %s",
		async (externalMcpServerId) => {
			h.stories.set(
				"s1",
				unlinkedRow({
					...judgedLink,
					externalMcpServerId: "server-active",
					lastPmSyncStatus: "SUCCESS",
				}),
			);
			const result = await checkStoryPmLink({
				...checkInput,
				externalMcpServerId,
			});
			expect(logger.info).not.toHaveBeenCalledWith(
				"pm.sync.create_skipped",
				expect.objectContaining({ reason: "linked" }),
			);
			expect(result).toMatchObject({ success: true, outcome: "link-ok" });
			expect(h.writes).toHaveLength(0);
			expect(h.recordPmSyncLog).not.toHaveBeenCalled();
		},
	);

	it.each(["externalId", "externalUrl", "externalMcpServerId"])(
		"returns link-changed without recording when %s changed before the read",
		async (field) => {
			h.stories.set(
				"s1",
				unlinkedRow({
					...judgedLink,
					[field]: "replacement",
					lastPmSyncStatus: "SUCCESS",
				}),
			);
			expect(await checkStoryPmLink(checkInput)).toMatchObject({
				success: false,
				outcome: "link-changed",
			});
			expect(h.writes).toHaveLength(0);
			expect(h.recordPmSyncLog).not.toHaveBeenCalled();
		},
	);

	it.each(["externalId", "externalUrl", "externalMcpServerId"])(
		"fences refusal against a concurrent %s replacement",
		async (field) => {
			h.stories.set(
				"s1",
				unlinkedRow({ ...judgedLink, lastPmSyncStatus: "SUCCESS" }),
			);
			vi.mocked(db.mCPConfig.findFirst).mockImplementationOnce(
				(async () => {
					Object.assign(row(), { [field]: "replacement" });
					return {
						baseUrl: "https://pm.example.com",
						mcpServer: { key: "fizzy" },
					};
				}) as never,
			);
			expect(await checkStoryPmLink(checkInput)).toMatchObject({
				success: false,
				outcome: "link-changed",
			});
			expect(row().lastPmSyncStatus).toBe("SUCCESS");
			expect(h.writes).toHaveLength(0);
			expect(h.recordPmSyncLog).not.toHaveBeenCalled();
		},
	);

	it("accepts a legacy link backfilled to the active server during the refusal write", async () => {
		const link = {
			...judgedLink,
			externalMcpServerId: null,
			externalUrl: "https://linear.app/example-org/issue/42",
		};
		h.stories.set("s1", unlinkedRow(link));
		vi.mocked(db.mCPConfig.findFirst).mockImplementationOnce((async () => {
			Object.assign(row(), {
				externalMcpServerId: "server-active",
				lastPmSyncStatus: "SUCCESS",
			});
			return {
				baseUrl: "https://pm.example.com",
				mcpServer: { key: "fizzy" },
			};
		}) as never);
		const result = await checkStoryPmLink({ ...checkInput, ...link });
		expect(logger.info).not.toHaveBeenCalledWith(
			"pm.sync.create_skipped",
			expect.objectContaining({ reason: "linked" }),
		);
		expect(result).toMatchObject({ success: true, outcome: "link-ok" });
		expect(row().lastPmSyncStatus).toBe("SUCCESS");
		expect(h.writes).toHaveLength(0);
		expect(h.recordPmSyncLog).not.toHaveBeenCalled();
	});

	it.each([{ projectId: "other-project" }, { organizationId: "other-org" }])(
		"checks the run's project and organization: %j",
		async (scope) => {
			h.stories.set("s1", unlinkedRow(judgedLink));
			expect(
				await checkStoryPmLink({ ...checkInput, ...scope }),
			).toMatchObject({ success: false, outcome: "not-in-project" });
			expect(h.writes).toHaveLength(0);
			expect(db.mCPConfig.findFirst).not.toHaveBeenCalled();
		},
	);

	it.each(["config-1", null])(
		"fails non-retryably for missing config/server (%s)",
		async (mcpConfigId) => {
			h.stories.set("s1", unlinkedRow(judgedLink));
			vi.mocked(db.mCPConfig.findFirst).mockResolvedValue(null);
			await expect(
				checkStoryPmLink({ ...checkInput, mcpConfigId }),
			).rejects.toMatchObject({
				nonRetryable: true,
				type: "PmConfigNotFoundError",
			});
			expect(h.writes).toHaveLength(0);
		},
	);

	it("loads the config scoped to the user, organization and active server", async () => {
		h.stories.set("s1", unlinkedRow(judgedLink));
		await checkStoryPmLink(checkInput);
		expect(db.mCPConfig.findFirst).toHaveBeenCalledWith({
			where: {
				id: "config-1",
				userId: "u-1",
				organizationId: "org-1",
				mcpServerId: "server-active",
			},
			select: {
				baseUrl: true,
				commandArgs: true,
				atlassianCloudSiteUrl: true,
				mcpServer: { select: { defaultUrl: true, key: true } },
			},
		});
	});

	it.each(["same", "other"])(
		"checks the %s GitLab instance without a config row",
		async (instance) => {
			const link = {
				...judgedLink,
				externalMcpServerId: null,
				externalUrl: `https://${instance === "same" ? "gitlab" : "old"}.example.com/example-org/project/-/issues/42`,
			};
			h.stories.set("s1", unlinkedRow(link));
			vi.mocked(db.mCPServer.findUnique).mockResolvedValue({
				key: "gitlab",
				defaultUrl: "https://gitlab.example.com",
			} as never);
			expect(
				await checkStoryPmLink({
					...checkInput,
					...link,
					mcpConfigId: null,
					pmTarget: {
						additionalContext: {
							gitlabOrigin: "https://gitlab.example.com",
						},
					},
					pmTool: "gitlab",
				}),
			).toMatchObject({ success: instance === "same" });
		},
	);

	it("yields the refusal status to a PENDING attempt", async () => {
		h.stories.set(
			"s1",
			unlinkedRow({
				...judgedLink,
				lastPmSyncAttemptId: "attempt-other",
				lastPmSyncStatus: "PENDING",
			}),
		);
		expect(await checkStoryPmLink(checkInput)).toMatchObject({
			success: false,
			outcome: "attempt-superseded",
			error: "Another PM sync attempt now owns this story, so Fabric did not push it.",
		});
		expect(row().lastPmSyncStatus).toBe("PENDING");
		expect(h.writes).toHaveLength(0);
		expect(h.recordPmSyncLog).not.toHaveBeenCalled();
	});
});

describe("story refusal attempt ownership", () => {
	it("reports a changed attempt id after the refusal write misses its fence", async () => {
		h.stories.set(
			"s1",
			unlinkedRow({ ...judgedLink, lastPmSyncStatus: "SUCCESS" }),
		);
		vi.mocked(db.mCPConfig.findFirst).mockImplementationOnce((async () => {
			Object.assign(row(), { lastPmSyncAttemptId: "attempt-other" });
			return {
				baseUrl: "https://pm.example.com",
				mcpServer: { key: "fizzy" },
			};
		}) as never);
		expect(await checkStoryPmLink(checkInput)).toMatchObject({
			success: false,
			outcome: "attempt-superseded",
			error: "Another PM sync attempt now owns this story, so Fabric did not push it.",
		});
		expect(row()).toMatchObject({
			lastPmSyncStatus: "SUCCESS",
			lastPmSyncAttemptId: "attempt-other",
		});
		expect(h.writes).toHaveLength(0);
		expect(h.recordPmSyncLog).not.toHaveBeenCalled();
	});
});

describe("story refusal write boundaries", () => {
	it("retries an unchanged refusal whose status write failed", async () => {
		h.stories.set("s1", unlinkedRow(judgedLink));
		vi.mocked(db.userStory.updateMany).mockRejectedValueOnce(
			new Error("write unavailable"),
		);
		await expect(checkStoryPmLink(checkInput)).rejects.toThrow(
			"could not record this story's PM link refusal",
		);
		expect(h.recordPmSyncLog).not.toHaveBeenCalled();
	});

	it("does not fail an active-server link because another attempt is PENDING", async () => {
		h.stories.set(
			"s1",
			unlinkedRow({
				...judgedLink,
				externalMcpServerId: "server-active",
				lastPmSyncAttemptId: "attempt-other",
				lastPmSyncStatus: "PENDING",
			}),
		);
		expect(
			await checkStoryPmLink({
				...checkInput,
				externalMcpServerId: "server-active",
			}),
		).toMatchObject({ success: true });
		expect(row().lastPmSyncStatus).toBe("PENDING");
		expect(h.writes).toHaveLength(0);
	});
});

describe("writer/checker target consistency", () => {
	it.each(pmTargetFixtures)(
		"$name: create-with-claim survives settings edits at both guards",
		async (fixture) => {
			h.stories.set("s1", unlinkedRow());
			vi.mocked(db.mCPConfig.findFirst).mockResolvedValue(
				fixture.config as never,
			);
			vi.mocked(executeMcpTool).mockResolvedValue(created);
			const pmTarget = {
				containerId: fixture.containerId,
				additionalContext: fixture.additionalContext,
			};
			const result = await createStoryInPmWithClaim({
				...createInput,
				mcpServerId: "example-server",
				pmTool: fixture.pmTool,
				pmTarget,
			});
			expect(result.success).toBe(true);
			// Connection-only attachment configuration and content filters change between calls.
			vi.mocked(db.mCPConfig.findFirst).mockResolvedValue({
				...fixture.config,
				atlassianCloudSiteUrl: "https://example.atlassian.net",
			} as never);
			const check = {
				...common,
				mcpServerId: "example-server",
				pmTool: fixture.pmTool,
				externalId: String(row().externalId),
				externalUrl: row().externalUrl as string,
				externalMcpServerId: "example-server",
				pmTarget: {
					...pmTarget,
					additionalContext: {
						...fixture.additionalContext,
						...mutablePmSettings,
					},
				},
			};
			await expect(checkStoryPmLink(check)).resolves.toMatchObject({
				success: true,
			});
			await expect(
				checkTestCasePmLink({ ...check, testCaseId: "s1" }),
			).resolves.toMatchObject({ success: true });
			expect(row().externalPmTarget).toBe(
				fixtureTarget(fixture, "example-server"),
			);
		},
	);
});
