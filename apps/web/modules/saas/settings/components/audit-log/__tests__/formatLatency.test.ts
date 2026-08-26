/**
 * Pure unit tests for the latency formatter used in the audit-log table.
 */

import { describe, expect, it } from "vitest";
import { formatLatency } from "../AuditLogTable";

describe("formatLatency (item 20)", () => {
	it("returns '—' for null / undefined / negative / non-finite values", () => {
		expect(formatLatency(null)).toBe("—");
		expect(formatLatency(undefined)).toBe("—");
		expect(formatLatency(-1)).toBe("—");
		expect(formatLatency(Number.NaN)).toBe("—");
		expect(formatLatency(Number.POSITIVE_INFINITY)).toBe("—");
	});

	it("renders sub-second values in milliseconds", () => {
		expect(formatLatency(0)).toBe("0ms");
		expect(formatLatency(12)).toBe("12ms");
		expect(formatLatency(999)).toBe("999ms");
	});

	it("renders >= 1s values as seconds with one decimal", () => {
		expect(formatLatency(1000)).toBe("1.0s");
		expect(formatLatency(1234)).toBe("1.2s");
		expect(formatLatency(54000)).toBe("54.0s");
	});
});
