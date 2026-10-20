/**
 * Shape of `recordWorkflowRunStarted` (the `Workflow.lastRunAt` stamp).
 *
 * No Postgres here, so this pins the statement instead: one parameterised raw
 * UPDATE, never a Prisma client update (which would bump `@updatedAt`), keyed
 * through the execution so a pipeline run without a workflow matches nothing,
 * guarded on a live (PENDING or RUNNING) execution and on never moving
 * backwards. The sibling
 * `.integration.test.ts` proves the same behaviour against a real database.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { executeRaw, workflowUpdate, workflowUpdateMany } = vi.hoisted(() => ({
	executeRaw: vi.fn(),
	workflowUpdate: vi.fn(async () => {
		throw new Error("db.workflow.update would bump Workflow.updatedAt");
	}),
	workflowUpdateMany: vi.fn(async () => {
		throw new Error("db.workflow.updateMany would bump Workflow.updatedAt");
	}),
}));

vi.mock("../../../client", () => ({
	db: {
		$executeRaw: executeRaw,
		workflow: { update: workflowUpdate, updateMany: workflowUpdateMany },
	},
}));

import { recordWorkflowRunStarted } from "../executions";

const STARTED_AT = new Date("2026-10-17T12:00:00.000Z");

function issuedStatement(): { sql: string; values: unknown[] } {
	expect(executeRaw).toHaveBeenCalledTimes(1);
	const [strings, ...values] = executeRaw.mock.calls[0];
	return { sql: strings.join("?").replace(/\s+/g, " "), values };
}

beforeEach(() => {
	vi.clearAllMocks();
	executeRaw.mockResolvedValue(1);
});

describe("recordWorkflowRunStarted", () => {
	it("issues one parameterised UPDATE of lastRunAt and nothing else", async () => {
		await expect(
			recordWorkflowRunStarted({
				executionId: "exec-1",
				startedAt: STARTED_AT,
			}),
		).resolves.toBe(1);

		const { sql, values } = issuedStatement();
		expect(sql).toContain('UPDATE "workflow" AS w SET "lastRunAt" = ?');
		expect(sql).not.toContain("updatedAt");
		expect(values).toEqual([STARTED_AT, "exec-1", STARTED_AT]);
		expect(workflowUpdate).not.toHaveBeenCalled();
		expect(workflowUpdateMany).not.toHaveBeenCalled();
	});

	it("reaches the workflow only through the execution's workflowId", async () => {
		await recordWorkflowRunStarted({
			executionId: "exec-1",
			startedAt: STARTED_AT,
		});

		const { sql } = issuedStatement();
		expect(sql).toContain('FROM "workflow_execution" AS e');
		expect(sql).toContain('e."id" = ?');
		expect(sql).toContain('w."id" = e."workflowId"');
	});

	it("stamps only a live (PENDING or RUNNING) execution and never moves lastRunAt backwards", async () => {
		await recordWorkflowRunStarted({
			executionId: "exec-1",
			startedAt: STARTED_AT,
		});

		const { sql } = issuedStatement();
		expect(sql).toContain(`e."status" IN ('PENDING', 'RUNNING')`);
		expect(sql).toContain('(w."lastRunAt" IS NULL OR w."lastRunAt" < ?)');
	});
});
