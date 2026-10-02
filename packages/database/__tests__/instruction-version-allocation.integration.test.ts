/**
 * Real-Postgres test for version allocation in `createInstructionSnapshot` and
 * `createDerivedInstructionSnapshot`.
 *
 * The version is the highest existing one plus one, and `@@unique([projectId,
 * version])` rejects a duplicate. Under READ COMMITTED two begins on one
 * project both read the same highest version, so a mocked transaction can only
 * describe the collision; here many begins really run at once. Eight must all
 * succeed with distinct, consecutive versions; a burst of sixteen may exhaust
 * the bounded retry, and then every result is a success or the typed
 * `InstructionVersionContentionError`, never a raw unique violation. A plain
 * begin waits on no project row lock: waiters inside a 5 s interactive
 * transaction are what expired on staging.
 *
 * Self-skips when DATABASE_URL is unset or is the CI placeholder.
 *
 * Run with:
 *   pnpm --filter @repo/database exec dotenv -c -e ../../.env.local -- vitest run __tests__/instruction-version-allocation.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createDerivedInstructionSnapshot,
	createInstructionSnapshot,
	db,
	InstructionVersionContentionError,
} from "../index";
import { hasReachableDatabaseUrl } from "./_helpers/db-availability";

const RUN_ID = `${Date.now()}-${process.pid}`;
const ORGANIZATION_ID = `version-alloc-org-${RUN_ID}`;
const USER_ID = `version-alloc-user-${RUN_ID}`;
const CONCURRENT_BEGINS = 8;
let projectId = "";
let baseSnapshotId = "";

function beginInput(index: number) {
	return {
		projectId,
		organizationId: ORGANIZATION_ID,
		userId: USER_ID,
		source: "UPLOAD" as const,
		settingsFrozen: {},
		publishOnReady: false,
		excludedCount: 0,
		files: [
			{
				path: `f-${index}.md`,
				size: 1,
				sha256: "a".repeat(64),
				mimeType: "text/markdown",
				isText: true,
				kind: "INSTRUCTIONS" as const,
				storageKey: `version-alloc/${RUN_ID}/${index}`,
			},
		],
	};
}

describe.skipIf(!hasReachableDatabaseUrl())(
	"instruction snapshot version allocation (real Postgres)",
	() => {
		beforeAll(async () => {
			const now = new Date();
			await db.user.create({
				data: {
					id: USER_ID,
					name: "Version Alloc",
					email: `${USER_ID}@example.com`,
					emailVerified: true,
					createdAt: now,
					updatedAt: now,
				},
			});
			await db.organization.create({
				data: {
					id: ORGANIZATION_ID,
					name: "Version Alloc",
					slug: ORGANIZATION_ID,
					createdAt: now,
				},
			});
			const project = await db.project.create({
				data: {
					name: "Version Alloc",
					userId: USER_ID,
					organizationId: ORGANIZATION_ID,
					techStack: [],
					features: [],
					tags: [],
				},
			});
			projectId = project.id;
			const base = await db.projectInstructionSnapshot.create({
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
			baseSnapshotId = base.id;
		});

		afterAll(async () => {
			if (projectId) {
				await db.projectInstructionFile.deleteMany({
					where: { projectId },
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

		it("gives every one of many simultaneous begins its own consecutive version", async () => {
			const before = await db.projectInstructionSnapshot.count({
				where: { projectId },
			});

			const results = await Promise.all(
				Array.from({ length: CONCURRENT_BEGINS }, (_, i) =>
					createInstructionSnapshot(beginInput(i)),
				),
			);

			const versions = results
				.map((r) => r.version)
				.sort((a, b) => a - b);
			expect(versions).toEqual(
				Array.from(
					{ length: CONCURRENT_BEGINS },
					(_, i) => before + 1 + i,
				),
			);
		});

		it("serializes derived begins with plain begins on the same project", async () => {
			const highest = await db.projectInstructionSnapshot.aggregate({
				where: { projectId },
				_max: { version: true },
			});
			const start = highest._max.version ?? 0;

			const results = await Promise.all(
				Array.from({ length: CONCURRENT_BEGINS }, (_, i) =>
					i % 2 === 0
						? createInstructionSnapshot(beginInput(100 + i))
						: createDerivedInstructionSnapshot({
								projectId,
								organizationId: ORGANIZATION_ID,
								userId: USER_ID,
								baseSnapshotId,
								publishOnReady: false,
								proposal: false,
								changes: [
									{
										op: "put" as const,
										path: `derived-${i}.md`,
										size: 1,
										sha256: "b".repeat(64),
										mimeType: "text/markdown",
										isText: true,
										kind: "INSTRUCTIONS" as const,
										storageKey: `version-alloc/${RUN_ID}/derived-${i}`,
									},
								],
								limits: {
									maxFiles: 100,
									maxTotalBytes: 1_000_000,
								},
								baseKeyPrefix: `version-alloc/${RUN_ID}/base/`,
							}),
				),
			);

			const versions = results
				.map((r) => {
					if (!("ok" in r)) {
						return r.version;
					}
					expect(r.ok).toBe(true);
					return r.ok ? r.version : -1;
				})
				.sort((a, b) => a - b);
			expect(versions).toEqual(
				Array.from(
					{ length: CONCURRENT_BEGINS },
					(_, i) => start + 1 + i,
				),
			);
		});

		it("answers a burst of 16 begins with a success or the typed contention error, never a raw unique violation", async () => {
			const settled = await Promise.allSettled(
				Array.from({ length: 16 }, (_, i) =>
					createInstructionSnapshot(beginInput(200 + i)),
				),
			);

			const versions: number[] = [];
			for (const outcome of settled) {
				if (outcome.status === "fulfilled") {
					versions.push(outcome.value.version);
				} else {
					expect(outcome.reason).toBeInstanceOf(
						InstructionVersionContentionError,
					);
				}
			}
			expect(versions.length).toBeGreaterThan(0);
			expect(new Set(versions).size).toBe(versions.length);
		});
	},
);
