/** Real-Postgres proof that runtime state writes preserve the workflow's edit timestamp. */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasReachableDatabaseUrl } from "../../../../__tests__/_helpers/db-availability";
import { db, Prisma, type WorkflowBuilderStatus } from "../../../client";
import { updateWorkflow, writeWorkflowRunState } from "../workflows";

const RUN_ID = `${Date.now()}-${process.pid}`;
const USER_ID = `test-run-state-user-${RUN_ID}`;
const ORG_ID = `test-run-state-org-${RUN_ID}`;
const EDITED_AT = new Date("2026-01-01T00:00:00.000Z");
const INITIAL_SETTINGS = { publishFrameIds: { publish: "frame-1" } };
const RUN_SETTINGS = { ...INITIAL_SETTINGS, consecutiveFailures: 3 };

describe.skipIf(!hasReachableDatabaseUrl())(
	"writeWorkflowRunState (real Postgres)",
	() => {
		beforeAll(async () => {
			const now = new Date();
			await db.$executeRaw(Prisma.sql`
				INSERT INTO "user" (id, name, email, "emailVerified", "onboardingComplete", "createdAt", "updatedAt")
				VALUES (${USER_ID}, ${"Run State User"}, ${`${USER_ID}@example.com`}, true, false, ${now}, ${now})
			`);
			await db.organization.create({
				data: {
					id: ORG_ID,
					name: "Run State Organization",
					createdAt: now,
				},
			});
		});

		afterAll(async () => {
			await db.workflow.deleteMany({ where: { userId: USER_ID } });
			await db.organization.deleteMany({ where: { id: ORG_ID } });
			await db.user.deleteMany({ where: { id: USER_ID } });
		});

		async function seed(organizationId: string | null = ORG_ID) {
			const workflow = await db.workflow.create({
				data: {
					name: "Run state",
					nodes: [],
					edges: [],
					userId: USER_ID,
					organizationId,
					status: "PUBLISHED",
					settings: INITIAL_SETTINGS,
				},
			});
			await db.$executeRaw`UPDATE "workflow" SET "updatedAt" = ${EDITED_AT} WHERE "id" = ${workflow.id}`;
			return workflow.id;
		}

		async function readWorkflow(id: string) {
			return db.workflow.findUniqueOrThrow({
				where: { id },
				select: {
					name: true,
					settings: true,
					status: true,
					updatedAt: true,
				},
			});
		}

		async function writeState(
			workflowId: string,
			organizationId: string | null = ORG_ID,
			status?: WorkflowBuilderStatus,
		) {
			return db.$transaction(async (tx) => {
				await tx.$queryRaw`SELECT id FROM workflow WHERE id = ${workflowId} FOR UPDATE`;
				return writeWorkflowRunState(tx, {
					workflowId,
					organizationId,
					settings: RUN_SETTINGS,
					status,
				});
			});
		}

		it("writes settings without changing status or updatedAt", async () => {
			const workflowId = await seed();

			await expect(writeState(workflowId)).resolves.toBe(1);
			expect(await readWorkflow(workflowId)).toEqual({
				name: "Run state",
				settings: RUN_SETTINGS,
				status: "PUBLISHED",
				updatedAt: EDITED_AT,
			});
		});

		it("pauses and writes settings without changing updatedAt", async () => {
			const workflowId = await seed();

			await expect(
				writeState(workflowId, ORG_ID, "PAUSED"),
			).resolves.toBe(1);
			expect(await readWorkflow(workflowId)).toMatchObject({
				settings: RUN_SETTINGS,
				status: "PAUSED",
				updatedAt: EDITED_AT,
			});
		});

		it.each([
			{ stored: ORG_ID, supplied: `${ORG_ID}-other` },
			{ stored: ORG_ID, supplied: null },
			{ stored: null, supplied: ORG_ID },
		])(
			"refuses tenant mismatch $stored / $supplied",
			async ({ stored, supplied }) => {
				const workflowId = await seed(stored);
				const before = await readWorkflow(workflowId);

				await expect(
					writeState(workflowId, supplied, "PAUSED"),
				).resolves.toBe(0);
				expect(await readWorkflow(workflowId)).toEqual(before);
			},
		);

		it("matches a null organization only with null and preserves updatedAt", async () => {
			const workflowId = await seed(null);

			await expect(writeState(workflowId, null)).resolves.toBe(1);
			expect(await readWorkflow(workflowId)).toMatchObject({
				settings: RUN_SETTINGS,
				updatedAt: EDITED_AT,
			});
		});

		it("still advances updatedAt for a user edit and preserves that timestamp on a run", async () => {
			const workflowId = await seed();
			const edited = await updateWorkflow(
				workflowId,
				USER_ID,
				{ name: "Edited workflow" },
				ORG_ID,
			);

			expect(edited.updatedAt.getTime()).toBeGreaterThan(
				EDITED_AT.getTime(),
			);
			await expect(writeState(workflowId)).resolves.toBe(1);
			expect(await readWorkflow(workflowId)).toMatchObject({
				name: "Edited workflow",
				settings: RUN_SETTINGS,
				updatedAt: edited.updatedAt,
			});
		});
	},
);
