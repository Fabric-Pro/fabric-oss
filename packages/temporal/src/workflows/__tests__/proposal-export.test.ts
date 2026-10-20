/**
 * The Proposal export workflows (Fizzy #2946): how each proxies its one
 * activity, and what each body does with it. The export runs on its own
 * queue with a heartbeat, one retry, and no retry at all for the failure codes
 * no retry can fix; each daily cleanup sweep is attempted once, the
 * schedule being its retry, and a sweep stopped by its deletion cap is
 * followed by another, a bounded number of times.
 *
 * Mocked: `@temporalio/workflow`, so `proxyActivities` records its options
 * and returns plain stubs, and each workflow is called as an async function.
 * Each workflow module is imported fresh so its `proxyActivities` call is the
 * only one recorded. Both workflows are new, so no recorded history exists
 * to replay yet.
 */

import type { Duration } from "@temporalio/common";
import { msToNumber } from "@temporalio/common/lib/time";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { proxyActivities, stubs } = vi.hoisted(() => {
	const stubs = {
		exportProposalDocumentActivity: vi.fn(),
		cleanupExpiredProposalExportsActivity: vi.fn(),
	};
	return { proxyActivities: vi.fn((_options: unknown) => stubs), stubs };
});

vi.mock("@temporalio/workflow", () => ({
	proxyActivities,
	patched: vi.fn(() => true),
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { HEARTBEAT_TICK_MS } from "../../activities/lib/activity-liveness";
import {
	PROPOSAL_EXPORT_LIMITS,
	PROPOSAL_EXPORT_NON_RETRYABLE_CODES,
	type ProposalExportResult,
	type ProposalExportWorkflowInput,
} from "../../lib/proposal-export/types";

interface ProxyOptions {
	taskQueue?: string;
	startToCloseTimeout?: Duration;
	heartbeatTimeout?: Duration;
	retry?: {
		maximumAttempts?: number;
		nonRetryableErrorTypes?: string[];
	};
}

/** Import `load()` fresh and return it with the options it proxied with. */
async function importWorkflow<T>(
	load: () => Promise<T>,
): Promise<{ module: T; options: ProxyOptions }> {
	vi.resetModules();
	proxyActivities.mockClear();
	const module = await load();
	expect(proxyActivities).toHaveBeenCalledTimes(1);
	return {
		module,
		options: proxyActivities.mock.calls[0]?.[0] as ProxyOptions,
	};
}

const INPUT: ProposalExportWorkflowInput = {
	exportId: "proposal-export-0123456789abcdef0123456789abcdef",
	userId: "user-example-1",
	organizationId: "org-example-1",
	projectId: "project-example-1",
	documentId: "document-example-1",
	format: "pdf",
};

beforeEach(() => {
	stubs.exportProposalDocumentActivity.mockReset();
	stubs.cleanupExpiredProposalExportsActivity.mockReset();
});

describe("proposalExportWorkflow", () => {
	it("proxies the export activity on the export queue with a heartbeat and one retry", async () => {
		const { options } = await importWorkflow(
			() => import("../proposal-export"),
		);

		expect(options.taskQueue).toBe("proposal-export");
		expect(options.startToCloseTimeout).toBeDefined();
		expect(options.heartbeatTimeout).toBeDefined();
		expect(options.retry?.maximumAttempts).toBe(2);
	});

	it("leaves the activity room to finish its own time budget", async () => {
		const { options } = await importWorkflow(
			() => import("../proposal-export"),
		);

		expect(
			msToNumber(options.startToCloseTimeout as Duration),
		).toBeGreaterThan(PROPOSAL_EXPORT_LIMITS.totalTimeMs);
		// The activity heartbeats on a ticker; a timeout shorter than one tick
		// would kill a healthy export.
		expect(
			msToNumber(options.heartbeatTimeout as Duration),
		).toBeGreaterThan(HEARTBEAT_TICK_MS);
	});

	it("never retries the failures no retry can fix, and retries anything else", async () => {
		const { options } = await importWorkflow(
			() => import("../proposal-export"),
		);

		const nonRetryable = options.retry?.nonRetryableErrorTypes ?? [];
		expect(nonRetryable).toEqual(
			expect.arrayContaining([...PROPOSAL_EXPORT_NON_RETRYABLE_CODES]),
		);
		expect([...nonRetryable].sort()).toEqual(
			[...PROPOSAL_EXPORT_NON_RETRYABLE_CODES].sort(),
		);
		expect(nonRetryable).not.toContain("EXPORT_FAILED");
	});

	it("passes its input through and returns the activity's result unchanged", async () => {
		const { module } = await importWorkflow(
			() => import("../proposal-export"),
		);
		const result: ProposalExportResult = {
			key: `proposal-exports/project-example-1/${INPUT.exportId}.pdf`,
			fileName: "example-proposal.pdf",
			contentType: "application/pdf",
			byteSize: 2048,
			warnings: [{ code: "LOGO_UNAVAILABLE", count: 1 }],
		};
		stubs.exportProposalDocumentActivity.mockResolvedValue(result);

		const returned = await module.proposalExportWorkflow(INPUT);

		expect(returned).toBe(result);
		expect(stubs.exportProposalDocumentActivity).toHaveBeenCalledTimes(1);
		expect(stubs.exportProposalDocumentActivity).toHaveBeenCalledWith(
			INPUT,
		);
	});

	it("fails with the activity's failure", async () => {
		const { module } = await importWorkflow(
			() => import("../proposal-export"),
		);
		const failure = new Error("EXPORT_ACCESS_DENIED");
		stubs.exportProposalDocumentActivity.mockRejectedValue(failure);

		await expect(module.proposalExportWorkflow(INPUT)).rejects.toBe(
			failure,
		);
	});
});

describe("proposalExportCleanupWorkflow", () => {
	it("proxies the cleanup activity on the workflow's own queue, attempted once", async () => {
		const { options } = await importWorkflow(
			() => import("../proposal-export-cleanup"),
		);

		expect(options.taskQueue).toBeUndefined();
		expect(options.startToCloseTimeout).toBeDefined();
		expect(options.heartbeatTimeout).toBeDefined();
		expect(options.retry?.maximumAttempts).toBe(1);
	});

	const sweep = (hitDeletionCap: boolean) => ({
		scanned: 3,
		deleted: 2,
		errorCount: 0,
		pages: 1,
		hitDeletionCap,
		cutoffAt: "2026-10-14T11:00:00.000Z",
	});

	it("sweeps once when the sweep finishes under its deletion cap", async () => {
		const { module } = await importWorkflow(
			() => import("../proposal-export-cleanup"),
		);
		const result = sweep(false);
		stubs.cleanupExpiredProposalExportsActivity.mockResolvedValue(result);

		const returned = await module.proposalExportCleanupWorkflow();

		expect(returned).toEqual([result]);
		expect(
			stubs.cleanupExpiredProposalExportsActivity,
		).toHaveBeenCalledTimes(1);
		expect(
			stubs.cleanupExpiredProposalExportsActivity,
		).toHaveBeenCalledWith();
	});

	it("sweeps again while a sweep stops at its deletion cap", async () => {
		const { module } = await importWorkflow(
			() => import("../proposal-export-cleanup"),
		);
		stubs.cleanupExpiredProposalExportsActivity
			.mockResolvedValueOnce(sweep(true))
			.mockResolvedValueOnce(sweep(true))
			.mockResolvedValueOnce(sweep(false));

		const returned = await module.proposalExportCleanupWorkflow();

		expect(returned.map((result) => result.hitDeletionCap)).toEqual([
			true,
			true,
			false,
		]);
		expect(
			stubs.cleanupExpiredProposalExportsActivity,
		).toHaveBeenCalledTimes(3);
	});

	it("stops after a bounded number of sweeps in one run", async () => {
		const { module } = await importWorkflow(
			() => import("../proposal-export-cleanup"),
		);
		stubs.cleanupExpiredProposalExportsActivity.mockResolvedValue(
			sweep(true),
		);

		const returned = await module.proposalExportCleanupWorkflow();

		expect(returned).toHaveLength(20);
		expect(
			stubs.cleanupExpiredProposalExportsActivity,
		).toHaveBeenCalledTimes(20);
	});
});
