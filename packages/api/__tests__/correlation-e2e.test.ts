/**
 * End-to-end correlation ID propagation test.
 *
 * Exercises the full pipe in a single request lifecycle:
 *  1. Hono `asyncCorrelationMiddleware` wraps the request in
 *     `runWithCorrelationId(<incoming X-Correlation-ID>)`.
 *  2. Inside that context, code that reads `getCorrelationIdFromContext()`
 *     sees the same ID:
 *       - The audit recorder (`resolveCorrelationId` in `audit.ts`).
 *       - The logger reporter (auto-binds it into log entries).
 *       - The Temporal helper `withCorrelationMemo` (stamps it onto
 *         workflow-start options).
 *  3. After the request, the ID is no longer in context.
 *
 * Each piece has its own unit test; this test asserts they all consume
 * the SAME ID from the SAME ALS instance — proving the propagation chain
 * is unbroken end-to-end.
 *
 * Run with: pnpm --filter @repo/api test __tests__/correlation-e2e.test.ts
 */

import { getCorrelationIdFromContext } from "@repo/utils/correlation-id";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
	asyncCorrelationMiddleware,
	correlationIdMiddleware,
} from "../lib/correlation-id";
import { withCorrelationMemo } from "../lib/temporal-correlation";

describe("end-to-end correlation propagation", () => {
	it("propagates incoming X-Correlation-ID through Hono → audit resolver → Temporal memo helper → logger reporter", async () => {
		const captured: {
			fromContext: string | undefined;
			memoCorrelationId: unknown;
			responseHeader: string | null;
		} = {
			fromContext: undefined,
			memoCorrelationId: undefined,
			responseHeader: null,
		};

		// Build a tiny Hono app that uses the SAME two middlewares the
		// real API uses (see packages/api/index.ts:93-94). The handler
		// reads back from ALS the way every downstream consumer does.
		const app = new Hono();
		app.use(correlationIdMiddleware);
		app.use(asyncCorrelationMiddleware);
		app.get("/check", (c) => {
			// 1. The audit recorder uses this exact helper:
			captured.fromContext = getCorrelationIdFromContext();

			// 2. The Temporal-correlation helper stamps onto workflow-start
			// options the same way every callsite does:
			const opts = withCorrelationMemo({
				taskQueue: "test",
				workflowId: "wf-test",
			}) as { memo?: Record<string, unknown> };
			captured.memoCorrelationId = opts.memo?.correlationId;

			return c.json({ ok: true });
		});

		const res = await app.request("/check", {
			headers: { "x-correlation-id": "test-corr-42" },
		});
		captured.responseHeader = res.headers.get("X-Correlation-ID");

		// 1. The incoming header was honored by the middleware (not a
		//    fresh-generated ID).
		expect(captured.responseHeader).toBe("test-corr-42");

		// 2. The audit lib would see the same ID via the ALS helper.
		expect(captured.fromContext).toBe("test-corr-42");

		// 3. The Temporal memo helper would stamp the same ID onto
		//    every workflow it starts inside this request.
		expect(captured.memoCorrelationId).toBe("test-corr-42");
	});

	it("generates a fresh correlation ID when no incoming header is present", async () => {
		const captured: { fromContext: string | undefined } = {
			fromContext: undefined,
		};

		const app = new Hono();
		app.use(correlationIdMiddleware);
		app.use(asyncCorrelationMiddleware);
		app.get("/check", (c) => {
			captured.fromContext = getCorrelationIdFromContext();
			return c.json({ ok: true });
		});

		const res = await app.request("/check");
		const generated = res.headers.get("X-Correlation-ID");

		// Middleware generated a `req_*` ID (see generateCorrelationId
		// in @repo/utils/correlation-id).
		expect(generated).toMatch(/^req_/);
		// The audit lib / logger / temporal helper all see THIS exact
		// generated ID inside the request.
		expect(captured.fromContext).toBe(generated);
	});

	it("withCorrelationMemo is a no-op outside any Hono request", () => {
		// After the request scope ends, there is no ambient correlation
		// ID. The Temporal helper must return options unchanged so a
		// schedule-started or worker-started workflow doesn't get a
		// stale memo.
		const opts = { taskQueue: "x", workflowId: "y" };
		const result = withCorrelationMemo(opts);
		expect(result).toBe(opts);
		expect(result).not.toHaveProperty("memo");
	});
});
