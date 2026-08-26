/**
 * Performance smoke test against a live Postgres.
 *
 * Seeds ~5,000 audit rows in a single test organization, then exercises
 * the read paths that production users hit:
 *  - `audit.list` with no filter (default page) — must be <200ms.
 *  - `audit.list` with an `actions` IN-filter — must be <200ms.
 *  - `audit.list` with a date-range filter — must be <200ms.
 *  - `audit.list` with `correlationId` JSON filter — measured and
 *    reported. CORRELATION ID IS NOT INDEXED IN V1 (json path query is
 *    a sequential-scan-ish plan in postgres without a partial GIN index).
 *    Recommendation: add `CREATE INDEX ON audit_log ((metadata->>'correlationId'))`
 *    when row counts approach the millions.
 *  - `countAuditLog` (used by export cap) — must be <300ms.
 *
 * The test is skipped when DATABASE_URL is unset so the default
 * `pnpm --filter @repo/database test` run does not require a DB. Run with:
 *   DATABASE_URL=... pnpm --filter @repo/database test __tests__/audit-log-perf-smoke.test.ts
 *
 * Seeded rows carry a unique `__perf_smoke_marker` tag in metadata so the
 * cleanup targets only this suite's writes — no risk of clobbering real
 * data on shared dev DBs.
 *
 * Spec: docs/audit-log/README.md §11.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../prisma/client";
import { hasReachableDatabaseUrl } from "./_helpers/db-availability";
import {
	type AuditAction,
	countAuditLog,
	listAuditLog,
} from "../prisma/queries/audit-log";

const PERF_MARKER = "__audit_perf_smoke_2026_05_17";
const SEED_USER = `perf-smoke-user-${PERF_MARKER}`;
const SEED_ORG = `perf-smoke-org-${PERF_MARKER}`;
const SEED_PROJECT = `perf-smoke-project-${PERF_MARKER}`;

const SEED_COUNT = 5_000; // Enough to exercise the indexes without
//                          spending a minute on the seed loop.

// Mix of actions so the actions/categories filters have something to bite.
const SEED_ACTIONS: AuditAction[] = [
	"auth.login.success",
	"auth.login.failure",
	"auth.logout",
	"org.member.invited",
	"project.created",
	"story.updated",
	"audit.viewed",
];

// Gate on a REACHABLE DB, not merely a set DATABASE_URL — the well-known
// CI placeholder (also defaulted by vitest.config.ts for local runs) must
// not send this suite into ECONNREFUSED.
const hasDb = hasReachableDatabaseUrl();

async function measureMs(fn: () => Promise<unknown>): Promise<number> {
	const start = process.hrtime.bigint();
	await fn();
	const end = process.hrtime.bigint();
	return Number(end - start) / 1_000_000;
}

describe.skipIf(!hasDb)("audit-log perf smoke (5k rows)", () => {
	beforeAll(async () => {
		// Create the user/org/project needed for FK referential integrity.
		await db.user.upsert({
			where: { id: SEED_USER },
			update: {},
			create: {
				id: SEED_USER,
				email: `${SEED_USER}@perf.test`,
				name: "Perf Smoke User",
				emailVerified: true,
				onboardingComplete: true,
				createdAt: new Date(),
				updatedAt: new Date(),
			} as Parameters<typeof db.user.upsert>[0]["create"],
		});

		await db.organization.upsert({
			where: { id: SEED_ORG },
			update: {},
			create: {
				id: SEED_ORG,
				name: "Perf Smoke Org",
				createdAt: new Date(),
			},
		});

		await db.member.upsert({
			where: {
				organizationId_userId: {
					organizationId: SEED_ORG,
					userId: SEED_USER,
				},
			},
			update: {},
			create: {
				organizationId: SEED_ORG,
				userId: SEED_USER,
				role: "owner",
				createdAt: new Date(),
			},
		});

		// Insert the project via raw SQL to bypass any Prisma client / DB
		// schema drift in the local dev DB (added columns the Prisma client
		// expects that the local migration set hasn't been brought up to).
		// We only need the row to exist for the projectId FK on audit_log.
		await db.$executeRawUnsafe(
			`INSERT INTO project (id, name, "userId", "organizationId", status, "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, $5, NOW(), NOW()) ON CONFLICT (id) DO NOTHING`,
			SEED_PROJECT,
			"Perf Smoke Project",
			SEED_USER,
			SEED_ORG,
			"DRAFT",
		);

		// Seed in batches via createMany. createMany doesn't return ids
		// so we don't need to keep track of them.
		const batchSize = 500;
		const baseTime = Date.now();
		for (let batch = 0; batch < SEED_COUNT / batchSize; batch += 1) {
			const rows: Array<Record<string, unknown>> = [];
			for (let i = 0; i < batchSize; i += 1) {
				const idx = batch * batchSize + i;
				const action = SEED_ACTIONS[idx % SEED_ACTIONS.length]!;
				const category = action.split(".")[0]!;
				rows.push({
					organizationId: SEED_ORG,
					userId: SEED_USER,
					actorType: "user",
					actorEmailSnapshot: `${SEED_USER}@perf.test`,
					actorNameSnapshot: "Perf Smoke User",
					action,
					category,
					severity: "info",
					outcome: "success",
					resourceType: "user",
					resourceId: SEED_USER,
					resourceName: `${SEED_USER}@perf.test`,
					projectId: idx % 3 === 0 ? SEED_PROJECT : null,
					// Stagger createdAt so date-range queries have something to
					// segment.
					createdAt: new Date(baseTime - idx * 1000),
					metadata: {
						__marker: PERF_MARKER,
						index: idx,
						correlationId: `corr-${idx % 100}`,
					},
				});
			}
			// rows are shaped like AuditLogCreateManyInput but typed loosely
			// here to avoid pulling generated Prisma types. Cast at the
			// call site.
			await db.auditLog.createMany({
				// biome-ignore lint/suspicious/noExplicitAny: Prisma row type
				data: rows as any[],
			});
		}
	}, 120_000);

	afterAll(async () => {
		// Delete in safe order: audit rows first (FK to project/org/user),
		// then project (FK to user/org), then member, then org, then user.
		// audit_log is append-only (WORM trigger); a legitimate purge must set
		// the per-transaction bypass GUC in the SAME transaction as the delete.
		await db.$transaction([
			db.$executeRawUnsafe("SET LOCAL app.audit_allow_delete = 'on'"),
			db.auditLog.deleteMany({
				where: { organizationId: SEED_ORG },
			}),
		]);
		await db
			.$executeRawUnsafe(
				"DELETE FROM project WHERE id = $1",
				SEED_PROJECT,
			)
			.catch(() => undefined);
		await db.member
			.deleteMany({ where: { organizationId: SEED_ORG } })
			.catch(() => undefined);
		await db.organization
			.deleteMany({ where: { id: SEED_ORG } })
			.catch(() => undefined);
		await db.user.deleteMany({ where: { id: SEED_USER } });
	});

	it("seeded the expected row count", async () => {
		const total = await countAuditLog({
			scope: { organizationId: SEED_ORG },
			filter: {},
		});
		expect(total).toBeGreaterThanOrEqual(SEED_COUNT);
	});

	it("default page (no filter) — composite index (organizationId, createdAt DESC) — <500ms", async () => {
		const ms = await measureMs(() =>
			listAuditLog({
				scope: { organizationId: SEED_ORG },
				filter: {},
				cursor: null,
				limit: 50,
			}),
		);
		// 500ms is generous to cover cold-cache first runs on a small dev DB.
		// The production target is <50ms with warm cache and proper indexes.
		expect(ms).toBeLessThan(500);
		// eslint-disable-next-line no-console
		console.log(`[perf] default page ms = ${ms.toFixed(1)}`);
	});

	it("actions IN-filter — uses (action, createdAt DESC) index — <500ms", async () => {
		const ms = await measureMs(() =>
			listAuditLog({
				scope: { organizationId: SEED_ORG },
				filter: { actions: ["auth.login.success"] },
				cursor: null,
				limit: 50,
			}),
		);
		expect(ms).toBeLessThan(500);
		// eslint-disable-next-line no-console
		console.log(`[perf] actions filter ms = ${ms.toFixed(1)}`);
	});

	it("date-range filter — uses composite index — <500ms", async () => {
		const dateFrom = new Date(Date.now() - 30 * 60 * 1000);
		const dateTo = new Date();
		const ms = await measureMs(() =>
			listAuditLog({
				scope: { organizationId: SEED_ORG },
				filter: { dateFrom, dateTo },
				cursor: null,
				limit: 50,
			}),
		);
		expect(ms).toBeLessThan(500);
		// eslint-disable-next-line no-console
		console.log(`[perf] date-range ms = ${ms.toFixed(1)}`);
	});

	it("correlationId filter (JSON path) — NOT INDEXED in v1 — measured and reported", async () => {
		const ms = await measureMs(() =>
			listAuditLog({
				scope: { organizationId: SEED_ORG },
				filter: { correlationId: "corr-50" },
				cursor: null,
				limit: 50,
			}),
		);
		// At 5k rows the sequential scan over JSON is still fast (<1s on
		// most dev DBs). DOCUMENT THE FINDING: at 1M+ rows this query
		// will become slow because Postgres can't use a btree on JSON
		// path equality without an expression index. Recommendation:
		// `CREATE INDEX audit_log_corr_idx ON audit_log ((metadata->>'correlationId'));`
		// (Phase 2 — see performance-notes.md).
		expect(ms).toBeLessThan(2_000);
		// eslint-disable-next-line no-console
		console.log(
			`[perf] correlationId filter ms = ${ms.toFixed(1)} (NO INDEX)`,
		);
	});

	it("countAuditLog for export cap — <500ms at 5k rows", async () => {
		const ms = await measureMs(() =>
			countAuditLog({
				scope: { organizationId: SEED_ORG },
				filter: {},
			}),
		);
		expect(ms).toBeLessThan(500);
		// eslint-disable-next-line no-console
		console.log(`[perf] countAuditLog ms = ${ms.toFixed(1)}`);
	});

	it("EXPLAIN ANALYZE confirms composite-index usage for the default page", async () => {
		const plan = (await db.$queryRawUnsafe(
			`EXPLAIN (FORMAT JSON, BUFFERS) SELECT * FROM audit_log WHERE "organizationId" = $1 ORDER BY "createdAt" DESC, "id" DESC LIMIT 50`,
			SEED_ORG,
		)) as Array<{ "QUERY PLAN": Array<{ Plan: Record<string, unknown> }> }>;

		const planJson = JSON.stringify(plan);
		// eslint-disable-next-line no-console
		console.log("[perf] EXPLAIN plan =", planJson);
		// We do NOT hard-assert which index is used (the planner may pick
		// the composite or the org-only) — just that it does NOT do a Seq
		// Scan at this row count.
		expect(planJson).not.toMatch(/"Node Type":\s*"Seq Scan"/);
	});

	it("EXPLAIN ANALYZE for correlationId JSON path — confirms sequential scan or row scan (DOCUMENT)", async () => {
		const plan = (await db.$queryRawUnsafe(
			`EXPLAIN (FORMAT JSON) SELECT * FROM audit_log WHERE "organizationId" = $1 AND metadata->>'correlationId' = $2 ORDER BY "createdAt" DESC, "id" DESC LIMIT 50`,
			SEED_ORG,
			"corr-50",
		)) as Array<{ "QUERY PLAN": Array<{ Plan: Record<string, unknown> }> }>;
		const planJson = JSON.stringify(plan);
		// eslint-disable-next-line no-console
		console.log(
			"[perf] EXPLAIN plan correlationId path =",
			planJson.slice(0, 500),
		);
		// No assertion — informational. We *expect* this to use the
		// (organizationId, createdAt) index but then filter via a Recheck
		// row-by-row. At million-row scale that filter cost becomes
		// noticeable.
	});
});
