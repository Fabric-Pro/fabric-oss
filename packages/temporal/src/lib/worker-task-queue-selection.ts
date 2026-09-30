/**
 * Which task queues one worker process polls (Fizzy #2730).
 *
 * Every queue's worker lives in one Node process and so shares one event
 * loop. A CPU-bound activity — an Atlas analysis of a large repository, a
 * tree-sitter pass in code indexing — holds that loop for minutes, and every
 * other queue in the process misses its heartbeats and database timeouts
 * with it. Separate activity slots do not help: they bound concurrency, not
 * CPU. Running the heavy queues in a separate process does, so the
 * deployment runs the same image twice and tells each copy which queues are
 * its own.
 *
 * Two variables, one per copy, because they fail in different directions:
 *
 * - `WORKER_TASK_QUEUES` (an allowlist) suits the dedicated copy, whose
 *   whole point is a short, fixed set.
 * - `WORKER_EXCLUDED_TASK_QUEUES` (a denylist) suits the general copy. An
 *   allowlist there would have to name every queue, and a queue added later
 *   would be polled by nobody — a workflow started on it is accepted and then
 *   waits in Temporal forever with nothing red anywhere (see
 *   ../task-queues.ts). With a denylist a new queue lands on the general copy
 *   by default.
 *
 * Neither set means every queue, which is what local development and any
 * deployment that predates the split get.
 *
 * Every mistake is fatal at boot rather than a warning: a misspelled name in
 * either list would otherwise leave a queue unpolled (allowlist) or polled
 * twice over (denylist), and both look healthy from the outside.
 */

export const WORKER_TASK_QUEUES_ENV = "WORKER_TASK_QUEUES";
export const WORKER_EXCLUDED_TASK_QUEUES_ENV = "WORKER_EXCLUDED_TASK_QUEUES";

function parseQueueList(value: string | undefined): string[] | null {
	if (value === undefined || value.trim() === "") {
		return null;
	}
	return value
		.split(",")
		.map((name) => name.trim())
		.filter((name) => name !== "");
}

/**
 * The subset of `known` this process should poll, in `known`'s order.
 *
 * @throws when both variables are set, when either names a queue that is not
 *   in `known`, or when the selection leaves nothing to poll.
 */
export function selectTaskQueues(
	known: readonly string[],
	env: Readonly<Record<string, string | undefined>> = process.env,
): string[] {
	const included = parseQueueList(env[WORKER_TASK_QUEUES_ENV]);
	const excluded = parseQueueList(env[WORKER_EXCLUDED_TASK_QUEUES_ENV]);

	if (included && excluded) {
		throw new Error(
			`${WORKER_TASK_QUEUES_ENV} and ${WORKER_EXCLUDED_TASK_QUEUES_ENV} are both set; set at most one.`,
		);
	}

	const named = included ?? excluded;
	if (!named) {
		return [...known];
	}

	const variable = included
		? WORKER_TASK_QUEUES_ENV
		: WORKER_EXCLUDED_TASK_QUEUES_ENV;
	const unknown = named.filter((name) => !known.includes(name));
	if (unknown.length > 0) {
		throw new Error(
			`${variable} names unknown task queue(s): ${unknown.join(", ")}. Known queues: ${known.join(", ")}.`,
		);
	}

	const selected = included
		? known.filter((name) => named.includes(name))
		: known.filter((name) => !named.includes(name));
	if (selected.length === 0) {
		throw new Error(
			`${variable} leaves this worker no task queue to poll.`,
		);
	}
	return selected;
}
