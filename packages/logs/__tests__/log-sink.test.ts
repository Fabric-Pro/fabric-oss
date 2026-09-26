/**
 * Unit tests for `addLogSink` — the generic hook that forwards warn/error/
 * fatal log lines to an external platform without `@repo/logs` depending on
 * one (see the doc comment on `addLogSink` for the cycle it avoids).
 *
 * Verifies:
 *  - Only warn/error/fatal reach the sink; info/debug do not.
 *  - Both call conventions in this codebase are parsed (message-first,
 *    object-first).
 *  - The shared sensitive-key + value-shape redactor runs on message and
 *    properties before the sink sees them.
 *  - A trailing Error is forwarded, redacted, and never mutated.
 *  - correlationId/organizationId (stamped by the reporters registered
 *    before this one) land in the sink's `properties`.
 *  - The sink is never bypassed silently: a redaction failure drops the
 *    entry; a throwing sink never breaks the log call.
 *  - stdout output is unaffected — this reporter never mutates `entry.args`.
 */

import { runWithCorrelationId } from "@repo/utils/correlation-id";
import type { ConsolaReporter } from "consola";
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { addLogSink, type LogSinkRecord, logger } from "../lib/logger";

const originalLevel = logger.level;
beforeAll(() => {
	logger.level = 5; // verbose — see correlation-binding.test.ts for why
});
afterAll(() => {
	logger.level = originalLevel;
});

function withSink(fn: (records: LogSinkRecord[]) => void) {
	const records: LogSinkRecord[] = [];
	addLogSink((record) => records.push(record));
	// `addLogSink` has no removal handle — it is meant to be attached once,
	// for the process's whole life. Tests instead snapshot the reporter
	// count via a plain passthrough reporter added/removed around the call,
	// so a run's sink additions do not accumulate across `it` blocks.
	fn(records);
}

// `addLogSink` itself never returns a handle to remove — each call adds one
// more reporter for the rest of the suite. Reset by tracking how many
// reporters existed before this file ran and trimming back to that count
// after every test, so later tests are not double-counted by earlier sinks.
let baselineReporterCount: number;
beforeAll(() => {
	baselineReporterCount = (
		logger as unknown as { options: { reporters: ConsolaReporter[] } }
	).options.reporters.length;
});
afterEach(() => {
	const opts = (
		logger as unknown as { options: { reporters: ConsolaReporter[] } }
	).options;
	opts.reporters.length = baselineReporterCount;
});

describe("addLogSink", () => {
	it("forwards warn, error and fatal", () => {
		withSink((records) => {
			logger.warn("a warning");
			logger.error("an error");
			logger.fatal("a fatal");
			expect(records.map((r) => r.level)).toEqual([
				"warn",
				"error",
				"fatal",
			]);
		});
	});

	it("does not forward info or debug", () => {
		withSink((records) => {
			logger.info("just info");
			logger.debug("just debug");
			expect(records).toHaveLength(0);
		});
	});

	it("parses the message-first convention: logger.warn(message, meta)", () => {
		withSink((records) => {
			logger.warn("rpc.error", {
				event: "rpc.error",
				code: "BAD_REQUEST",
			});
			expect(records[0]).toMatchObject({
				level: "warn",
				message: "rpc.error",
				properties: { event: "rpc.error", code: "BAD_REQUEST" },
			});
		});
	});

	it("parses the object-first convention: logger.warn(meta, message)", () => {
		withSink((records) => {
			logger.warn(
				{ event: "redis.set-failed" },
				"[notification-cache] Redis SET failed",
			);
			expect(records[0]).toMatchObject({
				level: "warn",
				message: "[notification-cache] Redis SET failed",
				properties: { event: "redis.set-failed" },
			});
		});
	});

	it("redacts a sensitive KEY in properties before the sink sees it", () => {
		withSink((records) => {
			logger.error("login failed", { password: "s3cr3t", userId: "u_1" });
			expect(records[0]?.properties.password).toBe("[REDACTED]");
			expect(records[0]?.properties.userId).toBe("u_1");
		});
	});

	it("redacts a sensitive VALUE shape in the message text", () => {
		withSink((records) => {
			logger.warn(
				"upstream call failed: Authorization: Bearer abcdef123456789",
			);
			expect(records[0]?.message).not.toContain("abcdef123456789");
			expect(records[0]?.message).toContain("[REDACTED]");
		});
	});

	it("forwards a trailing Error, with its message redacted, without mutating it", () => {
		withSink((records) => {
			const err = new Error("lookup failed for dev@example.com");
			logger.error("db call failed", err);

			expect(records[0]?.error).toBeInstanceOf(Error);
			expect(records[0]?.error?.message).not.toContain("dev@example.com");
			// The original, still-referenced Error is untouched — other code
			// (an outer catch, an error-reporting tool) may still hold it.
			expect(err.message).toBe("lookup failed for dev@example.com");
		});
	});

	it("leaves an Error's message alone when nothing needed redacting", () => {
		withSink((records) => {
			const err = new Error("plain failure, nothing sensitive here");
			logger.error("db call failed", err);
			// Same instance when no redaction was needed — see redactError.
			expect(records[0]?.error).toBe(err);
		});
	});

	it("includes correlationId and organizationId already stamped by the earlier reporters", async () => {
		const { runWithOrganizationLogContext } = await import(
			"@repo/utils/organization-log-context"
		);
		withSink((records) => {
			runWithCorrelationId("req_sink_test", () => {
				runWithOrganizationLogContext("org_sink_test", () => {
					logger.warn("scoped warning");
				});
			});
			expect(records[0]?.properties.correlationId).toBe("req_sink_test");
			expect(records[0]?.properties.organizationId).toBe("org_sink_test");
		});
	});

	it("drops the entry rather than forwarding it when redaction fails", async () => {
		vi.doMock("@repo/utils/log-redaction", () => ({
			redactLogEntry: () => null,
			redactLogText: (text: string) => ({ text, redactionCount: 0 }),
		}));
		vi.resetModules();
		const fresh = await import("../lib/logger");
		fresh.logger.level = 5;
		const records: LogSinkRecord[] = [];
		fresh.addLogSink((record) => records.push(record));

		fresh.logger.error("would have been forwarded");

		expect(records).toHaveLength(0);
		vi.doUnmock("@repo/utils/log-redaction");
		vi.resetModules();
	});

	it("never throws into the log call when the sink itself throws", () => {
		addLogSink(() => {
			throw new Error("sink is broken");
		});
		expect(() => logger.warn("should not throw")).not.toThrow();
	});

	it("never mutates entry.args — stdout output stays unaffected", () => {
		const seen: unknown[][] = [];
		const passthrough: ConsolaReporter = {
			log: (entry) => seen.push(entry.args),
		};
		// Registered AFTER the sink, so it sees whatever the sink's reporter
		// left behind.
		addLogSink(() => {});
		logger.addReporter(passthrough);
		try {
			const meta = { foo: "bar" };
			logger.warn("untouched message", meta);
			expect(seen[0]).toEqual(["untouched message", { foo: "bar" }]);
			// Same object reference — the sink reporter built its own copy
			// rather than rewriting the one the call site passed in.
			expect(seen[0]?.[1]).toBe(meta);
		} finally {
			logger.removeReporter(passthrough);
		}
	});
});
