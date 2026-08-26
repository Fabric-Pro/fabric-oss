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
 *   pnpm --filter @repo/temporal test test-case-sync
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	createTestCase: vi.fn(),
	updateTestCase: vi.fn(),
	updateTestCasePmRefs: vi.fn(),
	recordPmSyncLog: vi.fn(),
	fetchPmTicket: vi.fn(),
}));

// Partial-mock `@repo/database` (spread the real module) so the query functions
// this activity calls are stubbed while the rest of the package's surface stays
// intact — a full replacement breaks unrelated load-time consumers (e.g.
// `@repo/payments` → `setAiUsageRecorder`). `db.testCase.findFirst` is spied per
// test.
vi.mock("@repo/database", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@repo/database")>();
	return {
		...actual,
		createTestCase: mocks.createTestCase,
		updateTestCase: mocks.updateTestCase,
		updateTestCasePmRefs: mocks.updateTestCasePmRefs,
	};
});

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

beforeEach(() => {
	mocks.createTestCase
		.mockReset()
		.mockResolvedValue({ id: "tc-new", identifier: "TC-007" });
	mocks.updateTestCase
		.mockReset()
		.mockResolvedValue({ id: "tc-1", identifier: "TC-001" });
	mocks.updateTestCasePmRefs.mockReset();
	mocks.recordPmSyncLog.mockReset();
	findFirstSpy = vi.spyOn(db.testCase, "findFirst");
});

afterEach(() => {
	findFirstSpy.mockRestore();
});

describe("createOrUpdateTestCaseFromPMItem", () => {
	it("creates a DRAFT case (with parsed steps) when the PM item is new", async () => {
		findFirstSpy.mockResolvedValue(null as never);

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
		findFirstSpy.mockResolvedValue({
			id: "tc-1",
			identifier: "TC-001",
		} as never);

		const result = await createOrUpdateTestCaseFromPMItem({
			projectId: "proj-1",
			externalId: "AB#42",
			title: "Checkout works (edited)",
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

	it("creates a personal-context case when no organization is given", async () => {
		findFirstSpy.mockResolvedValue(null as never);

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
			expect(data.lastPmSyncStatus).toBe("SUCCESS");
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
			expect(data.lastPmSyncStatus).toBe("SUCCESS");
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
			expect(data.lastPmSyncStatus).toBe("SUCCESS");
		} finally {
			updateManySpy.mockRestore();
		}
	});
});
