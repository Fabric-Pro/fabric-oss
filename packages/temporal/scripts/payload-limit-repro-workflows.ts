/**
 * Workflow definitions for the payload-limit repro
 * (`scripts/payload-limit-repro.ts`). Kept in their own module because
 * Temporal bundles workflows by path — these must never import Node-only
 * code.
 *
 * The activities are injected by the repro runner via `Worker.create`.
 */

import { proxyActivities } from "@temporalio/workflow";

interface ReproActivities {
	/** Returns a deliberately oversized board listing (>4 MiB serialized). */
	fetchOversizedBoard: () => Promise<{
		items: Array<Record<string, unknown>>;
	}>;
	/** Same data, but bounded through `slimWorkItemSummaries` first (#1997). */
	fetchSlimmedBoard: () => Promise<{ items: Array<Record<string, unknown>> }>;
}

// Destructure directly — wrapping this proxy in an async function makes
// `await` probe the proxy's `.then`, which schedules a phantom "then"
// activity ("Activity function then is not registered").
const { fetchOversizedBoard, fetchSlimmedBoard } =
	proxyActivities<ReproActivities>({
		startToCloseTimeout: "30 seconds",
		retry: { maximumAttempts: 1 },
	});

/** Fails when the activity return crosses the server's gRPC frame limit. */
export async function oversizedReturnWorkflow(): Promise<string> {
	const result = await fetchOversizedBoard();
	return `completed with ${result.items.length} items`;
}

/** Succeeds where {@link oversizedReturnWorkflow} fails: bodies are elided. */
export async function slimmedReturnWorkflow(): Promise<string> {
	const result = await fetchSlimmedBoard();
	return `completed with ${result.items.length} items`;
}
