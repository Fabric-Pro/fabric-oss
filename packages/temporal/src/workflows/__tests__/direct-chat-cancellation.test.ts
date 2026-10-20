/**
 * A cancelled Direct chat turn ends as cancelled, after its model call has
 * stopped.
 *
 * Runs the REAL `directChatWorkflow` on a time-skipping Temporal server with
 * mocked activities. Covers:
 *  - the run ends CANCELED (not FAILED with DIRECT_CHAT_FAILED), and only
 *    once the activity has stopped: the activity is cancelled with
 *    `WAIT_CANCELLATION_COMPLETED`, so the workflow does not abandon it to
 *    run on;
 *  - the `direct-chat-cancellation-v1` patch: a cancelled run recorded by the
 *    code before it (which failed the run without waiting for the activity)
 *    replays on the current code, and would not replay without the patch.
 *
 * Offline note: `createTimeSkipping()` downloads a Temporal test-server binary
 * on first use; run once online to populate the cache.
 */

import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { Context } from "@temporalio/activity";
import { WorkflowFailedError } from "@temporalio/client";
import { ApplicationFailure, CancelledFailure } from "@temporalio/common";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import {
	bundleWorkflowCode,
	Worker,
	type WorkflowBundleWithSourceMap,
} from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
	DirectChatWorkflowInput,
	DirectChatWorkflowOutput,
} from "../../types";

const WORKFLOWS_PATH = resolve(__dirname, "..");
const PATCH_CALL = 'patched("direct-chat-cancellation-v1")';
const BUNDLE_DIR_PREFIX = ".direct-chat-cancel-variant-";

let env: TestWorkflowEnvironment;
let workflowBundle: WorkflowBundleWithSourceMap;
let prePatchBundle: WorkflowBundleWithSourceMap;
let unguardedBundle: WorkflowBundleWithSourceMap;
let taskQueueSeq = 0;

/**
 * `directChatWorkflow` with the patch call replaced: `false` is the code
 * before the patch, `true` is the change made without a patch. Bundled from a
 * copy one directory deeper, with its relative imports moved to match.
 */
async function bundleVariant(patchValue: "false" | "true") {
	const source = readFileSync(join(WORKFLOWS_PATH, "direct-chat.ts"), "utf8");
	if (!source.includes(PATCH_CALL)) {
		throw new Error("the cancellation patch moved; update this test");
	}
	const variant = source.replace(PATCH_CALL, patchValue);
	// Under __tests__, which the starter-allowlist scan skips.
	const dir = mkdtempSync(join(__dirname, BUNDLE_DIR_PREFIX));
	try {
		writeFileSync(
			join(dir, "workflow.ts"),
			variant
				.replace(/from "\.\.\//g, 'from "../../../')
				.replace(/from "\.\//g, 'from "../../'),
		);
		return await bundleWorkflowCode({
			workflowsPath: join(dir, "workflow.ts"),
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

beforeAll(async () => {
	env = await TestWorkflowEnvironment.createTimeSkipping();
	workflowBundle = await bundleWorkflowCode({
		workflowsPath: WORKFLOWS_PATH,
	});
	prePatchBundle = await bundleVariant("false");
	unguardedBundle = await bundleVariant("true");
}, 300_000);

afterAll(async () => {
	await env?.teardown();
	// A crashed run can leave its bundling directory behind.
	for (const entry of readdirSync(__dirname)) {
		if (entry.startsWith(BUNDLE_DIR_PREFIX)) {
			rmSync(join(__dirname, entry), { recursive: true, force: true });
		}
	}
});

const INPUT = {
	message: "What is on the roadmap?",
	userId: "user-1",
	organizationId: "org-1",
	reasoningMode: "balanced",
	conversationId: "conversation-1",
} as DirectChatWorkflowInput;

/**
 * Starts a turn whose model call runs until it is cancelled, cancels the
 * workflow once the call is under way, and reports how the run ended.
 */
async function cancelTurnMidCall(bundle: WorkflowBundleWithSourceMap) {
	let callStarted: () => void = () => undefined;
	const started = new Promise<void>((resolve) => {
		callStarted = resolve;
	});
	const events: string[] = [];
	const taskQueue = `direct-cancel-${taskQueueSeq++}`;
	const workflowId = `${taskQueue}-wf`;
	const worker = await Worker.create({
		connection: env.nativeConnection,
		taskQueue,
		workflowBundle: bundle,
		// As the fabric-worker queue sets it (src/worker.ts): Temporal hands
		// an activity its cancel only in the reply to a heartbeat sent.
		maxHeartbeatThrottleInterval: "1s",
		activities: {
			collectMcpToolsActivity: async () => ({
				tools: {},
				toolToServerMap: {},
				mcpToolInfo: [],
			}),
			generateMemoryContextActivity: async () => ({
				context: "",
				memoryCount: 0,
			}),
			generateToolSuggestionsActivity: async () => "",
			// A model call that only stops when the activity is cancelled,
			// as the real activity does once it reads the signal.
			executeDirectChatActivity:
				async (): Promise<DirectChatWorkflowOutput> => {
					const context = Context.current();
					callStarted();
					while (!context.cancellationSignal.aborted) {
						context.heartbeat();
						await new Promise((resolve) => setTimeout(resolve, 50));
					}
					events.push("model call stopped");
					throw context.cancellationSignal.reason;
				},
		},
	});
	const outcome = await worker.runUntil(async () => {
		const handle = await env.client.workflow.start("directChatWorkflow", {
			args: [{ ...INPUT, executionId: workflowId }],
			taskQueue,
			workflowId,
		});
		await started;
		await handle.cancel();
		const error = await handle.result().then(
			() => undefined,
			(failure: unknown) => failure,
		);
		events.push("workflow ended");
		const { status } = await handle.describe();
		const postOperationChild = await env.client.workflow
			.getHandle(`${workflowId}-post-op`)
			.describe()
			.then(
				() => true,
				() => false,
			);
		return { error, status: status.name, postOperationChild };
	});
	return { ...outcome, events, workflowId };
}

describe("directChatWorkflow — a turn cancelled during its model call", () => {
	it(
		"ends as cancelled once the model call has stopped, without a failure",
		{
			timeout: 60_000,
		},
		async () => {
			const { error, status, events, postOperationChild } =
				await cancelTurnMidCall(workflowBundle);

			expect(status).toBe("CANCELLED");
			expect(error).toBeInstanceOf(WorkflowFailedError);
			expect((error as WorkflowFailedError).cause).toBeInstanceOf(
				CancelledFailure,
			);
			// The workflow waited for the activity to stop before it ended.
			expect(events).toEqual(["model call stopped", "workflow ended"]);
			expect(postOperationChild).toBe(false);
		},
	);

	it(
		"replays a cancelled run recorded before the patch, which failed it",
		{
			timeout: 60_000,
		},
		async () => {
			const { error, status, workflowId } =
				await cancelTurnMidCall(prePatchBundle);
			// The code before the patch failed the run.
			expect(status).toBe("FAILED");
			expect((error as WorkflowFailedError).cause).toBeInstanceOf(
				ApplicationFailure,
			);
			expect(
				((error as WorkflowFailedError).cause as ApplicationFailure)
					.type,
			).toBe("DIRECT_CHAT_FAILED");

			const history = await env.client.workflow
				.getHandle(workflowId)
				.fetchHistory();
			await expect(
				Worker.runReplayHistory(
					{ workflowBundle },
					history,
					workflowId,
				),
			).resolves.toBeUndefined();
			// The same change without the patch cannot replay it.
			await expect(
				Worker.runReplayHistory(
					{ workflowBundle: unguardedBundle },
					history,
					workflowId,
				),
			).rejects.toThrow();
		},
	);
});
