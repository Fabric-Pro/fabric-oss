/**
 * The query observer must be TRANSPARENT, because it now sits in front of every
 * Prisma call in the process — including the audit-log seal job's own reads.
 *
 * ## Why this is a sealing test and not just a tidiness test
 *
 * A seal's `contentHash` is a fold over the rows `readWindowPage` returns for a
 * window, and `verifySealAgainstContent` treats a later mismatch as tampering. So
 * if the observer ever converted a FAILED read into an empty result, the seal job
 * would fold over zero rows, write a seal claiming to cover a window it never
 * read, and the tamper-evidence property would be silently destroyed — the seal
 * would verify today and disagree with the rows forever after.
 *
 * Nothing about that failure would be loud. It is the exact shape of the `$use`
 * bug this observer replaced: a mechanism that appears installed and does the
 * wrong thing quietly.
 *
 * The three properties below are what make the observer safe to have in that
 * path. They are cheap to assert and expensive to lose.
 */

import { describe, expect, it, vi } from "vitest";
import {
	bufferSpan,
	instrumentPrismaQuery,
	runWithRequestSpanContext,
} from "../request-span";

const SPAN_CONTEXT = {
	correlationId: "req_seal_safety",
	organizationId: null as string | null,
	userId: null as string | null,
};

/** The shape `readWindowPage` would get back for a sealing window. */
const ROWS = [
	{ id: "a", createdAt: new Date("2026-08-01T00:00:00.000Z") },
	{ id: "b", createdAt: new Date("2026-08-01T00:00:01.000Z") },
];

describe("the observer returns exactly what the query returned", () => {
	it("passes rows through unchanged inside a span frame", async () => {
		const query = vi.fn().mockResolvedValue(ROWS);

		const result = await runWithRequestSpanContext(SPAN_CONTEXT, () =>
			instrumentPrismaQuery({
				model: "AuditLog",
				operation: "findMany",
				args: { where: { createdAt: { gte: new Date(0) } } },
				query,
			}),
		);

		// Identity, not deep equality: the seal folds over these exact objects.
		expect(result).toBe(ROWS);
	});

	it("passes rows through unchanged with NO span frame (the fast path)", async () => {
		const query = vi.fn().mockResolvedValue(ROWS);

		const result = await instrumentPrismaQuery({
			model: "AuditLog",
			operation: "findMany",
			args: {},
			query,
		});

		expect(result).toBe(ROWS);
	});

	it("forwards the args object by identity, so a window filter cannot be altered", async () => {
		// If the observer rewrote `where`, a seal could cover a different window
		// than the one it records in its header.
		const args = { where: { createdAt: { gte: new Date("2026-08-01") } } };
		const query = vi.fn().mockResolvedValue([]);

		await runWithRequestSpanContext(SPAN_CONTEXT, () =>
			instrumentPrismaQuery({
				model: "AuditLog",
				operation: "findMany",
				args,
				query,
			}),
		);

		expect(query).toHaveBeenCalledTimes(1);
		expect(query.mock.calls[0]?.[0]).toBe(args);
	});
});

describe("a failed read must NEVER look like an empty one", () => {
	// The property that protects the seal chain. An empty result is a legitimate
	// answer ("no rows in this window"); a swallowed error is a lie that makes the
	// seal cover nothing while claiming otherwise.
	it("propagates the rejection instead of returning []", async () => {
		const boom = new Error("connection terminated unexpectedly");
		const query = vi.fn().mockRejectedValue(boom);

		await expect(
			runWithRequestSpanContext(SPAN_CONTEXT, () =>
				instrumentPrismaQuery({
					model: "AuditLog",
					operation: "findMany",
					args: {},
					query,
				}),
			),
		).rejects.toBe(boom);
	});

	it("propagates the rejection on the no-frame fast path too", async () => {
		const boom = new Error("connection terminated unexpectedly");

		await expect(
			instrumentPrismaQuery({
				model: "AuditLog",
				operation: "findMany",
				args: {},
				query: vi.fn().mockRejectedValue(boom),
			}),
		).rejects.toBe(boom);
	});

	it("keeps an empty result distinguishable from a failure", async () => {
		// Both are observable; neither is silently converted into the other.
		const empty = await runWithRequestSpanContext(SPAN_CONTEXT, () =>
			instrumentPrismaQuery({
				model: "AuditLog",
				operation: "findMany",
				args: {},
				query: vi.fn().mockResolvedValue([]),
			}),
		);
		expect(empty).toEqual([]);
	});
});

describe("span bookkeeping cannot break the query it observes", () => {
	// The span is recorded in a `finally`. A throw from there would replace the
	// query's result — or mask its error — which is why bufferSpan swallows.
	it("bufferSpan never throws, even on a hostile span object", () => {
		const hostile = {
			kind: "db" as const,
			get name(): string {
				throw new Error("exploding getter");
			},
			startedAt: new Date(),
			durationMs: 0,
			status: "ok" as const,
			errorMessage: null,
		};

		expect(() => bufferSpan(hostile as never)).not.toThrow();
	});

	it("bufferSpan outside a frame is a no-op rather than an error", () => {
		expect(() =>
			bufferSpan({
				kind: "db",
				name: "AuditLog.findMany",
				startedAt: new Date(),
				durationMs: 1,
				status: "ok",
				errorMessage: null,
			}),
		).not.toThrow();
	});

	it("still returns the rows when the span frame is already drained", async () => {
		// `drained` is the post-flush state. A read after that point must behave
		// like any other read — the retention and seal jobs are long-running.
		const query = vi.fn().mockResolvedValue(ROWS);
		const result = await runWithRequestSpanContext(
			SPAN_CONTEXT,
			async () => {
				return instrumentPrismaQuery({
					model: "AuditLog",
					operation: "findMany",
					args: {},
					query,
				});
			},
		);
		expect(result).toBe(ROWS);
	});
});
