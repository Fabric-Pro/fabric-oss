/**
 * DB-integration coverage for the daily-brief release-notes exclusion CRUD
 * helpers in `packages/database/prisma/queries/projects/daily-brief-exclusions.ts`
 * (Fizzy 1869 follow-up — hide flag-gated PRs/stories from the release-notes
 * panel and newsletter by PR or story identifier):
 *
 *   1. `createReleaseNoteExclusion` is idempotent — a second identical hide
 *      returns `{created:false}` and the DB holds exactly one row, both
 *      sequentially and under a concurrent `Promise.all` double-hide (the
 *      Codex-flagged race: two requests racing `createMany(skipDuplicates)`
 *      against the same `(projectId, targetKey)` unique key must yield
 *      exactly one `created:true` and one `created:false`, never a thrown
 *      unique-constraint error).
 *   2. `listReleaseNoteExclusions` returns the project's rows, scoped by the
 *      tenant XOR filter.
 *   3. `deleteReleaseNoteExclusion` scoped to the owning tenant removes the
 *      row and returns `{deleted:true, row}` with `kind`/`targetKey`
 *      preserved (the unhide flow re-derives the audit description from
 *      this returned row); a foreign-tenant delete is a no-op.
 *   4. XOR isolation — a personal-context row is invisible to an
 *      org-context list and vice versa.
 *
 * This suite needs a live Postgres (real unique-constraint + concurrent-
 * insert semantics can't be faithfully mocked), so it self-skips when
 * DATABASE_URL is unset or is the CI placeholder (`hasReachableDatabaseUrl`),
 * mirroring the sibling integration suite `newsletter-transitions.test.ts`.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { hasReachableDatabaseUrl } from "../../../../__tests__/_helpers/db-availability";
import { db, Prisma } from "../../../client";
import {
	createReleaseNoteExclusion,
	deleteReleaseNoteExclusion,
	listReleaseNoteExclusions,
	type ReleaseNoteExclusionTenant,
} from "../daily-brief-exclusions";

describe.skipIf(!hasReachableDatabaseUrl())(
	"daily-brief release-note exclusions (real Postgres)",
	() => {
		const RUN_ID = `${Date.now()}-${process.pid}`;
		const USER_ID = `test-dbre-user-${RUN_ID}`;
		const OTHER_USER_ID = `test-dbre-other-user-${RUN_ID}`;
		const ORG_ID = `test-dbre-org-${RUN_ID}`;
		let projectCounter = 0;

		beforeAll(async () => {
			const now = new Date();
			for (const id of [USER_ID, OTHER_USER_ID]) {
				await db.$executeRaw(Prisma.sql`
					INSERT INTO "user" (id, name, email, "emailVerified", "onboardingComplete", "createdAt", "updatedAt")
					VALUES (${id}, ${"DBRE Test User"}, ${`${id}@test.com`}, true, false, ${now}, ${now})
					ON CONFLICT (id) DO NOTHING
				`);
			}
			await db.$executeRaw(Prisma.sql`
				INSERT INTO "organization" (id, name, slug, "createdAt")
				VALUES (${ORG_ID}, ${"DBRE Test Org"}, ${`dbre-test-${RUN_ID}`}, ${now})
				ON CONFLICT (id) DO NOTHING
			`);
		});

		afterEach(async () => {
			// Deleting the project cascades its exclusions (onDelete: Cascade).
			await db.project.deleteMany({
				where: { userId: { in: [USER_ID, OTHER_USER_ID] } },
			});
		});

		async function seedProject(
			overrides: { userId?: string; organizationId?: string | null } = {},
		) {
			projectCounter += 1;
			return db.project.create({
				data: {
					name: `DBRE Project ${projectCounter}`,
					userId: overrides.userId ?? USER_ID,
					organizationId: overrides.organizationId ?? null,
				},
			});
		}

		function personalTenant(
			projectId: string,
			userId = USER_ID,
		): ReleaseNoteExclusionTenant {
			return { projectId, organizationId: null, userId };
		}

		function orgTenant(projectId: string): ReleaseNoteExclusionTenant {
			return { projectId, organizationId: ORG_ID, userId: USER_ID };
		}

		it("is sequentially idempotent: second identical create returns {created:false}, DB holds one row", async () => {
			const project = await seedProject();
			const tenant = personalTenant(project.id);
			const input = {
				kind: "pr",
				repoFullName: "acme/widgets",
				prNumber: 42,
			} as const;

			const first = await createReleaseNoteExclusion(
				db,
				tenant,
				input,
				USER_ID,
			);
			expect(first.created).toBe(true);
			expect(first.row.kind).toBe("pr");
			expect(first.row.repoFullName).toBe("acme/widgets");
			expect(first.row.prNumber).toBe(42);

			const second = await createReleaseNoteExclusion(
				db,
				tenant,
				input,
				USER_ID,
			);
			expect(second.created).toBe(false);
			expect(second.row.id).toBe(first.row.id);

			const rows = await db.dailyBriefReleaseNoteExclusion.findMany({
				where: { projectId: project.id },
			});
			expect(rows).toHaveLength(1);
		});

		it("is idempotent under a concurrent double-hide: exactly one created:true, one created:false, one row", async () => {
			const project = await seedProject();
			const tenant = personalTenant(project.id);
			const input = { kind: "story", storyIdentifier: "F-123" } as const;

			const [a, b] = await Promise.all([
				createReleaseNoteExclusion(db, tenant, input, USER_ID),
				createReleaseNoteExclusion(db, tenant, input, USER_ID),
			]);

			expect([a.created, b.created].sort()).toEqual([false, true]);
			expect(a.row.id).toBe(b.row.id);

			const rows = await db.dailyBriefReleaseNoteExclusion.findMany({
				where: { projectId: project.id },
			});
			expect(rows).toHaveLength(1);
		});

		it("list returns the project's rows", async () => {
			const project = await seedProject();
			const tenant = personalTenant(project.id);

			await createReleaseNoteExclusion(
				db,
				tenant,
				{ kind: "pr", repoFullName: "acme/widgets", prNumber: 1 },
				USER_ID,
			);
			await createReleaseNoteExclusion(
				db,
				tenant,
				{ kind: "story", storyIdentifier: "F-1" },
				USER_ID,
			);

			const rows = await listReleaseNoteExclusions(db, tenant);
			expect(rows).toHaveLength(2);
			expect(rows.map((r) => r.kind).sort()).toEqual(["pr", "story"]);
		});

		it("delete scoped by tenant removes the row and returns {deleted:true,row} with kind+targetKey preserved", async () => {
			const project = await seedProject();
			const tenant = personalTenant(project.id);
			const { row: created } = await createReleaseNoteExclusion(
				db,
				tenant,
				{ kind: "pr", repoFullName: "acme/widgets", prNumber: 7 },
				USER_ID,
			);

			const result = await deleteReleaseNoteExclusion(
				db,
				tenant,
				created.id,
			);
			expect(result.deleted).toBe(true);
			if (!result.deleted) {
				throw new Error("unreachable");
			}
			expect(result.row.kind).toBe("pr");
			expect(result.row.targetKey).toBe("pr:acme/widgets#7");

			const remaining =
				await db.dailyBriefReleaseNoteExclusion.findUnique({
					where: { id: created.id },
				});
			expect(remaining).toBeNull();
		});

		it("delete from a foreign tenant is a no-op: {deleted:false}, row untouched", async () => {
			const project = await seedProject();
			const owner = personalTenant(project.id);
			const { row: created } = await createReleaseNoteExclusion(
				db,
				owner,
				{ kind: "story", storyIdentifier: "F-9" },
				USER_ID,
			);

			const foreignTenant = personalTenant(project.id, OTHER_USER_ID);
			const result = await deleteReleaseNoteExclusion(
				db,
				foreignTenant,
				created.id,
			);
			expect(result.deleted).toBe(false);

			const stillThere =
				await db.dailyBriefReleaseNoteExclusion.findUnique({
					where: { id: created.id },
				});
			expect(stillThere).not.toBeNull();
		});

		it("XOR isolation: a personal-context row is invisible to an org-context list and vice versa", async () => {
			const personalProject = await seedProject({ organizationId: null });
			const orgProject = await seedProject({ organizationId: ORG_ID });

			const personal = personalTenant(personalProject.id);
			const org = orgTenant(orgProject.id);

			await createReleaseNoteExclusion(
				db,
				personal,
				{ kind: "pr", repoFullName: "acme/personal", prNumber: 1 },
				USER_ID,
			);
			await createReleaseNoteExclusion(
				db,
				org,
				{ kind: "pr", repoFullName: "acme/org", prNumber: 2 },
				USER_ID,
			);

			const personalRows = await listReleaseNoteExclusions(db, personal);
			expect(personalRows).toHaveLength(1);
			expect(personalRows[0]?.repoFullName).toBe("acme/personal");

			const orgRows = await listReleaseNoteExclusions(db, org);
			expect(orgRows).toHaveLength(1);
			expect(orgRows[0]?.repoFullName).toBe("acme/org");
		});
	},
);
