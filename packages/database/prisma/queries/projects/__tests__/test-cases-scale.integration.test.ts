/**
 * Real-Postgres integration tests for the Test Case query layer AT SCALE — the
 * behaviors that only bite once a project holds more cases than one page.
 *
 * These are deliberately the assertions a mocked suite cannot make:
 *   - `listTestCases` orders in the DB, so a sort holds across the WHOLE result
 *     set. The seeding here is adversarial on purpose: the CRITICAL cases and
 *     the alphabetically-first titles are seeded LAST, so under the default
 *     `order` sort they sit at positions 141..150 — i.e. page 2. Anything that
 *     sorted the already-loaded page could never surface them on page 1.
 *   - every sort is tie-broken by `identifier`, making the ordering TOTAL. With
 *     135 rows sharing one priority (and 147 sharing a NULL `lastRunAt`),
 *     Postgres is free to return equal-key rows in a different order per query,
 *     so a paging reader could see a row twice or miss one. Paging the full set
 *     and demanding every id exactly once is what proves the tiebreak works.
 *   - `bulkMutateTestCases` in `filter` mode re-resolves the matching set
 *     server-side from the SAME predicate the list rendered (`buildTestCaseWhere`),
 *     so a "select all N matching" action covers every match rather than the
 *     ids the client happened to have paged in.
 *
 * No mocks — hits the live Aspire Postgres via the shared Prisma singleton.
 * Self-skips when DATABASE_URL is unset or is the CI placeholder
 * (`hasReachableDatabaseUrl`), mirroring the sibling integration suites.
 *
 * Run with: pnpm --filter @repo/database test prisma/queries/projects/__tests__/test-cases-scale.integration.test.ts
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasReachableDatabaseUrl } from "../../../../__tests__/_helpers/db-availability";
import { db, Prisma } from "../../../client";
import { bulkMutateTestCases } from "../test-case-bulk";
import { listTestCases, TEST_CASE_SORT_KEYS } from "../test-case-list";
import { addCaseToPlan, createTestPlan, listPlanCases } from "../test-plans";

const RUN_ID = `${Date.now()}-${process.pid}`;
const ORG_ID = `test-tcscale-org-${RUN_ID}`;
const USER_ID = `test-tcscale-user-${RUN_ID}`;

const PAGE = 100; // `listTestCases` default page size — the boundary under test.

/** Sort-fixture shape: 150 cases, more than one page. */
const SORT_TOTAL = 150;
const SORT_LOW_FROM = 136; // TC-136..TC-140 are the only LOW cases.
const SORT_CRITICAL_FROM = 141; // TC-141..TC-150 — seeded last, CRITICAL.

const pad3 = (n: number) => String(n).padStart(3, "0");
const pad2 = (n: number) => String(n).padStart(2, "0");

/** Distinct run dates for the three cases that have ever been run. */
const RUN_DATES = [
	new Date("2024-01-01T00:00:00.000Z"),
	new Date("2024-02-01T00:00:00.000Z"),
	new Date("2024-03-01T00:00:00.000Z"),
];

describe.skipIf(!hasReachableDatabaseUrl())(
	"Test Cases at scale — DB-side sort + bulk-by-filter (real Postgres)",
	() => {
		/** Read-only 150-case fixture; every sort/paging test reads this one. */
		const sortProjectId = `test-tcscale-proj-sort-${RUN_ID}`;
		/** Mutated by the bulk tests; partitioned by tag so they stay disjoint. */
		const bulkProjectId = `test-tcscale-proj-bulk-${RUN_ID}`;
		/** Proves selection is re-scoped to the project it was asked for. */
		const otherProjectId = `test-tcscale-proj-other-${RUN_ID}`;
		let otherCaseId: string;

		/** TC-141..TC-150 — CRITICAL, and last under the default `order` sort. */
		const criticalIds: string[] = [];
		/** Every id in the sort fixture, for the paging-totality check. */
		const sortAllIds: string[] = [];

		/** Bulk-fixture ids, keyed by the tag that partitions them. */
		const bulkIds: Record<string, string[]> = {};
		/** The two `scale-delete` cases carrying a mirrored context. */
		const deleteContextIds: string[] = [];

		async function seedCases(
			rows: Prisma.TestCaseCreateManyInput[],
		): Promise<void> {
			await db.testCase.createMany({ data: rows });
		}

		beforeAll(async () => {
			const now = new Date();
			await db.$executeRaw(Prisma.sql`
				INSERT INTO "user" (id, name, email, "emailVerified", "onboardingComplete", "createdAt", "updatedAt")
				VALUES (${USER_ID}, ${"Test Case Scale User"}, ${`${USER_ID}@test.com`}, true, false, ${now}, ${now})
				ON CONFLICT (id) DO NOTHING
			`);
			await db.$executeRaw(Prisma.sql`
				INSERT INTO "organization" (id, name, slug, "createdAt")
				VALUES (${ORG_ID}, ${"Test Case Scale Org"}, ${ORG_ID}, ${now})
				ON CONFLICT (id) DO NOTHING
			`);

			// Raw SQL (like the user/org rows above) rather than `project.create`:
			// the fixture only needs id/name/owner, and naming the columns keeps
			// the suite independent of unrelated churn elsewhere in the Project
			// model.
			for (const [id, name] of [
				[sortProjectId, "TC Scale Sort"],
				[bulkProjectId, "TC Scale Bulk"],
				[otherProjectId, "TC Scale Other"],
			]) {
				await db.$executeRaw(Prisma.sql`
					INSERT INTO "project" (id, name, "userId", "organizationId", "createdAt", "updatedAt")
					VALUES (${id}, ${name}, ${USER_ID}, ${ORG_ID}, ${now}, ${now})
					ON CONFLICT (id) DO NOTHING
				`);
			}

			// --- Sort fixture -------------------------------------------------
			// `order` and `identifier` are assigned exactly as `createTestCase`
			// would have (both increase with creation), so "seeded last" means
			// "highest order" — which under the default `order asc` sort means the
			// LAST page. The CRITICAL cases and the `A-…` titles get the tail of
			// that range deliberately: they are the rows a page-1 reader would
			// never have loaded, and therefore the rows a client-side sort over
			// the loaded page could never bring to the top.
			const sortRows: Prisma.TestCaseCreateManyInput[] = [];
			for (let n = 1; n <= SORT_TOTAL; n++) {
				const isCritical = n >= SORT_CRITICAL_FROM;
				const isLow = n >= SORT_LOW_FROM && n < SORT_CRITICAL_FROM;
				sortRows.push({
					projectId: sortProjectId,
					identifier: `TC-${pad3(n)}`,
					createdById: USER_ID,
					userId: USER_ID,
					organizationId: ORG_ID,
					// Titles sort into two blocks: the `A-critical-NN` tail comes
					// alphabetically first while sitting last by `order`.
					title: isCritical
						? `A-critical-${pad2(n - SORT_CRITICAL_FROM + 1)}`
						: `Z-filler-${pad3(n)}`,
					// 135 MEDIUM rows share one priority key — without the
					// `identifier` tiebreak their relative order is undefined.
					priority: isCritical
						? "CRITICAL"
						: isLow
							? "LOW"
							: "MEDIUM",
					order: n,
					// Only TC-001..TC-003 have ever run; the other 147 are NULL.
					lastRunAt: n <= RUN_DATES.length ? RUN_DATES[n - 1] : null,
					lastRunSource: n <= RUN_DATES.length ? "MANUAL" : null,
				});
			}
			await seedCases(sortRows);
			const sortSeeded = await db.testCase.findMany({
				where: { projectId: sortProjectId },
				select: { id: true, identifier: true },
			});
			for (const row of sortSeeded) {
				sortAllIds.push(row.id);
				if (Number(row.identifier.slice(3)) >= SORT_CRITICAL_FROM) {
					criticalIds.push(row.id);
				}
			}

			// --- Bulk fixture -------------------------------------------------
			// Each tag is an independent slice, so no bulk test can observe or
			// disturb another's rows regardless of execution order.
			const bulkPlan: Array<{ tag: string; count: number }> = [
				// > one page, so an id-list bulk could only ever have named 100.
				{ tag: "scale-set-state", count: 105 },
				{ tag: "scale-prio", count: 8 }, // the project's only HIGH cases
				{ tag: "scale-ids", count: 6 },
				{ tag: "scale-cross", count: 1 },
				{ tag: "scale-delete", count: 4 },
				{ tag: "scale-plan", count: 3 },
				{ tag: "scale-plan-filter", count: 5 },
			];
			const bulkRows: Prisma.TestCaseCreateManyInput[] = [];
			let seq = 0;
			for (const { tag, count } of bulkPlan) {
				for (let i = 0; i < count; i++) {
					seq += 1;
					bulkRows.push({
						projectId: bulkProjectId,
						identifier: `TC-${pad3(seq)}`,
						createdById: USER_ID,
						userId: USER_ID,
						organizationId: ORG_ID,
						title: `${tag}-${pad3(i + 1)}`,
						state: "DRAFT",
						priority: tag === "scale-prio" ? "HIGH" : "MEDIUM",
						tags: [tag],
						order: seq,
						// Two of the delete slice mirror into a ProjectContext, so
						// DELETE has something to hand back for teardown.
						contextId:
							tag === "scale-delete" && i < 2
								? `ctx-${RUN_ID}-${i}`
								: null,
					});
				}
			}
			await seedCases(bulkRows);
			const bulkSeeded = await db.testCase.findMany({
				where: { projectId: bulkProjectId },
				select: { id: true, tags: true, contextId: true },
				orderBy: { order: "asc" },
			});
			for (const row of bulkSeeded) {
				const tag = row.tags[0];
				const slice = bulkIds[tag] ?? [];
				slice.push(row.id);
				bulkIds[tag] = slice;
				if (tag === "scale-delete" && row.contextId) {
					deleteContextIds.push(row.contextId);
				}
			}

			const otherCase = await db.testCase.create({
				data: {
					projectId: otherProjectId,
					identifier: "TC-001",
					createdById: USER_ID,
					userId: USER_ID,
					organizationId: ORG_ID,
					title: "Foreign project case",
					state: "DRAFT",
					order: 1,
				},
				select: { id: true },
			});
			otherCaseId = otherCase.id;
		}, 60_000);

		afterAll(async () => {
			// Steps / links / plan memberships / result events all cascade from
			// test_case; plans and projects are removed explicitly.
			await db.testCase.deleteMany({ where: { createdById: USER_ID } });
			await db.testPlan.deleteMany({ where: { createdById: USER_ID } });
			await db.project.deleteMany({ where: { userId: USER_ID } });
			await db.organization.deleteMany({ where: { id: ORG_ID } });
			await db.user.deleteMany({ where: { id: USER_ID } });
		});

		// -------------------------------------------------------------------
		// 1. Sort holds across the whole result set
		// -------------------------------------------------------------------

		it("surfaces last-page CRITICAL cases on page 1 under sort:priority", async () => {
			// Baseline: under the default `order` sort the ten CRITICAL cases are
			// at positions 141..150 — provably NOT on page 1. Any implementation
			// that re-sorted the loaded page would be sorting a set that does not
			// contain a single one of them.
			const defaultPage1 = await listTestCases({
				projectId: sortProjectId,
				limit: PAGE,
				offset: 0,
			});
			expect(defaultPage1.total).toBe(SORT_TOTAL);
			expect(defaultPage1.items).toHaveLength(PAGE);
			const defaultPage1Ids = new Set(
				defaultPage1.items.map((i) => i.id),
			);
			expect(criticalIds.filter((id) => defaultPage1Ids.has(id))).toEqual(
				[],
			);

			// The fix: ordering happens in the DB, so page 1 of the priority sort
			// leads with every CRITICAL case despite them being seeded last.
			const byPriority = await listTestCases({
				projectId: sortProjectId,
				sort: "priority",
				limit: PAGE,
				offset: 0,
			});
			expect(byPriority.total).toBe(SORT_TOTAL);
			const priorityPage1Ids = new Set(byPriority.items.map((i) => i.id));
			for (const id of criticalIds) {
				expect(priorityPage1Ids.has(id)).toBe(true);
			}
			// They lead the page — CRITICAL is the top of the enum, desc default.
			expect(
				byPriority.items
					.slice(0, criticalIds.length)
					.map((i) => i.priority),
			).toEqual(criticalIds.map(() => "CRITICAL"));
		});

		it("sorts by title across the whole set, not the page", async () => {
			const asc = await listTestCases({
				projectId: sortProjectId,
				sort: "title",
				limit: PAGE,
				offset: 0,
			});
			// `A-critical-01` has order 141: last page by default, first by title.
			expect(asc.items[0].title).toBe("A-critical-01");
			expect(asc.items[0].order).toBe(SORT_CRITICAL_FROM);

			const desc = await listTestCases({
				projectId: sortProjectId,
				sort: "title",
				direction: "desc",
				limit: PAGE,
				offset: 0,
			});
			expect(desc.items[0].title).toBe(
				`Z-filler-${pad3(SORT_TOTAL - 10)}`,
			);
		});

		it("honours `direction` for priority and title", async () => {
			const priorityAsc = await listTestCases({
				projectId: sortProjectId,
				sort: "priority",
				direction: "asc",
				limit: PAGE,
			});
			expect(priorityAsc.items[0].priority).toBe("LOW");
			const priorityDesc = await listTestCases({
				projectId: sortProjectId,
				sort: "priority",
				direction: "desc",
				limit: PAGE,
			});
			expect(priorityDesc.items[0].priority).toBe("CRITICAL");

			const titleAsc = await listTestCases({
				projectId: sortProjectId,
				sort: "title",
				direction: "asc",
				limit: PAGE,
			});
			const titleDesc = await listTestCases({
				projectId: sortProjectId,
				sort: "title",
				direction: "desc",
				limit: PAGE,
			});
			expect(titleAsc.items[0].title).not.toBe(titleDesc.items[0].title);
			expect(
				titleAsc.items[0].title.localeCompare(titleDesc.items[0].title),
			).toBeLessThan(0);
		});

		it.each(TEST_CASE_SORT_KEYS)(
			"pages the full set under sort:%s with no duplicates and no omissions",
			async (sort) => {
				const seen: string[] = [];
				for (let offset = 0; offset < SORT_TOTAL; offset += PAGE) {
					const page = await listTestCases({
						projectId: sortProjectId,
						sort,
						limit: PAGE,
						offset,
					});
					expect(page.total).toBe(SORT_TOTAL);
					seen.push(...page.items.map((i) => i.id));
				}
				// 135 rows share one priority and 147 share a NULL lastRunAt — the
				// `identifier` tiebreak is the only thing making these orderings
				// total, and therefore the only thing making paging safe.
				expect(seen).toHaveLength(SORT_TOTAL);
				expect(new Set(seen).size).toBe(SORT_TOTAL);
				expect(new Set(seen)).toEqual(new Set(sortAllIds));
			},
		);

		it("sorts never-run cases last under sort:recentRun in BOTH directions", async () => {
			for (const direction of ["desc", "asc"] as const) {
				const all = await listTestCases({
					projectId: sortProjectId,
					sort: "recentRun",
					direction,
					limit: SORT_TOTAL,
				});
				expect(all.items).toHaveLength(SORT_TOTAL);

				const runDates = all.items
					.slice(0, RUN_DATES.length)
					.map((i) => i.lastRunAt);
				expect(runDates.every((d) => d !== null)).toBe(true);
				// Postgres puts NULLs FIRST on DESC by default; `nulls: "last"` is
				// what keeps never-run cases off the top of "most recently run".
				expect(
					all.items
						.slice(RUN_DATES.length)
						.every((i) => i.lastRunAt === null),
				).toBe(true);

				const expected =
					direction === "desc" ? [...RUN_DATES].reverse() : RUN_DATES;
				expect(runDates.map((d) => d?.toISOString())).toEqual(
					expected.map((d) => d.toISOString()),
				);
			}
		});

		// -------------------------------------------------------------------
		// 2. Bulk by filter hits every match
		// -------------------------------------------------------------------

		it("SET_STATE by filter affects every match beyond the first page", async () => {
			const tag = "scale-set-state";
			const expected = bulkIds[tag].length;
			expect(expected).toBeGreaterThan(PAGE);

			// A page-of-ids bulk could only ever have named these 100.
			const page1 = await listTestCases({
				projectId: bulkProjectId,
				tag,
			});
			expect(page1.items).toHaveLength(PAGE);
			expect(page1.total).toBe(expected);

			const result = await bulkMutateTestCases({
				projectId: bulkProjectId,
				selection: { mode: "filter", filter: { tag } },
				operation: { type: "SET_STATE", state: "READY" },
				actingUserId: USER_ID,
			});
			expect(result.affected).toBe(expected);
			expect(result.contextIds).toEqual([]);

			// Re-query rather than trusting the return value.
			const ready = await listTestCases({
				projectId: bulkProjectId,
				tag,
				state: "READY",
			});
			expect(ready.total).toBe(expected);
			const draft = await listTestCases({
				projectId: bulkProjectId,
				tag,
				state: "DRAFT",
			});
			expect(draft.total).toBe(0);
		});

		it("filter-mode selection resolves the same set as the list's own predicate", async () => {
			// Both compile through `buildTestCaseWhere`; this is what stops them
			// drifting apart.
			const filter = { priority: "HIGH" } as const;
			const list = await listTestCases({
				projectId: bulkProjectId,
				...filter,
			});

			const result = await bulkMutateTestCases({
				projectId: bulkProjectId,
				selection: { mode: "filter", filter },
				operation: { type: "SET_STATE", state: "READY" },
				actingUserId: USER_ID,
			});

			expect(result.affected).toBe(list.total);
			expect(new Set(result.ids)).toEqual(
				new Set(list.items.map((i) => i.id)),
			);
			expect(new Set(result.ids)).toEqual(new Set(bulkIds["scale-prio"]));
		});

		it("ids-mode touches only the given ids", async () => {
			const slice = bulkIds["scale-ids"];
			const targeted = slice.slice(0, 2);

			const result = await bulkMutateTestCases({
				projectId: bulkProjectId,
				selection: { mode: "ids", ids: targeted },
				operation: { type: "SET_STATE", state: "READY" },
				actingUserId: USER_ID,
			});
			expect(result.affected).toBe(2);

			const rows = await db.testCase.findMany({
				where: { id: { in: slice } },
				select: { id: true, state: true },
			});
			for (const row of rows) {
				expect(row.state).toBe(
					targeted.includes(row.id) ? "READY" : "DRAFT",
				);
			}
		});

		it("drops an id from another project instead of mutating it", async () => {
			const mine = bulkIds["scale-cross"][0];

			const result = await bulkMutateTestCases({
				projectId: bulkProjectId,
				selection: { mode: "ids", ids: [mine, otherCaseId] },
				operation: { type: "SET_STATE", state: "READY" },
				actingUserId: USER_ID,
			});

			// The caller's id list is never trusted as authorization — the foreign
			// id silently drops out of the resolved selection.
			expect(result.ids).toEqual([mine]);
			expect(result.affected).toBe(1);

			const foreign = await db.testCase.findUniqueOrThrow({
				where: { id: otherCaseId },
				select: { state: true, projectId: true },
			});
			expect(foreign.state).toBe("DRAFT");
			expect(foreign.projectId).toBe(otherProjectId);
		});

		it("DELETE soft-deletes, returns mirrored contextIds, and drops from the list", async () => {
			const tag = "scale-delete";
			const slice = bulkIds[tag];

			const result = await bulkMutateTestCases({
				projectId: bulkProjectId,
				selection: { mode: "filter", filter: { tag } },
				operation: { type: "DELETE" },
				actingUserId: USER_ID,
			});
			expect(result.affected).toBe(slice.length);
			// Only the two cases that mirrored into a ProjectContext come back.
			expect(new Set(result.contextIds)).toEqual(
				new Set(deleteContextIds),
			);
			expect(result.contextIds).toHaveLength(2);

			const after = await listTestCases({
				projectId: bulkProjectId,
				tag,
			});
			expect(after.total).toBe(0);
			expect(after.items).toEqual([]);

			// Soft, not hard: the rows survive with `deletedAt` stamped.
			const rows = await db.testCase.findMany({
				where: { id: { in: slice } },
				select: { deletedAt: true },
			});
			expect(rows).toHaveLength(slice.length);
			expect(rows.every((r) => r.deletedAt !== null)).toBe(true);

			// And a deleted id can no longer be selected back into a mutation.
			const replay = await bulkMutateTestCases({
				projectId: bulkProjectId,
				selection: { mode: "ids", ids: slice },
				operation: { type: "SET_STATE", state: "READY" },
				actingUserId: USER_ID,
			});
			expect(replay.affected).toBe(0);
			expect(replay.ids).toEqual([]);
		});

		it("ADD_TO_PLAN is idempotent — the second run adds nothing and does not throw", async () => {
			const tag = "scale-plan";
			const plan = await createTestPlan({
				projectId: bulkProjectId,
				createdById: USER_ID,
				name: "Idempotency plan",
				userId: USER_ID,
				organizationId: ORG_ID,
			});

			const first = await bulkMutateTestCases({
				projectId: bulkProjectId,
				selection: { mode: "filter", filter: { tag } },
				operation: { type: "ADD_TO_PLAN", planId: plan.id },
				actingUserId: USER_ID,
			});
			expect(first.affected).toBe(bulkIds[tag].length);

			// (planId, testCaseId) is UNIQUE — a blind re-add would abort on P2002.
			const second = await bulkMutateTestCases({
				projectId: bulkProjectId,
				selection: { mode: "filter", filter: { tag } },
				operation: { type: "ADD_TO_PLAN", planId: plan.id },
				actingUserId: USER_ID,
			});
			expect(second.affected).toBe(0);
			expect(new Set(second.ids)).toEqual(new Set(bulkIds[tag]));

			const members = await listPlanCases(plan.id);
			expect(members).toHaveLength(bulkIds[tag].length);
		});

		// A caller only ever proves rights over the PROJECT. The selection
		// resolver re-scopes the case ids to it, but `planId` arrives straight
		// from the request — so without a matching guard on the plan, rights on
		// one project would be enough to file its cases into another tenant's
		// plan, where that tenant's plan detail would render them.
		it("ADD_TO_PLAN refuses a plan belonging to another project", async () => {
			const foreignPlan = await createTestPlan({
				projectId: otherProjectId,
				createdById: USER_ID,
				name: "Another project's plan",
				userId: USER_ID,
				organizationId: ORG_ID,
			});

			const result = await bulkMutateTestCases({
				projectId: bulkProjectId,
				selection: { mode: "ids", ids: bulkIds["scale-cross"] },
				operation: { type: "ADD_TO_PLAN", planId: foreignPlan.id },
				actingUserId: USER_ID,
			});

			expect(result.affected).toBe(0);
			// The decisive assertion: nothing was filed into the other project's
			// plan, so its detail view cannot surface a foreign case.
			await expect(listPlanCases(foreignPlan.id)).resolves.toEqual([]);
		});

		it("ADD_TO_PLAN refuses a soft-deleted plan", async () => {
			const plan = await createTestPlan({
				projectId: bulkProjectId,
				createdById: USER_ID,
				name: "Retired plan",
				userId: USER_ID,
				organizationId: ORG_ID,
			});
			await db.testPlan.update({
				where: { id: plan.id },
				data: { deletedAt: new Date() },
			});

			const result = await bulkMutateTestCases({
				projectId: bulkProjectId,
				selection: { mode: "ids", ids: bulkIds["scale-cross"] },
				operation: { type: "ADD_TO_PLAN", planId: plan.id },
				actingUserId: USER_ID,
			});

			expect(result.affected).toBe(0);
			await expect(listPlanCases(plan.id)).resolves.toEqual([]);
		});

		// -------------------------------------------------------------------
		// 3. planId filter
		// -------------------------------------------------------------------

		it("filters by planId to exactly the plan's cases", async () => {
			const slice = bulkIds["scale-plan-filter"];
			const members = slice.slice(0, 3);
			const plan = await createTestPlan({
				projectId: bulkProjectId,
				createdById: USER_ID,
				name: "Filter plan",
				userId: USER_ID,
				organizationId: ORG_ID,
			});
			for (const testCaseId of members) {
				await addCaseToPlan({ planId: plan.id, testCaseId });
			}

			const list = await listTestCases({
				projectId: bulkProjectId,
				planId: plan.id,
			});
			expect(list.total).toBe(members.length);
			expect(new Set(list.items.map((i) => i.id))).toEqual(
				new Set(members),
			);
		});
	},
);
