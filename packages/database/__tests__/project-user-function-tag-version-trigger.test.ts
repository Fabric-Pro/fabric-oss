/**
 * Positive control for the `confirmationVersion` bump trigger installed by
 * migration 20260821120000_project_user_function_tag_confirmation
 * (Fizzy #2264, spec §5.7).
 *
 * `confirmationVersion` is the compare-and-set token every project role
 * confirmation is conditional on. A writer that changes `tags` or
 * `confirmedAt` WITHOUT advancing it does not fail — it silently disarms the
 * CAS, leaving an old `expectedVersion` valid forever. That is the same
 * failure mode the rejected `updatedAt` token had, reached a different way.
 *
 * The choke point in `queries/projects/function-tags.ts` and the per-writer
 * tests are hygiene: neither can fail for a write path that does not exist
 * yet, so neither stops a future `db.projectUserFunctionTag.update()` written
 * somewhere else in the codebase. The trigger does, at the only place every
 * writer must pass through — which is exactly why it needs a test that proves
 * it is INSTALLED. A trigger that was never created, or was dropped by a later
 * migration, is otherwise indistinguishable from one that works.
 *
 * Self-skips unless a REACHABLE Postgres is configured; `hasReachableDatabaseUrl()`
 * rejects both an unset DATABASE_URL and the CI placeholder the unit-tests
 * workflow exports. Runs for real in `db-integration.yml` (path-filtered on
 * packages/database/**) and locally with:
 *   DATABASE_URL=<real> corepack pnpm --filter @repo/database test \
 *     __tests__/project-user-function-tag-version-trigger.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, Prisma } from "../prisma/client";
import { hasReachableDatabaseUrl } from "./_helpers/db-availability";

const RUN_ID = process.env.VITEST_WORKER_ID ?? "0";
const USER_ID = `test-tag-version-user-${RUN_ID}`;
const PROJECT_NAME = "Tag Version Trigger Project";

describe.skipIf(!hasReachableDatabaseUrl())(
	"project_user_function_tag version-bump trigger (real Postgres)",
	() => {
		let projectId: string;

		beforeAll(async () => {
			const now = new Date();
			await db.$executeRaw(Prisma.sql`
				INSERT INTO "user" (id, name, email, "emailVerified", "onboardingComplete", "createdAt", "updatedAt")
				VALUES (${USER_ID}, ${"Tag Version Test User"}, ${`${USER_ID}@example.com`}, true, false, ${now}, ${now})
				ON CONFLICT (id) DO NOTHING
			`);
			const project = await db.project.create({
				data: { name: PROJECT_NAME, userId: USER_ID },
			});
			projectId = project.id;
		});

		afterAll(async () => {
			await db.projectUserFunctionTag.deleteMany({
				where: { userId: USER_ID },
			});
			await db.project.deleteMany({ where: { userId: USER_ID } });
			await db.$executeRaw(
				Prisma.sql`DELETE FROM "user" WHERE id = ${USER_ID}`,
			);
		});

		async function freshRow() {
			await db.projectUserFunctionTag.deleteMany({
				where: { projectId, userId: USER_ID },
			});
			return db.projectUserFunctionTag.create({
				data: {
					projectId,
					userId: USER_ID,
					organizationId: null,
					tags: ["DEVELOPER"],
				},
			});
		}

		it("accepts an INSERT at version 0 (the trigger is BEFORE UPDATE only)", async () => {
			const row = await freshRow();
			expect(row.confirmationVersion).toBe(0);
			expect(row.confirmedAt).toBeNull();
		});

		it("ADVANCES the version itself when a write changes tags without it", async () => {
			// This is the whole reason the trigger corrects rather than
			// rejects: the writer here is a stand-in for an old deployed
			// instance that predates the column. It must succeed, and the CAS
			// token must still move — otherwise a stale `expectedVersion`
			// would stay valid forever.
			const row = await freshRow();
			const updated = await db.projectUserFunctionTag.update({
				where: { id: row.id },
				data: { tags: ["ARCHITECT"] },
			});
			expect(updated.tags).toEqual(["ARCHITECT"]);
			expect(updated.confirmationVersion).toBe(1);
		});

		it("ADVANCES the version when a write sets confirmedAt without it", async () => {
			const row = await freshRow();
			const updated = await db.projectUserFunctionTag.update({
				where: { id: row.id },
				data: { confirmedAt: new Date() },
			});
			expect(updated.confirmationVersion).toBe(1);
		});

		it("CORRECTS a version that would go backwards", async () => {
			// Proves backwards is corrected exactly like standing still: OLD
			// is 1, the writer explicitly sets confirmationVersion back to 0,
			// and the trigger still advances it to OLD+1 (2). This alone does
			// NOT distinguish `<=` from `<>` in the trigger's guard — with
			// OLD=1 and NEW=0, both operators are true and both would fire.
			// The case that actually separates them is "leaves a version
			// alone when the writer advances it by more than one" below.
			const row = await freshRow();
			await db.projectUserFunctionTag.update({
				where: { id: row.id },
				data: {
					tags: ["ARCHITECT"],
					confirmationVersion: { increment: 1 },
				},
			});
			const updated = await db.projectUserFunctionTag.update({
				where: { id: row.id },
				data: { tags: ["SME"], confirmationVersion: 0 },
			});
			expect(updated.confirmationVersion).toBe(2);
		});

		it("leaves a correct writer alone — no double bump", async () => {
			const row = await freshRow();
			const updated = await db.projectUserFunctionTag.update({
				where: { id: row.id },
				data: {
					tags: ["SME"],
					confirmedAt: new Date(),
					confirmationVersion: { increment: 1 },
				},
			});
			expect(updated.tags).toEqual(["SME"]);
			// 1, not 2 — the writer already advanced OLD (0) to 1 in the same
			// statement, so the trigger's guard is false and leaves it. This
			// alone does NOT prove the guard is conditional rather than an
			// unconditional "always set to OLD+1": with OLD=0, that would
			// coincidentally also land on 1 here. The case that actually
			// separates "guarded" from "unconditional" is "leaves a version
			// alone when the writer advances it by more than one" below.
			expect(updated.confirmationVersion).toBe(1);
		});

		it("allows an UPDATE that touches NEITHER tags nor confirmedAt", async () => {
			// The trigger guards two columns, not the whole row: an unrelated
			// write (organizationId being re-derived, say) must not be forced
			// to burn a version and invalidate an open confirmation prompt.
			const row = await freshRow();
			const updated = await db.projectUserFunctionTag.update({
				where: { id: row.id },
				data: { organizationId: null },
			});
			expect(updated.confirmationVersion).toBe(0);
		});

		it("clears confirmedAt when a write moves tags but leaves it set", async () => {
			// The old-instance shape: `update: { organizationId, tags }`.
			const row = await freshRow();
			await db.projectUserFunctionTag.update({
				where: { id: row.id },
				data: {
					confirmedAt: new Date(),
					confirmationVersion: { increment: 1 },
				},
			});
			const updated = await db.projectUserFunctionTag.update({
				where: { id: row.id },
				data: { tags: ["ARCHITECT"] },
			});
			expect(updated.confirmedAt).toBeNull();
			expect(updated.confirmationVersion).toBe(2);
		});

		it("leaves confirmedAt alone when the writer sets it in the same statement", async () => {
			// A real confirmation: tags and confirmedAt move together. Invariant 1
			// must not undo it.
			const row = await freshRow();
			const when = new Date();
			const updated = await db.projectUserFunctionTag.update({
				where: { id: row.id },
				data: {
					tags: ["SME"],
					confirmedAt: when,
					confirmationVersion: { increment: 1 },
				},
			});
			expect(updated.confirmedAt).toEqual(when);
			expect(updated.confirmationVersion).toBe(1);
		});

		it("does not clear confirmedAt when tags did not move", async () => {
			// organizationId-only write: neither invariant should fire.
			const row = await freshRow();
			await db.projectUserFunctionTag.update({
				where: { id: row.id },
				data: {
					confirmedAt: new Date(),
					confirmationVersion: { increment: 1 },
				},
			});
			const updated = await db.projectUserFunctionTag.update({
				where: { id: row.id },
				data: { organizationId: null },
			});
			expect(updated.confirmedAt).not.toBeNull();
			expect(updated.confirmationVersion).toBe(1);
		});

		it("leaves a version alone when the writer advances it by more than one", async () => {
			// The one case that actually distinguishes `<=` from `<>` in the
			// trigger's guard. OLD is 0, the writer sets confirmationVersion
			// straight to 99 (not via increment) alongside a tags change: a
			// `<=` guard sees 99 <= 0 as false and leaves it; a `<>` guard
			// would see 99 <> 0 as true and double-bump it to 100. Every
			// other case in this file has NEW land at OLD+1 or below, where
			// both operators agree — this is the only one where they diverge.
			const row = await freshRow();
			const updated = await db.projectUserFunctionTag.update({
				where: { id: row.id },
				data: { tags: ["ARCHITECT"], confirmationVersion: 99 },
			});
			expect(updated.confirmationVersion).toBe(99);
		});
	},
);
