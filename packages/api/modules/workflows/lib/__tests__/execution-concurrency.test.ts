/**
 * Nothing bounded how many executions a tenant could have in flight. A
 * workflow's Temporal id is unique per execution row, so the same workflow
 * could be started unboundedly in parallel and hold every slot on the shared
 * `workflow-builder` queue.
 *
 * The properties that matter: the count is scoped to the right tenant (an
 * organization's backlog must not block a personal workflow, or vice versa),
 * an organization can raise its own ceiling through the quota model that
 * already exists for agent deployments, and the row is created INSIDE the
 * reservation — the count-then-insert pair this replaced let N concurrent
 * starts at `limit - 1` all see one free slot. The atomicity itself is proved
 * against real Postgres in
 * `packages/database/__tests__/workflow-execution-reservation.integration.test.ts`;
 * here the reservation primitive is mocked and what is pinned is that every
 * decision reaches it with the right tenant, limit and row.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { reserveMock, quotaMock } = vi.hoisted(() => ({
	reserveMock: vi.fn(),
	quotaMock: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		organizationDeploymentQuota: { findUnique: quotaMock },
	},
	reserveWorkflowExecution: reserveMock,
}));

import {
	createExecutionWithinConcurrencyCap,
	FALLBACK_MAX_CONCURRENT_EXECUTIONS,
	resolveDefaultConcurrencyLimit,
} from "../execution-concurrency";

const ROW = {
	workflowId: "wf-1",
	version: 2,
	triggerType: "MANUAL" as const,
	triggerInput: { a: 1 },
};

const EXECUTION = { id: "exec-1", status: "PENDING" };

beforeEach(() => {
	vi.clearAllMocks();
	quotaMock.mockResolvedValue(null);
	reserveMock.mockImplementation(async (args: { limit: number }) => ({
		reserved: true,
		execution: EXECUTION,
		inFlight: 1,
		limit: args.limit,
	}));
});

describe("createExecutionWithinConcurrencyCap", () => {
	it("returns the row the reservation created when the tenant is below the cap", async () => {
		const result = await createExecutionWithinConcurrencyCap({
			userId: "u1",
			data: ROW,
		});

		expect(result).toEqual({
			allowed: true,
			execution: EXECUTION,
			inFlight: 1,
			limit: FALLBACK_MAX_CONCURRENT_EXECUTIONS,
		});
	});

	it("refuses — and created nothing — when the reservation reports the cap reached", async () => {
		reserveMock.mockResolvedValue({
			reserved: false,
			inFlight: FALLBACK_MAX_CONCURRENT_EXECUTIONS,
			limit: FALLBACK_MAX_CONCURRENT_EXECUTIONS,
		});

		const result = await createExecutionWithinConcurrencyCap({
			userId: "u1",
			data: ROW,
		});

		expect(result).toEqual({
			allowed: false,
			inFlight: FALLBACK_MAX_CONCURRENT_EXECUTIONS,
			limit: FALLBACK_MAX_CONCURRENT_EXECUTIONS,
		});
		expect(result).not.toHaveProperty("execution");
	});

	it("hands the reservation the row to create, so the cap and the insert are one decision", async () => {
		await createExecutionWithinConcurrencyCap({
			userId: "u1",
			organizationId: "org1",
			data: ROW,
		});

		expect(reserveMock).toHaveBeenCalledWith({
			userId: "u1",
			organizationId: "org1",
			limit: FALLBACK_MAX_CONCURRENT_EXECUTIONS,
			data: ROW,
		});
	});

	it("scopes a personal workflow to the user — organizationId stays unset for the XOR filter", async () => {
		await createExecutionWithinConcurrencyCap({ userId: "u1", data: ROW });

		expect(reserveMock.mock.calls[0][0]).toMatchObject({
			userId: "u1",
			organizationId: undefined,
		});
	});

	it("honours an organization's raised ceiling", async () => {
		quotaMock.mockResolvedValue({ maxConcurrentExecutions: 50 });

		const result = await createExecutionWithinConcurrencyCap({
			userId: "u1",
			organizationId: "org1",
			data: ROW,
		});

		expect(reserveMock.mock.calls[0][0].limit).toBe(50);
		expect(result.limit).toBe(50);
	});

	it("falls back to the default when an org has no quota row", async () => {
		quotaMock.mockResolvedValue(null);

		const result = await createExecutionWithinConcurrencyCap({
			userId: "u1",
			organizationId: "org1",
			data: ROW,
		});

		expect(result.limit).toBe(FALLBACK_MAX_CONCURRENT_EXECUTIONS);
	});

	it("does not query org quota for a personal workflow", async () => {
		await createExecutionWithinConcurrencyCap({ userId: "u1", data: ROW });

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
