/**
 * Retention never deletes an unresolved pull-request operation (Fizzy #2563
 * spec §4.3), on a real Postgres.
 *
 * One predicate, in a Prisma form and a raw SQL form, guards five sites:
 * both selection windows of `listPrunableInstructionSnapshots`, both
 * candidate windows of `listProjectsWithPrunableInstructionSnapshots` and
 * the DELETE of `deleteInstructionSnapshot`. The forms must select the same
 * rows, the null-safe "resolved" complement must keep a FABRIC row (null
 * state) prunable, and `pullRequestObligationOpen`, the column the predicate
 * reads, must equal what the records themselves say. Self-skips without a
 * reachable database.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	db,
	deleteInstructionSnapshot,
	listProjectsWithPrunableInstructionSnapshots,
	listPrunableInstructionSnapshots,
	Prisma,
} from "../index";
import {
	isUnresolvedPullRequestOperation,
	type PullRequestAttemptRecord,
	resolvedPullRequestOperation,
	resolvedPullRequestOperationSql,
	unresolvedPullRequestOperation,
	unresolvedPullRequestOperationSql,
	writeAttemptRecord,
} from "../prisma/queries/instruction-proposal-pull-requests";
import { hasReachableDatabaseUrl } from "./_helpers/db-availability";

const RUN_ID = `${Date.now()}-${process.pid}`;
const ORGANIZATION_ID = `pr-retention-org-${RUN_ID}`;
const USER_ID = `pr-retention-user-${RUN_ID}`;
const SHA = "b".repeat(40);
const CLEANUP_MARKER = {
	path: "(proposal staging)",
	reason: "abandoned",
	detail: "staging pending",
};
/** A proposal whose staging prefix the sweep has already cleared. */
const CLEARED_MARKER = { ...CLEANUP_MARKER, detail: "staging cleared" };

/**
 * `rejection` as the lifecycle leaves it on a terminal row: a JSON null on a
 * READY upload (`markInstructionSnapshotReady` writes `Prisma.JsonNull`), the
 * rejection list on a REJECTED one, and the swept staging marker on a
 * proposal. Never SQL NULL, which the cleanup-marker clauses do not treat
 * as "no marker".
 */
function terminalRejection(
	data: Partial<Prisma.ProjectInstructionSnapshotUncheckedCreateInput>,
) {
	if (data.proposalStatus) {
		return [CLEARED_MARKER];
	}
	// READY and FAILED both store a JSON null (`markInstructionSnapshotReady`,
	// `failInstructionSnapshot`).
	return data.status === "REJECTED"
		? [{ path: "CLAUDE.md", reason: "secret" }]
		: Prisma.JsonNull;
}

/** Project name → id, and each project's next version. */
const projects: Record<string, string> = {};
const versions: Record<string, number> = {};
/** Seed name → snapshot id. */
const ids: Record<string, string> = {};
let operation = 0;

async function seed(
	project: string,
	name: string,
	data: Partial<Prisma.ProjectInstructionSnapshotUncheckedCreateInput>,
	records: Array<Partial<PullRequestAttemptRecord>> = [],
): Promise<string> {
	const projectId = projects[project]!;
	versions[project] = (versions[project] ?? 0) + 1;
	const repository = data.proposalDestination === "REPOSITORY";
	operation += 1;
	const row = await db.projectInstructionSnapshot.create({
		data: {
			projectId,
			organizationId: ORGANIZATION_ID,
			userId: USER_ID,
			version: versions[project]!,
			source: "UPLOAD",
			status: "READY",
			settingsFrozen: {},
			publishOnReady: false,
			rejection: terminalRejection(data),
			...(repository
				? {
						pullRequestOperationId: `op${RUN_ID.replace(/\D/g, "")}r${operation}`,
					}
				: {}),
			...data,
		},
		select: { id: true },
	});
	await db.projectInstructionFile.create({
		data: {
			snapshotId: row.id,
			projectId,
			organizationId: ORGANIZATION_ID,
			userId: USER_ID,
			path: "CLAUDE.md",
			kind: "INSTRUCTIONS",
			storageKey: `projects/${projectId}/instructions/snapshots/${row.id}/f`,
			sha256: "0".repeat(64),
			size: 1,
			mimeType: "text/markdown",
			isText: true,
		},
	});
	// Through the real record writer, so the summary column is the one the
	// application maintains, not one this test wrote.
	for (const [n, record] of records.entries()) {
		const written = await writeAttemptRecord({
			snapshotId: row.id,
			organizationId: ORGANIZATION_ID,
			identity: { attempt: n + 1, ref: `fabric/instructions/r${n + 1}` },
			expect: {},
			patch: { sha: SHA, confirmations: 0, ...record },
			append: true,
		});
		expect(written).toBe(true);
	}
	ids[name] = row.id;
	return row.id;
}

async function publishBase(project: string) {
	const baseId = await seed(project, `${project}-base`, {});
	await db.project.update({
		where: { id: projects[project] },
		data: { publishedInstructionSnapshotId: baseId },
	});
}

const repository = (
	state: "QUEUED" | "OPENING" | "OPEN" | "CLOSE_REQUESTED" | "BLOCKED",
) =>
	({
		proposalStatus: "PENDING",
		proposalDestination: "REPOSITORY",
		pullRequestState: state,
	}) as const;
const settled = (outcome: "MERGED" | "CLOSED" | "CANCELED") =>
	({
		proposalStatus: outcome === "CANCELED" ? "REJECTED" : outcome,
		proposalDestination: "REPOSITORY",
		pullRequestState: outcome,
	}) as const;
const at = "2026-09-24T09:00:00.000Z";

describe.skipIf(!hasReachableDatabaseUrl())(
	"proposal pull-request retention (real Postgres)",
	() => {
		beforeAll(async () => {
			const now = new Date();
			await db.user.create({
				data: {
					id: USER_ID,
					name: "Retention Author",
					email: `${USER_ID}@example.com`,
					emailVerified: true,
					createdAt: now,
					updatedAt: now,
				},
			});
			await db.organization.create({
				data: {
					id: ORGANIZATION_ID,
					name: "Retention Integration",
					slug: ORGANIZATION_ID,
					createdAt: now,
				},
			});
			for (const name of ["main", "unresolved", "merged", "closed"]) {
				const project = await db.project.create({
					data: {
						name: `Retention ${name}`,
						userId: USER_ID,
						organizationId: ORGANIZATION_ID,
						techStack: [],
						features: [],
						tags: [],
					},
				});
				projects[name] = project.id;
				await publishBase(name);
			}

			// main: one row per unresolved clause, the prunable settled rows,
			// FABRIC rows, and the two protections that must still hold.
			await seed("main", "queued", repository("QUEUED"));
			await seed("main", "opening", repository("OPENING"));
			await seed("main", "open", repository("OPEN"), [
				// Issued, never acknowledged, no outcome: ownership unknown.
				{ pushIssuedAt: at },
			]);
			await seed("main", "closeRequested", repository("CLOSE_REQUESTED"));
			await seed("main", "blocked", repository("BLOCKED"));
			await seed("main", "mergeSyncOwed", {
				...settled("MERGED"),
				mergeSyncRequestedAt: new Date(at),
			});
			await seed(
				"main",
				"canceledAwaitingConfirmation",
				settled("CANCELED"),
				[
					{
						pushIssuedAt: at,
						pushAckedAt: at,
						settledAt: at,
						outcome: "settled",
					},
				],
			);
			await seed(
				"main",
				"rejectedWithCreateMarker",
				{ ...settled("CANCELED"), status: "REJECTED" },
				[{ pushIssuedAt: at, pushAckedAt: at, createIssuedAt: at }],
			);
			await seed("main", "merged", settled("MERGED"));
			await seed("main", "closed", settled("CLOSED"), [
				{
					pushIssuedAt: at,
					pushAckedAt: at,
					settledAt: at,
					confirmations: 2,
					outcome: "settled",
				},
			]);
			await seed("main", "canceled", {
				...settled("CANCELED"),
				status: "REJECTED",
			});
			await seed("main", "fabricReady", {});
			await seed("main", "fabricRejected", { status: "REJECTED" });
			await seed("main", "fabricFailed", { status: "FAILED" });
			// Never written at all (SQL NULL): still no marker.
			await seed("main", "fabricNoRejection", {
				rejection: Prisma.DbNull,
			});
			const pendingBase = await seed(
				"main",
				"mergedBaseOfPending",
				settled("MERGED"),
			);
			await seed("main", "pendingChild", {
				proposalStatus: "PENDING",
				baseSnapshotId: pendingBase,
				baseVersion: 1,
			});
			await seed("main", "canceledWithCleanupMarker", {
				...settled("CANCELED"),
				status: "REJECTED",
				rejection: [CLEANUP_MARKER],
			});

			// unresolved: nothing old in it is prunable, in either window.
			await seed("unresolved", "unresolvedOpen", repository("OPEN"));
			await seed(
				"unresolved",
				"unresolvedRejected",
				{ ...settled("CANCELED"), status: "REJECTED" },
				[{ pushIssuedAt: at, pushAckedAt: at, createIssuedAt: at }],
			);
			// merged / closed: one prunable settled row each.
			await seed("merged", "onlyMerged", settled("MERGED"));
			await seed("closed", "onlyClosed", settled("CLOSED"));
		});

		afterAll(async () => {
			const projectIds = Object.values(projects);
			await db.project.updateMany({
				where: { id: { in: projectIds } },
				data: { publishedInstructionSnapshotId: null },
			});
			await db.projectInstructionSnapshot.deleteMany({
				where: { projectId: { in: projectIds } },
			});
			await db.project.deleteMany({ where: { id: { in: projectIds } } });
			await db.organization.deleteMany({
				where: { id: ORGANIZATION_ID },
			});
			await db.user.deleteMany({ where: { id: USER_ID } });
			await db.$disconnect();
		});

		const name = (id: string) =>
			Object.entries(ids).find(([, v]) => v === id)?.[0] ?? id;

		it("the Prisma, SQL and row forms agree, and resolved and unresolved partition the rows", async () => {
			const projectIds = Object.values(projects);
			const scope = { projectId: { in: projectIds } };
			const byPrisma = async (
				where: Prisma.ProjectInstructionSnapshotWhereInput,
			) =>
				(
					await db.projectInstructionSnapshot.findMany({
						where: { AND: [scope, where] },
						select: { id: true },
					})
				)
					.map((r) => name(r.id))
					.sort();
			const bySql = async (predicate: Prisma.Sql) =>
				(
					await db.$queryRaw<Array<{ id: string }>>`
						SELECT s."id" FROM "project_instruction_snapshot" s
						WHERE s."projectId" = ANY(${projectIds}) AND ${predicate}
					`
				)
					.map((r) => name(r.id))
					.sort();

			const unresolved = await byPrisma(unresolvedPullRequestOperation());
			const resolved = await byPrisma(resolvedPullRequestOperation());
			expect(await bySql(unresolvedPullRequestOperationSql("s"))).toEqual(
				unresolved,
			);
			expect(await bySql(resolvedPullRequestOperationSql("s"))).toEqual(
				resolved,
			);
			expect(unresolved).toEqual(
				[
					"queued",
					"opening",
					"open",
					"closeRequested",
					"blocked",
					"mergeSyncOwed",
					"canceledAwaitingConfirmation",
					"rejectedWithCreateMarker",
					"unresolvedOpen",
					"unresolvedRejected",
				].sort(),
			);
			// A partition: every row is exactly one of the two, FABRIC rows
			// (null state) resolved rather than lost to SQL's NULL.
			const all = (
				await db.projectInstructionSnapshot.findMany({
					where: scope,
					select: {
						id: true,
						pullRequestState: true,
						mergeSyncRequestedAt: true,
						pullRequestObligationOpen: true,
					},
				})
			).map((r) => ({ ...r, id: name(r.id) }));
			expect([...unresolved, ...resolved].sort()).toEqual(
				all.map((r) => r.id).sort(),
			);
			expect(unresolved.filter((id) => resolved.includes(id))).toEqual(
				[],
			);
			expect(resolved).toContain("fabricReady");
			for (const row of all) {
				expect(isUnresolvedPullRequestOperation(row)).toBe(
					unresolved.includes(row.id),
				);
			}
		});

		it("keeps the obligation column equal to a recomputation over the records", async () => {
			const rows = await db.$queryRaw<
				Array<{ id: string; column: boolean; recomputed: boolean }>
			>`
				SELECT s."id",
					s."pullRequestObligationOpen" AS "column",
					EXISTS (
						SELECT 1 FROM unnest(s."pullRequestAttempts") r
						WHERE r->>'createIssuedAt' IS NOT NULL
							OR (r->>'settledAt' IS NOT NULL
								AND COALESCE((r->>'confirmations')::int, 0) < 2)
							OR (r->>'pushIssuedAt' IS NOT NULL
								AND r->>'pushAckedAt' IS NULL
								AND r->>'outcome' IS NULL)
					) AS "recomputed"
				FROM "project_instruction_snapshot" s
				WHERE s."projectId" = ANY(${Object.values(projects)})
			`;
			expect(rows.length).toBeGreaterThan(20);
			for (const row of rows) {
				expect({ id: name(row.id), column: row.column }).toEqual({
					id: name(row.id),
					column: row.recomputed,
				});
			}
			// Not vacuous: the seeds hold obligations of all three kinds.
			expect(
				rows
					.filter((r) => r.column)
					.map((r) => name(r.id))
					.sort(),
			).toEqual(
				[
					"open",
					"canceledAwaitingConfirmation",
					"rejectedWithCreateMarker",
					"unresolvedRejected",
				].sort(),
			);
		});

		it("both selection windows keep unresolved rows and prune settled and FABRIC ones", async () => {
			const prunable = await listPrunableInstructionSnapshots(
				projects.main!,
				ORGANIZATION_ID,
				{ ready: 0, rejected: 0 },
			);
			expect(prunable.map((r) => name(r.id)).sort()).toEqual(
				[
					// READY window: MERGED and CLOSED once settled, and FABRIC
					// rows whose `rejection` is a JSON null or absent.
					"merged",
					"closed",
					"fabricReady",
					"fabricNoRejection",
					// REJECTED/FAILED window.
					"canceled",
					"fabricRejected",
					"fabricFailed",
				].sort(),
			);
		});

		it("both candidate windows skip a project whose old rows are all unresolved", async () => {
			const { candidates } =
				await listProjectsWithPrunableInstructionSnapshots(
					{ ready: 0, rejected: 0 },
					1_000_000,
					0,
				);
			const nominated = new Set(candidates.map((c) => c.projectId));
			expect(nominated.has(projects.main!)).toBe(true);
			expect(nominated.has(projects.merged!)).toBe(true);
			expect(nominated.has(projects.closed!)).toBe(true);
			expect(nominated.has(projects.unresolved!)).toBe(false);
		});

		it("the DELETE refuses unresolved rows, rolls their file rows back, and keeps its protections", async () => {
			for (const refused of [
				"open",
				"mergeSyncOwed",
				"canceledAwaitingConfirmation",
				"rejectedWithCreateMarker",
			]) {
				expect(
					await deleteInstructionSnapshot(
						ids[refused]!,
						projects.main!,
						ORGANIZATION_ID,
					),
				).toEqual({
					deleted: false,
					reason: "pull_request_unresolved",
				});
				// The refusal threw inside the transaction: the file row the
				// statement before it deleted is back.
				expect(
					await db.projectInstructionFile.count({
						where: { snapshotId: ids[refused] },
					}),
				).toBe(1);
			}
			expect(
				await deleteInstructionSnapshot(
					ids.mergedBaseOfPending!,
					projects.main!,
					ORGANIZATION_ID,
				),
			).toEqual({ deleted: false, reason: "base_in_flight" });
			expect(
				await deleteInstructionSnapshot(
					ids.canceledWithCleanupMarker!,
					projects.main!,
					ORGANIZATION_ID,
				),
			).toEqual({ deleted: false, reason: "active" });
			for (const deletable of [
				"merged",
				"closed",
				"canceled",
				"fabricReady",
				"fabricFailed",
				"fabricNoRejection",
			]) {
				expect(
					await deleteInstructionSnapshot(
						ids[deletable]!,
						projects.main!,
						ORGANIZATION_ID,
					),
				).toEqual({ deleted: true });
			}
		});
	},
);
