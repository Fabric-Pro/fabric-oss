/**
 * Real-Postgres proof for `recordWorkflowRunStarted`: what moves `updatedAt`
 * is Postgres applying Prisma's `@updatedAt` on a real write, which a mocked
 * client cannot show.
 *
 * Self-skips when DATABASE_URL is unset or is the CI placeholder.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasReachableDatabaseUrl } from "../../../../__tests__/_helpers/db-availability";
import { db, Prisma, type WorkflowExecutionStatus } from "../../../client";
import { recordWorkflowRunStarted } from "../executions";

const RUN_ID = `${Date.now()}-${process.pid}`;
const USER_ID = `test-last-run-user-${RUN_ID}`;
const EDITED_AT = new Date("2026-01-01T00:00:00.000Z");

describe.skipIf(!hasReachableDatabaseUrl())(
	"recordWorkflowRunStarted (real Postgres)",
	() => {
		beforeAll(async () => {
			const now = new Date();
			await db.$executeRaw(Prisma.sql`
				INSERT INTO "user" (id, name, email, "emailVerified", "onboardingComplete", "createdAt", "updatedAt")
				VALUES (${USER_ID}, ${"Last Run User"}, ${`${USER_ID}@test.com`}, true, false, ${now}, ${now})
				ON CONFLICT (id) DO NOTHING
			`);
		});

		afterAll(async () => {
			await db.workflowExecution.deleteMany({
				where: { userId: USER_ID },
			});
			await db.workflow.deleteMany({ where: { userId: USER_ID } });
			await db.user.deleteMany({ where: { id: USER_ID } });
		});

		async function seed(
			status: WorkflowExecutionStatus,
			lastRunAt: Date | null = null,
		) {
			const workflow = await db.workflow.create({
				data: {
					name: "Last run",
					nodes: [],
					edges: [],
					userId: USER_ID,
					lastRunAt,
				},
			});
			// Pin updatedAt to a known past value so any bump is visible.
			await db.$executeRaw`UPDATE "workflow" SET "updatedAt" = ${EDITED_AT} WHERE "id" = ${workflow.id}`;
			const execution = await db.workflowExecution.create({
				data: {
					workflowId: workflow.id,
					version: 1,
					triggerType: "MANUAL",
					userId: USER_ID,
					status,
				},
			});
			return { workflowId: workflow.id, executionId: execution.id };
		}

		async function readWorkflow(id: string) {
			return await db.workflow.findUniqueOrThrow({
				where: { id },
				select: { lastRunAt: true, updatedAt: true },
			});
		}

		// PENDING: a scheduled run, which no starter advances. RUNNING: a reserved
		// start, where `markExecutionRunningIfPending` wrote before the activity.
		it.each<WorkflowExecutionStatus>(["PENDING", "RUNNING"])(
			"stamps a %s execution's workflow without touching updatedAt",
			async (status) => {
				const { workflowId, executionId } = await seed(status);
				const startedAt = new Date("2026-10-17T12:00:00.000Z");

				await expect(
					recordWorkflowRunStarted({ executionId, startedAt }),
				).resolves.toBe(1);
				expect(await readWorkflow(workflowId)).toEqual({
					lastRunAt: startedAt,
					updatedAt: EDITED_AT,
				});

				// An activity retry carries the same workflow-time startedAt.
				await expect(
					recordWorkflowRunStarted({ executionId, startedAt }),
				).resolves.toBe(0);
			},
		);

		it.each<WorkflowExecutionStatus>(["CANCELLED", "FAILED", "COMPLETED"])(
			"skips a %s execution",
			async (status) => {
				const { workflowId, executionId } = await seed(status);

				await expect(
					recordWorkflowRunStarted({
						executionId,
						startedAt: new Date(),
					}),
				).resolves.toBe(0);
				expect((await readWorkflow(workflowId)).lastRunAt).toBeNull();
			},
		);

		it("never moves lastRunAt backwards", async () => {
			const later = new Date("2026-10-17T12:00:00.000Z");
			const { workflowId, executionId } = await seed("PENDING", later);

			await expect(
				recordWorkflowRunStarted({
					executionId,
					startedAt: new Date("2026-10-16T12:00:00.000Z"),
				}),
			).resolves.toBe(0);
			expect((await readWorkflow(workflowId)).lastRunAt).toEqual(later);
		});

		it("matches nothing for an execution without a workflow", async () => {
			const execution = await db.workflowExecution.create({
				data: {
					version: 1,
					triggerType: "MANUAL",
					userId: USER_ID,
					status: "PENDING",
				},
			});

			await expect(
				recordWorkflowRunStarted({
					executionId: execution.id,
					startedAt: new Date(),
				}),
			).resolves.toBe(0);
		});
	},
);
