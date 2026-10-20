/**
 * Whether a Temporal run still holds what it was started for: the one
 * question both a Glossy build's stuck-claim reclaim and a client-document
 * Proposal's join of its live run (Fizzy #2946) ask before they let a new run
 * take over.
 *
 * The answer is a tri-state, and only `gone` lets a caller take over: a
 * running or paused run still holds its work, and a doubtful answer — an
 * error, a state this code does not name, or no answer in time — is
 * `unknown`, never `gone`.
 */

import type { getTemporalClient } from "@repo/temporal";

type TemporalClient = Awaited<ReturnType<typeof getTemporalClient>>;

export type WorkflowRunLiveness = "running" | "gone" | "unknown";

/**
 * How long the question may take. It is asked inside requests (and, for a
 * Proposal, inside its dispatch lock), so a Temporal that accepts the
 * connection but never answers must not hold them: an unanswered question is
 * `unknown`.
 */
export const WORKFLOW_RUN_LIVENESS_TIMEOUT_MS = 5_000;

/** Run states in which the run still holds its work. */
const LIVE_RUN_STATUSES: ReadonlySet<string> = new Set(["RUNNING", "PAUSED"]);

/** Run states Temporal reports once a run has closed for good. */
const CLOSED_RUN_STATUSES: ReadonlySet<string> = new Set([
	"COMPLETED",
	"FAILED",
	"CANCELLED",
	"TERMINATED",
	"CONTINUED_AS_NEW",
	"TIMED_OUT",
]);

const LIVENESS_TIMED_OUT = Symbol("liveness timed out");

/**
 * Temporal's "never heard of it", matched by name: the class sets it, and the
 * name survives a caller whose mocks do not share the client package's copy
 * of the class.
 */
function isWorkflowNotFound(error: unknown): boolean {
	return error instanceof Error && error.name === "WorkflowNotFoundError";
}

/**
 * What Temporal says about one run: `running`, `gone` (closed for good, or
 * never heard of), or `unknown` when it could not be asked within
 * {@link WORKFLOW_RUN_LIVENESS_TIMEOUT_MS} or reports a state it does not
 * name.
 *
 * `client` may still be connecting: a client that never connects, or fails
 * to, is covered by the same bound and answers `unknown`.
 */
export async function workflowRunLiveness(
	client: TemporalClient | PromiseLike<TemporalClient>,
	workflowId: string,
): Promise<WorkflowRunLiveness> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const answer = await Promise.race([
			(async () =>
				(await client).workflow.getHandle(workflowId).describe())(),
			new Promise<typeof LIVENESS_TIMED_OUT>((resolve) => {
				timer = setTimeout(
					() => resolve(LIVENESS_TIMED_OUT),
					WORKFLOW_RUN_LIVENESS_TIMEOUT_MS,
				);
			}),
		]);
		if (answer === LIVENESS_TIMED_OUT) {
			return "unknown";
		}
		const status = answer.status.name;
		if (LIVE_RUN_STATUSES.has(status)) {
			return "running";
		}
		return CLOSED_RUN_STATUSES.has(status) ? "gone" : "unknown";
	} catch (error) {
		return isWorkflowNotFound(error) ? "gone" : "unknown";
	} finally {
		clearTimeout(timer);
	}
}
