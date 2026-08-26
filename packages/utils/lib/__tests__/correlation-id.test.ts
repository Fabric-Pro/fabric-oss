import { describe, expect, it } from "vitest";
import {
	generateCorrelationId,
	getCorrelationIdFromContext,
	runWithCorrelationId,
} from "../correlation-id";

describe("generateCorrelationId", () => {
	it("returns a string starting with 'req_'", () => {
		const id = generateCorrelationId();
		expect(id).toMatch(/^req_[a-z0-9]+_[a-z0-9]+$/);
	});

	it("generates unique IDs on successive calls", () => {
		const id1 = generateCorrelationId();
		const id2 = generateCorrelationId();
		expect(id1).not.toBe(id2);
	});
});

describe("getCorrelationIdFromContext", () => {
	it("returns undefined when no context is active", () => {
		expect(getCorrelationIdFromContext()).toBeUndefined();
	});

	it("returns the correlation ID inside runWithCorrelationId", () => {
		const testId = "req_test123_abc";
		runWithCorrelationId(testId, () => {
			expect(getCorrelationIdFromContext()).toBe(testId);
		});
	});

	it("returns undefined after runWithCorrelationId completes", () => {
		runWithCorrelationId("req_temp_123", () => {
			// inside context
		});
		expect(getCorrelationIdFromContext()).toBeUndefined();
	});
});

describe("runWithCorrelationId", () => {
	it("returns the value from the wrapped function", () => {
		const result = runWithCorrelationId("req_test_123", () => 42);
		expect(result).toBe(42);
	});

	it("supports async functions", async () => {
		const result = await runWithCorrelationId("req_test_123", async () => {
			const id = getCorrelationIdFromContext();
			return id;
		});
		expect(result).toBe("req_test_123");
	});

	it("supports nested contexts (inner wins)", () => {
		runWithCorrelationId("outer", () => {
			expect(getCorrelationIdFromContext()).toBe("outer");
			runWithCorrelationId("inner", () => {
				expect(getCorrelationIdFromContext()).toBe("inner");
			});
			expect(getCorrelationIdFromContext()).toBe("outer");
		});
	});
});
