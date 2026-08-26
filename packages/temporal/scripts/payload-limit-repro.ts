/**
 * Reproduces the Temporal payload-size failure against the LOCAL Temporal
 * server and demonstrates the mitigation (Fizzy #1997).
 *
 * The 4 MiB ceiling is the gRPC max-message size every Temporal frontend
 * enforces — Cloud and self-hosted alike — so the local auto-setup server is
 * production-equivalent for this failure mode. Production evidence (#1741):
 * a 6,482,333-byte activity return rejected at exactly 4,194,304 bytes.
 *
 * Cases:
 *   A. An activity returns a ~5 MiB board listing → the workflow FAILS with
 *      the server-side rejection (the pre-fix behaviour that stalled pulls).
 *   B. The same data bounded through `slimWorkItemSummaries` before it
 *      crosses → the workflow COMPLETES (the #1997 fix shape).
 *
 * Usage (local stack must be up: `bash aspire.sh up`):
 *   pnpm --filter @repo/temporal exec tsx scripts/payload-limit-repro.ts
 *
 * Exits non-zero if case A unexpectedly succeeds or case B unexpectedly
 * fails. Read-only against Temporal: creates short-lived workflows on a
 * throwaway task queue and lets their retention expire.
 */

import { Client } from "@temporalio/client";
import {
	bundleWorkflowCode,
	NativeConnection,
	Worker,
} from "@temporalio/worker";
import { slimWorkItemSummaries } from "../src/lib/payload-elision";
import {
	measureSerializedBytes,
	TEMPORAL_MAX_MESSAGE_BYTES,
} from "../src/lib/payload-size-guard";

const ADDRESS = process.env.TEMPORAL_ADDRESS ?? "localhost:7233";
const NAMESPACE = process.env.TEMPORAL_NAMESPACE ?? "default";

/** ~500 cards × ~10 KB bodies ≈ 5.2 MB serialized — the #1741 scenario. */
function oversizedBoard(): Array<Record<string, unknown>> {
	return Array.from({ length: 500 }, (_, i) => ({
		id: String(i),
		title: `Card ${i}`,
		description: `d${i}`.padEnd(10_000, "d"),
		state: "In Progress",
	}));
}

const board = oversizedBoard();

const activities = {
	fetchOversizedBoard: async (): Promise<{
		items: Array<Record<string, unknown>>;
	}> => ({ items: board }),
	fetchSlimmedBoard: async (): Promise<{
		items: Array<Record<string, unknown>>;
	}> => {
		const slimmed = slimWorkItemSummaries(
			board,
			TEMPORAL_MAX_MESSAGE_BYTES - 64 * 1024,
		);
		console.log(
			`  [activity] slimmed listing: ${measureSerializedBytes(board)} → ${slimmed.bytes} bytes (fits=${slimmed.fits})`,
		);
		return { items: slimmed.items };
	},
};

async function main(): Promise<void> {
	if (process.env.NODE_ENV === "production") {
		throw new Error("refusing to run the repro in production");
	}

	const rawBytes = measureSerializedBytes({ items: board });
	console.log(
		`[repro] fixture: ${board.length} cards, ${rawBytes} bytes serialized (frame = ${TEMPORAL_MAX_MESSAGE_BYTES})`,
	);
	if (rawBytes <= TEMPORAL_MAX_MESSAGE_BYTES) {
		throw new Error("fixture does not exceed the frame — enlarge it");
	}

	const connection = await NativeConnection.connect({ address: ADDRESS });
	const client = new Client({ connection, namespace: NAMESPACE });
	const taskQueue = `payload-repro-${process.pid}`;

	const workflowBundle = await bundleWorkflowCode({
		workflowsPath: require.resolve("./payload-limit-repro-workflows"),
	});

	const worker = await Worker.create({
		connection,
		namespace: NAMESPACE,
		taskQueue,
		workflowBundle,
		activities,
		maxConcurrentActivityTaskExecutions: 1,
		// 1 is rejected by the core bridge when workflow caching is on
		// ("workflow_task_poller_behavior to be at least 2").
		maxConcurrentWorkflowTaskExecutions: 2,
	});
	const workerRun = worker.run();
	void workerRun.catch((err) => {
		console.error("[repro] worker run failed:", err);
	});
	// shutdown() signals the drain; the run promise resolves once it finishes,
	// and the connection must not close before that.
	const awaitWorkerDrain = workerRun.catch(() => undefined);

	let failures = 0;

	/** Flatten an error's cause chain — the size rejection sits a few links
	 *  down beneath WorkflowExecutionFailedError → ActivityFailure → … */
	function errorChainMessage(err: unknown): string {
		const parts: string[] = [];
		let current: unknown = err;
		let guard = 0;
		while (current instanceof Error && guard++ < 10) {
			parts.push(current.message);
			current = (current as { cause?: unknown }).cause;
		}
		return parts.join(" | ");
	}

	try {
		// Case A — unbounded return: expected to FAIL at the server.
		let caseAError: string | null = null;
		try {
			await client.workflow.execute("oversizedReturnWorkflow", {
				taskQueue,
				workflowId: `payload-repro-a-${process.pid}`,
				workflowExecutionTimeout: "2 minutes",
			});
			console.log("[repro] case A: UNEXPECTEDLY SUCCEEDED");
			failures++;
		} catch (err) {
			caseAError = errorChainMessage(err);
			console.log(`[repro] case A failed as expected: ${caseAError}`);
		}
		// The observable workflow-level signature of an oversized completion is
		// the StartToClose timeout: the Rust core logs the actual
		// "grpc: received message larger than max" rejection, but the activity
		// never registers complete, so Temporal records a timeout — this IS
		// how #1741 manifested in production (485 occurrences over 8 days).
		const looksLikeSizeRejection =
			caseAError != null &&
			/start.?to.?close.*(timeout|timed out)|larger than max|resource.?exhausted|PAYLOAD_TOO_LARGE|4194304/i.test(
				caseAError,
			);
		if (!looksLikeSizeRejection) {
			console.log(
				"[repro] case A error does NOT look like a size rejection — investigate",
			);
			failures++;
		}

		// Case B — elided return: expected to COMPLETE.
		try {
			const result = await client.workflow.execute(
				"slimmedReturnWorkflow",
				{
					taskQueue,
					workflowId: `payload-repro-b-${process.pid}`,
					workflowExecutionTimeout: "2 minutes",
				},
			);
			console.log(`[repro] case B completed as expected: ${result}`);
		} catch (err) {
			console.log(
				`[repro] case B UNEXPECTEDLY FAILED: ${err instanceof Error ? err.message : err}`,
			);
			failures++;
		}
	} finally {
		// shutdown() signals the drain; await the run promise before closing
		// the connection — closing while workers hold a reference throws.
		worker.shutdown();
		await awaitWorkerDrain;
		await connection.close();
	}

	if (failures > 0) {
		console.log(`[repro] FAILED with ${failures} unexpected outcome(s)`);
		process.exit(1);
	}
	console.log(
		"[repro] PASSED — failure reproduced pre-bound, success post-bound",
	);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
