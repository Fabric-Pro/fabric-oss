/**
 * The flusher must work from OUTSIDE the frame that buffered the spans.
 *
 * `flushSpansOnFailure` read the buffer from AsyncLocalStorage. Its only caller
 * that knows the resolved tenant — `auditErrorMiddleware` — mounts OUTSIDE the
 * middleware that opens the frame (`auditTimingMiddleware`). So when a handler
 * threw, the error propagated out of the frame first, the ALS context exited,
 * `getStore()` returned undefined, and the flush returned at its first guard
 * having written nothing.
 *
 * Deterministically, on every failure. `audit.tracedRequest` advertised
 * "low-level spans (db / temporal / http)" and served an empty list — verified on
 * staging twice: a post-lookup 404 produced an error row with a correlationId and
 * a traced request with zero spans.
 *
 * This is the third defect in this family, after the `$use` guard that captured
 * nothing and the null tenant that made rows unreadable. Each one left the data
 * unreachable rather than absent, and each survived because the tests asserted
 * the layer above the break. So these assertions are on the persisted row,
 * reached through the real two-middleware sequence rather than a single call.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const createMany = vi.fn();

vi.mock("@repo/database", () => ({
	db: { requestSpan: { createMany: (...a: unknown[]) => createMany(...a) } },
	Prisma: { JsonNull: "DbNull" as unknown },
	// Omitting this makes the redactor throw inside the flush's own try/catch, so
	// the write silently never happens and the test reads as "no spans written".
	redactSensitiveKeys: (input: unknown) => input,
}));

const {
	bufferSpan,
	detachSpansForFlush,
	dropSpans,
	flushSpansOnFailure,
	runWithRequestSpanContext,
} = await import("../request-span");

const CID = "req_outside_frame";

function aSpan(name: string) {
	return {
		kind: "db" as const,
		name,
		startedAt: new Date("2026-08-08T00:00:00.000Z"),
		durationMs: 3,
		status: "error" as const,
		errorMessage: null,
	};
}

/** The real sequence: an inner frame that buffers and detaches, an outer flusher. */
async function requestThatFails(): Promise<void> {
	await runWithRequestSpanContext(
		{ correlationId: CID, organizationId: null, userId: null },
		async () => {
			bufferSpan(aSpan("AuditLog.findFirst"));
			bufferSpan(aSpan("ApiKey.findUnique"));
			// What auditTimingMiddleware does on the failure path.
			detachSpansForFlush(CID);
			throw new Error("handler failed");
		},
	).catch(() => {});

	// Now OUTSIDE the frame, which is where auditErrorMiddleware runs.
	await flushSpansOnFailure(CID, {
		organizationId: null,
		userId: "user_1",
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	createMany.mockResolvedValue({ count: 0 });
});

describe("flushing from outside the frame", () => {
	it("persists the spans the frame buffered", async () => {
		await requestThatFails();

		expect(createMany).toHaveBeenCalledTimes(1);
		expect(createMany.mock.calls[0]?.[0].data).toHaveLength(2);
	});

	it("stamps the tenant the outer caller resolved, not the frame's nulls", async () => {
		// The frame opens before auth, so its userId is null. Persisting that made
		// rows unreadable by the only surface that reads them.
		await requestThatFails();

		for (const row of createMany.mock.calls[0]?.[0].data ?? []) {
			expect(row.userId).toBe("user_1");
			expect(row.correlationId).toBe(CID);
		}
	});

	it("writes nothing twice if the flusher runs again", async () => {
		await requestThatFails();
		await flushSpansOnFailure(CID, {
			organizationId: null,
			userId: "user_1",
		});

		expect(createMany).toHaveBeenCalledTimes(1);
	});

	it("writes nothing when the request succeeded", async () => {
		// dropSpans is the success path; nothing may be left parked afterwards.
		await runWithRequestSpanContext(
			{ correlationId: CID, organizationId: null, userId: null },
			async () => {
				bufferSpan(aSpan("AuditLog.findFirst"));
				dropSpans();
			},
		);
		await flushSpansOnFailure(CID, {
			organizationId: null,
			userId: "user_1",
		});

		expect(createMany).not.toHaveBeenCalled();
	});

	it("does not cross requests", async () => {
		await requestThatFails();
		createMany.mockClear();

		// A different correlationId must not collect the first request's spans.
		await flushSpansOnFailure("req_someone_else", {
			organizationId: null,
			userId: "user_2",
		});

		expect(createMany).not.toHaveBeenCalled();
	});

	it("still works for an in-frame caller", async () => {
		// Worker paths flush from inside their own frame; that must keep working.
		await runWithRequestSpanContext(
			{
				correlationId: "req_in_frame",
				organizationId: null,
				userId: "u9",
			},
			async () => {
				bufferSpan(aSpan("AuditLog.findMany"));
				await flushSpansOnFailure();
			},
		);

		expect(createMany).toHaveBeenCalledTimes(1);
		expect(createMany.mock.calls[0]?.[0].data[0].userId).toBe("u9");
	});
});
