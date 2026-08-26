/**
 * Unit tests for the request-span buffering helpers (v2 item 4).
 *
 * Covers:
 *  - bufferSpan fills the active frame within a context.
 *  - bufferSpan no-ops outside any context.
 *  - dropSpans (success path) clears the buffer; flushSpansOnFailure
 *    becomes a no-op after a drop.
 *  - flushSpansOnFailure persists buffered spans through `db.requestSpan.createMany`.
 *  - Bounded buffer (200 by default; override via env) — extra spans are silently dropped.
 *  - instrumentPrismaQuery wraps the inner query and emits a `db` span
 *    with the model+action and elapsed time.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	createMany: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		requestSpan: {
			createMany: (...args: unknown[]) => mocks.createMany(...args),
		},
	},
	Prisma: {
		JsonNull: "DbNull" as unknown,
	},
	// flushSpansOnFailure now redacts span attributes before persisting;
	// a passthrough is equivalent for these non-sensitive test attributes.
	redactSensitiveKeys: (input: unknown) => input,
}));

vi.mock("@repo/logs", () => ({
	logger: {
		warn: vi.fn(),
		error: vi.fn(),
		info: vi.fn(),
	},
}));

import {
	__getBufferForTest,
	__isDrainedForTest,
	bufferSpan,
	dropSpans,
	flushSpansOnFailure,
	getRequestSpanContext,
	instrumentPrismaQuery,
	runWithRequestSpanContext,
} from "../request-span";

beforeEach(() => {
	mocks.createMany.mockReset();
	mocks.createMany.mockResolvedValue({ count: 0 });
});

afterEach(() => {
	delete process.env.FABRIC_REQUEST_SPAN_BUFFER_CAP;
});

describe("bufferSpan + runWithRequestSpanContext", () => {
	it("fills the active frame with spans", async () => {
		await runWithRequestSpanContext(
			{
				correlationId: "req_abc",
				organizationId: "org-1",
				userId: null,
			},
			async () => {
				bufferSpan({
					kind: "db",
					name: "User.findUnique",
					startedAt: new Date(),
					durationMs: 4,
					status: "ok",
				});
				bufferSpan({
					kind: "http_outbound",
					name: "GET https://example.com",
					startedAt: new Date(),
					durationMs: 22,
					status: "ok",
				});
				const buffer = __getBufferForTest();
				expect(buffer).toHaveLength(2);
				expect(buffer?.[0]?.kind).toBe("db");
				expect(buffer?.[1]?.kind).toBe("http_outbound");
			},
		);
	});

	it("returns the active context via getRequestSpanContext", async () => {
		await runWithRequestSpanContext(
			{
				correlationId: "req_ctx",
				organizationId: "org-2",
				userId: null,
			},
			async () => {
				const ctx = getRequestSpanContext();
				expect(ctx?.correlationId).toBe("req_ctx");
				expect(ctx?.organizationId).toBe("org-2");
			},
		);
		// Outside the frame, returns null.
		expect(getRequestSpanContext()).toBeNull();
	});

	it("no-ops outside any active frame", () => {
		bufferSpan({
			kind: "db",
			name: "X.y",
			startedAt: new Date(),
			durationMs: 1,
			status: "ok",
		});
		// __getBufferForTest returns null outside a frame.
		expect(__getBufferForTest()).toBeNull();
	});
});

describe("dropSpans + success path", () => {
	it("clears the buffer and marks the frame drained", async () => {
		await runWithRequestSpanContext(
			{
				correlationId: "req_drop",
				organizationId: null,
				userId: "u-1",
			},
			async () => {
				bufferSpan({
					kind: "db",
					name: "Org.findMany",
					startedAt: new Date(),
					durationMs: 3,
					status: "ok",
				});
				dropSpans();
				expect(__getBufferForTest()).toHaveLength(0);
				expect(__isDrainedForTest()).toBe(true);
				// flushSpansOnFailure after a drop is a no-op.
				await flushSpansOnFailure();
				expect(mocks.createMany).not.toHaveBeenCalled();
			},
		);
	});

	it("bufferSpan after drop is a no-op", async () => {
		await runWithRequestSpanContext(
			{ correlationId: "x", organizationId: null, userId: null },
			async () => {
				dropSpans();
				bufferSpan({
					kind: "db",
					name: "Late.span",
					startedAt: new Date(),
					durationMs: 1,
					status: "ok",
				});
				expect(__getBufferForTest()).toHaveLength(0);
			},
		);
	});
});

describe("flushSpansOnFailure", () => {
	it("persists the entire buffer in one batched insert", async () => {
		await runWithRequestSpanContext(
			{
				correlationId: "req_flush",
				organizationId: "org-x",
				userId: null,
			},
			async () => {
				const start1 = new Date();
				const start2 = new Date(start1.getTime() + 1);
				bufferSpan({
					kind: "db",
					name: "User.findMany",
					startedAt: start1,
					durationMs: 12,
					status: "ok",
				});
				bufferSpan({
					kind: "temporal_activity",
					name: "deploy.run",
					startedAt: start2,
					durationMs: 1500,
					status: "error",
					errorMessage: "boom",
					attributes: { workflowId: "wf-1" },
				});
				await flushSpansOnFailure();
			},
		);
		expect(mocks.createMany).toHaveBeenCalledTimes(1);
		const call = mocks.createMany.mock.calls[0]?.[0] as {
			data: Array<{
				correlationId: string;
				kind: string;
				name: string;
				status: string;
				errorMessage: string | null;
				organizationId: string | null;
				durationMs: number | null;
			}>;
		};
		expect(call.data).toHaveLength(2);
		expect(call.data[0]?.correlationId).toBe("req_flush");
		expect(call.data[0]?.organizationId).toBe("org-x");
		expect(call.data[0]?.kind).toBe("db");
		expect(call.data[0]?.name).toBe("User.findMany");
		expect(call.data[0]?.status).toBe("ok");
		expect(call.data[1]?.kind).toBe("temporal_activity");
		expect(call.data[1]?.status).toBe("error");
		expect(call.data[1]?.errorMessage).toBe("boom");
	});

	it("respects an explicit correlationId override", async () => {
		await runWithRequestSpanContext(
			{
				correlationId: "frame_id",
				organizationId: null,
				userId: null,
			},
			async () => {
				bufferSpan({
					kind: "db",
					name: "X.y",
					startedAt: new Date(),
					durationMs: 1,
					status: "ok",
				});
				await flushSpansOnFailure("override_id");
			},
		);
		const call = mocks.createMany.mock.calls[0]?.[0] as {
			data: Array<{ correlationId: string }>;
		};
		expect(call.data[0]?.correlationId).toBe("override_id");
	});

	it("is a no-op when the buffer is empty", async () => {
		await runWithRequestSpanContext(
			{
				correlationId: "req_empty",
				organizationId: null,
				userId: null,
			},
			async () => {
				await flushSpansOnFailure();
			},
		);
		expect(mocks.createMany).not.toHaveBeenCalled();
	});

	it("does not throw when the db write fails", async () => {
		mocks.createMany.mockRejectedValueOnce(new Error("db down"));
		await runWithRequestSpanContext(
			{
				correlationId: "req_fail_write",
				organizationId: null,
				userId: null,
			},
			async () => {
				bufferSpan({
					kind: "db",
					name: "X.y",
					startedAt: new Date(),
					durationMs: 1,
					status: "ok",
				});
				// Should NOT throw — span persistence is best-effort.
				await expect(flushSpansOnFailure()).resolves.not.toThrow();
			},
		);
	});
});

describe("bounded buffer", () => {
	it("drops spans beyond FABRIC_REQUEST_SPAN_BUFFER_CAP", async () => {
		process.env.FABRIC_REQUEST_SPAN_BUFFER_CAP = "3";
		await runWithRequestSpanContext(
			{
				correlationId: "req_cap",
				organizationId: null,
				userId: null,
			},
			async () => {
				for (let i = 0; i < 10; i++) {
					bufferSpan({
						kind: "db",
						name: `Span.${i}`,
						startedAt: new Date(),
						durationMs: 1,
						status: "ok",
					});
				}
				const buffer = __getBufferForTest();
				expect(buffer).toHaveLength(3);
				// The earliest spans are kept (failures are likely later).
				expect(buffer?.[0]?.name).toBe("Span.0");
				expect(buffer?.[1]?.name).toBe("Span.1");
				expect(buffer?.[2]?.name).toBe("Span.2");
			},
		);
	});
});

describe("instrumentPrismaQuery", () => {
	it("emits a db span around a successful query", async () => {
		await runWithRequestSpanContext(
			{
				correlationId: "req_db",
				organizationId: null,
				userId: null,
			},
			async () => {
				const result = await instrumentPrismaQuery({
					model: "User",
					operation: "findUnique",
					args: { where: { id: "u-1" } },
					query: async (a) => ({ ok: true, args: a }),
				});
				expect(result).toEqual({
					ok: true,
					args: { where: { id: "u-1" } },
				});
				const buffer = __getBufferForTest();
				expect(buffer).toHaveLength(1);
				expect(buffer?.[0]?.kind).toBe("db");
				expect(buffer?.[0]?.name).toBe("User.findUnique");
				expect(buffer?.[0]?.status).toBe("ok");
			},
		);
	});

	it("emits an error span when the inner query throws and re-throws unchanged", async () => {
		await runWithRequestSpanContext(
			{
				correlationId: "req_db_err",
				organizationId: null,
				userId: null,
			},
			async () => {
				await expect(
					instrumentPrismaQuery({
						model: "User",
						operation: "create",
						args: {},
						query: async () => {
							throw new Error("unique constraint");
						},
					}),
				).rejects.toThrow("unique constraint");
				const buffer = __getBufferForTest();
				expect(buffer).toHaveLength(1);
				expect(buffer?.[0]?.status).toBe("error");
				expect(buffer?.[0]?.errorMessage).toBe("unique constraint");
			},
		);
	});

	it("does not allocate when no frame is active", async () => {
		// Outside the frame the inner query still runs, but no span lands.
		const result = await instrumentPrismaQuery({
			model: "Org",
			operation: "findMany",
			args: {},
			query: async () => "x",
		});
		expect(result).toBe("x");
		expect(__getBufferForTest()).toBeNull();
	});
});
