/**
 * Workflow execution reservation: the per-tenant in-flight cap under real
 * concurrency (real Postgres).
 *
 * Every starter used to count a tenant's in-flight executions and then insert
 * the row in a second statement. N concurrent starts at `limit - 1` all saw
 * one free slot and all inserted, so the advertised ceiling held only when
 * nobody raced for it — and the surfaces most able to race (webhooks, retry
 * storms) are exactly what it exists to contain. `reserveWorkflowExecution`
 * takes a tenant-keyed transaction advisory lock around the count and the
 * insert (see its comment for why a lock and not a conditional write).
 *
 * A mocked client cannot show a lock being honoured, so this drives the real
 * statement with many concurrent callers on separate pool connections:
 *
 *   1. at one free slot, N concurrent reservations admit EXACTLY one;
 *   2. below the cap, concurrent reservations admit exactly the headroom;
 *   3. the tenant filter is XOR: an organization's rows do not consume a
 *      user's personal headroom, and a member's personal rows do not consume
 *      the organization's;
 *   4. the organization cap is the organization's, not each member's: two
 *      different members racing for its last slot admit exactly one;
 *   5. the starter's RUNNING write only moves a row out of PENDING, so a run
 *      that already reached a terminal status is never moved back.
 *
 * Runs against DATABASE_URL (RUN_DB_INTEGRATION=1).
 */

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "../prisma/generated/client";
import {
	markExecutionRunningIfPending,
	reserveWorkflowExecution,
} from "../prisma/queries/workflows/executions";

const IDS = {
	owner: "wfres-owner",
	member: "wfres-member",
	secondMember: "wfres-member-2",
	org: "wfres-org",
	personalWorkflow: "wfres-wf-personal",
	orgWorkflow: "wfres-wf-org",
};

function client(): PrismaClient {
	return new PrismaClient({
		adapter: new PrismaPg({
			connectionString: process.env.DATABASE_URL ?? "",
		}),
	});
}

/** Fixture writes and assertions; the reservations under test use the shared `db`. */
const fixtures = client();

async function upsertUser(id: string) {
	await fixtures.user.upsert({
		where: { id },
		update: {},
		create: {
			id,
			name: id,
			email: `${id}@example.com`,
			emailVerified: true,
			onboardingComplete: false,
			createdAt: new Date(),
			updatedAt: new Date(),
		} as never,
	});
}

async function clearExecutions() {
	await fixtures.workflowExecution.deleteMany({
		where: { workflowId: { in: [IDS.personalWorkflow, IDS.orgWorkflow] } },
	});
}

async function inFlightRows(where: {
	userId?: string;
	organizationId: string | null;
}) {
	return fixtures.workflowExecution.count({
		where: { ...where, status: { in: ["PENDING", "RUNNING"] } },
	});
}

function reservePersonal(limit: number) {
	return reserveWorkflowExecution({
		userId: IDS.owner,
		organizationId: null,
		limit,
		data: {
			workflowId: IDS.personalWorkflow,
			version: 1,
			triggerType: "MANUAL",
		},
	});
}

function reserveOrg(limit: number, userId = IDS.member) {
	return reserveWorkflowExecution({
		userId,
		organizationId: IDS.org,
		limit,
		data: {
			workflowId: IDS.orgWorkflow,
			version: 1,
			triggerType: "WEBHOOK",
		},
	});
}

const RACERS = 8;

describe.skipIf(!process.env.DATABASE_URL)(
	"Workflow execution reservation: the in-flight cap under contention (real Postgres)",
	() => {
		beforeAll(async () => {
			await upsertUser(IDS.owner);
			await upsertUser(IDS.member);
			await upsertUser(IDS.secondMember);
			await fixtures.organization.upsert({
				where: { id: IDS.org },
				update: {},
				create: {
					id: IDS.org,
					name: "Reservation contention org",
					slug: IDS.org,
					createdAt: new Date(),
				} as never,
			});
			await fixtures.workflow.upsert({
				where: { id: IDS.personalWorkflow },
				update: {},
				create: {
					id: IDS.personalWorkflow,
					name: "Personal reservation workflow",
					userId: IDS.owner,
					organizationId: null,
					nodes: [],
					edges: [],
				} as never,
			});
			await fixtures.workflow.upsert({
				where: { id: IDS.orgWorkflow },
				update: {},
				create: {
					id: IDS.orgWorkflow,
					name: "Org reservation workflow",
					userId: IDS.member,
					organizationId: IDS.org,
					nodes: [],
					edges: [],
				} as never,
			});
			await clearExecutions();
		});

		beforeEach(async () => {
			await clearExecutions();
		});

		afterAll(async () => {
			await clearExecutions();
			await fixtures.workflow.deleteMany({
				where: { id: { in: [IDS.personalWorkflow, IDS.orgWorkflow] } },
			});
			await fixtures.organization.deleteMany({ where: { id: IDS.org } });
			await fixtures.user.deleteMany({
				where: {
					id: { in: [IDS.owner, IDS.member, IDS.secondMember] },
				},
			});
			await fixtures.$disconnect();
			const { db } = await import("../prisma/client");
			await db.$disconnect();
		});

		it("admits exactly one of many concurrent reservations for the last free slot", async () => {
			// Two already in flight, cap of three: one slot left, eight racers.
			// Without the lock every racer counts two, and all eight insert.
			await reservePersonal(3);
			await reservePersonal(3);

			const results = await Promise.all(
				Array.from({ length: RACERS }, () => reservePersonal(3)),
			);

			const admitted = results.filter((r) => r.reserved);
			expect(admitted).toHaveLength(1);
			expect(results.filter((r) => !r.reserved)).toHaveLength(RACERS - 1);
			for (const refused of results.filter((r) => !r.reserved)) {
				expect(refused).toEqual({
					reserved: false,
					inFlight: 3,
					limit: 3,
				});
			}
			expect(
				await inFlightRows({ userId: IDS.owner, organizationId: null }),
			).toBe(3);
		});

		it("admits exactly the headroom, never more, when several slots are free", async () => {
			const results = await Promise.all(
				Array.from({ length: RACERS }, () => reservePersonal(5)),
			);

			expect(results.filter((r) => r.reserved)).toHaveLength(5);
			expect(
				await inFlightRows({ userId: IDS.owner, organizationId: null }),
			).toBe(5);
		});

		it("creates the row as PENDING with the tenant it was reserved for", async () => {
			const result = await reserveOrg(10);

			expect(result.reserved).toBe(true);
			if (!result.reserved) {
				return;
			}
			expect(result.execution).toMatchObject({
				status: "PENDING",
				workflowId: IDS.orgWorkflow,
				userId: IDS.member,
				organizationId: IDS.org,
				triggerType: "WEBHOOK",
			});
			expect(result).toMatchObject({ inFlight: 1, limit: 10 });
		});

		it("does not let an organization's rows consume a member's personal headroom, or vice versa", async () => {
			// The org is full; the member's personal cap (as the owner of the
			// personal workflow) is untouched by it.
			await reserveOrg(2, IDS.owner);
			await reserveOrg(2, IDS.owner);
			expect(await reserveOrg(2, IDS.owner)).toMatchObject({
				reserved: false,
				inFlight: 2,
			});

			const personal = await reservePersonal(1);
			expect(personal.reserved).toBe(true);

			// And the personal row, now filling the personal cap, does not
			// count against the organization either: raising the org cap by
			// one admits exactly one more org run.
			expect(await reservePersonal(1)).toMatchObject({ reserved: false });
			expect(await reserveOrg(3, IDS.owner)).toMatchObject({
				reserved: true,
				inFlight: 3,
			});
		});

		it("admits exactly one of two different members racing for the organization's last slot", async () => {
			// The lock is keyed on the organization, not the caller: two members
			// each seeing one free slot must not both take it. Several rounds so
			// an unlucky interleaving has a chance to show.
			for (let round = 0; round < 5; round++) {
				await clearExecutions();
				await reserveOrg(2, IDS.member);

				const [first, second] = await Promise.all([
					reserveOrg(2, IDS.member),
					reserveOrg(2, IDS.secondMember),
				]);

				expect([first, second].filter((r) => r.reserved)).toHaveLength(
					1,
				);
				expect(await inFlightRows({ organizationId: IDS.org })).toBe(2);
			}
		});

		it("moves a row to RUNNING only from PENDING, and never moves a finished run back", async () => {
			const pending = await reserveOrg(10);
			const finished = await reserveOrg(10);
			if (!pending.reserved || !finished.reserved) {
				throw new Error("expected both reservations to be admitted");
			}
			// The run behind `finished` wrote its terminal status before the
			// starter's RUNNING write landed.
			await fixtures.workflowExecution.update({
				where: { id: finished.execution.id },
				data: { status: "COMPLETED", completedAt: new Date() },
			});

			expect(
				await markExecutionRunningIfPending({
					executionId: pending.execution.id,
					temporalRunId: `workflow-execution-${pending.execution.id}`,
				}),
			).toBe(true);
			expect(
				await markExecutionRunningIfPending({
					executionId: finished.execution.id,
					temporalRunId: `workflow-execution-${finished.execution.id}`,
				}),
			).toBe(false);

			const rows = await fixtures.workflowExecution.findMany({
				where: {
					id: { in: [pending.execution.id, finished.execution.id] },
				},
				select: { id: true, status: true, temporalRunId: true },
			});
			const byId = new Map(rows.map((r) => [r.id, r]));
			expect(byId.get(pending.execution.id)).toMatchObject({
				status: "RUNNING",
				temporalRunId: `workflow-execution-${pending.execution.id}`,
			});
			// Still COMPLETED, but it now names the run it came from.
			expect(byId.get(finished.execution.id)).toMatchObject({
				status: "COMPLETED",
				temporalRunId: `workflow-execution-${finished.execution.id}`,
			});
		});
	},
);
