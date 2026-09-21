/**
 * PM status sync queries against REAL Postgres (Fizzy #2304, spec §4.3 D2.6,
 * §4.4 "CONFLICT rows", §6 rule 3).
 *
 * Two properties live in the rows, not in the code that builds the queries:
 *
 *   - the CONFLICT dedupe answers whether ANY conflict pull row of one story in
 *     one project carries the key, so an identical hourly cycle adds nothing —
 *     even with an unrelated CONFLICT row in between — and a changed ticket
 *     date adds exactly one row;
 *   - the last-run merge refuses a write from an older session or from a
 *     project whose switch is off, so a stale activity cannot overwrite a fresh
 *     session's summary.
 *
 * The unit suites pin the WHERE clauses; this suite pins what Postgres does
 * with them. Self-skips when DATABASE_URL is unset or is the CI placeholder;
 * `.github/workflows/db-integration.yml` runs it with an exact-count guard.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, Prisma } from "../prisma/client";
import {
	mergePmStatusSyncLastRun,
	pmStatusSyncLastRunSchema,
} from "../prisma/queries/pm-status-sync-last-run";
import {
	createPmSyncLog,
	hasPmSyncConflictWithDedupeKey,
} from "../prisma/queries/pm-sync-log";
import { hasReachableDatabaseUrl } from "./_helpers/db-availability";

const RUN = `${Date.now()}-${process.pid}`;
const USER = `pss-db-user-${RUN}`;
const ORG = `pss-db-org-${RUN}`;
const PROJECT = `pss-db-project-${RUN}`;
const OTHER_PROJECT = `pss-db-other-${RUN}`;
const SESSION = new Date("2026-09-21T08:00:00.000Z");
const EARLIER_SESSION = new Date("2026-09-20T08:00:00.000Z");

let entitySeq = 0;
const nextEntity = () => `pss-db-story-${RUN}-${++entitySeq}`;
const at = (hour: number) =>
	new Date(`2026-09-21T${String(hour).padStart(2, "0")}:00:00.000Z`);

async function writeLogRow(args: {
	entityId: string;
	dedupeKey: string;
	createdAt: Date;
	projectId?: string;
	direction?: "pull" | "push";
	status?: "CONFLICT" | "SUCCESS";
}) {
	await db.pmSyncLog.create({
		data: {
			direction: args.direction ?? "pull",
			entityType: "STORY",
			entityId: args.entityId,
			title: "Two status labels",
			pmTool: "gitlab",
			status: args.status ?? "CONFLICT",
			// A SUCCESS or push row never carries a dedupe key in production; it
			// carries one here so the status/direction filters are what exclude it.
			errorPayload: {
				reason: "pm-status-ambiguous",
				dedupeKey: args.dedupeKey,
			},
			organizationId: ORG,
			userId: null,
			projectId: args.projectId ?? PROJECT,
			createdAt: args.createdAt,
		},
	});
}

const has = (entityId: string, dedupeKey: string, projectId = PROJECT) =>
	hasPmSyncConflictWithDedupeKey({ projectId, entityId, dedupeKey });

const fetchSummary = (linked: number) => ({
	at: "2026-09-21T09:00:05.000Z",
	linked,
	fetched: linked,
	failed: 0,
	notFound: 0,
	complete: true,
});

const outcomeSummary = {
	at: "2026-09-21T09:01:00.000Z",
	counts: {
		moved: 1,
		unchanged: 2,
		"fabric-ahead": 0,
		"not-mapped": 0,
		ambiguous: 0,
		unverified: 0,
		stale: 0,
		"skipped-conflict": 0,
		raced: 0,
	},
};

async function readLastRun(projectId = PROJECT) {
	const row = await db.project.findUniqueOrThrow({
		where: { id: projectId },
		select: { pmStatusSyncLastRun: true },
	});
	return row.pmStatusSyncLastRun;
}

describe.skipIf(!hasReachableDatabaseUrl())(
	"PM status sync queries (real Postgres)",
	() => {
		beforeAll(async () => {
			const now = new Date();
			await db.$executeRaw(Prisma.sql`
				INSERT INTO "user" (id, name, email, "emailVerified", "onboardingComplete", "createdAt", "updatedAt")
				VALUES (${USER}, ${"Status Sync DB"}, ${`${USER}@example.com`}, true, true, ${now}, ${now})
				ON CONFLICT (id) DO NOTHING
			`);
			await db.$executeRaw(Prisma.sql`
				INSERT INTO "organization" (id, name, slug, "createdAt")
				VALUES (${ORG}, ${"Status Sync DB Org"}, ${ORG}, ${now})
				ON CONFLICT (id) DO NOTHING
			`);
			for (const id of [PROJECT, OTHER_PROJECT]) {
				await db.project.create({
					data: {
						id,
						name: `Status sync queries ${RUN}`,
						userId: USER,
						organizationId: ORG,
						projectManagementMcpServerId: "key:gitlab-official",
						projectManagementContainerId: "4711",
						pmStatusSyncEnabled: true,
						pmStatusSyncSessionAt: SESSION,
					},
				});
			}
		});

		afterAll(async () => {
			await db.pmSyncLog.deleteMany({
				where: { projectId: { in: [PROJECT, OTHER_PROJECT] } },
			});
			await db.project.deleteMany({
				where: { id: { in: [PROJECT, OTHER_PROJECT] } },
			});
		});

		describe("hasPmSyncConflictWithDedupeKey", () => {
			it("answers whether ANY CONFLICT pull row carries the key — an older key stays seen after a newer one", async () => {
				const entityId = nextEntity();
				await writeLogRow({
					entityId,
					dedupeKey: "key-a",
					createdAt: at(9),
				});
				expect(await has(entityId, "key-a")).toBe(true);
				expect(await has(entityId, "key-b")).toBe(false);

				await writeLogRow({
					entityId,
					dedupeKey: "key-b",
					createdAt: at(10),
				});
				expect(await has(entityId, "key-b")).toBe(true);
				// Not "the latest row": key-a's observation was already reported.
				expect(await has(entityId, "key-a")).toBe(true);
			});

			it("ignores SUCCESS rows, push rows, other stories and other projects", async () => {
				const entityId = nextEntity();
				await writeLogRow({
					entityId,
					dedupeKey: "key-a",
					createdAt: at(9),
				});
				// Positive control.
				expect(await has(entityId, "key-a")).toBe(true);

				await writeLogRow({
					entityId,
					dedupeKey: "key-b",
					createdAt: at(10),
					status: "SUCCESS",
				});
				await writeLogRow({
					entityId,
					dedupeKey: "key-c",
					createdAt: at(11),
					direction: "push",
				});
				expect(await has(entityId, "key-a")).toBe(true);
				expect(await has(entityId, "key-b")).toBe(false);
				expect(await has(entityId, "key-c")).toBe(false);
				expect(await has(nextEntity(), "key-a")).toBe(false);

				await writeLogRow({
					entityId,
					dedupeKey: "key-d",
					createdAt: at(12),
					projectId: OTHER_PROJECT,
				});
				expect(await has(entityId, "key-d", OTHER_PROJECT)).toBe(true);
				expect(await has(entityId, "key-d")).toBe(false);
				expect(await has(entityId, "key-a")).toBe(true);
			});

			it("a check-then-write cycle adds no row for an identical observation and one when the ticket date changes", async () => {
				const entityId = nextEntity();
				const labels = [
					"workflow::blocked",
					"workflow::in-review",
				].join(",");
				const keyFor = (changedAt: string) =>
					`${entityId}|${labels}|${changedAt}`;
				async function cycle(dedupeKey: string) {
					if (
						await hasPmSyncConflictWithDedupeKey({
							projectId: PROJECT,
							entityId,
							dedupeKey,
						})
					) {
						return;
					}
					await createPmSyncLog({
						direction: "pull",
						entityType: "STORY",
						entityId,
						title: "Two status labels",
						pmTool: "gitlab",
						status: "CONFLICT",
						errorPayload: {
							reason: "pm-status-ambiguous",
							dedupeKey,
						},
						organizationId: ORG,
						projectId: PROJECT,
					});
				}
				const conflictRows = () =>
					db.pmSyncLog.count({
						where: {
							projectId: PROJECT,
							entityId,
							status: "CONFLICT",
						},
					});

				await cycle(keyFor("2026-09-21T09:00:00.000Z"));
				expect(await conflictRows()).toBe(1);

				await cycle(keyFor("2026-09-21T09:00:00.000Z"));
				expect(await conflictRows()).toBe(1);

				await cycle(keyFor("2026-09-21T10:00:00.000Z"));
				expect(await conflictRows()).toBe(2);
			});

			it("an unrelated CONFLICT row between two identical ambiguous cycles does not re-raise the observation", async () => {
				const entityId = nextEntity();
				const dedupeKey = `${entityId}|workflow::blocked,workflow::in-review|2026-09-21T09:00:00.000Z`;
				async function cycle() {
					if (
						await hasPmSyncConflictWithDedupeKey({
							projectId: PROJECT,
							entityId,
							dedupeKey,
						})
					) {
						return;
					}
					await createPmSyncLog({
						direction: "pull",
						entityType: "STORY",
						entityId,
						title: "Two status labels",
						pmTool: "gitlab",
						status: "CONFLICT",
						errorPayload: {
							reason: "pm-status-ambiguous",
							dedupeKey,
						},
						organizationId: ORG,
						projectId: PROJECT,
					});
				}
				const rowsWithKey = () =>
					db.pmSyncLog.count({
						where: {
							projectId: PROJECT,
							entityId,
							status: "CONFLICT",
							errorPayload: {
								path: ["dedupeKey"],
								equals: dedupeKey,
							},
						},
					});

				await cycle();
				// Positive control: the first cycle reported the observation.
				expect(await rowsWithKey()).toBe(1);

				// Content drift raises its own CONFLICT pull row for the story —
				// newer than the ambiguous one, and with no dedupe key.
				await createPmSyncLog({
					direction: "pull",
					entityType: "STORY",
					entityId,
					title: "Two status labels",
					pmTool: "gitlab",
					status: "CONFLICT",
					errorPayload: { reason: "content-drift" },
					organizationId: ORG,
					projectId: PROJECT,
				});

				await cycle();
				expect(await rowsWithKey()).toBe(1);
				expect(
					await db.pmSyncLog.count({
						where: {
							projectId: PROJECT,
							entityId,
							status: "CONFLICT",
						},
					}),
				).toBe(2);
			});
		});

		describe("mergePmStatusSyncLastRun", () => {
			beforeEach(async () => {
				await db.project.update({
					where: { id: PROJECT },
					data: {
						pmStatusSyncEnabled: true,
						pmStatusSyncSessionAt: SESSION,
						pmStatusSyncLastRun: Prisma.DbNull,
					},
				});
			});

			it("merges each writer's piece under the current session and records the session", async () => {
				await mergePmStatusSyncLastRun({
					projectId: PROJECT,
					sessionAt: SESSION,
					patch: { fetch: fetchSummary(3) },
				});
				await mergePmStatusSyncLastRun({
					projectId: PROJECT,
					sessionAt: SESSION,
					patch: { outcome: outcomeSummary },
				});

				const stored = await readLastRun();
				expect(
					pmStatusSyncLastRunSchema.safeParse(stored).success,
				).toBe(true);
				expect(stored).toEqual({
					sessionAt: SESSION.toISOString(),
					fetch: fetchSummary(3),
					outcome: outcomeSummary,
				});
			});

			it("drops a write from an older session", async () => {
				await mergePmStatusSyncLastRun({
					projectId: PROJECT,
					sessionAt: SESSION,
					patch: { fetch: fetchSummary(3) },
				});
				// Positive control: the current session's write landed.
				expect(await readLastRun()).toMatchObject({
					fetch: { linked: 3 },
				});

				await mergePmStatusSyncLastRun({
					projectId: PROJECT,
					sessionAt: EARLIER_SESSION,
					patch: { fetch: fetchSummary(99) },
				});
				expect(await readLastRun()).toMatchObject({
					sessionAt: SESSION.toISOString(),
					fetch: { linked: 3 },
				});
			});

			it("drops a write while the switch is off", async () => {
				await mergePmStatusSyncLastRun({
					projectId: PROJECT,
					sessionAt: SESSION,
					patch: { fetch: fetchSummary(3) },
				});
				// Positive control.
				expect(await readLastRun()).toMatchObject({
					fetch: { linked: 3 },
				});

				await db.project.update({
					where: { id: PROJECT },
					data: { pmStatusSyncEnabled: false },
				});
				await mergePmStatusSyncLastRun({
					projectId: PROJECT,
					sessionAt: SESSION,
					patch: { fetch: fetchSummary(99) },
				});
				expect(await readLastRun()).toMatchObject({
					fetch: { linked: 3 },
				});
			});

			it("is non-fatal for a project that does not exist", async () => {
				await expect(
					mergePmStatusSyncLastRun({
						projectId: `pss-db-missing-${RUN}`,
						sessionAt: SESSION,
						patch: { fetch: fetchSummary(1) },
					}),
				).resolves.toBeUndefined();
			});
		});
	},
);
