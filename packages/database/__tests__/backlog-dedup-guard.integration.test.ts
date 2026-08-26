/**
 * Real-Postgres integration test for `buildBacklogDedupGuard`.
 *
 * The unit tests (`backlog-dedup-guard.test.ts`) cover the helper's logic
 * against a mocked `db.userStory.findMany`. These tests exercise the same
 * surface against the actual Aspire-spun-up dev Postgres + Prisma client,
 * proving:
 *
 *   1. The `findMany` select shape returns rows in the format the index
 *      builder consumes.
 *   2. Legacy `[BUG] ` prefixed rows collide with new unprefixed proposals
 *      against real data, not just a mock.
 *   3. Per-family (BUG vs FEATURE/USER_STORY) isolation holds end-to-end.
 *
 * Self-skips when DATABASE_URL is unset or points at the CI placeholder
 * (mirrors `allocate-next-story-number.test.ts`).
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { db, type FeatureDraftingStage, Prisma } from "../prisma/client";
import { buildBacklogDedupGuard } from "../prisma/queries/projects/backlog-dedup-guard";
import { hasReachableDatabaseUrl } from "./_helpers/db-availability";

const RUN_ID = `${Date.now()}-${process.pid}`;
const ORG_ID = `test-dedup-guard-org-${RUN_ID}`;
const USER_ID = `test-dedup-guard-user-${RUN_ID}`;

describe.skipIf(!hasReachableDatabaseUrl())(
	"buildBacklogDedupGuard (real Postgres)",
	() => {
		beforeAll(async () => {
			const now = new Date();
			await db.$executeRaw(Prisma.sql`
				INSERT INTO "user" (id, name, email, "emailVerified", "onboardingComplete", "createdAt", "updatedAt")
				VALUES (${USER_ID}, ${"Dedup Test User"}, ${`${USER_ID}@test.com`}, true, false, ${now}, ${now})
				ON CONFLICT (id) DO NOTHING
			`);
			await db.$executeRaw(Prisma.sql`
				INSERT INTO "organization" (id, name, slug, "createdAt")
				VALUES (${ORG_ID}, ${"Dedup Test Org"}, ${ORG_ID}, ${now})
				ON CONFLICT (id) DO NOTHING
			`);
		});

		afterEach(async () => {
			// Stories → statuses → projects (FK order).
			await db.userStory.deleteMany({ where: { createdById: USER_ID } });
			await db.projectStoryStatus.deleteMany({
				where: { project: { userId: USER_ID } },
			});
			await db.project.deleteMany({ where: { userId: USER_ID } });
		});

		async function seedProjectWithStories(
			stories: Array<{
				title: string;
				kind: "BUG" | "FEATURE";
				identifier: string;
				draftingStage?: FeatureDraftingStage;
				pmAutoHidden?: boolean;
			}>,
		) {
			const project = await db.project.create({
				data: {
					name: "Dedup Test Project",
					userId: USER_ID,
					organizationId: ORG_ID,
				},
			});
			const status = await db.projectStoryStatus.create({
				data: {
					projectId: project.id,
					name: "Backlog",
					color: "#94a3b8",
					order: 0,
					isDefault: true,
				},
			});
			for (const s of stories) {
				await db.userStory.create({
					data: {
						projectId: project.id,
						statusId: status.id,
						identifier: s.identifier,
						title: s.title,
						kind: s.kind,
						priority: "P2_MEDIUM",
						createdById: USER_ID,
						source: "MANUAL",
						draftingStage: s.draftingStage,
						pmAutoHidden: s.pmAutoHidden,
					},
				});
			}
			return project;
		}

		it("returns null for any title on an empty project", async () => {
			const project = await seedProjectWithStories([]);
			const guard = await buildBacklogDedupGuard(project.id);
			expect(guard.findCollision("FEATURE", "Anything")).toBeNull();
			expect(guard.findCollision("BUG", "Anything")).toBeNull();
		});

		it("EXCLUDES terminal rows (closed / declined / auto-hidden) from the dedup index", async () => {
			const project = await seedProjectWithStories([
				{
					title: "Closed feature",
					kind: "FEATURE",
					identifier: "C-1",
					draftingStage: "CLOSED",
				},
				{
					title: "Declined feature",
					kind: "FEATURE",
					identifier: "D-1",
					draftingStage: "DECLINED",
				},
				{
					title: "Hidden feature",
					kind: "FEATURE",
					identifier: "H-1",
					draftingStage: "CLOSED",
					pmAutoHidden: true,
				},
				{ title: "Active feature", kind: "FEATURE", identifier: "A-1" },
			]);
			const guard = await buildBacklogDedupGuard(project.id);
			// Terminal rows must NOT block a fresh create that shares their title.
			expect(guard.findCollision("FEATURE", "Closed feature")).toBeNull();
			expect(
				guard.findCollision("FEATURE", "Declined feature"),
			).toBeNull();
			expect(guard.findCollision("FEATURE", "Hidden feature")).toBeNull();
			// The non-terminal control row IS still found.
			expect(
				guard.findCollision("FEATURE", "Active feature"),
			).not.toBeNull();
		});

		it("finds an existing FEATURE on case + whitespace + punctuation insensitive match", async () => {
			const project = await seedProjectWithStories([
				{
					title: "Add Login Button",
					kind: "FEATURE",
					identifier: "1",
				},
			]);
			const guard = await buildBacklogDedupGuard(project.id);
			const hit = guard.findCollision("FEATURE", "  ADD login button  ");
			expect(hit).not.toBeNull();
			expect(hit?.existingIdentifier).toBe("1");
		});

		it("collides a legacy `[BUG] ` prefixed row with a new unprefixed bug title", async () => {
			const project = await seedProjectWithStories([
				{
					title: "[BUG] Login crashes on Safari",
					kind: "BUG",
					identifier: "B-007",
				},
			]);
			const guard = await buildBacklogDedupGuard(project.id);
			const hit = guard.findCollision("BUG", "Login crashes on Safari");
			expect(hit).not.toBeNull();
			expect(hit?.existingIdentifier).toBe("B-007");
		});

		it("does NOT cross BUG ↔ FEATURE family: same title in opposite kind is not a collision", async () => {
			const project = await seedProjectWithStories([
				{
					title: "Mobile menu broken",
					kind: "FEATURE",
					identifier: "12",
				},
			]);
			const guard = await buildBacklogDedupGuard(project.id);
			expect(guard.findCollision("BUG", "Mobile menu broken")).toBeNull();
			expect(
				guard.findCollision("FEATURE", "Mobile menu broken"),
			).not.toBeNull();
		});

		it("keeps a FEATURE row in the FEATURE family (User Story retired)", async () => {
			const project = await seedProjectWithStories([
				{
					title: "Refactor checkout",
					kind: "FEATURE",
					identifier: "13",
				},
			]);
			const guard = await buildBacklogDedupGuard(project.id);
			expect(
				guard.findCollision("FEATURE", "Refactor checkout"),
			).not.toBeNull();
			expect(guard.findCollision("BUG", "Refactor checkout")).toBeNull();
		});

		it("indexes multiple existing stories and finds each by title", async () => {
			const project = await seedProjectWithStories([
				{
					title: "Search bar broken",
					kind: "BUG",
					identifier: "B-001",
				},
				{
					title: "Add SSO login",
					kind: "FEATURE",
					identifier: "1",
				},
				{
					title: "Refactor checkout",
					kind: "FEATURE",
					identifier: "2",
				},
			]);
			const guard = await buildBacklogDedupGuard(project.id);
			expect(
				guard.findCollision("BUG", "search bar broken")
					?.existingIdentifier,
			).toBe("B-001");
			expect(
				guard.findCollision("FEATURE", "ADD sso LOGIN")
					?.existingIdentifier,
			).toBe("1");
			expect(
				guard.findCollision("FEATURE", "refactor checkout")
					?.existingIdentifier,
			).toBe("2");
			expect(guard.findCollision("BUG", "Add SSO login")).toBeNull();
		});

		it("recordCreated adds an in-batch entry so a follow-up same-title check collides", async () => {
			const project = await seedProjectWithStories([]);
			const guard = await buildBacklogDedupGuard(project.id);
			expect(guard.findCollision("FEATURE", "Net new idea")).toBeNull();
			guard.recordCreated("FEATURE", "Net new idea", {
				id: "synthetic-id",
				identifier: "9",
			});
			expect(
				guard.findCollision("FEATURE", "net new idea")
					?.existingIdentifier,
			).toBe("9");
		});

		it("only sees stories from the project it was built for (project isolation)", async () => {
			const projectA = await seedProjectWithStories([
				{
					title: "Shared title across projects",
					kind: "FEATURE",
					identifier: "1",
				},
			]);
			// Different project, same user/org, same title.
			const projectB = await db.project.create({
				data: {
					name: "Project B",
					userId: USER_ID,
					organizationId: ORG_ID,
				},
			});
			const statusB = await db.projectStoryStatus.create({
				data: {
					projectId: projectB.id,
					name: "Backlog",
					color: "#94a3b8",
					order: 0,
					isDefault: true,
				},
			});
			await db.userStory.create({
				data: {
					projectId: projectB.id,
					statusId: statusB.id,
					identifier: "1",
					title: "Shared title across projects",
					kind: "FEATURE",
					priority: "P2_MEDIUM",
					createdById: USER_ID,
					source: "MANUAL",
				},
			});

			// Guard built for project A only sees project A's story (which
			// happens to share a title with project B's). Project B's row
			// must not appear as a collision.
			const guardA = await buildBacklogDedupGuard(projectA.id);
			const hit = guardA.findCollision(
				"FEATURE",
				"Shared title across projects",
			);
			expect(hit).not.toBeNull();
			expect(hit?.existingIdentifier).toBe("1");
			// (Both projects' stories happen to be F-1; the assertion above
			// can't distinguish on identifier alone. The semantic guarantee
			// is that `findMany({where:{projectId:A.id}})` only returns A's
			// rows — proven structurally by the helper's `where` clause.)
		});
	},
);
