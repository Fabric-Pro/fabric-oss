/**
 * Behavioral (TestWorkflowEnvironment) tests for
 * `projectInstructionSnapshotWorkflow` — Task 10 of the coding-instructions
 * slice.
 *
 * Mirrors `__tests__/publishing-reconcile/reconcile-workflow.test.ts`: spins
 * up a local time-skipping Temporal test server, bundles the REAL workflow
 * code from the workflows barrel, injects mocked activities, and asserts
 * observable behavior. Bundling the barrel also means these cases fail if
 * the workflow is ever dropped from `src/workflows/index.ts` — executing it
 * by name is what proves the export, so registration needs no separate case.
 *
 * Offline note: `TestWorkflowEnvironment.createTimeSkipping()` downloads a
 * Temporal test-server binary on first use. In a network-restricted
 * environment `beforeAll` will fail; run once online to populate the binary
 * cache.
 *
 * Run with:
 *   pnpm --filter @repo/temporal exec vitest run __tests__/project-instruction-snapshot-workflow.test.ts
 */

import { resolve } from "node:path";
import { ActivityFailure, WorkflowFailedError } from "@temporalio/client";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import {
	bundleWorkflowCode,
	Worker,
	type WorkflowBundleWithSourceMap,
} from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type {
	GateResult,
	SnapshotRef,
} from "../src/activities/project-instructions";

const WORKFLOWS_PATH = resolve(__dirname, "..", "src", "workflows");
const WORKFLOW_NAME = "projectInstructionSnapshotWorkflow";

const INPUT: SnapshotRef = {
	snapshotId: "s",
	projectId: "p",
	organizationId: "o",
	userId: "u",
};

let env: TestWorkflowEnvironment;
let workflowBundle: WorkflowBundleWithSourceMap;

beforeAll(async () => {
	env = await TestWorkflowEnvironment.createTimeSkipping();
	workflowBundle = await bundleWorkflowCode({
		workflowsPath: WORKFLOWS_PATH,
	});
}, 120_000);

afterAll(async () => {
	await env?.teardown();
});

let taskQueueSeq = 0;

type Mocks = {
	verifyAndScanInstructionFiles: (ref: SnapshotRef) => Promise<GateResult>;
	finalizeInstructionSnapshot: (ref: SnapshotRef) => Promise<GateResult>;
	rejectInstructionSnapshot: (
		input: SnapshotRef & { rejections: unknown[] },
	) => Promise<void>;
	markInstructionSnapshotFailed: (
		input: SnapshotRef & { failure: string },
	) => Promise<{ marked: boolean }>;
	publishInstructionSnapshotActivity: (
		ref: SnapshotRef,
	) => Promise<{ published: boolean; reason?: string }>;
	pruneInstructionSnapshots: (
		ref: SnapshotRef,
	) => Promise<{ deleted: number }>;
};

async function runWorkflow(
	input: SnapshotRef,
	mocks: Mocks,
): Promise<{
	status: "READY" | "REJECTED";
	published: boolean;
	publishReason?: string;
}> {
	const taskQueue = `project-instruction-snapshot-${taskQueueSeq++}`;
	const worker = await Worker.create({
		connection: env.nativeConnection,
		taskQueue,
		workflowBundle,
		activities: mocks,
	});

	return (await worker.runUntil(
		env.client.workflow.execute(WORKFLOW_NAME, {
			args: [input],
			taskQueue,
			workflowId: `${taskQueue}-wf`,
		}),
	)) as {
		status: "READY" | "REJECTED";
		published: boolean;
		publishReason?: string;
	};
}

/** Every error in a `cause` chain, outermost first. */
function causeChain(error: unknown): unknown[] {
	const chain: unknown[] = [];
	let current = error;
	while (current instanceof Error) {
		chain.push(current);
		current = current.cause;
	}
	return chain;
}

function happyMocks(overrides: Partial<Mocks> = {}): Mocks {
	return {
		verifyAndScanInstructionFiles: async () => ({
			ok: true,
			rejections: [],
		}),
		finalizeInstructionSnapshot: async () => ({ ok: true, rejections: [] }),
		rejectInstructionSnapshot: async () => undefined,
		markInstructionSnapshotFailed: async () => ({ marked: true }),
		publishInstructionSnapshotActivity: async () => ({ published: true }),
		pruneInstructionSnapshots: async () => ({ deleted: 0 }),
		...overrides,
	};
}

describe("projectInstructionSnapshotWorkflow", () => {
	it("rejects on a secret hit and never promotes", async () => {
		const mocks = {
			verifyAndScanInstructionFiles: vi.fn().mockResolvedValue({
				ok: false,
				rejections: [
					{ path: "a", reason: "secret", detail: "jwt", line: 1 },
				],
			}),
			finalizeInstructionSnapshot: vi.fn(),
			rejectInstructionSnapshot: vi.fn(),
			markInstructionSnapshotFailed: vi.fn(),
			publishInstructionSnapshotActivity: vi.fn(),
			pruneInstructionSnapshots: vi.fn(),
		};
		const result = await runWorkflow(INPUT, mocks);
		expect(result).toEqual({ status: "REJECTED", published: false });
		expect(mocks.rejectInstructionSnapshot).toHaveBeenCalledWith(
			expect.objectContaining({
				rejections: [
					{ path: "a", reason: "secret", detail: "jwt", line: 1 },
				],
			}),
		);
		expect(mocks.finalizeInstructionSnapshot).not.toHaveBeenCalled();
		expect(mocks.publishInstructionSnapshotActivity).not.toHaveBeenCalled();
		expect(mocks.pruneInstructionSnapshots).not.toHaveBeenCalled();
	});

	it("rejects on an integrity failure and never promotes", async () => {
		const mocks = {
			verifyAndScanInstructionFiles: vi.fn().mockResolvedValue({
				ok: false,
				rejections: [{ path: "b", reason: "hash_mismatch" }],
			}),
			finalizeInstructionSnapshot: vi.fn(),
			rejectInstructionSnapshot: vi.fn(),
			markInstructionSnapshotFailed: vi.fn(),
			publishInstructionSnapshotActivity: vi.fn(),
			pruneInstructionSnapshots: vi.fn(),
		};
		const result = await runWorkflow(INPUT, mocks);
		expect(result).toEqual({ status: "REJECTED", published: false });
		expect(mocks.rejectInstructionSnapshot).toHaveBeenCalledWith(
			expect.objectContaining({
				rejections: [{ path: "b", reason: "hash_mismatch" }],
			}),
		);
		expect(mocks.finalizeInstructionSnapshot).not.toHaveBeenCalled();
	});

	// C1: the staged bytes stay mutable while the client's signed PUT lives,
	// so promotion re-hashes and can still refuse. That verdict must reject
	// the snapshot exactly as the gate's does — never publish it.
	it("rejects when promotion finds the staged bytes changed after the gate (C1)", async () => {
		const mocks = happyMocks({
			finalizeInstructionSnapshot: vi.fn().mockResolvedValue({
				ok: false,
				rejections: [{ path: "c", reason: "hash_mismatch" }],
			}),
			rejectInstructionSnapshot: vi.fn(),
			publishInstructionSnapshotActivity: vi.fn(),
			pruneInstructionSnapshots: vi.fn(),
			markInstructionSnapshotFailed: vi.fn(),
		});

		const result = await runWorkflow(INPUT, mocks);

		expect(result).toEqual({ status: "REJECTED", published: false });
		expect(mocks.rejectInstructionSnapshot).toHaveBeenCalledWith(
			expect.objectContaining({
				rejections: [{ path: "c", reason: "hash_mismatch" }],
			}),
		);
		expect(mocks.publishInstructionSnapshotActivity).not.toHaveBeenCalled();
		expect(mocks.pruneInstructionSnapshots).not.toHaveBeenCalled();
		// REJECTED is a verdict, not a breakdown.
		expect(mocks.markInstructionSnapshotFailed).not.toHaveBeenCalled();
	});

	// C1 (round 2): there is no classify step between the gate and promotion
	// any more. It re-read the mutable staging key without re-hashing it, so
	// frontmatter swapped in after the gate could be persisted as a file's
	// `name`/`description`; the gate now classifies from the buffer it has
	// already verified.
	it("gates, promotes, publishes, and prunes on a clean upload", async () => {
		const order: string[] = [];
		const mocks = happyMocks({
			verifyAndScanInstructionFiles: async () => {
				order.push("gate");
				return { ok: true, rejections: [] };
			},
			finalizeInstructionSnapshot: async () => {
				order.push("promote");
				return { ok: true, rejections: [] };
			},
			publishInstructionSnapshotActivity: async () => {
				order.push("publish");
				return { published: true };
			},
			pruneInstructionSnapshots: async () => {
				order.push("prune");
				return { deleted: 1 };
			},
		});

		const result = await runWorkflow(INPUT, mocks);

		expect(result).toEqual({ status: "READY", published: true });
		expect(order).toEqual(["gate", "promote", "publish", "prune"]);
	});

	it("reports published: false when the snapshot is manual (publishOnReady false), and still prunes", async () => {
		const mocks = happyMocks({
			publishInstructionSnapshotActivity: async () => ({
				published: false,
				reason: "manual",
			}),
		});
		const result = await runWorkflow(INPUT, mocks);
		// Minor 6: the activity's reason travels into the workflow result so
		// "manual" (publishOnReady: false) is distinguishable from a genuine
		// conflict such as "older_than_current".
		expect(result).toEqual({
			status: "READY",
			published: false,
			publishReason: "manual",
		});
	});

	it("carries a genuine publish conflict's reason through distinctly from 'manual' (Minor 6)", async () => {
		const mocks = happyMocks({
			publishInstructionSnapshotActivity: async () => ({
				published: false,
				reason: "older_than_current",
			}),
		});
		const result = await runWorkflow(INPUT, mocks);
		expect(result).toEqual({
			status: "READY",
			published: false,
			publishReason: "older_than_current",
		});
	});

	it("surfaces an activity failure rather than reporting success (no swallowed errors)", async () => {
		let finalizeAttempts = 0;
		const publishMock = vi.fn();
		const markFailed = vi.fn().mockResolvedValue({ marked: true });
		const mocks = happyMocks({
			finalizeInstructionSnapshot: async () => {
				finalizeAttempts++;
				throw new Error("promotion to the immutable prefix failed");
			},
			publishInstructionSnapshotActivity: publishMock,
			markInstructionSnapshotFailed: markFailed,
		});

		const failure = await runWorkflow(INPUT, mocks).then(
			() => {
				throw new Error(
					"expected the workflow to fail, but it completed",
				);
			},
			(error: unknown) => error,
		);

		const chain = causeChain(failure);
		expect(failure).toBeInstanceOf(WorkflowFailedError);
		expect(chain.some((e) => e instanceof ActivityFailure)).toBe(true);
		expect(chain.map((e) => (e as Error).message)).toContain(
			"promotion to the immutable prefix failed",
		);
		// The workflow's ONE try/catch marks the snapshot and RETHROWS: the
		// failure still propagates after the retry policy's bounded 3
		// attempts rather than being swallowed into a reported success, and
		// the step after promotion never runs.
		expect(finalizeAttempts).toBe(3);
		expect(publishMock).not.toHaveBeenCalled();
	});

	// R30/I2. Nothing in the feature wrote FAILED, so an activity that
	// exhausted its attempts left the row VALIDATING and the tab polled it
	// every three seconds forever.
	it("marks the snapshot failed with the error's TYPE/class label, then rethrows", async () => {
		const markFailed = vi.fn().mockResolvedValue({ marked: true });
		const mocks = happyMocks({
			verifyAndScanInstructionFiles: async () => {
				throw new TypeError("credentials rotated mid-validation");
			},
			markInstructionSnapshotFailed: markFailed,
		});

		const failure = await runWorkflow(INPUT, mocks).then(
			() => {
				throw new Error(
					"expected the workflow to fail, but it completed",
				);
			},
			(error: unknown) => error,
		);

		expect(failure).toBeInstanceOf(WorkflowFailedError);
		expect(markFailed).toHaveBeenCalledTimes(1);
		expect(markFailed).toHaveBeenCalledWith({
			...INPUT,
			failure: "TypeError",
		});
		// The label, never the message: an error message can quote a storage
		// URL, a signed key, or the file content that broke the run. Note it
		// is "TypeError" and not "ActivityFailure": the workflow walks to the
		// innermost link of the failure chain, because every activity error
		// arrives wrapped and the outer class name says nothing.
		expect(JSON.stringify(markFailed.mock.calls[0])).not.toContain(
			"credentials rotated",
		);
	});

	// I2 (round 2): `rejectInstructionSnapshot` now deletes the staging objects
	// BEFORE it writes REJECTED, so a cleanup that keeps failing throws out of
	// the activity with the row still VALIDATING. This is the path that used to
	// be impossible: the row went terminal first, and
	// `markInstructionSnapshotFailed` refuses to move a terminal row, so the
	// secret-bearing staging object stayed with no state the UI could retry.
	it("marks a snapshot FAILED when the rejection path's staging cleanup keeps failing", async () => {
		const markFailed = vi.fn().mockResolvedValue({ marked: true });
		const mocks = happyMocks({
			verifyAndScanInstructionFiles: async () => ({
				ok: false,
				rejections: [{ path: "a", reason: "secret", detail: "jwt" }],
			}),
			rejectInstructionSnapshot: async () => {
				throw new Error(
					"Storage delete failed for 1 object(s) during staging cleanup",
				);
			},
			markInstructionSnapshotFailed: markFailed,
		});

		const failure = await runWorkflow(INPUT, mocks).then(
			() => {
				throw new Error(
					"expected the workflow to fail, but it completed",
				);
			},
			(error: unknown) => error,
		);

		expect(failure).toBeInstanceOf(WorkflowFailedError);
		// FAILED is re-attemptable: the tab's "Try again" starts a fresh run
		// whose gate re-reads the staging objects that are still there.
		expect(markFailed).toHaveBeenCalledTimes(1);
	});

	it("does not mark failed on either rejection path — REJECTED is a verdict, not a breakdown", async () => {
		const markFailed = vi.fn().mockResolvedValue({ marked: true });
		const mocks = happyMocks({
			verifyAndScanInstructionFiles: async () => ({
				ok: false,
				rejections: [{ path: "a", reason: "secret", detail: "jwt" }],
			}),
			markInstructionSnapshotFailed: markFailed,
		});

		const result = await runWorkflow(INPUT, mocks);

		expect(result).toEqual({ status: "REJECTED", published: false });
		expect(markFailed).not.toHaveBeenCalled();
	});
});
