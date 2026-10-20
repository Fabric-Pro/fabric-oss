import { PrismaPg } from "@prisma/adapter-pg";
import { describe, expect, it } from "vitest";
import {
	Prisma,
	db as publicDb,
	type WorkflowTriggerType,
} from "../prisma/client";
import { PrismaClient } from "../prisma/generated/client";
import { backfillWorkflowLastRunAt } from "../scripts/backfill-workflow-last-run-at";
import { hasReachableDatabaseUrl } from "./_helpers/db-availability";

describe.skipIf(!hasReachableDatabaseUrl())(
	"workflow last-run backfill (real Postgres)",
	() => {
		it("bounds writes, resumes committed batches, preserves edits, and is monotonic and idempotent", async () => {
			const fixtureId = `backfill-${Date.now()}-${process.pid}`;
			const unrelatedWorkflowId = `000-unrelated-${fixtureId}`;
			const editedAt = new Date("2026-01-01T00:00:00Z");
			const older = new Date("2026-02-01T00:00:00Z");
			const startedAt = new Date("2026-03-01T00:00:00Z");
			const later = new Date("2026-04-01T00:00:00Z");
			const schema = `backfill_${Date.now()}_${process.pid}`;
			const schemaIdentifier = Prisma.raw(`"${schema}"`);
			await publicDb.$executeRaw`CREATE SCHEMA ${schemaIdentifier}`;
			const db = new PrismaClient({
				adapter: new PrismaPg(
					{
						connectionString: process.env.DATABASE_URL,
						options: `-c search_path=${schema}`,
					},
					{ schema },
				),
			});
			try {
				// Raw fixture writes and backfill batches share this search_path.
				// Copy the real columns/indexes, keeping commits independent of cleanup.
				for (const table of [
					"user",
					"organization",
					"workflow",
					"workflow_execution",
				]) {
					const tableIdentifier = Prisma.raw(`"${table}"`);
					await publicDb.$executeRaw`CREATE TABLE ${schemaIdentifier}.${tableIdentifier} (LIKE public.${tableIdentifier} INCLUDING ALL)`;
				}
				await publicDb.user.create({
					data: {
						id: fixtureId,
						name: "Unrelated backfill fixture",
						email: `unrelated-${fixtureId}@example.com`,
						emailVerified: true,
						createdAt: new Date(),
						updatedAt: new Date(),
					},
				});
				await publicDb.organization.create({
					data: {
						id: fixtureId,
						name: "Unrelated backfill fixture",
						createdAt: new Date(),
					},
				});
				await publicDb.workflow.create({
					data: {
						id: unrelatedWorkflowId,
						name: "Unrelated eligible workflow",
						userId: fixtureId,
						organizationId: fixtureId,
						nodes: [],
						edges: [],
						lastRunAt: null,
						updatedAt: editedAt,
					},
				});
				await publicDb.workflowExecution.create({
					data: {
						workflowId: unrelatedWorkflowId,
						userId: fixtureId,
						organizationId: fixtureId,
						version: 1,
						status: "COMPLETED",
						triggerType: "MANUAL",
						temporalRunId: "unrelated-run",
						startedAt,
					},
				});
				let sequence = 0;
				async function seed(
					name: string,
					status: "COMPLETED" | "FAILED" | "PENDING" | "CANCELLED",
					temporalRunId: string | null,
					triggerType: WorkflowTriggerType = "MANUAL",
					lastRunAt: Date | null = null,
				) {
					const workflowId = `${fixtureId}-${++sequence}`;
					await db.$executeRaw`
						INSERT INTO "workflow" ("id", "name", "userId", "organizationId", "nodes", "edges", "lastRunAt", "updatedAt")
						VALUES (${workflowId}, ${name}, ${fixtureId}, ${fixtureId}, '[]'::jsonb, '[]'::jsonb, ${lastRunAt}, ${editedAt})`;
					await db.$executeRaw`
						INSERT INTO "workflow_execution" ("id", "workflowId", "userId", "organizationId", "version", "status", "triggerType", "temporalRunId", "startedAt")
						VALUES (${`${workflowId}-run`}, ${workflowId}, ${fixtureId}, ${fixtureId}, 1, ${status}::public."WorkflowExecutionStatus", ${triggerType}::public."WorkflowTriggerType", ${temporalRunId}, ${startedAt})`;
					return workflowId;
				}
				const expected = new Map<string, Date | null>([
					[await seed("Completed", "COMPLETED", "run-1"), startedAt],
					[
						await seed("Failed after start", "FAILED", "run-2"),
						startedAt,
					],
					[
						await seed(
							"Cancelled after start",
							"CANCELLED",
							"run-3",
						),
						startedAt,
					],
					[await seed("Refused", "FAILED", null), null],
					[await seed("Pending", "PENDING", "pending-run"), null],
					[
						await seed("Scheduled", "COMPLETED", null, "SCHEDULE"),
						startedAt,
					],
					[
						await seed(
							"Already newer",
							"COMPLETED",
							"run-4",
							"MANUAL",
							later,
						),
						later,
					],
					[
						await seed(
							"Already older",
							"COMPLETED",
							"run-5",
							"MANUAL",
							older,
						),
						startedAt,
					],
				]);
				await db.$executeRaw`
					INSERT INTO "workflow_execution" ("id", "workflowId", "userId", "organizationId", "version", "status", "triggerType", "temporalRunId", "startedAt")
					VALUES (${`${fixtureId}-older`}, ${`${fixtureId}-1`}, ${fixtureId}, ${fixtureId}, 1, 'COMPLETED', 'MANUAL', 'older-run', ${older}),
					       (${`${fixtureId}-pending`}, ${`${fixtureId}-1`}, ${fixtureId}, ${fixtureId}, 1, 'PENDING', 'MANUAL', 'newer-pending-run', ${later})`;
				async function snapshot() {
					return db.$queryRaw<
						Array<{
							id: string;
							lastRunAt: Date | null;
							updatedAt: Date;
						}>
					>`
						SELECT "id", "lastRunAt", "updatedAt" FROM "workflow" ORDER BY "id"`;
				}
				const before = await snapshot();
				await expect(
					backfillWorkflowLastRunAt({
						apply: false,
						batchSize: 2,
						client: db,
					}),
				).resolves.toEqual({ filled: 5 });
				expect(await snapshot()).toEqual(before);
				await expect(
					backfillWorkflowLastRunAt({
						apply: true,
						batchSize: 501,
						client: db,
					}),
				).rejects.toThrow("between 1 and 500");

				let batches = 0;
				let committed = 0;
				const interrupted = new Error(
					"Interrupted after a committed batch",
				);
				await expect(
					backfillWorkflowLastRunAt({
						apply: true,
						batchSize: 2,
						client: {
							$queryRaw: async (query) => {
								if (committed > 0) {
									throw interrupted;
								}
								const result =
									await db.$queryRaw<
										Array<{
											cursor: string | null;
											scanned: bigint;
											filled: bigint;
										}>
									>(query);
								batches++;
								expect(
									Number(result[0].scanned),
								).toBeLessThanOrEqual(2);
								expect(
									Number(result[0].filled),
								).toBeLessThanOrEqual(2);
								committed += Number(result[0].filled);
								return result;
							},
						},
					}),
				).rejects.toBe(interrupted);
				expect(batches).toBeGreaterThan(0);
				expect(committed).toBeGreaterThan(0);
				expect(
					(await snapshot()).filter(
						(row, index) =>
							row.lastRunAt?.getTime() !==
							before[index].lastRunAt?.getTime(),
					),
				).toHaveLength(committed);

				await expect(
					backfillWorkflowLastRunAt({
						apply: true,
						batchSize: 2,
						client: db,
					}),
				).resolves.toEqual({ filled: 5 - committed });
				const first = await snapshot();
				for (const workflow of first) {
					expect(workflow.lastRunAt).toEqual(
						expected.get(workflow.id),
					);
					expect(workflow.updatedAt).toEqual(editedAt);
				}
				await expect(
					backfillWorkflowLastRunAt({
						apply: true,
						batchSize: 2,
						client: db,
					}),
				).resolves.toEqual({ filled: 0 });
				expect(await snapshot()).toEqual(first);
				expect(
					await publicDb.workflow.findUniqueOrThrow({
						where: { id: unrelatedWorkflowId },
						select: { lastRunAt: true, updatedAt: true },
					}),
				).toEqual({ lastRunAt: null, updatedAt: editedAt });
			} finally {
				await db.$disconnect();
				await publicDb.$executeRaw`DROP SCHEMA ${schemaIdentifier} CASCADE`;
				await publicDb.workflow.deleteMany({
					where: { id: unrelatedWorkflowId },
				});
				await publicDb.organization.deleteMany({
					where: { id: fixtureId },
				});
				await publicDb.user.deleteMany({ where: { id: fixtureId } });
			}
		}, 30_000);
	},
);
