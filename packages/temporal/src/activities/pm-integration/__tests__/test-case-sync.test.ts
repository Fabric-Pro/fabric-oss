/**
 * Unit tests for `createOrUpdateTestCaseFromPMItem`.
 *
 * Covers the two pull/import branches and the audit contract:
 *  - new PM item  → `createTestCase` (DRAFT) + external refs + a pull PmSyncLog;
 *  - known PM item → `updateTestCase` + external refs + a pull PmSyncLog;
 *  - the PmSyncLog is always written with `entityType: "TEST_CASE"`.
 *
 * The DB + log layers are mocked; the real (pure) serializer parses steps out of
 * the body so the create path exercises the round-trip.
 *
 * Run with:
 *   pnpm --filter @repo/temporal exec vitest run src/activities/pm-integration/__tests__/test-case-sync.test.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	createTestCase: vi.fn(),
	getTestCase: vi.fn(),
	createContext: vi.fn(),
	updateContext: vi.fn(),
	getContextById: vi.fn(),
	setTestCaseContextId: vi.fn(),
	start: vi.fn(),
	updateTestCase: vi.fn(),
	updateTestCasePmRefs: vi.fn(),
	recordPmSyncLog: vi.fn(),
	fetchPmTicket: vi.fn(),
	warn: vi.fn(),
}));

// Partial-mock `@repo/database` (spread the real module) so the query functions
// this activity calls are stubbed while the rest of the package's surface stays
// intact — a full replacement breaks unrelated load-time consumers (e.g.
// `@repo/payments` → `setAiUsageRecorder`). `db.testCase` lookups are spied per
// test.
vi.mock("@repo/database", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@repo/database")>();
	return {
		...actual,
		createTestCase: mocks.createTestCase,
		getTestCase: mocks.getTestCase,
		createContext: mocks.createContext,
		updateContext: mocks.updateContext,
		getContextById: mocks.getContextById,
		setTestCaseContextId: mocks.setTestCaseContextId,
		updateTestCase: mocks.updateTestCase,
		updateTestCasePmRefs: mocks.updateTestCasePmRefs,
	};
});

vi.mock("@repo/logs", () => ({
	logger: { warn: mocks.warn, info: vi.fn(), error: vi.fn() },
}));

vi.mock("../record-pm-sync-log", () => ({
	recordPmSyncLog: mocks.recordPmSyncLog,
}));
vi.mock("../record-pm-sync-state", () => ({
	recordPmSyncFailure: vi.fn(),
	recordPmSyncSuccessState: vi.fn(),
}));
vi.mock("../orchestrator/execution/execute-mcp-tool", () => ({
	executeMcpTool: vi.fn(),
}));
vi.mock("../story-sync", () => ({
	discoverPMToolCapabilities: vi.fn(),
	fetchPMItemsByIds: vi.fn(),
}));
vi.mock("../fetch-pm-ticket", () => ({
	fetchPmTicket: mocks.fetchPmTicket,
}));

vi.mock("../../../client", () => ({
	getTemporalClient: vi.fn(async () => ({
		workflow: { start: mocks.start },
	})),
}));

import { db } from "@repo/database";
import { computePmHash } from "../pm-sync-hash";
import {
	createOrUpdateTestCaseFromPMItem,
	updateTestCaseExternalRefs,
} from "../test-case-sync";

const BODY = ["Preconditions kept.", "", "Steps:", "1. Do a — Expect b"].join(
	"\n",
);

let findFirstSpy: ReturnType<typeof vi.spyOn>;
let restoreSpy: ReturnType<typeof vi.spyOn>;
let configSpy: ReturnType<typeof vi.spyOn>;
let serverSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	mocks.getTestCase.mockReset().mockResolvedValue(null);
	mocks.createContext
		.mockReset()
		.mockResolvedValue({ id: "example-context" });
	mocks.getContextById.mockReset().mockResolvedValue(null);
	mocks.updateContext.mockReset();
	mocks.setTestCaseContextId.mockReset();
	mocks.start.mockReset().mockResolvedValue({});
	mocks.createTestCase
		.mockReset()
		.mockResolvedValue({ id: "tc-new", identifier: "TC-007" });
	mocks.updateTestCase
		.mockReset()
		.mockResolvedValue({ id: "tc-1", identifier: "TC-001" });
	mocks.updateTestCasePmRefs.mockReset();
	mocks.recordPmSyncLog.mockReset();
	findFirstSpy = vi.spyOn(db.testCase, "findFirst").mockResolvedValue(null);
	restoreSpy = vi
		.spyOn(db.testCase, "updateMany")
		.mockResolvedValue({ count: 1 });
	configSpy = vi.spyOn(db.mCPConfig, "findFirst").mockResolvedValue({
		baseUrl: null,
		mcpServer: { key: "github", defaultUrl: "https://api.github.com" },
	} as never);
	serverSpy = vi.spyOn(db.mCPServer, "findUnique").mockResolvedValue({
		key: "github",
		defaultUrl: "https://api.github.com",
	} as never);
	mocks.warn.mockReset();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("createOrUpdateTestCaseFromPMItem", () => {
	it("creates a DRAFT case (with parsed steps) when the PM item is new", async () => {
		const result = await createOrUpdateTestCaseFromPMItem({
			projectId: "proj-1",
			externalId: "AB#42",
			title: "Checkout works",
			description: BODY,
			externalUrl: "https://dev.azure.com/work/42",
			externalMcpServerId: "srv-1",
			userId: "user-1",
			organizationId: "org-1",
			toolKey: "azure-devops",
		});

		expect(result.created).toBe(true);
		expect(result.testCaseId).toBe("tc-new");

		// Created as DRAFT, in the org tenant (userId nulled), with parsed steps.
		const createArg = mocks.createTestCase.mock.calls[0][0];
		expect(createArg.state).toBe("DRAFT");
		expect(createArg.organizationId).toBe("org-1");
		expect(createArg.userId).toBeNull();
		expect(createArg.steps).toEqual([
			{ action: "Do a", expected: "Expect b" },
		]);

		// External refs + drift baseline are stamped IN the create (one atomic
		// insert) — NOT a separate updateTestCasePmRefs, which could orphan an
		// externalId-null draft if the process died between the two writes.
		expect(createArg).toEqual(
			expect.objectContaining({
				externalId: "AB#42",
				externalUrl: "https://dev.azure.com/work/42",
				externalMcpServerId: "srv-1",
				lastSyncedPmHash: expect.any(String),
				lastSyncedAt: expect.any(Date),
			}),
		);
		expect(mocks.updateTestCasePmRefs).not.toHaveBeenCalled();
		// A pull log is written.
		expect(mocks.recordPmSyncLog).toHaveBeenCalledWith(
			expect.objectContaining({
				direction: "pull",
				entityType: "TEST_CASE",
				entityId: "tc-new",
			}),
		);
	});

	it("updates the existing case when the PM item is already linked", async () => {
		const candidate = {
			id: "tc-1",
			identifier: "TC-001",
			externalMcpServerId: "srv-1",
			externalUrl: null,
		};
		findFirstSpy.mockResolvedValue(candidate as never);

		const result = await createOrUpdateTestCaseFromPMItem({
			projectId: "proj-1",
			externalId: "AB#42",
			title: "Checkout works (edited)",
			externalMcpServerId: "srv-1",
			description: BODY,
			userId: "user-1",
			toolKey: "azure-devops",
		});

		expect(result.created).toBe(false);
		expect(result.testCaseId).toBe("tc-1");
		expect(mocks.createTestCase).not.toHaveBeenCalled();
		expect(mocks.updateTestCase).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "tc-1",
				projectId: "proj-1",
				data: expect.objectContaining({
					title: "Checkout works (edited)",
				}),
			}),
		);
		expect(mocks.recordPmSyncLog).toHaveBeenCalledWith(
			expect.objectContaining({
				direction: "pull",
				entityType: "TEST_CASE",
				entityId: "tc-1",
			}),
		);
	});

	const pullInput = {
		projectId: "proj-1",
		externalId: "42",
		title: "Pulled case",
		description: BODY,
		externalUrl: "https://github.com/example/repo/issues/42",
		externalMcpServerId: "srv-active",
		userId: "user-1",
		organizationId: "org-1",
		toolKey: "github",
		mcpConfigId: "cfg-1",
	};
	const legacy = {
		id: "tc-old",
		identifier: "TC-001",
		externalMcpServerId: null,
		externalUrl: "https://dev.azure.com/example/project/_workitems/edit/42",
	};
	function candidate(row: {
		id: string;
		identifier: string;
		externalMcpServerId: string | null;
		externalUrl: string | null;
		deletedAt?: Date | null;
	}) {
		findFirstSpy.mockResolvedValue({ deletedAt: null, ...row } as never);
	}
	const mismatchMessage =
		"Test case TC-001 is linked to an item in a different PM tool, so Fabric did not overwrite it with github item 42.";
	async function expectRefused(input: typeof pullInput = pullInput) {
		await expect(
			createOrUpdateTestCaseFromPMItem(input),
		).rejects.toMatchObject({
			type: "TestCasePullLinkMismatchError",
			nonRetryable: true,
			message: mismatchMessage,
		});
		expect(mocks.updateTestCase).not.toHaveBeenCalled();
		expect(mocks.updateTestCasePmRefs).not.toHaveBeenCalled();
		expect(mocks.createTestCase).not.toHaveBeenCalled();
		expect(mocks.recordPmSyncLog).not.toHaveBeenCalled();
		expect(restoreSpy).not.toHaveBeenCalled();
		expect(mocks.warn).toHaveBeenCalledWith(
			"pm.sync.test_case_pull.link_other_tool",
			{ id: "tc-old", reason: expect.any(String) },
		);
	}
	it.each([
		{ activeServer: undefined, stamp: "srv-other" },
		{ activeServer: null, stamp: "srv-other" },
		{ activeServer: undefined, stamp: null },
		{ activeServer: null, stamp: null },
	])(
		"refuses an existing case with missing active server ($activeServer, stamp $stamp)",
		async ({ activeServer, stamp }) => {
			candidate({
				...legacy,
				externalMcpServerId: stamp,
				deletedAt: new Date("2026-01-01"),
			});
			await expect(
				createOrUpdateTestCaseFromPMItem({
					...pullInput,
					externalMcpServerId: activeServer,
				}),
			).rejects.toMatchObject({
				type: "TestCasePullLinkMismatchError",
				nonRetryable: true,
				message:
					"Fabric could not confirm which PM tool this project syncs with, so it did not overwrite test case TC-001. Select the PM tool in Project Settings → Project Management, then pull again.",
			});
			expect(mocks.updateTestCase).not.toHaveBeenCalled();
			expect(restoreSpy).not.toHaveBeenCalled();
			expect(mocks.updateTestCasePmRefs).not.toHaveBeenCalled();
			expect(mocks.recordPmSyncLog).not.toHaveBeenCalled();
			expect(mocks.createTestCase).not.toHaveBeenCalled();
			expect(configSpy).not.toHaveBeenCalled();
			expect(serverSpy).not.toHaveBeenCalled();
			expect(mocks.warn).toHaveBeenCalledWith(
				"pm.sync.test_case_pull.link_other_tool",
				{ id: "tc-old", reason: expect.any(String) },
			);
		},
	);
	it.each([undefined, null])(
		"creates a new case without an active server (%s) when nothing matches",
		async (activeServer) => {
			const result = await createOrUpdateTestCaseFromPMItem({
				...pullInput,
				externalMcpServerId: activeServer,
			});
			expect(result).toMatchObject({
				testCaseId: "tc-new",
				created: true,
			});
			expect(mocks.createTestCase).toHaveBeenCalledWith(
				expect.objectContaining({
					externalId: "42",
					externalMcpServerId: undefined,
				}),
			);
			expect(mocks.recordPmSyncLog).toHaveBeenCalledWith(
				expect.objectContaining({ entityId: "tc-new" }),
			);
			expect(mocks.updateTestCase).not.toHaveBeenCalled();
			expect(restoreSpy).not.toHaveBeenCalled();
			expect(mocks.updateTestCasePmRefs).not.toHaveBeenCalled();
			expect(configSpy).not.toHaveBeenCalled();
			expect(serverSpy).not.toHaveBeenCalled();
		},
	);
	it("refuses a case stamped with another server without writes or create", async () => {
		candidate({ ...legacy, externalMcpServerId: "srv-other" });
		await expectRefused();
		expect(configSpy).not.toHaveBeenCalled();
		expect(serverSpy).not.toHaveBeenCalled();
	});
	it("refuses an unstamped other-tool URL without writes or create", async () => {
		candidate(legacy);
		await expectRefused();
	});
	it("updates and stamps an eligible legacy URL using tenant-scoped config", async () => {
		candidate({ ...legacy, externalUrl: pullInput.externalUrl });
		expect(
			(await createOrUpdateTestCaseFromPMItem(pullInput)).testCaseId,
		).toBe("tc-old");
		expect(configSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					id: "cfg-1",
					userId: "user-1",
					organizationId: "org-1",
					mcpServerId: "srv-active",
				},
			}),
		);
		expect(mocks.updateTestCasePmRefs).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "tc-old",
				externalMcpServerId: "srv-active",
			}),
		);
		expect(mocks.updateTestCase).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "tc-old",
				data: expect.objectContaining({
					title: "Pulled case",
					description: BODY,
					steps: [{ action: "Do a", expected: "Expect b" }],
				}),
			}),
		);
		expect(mocks.recordPmSyncLog).toHaveBeenCalledWith(
			expect.objectContaining({ entityId: "tc-old", direction: "pull" }),
		);
		expect(mocks.createTestCase).not.toHaveBeenCalled();
		expect(restoreSpy).not.toHaveBeenCalled();
	});
	it("updates a case stamped with the pulled server without config lookup", async () => {
		candidate({ ...legacy, externalMcpServerId: "srv-active" });
		expect(
			(await createOrUpdateTestCaseFromPMItem(pullInput)).testCaseId,
		).toBe("tc-old");
		expect(mocks.updateTestCase).toHaveBeenCalledWith(
			expect.objectContaining({ id: "tc-old" }),
		);
		expect(configSpy).not.toHaveBeenCalled();
		expect(serverSpy).not.toHaveBeenCalled();
		expect(findFirstSpy).toHaveBeenCalledWith({
			where: { projectId: "proj-1", externalId: "42" },
			select: {
				id: true,
				identifier: true,
				externalUrl: true,
				externalMcpServerId: true,
				externalPmTarget: true,
				deletedAt: true,
			},
		});
	});
	it("resolves the server for an in-flight pull without mcpConfigId", async () => {
		candidate({ ...legacy, externalUrl: pullInput.externalUrl });
		const { mcpConfigId: _configId, ...oldInput } = pullInput;
		await createOrUpdateTestCaseFromPMItem(oldInput);
		expect(serverSpy).toHaveBeenCalledWith({
			where: { id: "srv-active" },
			select: { defaultUrl: true, key: true },
		});
		expect(configSpy).not.toHaveBeenCalled();
		expect(mocks.updateTestCasePmRefs).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "tc-old",
				externalMcpServerId: "srv-active",
			}),
		);
	});
	it("fails without writes when the tenant-scoped config is missing", async () => {
		candidate(legacy);
		configSpy.mockResolvedValue(null);
		await expect(
			createOrUpdateTestCaseFromPMItem(pullInput),
		).rejects.toMatchObject({
			type: "PmConfigNotFoundError",
			nonRetryable: true,
		});
		expect(mocks.updateTestCase).not.toHaveBeenCalled();
		expect(mocks.updateTestCasePmRefs).not.toHaveBeenCalled();
		expect(mocks.createTestCase).not.toHaveBeenCalled();
		expect(mocks.recordPmSyncLog).not.toHaveBeenCalled();
	});
	// The bulk pull and the single-item import both pass this input shape; a
	// deleted case must be restored, never shadowed by a second insert that
	// test_case_projectId_externalId_key rejects (Fizzy #3124).
	it("restores an eligible deleted case before updating it", async () => {
		candidate({
			...legacy,
			externalMcpServerId: "srv-active",
			deletedAt: new Date("2026-01-01"),
		});
		const result = await createOrUpdateTestCaseFromPMItem(pullInput);
		expect(result).toMatchObject({ testCaseId: "tc-old", created: false });
		expect(restoreSpy).toHaveBeenCalledWith({
			where: { id: "tc-old", projectId: "proj-1" },
			data: { deletedAt: null },
		});
		expect(restoreSpy.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.updateTestCase.mock.invocationCallOrder[0],
		);
		expect(mocks.updateTestCase).toHaveBeenCalledWith(
			expect.objectContaining({ id: "tc-old" }),
		);
		expect(mocks.updateTestCasePmRefs).toHaveBeenCalledWith(
			expect.objectContaining({ id: "tc-old" }),
		);
		expect(mocks.recordPmSyncLog).toHaveBeenCalledWith(
			expect.objectContaining({ entityId: "tc-old", direction: "pull" }),
		);
		expect(mocks.createTestCase).not.toHaveBeenCalled();
	});
	it("leaves an ineligible deleted case deleted", async () => {
		candidate({
			...legacy,
			externalMcpServerId: "srv-other",
			deletedAt: new Date("2026-01-01"),
		});
		await expectRefused();
	});
	it("does not restore a live case", async () => {
		candidate({ ...legacy, externalMcpServerId: "srv-active" });
		await createOrUpdateTestCaseFromPMItem(pullInput);
		expect(restoreSpy).not.toHaveBeenCalled();
		expect(mocks.updateTestCase).toHaveBeenCalledWith(
			expect.objectContaining({ id: "tc-old" }),
		);
	});

	it("creates a personal-context case when no organization is given", async () => {
		await createOrUpdateTestCaseFromPMItem({
			projectId: "proj-1",
			externalId: "AB#43",
			title: "Personal case",
			description: "no steps here",
			userId: "user-9",
			toolKey: "jira",
		});

		const createArg = mocks.createTestCase.mock.calls[0][0];
		expect(createArg.userId).toBe("user-9");
		expect(createArg.organizationId).toBeNull();
		// No parseable steps in the body → none created (never wiped).
		expect(createArg.steps).toEqual([]);
	});
});

describe("updateTestCaseExternalRefs", () => {
	it("does NOT stamp a lastSyncedPmHash baseline when no readback context is supplied", async () => {
		const updateManySpy = vi
			.spyOn(db.testCase, "updateMany")
			.mockResolvedValue({ count: 1 } as never);
		try {
			await updateTestCaseExternalRefs({
				testCaseId: "tc-1",
				projectId: "proj-1",
				externalId: "AB#42",
				externalUrl: "https://dev.azure.com/work/42",
				externalMcpServerId: "srv-1",
			});
			const data = updateManySpy.mock.calls[0][0].data as Record<
				string,
				unknown
			>;
			// No `baseline` → no readback → leave lastSyncedPmHash untouched.
			expect(data).not.toHaveProperty("lastSyncedPmHash");
			// The link and baseline land first, by id; the SUCCESS is a
			// second write, kept off a case that is PENDING for an attempt.
			expect(data).not.toHaveProperty("lastPmSyncStatus");
			expect(updateManySpy.mock.calls[1][0]).toMatchObject({
				where: { id: "tc-1", projectId: "proj-1" },
				data: { lastPmSyncStatus: "SUCCESS" },
			});
			expect(mocks.fetchPmTicket).not.toHaveBeenCalled();
		} finally {
			updateManySpy.mockRestore();
		}
	});

	it("stamps lastSyncedPmHash from the post-push READBACK when a baseline is supplied (enables push-side conflict detection)", async () => {
		const updateManySpy = vi
			.spyOn(db.testCase, "updateMany")
			.mockResolvedValue({ count: 1 } as never);
		// The readback returns the PM tool's STORED (canonical) content — the
		// baseline hashes THIS, not the pushed body (ADO re-renders markdown).
		mocks.fetchPmTicket.mockResolvedValue({
			title: "Canonical ADO Title",
			description: "<ol><li>rendered</li></ol>",
			lastChangedBy: null,
			lastChangedAt: null,
		});
		try {
			await updateTestCaseExternalRefs({
				testCaseId: "tc-1",
				projectId: "proj-1",
				externalId: "249",
				externalMcpServerId: "srv-1",
				baseline: {
					mcpConfigId: "cfg-1",
					capabilities: { taskGet: { toolName: "get" } } as any,
					userId: "u-1",
					containerId: "board-1",
				},
			});
			const data = updateManySpy.mock.calls[0][0].data as Record<
				string,
				unknown
			>;
			expect(mocks.fetchPmTicket).toHaveBeenCalledWith(
				expect.objectContaining({
					externalId: "249",
					mcpConfigId: "cfg-1",
					containerId: "board-1",
				}),
			);
			expect(data.lastSyncedPmHash).toBe(
				computePmHash(
					"Canonical ADO Title",
					"<ol><li>rendered</li></ol>",
				),
			);
			// The link and baseline land first, by id; the SUCCESS is a
			// second write, kept off a case that is PENDING for an attempt.
			expect(data).not.toHaveProperty("lastPmSyncStatus");
			expect(updateManySpy.mock.calls[1][0]).toMatchObject({
				where: { id: "tc-1", projectId: "proj-1" },
				data: { lastPmSyncStatus: "SUCCESS" },
			});
		} finally {
			updateManySpy.mockRestore();
		}
	});

	it("leaves the baseline UNTOUCHED when the readback fails (never stamps a wrong hash)", async () => {
		const updateManySpy = vi
			.spyOn(db.testCase, "updateMany")
			.mockResolvedValue({ count: 1 } as never);
		mocks.fetchPmTicket.mockRejectedValue(new Error("PM read failed"));
		try {
			await updateTestCaseExternalRefs({
				testCaseId: "tc-1",
				projectId: "proj-1",
				externalId: "249",
				baseline: {
					mcpConfigId: "cfg-1",
					capabilities: { taskGet: { toolName: "get" } } as any,
					userId: "u-1",
					containerId: "board-1",
				},
			});
			const data = updateManySpy.mock.calls[0][0].data as Record<
				string,
				unknown
			>;
			expect(data).not.toHaveProperty("lastSyncedPmHash");
			// The link and baseline land first, by id; the SUCCESS is a
			// second write, kept off a case that is PENDING for an attempt.
			expect(data).not.toHaveProperty("lastPmSyncStatus");
			expect(updateManySpy.mock.calls[1][0]).toMatchObject({
				where: { id: "tc-1", projectId: "proj-1" },
				data: { lastPmSyncStatus: "SUCCESS" },
			});
		} finally {
			updateManySpy.mockRestore();
		}
	});
});

describe("pull RAG mirror", () => {
	const input = {
		projectId: "example-project",
		externalId: "42",
		title: "Pulled case",
		userId: "example-user",
		organizationId: "example-org",
		externalMcpServerId: "example-server",
	};
	const detail = {
		id: "tc-new",
		projectId: "example-project",
		contextId: null,
		identifier: "TC-007",
		title: "Pulled case",
		description: "Ready to test",
		state: "DRAFT",
		priority: "MEDIUM",
		tags: ["smoke"],
		steps: [{ action: "Open page", expected: "Page appears" }],
		workItemLinks: [
			{
				userStory: { identifier: "F-001", title: "Example feature" },
				acceptanceCriterionRefs: ["2"],
			},
		],
	};
	const content =
		"TC-007 Pulled case\nState: DRAFT\nPriority: MEDIUM\nPreconditions: Ready to test\n\nSteps:\n1. Open page → Page appears\n\nCovers:\n- F-001 Example feature (Covers AC 2)\n\nTags: smoke";
	it("creates context and starts embedding after creating a pulled case", async () => {
		mocks.getTestCase.mockResolvedValue(detail);
		await expect(
			createOrUpdateTestCaseFromPMItem({
				...input,
				memo: { correlationId: "example-request" },
			}),
		).resolves.toMatchObject({ created: true });
		expect(mocks.getTestCase).toHaveBeenCalledWith({
			id: "tc-new",
			projectId: "example-project",
		});
		expect(mocks.createContext).toHaveBeenCalledWith(
			expect.objectContaining({
				content,
				type: "TEST_CASE",
				organizationId: "example-org",
				userId: "example-user",
			}),
		);
		expect(mocks.setTestCaseContextId).toHaveBeenCalledWith({
			id: "tc-new",
			contextId: "example-context",
		});
		expect(mocks.start).toHaveBeenCalledTimes(1);
		expect(mocks.start).toHaveBeenCalledWith(
			"contextEmbeddingWorkflow",
			expect.objectContaining({
				taskQueue: "project-documents",
				memo: { correlationId: "example-request" },
				args: [
					expect.objectContaining({
						contextId: "example-context",
						content,
						organizationId: "example-org",
						userId: "example-user",
					}),
				],
			}),
		);
		expect(mocks.recordPmSyncLog.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.getTestCase.mock.invocationCallOrder[0],
		);
	});
	it("updates existing context content without creating another row", async () => {
		findFirstSpy.mockResolvedValue({
			id: "tc-new",
			identifier: "TC-007",
			externalMcpServerId: "example-server",
		} as never);
		mocks.getTestCase.mockResolvedValue({
			...detail,
			contextId: "example-context",
		});
		mocks.getContextById.mockResolvedValue({
			id: "example-context",
			projectId: "example-project",
		});
		await expect(
			createOrUpdateTestCaseFromPMItem(input),
		).resolves.toMatchObject({ created: false });
		expect(mocks.updateContext).toHaveBeenCalledWith(
			"example-context",
			expect.objectContaining({ content }),
		);
		expect(mocks.createContext).not.toHaveBeenCalled();
		expect(mocks.start).toHaveBeenCalledTimes(1);
	});
	it("recreates a vanished context and relinks a restored case", async () => {
		findFirstSpy.mockResolvedValue({
			id: "tc-new",
			identifier: "TC-007",
			externalMcpServerId: "example-server",
			deletedAt: new Date("2026-01-01"),
		} as never);
		mocks.getTestCase.mockResolvedValue({
			...detail,
			contextId: "example-deleted-context",
		});
		await expect(
			createOrUpdateTestCaseFromPMItem(input),
		).resolves.toMatchObject({ created: false });
		expect(restoreSpy).toHaveBeenCalledWith({
			where: { id: "tc-new", projectId: "example-project" },
			data: { deletedAt: null },
		});
		expect(mocks.getContextById).toHaveBeenCalledWith(
			"example-deleted-context",
		);
		expect(mocks.createContext).toHaveBeenCalledTimes(1);
		expect(mocks.setTestCaseContextId).toHaveBeenCalledWith({
			id: "tc-new",
			contextId: "example-context",
		});
		expect(mocks.start).toHaveBeenCalledTimes(1);
	});
	it("keeps the pull successful when context creation fails", async () => {
		mocks.getTestCase.mockResolvedValue(detail);
		mocks.createContext.mockRejectedValue(
			new Error("Example indexing failure"),
		);
		await expect(
			createOrUpdateTestCaseFromPMItem(input),
		).resolves.toMatchObject({ created: true, testCaseId: "tc-new" });
		expect(mocks.createContext).toHaveBeenCalledTimes(1);
		expect(mocks.start).not.toHaveBeenCalled();
	});
	it("keeps the pull successful when loading the mirror detail fails", async () => {
		mocks.getTestCase.mockRejectedValue(new Error("Example read failure"));
		await expect(
			createOrUpdateTestCaseFromPMItem(input),
		).resolves.toMatchObject({ created: true });
		expect(mocks.getTestCase).toHaveBeenCalledTimes(1);
	});
});

describe("pull target adoption", () => {
	const input = {
		projectId: "example-project",
		externalId: "123",
		title: "Example case",
		externalMcpServerId: "example-server",
		mcpConfigId: "example-config",
		containerId: "example-container",
		additionalContext: {},
		userId: "example-user",
		toolKey: "github",
	};
	const target = 'pmt1:["example-server","","example-container"]';
	it.each(["example-server", null])(
		"adopts the observed target after a legacy link guard passes (server %s)",
		async (externalMcpServerId) => {
			findFirstSpy.mockResolvedValue({
				id: "example-case",
				identifier: "TC-1",
				externalUrl: null,
				externalMcpServerId,
				externalPmTarget: null,
				deletedAt: null,
			} as never);
			await createOrUpdateTestCaseFromPMItem(input);
			expect(restoreSpy).toHaveBeenCalledWith({
				where: {
					id: "example-case",
					projectId: "example-project",
					externalId: "123",
					externalMcpServerId: "example-server",
					externalPmTarget: null,
				},
				data: { externalPmTarget: target },
			});
		},
	);
	it("refuses a row linked to a different target on the same server", async () => {
		findFirstSpy.mockResolvedValue({
			id: "example-case",
			identifier: "TC-1",
			externalUrl: null,
			externalMcpServerId: "example-server",
			externalPmTarget: 'pmt1:["example-server","","other-container"]',
			deletedAt: null,
		} as never);
		await expect(
			createOrUpdateTestCaseFromPMItem(input),
		).rejects.toMatchObject({ type: "TestCasePullLinkMismatchError" });
		expect(mocks.updateTestCase).not.toHaveBeenCalled();
		expect(mocks.updateTestCasePmRefs).not.toHaveBeenCalled();
	});
});

it.each([null, 'pmt1:["example-server","","example-container"]'])(
	"ordinary pushes preserve target metadata (%s)",
	async (externalPmTarget) => {
		const spy = vi
			.spyOn(db.testCase, "updateMany")
			.mockResolvedValue({ count: 1 } as never);
		try {
			await updateTestCaseExternalRefs({
				testCaseId: "example-case",
				projectId: "example-project",
				externalId: "42",
				externalMcpServerId: "example-server",
				externalPmTarget,
				target: {
					userId: "example-user",
					mcpConfigId: "example-config",
					containerId: "example-container",
				},
			});
			for (const [args] of spy.mock.calls) {
				expect(args.data).not.toHaveProperty("externalPmTarget");
			}
		} finally {
			spy.mockRestore();
		}
	},
);
