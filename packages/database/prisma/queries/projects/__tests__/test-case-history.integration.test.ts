/**
 * Real-Postgres integration tests for the test-case history tables:
 *   - `test_case_activity` — the per-case edit audit written by createTestCase /
 *     updateTestCase, read back by `listTestCaseActivity`.
 *   - `qa_analysis_version` — the QA-analysis snapshot written by `setQaAnalysis`
 *     in the same transaction as the current-blob write, read by
 *     `listQaAnalysisVersions`.
 *
 * These are the assertions a mocked suite cannot make, because the contract IS
 * the SQL: the CREATED birth event, the field diff on update, the version
 * insert being atomic with (and scoped to) the story update, and the
 * project-scoping of both readers.
 *
 * No mocks — hits the live Aspire Postgres via the shared Prisma singleton.
 * Self-skips when DATABASE_URL is unset or is the CI placeholder.
 *
 * Run with: pnpm --filter @repo/database test:integration
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasReachableDatabaseUrl } from "../../../../__tests__/_helpers/db-availability";
import { db, Prisma } from "../../../client";
import {
	listQaAnalysisVersions,
	setQaAnalysis,
} from "../../feature-maturation";
import { listTestCaseActivity } from "../test-case-activity";
import { createTestCase, updateTestCase } from "../test-cases";

const RUN_ID = `${Date.now()}-${process.pid}`;
const ORG_ID = `test-tch-org-${RUN_ID}`;
const USER_ID = `test-tch-user-${RUN_ID}`;
const PROJECT_ID = `test-tch-proj-${RUN_ID}`;
const OTHER_PROJECT_ID = `test-tch-proj-other-${RUN_ID}`;
const PROJECT_IDS = [PROJECT_ID, OTHER_PROJECT_ID];
const STATUS_ID = `test-tch-status-${RUN_ID}`;
const STORY_ID = `test-tch-story-${RUN_ID}`;

describe.skipIf(!hasReachableDatabaseUrl())(
	"TestCase history tables (real Postgres)",
	() => {
		beforeAll(async () => {
			const now = new Date();
			await db.$executeRaw(Prisma.sql`
				INSERT INTO "user" (id, name, email, "emailVerified", "onboardingComplete", "createdAt", "updatedAt")
				VALUES (${USER_ID}, ${"History User"}, ${`${USER_ID}@test.com`}, true, false, ${now}, ${now})
				ON CONFLICT (id) DO NOTHING
			`);
			await db.$executeRaw(Prisma.sql`
				INSERT INTO "organization" (id, name, slug, "createdAt")
				VALUES (${ORG_ID}, ${"History Org"}, ${ORG_ID}, ${now})
				ON CONFLICT (id) DO NOTHING
			`);
			for (const [id, name] of [
				[PROJECT_ID, "History Project"],
				[OTHER_PROJECT_ID, "History Other Project"],
			]) {
				await db.$executeRaw(Prisma.sql`
					INSERT INTO "project" (id, name, "userId", "organizationId", "createdAt", "updatedAt")
					VALUES (${id}, ${name}, ${USER_ID}, ${ORG_ID}, ${now}, ${now})
					ON CONFLICT (id) DO NOTHING
				`);
			}
			await db.projectStoryStatus.create({
				data: {
					id: STATUS_ID,
					projectId: PROJECT_ID,
					name: "Backlog",
					color: "#000000",
					order: 1,
					isDefault: true,
				},
			});
			await db.userStory.create({
				data: {
					id: STORY_ID,
					projectId: PROJECT_ID,
					statusId: STATUS_ID,
					identifier: "F-001",
					title: "History feature",
					createdById: USER_ID,
				},
			});
		}, 60_000);

		afterAll(async () => {
			// test_case_activity + qa_analysis_version cascade from their parents.
			await db.testCase.deleteMany({
				where: { projectId: { in: PROJECT_IDS } },
			});
			await db.qaAnalysisVersion.deleteMany({
				where: { projectId: { in: PROJECT_IDS } },
			});
			await db.userStory.deleteMany({
				where: { projectId: { in: PROJECT_IDS } },
			});
			await db.projectStoryStatus.deleteMany({
				where: { projectId: { in: PROJECT_IDS } },
			});
			await db.project.deleteMany({ where: { id: { in: PROJECT_IDS } } });
			await db.organization.deleteMany({ where: { id: ORG_ID } });
			await db.user.deleteMany({ where: { id: USER_ID } });
		});

		function newCase(title = "A case") {
			return createTestCase({
				projectId: PROJECT_ID,
				createdById: USER_ID,
				userId: USER_ID,
				organizationId: ORG_ID,
				title,
				state: "DRAFT",
				priority: "MEDIUM",
			});
		}

		describe("test_case_activity", () => {
			it("records a CREATED birth event on create, attributed to the author", async () => {
				const tc = await newCase("Birth event");
				const { items: events } = await listTestCaseActivity({
					projectId: PROJECT_ID,
					testCaseId: tc.id,
				});
				expect(events).toHaveLength(1);
				expect(events[0]).toMatchObject({
					type: "CREATED",
					actorUserId: USER_ID,
					actorName: "History User",
				});
			});

			it("records a field diff on update — and nothing for a no-op save", async () => {
				const tc = await newCase("Diff me");

				// A real change: state + priority + title.
				await updateTestCase({
					id: tc.id,
					projectId: PROJECT_ID,
					data: {
						state: "READY",
						priority: "CRITICAL",
						title: "Diffed",
					},
					actorUserId: USER_ID,
				});
				// A no-op: same values again.
				await updateTestCase({
					id: tc.id,
					projectId: PROJECT_ID,
					data: {
						state: "READY",
						priority: "CRITICAL",
						title: "Diffed",
					},
					actorUserId: USER_ID,
				});

				const { items: events } = await listTestCaseActivity({
					projectId: PROJECT_ID,
					testCaseId: tc.id,
				});
				// CREATED + three change events; the no-op save added nothing.
				const types = events.map((e) => e.type).sort();
				expect(types).toEqual([
					"CREATED",
					"PRIORITY_CHANGED",
					"RENAMED",
					"STATE_CHANGED",
				]);
				const state = events.find((e) => e.type === "STATE_CHANGED");
				expect(state).toMatchObject({
					fromValue: "DRAFT",
					toValue: "READY",
				});
			});

			it("returns newest first and scopes to the project", async () => {
				const tc = await newCase("Scoped");
				await updateTestCase({
					id: tc.id,
					projectId: PROJECT_ID,
					data: { state: "READY" },
					actorUserId: USER_ID,
				});

				const { items: events } = await listTestCaseActivity({
					projectId: PROJECT_ID,
					testCaseId: tc.id,
				});
				// STATE_CHANGED (newest) before CREATED.
				expect(events[0]?.type).toBe("STATE_CHANGED");
				expect(events[1]?.type).toBe("CREATED");

				// A wrong project resolves to nothing — the case isn't in it.
				const { items: crossProject } = await listTestCaseActivity({
					projectId: OTHER_PROJECT_ID,
					testCaseId: tc.id,
				});
				expect(crossProject).toEqual([]);
			});

			it("pages with limit/offset and reports the untruncated total", async () => {
				// The panel shows a few entries and says how many exist; the
				// dialog pages through the rest. `total` must therefore be the
				// FULL count, never the size of the page just returned —
				// otherwise a truncated list looks complete.
				const tc = await newCase("Paged");
				for (const state of ["READY", "CLOSED", "DRAFT"] as const) {
					await updateTestCase({
						id: tc.id,
						projectId: PROJECT_ID,
						data: { state },
						actorUserId: USER_ID,
					});
				}
				// CREATED + three state changes.
				const all = await listTestCaseActivity({
					projectId: PROJECT_ID,
					testCaseId: tc.id,
				});
				expect(all.total).toBe(4);
				expect(all.items).toHaveLength(4);

				const firstPage = await listTestCaseActivity({
					projectId: PROJECT_ID,
					testCaseId: tc.id,
					limit: 2,
				});
				expect(firstPage.items).toHaveLength(2);
				// Total is the whole history, not the page.
				expect(firstPage.total).toBe(4);

				const secondPage = await listTestCaseActivity({
					projectId: PROJECT_ID,
					testCaseId: tc.id,
					limit: 2,
					offset: 2,
				});
				expect(secondPage.items).toHaveLength(2);
				expect(secondPage.total).toBe(4);
				// The pages are disjoint and continue the same newest-first order.
				const ids = [...firstPage.items, ...secondPage.items].map(
					(e) => e.id,
				);
				expect(new Set(ids).size).toBe(4);
				expect(all.items.map((e) => e.id)).toEqual(ids);
			});

			it("orders rows sharing one timestamp deterministically", async () => {
				// One save writes its state / priority / title events in a
				// single createMany, so they all carry the SAME `occurredAt`.
				// With `occurredAt` as the only sort key, tied rows come back in
				// whatever order the plan happens to produce — which under
				// offset paging silently drops one row and repeats another
				// across the page boundary. `id` is the tiebreaker that makes
				// the order total.
				const tc = await newCase("Tied");
				await updateTestCase({
					id: tc.id,
					projectId: PROJECT_ID,
					data: {
						state: "READY",
						priority: "CRITICAL",
						title: "Tied renamed",
					},
					actorUserId: USER_ID,
				});

				const page = () =>
					listTestCaseActivity({
						projectId: PROJECT_ID,
						testCaseId: tc.id,
					});
				const first = await page();
				// The three change events share one timestamp.
				const tied = first.items.filter((e) => e.type !== "CREATED");
				expect(tied).toHaveLength(3);
				expect(new Set(tied.map((e) => e.occurredAt)).size).toBe(1);
				// Tied rows are ordered by id descending, so the order is a
				// property of the data rather than of the query plan.
				expect(tied.map((e) => e.id)).toEqual(
					[...tied.map((e) => e.id)].sort().reverse(),
				);

				// Paging across the tie loses nothing and repeats nothing.
				const p1 = await listTestCaseActivity({
					projectId: PROJECT_ID,
					testCaseId: tc.id,
					limit: 2,
				});
				const p2 = await listTestCaseActivity({
					projectId: PROJECT_ID,
					testCaseId: tc.id,
					limit: 2,
					offset: 2,
				});
				const paged = [...p1.items, ...p2.items].map((e) => e.id);
				expect(new Set(paged).size).toBe(4);
				expect(paged).toEqual(first.items.map((e) => e.id));
			});
		});

		describe("qa_analysis_version", () => {
			const analysis = (specHash: string) => ({
				warnings: [{ criterionRef: "AC 1", warning: "Too vague." }],
				integrationNotes: "- note",
				e2eScenarios: "### E2E",
				depth: "STANDARD" as const,
				specHash,
				generatedAt: new Date().toISOString(),
			});

			it("snapshots every generation, newest first, with the generator", async () => {
				await setQaAnalysis({
					userStoryId: STORY_ID,
					projectId: PROJECT_ID,
					qaAnalysis: analysis("hash-1"),
					generatedByUserId: USER_ID,
				});
				await setQaAnalysis({
					userStoryId: STORY_ID,
					projectId: PROJECT_ID,
					qaAnalysis: analysis("hash-2"),
					generatedByUserId: USER_ID,
				});

				const { versions } = await listQaAnalysisVersions({
					projectId: PROJECT_ID,
					userStoryId: STORY_ID,
				});
				expect(versions.length).toBeGreaterThanOrEqual(2);
				// Newest first.
				expect(versions[0]?.specHash).toBe("hash-2");
				expect(versions[1]?.specHash).toBe("hash-1");
				expect(versions[0]).toMatchObject({
					depth: "STANDARD",
					generatedByName: "History User",
				});
				// The full content round-trips through the parser.
				expect(versions[0]?.content?.warnings[0]?.warning).toBe(
					"Too vague.",
				);
			});

			it("writes NO version when the story update misses (wrong project)", async () => {
				const before = await db.qaAnalysisVersion.count({
					where: { projectId: OTHER_PROJECT_ID },
				});
				const count = await setQaAnalysis({
					// Real story id but the WRONG project — updateMany hits nothing.
					userStoryId: STORY_ID,
					projectId: OTHER_PROJECT_ID,
					qaAnalysis: analysis("orphan"),
					generatedByUserId: USER_ID,
				});
				expect(count).toBe(0);
				const after = await db.qaAnalysisVersion.count({
					where: { projectId: OTHER_PROJECT_ID },
				});
				// The miss left no orphan snapshot.
				expect(after).toBe(before);
			});
		});
	},
);
