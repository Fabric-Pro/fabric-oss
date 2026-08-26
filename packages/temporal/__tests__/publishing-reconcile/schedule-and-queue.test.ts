import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	PUBLISHING_RECONCILE_CATCHUP_WINDOW,
	PUBLISHING_RECONCILE_CRON_SCHEDULE,
	PUBLISHING_RECONCILE_EXECUTION_TIMEOUT_MS,
	PUBLISHING_RECONCILE_SCHEDULE_ID,
	PUBLISHING_RECONCILE_TASK_QUEUE,
} from "../../src/schedules";

/**
 * Derive the interval between triggers from the cron expression itself.
 *
 * Deliberately narrow, and it THROWS on anything it does not recognise rather
 * than guessing. The point is that changing the cadence cannot silently satisfy
 * the invariant below: a shape this function does not handle fails the test and
 * asks a human to extend it, which is the correct outcome for a create-only
 * schedule whose numbers cannot be edited after registration.
 */
function cronIntervalMs(expression: string): number {
	const [minute, hour, dayOfMonth, month, dayOfWeek] = expression
		.trim()
		.split(/\s+/);
	if (dayOfMonth !== "*" || month !== "*" || dayOfWeek !== "*") {
		throw new Error(`Unsupported cron shape: ${expression}`);
	}
	if (hour !== "*") {
		throw new Error(`Unsupported cron shape: ${expression}`);
	}
	if (minute === "*") {
		return 60_000;
	}
	if (/^\d+$/.test(minute)) {
		return 60 * 60_000;
	}
	const stepped = /^\*\/(\d+)$/.exec(minute);
	if (stepped) {
		return Number(stepped[1]) * 60_000;
	}
	throw new Error(`Unsupported cron shape: ${expression}`);
}

describe("the reconciliation schedule's three interlocked numbers", () => {
	it("fires hourly", () => {
		expect(cronIntervalMs(PUBLISHING_RECONCILE_CRON_SCHEDULE)).toBe(
			60 * 60_000,
		);
	});

	it("terminates a wedged run BEFORE the next trigger fires", () => {
		// The ordering of two events, not merely the existence of a timeout.
		// overlap: "SKIP" is safe only because of this inequality: a run that
		// outlived the interval would swallow every subsequent trigger, and the
		// schedule would go quiet exactly when it was needed.
		expect(PUBLISHING_RECONCILE_EXECUTION_TIMEOUT_MS).toBeLessThan(
			cronIntervalMs(PUBLISHING_RECONCILE_CRON_SCHEDULE),
		);
	});

	it("leaves at least one full tick of slack, not a hair", () => {
		const interval = cronIntervalMs(PUBLISHING_RECONCILE_CRON_SCHEDULE);
		// 45 of 60 minutes. A timeout one second under the interval satisfies
		// the assertion above while leaving no room for the terminated run to be
		// cleaned up before the next one starts.
		expect(
			interval - PUBLISHING_RECONCILE_EXECUTION_TIMEOUT_MS,
		).toBeGreaterThanOrEqual(10 * 60_000);
	});

	it("catches up by one tick, not by a backlog", () => {
		expect(PUBLISHING_RECONCILE_CATCHUP_WINDOW).toBe("1 hour");
	});
});

describe("the schedule and the worker cannot disagree on the task queue", () => {
	const workerSource = readFileSync(
		join(__dirname, "..", "..", "src", "worker.ts"),
		"utf8",
	);

	it("takes the queue name from the schedule module instead of copying it", () => {
		// A schedule pointing at a queue nothing polls produces workflows that
		// queue up in Temporal forever with nothing red anywhere.
		//
		// This used to compare two independent string literals across the two
		// files, justified by a claim that the worker could not import the
		// schedule module without pulling the client in. That claim was false —
		// worker.ts imported `registerSystemSchedules` from "./schedules"
		// directly until the commit that added this suite moved the call into
		// worker-startup.ts, and it still reaches schedules.ts through it. The
		// comparison did discriminate, but on source TEXT: hoisting the name
		// into a local const reddened it with the behaviour unchanged, and a
		// computed queue name was invisible to it.
		//
		// So the two are made identical BY CONSTRUCTION instead: worker.ts
		// imports the constant. Measured before making the change, not assumed
		// — worker.ts's static import graph (617 modules) already contains
		// src/schedules.ts via worker-startup.ts, and schedules.ts's own graph
		// (7 modules) contains no worker module, so the import adds neither a
		// module to the worker process's load graph nor a cycle.
		//
		// What is left to assert is that the construction is still in place, and
		// the assertions are chosen to survive refactors that change nothing.
		// `toContain("taskQueue: PUBLISHING_RECONCILE_TASK_QUEUE")` was written
		// first and rejected on measurement: hoisting the name into a local
		// const reddened it — the same false alarm as the literal comparison it
		// replaced, which is what trains the next reader to weaken the case.
		//
		// So: the constant is imported, it is referenced at least once beyond
		// the import binding, and no `taskQueue:` in the file is handed the
		// queue as a bare string. A hoist keeps all three true. Reverting to a
		// copied literal breaks the last two.
		expect(workerSource).toMatch(
			/import\s*\{[^}]*\bPUBLISHING_RECONCILE_TASK_QUEUE\b[^}]*\}\s*from\s*"\.\/schedules"/,
		);
		expect(
			workerSource.match(/\bPUBLISHING_RECONCILE_TASK_QUEUE\b/g)
				?.length ?? 0,
		).toBeGreaterThanOrEqual(2);
		expect(workerSource).not.toMatch(
			new RegExp(`taskQueue:\\s*"${PUBLISHING_RECONCILE_TASK_QUEUE}"`),
		);
		// RESIDUAL, named rather than left to be discovered: a queue handed a
		// MISTYPED literal — `"publishing-reconcil"` — passes all three, and no
		// other case in this file sees it either. Nothing short of resolving the
		// expression would, and once the property takes an identifier, typing a
		// string there is a deliberate act rather than the slip this guards.
	});

	it("gives that queue its own activity-slot budget", () => {
		// Slots feed applyDatabasePoolBudget(); a queue with no key would poll
		// with the SDK default and size the pool from a total that does not
		// include it.
		expect(workerSource).toMatch(/publishingReconcile:\s*\d+/);
		expect(workerSource).toContain("ACTIVITY_SLOTS.publishingReconcile");
	});

	it("adds the worker to the drain list", () => {
		// activeWorkers is what the SIGTERM handler drains and what
		// workersRunning awaits. A worker created but not listed is one that is
		// never awaited and never drained.
		expect(workerSource).toContain("publishingReconcileWorker,");
	});

	it("pins the two identifiers a create-only registration freezes", () => {
		// NOT a check against the runbook — that private assertion lives in
		// schedule-and-queue.ops.test.ts. This one reads no file at all: a
		// markdown page cannot import a TypeScript constant, so the two are bound
		// by a grep or by nothing. What this case does is pin the two values `create()`
		// writes once and never revisits.
		//
		// Editing either changes NEW environments only. A changed schedule id
		// orphans the registered schedule — the old one keeps firing, the new
		// one is created beside it. A changed queue name is quieter and worse:
		// every worker polls the new queue while the registered schedule still
		// targets the old one, so the sweep simply stops running and the only
		// symptom is the absence of a log line. Both are unfixable by redeploy;
		// see the register function's doc-comment.
		expect(PUBLISHING_RECONCILE_SCHEDULE_ID).toBe(
			"publishing-notification-reconcile",
		);
		expect(PUBLISHING_RECONCILE_TASK_QUEUE).toBe("publishing-reconcile");
	});
});
