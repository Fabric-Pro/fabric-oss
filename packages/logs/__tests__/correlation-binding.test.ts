/**
 * Unit tests for the AsyncLocalStorage-aware logger reporter that auto-
 * binds `correlationId` into every server-side log entry.
 *
 * Verifies:
 *  - Entries emitted inside `runWithCorrelationId` carry correlationId.
 *  - Entries outside any correlation context have no correlationId.
 *  - The reporter never overwrites an explicit caller-supplied
 *    correlationId.
 *  - Reporter errors never crash the original log call.
 */

import { runWithCorrelationId } from "@repo/utils/correlation-id";
import type { ConsolaReporter } from "consola";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { logger } from "../lib/logger";

interface CapturedEntry {
	args: unknown[];
	type: string;
}

// consola defaults to level=3 (info) only when the build target is "dev".
// In Node/test it can default to 0 (errors only). Raise to verbose for the
// duration of these tests so every log call invokes reporters.
const originalLevel = logger.level;
beforeAll(() => {
	logger.level = 5; // verbose
});
afterAll(() => {
	logger.level = originalLevel;
});

function withTestReporter(fn: (captured: CapturedEntry[]) => void) {
	const captured: CapturedEntry[] = [];
	const sink: ConsolaReporter = {
		log: (entry) => {
			captured.push({
				args: [...entry.args],
				type: entry.type,
			});
		},
	};
	logger.addReporter(sink);
	try {
		fn(captured);
	} finally {
		logger.removeReporter(sink);
	}
}

describe("logger correlation auto-binding", () => {
	it("stamps correlationId on entries emitted inside runWithCorrelationId", () => {
		withTestReporter((captured) => {
			runWithCorrelationId("req_logger_test_1", () => {
				logger.info("[Test] inside context", { foo: "bar" });
			});

			const entry = captured.find((e) =>
				e.args.some(
					(a) =>
						typeof a === "string" && a.includes("inside context"),
				),
			);
			expect(entry).toBeDefined();
			const meta = entry?.args.find(
				(a) =>
					typeof a === "object" &&
					a !== null &&
					!Array.isArray(a) &&
					"foo" in (a as Record<string, unknown>),
			) as Record<string, unknown> | undefined;
			expect(meta).toBeDefined();
			expect(meta?.correlationId).toBe("req_logger_test_1");
			expect(meta?.foo).toBe("bar");
		});
	});

	it("emits no correlationId when called outside a context", () => {
		withTestReporter((captured) => {
			logger.info("[Test] outside context", { fizz: "buzz" });

			const entry = captured.find((e) =>
				e.args.some(
					(a) =>
						typeof a === "string" && a.includes("outside context"),
				),
			);
			expect(entry).toBeDefined();
			const meta = entry?.args.find(
				(a) =>
					typeof a === "object" &&
					a !== null &&
					!Array.isArray(a) &&
					"fizz" in (a as Record<string, unknown>),
			) as Record<string, unknown> | undefined;
			expect(meta).toBeDefined();
			expect(meta?.correlationId).toBeUndefined();
		});
	});

	it("preserves an explicit caller-supplied correlationId", () => {
		withTestReporter((captured) => {
			runWithCorrelationId("req_ambient", () => {
				logger.info("[Test] explicit override", {
					correlationId: "req_caller_override",
					payload: 42,
				});
			});

			const entry = captured.find((e) =>
				e.args.some(
					(a) =>
						typeof a === "string" &&
						a.includes("explicit override"),
				),
			);
			const meta = entry?.args.find(
				(a) =>
					typeof a === "object" &&
					a !== null &&
					!Array.isArray(a) &&
					"payload" in (a as Record<string, unknown>),
			) as Record<string, unknown> | undefined;
			expect(meta?.correlationId).toBe("req_caller_override");
			expect(meta?.payload).toBe(42);
		});
	});

	it("appends a fresh meta object when no trailing object exists", () => {
		withTestReporter((captured) => {
			runWithCorrelationId("req_no_meta", () => {
				logger.info("[Test] no trailing meta");
			});

			const entry = captured.find((e) =>
				e.args.some(
					(a) =>
						typeof a === "string" && a.includes("no trailing meta"),
				),
			);
			expect(entry).toBeDefined();
			// The reporter appended a `{correlationId: ...}` object.
			const meta = entry?.args.find(
				(a) =>
					typeof a === "object" &&
					a !== null &&
					!Array.isArray(a) &&
					"correlationId" in (a as Record<string, unknown>),
			) as Record<string, unknown> | undefined;
			expect(meta).toBeDefined();
			expect(meta?.correlationId).toBe("req_no_meta");
		});
	});

	it("does not crash if Error objects are the trailing arg", () => {
		withTestReporter(() => {
			runWithCorrelationId("req_error", () => {
				// Errors should NOT be treated as meta objects.
				// The reporter must append a new {correlationId} arg, not
				// mutate the Error instance.
				const err = new Error("boom");
				expect(() => logger.error("[Test] err", err)).not.toThrow();
				// Critically, the error itself was not mutated:
				expect(
					(err as unknown as { correlationId?: string })
						.correlationId,
				).toBeUndefined();
			});
		});
	});
});
