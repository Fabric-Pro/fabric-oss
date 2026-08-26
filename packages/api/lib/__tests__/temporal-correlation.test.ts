/**
 * Unit tests for `withCorrelationMemo`.
 *
 * Verifies that the helper:
 *  - Reads correlationId from AsyncLocalStorage.
 *  - Is a no-op when no correlation context is active.
 *  - Preserves existing memo keys and doesn't clobber caller-supplied
 *    memo.correlationId values.
 *  - Doesn't mutate the original options object (returns a new one when
 *    enriching, the same object when no-op).
 *
 * Run with: pnpm --filter @repo/api test lib/__tests__/temporal-correlation.test.ts
 */

import { runWithCorrelationId } from "@repo/utils/correlation-id";
import { describe, expect, it } from "vitest";
import { withCorrelationMemo } from "../temporal-correlation";

describe("withCorrelationMemo", () => {
	it("returns options unchanged when no correlation context is active", () => {
		const opts = {
			taskQueue: "default",
			workflowId: "wf-1",
			args: [],
		};
		const result = withCorrelationMemo(opts);
		expect(result).toBe(opts); // Same object reference
		expect(result).not.toHaveProperty("memo");
	});

	it("injects memo.correlationId when ALS is bound", () => {
		runWithCorrelationId("req_test_42", () => {
			const opts = {
				taskQueue: "default",
				workflowId: "wf-2",
				args: [],
			};
			const result = withCorrelationMemo(opts);
			expect(result.memo).toEqual({ correlationId: "req_test_42" });
			// Should preserve the other fields verbatim
			expect(result.taskQueue).toBe("default");
			expect(result.workflowId).toBe("wf-2");
		});
	});

	it("preserves existing memo keys (does not clobber other entries)", () => {
		runWithCorrelationId("req_test_99", () => {
			const opts = {
				taskQueue: "queue",
				memo: { traceId: "trace-abc", customKey: "value" },
			};
			const result = withCorrelationMemo(opts) as {
				memo: Record<string, unknown>;
				taskQueue: string;
			};
			expect(result.memo).toEqual({
				traceId: "trace-abc",
				customKey: "value",
				correlationId: "req_test_99",
			});
		});
	});

	it("does NOT overwrite a caller-supplied memo.correlationId", () => {
		runWithCorrelationId("req_outer", () => {
			const opts = {
				taskQueue: "queue",
				memo: { correlationId: "req_caller_override" },
			};
			const result = withCorrelationMemo(opts) as {
				memo: Record<string, unknown>;
			};
			expect(result.memo.correlationId).toBe("req_caller_override");
		});
	});

	it("does not mutate the original options object when injecting", () => {
		runWithCorrelationId("req_no_mut", () => {
			const opts = {
				taskQueue: "x",
				workflowId: "y",
			};
			const result = withCorrelationMemo(opts);
			// Original opts must not have gained `memo`.
			expect(opts).not.toHaveProperty("memo");
			// Result is a new object.
			expect(result).not.toBe(opts);
		});
	});

	it("works with empty options object", () => {
		runWithCorrelationId("req_empty", () => {
			const result = withCorrelationMemo({}) as {
				memo: Record<string, unknown>;
			};
			expect(result.memo).toEqual({ correlationId: "req_empty" });
		});
	});

	it("nested contexts: inner correlation ID wins", () => {
		runWithCorrelationId("outer", () => {
			const outerResult = withCorrelationMemo({ taskQueue: "q" }) as {
				memo: Record<string, unknown>;
			};
			expect(outerResult.memo.correlationId).toBe("outer");

			runWithCorrelationId("inner", () => {
				const innerResult = withCorrelationMemo({ taskQueue: "q" }) as {
					memo: Record<string, unknown>;
				};
				expect(innerResult.memo.correlationId).toBe("inner");
			});

			const afterResult = withCorrelationMemo({ taskQueue: "q" }) as {
				memo: Record<string, unknown>;
			};
			expect(afterResult.memo.correlationId).toBe("outer");
		});
	});
});
