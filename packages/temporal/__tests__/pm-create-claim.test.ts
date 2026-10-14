/**
 * The PM create claim (Fizzy #3045) on the auto-push path
 * (`syncWorkItemToPM`, MCP tools).
 *
 * A create is sent only after the run took the row's create claim, a
 * conditional UPDATE that requires the claim and `externalId` to be null. The
 * claim is cleared by the link write (scoped to it), by a definite rejection,
 * or by Unlink & re-create; a timeout, a thrown call, a crash or an
 * unreadable response keeps it, and a held claim blocks every later create.
 *
 * The activity runs for real over a simulated `user_story` store with
 * Prisma's `where` semantics; `updateStory` honours `settlesPmCreateClaim`
 * the way the real one does (its own tests are in @repo/database).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown> & { id: string };

const h = vi.hoisted(() => ({
	stories: new Map<string, Record<string, unknown> & { id: string }>(),
	recordPmSyncLog: vi.fn(),
}));

/** Prisma `where` semantics for the shapes these writes use. */
function matches(row: Row, where: Record<string, unknown>): boolean {
	return Object.entries(where).every(([key, value]) => {
		const cell = row[key] ?? null;
		if (value && typeof value === "object" && "not" in value) {
			return cell !== null && cell !== (value as { not: unknown }).not;
		}
		return cell === value;
	});
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
		userStory: {
			findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
				const row = h.stories.get(where.id);
				return row
					? {
							...row,
							project: { organizationId: "org-1", userId: "u-1" },
						}
					: null;
			}),
			update: vi.fn(
				async ({
					where,
					data,
				}: {
					where: { id: string };
					data: Record<string, unknown>;
				}) => {
					const row = h.stories.get(where.id);
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
					for (const row of h.stories.values()) {
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
	// The real `updateStory`'s claim scoping: with `settlesPmCreateClaim`
	// the write lands only while the row holds that claim, and clears it.
	updateStory: vi.fn(
		async (
			id: string,
			_projectId: string,
			data: Record<string, unknown>,
			context?: { settlesPmCreateClaim?: string },
		) => {
			const row = h.stories.get(id);
			if (!row) {
				throw new Error("Story not found");
			}
			const claim = context?.settlesPmCreateClaim;
			if (claim !== undefined) {
				if (row.pmCreateClaimId !== claim) {
					throw new Error("PmCreateClaimNotHeldError");
				}
				Object.assign(row, data, {
					pmCreateClaimId: null,
					pmCreateClaimedAt: null,
				});
				return { ...row };
			}
			Object.assign(row, data);
			return { ...row };
		},
	),
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

vi.mock("../src/activities/pm-integration/story-sync", () => ({
	discoverPMToolCapabilities: vi.fn(),
	fetchPMItemsByIds: vi.fn(),
	HTML_DESCRIPTION_TOOLS: new Set<string>(),
	MARKDOWN_DESCRIPTION_TOOLS: new Set<string>(),
	markdownToSimpleHtml: (s: string) => s,
}));

const { syncWorkItemToPM } = await import(
	"../src/activities/pm-integration/hierarchy-sync"
);
const {
	acquirePmCreateClaim,
	isDefiniteGitLabCreateRejection,
	isDefiniteMcpCreateRejection,
	releasePmCreateClaim,
} = await import("../src/activities/pm-integration/pm-create-claim");
const { getStoryById, readDatabaseClock, updateStory } = await import(
	"@repo/database"
);
const { executeMcpTool } = await import(
	"../src/activities/orchestrator/execution/execute-mcp-tool"
);
const { discoverPMToolCapabilities } = await import(
	"../src/activities/pm-integration/story-sync"
);

function unlinkedRow(overrides: Record<string, unknown> = {}): Row {
	return {
		id: "s1",
		projectId: "project-1",
		title: "Example",
		description: "Body",
		acceptanceCriteria: null,
		identifier: "US-1",
		externalId: null,
		externalUrl: null,
		externalMcpServerId: null,
		lastSyncedPmHash: null,
		lastPmSyncStatus: "PENDING",
		lastPmSyncError: null,
		lastPmSyncAttemptId: "attempt-A",
		pmCreateClaimId: null,
		pmCreateClaimedAt: null,
		...overrides,
	};
}

const input = {
	itemType: "story" as const,
	itemId: "s1",
	projectId: "project-1",
	mcpConfigId: "config-1",
	containerId: "board-1",
	userId: "u-1",
	triggerSource: "manual-edit" as const,
	pmSyncAttemptId: "attempt-A",
};

const created = { success: true, output: { id: "1075" } };

beforeEach(() => {
	h.stories.clear();
	h.recordPmSyncLog.mockReset();
	vi.mocked(executeMcpTool).mockReset();
	vi.mocked(updateStory).mockClear();
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
});

function row(): Row {
	const r = h.stories.get("s1");
	if (!r) {
		throw new Error("row missing");
	}
	return r;
}

describe("syncWorkItemToPM create claim", () => {
	it("a held claim: the create tool is not called and the row is stamped create_unconfirmed, over a newer PENDING", async () => {
		// A newer attempt (C) stamped PENDING after this run (A) started.
		h.stories.set(
			"s1",
			unlinkedRow({
				pmCreateClaimId: "earlier-run",
				lastPmSyncAttemptId: "attempt-C",
			}),
		);
		vi.mocked(executeMcpTool).mockResolvedValue(created as never);

		const result = await syncWorkItemToPM(input);

		expect(executeMcpTool).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			status: "FAILED",
			errorClass: "create_unconfirmed",
		});
		expect(row()).toMatchObject({
			lastPmSyncStatus: "FAILED",
			lastPmSyncError: expect.stringContaining("may already exist"),
			// The override: C's attempt id stays, its PENDING does not.
			lastPmSyncAttemptId: "attempt-C",
			// Untouched: still the earlier run's.
			pmCreateClaimId: "earlier-run",
			externalId: null,
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

	it("two runs at once: only one sends a create, and the other's stamp does not land on the linked row", async () => {
		h.stories.set("s1", unlinkedRow());
		vi.mocked(executeMcpTool).mockResolvedValue(created as never);

		const results = await Promise.all([
			syncWorkItemToPM(input),
			syncWorkItemToPM(input),
		]);

		expect(executeMcpTool).toHaveBeenCalledTimes(1);
		// The second run misses the claim while the first holds it; by its
		// stamp the first has linked the row, so the claim-held fence keeps
		// `create_unconfirmed` off it and its result is the benign one.
		expect(results.map((r) => r.status)).toEqual(["SUCCESS", "SUCCESS"]);
		// Only the run that sent the create reports a push; the other says
		// it sent nothing.
		expect(
			results.filter((r) => r.status === "SUCCESS" && r.pushSkipped),
		).toHaveLength(1);
		expect(row()).toMatchObject({ externalId: "1075" });
		expect(row().lastPmSyncStatus).not.toBe("FAILED");
		expect(h.recordPmSyncLog).not.toHaveBeenCalledWith(
			expect.objectContaining({ status: "FAILURE" }),
		);
	});

	it("linked by another run since this one read the row: no create, no create_unconfirmed, and a newer PENDING is untouched", async () => {
		h.stories.set("s1", unlinkedRow());
		// A reads the row unlinked; then B creates and links "88" (clearing
		// its claim), and C stamps PENDING for an update.
		vi.mocked(getStoryById).mockImplementationOnce((async () => {
			const snapshot = { ...row() };
			Object.assign(row(), {
				externalId: "88",
				externalUrl: "https://pm.example.com/88",
				pmCreateClaimId: null,
				lastPmSyncStatus: "PENDING",
				lastPmSyncAttemptId: "attempt-C",
				lastPmSyncError: null,
			});
			return snapshot;
		}) as never);
		vi.mocked(executeMcpTool).mockResolvedValue(created as never);

		const result = await syncWorkItemToPM(input);

		expect(result).toMatchObject({
			status: "SUCCESS",
			externalId: "88",
			externalUrl: "https://pm.example.com/88",
			pushSkipped: "already-linked",
		});
		expect(executeMcpTool).not.toHaveBeenCalled();
		expect(row()).toMatchObject({
			externalId: "88",
			lastPmSyncStatus: "PENDING",
			lastPmSyncAttemptId: "attempt-C",
			lastPmSyncError: null,
			pmCreateClaimId: null,
		});
		expect(h.recordPmSyncLog).not.toHaveBeenCalled();
	});

	it("a successful link clears the claim in the link write", async () => {
		h.stories.set("s1", unlinkedRow());
		vi.mocked(executeMcpTool).mockResolvedValue(created as never);

		const result = await syncWorkItemToPM(input);

		expect(result.status).toBe("SUCCESS");
		// A real push: not reported as skipped.
		expect(result.status === "SUCCESS" && result.pushSkipped).toBeFalsy();
		expect(row()).toMatchObject({
			externalId: "1075",
			pmCreateClaimId: null,
		});
		// The link write is the one that settles the claim, not a later one.
		expect(updateStory).toHaveBeenCalledWith(
			"s1",
			"project-1",
			expect.objectContaining({ externalId: "1075" }),
			expect.objectContaining({
				settlesPmCreateClaim: expect.any(String),
			}),
		);
		// The create was sent at most once, and never resent on a closed
		// connection.
		expect(executeMcpTool).toHaveBeenCalledWith(
			expect.objectContaining({
				sendAtMostOnce: true,
				timeoutMs: 50_000,
			}),
		);
	});

	it("an indeterminate failure keeps the claim, and the retry does not create again", async () => {
		h.stories.set("s1", unlinkedRow());
		vi.mocked(executeMcpTool).mockResolvedValue({
			success: false,
			failureKind: "indeterminate",
			output: { error: "MCP tool timed out after 60000ms" },
		} as never);

		const first = await syncWorkItemToPM(input);
		// A Temporal retry of the same activity (or the next push).
		const retry = await syncWorkItemToPM(input);

		expect(executeMcpTool).toHaveBeenCalledTimes(1);
		expect(first).toMatchObject({
			status: "FAILED",
			errorClass: "create_unconfirmed",
		});
		expect(retry).toMatchObject({
			status: "FAILED",
			errorClass: "create_unconfirmed",
		});
		expect(row().pmCreateClaimId).toEqual(expect.any(String));
		expect(row().lastPmSyncError).toEqual(
			expect.stringContaining("may already exist"),
		);
	});

	it("a create call that throws keeps the claim and is returned, not thrown (no Temporal retry)", async () => {
		h.stories.set("s1", unlinkedRow());
		vi.mocked(executeMcpTool).mockRejectedValue(
			new Error("payload exceeds the activity result limit"),
		);

		const first = await syncWorkItemToPM(input);
		const retry = await syncWorkItemToPM(input);

		expect(first).toMatchObject({ errorClass: "create_unconfirmed" });
		expect(retry).toMatchObject({ errorClass: "create_unconfirmed" });
		expect(executeMcpTool).toHaveBeenCalledTimes(1);
	});

	// An error result from the server is not evidence that nothing was
	// created: the claim stays and a second push cannot take it. The first
	// four are the review's repro payloads (`executeMcpTool` marks every
	// error result `error_result`: execute-mcp-tool.failure-kind.test.ts).
	it.each([
		["an empty error result", { isError: true, content: [] }],
		[
			"a JSON 503 in the text",
			{
				isError: true,
				content: [
					{
						type: "text",
						text: '{"status":503,"error":"Upstream request failed"}',
					},
				],
			},
		],
		[
			"a structured 503",
			{ isError: true, error: "Upstream request failed", status: 503 },
		],
		[
			"a bare 500 in the text",
			{
				isError: true,
				content: [{ type: "text", text: "Error creating item: 500" }],
			},
		],
		[
			"a validation message",
			{
				isError: true,
				content: [
					{
						type: "text",
						text: "TF401347: Invalid tree name given for work item",
					},
				],
			},
		],
	])(
		"%s keeps the claim, and the next push does not create",
		async (_label, output) => {
			h.stories.set("s1", unlinkedRow());
			vi.mocked(executeMcpTool).mockResolvedValue({
				success: false,
				failureKind: "error_result",
				output,
			} as never);

			const first = await syncWorkItemToPM(input);

			expect(first).toMatchObject({ errorClass: "create_unconfirmed" });
			expect(row().pmCreateClaimId).toEqual(expect.any(String));
			expect(await acquirePmCreateClaim({ storyId: "s1" })).toEqual({
				miss: "claimed",
				heldBy: expect.any(String),
			});

			const next = await syncWorkItemToPM(input);

			expect(next).toMatchObject({ errorClass: "create_unconfirmed" });
			expect(executeMcpTool).toHaveBeenCalledTimes(1);
		},
	);

	it("a create refused before it was sent releases the claim, so a later push can create", async () => {
		h.stories.set("s1", unlinkedRow());
		vi.mocked(executeMcpTool)
			.mockResolvedValueOnce({
				success: false,
				failureKind: "rejected",
				output: {
					error: "Tool not found: create_card (on specified MCP config)",
				},
			} as never)
			.mockResolvedValueOnce(created as never);

		await expect(syncWorkItemToPM(input)).rejects.toMatchObject({
			type: "PmCreateError",
		});
		expect(row().pmCreateClaimId).toBeNull();

		const later = await syncWorkItemToPM(input);

		expect(later.status).toBe("SUCCESS");
		expect(executeMcpTool).toHaveBeenCalledTimes(2);
		expect(row()).toMatchObject({
			externalId: "1075",
			pmCreateClaimId: null,
		});
	});

	describe("the send deadline, started before the claim is asked for", () => {
		let clock = 1_000_000;
		beforeEach(() => {
			clock = 1_000_000;
			vi.spyOn(performance, "now").mockImplementation(() => clock);
		});
		afterEach(() => {
			vi.mocked(performance.now).mockRestore();
			vi.mocked(readDatabaseClock).mockImplementation(
				async () => new Date(),
			);
		});

		it("a claim whose answer came after the ceiling: executeMcpTool gets a deadline already passed, and its not-sent result releases the claim as a FAILED that offers a retry", async () => {
			h.stories.set("s1", unlinkedRow());
			// The claim UPDATE's answer comes back six minutes late.
			vi.mocked(readDatabaseClock).mockImplementation(async () => {
				clock += 6 * 60_000;
				return new Date();
			});
			let deadlineSeen: number | undefined;
			let clockAtCall = 0;
			vi.mocked(executeMcpTool)
				.mockImplementationOnce((async (args: {
					dispatchDeadline?: number;
				}) => {
					deadlineSeen = args.dispatchDeadline;
					clockAtCall = clock;
					return {
						success: false,
						failureKind: "deadline_passed",
						output: { error: "not sent" },
						durationMs: 0,
					};
				}) as never)
				.mockResolvedValueOnce(created as never);

			await expect(syncWorkItemToPM(input)).rejects.toMatchObject({
				type: "PmCreateNotSent",
				message: expect.stringContaining(
					"Fabric did not send the create to fizzy",
				),
			});
			// Started before the claim: 50s from the start, not from the
			// claim's late answer, so already passed when the send came.
			expect(deadlineSeen).toBe(1_000_000 + 50_000);
			expect(clockAtCall).toBeGreaterThanOrEqual(deadlineSeen ?? 0);
			expect(row()).toMatchObject({
				pmCreateClaimId: null,
				pmCreateClaimedAt: null,
				externalId: null,
			});
			// Not an unconfirmed create.
			expect(row().lastPmSyncError ?? "").not.toMatch(
				/may already exist/,
			);

			vi.mocked(readDatabaseClock).mockImplementation(
				async () => new Date(),
			);
			const later = await syncWorkItemToPM(input);
			expect(later.status).toBe("SUCCESS");
		});
	});

	it("an unreadable create response is an orphan that keeps the claim", async () => {
		h.stories.set("s1", unlinkedRow());
		vi.mocked(executeMcpTool).mockResolvedValue({
			success: true,
			output: {},
		} as never);

		const orphan = await syncWorkItemToPM(input);
		const next = await syncWorkItemToPM(input);

		expect(orphan).toMatchObject({
			status: "FAILED",
			errorClass: "create_orphan",
		});
		expect(row().pmCreateClaimId).toEqual(expect.any(String));
		expect(next).toMatchObject({ errorClass: "create_unconfirmed" });
		expect(executeMcpTool).toHaveBeenCalledTimes(1);
	});

	it.each([
		["null", null],
		["an object", {}],
		["an array", ["wrong"]],
	])(
		"a create answer whose id is %s is an orphan that keeps the claim, never a link to its text",
		async (_label, id) => {
			h.stories.set("s1", unlinkedRow());
			vi.mocked(executeMcpTool).mockResolvedValue({
				success: true,
				output: { id },
			} as never);

			const result = await syncWorkItemToPM(input);

			expect(result).toMatchObject({
				status: "FAILED",
				errorClass: "create_orphan",
			});
			expect(row()).toMatchObject({
				externalId: null,
				pmCreateClaimId: expect.any(String),
			});
		},
	);

	it("a failed link write is an orphan that keeps the claim", async () => {
		h.stories.set("s1", unlinkedRow());
		vi.mocked(executeMcpTool).mockResolvedValue(created as never);
		vi.mocked(updateStory)
			.mockRejectedValueOnce(new Error("database unavailable"))
			.mockRejectedValueOnce(new Error("database unavailable"))
			.mockRejectedValueOnce(new Error("database unavailable"));

		const orphan = await syncWorkItemToPM(input);
		const next = await syncWorkItemToPM(input);

		expect(orphan).toMatchObject({ errorClass: "create_orphan" });
		expect(orphan.status === "FAILED" && orphan.error).toEqual(
			expect.stringContaining("1075"),
		);
		expect(row()).toMatchObject({ externalId: null });
		expect(row().pmCreateClaimId).toEqual(expect.any(String));
		expect(next).toMatchObject({ errorClass: "create_unconfirmed" });
		expect(executeMcpTool).toHaveBeenCalledTimes(1);
	});

	it("once the held claim is gone, the next push creates", async () => {
		h.stories.set("s1", unlinkedRow({ pmCreateClaimId: "orphaned" }));
		vi.mocked(executeMcpTool).mockResolvedValue(created as never);
		// The push side only. Unlink & re-create's own clear, scoped to the
		// claim the request read, is tested through the real recovery in
		// @repo/api (`retry-pm-sync-item-recovery-race.test.ts`).
		row().pmCreateClaimId = null;

		const result = await syncWorkItemToPM(input);

		expect(result.status).toBe("SUCCESS");
		expect(executeMcpTool).toHaveBeenCalledTimes(1);
	});
});

describe("acquirePmCreateClaim / releasePmCreateClaim", () => {
	it("takes the claim only on an unlinked, unclaimed row, and says why it missed", async () => {
		h.stories.set("s1", unlinkedRow());
		h.stories.set(
			"linked",
			unlinkedRow({
				id: "linked",
				externalId: "9",
				externalUrl: "https://pm.example.com/9",
			}),
		);

		const claim = await acquirePmCreateClaim({ storyId: "s1" });

		expect(claim).toEqual({ claimId: expect.any(String) });
		expect(row().pmCreateClaimedAt).toBeInstanceOf(Date);
		expect(await acquirePmCreateClaim({ storyId: "s1" })).toEqual({
			miss: "claimed",
			heldBy: expect.any(String),
		});
		expect(await acquirePmCreateClaim({ storyId: "linked" })).toEqual({
			miss: "linked",
			externalId: "9",
			externalUrl: "https://pm.example.com/9",
		});
		expect(await acquirePmCreateClaim({ storyId: "gone" })).toEqual({
			miss: "missing",
		});
	});

	it("stamps the claim with the database clock, not this process's clock", async () => {
		h.stories.set("s1", unlinkedRow());
		const databaseNow = new Date("2026-03-04T05:06:07.000Z");
		vi.mocked(readDatabaseClock).mockResolvedValueOnce(databaseNow);
		// This process's clock is an hour behind the database's.
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date(databaseNow.getTime() - 60 * 60_000));
		try {
			await acquirePmCreateClaim({ storyId: "s1" });
		} finally {
			vi.useRealTimers();
		}

		expect(row().pmCreateClaimedAt).toEqual(databaseNow);
	});

	it("a linked row that also carries a claim reads as linked", async () => {
		h.stories.set(
			"s1",
			unlinkedRow({ externalId: "9", pmCreateClaimId: "stale" }),
		);

		expect(await acquirePmCreateClaim({ storyId: "s1" })).toMatchObject({
			miss: "linked",
		});
	});

	it("a claim released between the miss and the read is retried", async () => {
		h.stories.set("s1", unlinkedRow({ pmCreateClaimId: "other" }));
		const { db } = await import("@repo/database");
		// The holder releases right after this caller's first UPDATE misses.
		vi.mocked(db.userStory.findUnique).mockImplementationOnce((async () => {
			row().pmCreateClaimId = null;
			return { ...row() };
		}) as never);

		const claim = await acquirePmCreateClaim({ storyId: "s1" });

		expect(claim).toEqual({ claimId: expect.any(String) });
		expect(row().pmCreateClaimId).toBe(
			(claim as { claimId: string }).claimId,
		);
	});

	it("release clears only the caller's own claim", async () => {
		h.stories.set("s1", unlinkedRow({ pmCreateClaimId: "someone-else" }));

		expect(
			await releasePmCreateClaim({ storyId: "s1", claimId: "mine" }),
		).toBe(false);
		expect(row().pmCreateClaimId).toBe("someone-else");
		expect(
			await releasePmCreateClaim({
				storyId: "s1",
				claimId: "someone-else",
			}),
		).toBe(true);
		expect(row().pmCreateClaimId).toBeNull();
	});
});

describe("isDefiniteMcpCreateRejection", () => {
	const failed = (failureKind: unknown, error: string) =>
		({ success: false, failureKind, output: { error } }) as never;

	it("a call refused before it was sent releases", () => {
		expect(
			isDefiniteMcpCreateRejection(failed("rejected", "Tool not found")),
		).toBe(true);
	});

	it.each([
		["error_result", "Invalid board"],
		["indeterminate", "Invalid board"],
		[undefined, "Invalid board"],
	])("%s / %s keeps the claim", (kind, text) => {
		expect(isDefiniteMcpCreateRejection(failed(kind, text))).toBe(false);
	});

	it("a success is never a rejection", () => {
		expect(
			isDefiniteMcpCreateRejection({
				success: true,
				failureKind: "rejected",
			}),
		).toBe(false);
	});
});

describe("isDefiniteGitLabCreateRejection", () => {
	const READ_ONLY = "Read-only mode is on";
	const apiError = (status: number) =>
		Object.assign(new Error(`HTTP ${status}`), {
			name: "GitLabApiError",
			status,
		});

	it.each([400, 401, 403, 404, 409, 422, 429])(
		"a GitLab %i releases",
		(status) => {
			expect(
				isDefiniteGitLabCreateRejection(apiError(status), READ_ONLY),
			).toBe(true);
		},
	);

	it.each([408, 500, 502, 503, 504])(
		"a GitLab %i keeps the claim",
		(status) => {
			expect(
				isDefiniteGitLabCreateRejection(apiError(status), READ_ONLY),
			).toBe(false);
		},
	);

	it("refusals raised before sending release", () => {
		const reauth = Object.assign(new Error("NEEDS_REAUTH"), {
			name: "GitLabReauthRequiredError",
		});
		const mismatch = Object.assign(new Error("origin moved"), {
			type: "GitLabPmOriginMismatch",
		});
		expect(isDefiniteGitLabCreateRejection(reauth, READ_ONLY)).toBe(true);
		expect(isDefiniteGitLabCreateRejection(mismatch, READ_ONLY)).toBe(true);
		expect(
			isDefiniteGitLabCreateRejection(new Error(READ_ONLY), READ_ONLY),
		).toBe(true);
		expect(
			isDefiniteGitLabCreateRejection(
				new Error(
					"GitLab not connected. Please connect your GitLab account in Project Settings or Workflow Integrations.",
				),
				READ_ONLY,
			),
		).toBe(true);
	});

	it("a network error or a non-Error keeps the claim", () => {
		expect(
			isDefiniteGitLabCreateRejection(
				new TypeError("fetch failed"),
				READ_ONLY,
			),
		).toBe(false);
		expect(isDefiniteGitLabCreateRejection("boom", READ_ONLY)).toBe(false);
	});

	it("the send ceiling's abort keeps the claim (the request may have reached GitLab)", () => {
		expect(
			isDefiniteGitLabCreateRejection(
				new DOMException(
					"The operation was aborted due to timeout",
					"TimeoutError",
				),
				READ_ONLY,
			),
		).toBe(false);
		expect(
			isDefiniteGitLabCreateRejection(
				new DOMException("This operation was aborted", "AbortError"),
				READ_ONLY,
			),
		).toBe(false);
	});
});
