import type { Worker } from "@temporalio/worker";
import { registerSystemSchedules } from "./schedules";

/**
 * The worker's final startup step, as a CALLABLE rather than as inline code in
 * worker.ts's `run()`.
 *
 * The seam is drawn HERE and not one line earlier, deliberately. Registering the
 * system schedules and starting the pollers are welded into one function, so a
 * worker process cannot poll for tasks without having attempted registration.
 * The one line this leaves untested — worker.ts's own call to this function —
 * therefore has a LOUD failure mode: delete it and the process creates its
 * workers and exits without polling anything, on every boot, in every
 * environment. That is the opposite of the create-only schedule's failure mode,
 * which is silence.
 *
 * Fire-and-forget on purpose: a registration failure must not stop the worker
 * from polling. The `.catch` is not optional decoration — a bare
 * `void registerSystemSchedules()` would satisfy "does not block" and lose the
 * error, so the swallow is EXPLICIT and the test asserts the logged message.
 */
export function startWorkerRuntime(
	workers: Pick<Worker, "run">[],
): Promise<unknown> {
	registerSystemSchedules().catch((error) => {
		console.error(
			"[Worker] Failed to register system schedules:",
			error instanceof Error ? error.message : error,
		);
	});

	console.log("[Worker] Polling for tasks...");
	return Promise.all(workers.map((worker) => worker.run()));
}
