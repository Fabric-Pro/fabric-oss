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
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
	// `addLogSink` with no `id` registers an always-distinct anonymous sink
	// (a fresh Symbol per call) in the shared registry — see `singleton.test.ts`
	// for the registry's re-evaluation/idempotency guarantees. It has no
	// removal handle, so within this file sinks from earlier `it` blocks stay
	// registered; each keeps writing into its own now-unread `records` array,
	// which is harmless — every assertion below only reads the array `fn`
	// was given.
	addLogSink((record) => records.push(record));
	fn(records);
}

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
		// The logger and its sink registry are process-wide singletons on
		// `globalThis` (see `singleton.test.ts`), so a plain `vi.resetModules()`
		// + re-import would hand back the SAME logger this file already
		// imported — including its reporters, already bound to the real
		// (unmocked) `redactLogEntry`. To exercise the mocked redaction this
		// test needs a genuinely fresh logger, so it clears the shared
		// singleton's well-known `Symbol.for` slots first, forcing the next
		// import to build a new one from scratch, then restores the originals
		// afterward so later tests in this file keep using the `logger` /
		// `addLogSink` bindings captured at the top of the file.
		const g = globalThis as Record<PropertyKey, unknown>;
		const loggerKey = Symbol.for("fabric.repo-logs.logger");
		const sinksKey = Symbol.for("fabric.repo-logs.log-sinks");
		const savedLogger = g[loggerKey];
		const savedSinks = g[sinksKey];
		delete g[loggerKey];
		delete g[sinksKey];

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
		g[loggerKey] = savedLogger;
		g[sinksKey] = savedSinks;
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
