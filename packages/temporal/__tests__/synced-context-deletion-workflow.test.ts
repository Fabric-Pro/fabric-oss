/**
 * Behavioral (TestWorkflowEnvironment) tests for
 * `syncedContextDeletionWorkflow` (Fizzy #2636): the durable compare-and-set
 * delete behind `fabric context push --prune`.
 *
 * Mirrors `__tests__/project-instruction-snapshot-workflow.test.ts`: a local
 * time-skipping Temporal test server, the REAL workflow code bundled from
 * the workflows barrel (so these cases also prove the workflow is exported
 * there), and mocked activities.
 *
 * What this pins:
 *  - the steps run in order — claim, vector delete, row delete — each with
 *    the project's hosting organization, and nothing destructive runs when
 *    the claim answers `absent` or `conflict`; the row delete carries the
 *    operation id, the claimed title and the request's audit context, since
 *    it writes the audit row in the delete's transaction;
 *  - a failed step fails the workflow with a failure type the API maps,
 *    after Temporal's retries, and nothing after it runs: in particular a
 *    row is never deleted while its points could not be removed;
 *  - a row delete that loses a race after the points were removed starts the
 *    embedding workflow for the survivor (`reembed: true`), abandoned so it
 *    outlives this one, and answers `conflict` or `absent`;
 *  - after a `deleted` row delete, and only then, the last activity
 *    publishes the delete to the realtime channels, so the delete is seen
 *    even when no request is left waiting; a publish that cannot be made
 *    never turns a committed delete into a failure;
 *  - the workflow replays deterministically against its own history (there
 *    are no production histories for a new workflow yet).
 *
 * Offline note: `TestWorkflowEnvironment.createTimeSkipping()` downloads a
 * Temporal test-server binary on first use.
 *
 * Run with:
 *   pnpm --filter @repo/temporal exec vitest run __tests__/synced-context-deletion-workflow.test.ts
 */

import { resolve } from "node:path";
import { WorkflowFailedError } from "@temporalio/client";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import {
	bundleWorkflowCode,
	Worker,
	type WorkflowBundleWithSourceMap,
} from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type {
	ClaimSyncedContextForDeletionOutput,
	DeleteSyncedContextRowInput,
	DeleteSyncedContextRowOutput,
	PublishSyncedContextDeletedInput,
	SyncedContextDeletionActivityInput,
} from "../src/activities/synced-context-deletion";
import {
	SYNCED_CONTEXT_DELETION_FAILURE,
	SYNCED_CONTEXT_DELETION_TASK_QUEUE,
	type SyncedContextDeletionWorkflowInput,
} from "../src/lib/synced-context-deletion-contract";

const WORKFLOWS_PATH = resolve(__dirname, "..", "src", "workflows");
const WORKFLOW_NAME = "syncedContextDeletionWorkflow";

/** The version the delete names: what the claim is keyed on. */
const TARGET: SyncedContextDeletionActivityInput = {
	projectId: "proj-1",
	sourcePath: "docs/glossary.md",
	expectedContentHash: "a".repeat(64),
	userId: "user-1",
	organizationId: "org-host",
};

const INPUT: SyncedContextDeletionWorkflowInput = {
	...TARGET,
	// A fresh UUID per request; the workflow id is built from it.
	operationId: "0b6f1a52-9d3e-4c1a-8f4e-2d7c5b9a3e10",
	audit: {
		via: "v1-api",
		impersonatedById: null,
		ipAddress: "203.0.113.7",
		userAgent: "fabric-cli/1.0",
		requestId: "req-1",
		sessionId: null,
		correlationId: "corr-1",
	},
};

const CLAIMED: ClaimSyncedContextForDeletionOutput = {
	status: "claimed",
	context: {
		contextId: "ctx-1",
		qdrantId: "11111111-2222-3333-4444-555555555555",
		type: "TEXT",
		title: "Glossary",
	},
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
	claimSyncedContextForDeletion: (
		input: SyncedContextDeletionActivityInput,
	) => Promise<ClaimSyncedContextForDeletionOutput>;
	deleteSyncedContextVectors: (input: {
		contextId: string;
		organizationId: string;
		qdrantId: string | null;
	}) => Promise<void>;
	deleteSyncedContextRow: (
		input: DeleteSyncedContextRowInput,
	) => Promise<DeleteSyncedContextRowOutput>;
	publishSyncedContextDeleted: (
		input: PublishSyncedContextDeletedInput,
	) => Promise<void>;
	/** The child `contextEmbeddingWorkflow` a lost race starts. */
	embedSingleContextActivity: (input: unknown) => Promise<unknown>;
};

function happyMocks(overrides: Partial<Mocks> = {}): Mocks {
	return {
		claimSyncedContextForDeletion: vi.fn(async () => CLAIMED),
		deleteSyncedContextVectors: vi.fn(async () => undefined),
		deleteSyncedContextRow: vi.fn(
			async (): Promise<DeleteSyncedContextRowOutput> => ({
				status: "deleted",
			}),
		),
		publishSyncedContextDeleted: vi.fn(async () => undefined),
		embedSingleContextActivity: vi.fn(async () => ({ success: true })),
		...overrides,
	};
}

/**
 * Run the workflow to completion. With `awaitChildOf`, also run a worker on
 * the queue the rebuild is started on, and wait for that embedding workflow
 * before the workers stop.
 */
async function runWorkflow(
	mocks: Mocks,
	options: { awaitChildOf?: string } = {},
): Promise<{ result: unknown; workflowId: string; runId: string }> {
	const taskQueue = `synced-context-deletion-${taskQueueSeq++}`;
	const worker = await Worker.create({
		connection: env.nativeConnection,
		taskQueue,
		workflowBundle,
		activities: mocks,
	});
	const childWorker = options.awaitChildOf
		? await Worker.create({
				connection: env.nativeConnection,
				taskQueue: SYNCED_CONTEXT_DELETION_TASK_QUEUE,
				workflowBundle,
				activities: mocks,
			})
		: null;
	const workflowId = `${taskQueue}-wf`;

	const run = (async () => {
		const handle = await env.client.workflow.start(WORKFLOW_NAME, {
			args: [INPUT],
			taskQueue,
			workflowId,
		});
		const result = await handle.result();
		if (options.awaitChildOf) {
			await env.client.workflow
				.getHandle(
					`context-embedding-${options.awaitChildOf}-${handle.firstExecutionRunId}`,
				)
				.result();
		}
		return { result, workflowId, runId: handle.firstExecutionRunId };
	})();

	const [outcome] = await Promise.all([
		worker.runUntil(run),
		childWorker?.runUntil(run.catch(() => undefined)),
	]);
	return outcome;
}

async function failureOf(mocks: Mocks): Promise<{ type?: string }> {
	const error = await runWorkflow(mocks).catch((caught: unknown) => caught);
	expect(error).toBeInstanceOf(WorkflowFailedError);
	return (error as WorkflowFailedError).cause as { type?: string };
}

describe("syncedContextDeletionWorkflow", () => {
	it("claims, removes the points, then deletes the row, each under the hosting organization", async () => {
		const order: string[] = [];
		const mocks = happyMocks({
			claimSyncedContextForDeletion: vi.fn(async () => {
				order.push("claim");
				return CLAIMED;
			}),
			deleteSyncedContextVectors: vi.fn(async () => {
				order.push("vectors");
			}),
			deleteSyncedContextRow: vi.fn(async () => {
				order.push("row");
				return { status: "deleted" as const };
			}),
			publishSyncedContextDeleted: vi.fn(async () => {
				order.push("publish");
			}),
		});

		const { result } = await runWorkflow(mocks);

		expect(order).toEqual(["claim", "vectors", "row", "publish"]);
		expect(result).toEqual({ status: "deleted", context: CLAIMED.context });
		// The claim is keyed on the version alone; the audit context rides
		// only to the step that writes the audit row.
		expect(mocks.claimSyncedContextForDeletion).toHaveBeenCalledWith(
			TARGET,
		);
		expect(mocks.deleteSyncedContextVectors).toHaveBeenCalledWith({
			contextId: "ctx-1",
			organizationId: "org-host",
			qdrantId: "11111111-2222-3333-4444-555555555555",
		});
		expect(mocks.deleteSyncedContextRow).toHaveBeenCalledWith({
			...TARGET,
			contextId: "ctx-1",
			title: "Glossary",
			operationId: INPUT.operationId,
			audit: INPUT.audit,
		});
		// The publish is the workflow's, so it happens whether or not a
		// request is still waiting; the user's name is read in the activity.
		expect(mocks.publishSyncedContextDeleted).toHaveBeenCalledTimes(1);
		expect(mocks.publishSyncedContextDeleted).toHaveBeenCalledWith({
			organizationId: "org-host",
			projectId: "proj-1",
			contextId: "ctx-1",
			sourcePath: "docs/glossary.md",
			userId: "user-1",
			contextType: "TEXT",
			contextName: "Glossary",
		});
		expect(mocks.embedSingleContextActivity).not.toHaveBeenCalled();
	});

	it("still answers deleted when the publish cannot be made: the delete is committed and recorded", async () => {
		const mocks = happyMocks({
			publishSyncedContextDeleted: vi.fn(async () => {
				throw new Error("database unavailable");
			}),
		});

		const { result } = await runWorkflow(mocks);

		expect(result).toEqual({ status: "deleted", context: CLAIMED.context });
		expect(
			(mocks.publishSyncedContextDeleted as ReturnType<typeof vi.fn>).mock
				.calls.length,
		).toBeGreaterThan(1);
	});

	it("answers absent and touches nothing when no row is at the path", async () => {
		const mocks = happyMocks({
			claimSyncedContextForDeletion: vi.fn(async () => ({
				status: "absent" as const,
			})),
		});

		const { result } = await runWorkflow(mocks);

		expect(result).toEqual({ status: "absent" });
		expect(mocks.deleteSyncedContextVectors).not.toHaveBeenCalled();
		expect(mocks.deleteSyncedContextRow).not.toHaveBeenCalled();
		expect(mocks.publishSyncedContextDeleted).not.toHaveBeenCalled();
	});

	it("answers the claim's conflict and touches nothing when the path holds another version", async () => {
		const current = {
			contextId: "ctx-1",
			contentHash: "b".repeat(64),
			contentUpdatedAt: "2026-09-22T11:00:00.000Z",
			contentUpdatedByUserId: "user-2",
		};
		const mocks = happyMocks({
			claimSyncedContextForDeletion: vi.fn(async () => ({
				status: "conflict" as const,
				current,
			})),
		});

		const { result } = await runWorkflow(mocks);

		expect(result).toEqual({ status: "conflict", current });
		expect(mocks.deleteSyncedContextVectors).not.toHaveBeenCalled();
		expect(mocks.deleteSyncedContextRow).not.toHaveBeenCalled();
		expect(mocks.publishSyncedContextDeleted).not.toHaveBeenCalled();
	});

	it("never deletes the row when its points cannot be removed: retries, then fails with the index-cleanup type", async () => {
		const mocks = happyMocks({
			deleteSyncedContextVectors: vi.fn(async () => {
				throw new Error("Failed to delete project context: timeout");
			}),
		});

		const cause = await failureOf(mocks);

		expect(cause.type).toBe(SYNCED_CONTEXT_DELETION_FAILURE.indexCleanup);
		// Temporal retried it before giving up.
		expect(
			(mocks.deleteSyncedContextVectors as ReturnType<typeof vi.fn>).mock
				.calls.length,
		).toBeGreaterThan(1);
		expect(mocks.deleteSyncedContextRow).not.toHaveBeenCalled();
	});

	it("fails with the row-delete type when the row cannot be deleted after its points were removed", async () => {
		const mocks = happyMocks({
			deleteSyncedContextRow: vi.fn(async () => {
				throw new Error("database unavailable");
			}),
		});

		const cause = await failureOf(mocks);

		expect(cause.type).toBe(SYNCED_CONTEXT_DELETION_FAILURE.rowDelete);
		expect(
			(mocks.deleteSyncedContextRow as ReturnType<typeof vi.fn>).mock
				.calls.length,
		).toBeGreaterThan(1);
	});

	it("fails with the claim type, having removed nothing, when the claim cannot be made", async () => {
		const mocks = happyMocks({
			claimSyncedContextForDeletion: vi.fn(async () => {
				throw new Error("database unavailable");
			}),
		});

		const cause = await failureOf(mocks);

		expect(cause.type).toBe(SYNCED_CONTEXT_DELETION_FAILURE.claim);
		expect(mocks.deleteSyncedContextVectors).not.toHaveBeenCalled();
		expect(mocks.deleteSyncedContextRow).not.toHaveBeenCalled();
	});

	it("rebuilds the index of a row that changed after its points were removed, and answers the conflict", async () => {
		const current = {
			contextId: "ctx-1",
			contentHash: "b".repeat(64),
			contentUpdatedAt: "2026-09-22T11:00:00.000Z",
			contentUpdatedByUserId: "user-2",
		};
		const mocks = happyMocks({
			deleteSyncedContextRow: vi.fn(async () => ({
				status: "conflict" as const,
				current,
				reindex: {
					contextId: "ctx-1",
					sourcePath: "docs/glossary.md",
					title: "Glossary",
				},
			})),
		});

		const { result } = await runWorkflow(mocks, { awaitChildOf: "ctx-1" });

		expect(result).toEqual({ status: "conflict", current });
		expect(mocks.publishSyncedContextDeleted).not.toHaveBeenCalled();
		expect(mocks.embedSingleContextActivity).toHaveBeenCalledTimes(1);
		expect(mocks.embedSingleContextActivity).toHaveBeenCalledWith(
			expect.objectContaining({
				contextId: "ctx-1",
				projectId: "proj-1",
				userId: "user-1",
				organizationId: "org-host",
				type: "TEXT",
				metadata: {
					filename: "docs/glossary.md",
					sourceTitle: "Glossary",
					sourcePath: "docs/glossary.md",
				},
				reembed: true,
			}),
		);
	});

	it("rebuilds a row moved after its points were removed under its new path, and answers absent", async () => {
		const mocks = happyMocks({
			deleteSyncedContextRow: vi.fn(async () => ({
				status: "absent" as const,
				reindex: {
					contextId: "ctx-1",
					sourcePath: "docs/renamed.md",
					title: "renamed.md",
				},
			})),
		});

		const { result } = await runWorkflow(mocks, { awaitChildOf: "ctx-1" });

		expect(result).toEqual({ status: "absent" });
		expect(mocks.publishSyncedContextDeleted).not.toHaveBeenCalled();
		expect(mocks.embedSingleContextActivity).toHaveBeenCalledWith(
			expect.objectContaining({
				contextId: "ctx-1",
				metadata: {
					filename: "docs/renamed.md",
					sourceTitle: "renamed.md",
					sourcePath: "docs/renamed.md",
				},
				reembed: true,
			}),
		);
	});

	it("answers absent with nothing to rebuild when somebody else deleted the row", async () => {
		const mocks = happyMocks({
			deleteSyncedContextRow: vi.fn(async () => ({
				status: "absent" as const,
				reindex: null,
			})),
		});

		const { result } = await runWorkflow(mocks);

		expect(result).toEqual({ status: "absent" });
		expect(mocks.embedSingleContextActivity).not.toHaveBeenCalled();
		// Somebody else deleted it, and published their own delete.
		expect(mocks.publishSyncedContextDeleted).not.toHaveBeenCalled();
	});

	it("replays a deleted run, publish included, deterministically against its own history", async () => {
		const mocks = happyMocks();
		const { workflowId } = await runWorkflow(mocks);
		expect(mocks.publishSyncedContextDeleted).toHaveBeenCalledTimes(1);

		const history = await env.client.workflow
			.getHandle(workflowId)
			.fetchHistory();

		await expect(
			Worker.runReplayHistory({ workflowBundle }, history, workflowId),
		).resolves.toBeUndefined();
	});

	it("replays deterministically against its own history", async () => {
		const mocks = happyMocks({
			deleteSyncedContextRow: vi.fn(async () => ({
				status: "conflict" as const,
				current: {
					contextId: "ctx-1",
					contentHash: "b".repeat(64),
					contentUpdatedAt: null,
					contentUpdatedByUserId: null,
				},
				reindex: {
					contextId: "ctx-1",
					sourcePath: "docs/glossary.md",
					title: "Glossary",
				},
			})),
		});
		const { workflowId } = await runWorkflow(mocks, {
			awaitChildOf: "ctx-1",
		});

		const history = await env.client.workflow
			.getHandle(workflowId)
			.fetchHistory();

		await expect(
			Worker.runReplayHistory({ workflowBundle }, history, workflowId),
		).resolves.toBeUndefined();
	});
});
