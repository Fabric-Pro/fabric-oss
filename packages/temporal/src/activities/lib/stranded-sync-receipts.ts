/**
 * What the two stranded-receipt reapers (Coding Instructions, Fizzy #2672, and
 * Living Memory, Fizzy #2784) share: which workflow run a receipt names, and
 * whether Temporal says that exact run has ended. Everything that decides what
 * to do with a receipt stays in each reaper.
 *
 * Not in either activity module on purpose: every export there is a
 * schedulable activity.
 */
import type { Client } from "@temporalio/client";

const CLOSED_STATUSES: ReadonlySet<string> = new Set([
	"COMPLETED",
	"FAILED",
	"CANCELLED",
	"TERMINATED",
	"TIMED_OUT",
	"CONTINUED_AS_NEW",
]);

export type ExecutionState = "running" | "closed" | "not-found" | "unknown";

class DescribeTimeout extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new DescribeTimeout()), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * The workflow run id a receipt key names: `<syncId>:<workflow run id>`.
 * `null` for a key of any other shape, which is never described.
 */
export function workflowRunIdOf(receipt: { id: string; syncId: string }) {
	const prefix = `${receipt.syncId}:`;
	const runId = receipt.id.startsWith(prefix)
		? receipt.id.slice(prefix.length)
		: "";
	return runId.length > 0 && !runId.includes(":") ? runId : null;
}

/**
 * The state of one EXACT execution (the starter's workflow id plus the run id
 * in the receipt's key). An unanswered describe is `unknown`, never read as
 * closed.
 */
export async function describeExecution(
	client: Pick<Client, "workflow">,
	workflowId: string,
	runId: string,
	timeoutMs: number,
): Promise<ExecutionState> {
	try {
		const description = await withTimeout(
			client.workflow.getHandle(workflowId, runId).describe(),
			timeoutMs,
		);
		const status = description.status.name;
		if (status === "RUNNING") {
			return "running";
		}
		return CLOSED_STATUSES.has(status) ? "closed" : "unknown";
	} catch (error) {
		return error instanceof Error && error.name === "WorkflowNotFoundError"
			? "not-found"
			: "unknown";
	}
}
