/**
 * Real-Postgres tests for the two queries behind the Living Memory index-only
 * pass: `listContextRepositorySyncsAwaitingIndex` (which syncs have unindexed
 * rows in a content-change window and no run open, paged by id) and
 * `listContextRepositorySyncAwaitingIndexSince` (a sync's unindexed rows in
 * that window, each with the time its content last changed).
 *
 * The contract is the SQL: a `contentUpdatedAt` that is NULL falls back to
 * `createdAt`, the window is half-open, and the sync listing is unscoped by
 * design while the row listing is tenant-scoped. A mocked client cannot hold
 * any of that.
 *
 * The sync listing is unscoped, so every assertion about it names the exact
 * ids this run seeded and is made on the page it returned, which a foreign
 * row would break.
 *
 * Self-skips when DATABASE_URL is unset or is the CI placeholder.
 *
 * Run with:
 *   pnpm --filter @repo/database exec dotenv -c -e ../../.env.local -- vitest run __tests__/context-awaiting-index.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	db,
	listContextRepositorySyncAwaitingIndexSince,
	listContextRepositorySyncsAwaitingIndex,
} from "../index";
import { hasReachableDatabaseUrl } from "./_helpers/db-availability";

const RUN_ID = `${Date.now()}-${process.pid}`;
const USER_ID = `awaiting-index-user-${RUN_ID}`;
const ORG_A = `awaiting-index-org-a-${RUN_ID}`;
const ORG_B = `awaiting-index-org-b-${RUN_ID}`;

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const NOW = Date.now();
const ago = (ms: number) => new Date(NOW - ms);
/** The window the hourly pass reads: 1 to 65 hours ago. */
const WINDOW = { from: ago(65 * HOUR), to: ago(1 * HOUR) };

type Seeded = {
	projectId: string;
	syncId: string;
	organizationId: string;
};

const seededProjectIds: string[] = [];
const seededSyncIds: string[] = [];

async function seedSync(
	organizationId: string,
	label: string,
	activeRunKey: string | null,
): Promise<Seeded> {
	const project = await db.project.create({
		data: {
			name: `Awaiting Index ${label}`,
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
			repositoryUrl: `https://github.com/example-org/awaiting-${label}`,
			repositoryOwner: "example-org",
			repositoryName: `awaiting-${label}`,
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
			activeRunKey,
		},
	});
	seededSyncIds.push(sync.id);
	return { projectId: project.id, syncId: sync.id, organizationId };
}

function seedRow(
	target: Seeded,
	path: string,
	row: {
		contentUpdatedAt: Date | null;
		createdAt?: Date;
		embeddedAt?: Date | null;
	},
) {
	return db.projectContext.create({
		data: {
			projectId: target.projectId,
			organizationId: target.organizationId,
			type: "TEXT",
			content: "x",
			sourcePath: path,
			repositorySyncId: target.syncId,
			contentUpdatedAt: row.contentUpdatedAt,
			...(row.createdAt ? { createdAt: row.createdAt } : {}),
			embeddedAt: row.embeddedAt ?? null,
		},
		select: { id: true },
	});
}

describe.skipIf(!hasReachableDatabaseUrl())(
	"Living Memory index-only pass queries (real Postgres)",
	() => {
		let idle: Seeded;
		let open: Seeded;
		let pagedA: Seeded;
		let pagedB: Seeded;
		let otherTenant: Seeded;
		const ids: Record<string, string> = {};

		beforeAll(async () => {
			const now = new Date();
			await db.user.create({
				data: {
					id: USER_ID,
					name: "Awaiting Index",
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
			idle = await seedSync(ORG_A, "idle", null);
			open = await seedSync(ORG_A, "open", `${RUN_ID}:run-open`);
			pagedA = await seedSync(ORG_A, "paged-a", null);
			pagedB = await seedSync(ORG_A, "paged-b", null);
			otherTenant = await seedSync(ORG_B, "other", null);

			const changed = (ms: number) => ago(ms);
			for (const [name, ms] of [
				["h05", 30 * MINUTE],
				["h1", 1 * HOUR + MINUTE],
				["h3", 3 * HOUR],
				["h64", 64 * HOUR + MINUTE],
				["h66", 66 * HOUR],
			] as const) {
				ids[name] = (
					await seedRow(idle, `${name}.md`, {
						contentUpdatedAt: changed(ms),
					})
				).id;
			}
			ids.embedded = (
				await seedRow(idle, "embedded.md", {
					contentUpdatedAt: changed(3 * HOUR),
					embeddedAt: ago(2 * HOUR),
				})
			).id;
			ids.fallback = (
				await seedRow(idle, "fallback.md", {
					contentUpdatedAt: null,
					createdAt: changed(2 * HOUR),
				})
			).id;
			ids.fallbackOld = (
				await seedRow(idle, "fallback-old.md", {
					contentUpdatedAt: null,
					createdAt: changed(70 * HOUR),
				})
			).id;
			await seedRow(open, "open.md", {
				contentUpdatedAt: changed(3 * HOUR),
			});
			await seedRow(pagedA, "a.md", {
				contentUpdatedAt: changed(3 * HOUR),
			});
			await seedRow(pagedB, "b.md", {
				contentUpdatedAt: changed(3 * HOUR),
			});
			ids.other = (
				await seedRow(otherTenant, "other.md", {
					contentUpdatedAt: changed(3 * HOUR),
				})
			).id;
		});

		afterAll(async () => {
			// Delete by the exact ids this run created, never by pattern.
			if (seededSyncIds.length > 0) {
				await db.projectContext.deleteMany({
					where: { repositorySyncId: { in: seededSyncIds } },
				});
				await db.projectContextRepositorySync.deleteMany({
					where: { id: { in: seededSyncIds } },
				});
			}
			if (seededProjectIds.length > 0) {
				await db.projectRepositoryIntegration.deleteMany({
					where: { projectId: { in: seededProjectIds } },
				});
				await db.project.deleteMany({
					where: { id: { in: seededProjectIds } },
				});
			}
			await db.organization.deleteMany({
				where: { id: { in: [ORG_A, ORG_B] } },
			});
			await db.user.deleteMany({ where: { id: USER_ID } });
			await db.$disconnect();
		});

		const mine = (syncs: Array<{ id: string }>) =>
			syncs.map((s) => s.id).filter((id) => seededSyncIds.includes(id));

		it("lists the syncs with an unindexed row in the window and no run open, and never the one whose run is open", async () => {
			const syncs = await listContextRepositorySyncsAwaitingIndex({
				changedBetween: WINDOW,
				limit: 100,
			});

			expect(mine(syncs).sort()).toEqual(
				[
					idle.syncId,
					pagedA.syncId,
					pagedB.syncId,
					otherTenant.syncId,
				].sort(),
			);
			expect(mine(syncs)).not.toContain(open.syncId);
			expect(syncs.find((s) => s.id === idle.syncId)).toEqual({
				id: idle.syncId,
				projectId: idle.projectId,
				organizationId: ORG_A,
				userId: USER_ID,
			});
		});

		it("lists no sync whose only unindexed rows are outside the window", async () => {
			const syncs = await listContextRepositorySyncsAwaitingIndex({
				changedBetween: { from: ago(200 * HOUR), to: ago(100 * HOUR) },
				limit: 100,
			});

			expect(mine(syncs)).toEqual([]);
		});

		it("pages by id, returning every sync exactly once across pages", async () => {
			const seen: string[] = [];
			let afterId: string | null = null;
			for (let page = 0; page < 20; page++) {
				const syncs: Array<{ id: string }> =
					await listContextRepositorySyncsAwaitingIndex({
						changedBetween: WINDOW,
						afterId,
						limit: 2,
					});
				seen.push(...syncs.map((s) => s.id));
				afterId = syncs.at(-1)?.id ?? null;
				if (syncs.length < 2 || afterId === null) {
					break;
				}
			}

			expect(new Set(seen).size).toBe(seen.length);
			expect(mine(seen.map((id) => ({ id }))).sort()).toEqual(
				[
					idle.syncId,
					pagedA.syncId,
					pagedB.syncId,
					otherTenant.syncId,
				].sort(),
			);
			expect([...seen]).toEqual([...seen].sort());
		});

		it("returns exactly the unindexed rows inside the window, each with when its content last changed", async () => {
			const rows = await listContextRepositorySyncAwaitingIndexSince(
				{ projectId: idle.projectId, organizationId: ORG_A },
				idle.syncId,
				{ changedBetween: WINDOW, limit: 100 },
			);

			expect(rows.map((r) => r.sourcePath)).toEqual([
				"fallback.md",
				"h1.md",
				"h3.md",
				"h64.md",
			]);
			const byPath = new Map(rows.map((r) => [r.sourcePath, r]));
			const dbRow = (id: string) =>
				db.projectContext.findUniqueOrThrow({
					where: { id },
					select: { contentUpdatedAt: true, createdAt: true },
				});
			expect(byPath.get("h3.md")?.changedAt).toEqual(
				(await dbRow(ids.h3)).contentUpdatedAt,
			);
			expect(byPath.get("h64.md")?.changedAt).toEqual(
				(await dbRow(ids.h64)).contentUpdatedAt,
			);
			expect(byPath.get("fallback.md")?.changedAt).toEqual(
				(await dbRow(ids.fallback)).createdAt,
			);
			for (const excluded of [
				"h05.md",
				"h66.md",
				"embedded.md",
				"fallback-old.md",
			]) {
				expect(byPath.has(excluded)).toBe(false);
			}
		});

		it("pages a sync's rows by storage key", async () => {
			const first = await listContextRepositorySyncAwaitingIndexSince(
				{ projectId: idle.projectId, organizationId: ORG_A },
				idle.syncId,
				{ changedBetween: WINDOW, limit: 2 },
			);
			const second = await listContextRepositorySyncAwaitingIndexSince(
				{ projectId: idle.projectId, organizationId: ORG_A },
				idle.syncId,
				{
					changedBetween: WINDOW,
					afterKey: first.at(-1)?.sourcePath,
					limit: 2,
				},
			);

			expect(first.map((r) => r.sourcePath)).toEqual([
				"fallback.md",
				"h1.md",
			]);
			expect(second.map((r) => r.sourcePath)).toEqual([
				"h3.md",
				"h64.md",
			]);
		});

		it("never returns another tenant's rows, whichever scope or sync is named", async () => {
			const own = await listContextRepositorySyncAwaitingIndexSince(
				{ projectId: otherTenant.projectId, organizationId: ORG_B },
				otherTenant.syncId,
				{ changedBetween: WINDOW, limit: 100 },
			);
			const wrongScope =
				await listContextRepositorySyncAwaitingIndexSince(
					{ projectId: otherTenant.projectId, organizationId: ORG_A },
					otherTenant.syncId,
					{ changedBetween: WINDOW, limit: 100 },
				);
			const foreignSync =
				await listContextRepositorySyncAwaitingIndexSince(
					{ projectId: idle.projectId, organizationId: ORG_A },
					otherTenant.syncId,
					{ changedBetween: WINDOW, limit: 100 },
				);

			expect(own.map((r) => r.id)).toEqual([ids.other]);
			expect(wrongScope).toEqual([]);
			expect(foreignSync).toEqual([]);
		});
	},
);
