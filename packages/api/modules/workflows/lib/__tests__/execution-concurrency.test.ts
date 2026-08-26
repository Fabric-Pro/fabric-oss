/**
 * Nothing bounded how many executions a tenant could have in flight. A
 * workflow's Temporal id is unique per execution row, so the same workflow
 * could be started unboundedly in parallel and hold every slot on the shared
 * `workflow-builder` queue.
 *
 * The two properties that matter: the count is scoped to the right tenant (an
 * organization's backlog must not block a personal workflow, or vice versa),
 * and an organization can raise its own ceiling through the quota model that
 * already exists for agent deployments.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { countMock, quotaMock } = vi.hoisted(() => ({
	countMock: vi.fn(),
	quotaMock: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		workflowExecution: { count: countMock },
		organizationDeploymentQuota: { findUnique: quotaMock },
	},
}));

import {
	checkExecutionConcurrency,
	FALLBACK_MAX_CONCURRENT_EXECUTIONS,
	resolveDefaultConcurrencyLimit,
} from "../execution-concurrency";

beforeEach(() => {
	vi.clearAllMocks();
	quotaMock.mockResolvedValue(null);
});

describe("checkExecutionConcurrency", () => {
	it("allows a tenant below the cap", async () => {
		countMock.mockResolvedValue(3);

		const result = await checkExecutionConcurrency({ userId: "u1" });

		expect(result).toEqual({
			allowed: true,
			inFlight: 3,
			limit: FALLBACK_MAX_CONCURRENT_EXECUTIONS,
		});
	});

	it("refuses at the cap", async () => {
		countMock.mockResolvedValue(FALLBACK_MAX_CONCURRENT_EXECUTIONS);

		const result = await checkExecutionConcurrency({ userId: "u1" });

		expect(result.allowed).toBe(false);
	});

	it("counts only work that is actually in flight", async () => {
		countMock.mockResolvedValue(0);

		await checkExecutionConcurrency({ userId: "u1" });

		const { status } = countMock.mock.calls[0][0].where;
		expect(status.in.sort()).toEqual(["PENDING", "RUNNING"]);
	});

	it("scopes a personal workflow to the user, excluding org rows", async () => {
		countMock.mockResolvedValue(0);

		await checkExecutionConcurrency({ userId: "u1" });

		// organizationId: null is the XOR half — without it a user's personal
		// count would include every execution they started inside an org.
		expect(countMock.mock.calls[0][0].where).toMatchObject({
			userId: "u1",
			organizationId: null,
		});
	});

	it("scopes an org workflow to the org, not the caller", async () => {
		countMock.mockResolvedValue(0);

		await checkExecutionConcurrency({
			userId: "u1",
			organizationId: "org1",
		});

		const { where } = countMock.mock.calls[0][0];
		expect(where).toMatchObject({ organizationId: "org1" });
		// Otherwise one member's runs would not count against the org's cap.
		expect(where.userId).toBeUndefined();
	});

	it("honours an organization's raised ceiling", async () => {
		countMock.mockResolvedValue(40);
		quotaMock.mockResolvedValue({ maxConcurrentExecutions: 50 });

		const result = await checkExecutionConcurrency({
			userId: "u1",
			organizationId: "org1",
		});

		expect(result).toEqual({ allowed: true, inFlight: 40, limit: 50 });
	});

	it("falls back to the default when an org has no quota row", async () => {
		countMock.mockResolvedValue(0);
		quotaMock.mockResolvedValue(null);

		const result = await checkExecutionConcurrency({
			userId: "u1",
			organizationId: "org1",
		});

		expect(result.limit).toBe(FALLBACK_MAX_CONCURRENT_EXECUTIONS);
	});

	it("does not query org quota for a personal workflow", async () => {
		countMock.mockResolvedValue(0);

		await checkExecutionConcurrency({ userId: "u1" });

		expect(quotaMock).not.toHaveBeenCalled();
	});
});

describe("resolveDefaultConcurrencyLimit", () => {
	const original = process.env.WORKFLOW_MAX_CONCURRENT_EXECUTIONS;
	afterEach(() => {
		if (original === undefined) {
			process.env.WORKFLOW_MAX_CONCURRENT_EXECUTIONS = undefined;
			delete process.env.WORKFLOW_MAX_CONCURRENT_EXECUTIONS;
		} else {
			process.env.WORKFLOW_MAX_CONCURRENT_EXECUTIONS = original;
		}
	});

	it("falls back when unset", () => {
		delete process.env.WORKFLOW_MAX_CONCURRENT_EXECUTIONS;
		expect(resolveDefaultConcurrencyLimit()).toBe(
			FALLBACK_MAX_CONCURRENT_EXECUTIONS,
		);
	});

	it("honours a valid override", () => {
		process.env.WORKFLOW_MAX_CONCURRENT_EXECUTIONS = "5";
		expect(resolveDefaultConcurrencyLimit()).toBe(5);
	});

	it("ignores an override that would disable the guard", () => {
		// "0" or a negative would let every execution through; a typo must not
		// silently remove the protection.
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {
			// expected
		});
		for (const bad of ["0", "-1", "abc", ""]) {
			process.env.WORKFLOW_MAX_CONCURRENT_EXECUTIONS = bad;
			expect(resolveDefaultConcurrencyLimit()).toBe(
				FALLBACK_MAX_CONCURRENT_EXECUTIONS,
			);
		}
		warn.mockRestore();
	});
});
