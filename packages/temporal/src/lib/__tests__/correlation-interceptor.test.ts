/**
 * Unit tests for the Temporal correlation propagation interceptors.
 *
 * The full FE → BE → Temporal flow is verified live in Playwright +
 * direct DB inspection; these tests pin the interceptor contracts so a
 * future refactor can't silently drop correlation propagation.
 */

import { runWithCorrelationId } from "@repo/utils/correlation-id";
import { defaultPayloadConverter } from "@temporalio/common";
import { describe, expect, it, vi } from "vitest";
import {
	CorrelationActivityInboundInterceptor,
	makeCorrelationClientInterceptor,
	TEMPORAL_CORRELATION_HEADER,
} from "../correlation-interceptor";

describe("makeCorrelationClientInterceptor", () => {
	it("attaches correlation id to workflow.start headers when one is in scope", async () => {
		const interceptor = makeCorrelationClientInterceptor();
		const next = vi.fn().mockResolvedValue("ok");
		await runWithCorrelationId("req_test_abc", async () => {
			// biome-ignore lint/style/noNonNullAssertion: tested behavior
			await interceptor.start!({ headers: {} } as never, next);
		});
		expect(next).toHaveBeenCalledTimes(1);
		const call = (
			next.mock.calls[0] as [{ headers: Record<string, unknown> }]
		)[0];
		const payload = call.headers[TEMPORAL_CORRELATION_HEADER];
		expect(payload).toBeDefined();
		const decoded = defaultPayloadConverter.fromPayload(payload as never);
		expect(decoded).toBe("req_test_abc");
	});

	it("is a no-op when no correlation id is in scope", async () => {
		const interceptor = makeCorrelationClientInterceptor();
		const next = vi.fn().mockResolvedValue("ok");
		// biome-ignore lint/style/noNonNullAssertion: tested behavior
		await interceptor.start!({ headers: { existing: "h" } } as never, next);
		expect(next).toHaveBeenCalledWith({ headers: { existing: "h" } });
	});

	it("preserves caller-supplied headers (doesn't clobber)", async () => {
		const interceptor = makeCorrelationClientInterceptor();
		const next = vi.fn().mockResolvedValue("ok");
		await runWithCorrelationId("req_keep", async () => {
			await interceptor.start!(
				{ headers: { other: "preserve-me" } } as never,
				next,
			);
		});
		const call = (
			next.mock.calls[0] as [{ headers: Record<string, unknown> }]
		)[0];
		expect(call.headers.other).toBe("preserve-me");
		expect(call.headers[TEMPORAL_CORRELATION_HEADER]).toBeDefined();
	});
});

describe("CorrelationActivityInboundInterceptor", () => {
	it("re-enters AsyncLocalStorage with the correlation id from headers", async () => {
		const interceptor = new CorrelationActivityInboundInterceptor();
		const payload = defaultPayloadConverter.toPayload("req_inbound_xyz");
		let observed: string | undefined;
		await interceptor.execute(
			{
				headers: { [TEMPORAL_CORRELATION_HEADER]: payload as never },
				args: [],
			} as never,
			(async () => {
				const { getCorrelationIdFromContext } = await import(
					"@repo/utils/correlation-id"
				);
				observed = getCorrelationIdFromContext();
				return "ok";
			}) as never,
		);
		expect(observed).toBe("req_inbound_xyz");
	});

	it("is a no-op when no correlation header is set", async () => {
		const interceptor = new CorrelationActivityInboundInterceptor();
		let observed: string | undefined = "untouched";
		await interceptor.execute(
			{ headers: {}, args: [] } as never,
			(async () => {
				const { getCorrelationIdFromContext } = await import(
					"@repo/utils/correlation-id"
				);
				observed = getCorrelationIdFromContext();
				return "ok";
			}) as never,
		);
		expect(observed).toBeUndefined();
	});

	it("survives a malformed header payload without throwing", async () => {
		const interceptor = new CorrelationActivityInboundInterceptor();
		await expect(
			interceptor.execute(
				{
					headers: {
						[TEMPORAL_CORRELATION_HEADER]: {
							not: "a payload",
						} as never,
					},
					args: [],
				} as never,
				(async () => "ok") as never,
			),
		).resolves.toBe("ok");
	});
});
