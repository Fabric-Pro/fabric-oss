/**
 * Real-Postgres integration tests for the Test Case + Test Plan query layer.
 *
 * Covers the behaviors that are only meaningful against live rows (and which the
 * mocked `test-cases.test.ts` / `test-plans.test.ts` cannot prove):
 *   - per-project `TC-NNN` / `TP-NNN` identifier sequencing across real inserts;
 *   - tenant XOR isolation — a personal-context case (organizationId NULL) and an
 *     org-context case live in separate projects and never leak across `list`;
 *   - soft-delete removes a case from `listTestCases` / `getTestCase`;
 *   - step replace (keep / drop / add + re-number) and `reorderTestCases`;
 *   - plan membership uniqueness — the second `addCaseToPlan` throws P2002;
 *   - `countTestCasesForStory` reflects link / unlink;
 *   - `bulkCreateTestCases` persists `workItemLinks[].acceptanceCriterionRefs`
 *     exactly as sent — the criterion contract behind per-AC traceability.
 *
 * No mocks — hits the live Aspire Postgres via the shared Prisma singleton.
 * Self-skips when DATABASE_URL is unset or is the CI placeholder
 * (`hasReachableDatabaseUrl`), mirroring the sibling integration suites.
 *
 * Run with: pnpm --filter @repo/database test prisma/queries/projects/__tests__/test-cases.integration.test.ts
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasReachableDatabaseUrl } from "../../../../__tests__/_helpers/db-availability";
import { db, Prisma } from "../../../client";
import { listTestCases } from "../test-case-list";
import {
	bulkCreateTestCases,
	cloneTestCase,
	countTestCasesForStory,
	createTestCase,
	generateTestCaseIdentifier,
	getTestCase,
	linkTestCaseToWorkItem,
	reorderTestCases,
	softDeleteTestCase,
	unlinkTestCaseFromWorkItem,
	updateTestCase,
} from "../test-cases";
import {
	addCaseToPlan,
	createTestPlan,
	generateTestPlanIdentifier,
	listPlanCases,
} from "../test-plans";

const RUN_ID = `${Date.now()}-${process.pid}`;
const ORG_ID = `test-tc-org-${RUN_ID}`;
const USER_ID = `test-tc-user-${RUN_ID}`;

describe.skipIf(!hasReachableDatabaseUrl())(
	"Test Cases query layer (real Postgres)",
	() => {
		let personalProjectId: string;
		let orgProjectId: string;
		let personalStatusId: string;

		beforeAll(async () => {
			const now = new Date();
			await db.$executeRaw(Prisma.sql`
				INSERT INTO "user" (id, name, email, "emailVerified", "onboardingComplete", "createdAt", "updatedAt")
				VALUES (${USER_ID}, ${"Test Case User"}, ${`${USER_ID}@test.com`}, true, false, ${now}, ${now})
				ON CONFLICT (id) DO NOTHING
			`);
			await db.$executeRaw(Prisma.sql`
				INSERT INTO "organization" (id, name, slug, "createdAt")
				VALUES (${ORG_ID}, ${"Test Case Org"}, ${ORG_ID}, ${now})
				ON CONFLICT (id) DO NOTHING
			`);

			const personalProject = await db.project.create({
				data: {
					name: "TC Personal",
					userId: USER_ID,
					organizationId: null,
				},
			});
			personalProjectId = personalProject.id;
			const personalStatus = await db.projectStoryStatus.create({
				data: {
					projectId: personalProjectId,
					name: "Backlog",
					color: "#94a3b8",
					order: 0,
					isDefault: true,
				},
			});
			personalStatusId = personalStatus.id;

			const orgProject = await db.project.create({
				data: {
					name: "TC Org",
					userId: USER_ID,
					organizationId: ORG_ID,
				},
			});
			orgProjectId = orgProject.id;
		});

		afterAll(async () => {
			// test_case / test_plan cascade from project (steps, links, plan
			// memberships included); userStory + statuses are deleted explicitly.
			await db.testCase.deleteMany({ where: { createdById: USER_ID } });
			await db.testPlan.deleteMany({ where: { createdById: USER_ID } });
			await db.userStory.deleteMany({ where: { createdById: USER_ID } });
			await db.projectStoryStatus.deleteMany({
				where: { project: { userId: USER_ID } },
			});
			await db.project.deleteMany({ where: { userId: USER_ID } });
			await db.organization.deleteMany({ where: { id: ORG_ID } });
			await db.user.deleteMany({ where: { id: USER_ID } });
		});

		it("sequences TC-NNN per project, monotonic with creation", async () => {
			const startId = await generateTestCaseIdentifier(personalProjectId);
			const a = await createTestCase({
				projectId: personalProjectId,
				createdById: USER_ID,
				title: "First",
				userId: USER_ID,
				organizationId: null,
			});
			const b = await createTestCase({
				projectId: personalProjectId,
				createdById: USER_ID,
				title: "Second",
				userId: USER_ID,
				organizationId: null,
			});
			// Sequential, zero-padded, and strictly increasing.
			expect(a.identifier).toBe(startId);
			expect(Number(b.identifier.slice(3))).toBe(
				Number(a.identifier.slice(3)) + 1,
			);
		});

		describe("automation link (real rows)", () => {
			it("persists a ref, flips the case to AUTOMATED, and re-loads on reopen", async () => {
				const created = await createTestCase({
					projectId: personalProjectId,
					createdById: USER_ID,
					title: "Automated login",
					userId: USER_ID,
					organizationId: null,
				});
				expect(created.automationStatus).toBe("NOT_AUTOMATED");

				await updateTestCase({
					id: created.id,
					projectId: personalProjectId,
					data: {
						automationRef: "login.spec.ts > signs in",
						automationFilePath: "apps/web/tests/e2e/login.spec.ts",
						automationExternalUrl: "https://ci.example.com/run/1",
					},
				});

				// Re-read (the "reopen" in the requirement) rather than trusting the
				// value the write returned.
				const reopened = await getTestCase({
					id: created.id,
					projectId: personalProjectId,
				});
				expect(reopened).toMatchObject({
					automationRef: "login.spec.ts > signs in",
					automationFilePath: "apps/web/tests/e2e/login.spec.ts",
					automationExternalUrl: "https://ci.example.com/run/1",
					automationStatus: "AUTOMATED",
				});
			});

			it("counts a ref-backed case in the automation stat, but not a bare AUTOMATED one", async () => {
				const project = await db.project.create({
					data: { name: "TC Automation", userId: USER_ID },
				});
				// One ref-backed, one AUTOMATED by intent only.
				await createTestCase({
					projectId: project.id,
					createdById: USER_ID,
					title: "Ref-backed",
					automationRef: "a.spec.ts > t",
					userId: USER_ID,
				});
				await createTestCase({
					projectId: project.id,
					createdById: USER_ID,
					title: "Intent only",
					automationStatus: "AUTOMATED",
					userId: USER_ID,
				});

				const { summary } = await listTestCases({
					projectId: project.id,
					includeSummary: true,
				});
				// Both read as AUTOMATED intent; only the ref-backed one counts.
				expect(summary?.automationCounts.AUTOMATED).toBe(2);
				expect(summary?.automatedWithRefCount).toBe(1);
			});

			it("clearing the ref drops it from the stat without downgrading the status", async () => {
				const project = await db.project.create({
					data: { name: "TC Automation Clear", userId: USER_ID },
				});
				const c = await createTestCase({
					projectId: project.id,
					createdById: USER_ID,
					title: "Was automated",
					automationRef: "a.spec.ts > t",
					userId: USER_ID,
				});

				await updateTestCase({
					id: c.id,
					projectId: project.id,
					data: { automationRef: "" },
				});

				const reopened = await getTestCase({
					id: c.id,
					projectId: project.id,
				});
				expect(reopened?.automationRef).toBeNull();
				expect(reopened?.automationStatus).toBe("AUTOMATED");

				const { summary } = await listTestCases({
					projectId: project.id,
					includeSummary: true,
				});
				expect(summary?.automatedWithRefCount).toBe(0);
			});
		});

		it("isolates personal vs org cases by project (tenant XOR holds both ways)", async () => {
			const personal = await createTestCase({
				projectId: personalProjectId,
				createdById: USER_ID,
				title: "Personal-only",
				userId: USER_ID,
				organizationId: null,
			});
			const org = await createTestCase({
				projectId: orgProjectId,
				createdById: USER_ID,
				title: "Org-only",
				userId: USER_ID,
				organizationId: ORG_ID,
			});

			const personalList = await listTestCases({
				projectId: personalProjectId,
			});
			const orgList = await listTestCases({ projectId: orgProjectId });

			const personalIds = personalList.items.map((i) => i.id);
			const orgIds = orgList.items.map((i) => i.id);

			expect(personalIds).toContain(personal.id);
			expect(personalIds).not.toContain(org.id);
			expect(orgIds).toContain(org.id);
			expect(orgIds).not.toContain(personal.id);
			// The org case carries the organization tenant column; the personal one does not.
			const orgRow = await getTestCase({
				id: org.id,
				projectId: orgProjectId,
			});
			expect(orgRow?.organizationId).toBe(ORG_ID);
			const personalRow = await getTestCase({
				id: personal.id,
				projectId: personalProjectId,
			});
			expect(personalRow?.organizationId).toBeNull();
		});

		it("soft-delete returns { contextId } and removes the case from list + get", async () => {
			const created = await createTestCase({
				projectId: personalProjectId,
				createdById: USER_ID,
				title: "To delete",
				userId: USER_ID,
				organizationId: null,
			});

			const deleted = await softDeleteTestCase({
				id: created.id,
				projectId: personalProjectId,
			});
			expect(deleted).toEqual({ id: created.id, contextId: null });

			const after = await listTestCases({ projectId: personalProjectId });
			expect(after.items.map((i) => i.id)).not.toContain(created.id);
			expect(
				await getTestCase({
					id: created.id,
					projectId: personalProjectId,
				}),
			).toBeNull();
		});

		it("replaces steps (keep / drop / add) and re-numbers order", async () => {
			const created = await createTestCase({
				projectId: personalProjectId,
				createdById: USER_ID,
				title: "Stepful",
				userId: USER_ID,
				organizationId: null,
				steps: [
					{ action: "step one", expected: "ok1" },
					{ action: "step two", expected: "ok2" },
				],
			});
			const keep = created.steps.find((s) => s.action === "step two");
			expect(keep).toBeDefined();

			const updated = await updateTestCase({
				id: created.id,
				projectId: personalProjectId,
				data: {
					steps: [
						{ id: keep?.id, action: "step two", expected: "ok2" },
						{ action: "step three", expected: "ok3" },
					],
				},
			});

			expect(updated?.steps).toHaveLength(2);
			expect(updated?.steps.map((s) => s.action)).toEqual([
				"step two",
				"step three",
			]);
			expect(updated?.steps.map((s) => s.order)).toEqual([0, 1]);
			// The dropped step is gone.
			expect(updated?.steps.some((s) => s.action === "step one")).toBe(
				false,
			);
		});

		it("reorderTestCases persists the new order", async () => {
			const x = await createTestCase({
				projectId: orgProjectId,
				createdById: USER_ID,
				title: "Reorder X",
				userId: USER_ID,
				organizationId: ORG_ID,
			});
			const y = await createTestCase({
				projectId: orgProjectId,
				createdById: USER_ID,
				title: "Reorder Y",
				userId: USER_ID,
				organizationId: ORG_ID,
			});

			await reorderTestCases(orgProjectId, [
				{ id: x.id, order: 1000 },
				{ id: y.id, order: 1 },
			]);

			const list = await listTestCases({ projectId: orgProjectId });
			const xs = list.items.findIndex((i) => i.id === x.id);
			const ys = list.items.findIndex((i) => i.id === y.id);
			// y (order 1) now sorts before x (order 1000).
			expect(ys).toBeLessThan(xs);
		});

		it("clone produces a new DRAFT case with a fresh id and no external link", async () => {
			const source = await createTestCase({
				projectId: personalProjectId,
				createdById: USER_ID,
				title: "Cloneable",
				state: "READY",
				userId: USER_ID,
				organizationId: null,
				steps: [{ action: "a", expected: "e" }],
			});

			const clone = await cloneTestCase({
				id: source.id,
				projectId: personalProjectId,
				actorUserId: USER_ID,
			});

			expect(clone).not.toBeNull();
			expect(clone?.id).not.toBe(source.id);
			expect(clone?.identifier).not.toBe(source.identifier);
			expect(clone?.state).toBe("DRAFT");
			expect(clone?.externalId).toBeNull();
			expect(clone?.steps.map((s) => s.action)).toEqual(["a"]);
		});

		it("countTestCasesForStory reflects link then unlink", async () => {
			const story = await db.userStory.create({
				data: {
					projectId: personalProjectId,
					statusId: personalStatusId,
					createdById: USER_ID,
					identifier: `F-${RUN_ID}-cov`,
					title: "Covered feature",
				},
			});
			const tc = await createTestCase({
				projectId: personalProjectId,
				createdById: USER_ID,
				title: "Covering case",
				userId: USER_ID,
				organizationId: null,
			});

			await linkTestCaseToWorkItem({
				testCaseId: tc.id,
				userStoryId: story.id,
				acceptanceCriterionRefs: ["AC 2"],
			});
			expect(
				await countTestCasesForStory({
					storyId: story.id,
					projectId: personalProjectId,
				}),
			).toBe(1);

			await unlinkTestCaseFromWorkItem({
				testCaseId: tc.id,
				userStoryId: story.id,
			});
			expect(
				await countTestCasesForStory({
					storyId: story.id,
					projectId: personalProjectId,
				}),
			).toBe(0);
		});

		it("bulkCreateTestCases persists acceptanceCriterionRefs on the links it creates", async () => {
			// The drafting activity once sent a legacy singular
			// `acceptanceCriterionRef` key that this writer silently ignored —
			// every AI-drafted case landed with an empty refs array and coverage
			// read 0% after a successful run. Only a real write proves the
			// plural contract holds end to end.
			const story = await db.userStory.create({
				data: {
					projectId: personalProjectId,
					statusId: personalStatusId,
					createdById: USER_ID,
					identifier: `F-${RUN_ID}-bulk`,
					title: "Bulk-drafted feature",
				},
			});

			const createdCases = await bulkCreateTestCases({
				projectId: personalProjectId,
				createdById: USER_ID,
				cases: [
					{
						title: "Bulk case naming two criteria",
						workItemLinks: [
							{
								userStoryId: story.id,
								acceptanceCriterionRefs: ["AC 1", "AC 3"],
							},
						],
					},
					{
						title: "Bulk case naming none",
						workItemLinks: [
							{
								userStoryId: story.id,
								acceptanceCriterionRefs: [],
							},
						],
					},
				],
			});
			expect(createdCases).toHaveLength(2);

			const links = await db.testCaseWorkItemLink.findMany({
				where: { userStoryId: story.id },
			});
			expect(links).toHaveLength(2);
			const refsByCase = new Map(
				links.map((l) => [l.testCaseId, l.acceptanceCriterionRefs]),
			);
			expect(refsByCase.get(createdCases[0].id)).toEqual([
				"AC 1",
				"AC 3",
			]);
			expect(refsByCase.get(createdCases[1].id)).toEqual([]);
		});

		it("enforces unique plan membership — the second addCaseToPlan throws P2002", async () => {
			const planStartId = await generateTestPlanIdentifier(orgProjectId);
			expect(planStartId).toMatch(/^TP-\d{3,}$/);

			const plan = await createTestPlan({
				projectId: orgProjectId,
				createdById: USER_ID,
				name: "Regression",
				userId: USER_ID,
				organizationId: ORG_ID,
			});
			const tc = await createTestCase({
				projectId: orgProjectId,
				createdById: USER_ID,
				title: "Plan member",
				userId: USER_ID,
				organizationId: ORG_ID,
			});

			await addCaseToPlan({ planId: plan.id, testCaseId: tc.id });
			await expect(
				addCaseToPlan({ planId: plan.id, testCaseId: tc.id }),
			).rejects.toMatchObject({ code: "P2002" });

			const members = await listPlanCases(plan.id);
			expect(members).toHaveLength(1);
			expect(members[0].testCase.id).toBe(tc.id);
		});
	},
);
