import { describe, expect, it } from "vitest";
import {
	computeHealthCheckUpdate,
	HEALTH_FAILURE_THRESHOLD,
} from "../prisma/queries/registered-agents";

describe("computeHealthCheckUpdate", () => {
	it("resets counter and goes ACTIVE on a healthy probe", () => {
		const next = computeHealthCheckUpdate(
			{ status: "ERROR", consecutiveHealthFailures: 5 },
			true,
		);
		expect(next).toEqual({
			status: "ACTIVE",
			consecutiveHealthFailures: 0,
			lastHealthError: null,
		});
	});

	it("keeps prior status below the threshold", () => {
		const next = computeHealthCheckUpdate(
			{ status: "ACTIVE", consecutiveHealthFailures: 0 },
			false,
			"connection refused probing http://localhost:8124/health",
		);
		expect(next.status).toBe("ACTIVE");
		expect(next.consecutiveHealthFailures).toBe(1);
		expect(next.lastHealthError).toContain("connection refused");
	});

	it("flips to ERROR once the threshold is reached", () => {
		const next = computeHealthCheckUpdate(
			{
				status: "ACTIVE",
				consecutiveHealthFailures: HEALTH_FAILURE_THRESHOLD - 1,
			},
			false,
			"HTTP 503 probing http://doc-gen/health",
		);
		expect(next.status).toBe("ERROR");
		expect(next.consecutiveHealthFailures).toBe(HEALTH_FAILURE_THRESHOLD);
	});

	it("falls back to a generic reason when none is given", () => {
		const next = computeHealthCheckUpdate(
			{ status: "ACTIVE", consecutiveHealthFailures: 0 },
			false,
		);
		expect(next.lastHealthError).toBe("Health check failed");
	});
});
