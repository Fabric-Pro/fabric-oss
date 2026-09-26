/**
 * Verifies `@repo/logs`' logger and sink registry are process-wide
 * singletons on `globalThis`, not module-scoped state.
 *
 * Bundlers (Next/Turbopack in particular) can compile this module into more
 * than one module/chunk instance for one running process —
 * `apps/web/instrumentation.ts`'s `register()` and an API route handler
 * observably ended up with separate instances in staging, which is why
 * `addLogSink` calls made from `register()` never reached the logger the
 * route handlers actually logged through, and App Insights received zero
 * records despite the sink being wired up and the SDK itself working.
 *
 * `vi.resetModules()` clears vitest's module cache but never touches
 * `globalThis` — the exact shape of that bug — so it is the direct
 * regression test for the fix: `logger` and the sink registry must come
 * back identical, and reporters/sinks must never be duplicated, across a
 * re-evaluation.
 */
import type { ConsolaReporter } from "consola";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const LOGGER_KEY = Symbol.for("fabric.repo-logs.logger");
const SINKS_KEY = Symbol.for("fabric.repo-logs.log-sinks");

function reporterCount(instance: unknown): number {
	return (
		instance as unknown as { options: { reporters: ConsolaReporter[] } }
	).options.reporters.length;
}

describe("@repo/logs process-wide singleton", () => {
	beforeEach(() => {
		vi.resetModules();
	});

	afterEach(() => {
		// Leave a clean slate for other test files in this suite (and for
		// log-sink.test.ts's own baseline reporter-count expectations).
		const g = globalThis as Record<PropertyKey, unknown>;
		delete g[LOGGER_KEY];
		delete g[SINKS_KEY];
	});

	it("returns the same logger instance across a module re-evaluation", async () => {
		const first = await import("../lib/logger");
		vi.resetModules();
		const second = await import("../lib/logger");

		expect(second.logger).toBe(first.logger);
	});

	it("never adds a duplicate reporter set when the module is re-evaluated", async () => {
		const first = await import("../lib/logger");
		const countAfterFirst = reporterCount(first.logger);

		vi.resetModules();
		const second = await import("../lib/logger");
		const countAfterSecond = reporterCount(second.logger);

		expect(countAfterSecond).toBe(countAfterFirst);

		// And a third evaluation for good measure — this is the count that
		// would grow without bound under the old per-module-instance design.
		vi.resetModules();
		const third = await import("../lib/logger");
		expect(reporterCount(third.logger)).toBe(countAfterFirst);
	});

	it("delivers a sink added via one module instance to a log call made via another", async () => {
		const first = await import("../lib/logger");
		first.logger.level = 5; // verbose — guarantee reporters fire

		const received: string[] = [];
		first.addLogSink((record) => received.push(record.message));

		vi.resetModules();
		const second = await import("../lib/logger");
		second.logger.warn("from the re-evaluated instance");

		expect(received).toEqual(["from the re-evaluated instance"]);
	});

	it("replaces rather than duplicates a sink re-added under the same id, even across a re-evaluation", async () => {
		const first = await import("../lib/logger");
		first.logger.level = 5;

		let firstSinkCalls = 0;
		first.addLogSink(() => {
			firstSinkCalls++;
		}, "shared-id");

		vi.resetModules();
		const second = await import("../lib/logger");
		let secondSinkCalls = 0;
		second.addLogSink(() => {
			secondSinkCalls++;
		}, "shared-id");

		// Logging through `first`'s own logger reference is the distinguishing
		// case: it only proves the id-based replace is real, rather than each
		// module instance quietly keeping its own separate registry, if the
		// FIRST instance's logger call now reaches the SECOND (replacing)
		// sink — which requires `first.logger` and `second.logger` to already
		// be the same shared object (see the first test in this file).
		first.logger.warn("one record, one delivery, via either reference");

		expect(firstSinkCalls).toBe(0);
		expect(secondSinkCalls).toBe(1);
	});

	it("keeps two distinct anonymous sinks (no id) both delivering", async () => {
		const first = await import("../lib/logger");
		first.logger.level = 5;

		const receivedByFirst: string[] = [];
		first.addLogSink((record) => receivedByFirst.push(record.message));

		vi.resetModules();
		const second = await import("../lib/logger");
		const receivedBySecond: string[] = [];
		second.addLogSink((record) => receivedBySecond.push(record.message));

		second.logger.warn("broadcast to every sink");

		expect(receivedByFirst).toEqual(["broadcast to every sink"]);
		expect(receivedBySecond).toEqual(["broadcast to every sink"]);
	});
});
