/**
 * Real-Postgres test for the publish audit row written by
 * `publishInstructionSnapshot` (`audit`).
 *
 * The audit row is written inside the publish transaction, only when the
 * pointer actually moved, so the pointer never moves without the record that
 * it moved and a retry never writes a second one. A mocked transaction cannot
 * prove that: it is the database's rollback that makes a crash between the
 * pointer move and the audit write leave nothing behind, and the
 * `publishedAt` marker that makes the retry quiet. Here the audit write is
 * made to fail for real (a foreign key on its actor) and the retry then runs
 * against the same rows.
 *
 * Self-skips when DATABASE_URL is unset or is the CI placeholder.
 *
 * Run with:
 *   pnpm --filter @repo/database exec dotenv -c -e ../../.env.local -- vitest run __tests__/instruction-publish-audit.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, publishInstructionSnapshot } from "../index";
import { hasReachableDatabaseUrl } from "./_helpers/db-availability";

const RUN_ID = `${Date.now()}-${process.pid}`;
const ORGANIZATION_ID = `publish-audit-org-${RUN_ID}`;
const USER_ID = `publish-audit-user-${RUN_ID}`;
const MISSING_USER_ID = `publish-audit-missing-${RUN_ID}`;
let projectId = "";
let snapshotId = "";

function audit(userId: string) {
	return {
		action: "project.instructions.published",
		category: "project",
		actor: { type: "user" as const, userId },
		organizationId: ORGANIZATION_ID,
		projectId,
		resource: {
			type: "project_instruction_snapshot",
			id: snapshotId,
			name: "v1",
		},
		metadata: { version: 1, fileCount: 0, source: "auto_publish_on_ready" },
	};
}

function publish(userId: string) {
	return publishInstructionSnapshot({
		snapshotId,
		projectId,
		organizationId: ORGANIZATION_ID,
		requireBaseUnmoved: true,
		audit: audit(userId),
	});
}

function publishedRows() {
	return db.auditLog.count({
		where: {
			projectId,
			action: "project.instructions.published",
			resourceId: snapshotId,
		},
	});
}

describe.skipIf(!hasReachableDatabaseUrl())(
	"publishInstructionSnapshot audit (real Postgres)",
	() => {
		beforeAll(async () => {
			const now = new Date();
			await db.user.create({
				data: {
					id: USER_ID,
					name: "Publish Audit",
					email: `${USER_ID}@example.com`,
					emailVerified: true,
					createdAt: now,
					updatedAt: now,
				},
			});
			await db.organization.create({
				data: {
					id: ORGANIZATION_ID,
					name: "Publish Audit",
					slug: ORGANIZATION_ID,
					createdAt: now,
				},
			});
			const project = await db.project.create({
				data: {
					name: "Publish Audit",
					userId: USER_ID,
					organizationId: ORGANIZATION_ID,
					techStack: [],
					features: [],
					tags: [],
				},
			});
			projectId = project.id;
			const snapshot = await db.projectInstructionSnapshot.create({
				data: {
					projectId,
					organizationId: ORGANIZATION_ID,
					userId: USER_ID,
					version: 1,
					source: "UPLOAD",
					status: "READY",
					settingsFrozen: {},
					digest: "d".repeat(64),
				},
				select: { id: true },
			});
			snapshotId = snapshot.id;
		});

		afterAll(async () => {
			// Delete by the exact ids this run created, never by pattern.
			if (projectId) {
				// The audit log is append-only: purging the rows this run
				// wrote needs the in-transaction opt-in, scoped to its project.
				await db.$transaction([
					db.$executeRawUnsafe(
						"SET LOCAL app.audit_allow_delete = 'on'",
					),
					db.$executeRaw`DELETE FROM "audit_log" WHERE "projectId" = ${projectId}`,
				]);
				await db.project.updateMany({
					where: { id: projectId },
					data: { publishedInstructionSnapshotId: null },
				});
				await db.projectInstructionSnapshot.deleteMany({
					where: { projectId },
				});
				await db.project.deleteMany({ where: { id: projectId } });
			}
			await db.organization.deleteMany({
				where: { id: ORGANIZATION_ID },
			});
			await db.user.deleteMany({ where: { id: USER_ID } });
			await db.$disconnect();
		});

		it("leaves the pointer, the marker and the audit log untouched when the audit write fails, then publishes once with exactly one row on the retry", async () => {
			await expect(publish(MISSING_USER_ID)).rejects.toBeDefined();

			const afterCrash = await db.project.findUnique({
				where: { id: projectId },
				select: { publishedInstructionSnapshotId: true },
			});
			const snapshotAfterCrash =
				await db.projectInstructionSnapshot.findUnique({
					where: { id: snapshotId },
					select: { publishedAt: true },
				});
			expect(afterCrash?.publishedInstructionSnapshotId).toBeNull();
			expect(snapshotAfterCrash?.publishedAt).toBeNull();
			expect(await publishedRows()).toBe(0);

			expect(await publish(USER_ID)).toMatchObject({
				published: true,
				changed: true,
			});
			expect(await publishedRows()).toBe(1);
		});

		it("answers a repeat of a completed publish as unchanged and writes no second row", async () => {
			expect(await publish(USER_ID)).toEqual({
				published: true,
				changed: false,
			});

			expect(await publishedRows()).toBe(1);
			const project = await db.project.findUnique({
				where: { id: projectId },
				select: { publishedInstructionSnapshotId: true },
			});
			expect(project?.publishedInstructionSnapshotId).toBe(snapshotId);
		});
	},
);
