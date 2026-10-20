import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { hasReachableDatabaseUrl } from "../../../../__tests__/_helpers/db-availability";
import {
	db,
	Prisma,
	type WorkflowExecutionStatus,
	type WorkflowTriggerType,
} from "../../../client";
import { listAdoReviewBaselines } from "../ado-review-baselines";

const runId = `${Date.now()}-${process.pid}`;
const userId = `baseline-user-${runId}`;
const organizationId = `baseline-org-${runId}`;
const workflowId = `baseline-workflow-${runId}`;
const projectId = `baseline-project-${runId}`;
const binding = {
	userId,
	organizationId,
	workflowId,
	projectId,
	nodeId: "review",
	selectionFingerprint: "a".repeat(64),
};
const evaluatorFingerprint = "b".repeat(64);
const requirementsAsOf = "2026-01-03T12:00:00.1Z";
const captureStartedAt = "2026-01-03T12:01:00Z";
const completedAt = new Date("2026-01-03T12:00:01Z");
const executionId = (name: string) => `${workflowId}-${name}`;

function cache(overrides: Prisma.InputJsonObject = {}): Prisma.InputJsonObject {
	return {
		version: 1,
		...binding,
		evaluatorFingerprint,
		requirementsAsOf: "2026-01-02T12:00:00Z",
		stories: [],
		...overrides,
	};
}

function query(
	overrides: Partial<Parameters<typeof listAdoReviewBaselines>[0]> = {},
) {
	return listAdoReviewBaselines({
		binding,
		evaluatorFingerprint,
		requirementsAsOf,
		captureStartedAt,
		executionId: executionId("current"),
		...overrides,
	});
}

async function seed(
	id: string,
	options: {
		cache?: Prisma.InputJsonValue;
		output?: Prisma.InputJsonObject;
		status?: WorkflowExecutionStatus;
		triggerType?: WorkflowTriggerType;
		completedAt?: Date | null;
		userId?: string;
		organizationId?: string | null;
	} = {},
) {
	return db.workflowExecution.create({
		data: {
			id: executionId(id),
			workflowId,
			version: 1,
			status: options.status ?? "COMPLETED",
			triggerType: options.triggerType ?? "SCHEDULE",
			completedAt:
				options.completedAt === undefined
					? completedAt
					: options.completedAt,
			userId: options.userId ?? userId,
			organizationId:
				options.organizationId === undefined
					? organizationId
					: options.organizationId,
			output: options.output ?? {
				review: { cache: options.cache ?? cache() },
				unrelated: {
					secret: "must-not-project",
					large: "x".repeat(50_000),
				},
			},
		},
	});
}

describe.skipIf(!hasReachableDatabaseUrl())(
	"ADO review baseline projections (real Postgres 16)",
	() => {
		beforeAll(async () => {
			const now = new Date();
			await db.$executeRaw(Prisma.sql`
			INSERT INTO "user" (id, name, email, "emailVerified", "onboardingComplete", "createdAt", "updatedAt")
			VALUES (${userId}, 'Baseline fixture', ${`${userId}@example.com`}, true, false, ${now}, ${now})
		`);
			await db.organization.create({
				data: {
					id: organizationId,
					name: "Baseline fixtures",
					createdAt: now,
				},
			});
			await db.project.create({
				data: {
					id: projectId,
					name: "Review project",
					userId,
					organizationId,
				},
			});
			await db.workflow.create({
				data: {
					id: workflowId,
					name: "Review workflow",
					userId,
					organizationId,
					projectId,
					nodes: [],
					edges: [],
				},
			});
		});
		beforeEach(async () => {
			await db.workflowExecution.deleteMany({ where: { workflowId } });
			await db.workflow.update({
				where: { id: workflowId },
				data: { userId, organizationId, projectId },
			});
		});
		afterAll(async () => {
			await db.workflow.deleteMany({ where: { id: workflowId } });
			await db.project.deleteMany({ where: { id: projectId } });
			await db.organization.deleteMany({ where: { id: organizationId } });
			await db.user.deleteMany({ where: { id: userId } });
		});

		it("filters selection and evaluator before independently limiting analysis and scheduled comparison", async () => {
			await seed("daily", {
				cache: cache({ evaluatorFingerprint: "c".repeat(64) }),
			});
			await seed("manual", {
				triggerType: "MANUAL",
				cache: cache({ requirementsAsOf: "2026-01-03T10:00:00Z" }),
			});
			for (let index = 0; index < 8; index++) {
				await seed(`irrelevant-${index}`, {
					cache: cache({
						selectionFingerprint: "d".repeat(64),
						requirementsAsOf: "2026-01-03T11:00:00Z",
					}),
				});
				await seed(`other-evaluator-${index}`, {
					triggerType: "MANUAL",
					cache: cache({
						evaluatorFingerprint: "e".repeat(64),
						requirementsAsOf: "2026-01-03T11:00:00Z",
					}),
				});
			}
			const result = await query();
			expect(result.analysis.candidates.map((row) => row.id)).toEqual([
				executionId("manual"),
			]);
			expect(result.comparison.candidates.map((row) => row.id)).toEqual([
				executionId("daily"),
			]);
			expect(result.analysis.hasMore).toBe(false);
			expect(result.comparison.hasMore).toBe(false);
		});

		it("isolates exact cache versions before the bounded independent projections", async () => {
			await seed("direct-daily");
			await seed("sprint-daily", { cache: cache({ version: 2 }) });
			await seed("sprint-manual", {
				triggerType: "MANUAL",
				cache: cache({
					version: 2,
					requirementsAsOf: "2026-01-03T10:00:00Z",
				}),
			});
			for (let index = 0; index < 8; index++) {
				await seed(`direct-newer-${index}`, {
					triggerType: "MANUAL",
					cache: cache({ requirementsAsOf: "2026-01-03T11:00:00Z" }),
				});
			}
			const sprint = await query({ cacheVersion: 2 });
			expect(sprint.analysis.candidates.map((row) => row.id)).toEqual([
				executionId("sprint-manual"),
				executionId("sprint-daily"),
			]);
			expect(sprint.comparison.candidates.map((row) => row.id)).toEqual([
				executionId("sprint-daily"),
			]);
			expect(sprint.analysis.hasMore).toBe(false);
			expect(sprint.comparison.hasMore).toBe(false);
			const direct = await query();
			expect(direct.analysis.candidates).toHaveLength(5);
			expect(direct.analysis.hasMore).toBe(true);
			expect(direct.comparison.candidates.map((row) => row.id)).toEqual([
				executionId("direct-daily"),
			]);
		});

		it("requires all six exact cache binding fields before applying the limit", async () => {
			await seed("valid");
			for (const key of Object.keys(binding)) {
				await seed(`wrong-${key}`, {
					cache: cache({
						[key]:
							key === "selectionFingerprint"
								? "d".repeat(64)
								: "other",
					}),
				});
			}
			expect(
				(await query()).analysis.candidates.map((row) => row.id),
			).toEqual([executionId("valid")]);
		});

		it("checks execution tenant and the current workflow actor, organization and project", async () => {
			await seed("valid");
			await seed("foreign-user", { userId: "other" });
			await seed("foreign-org", { organizationId: "other" });
			await seed("null-org", { organizationId: null });
			expect(
				(await query()).analysis.candidates.map((row) => row.id),
			).toEqual([executionId("valid")]);
			for (const change of [
				{ projectId: null },
				{ organizationId: null },
			]) {
				await db.workflow.update({
					where: { id: workflowId },
					data: change,
				});
				expect((await query()).analysis.candidates).toEqual([]);
				await db.workflow.update({
					where: { id: workflowId },
					data: { projectId, organizationId },
				});
			}
			expect(
				(await query({ binding: { ...binding, userId: "other" } }))
					.analysis.candidates,
			).toEqual([]);
		});

		it("excludes current, failed, unfinished, future-watermark and late-completing executions", async () => {
			await seed("valid");
			await seed("current");
			await seed("failed", { status: "FAILED" });
			await seed("unfinished", { completedAt: null });
			await seed("future", {
				cache: cache({ requirementsAsOf: "2026-01-04T00:00:00Z" }),
			});
			await seed("late", {
				completedAt: new Date("2026-01-03T12:01:00.001Z"),
			});
			expect(
				(await query()).analysis.candidates.map((row) => row.id),
			).toEqual([executionId("valid")]);
		});

		it("orders parsed offsets and fractional watermarks, then completion and ID, with a temporal cutoff", async () => {
			await seed("fraction-09", {
				cache: cache({ requirementsAsOf: "2026-01-03T12:00:00.09Z" }),
				completedAt: new Date("2026-01-03T12:00:30Z"),
			});
			await seed("fraction-1", {
				cache: cache({ requirementsAsOf: "2026-01-03T12:00:00.1Z" }),
			});
			await seed("offset-z", {
				cache: cache({
					requirementsAsOf: "2026-01-03T14:00:00.100000+02:00",
				}),
			});
			await seed("offset-a", {
				cache: cache({
					requirementsAsOf: "2026-01-03T07:00:00.100000-05:00",
				}),
			});
			await seed("future-fraction", {
				cache: cache({
					requirementsAsOf: "2026-01-03T12:00:00.100001Z",
				}),
			});
			expect(
				(await query()).analysis.candidates.map((row) => row.id),
			).toEqual(
				["offset-z", "offset-a", "fraction-1", "fraction-09"].map(
					executionId,
				),
			);
			const precise = await query({
				requirementsAsOf: "2026-01-03T12:00:00.100001Z",
			});
			expect(precise.analysis.candidates[0].id).toBe(
				executionId("future-fraction"),
			);

			await db.workflowExecution.deleteMany({ where: { workflowId } });
			for (let index = 6; index <= 14; index++) {
				await seed(`tie-${20 - index}`, {
					cache: cache({
						requirementsAsOf: `2026-01-03T12:00:00.${1_000_000 + index}Z`,
					}),
				});
			}
			const tied = await query({
				requirementsAsOf: "2026-01-03T12:00:00.1000013Z",
			});
			expect(tied.analysis.candidates.map((row) => row.id)).toEqual(
				["tie-7", "tie-8", "tie-9", "tie-10", "tie-11"].map(
					executionId,
				),
			);
			expect(tied.analysis.hasMore).toBe(true);

			await db.workflowExecution.deleteMany({ where: { workflowId } });
			await seed("before-second", {
				cache: cache({
					requirementsAsOf: "2026-01-03T12:00:00.9999999Z",
				}),
			});
			await seed("after-second", {
				cache: cache({
					requirementsAsOf: "2026-01-03T12:00:01.0000001Z",
				}),
			});
			const boundary = await query({
				requirementsAsOf: "2026-01-03T12:00:00.9999999Z",
			});
			expect(boundary.analysis.candidates.map((row) => row.id)).toEqual([
				executionId("before-second"),
			]);
		});

		it("keeps malformed timestamp text diagnostic without throwing or casting it", async () => {
			const values = [
				"not-a-date",
				"2026-02-30T00:00:00Z",
				"2026-13-01T00:00:00Z",
				"infinity",
			];
			for (const [index, value] of values.entries())
				await seed(`malformed-${index}`, {
					cache: cache({ requirementsAsOf: value }),
				});
			const result = await query();
			expect(result.analysis.candidates).toHaveLength(4);
			expect(result.analysis.candidates.map((row) => row.cache)).toEqual(
				values.map((_, index) =>
					cache({ requirementsAsOf: values[3 - index] }),
				),
			);
		});

		it("projects only the cache, keeps valid Unicode above 600,000 UTF-8 bytes, and nulls oversized payloads", async () => {
			const unicode = cache({
				stories: Array.from({ length: 50 }, (_, index) => ({
					id: index + 1,
					sourceDetails: { requirements: {}, comments: [] },
					sourceFingerprint: createHash("sha256")
						.update('{"comments":[],"requirements":{}}')
						.digest("hex"),
					observation: {
						title: "界".repeat(3_000),
						state: "Active",
						assignedTo: null,
						workItemType: "User Story",
					},
					review: {
						id: index + 1,
						verdict: "ready",
						summary: "界".repeat(1_000),
						issues: Array.from({ length: 8 }, () =>
							"界".repeat(250),
						),
					},
				})),
			});
			expect(JSON.stringify(unicode).length).toBeLessThan(600_000);
			expect(Buffer.byteLength(JSON.stringify(unicode))).toBeGreaterThan(
				600_000,
			);
			await seed("unicode", { cache: unicode });
			await seed("oversized", {
				cache: cache({ text: "x".repeat(2_400_001) }),
			});
			const result = await query();
			expect(
				result.analysis.candidates.find(
					(row) => row.id === executionId("unicode"),
				)?.cache,
			).toEqual(unicode);
			expect(
				result.analysis.candidates.find(
					(row) => row.id === executionId("oversized"),
				)?.cache,
			).toBeNull();
			expect(JSON.stringify(result)).not.toContain("must-not-project");
			expect(Object.keys(result.analysis.candidates[0]).sort()).toEqual([
				"cache",
				"completedAt",
				"id",
			]);
		});

		it("bounds each candidate page independently and reports more matching history", async () => {
			for (let index = 0; index < 7; index++)
				await seed(`scheduled-${index}`);
			for (let index = 0; index < 7; index++)
				await seed(`manual-${index}`, { triggerType: "MANUAL" });
			const result = await query();
			expect(result.analysis.candidates).toHaveLength(5);
			expect(result.comparison.candidates).toHaveLength(5);
			expect(result.analysis.hasMore).toBe(true);
			expect(result.comparison.hasMore).toBe(true);
		});

		it("requires the exact node's object cache and version, without reading sibling outputs", async () => {
			await seed("valid");
			await seed("sibling", { output: { other: { cache: cache() } } });
			await seed("text", { cache: "cache" });
			await seed("version", { cache: cache({ version: 2 }) });
			await seed("string-version", { cache: cache({ version: "1" }) });
			expect(
				(await query()).analysis.candidates.map((row) => row.id),
			).toEqual([executionId("valid")]);
		});
	},
);
