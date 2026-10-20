/**
 * Real-Postgres tests for Living Memory "Store only" write folders (ADR-022):
 * the SQL of `reconcileContextIndexing` (a folder's prefix, not a lookalike's,
 * decides; the update is idempotent, tenant-scoped and limited to the paths
 * it is given), and what the awaiting-index scans and the summarization reads
 * make of the rows it marks. A mocked client cannot hold any of that.
 *
 * Self-skips when DATABASE_URL is unset or is the CI placeholder.
 *
 * Run with:
 *   pnpm --filter @repo/database exec dotenv -c -e ../../.env.local -- vitest run __tests__/context-index-mode.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	countAwaitingIndexContexts,
	countRawContextRows,
	db,
	deleteContextRepositorySync,
	getContextVolumeCandidates,
	listContextRepositorySyncAwaitingIndex,
	reconcileContextIndexing,
} from "../index";
import { hasReachableDatabaseUrl } from "./_helpers/db-availability";

const RUN_ID = `${Date.now()}-${process.pid}`;
const USER_ID = `index-mode-user-${RUN_ID}`;
const ORG_A = `index-mode-org-a-${RUN_ID}`;
const ORG_B = `index-mode-org-b-${RUN_ID}`;

const seededProjectIds: string[] = [];
const seededSyncIds: string[] = [];
const seededCleanupIds: string[] = [];

type Seeded = { projectId: string; syncId: string; organizationId: string };

async function seedSync(
	organizationId: string,
	label: string,
): Promise<Seeded> {
	const project = await db.project.create({
		data: {
			name: `Index Mode ${label}`,
			userId: USER_ID,
			organizationId,
			techStack: [],
			features: [],
			tags: [],
		},
	});
	seededProjectIds.push(project.id);
	const integration = await db.projectRepositoryIntegration.create({
		data: {
			projectId: project.id,
			provider: "GITHUB",
			authMethod: "OAUTH",
			repositoryUrl: `https://github.com/example-org/index-mode-${label}`,
			repositoryOwner: "example-org",
			repositoryName: `index-mode-${label}`,
		},
	});
	const sync = await db.projectContextRepositorySync.create({
		data: {
			projectId: project.id,
			organizationId,
			userId: USER_ID,
			repositoryIntegrationId: integration.id,
			ref: "main",
			paths: [""],
		},
	});
	seededSyncIds.push(sync.id);
	return { projectId: project.id, syncId: sync.id, organizationId };
}

function seedRow(target: Seeded, path: string, embedded: boolean) {
	return db.projectContext.create({
		data: {
			projectId: target.projectId,
			organizationId: target.organizationId,
			type: "TEXT",
			content: "x".repeat(50),
			sourcePath: path,
			repositorySyncId: target.syncId,
			embeddedAt: embedded ? new Date() : null,
			qdrantId: embedded ? `${path}-chunk-0` : null,
		},
		select: { id: true },
	});
}

function addFolder(
	target: Seeded,
	folder: string,
	indexMode: "INDEXED" | "STORE_ONLY",
) {
	return db.projectContextWriteTarget.create({
		data: {
			syncId: target.syncId,
			projectId: target.projectId,
			organizationId: target.organizationId,
			userId: USER_ID,
			folder,
			indexMode,
		},
	});
}

const reconcile = (target: Seeded, sourcePaths?: string[]) =>
	db.$transaction((tx) =>
		reconcileContextIndexing(tx, {
			projectId: target.projectId,
			organizationId: target.organizationId,
			syncId: target.syncId,
			actingUserId: USER_ID,
			...(sourcePaths ? { sourcePaths } : {}),
		}),
	);

const flagOf = async (id: string) =>
	(
		await db.projectContext.findUniqueOrThrow({
			where: { id },
			select: {
				indexingExcluded: true,
				embeddedAt: true,
				qdrantId: true,
			},
		})
	).indexingExcluded;

describe.skipIf(!hasReachableDatabaseUrl())(
	"Store only write folders (real Postgres)",
	() => {
		let main: Seeded;
		let other: Seeded;
		let folderTarget: { id: string };
		const ids: Record<string, string> = {};

		beforeAll(async () => {
			const now = new Date();
			await db.user.create({
				data: {
					id: USER_ID,
					name: "Index Mode",
					email: `${USER_ID}@example.com`,
					emailVerified: true,
					createdAt: now,
					updatedAt: now,
				},
			});
			for (const id of [ORG_A, ORG_B]) {
				await db.organization.create({
					data: { id, name: id, slug: id, createdAt: now },
				});
			}
			main = await seedSync(ORG_A, "main");
			other = await seedSync(ORG_B, "other");
			folderTarget = await addFolder(main, "docs/tasks", "STORE_ONLY");
			for (const [name, path, embedded] of [
				["embedded", "docs/tasks/a.md", true],
				["fresh", "docs/tasks/deep/b.md", false],
				["outside", "docs/guide/c.md", true],
				["lookalike", "docs/tasks-extra/d.md", true],
				["sibling", "docs/task/e.md", true],
			] as const) {
				ids[name] = (await seedRow(main, path, embedded)).id;
			}
			ids.otherTenant = (
				await seedRow(other, "docs/tasks/a.md", true)
			).id;
		});

		afterAll(async () => {
			if (seededCleanupIds.length > 0) {
				await db.projectContextPendingVectorCleanup.deleteMany({
					where: { id: { in: seededCleanupIds } },
				});
			}
			await db.projectContext.deleteMany({
				where: { repositorySyncId: { in: seededSyncIds } },
			});
			await db.projectContextWriteTarget.deleteMany({
				where: { syncId: { in: seededSyncIds } },
			});
			await db.projectContextRepositorySync.deleteMany({
				where: { id: { in: seededSyncIds } },
			});
			await db.projectRepositoryIntegration.deleteMany({
				where: { projectId: { in: seededProjectIds } },
			});
			await db.project.deleteMany({
				where: { id: { in: seededProjectIds } },
			});
			await db.organization.deleteMany({
				where: { id: { in: [ORG_A, ORG_B] } },
			});
			await db.user.deleteMany({ where: { id: USER_ID } });
			await db.$disconnect();
		});

		it("marks only the rows under the folder, by whole path segments, and queues the vectors of those that held any", async () => {
			const result = await reconcile(main);
			seededCleanupIds.push(...result.cleanups.map((c) => c.id));

			expect(result.excluded).toBe(2);
			expect(result.included).toBe(0);
			expect(result.cleanups).toHaveLength(1);
			expect(result.cleanups[0]?.contextIds).toEqual([ids.embedded]);
			expect(await flagOf(ids.embedded)).toBe(true);
			expect(await flagOf(ids.fresh)).toBe(true);
			expect(await flagOf(ids.outside)).toBe(false);
			expect(await flagOf(ids.lookalike)).toBe(false);
			expect(await flagOf(ids.sibling)).toBe(false);
			const cleared = await db.projectContext.findUniqueOrThrow({
				where: { id: ids.embedded },
				select: { embeddedAt: true, qdrantId: true },
			});
			expect(cleared).toEqual({ embeddedAt: null, qdrantId: null });
			// Store-only rows are settled, never left "Pending"; the rest keep
			// waiting for their embedding pass.
			const statuses = await db.projectContext.findMany({
				where: { id: { in: [ids.embedded, ids.fresh, ids.outside] } },
				select: { id: true, extractionStatus: true },
			});
			expect(
				Object.fromEntries(
					statuses.map((r) => [r.id, r.extractionStatus]),
				),
			).toEqual({
				[ids.embedded]: "COMPLETED",
				[ids.fresh]: "COMPLETED",
				[ids.outside]: "PENDING",
			});
			const record =
				await db.projectContextPendingVectorCleanup.findUniqueOrThrow({
					where: { id: result.cleanups[0]?.id },
				});
			expect(record).toMatchObject({
				projectId: main.projectId,
				organizationId: main.organizationId,
				contextIds: [ids.embedded],
			});
		});

		it("is idempotent", async () => {
			const result = await reconcile(main);

			expect(result).toEqual({ excluded: 0, included: 0, cleanups: [] });
		});

		it("never touches another tenant's rows, whatever sync id it is given", async () => {
			expect(await flagOf(ids.otherTenant)).toBe(false);
			const result = await db.$transaction((tx) =>
				reconcileContextIndexing(tx, {
					projectId: other.projectId,
					organizationId: ORG_A,
					syncId: main.syncId,
					actingUserId: USER_ID,
				}),
			);

			expect(result.excluded + result.included).toBe(0);
		});

		it("skips the excluded rows in the awaiting-index scan and count, and keeps the others", async () => {
			const awaiting = await listContextRepositorySyncAwaitingIndex(
				{
					projectId: main.projectId,
					organizationId: main.organizationId,
				},
				main.syncId,
				{ limit: 50 },
			);
			const count = await countAwaitingIndexContexts(
				{
					projectId: main.projectId,
					organizationId: main.organizationId,
				},
				main.syncId,
			);

			expect(awaiting.map((row) => row.id)).toEqual([]);
			expect(count).toBe(0);
		});

		it("leaves the excluded rows out of the summarization volume and row counts", async () => {
			const tenancy = { userId: null, organizationId: ORG_A };

			const rows = await countRawContextRows({
				projectId: main.projectId,
				tenancy,
			});
			const candidates = await getContextVolumeCandidates({
				minChars: 1,
			});
			const mine = candidates.find((c) => c.projectId === main.projectId);

			expect(rows).toBe(3);
			expect(mine?.contextCount).toBe(3);
			expect(mine?.rawChars).toBe(150);
		});

		it("limits a batch's reconcile to its own paths", async () => {
			await addFolder(main, "docs/guide", "STORE_ONLY");

			const first = await reconcile(main, ["docs/other.md"]);
			expect(first).toMatchObject({ excluded: 0, included: 0 });
			expect(await flagOf(ids.outside)).toBe(false);

			const second = await reconcile(main, ["docs/guide/c.md"]);
			seededCleanupIds.push(...second.cleanups.map((c) => c.id));
			expect(second.excluded).toBe(1);
			expect(await flagOf(ids.outside)).toBe(true);
		});

		it("indexes the rows again when the folder is switched to INDEXED, and they are awaiting", async () => {
			await db.projectContextWriteTarget.update({
				where: { id: folderTarget.id },
				data: { indexMode: "INDEXED" },
			});

			const result = await reconcile(main);

			expect(result).toMatchObject({ excluded: 0, included: 2 });
			expect(await flagOf(ids.embedded)).toBe(false);
			const awaiting = await listContextRepositorySyncAwaitingIndex(
				{
					projectId: main.projectId,
					organizationId: main.organizationId,
				},
				main.syncId,
				{ limit: 50 },
			);
			expect(awaiting.map((row) => row.id).sort()).toEqual(
				[ids.embedded, ids.fresh].sort(),
			);
		});

		it("releases the store-only mark when the sync is disabled", async () => {
			expect(await flagOf(ids.outside)).toBe(true);

			const result = await deleteContextRepositorySync({
				projectId: main.projectId,
				organizationId: main.organizationId,
			});

			expect(result.deleted).toBe(true);
			expect(await flagOf(ids.outside)).toBe(false);
		});
	},
);
