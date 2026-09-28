/**
 * Real-Postgres integration test for Glossy editions (Fizzy #2589).
 *
 * Two halves:
 *  1. The attempt guard, on the superuser connection the API and worker use:
 *     concurrent claims, stale-holder reclaim, finalize and fail against a
 *     superseding attempt, cache pruning, decision pruning, regenerate, and
 *     the Brand kit and recipient brand writers.
 *  2. Row-level security, under the NOSUPERUSER/NOBYPASSRLS test role
 *     (`_helpers/rls-role.ts`): the project tables admit the tenant and
 *     accepted project members and reject writes whose organizationId is not
 *     the parent project's; the Brand kit is readable by guests of the
 *     organization's projects and writable by the organization alone.
 *
 * Requires the Glossy migration and `apply:rls` on the target database.
 * Self-skips without a reachable DATABASE_URL.
 *
 * Run with: pnpm --filter @repo/database test:integration
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, type Prisma } from "../prisma/client";
import {
	BrandKitValidationError,
	getBrandKitForProject,
	upsertBrandKit,
} from "../prisma/queries/brand-kit";
import {
	applyVisualRegeneration,
	type ClaimGlossyBuildInput,
	claimGlossyBuild,
	clearVisualDecision,
	ensureGlossyEdition,
	failGlossyBuild,
	finalizeGlossyBuild,
	GLOSSY_WORKFLOW_START_FAILED,
	GlossyEditionTenantError,
	type GlossyGuardedOutcome,
	getCacheEntries,
	getGlossyBuildSnapshot,
	getGlossyEdition,
	heartbeatGlossyBuild,
	markGlossyBuildSuperseded,
	putCacheEntry,
	releaseGlossyClaim,
	upsertVisualDecision,
} from "../prisma/queries/projects/glossy-editions";
import { confirmRecipientBrand } from "../prisma/queries/projects/recipient-brand";
import { hasReachableDatabaseUrl } from "./_helpers/db-availability";
import {
	asRlsRole,
	ensureRlsTestRole,
	type TenantCtx,
} from "./_helpers/rls-role";

const RUN = `${Date.now()}-${process.pid}`;
const id = (name: string) => `glossy-it-${name}-${RUN}`;

const USERS = {
	owner: id("owner"),
	ownerB: id("owner-b"),
	guest: id("guest"),
	otherGuest: id("other-guest"),
	expired: id("expired"),
	pending: id("pending"),
};
const ORG_A = id("org-a");
const ORG_B = id("org-b");
const ORG_C = id("org-c");
const PA = id("project-a");
const PA2 = id("project-a2");
const PB = id("project-b");
const ORG_A_METADATA = JSON.stringify({ brandColor: "ocean" });

let documentCounter = 0;
async function freshDocument(projectId = PA): Promise<string> {
	documentCounter += 1;
	const documentId = id(`doc-${documentCounter}`);
	const project = await db.project.findUniqueOrThrow({
		where: { id: projectId },
		select: { organizationId: true, userId: true },
	});
	await db.projectDocument.create({
		data: {
			id: documentId,
			projectId,
			type: "BUSINESS_CASE",
			title: "Example business case",
			content: "# Example\n\n## Scope\n\nBody.",
			userId: project.userId,
			organizationId: project.organizationId,
		},
	});
	return documentId;
}

function snapshot(version = 1) {
	return {
		title: "Example business case",
		content: `# Example\n\n## Scope ${version}\n\nBody.`,
		version,
		contentHash: `hash-${version}`,
	};
}

function claim(
	documentId: string,
	overrides: Partial<ClaimGlossyBuildInput> = {},
) {
	return claimGlossyBuild({
		documentId,
		projectId: PA,
		organizationId: ORG_A,
		startedById: USERS.owner,
		options: { lengthMode: "standard", mode: "rollTheDice" },
		snapshot: snapshot(),
		...overrides,
	});
}

async function claimed(
	documentId: string,
	overrides: Partial<ClaimGlossyBuildInput> = {},
) {
	const result = await claim(documentId, overrides);
	if (result.outcome !== "claimed") {
		throw new Error(`expected a claim, got ${result.outcome}`);
	}
	return result;
}

function finalize(
	buildId: string,
	content: Prisma.InputJsonValue,
	extra: {
		sectionKeys?: string[];
		usedCacheKeys?: {
			kind: "REWRITE" | "DETECTION" | "EXTRACTION";
			cacheKey: string;
		}[];
		now?: Date;
	} = {},
) {
	return finalizeGlossyBuild({
		buildId,
		content,
		report: { keptOriginal: [] },
		sectionKeys: extra.sectionKeys ?? ["s1"],
		usedCacheKeys: extra.usedCacheKeys ?? [],
		now: extra.now,
	});
}

async function editionRow(documentId: string) {
	return db.glossyEdition.findUniqueOrThrow({
		where: { documentId },
		select: {
			content: true,
			publishedBuildId: true,
			currentBuildId: true,
			contentRevision: true,
		},
	});
}

function deferred<T = void>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

/**
 * Wait until a session is blocked by `pid`: `directly`, or through a waiter
 * that is itself blocked by `pid`.
 */
async function untilBlockedBy(
	pid: number,
	through: "directly" | "via a waiter",
): Promise<void> {
	const deadline = Date.now() + 10_000;
	for (;;) {
		const [{ n }] =
			through === "directly"
				? await db.$queryRaw<{ n: number }[]>`
					SELECT count(*)::int AS n FROM pg_stat_activity
					WHERE ${pid}::int = ANY(pg_blocking_pids(pid))`
				: await db.$queryRaw<{ n: number }[]>`
					SELECT count(*)::int AS n FROM pg_stat_activity AS waiter
					WHERE EXISTS (
						SELECT 1 FROM unnest(pg_blocking_pids(waiter.pid)) AS holder(pid)
						WHERE ${pid}::int = ANY(pg_blocking_pids(holder.pid))
					)`;
		if (n > 0) {
			return;
		}
		if (Date.now() > deadline) {
			throw new Error(`no session blocked by ${pid} ${through}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

describe.skipIf(!hasReachableDatabaseUrl())(
	"Glossy editions (real Postgres)",
	() => {
		beforeAll(async () => {
			const present = await db.$queryRaw<{ name: string | null }[]>`
				SELECT to_regclass('public.glossy_edition')::text AS name`;
			if (!present[0]?.name) {
				throw new Error(
					"glossy_edition is missing: apply the *_glossy_editions migration (prisma migrate deploy) and apply:rls to this database first",
				);
			}

			const now = new Date();
			for (const userId of Object.values(USERS)) {
				await db.user.create({
					data: {
						id: userId,
						name: userId,
						email: `${userId}@example.com`,
						emailVerified: true,
						createdAt: now,
						updatedAt: now,
					},
				});
			}
			for (const [orgId, metadata] of [
				[ORG_A, ORG_A_METADATA],
				[ORG_B, null],
				[ORG_C, null],
			] as const) {
				await db.organization.create({
					data: {
						id: orgId,
						name: `Example ${orgId}`,
						slug: orgId,
						createdAt: now,
						metadata,
					},
				});
			}
			for (const [projectId, organizationId, userId] of [
				[PA, ORG_A, USERS.owner],
				[PA2, ORG_A, USERS.owner],
				[PB, ORG_B, USERS.ownerB],
			] as const) {
				await db.project.create({
					data: {
						id: projectId,
						name: `Example ${projectId}`,
						userId,
						organizationId,
						techStack: [],
						features: [],
						tags: [],
					},
				});
			}
			const accepted = new Date();
			const memberships: {
				projectId: string;
				userId: string;
				acceptedAt: Date | null;
				expiresAt: Date | null;
			}[] = [
				// The guest belongs to no organization at all.
				{
					projectId: PA,
					userId: USERS.guest,
					acceptedAt: accepted,
					expiresAt: null,
				},
				{
					projectId: PA2,
					userId: USERS.guest,
					acceptedAt: accepted,
					expiresAt: null,
				},
				{
					projectId: PB,
					userId: USERS.otherGuest,
					acceptedAt: accepted,
					expiresAt: null,
				},
				{
					projectId: PA,
					userId: USERS.expired,
					acceptedAt: accepted,
					expiresAt: new Date(Date.now() - 60_000),
				},
				{
					projectId: PA,
					userId: USERS.pending,
					acceptedAt: null,
					expiresAt: null,
				},
			];
			for (const membership of memberships) {
				await db.projectMember.create({
					data: {
						...membership,
						role: "EDITOR",
						invitedBy: USERS.owner,
					},
				});
			}
		});

		afterAll(async () => {
			// Projects cascade to documents, members and every Glossy row;
			// organizations cascade to their Brand kits.
			await db.project.deleteMany({
				where: { id: { in: [PA, PA2, PB] } },
			});
			await db.organization.deleteMany({
				where: { id: { in: [ORG_A, ORG_B, ORG_C] } },
			});
			await db.user.deleteMany({
				where: { id: { in: Object.values(USERS) } },
			});
		});

		describe("claim", () => {
			it("two concurrent first claims on a missing row yield exactly one claimed, with no unique violation", async () => {
				const documentId = await freshDocument();
				const results = await Promise.all(
					Array.from({ length: 5 }, () => claim(documentId)),
				);
				const winners = results.filter((r) => r.outcome === "claimed");
				expect(winners).toHaveLength(1);
				const [winner] = winners;
				for (const result of results) {
					if (result.outcome === "alreadyBuilding") {
						expect(result.holder?.buildId).toBe(
							winner.outcome === "claimed"
								? winner.buildId
								: undefined,
						);
					}
				}
				expect(
					await db.glossyEdition.count({ where: { documentId } }),
				).toBe(1);
				expect(
					await db.glossyBuild.count({ where: { documentId } }),
				).toBe(1);
			});

			it("a claim while a building attempt has a fresh heartbeat returns alreadyBuilding with its starter and start time", async () => {
				const documentId = await freshDocument();
				const first = await claimed(documentId);
				const second = await claim(documentId, {
					startedById: USERS.guest,
				});
				expect(second).toEqual({
					outcome: "alreadyBuilding",
					holder: {
						buildId: first.buildId,
						startedById: USERS.owner,
						startedAt: first.startedAt,
						heartbeatAt: first.startedAt,
						workflowId: first.workflowId,
					},
				});
				expect(first.workflowId).toBe(
					`glossy-edition-build-${documentId}-${first.buildId}`,
				);
			});

			it("a stale holder is reclaimed only once its heartbeat is stale, and the new attempt carries its own snapshot", async () => {
				const documentId = await freshDocument();
				const holder = await claimed(documentId);
				const staleBefore = new Date(Date.now() - 60_000);

				const refused = await claim(documentId, {
					reclaim: { holderBuildId: holder.buildId, staleBefore },
				});
				expect(refused.outcome).toBe("alreadyBuilding");

				await db.glossyBuild.update({
					where: { id: holder.buildId },
					data: { heartbeatAt: new Date(Date.now() - 10 * 60_000) },
				});
				const next = await claimed(documentId, {
					reclaim: { holderBuildId: holder.buildId, staleBefore },
					snapshot: snapshot(2),
				});
				expect(next.buildId).not.toBe(holder.buildId);

				const rows = await db.glossyBuild.findMany({
					where: { documentId },
					select: {
						id: true,
						status: true,
						sourceVersion: true,
						sourceContent: true,
					},
				});
				expect(rows.find((r) => r.id === holder.buildId)?.status).toBe(
					"SUPERSEDED",
				);
				expect(rows.find((r) => r.id === next.buildId)).toMatchObject({
					status: "BUILDING",
					sourceVersion: 2,
					sourceContent: snapshot(2).content,
				});
				expect((await editionRow(documentId)).currentBuildId).toBe(
					next.buildId,
				);

				// The retired run's guarded writes now all refuse.
				expect(await heartbeatGlossyBuild(holder.buildId)).toBe(
					"superseded",
				);
				expect(
					await putCacheEntry({
						documentId,
						projectId: PA,
						kind: "REWRITE",
						cacheKey: "from-the-retired-run",
						output: { text: "late" },
						buildId: holder.buildId,
					}),
				).toBe("superseded");
				expect(
					await db.glossySegmentCache.count({
						where: { documentId, cacheKey: "from-the-retired-run" },
					}),
				).toBe(0);
				expect(await markGlossyBuildSuperseded(holder.buildId)).toBe(
					"unchanged",
				);
				// The live attempt heartbeats and caches normally.
				expect(
					await heartbeatGlossyBuild(next.buildId, {
						step: "rewrite",
						sectionsDone: 1,
						sectionsTotal: 4,
					}),
				).toBe("applied");
				expect(await markGlossyBuildSuperseded(next.buildId)).toBe(
					"unchanged",
				);
			});

			it("markGlossyBuildSuperseded retires an attempt left BUILDING after the claim moved on, and only that attempt", async () => {
				const documentId = await freshDocument();
				const stray = await claimed(documentId);
				// No writer leaves this state behind; it is what the function
				// cleans up if one ever does, so it is set up by hand.
				const now = new Date();
				const successor = await db.glossyBuild.create({
					data: {
						documentId,
						projectId: PA,
						organizationId: ORG_A,
						status: "BUILDING",
						startedAt: now,
						heartbeatAt: now,
						options: {},
						sourceTitle: "t",
						sourceContent: "c",
						sourceVersion: 2,
						sourceContentHash: "h",
					},
					select: { id: true },
				});
				await db.glossyEdition.update({
					where: { documentId },
					data: { currentBuildId: successor.id },
				});

				const at = new Date(now.getTime() + 1_000);
				expect(await markGlossyBuildSuperseded(stray.buildId, at)).toBe(
					"marked",
				);
				const statusOf = (buildId: string) =>
					db.glossyBuild.findUniqueOrThrow({
						where: { id: buildId },
						select: { status: true, finishedAt: true },
					});
				expect(await statusOf(stray.buildId)).toEqual({
					status: "SUPERSEDED",
					finishedAt: at,
				});
				expect(await markGlossyBuildSuperseded(stray.buildId)).toBe(
					"unchanged",
				);
				// The attempt holding the claim is never touched.
				expect(await markGlossyBuildSuperseded(successor.id)).toBe(
					"unchanged",
				);
				expect(await statusOf(successor.id)).toEqual({
					status: "BUILDING",
					finishedAt: null,
				});
				expect((await editionRow(documentId)).currentBuildId).toBe(
					successor.id,
				);
			});

			it("an attempt's snapshot reads back exactly as claimed; an unknown attempt reads as null", async () => {
				const documentId = await freshDocument();
				const build = await claimed(documentId, {
					startedById: USERS.guest,
					snapshot: snapshot(3),
				});
				expect(await getGlossyBuildSnapshot(build.buildId)).toEqual({
					buildId: build.buildId,
					documentId,
					projectId: PA,
					organizationId: ORG_A,
					status: "BUILDING",
					startedById: USERS.guest,
					startedAt: build.startedAt,
					options: { lengthMode: "standard", mode: "rollTheDice" },
					title: snapshot(3).title,
					content: snapshot(3).content,
					version: 3,
					contentHash: "hash-3",
				});
				expect(
					await getGlossyBuildSnapshot(id("no-such-build")),
				).toBeNull();
			});

			it("rows written for a guest editor's build land with the host organization's tenant columns", async () => {
				const documentId = await freshDocument();
				const build = await claimed(documentId, {
					startedById: USERS.guest,
				});
				expect(build.organizationId).toBe(ORG_A);
				const row = await db.glossyBuild.findUniqueOrThrow({
					where: { id: build.buildId },
					select: {
						organizationId: true,
						projectId: true,
						startedById: true,
					},
				});
				expect(row).toEqual({
					organizationId: ORG_A,
					projectId: PA,
					startedById: USERS.guest,
				});
			});

			it("refuses a claim whose organization disagrees with the document's, writing nothing", async () => {
				const documentId = await freshDocument();
				await expect(
					claim(documentId, { organizationId: ORG_B }),
				).rejects.toBeInstanceOf(GlossyEditionTenantError);
				await expect(
					claim(documentId, { projectId: PB, organizationId: ORG_B }),
				).rejects.toBeInstanceOf(GlossyEditionTenantError);
				expect(
					await db.glossyEdition.count({ where: { documentId } }),
				).toBe(0);
				expect(
					await db.glossyBuild.count({ where: { documentId } }),
				).toBe(0);
			});

			it("a released claim (failed workflow start) can be claimed again", async () => {
				const documentId = await freshDocument();
				const first = await claimed(documentId);
				expect(await releaseGlossyClaim(first.buildId)).toBe("applied");
				const row = await db.glossyBuild.findUniqueOrThrow({
					where: { id: first.buildId },
					select: { status: true, errorCode: true },
				});
				expect(row).toEqual({
					status: "FAILED",
					errorCode: GLOSSY_WORKFLOW_START_FAILED,
				});
				expect((await claim(documentId)).outcome).toBe("claimed");
			});
		});

		describe("finalize and fail", () => {
			it("finalize with the current build swaps content and publishedBuildId; with an old build returns superseded and changes nothing", async () => {
				const documentId = await freshDocument();
				const first = await claimed(documentId);
				expect(await finalize(first.buildId, { v: 1 })).toEqual({
					outcome: "applied",
					editionId: expect.any(String),
					contentRevision: 1,
				});
				expect(await editionRow(documentId)).toEqual({
					content: { v: 1 },
					publishedBuildId: first.buildId,
					currentBuildId: null,
					contentRevision: 1,
				});

				const second = await claimed(documentId);
				expect(await finalize(first.buildId, { v: "stale" })).toEqual({
					outcome: "superseded",
				});
				expect(await editionRow(documentId)).toEqual({
					content: { v: 1 },
					publishedBuildId: first.buildId,
					currentBuildId: second.buildId,
					contentRevision: 1,
				});
				expect(
					(
						await db.glossyBuild.findUniqueOrThrow({
							where: { id: second.buildId },
							select: { status: true },
						})
					).status,
				).toBe("BUILDING");
			});

			it("fail with the current build keeps the published content; fail with an old build changes nothing", async () => {
				const documentId = await freshDocument();
				const first = await claimed(documentId);
				await finalize(first.buildId, { v: 1 });
				const second = await claimed(documentId);

				expect(
					await failGlossyBuild({
						buildId: second.buildId,
						errorCode: "MODEL_ERROR",
						errorMessage: "The model call failed.",
					}),
				).toBe("applied");
				expect(await editionRow(documentId)).toEqual({
					content: { v: 1 },
					publishedBuildId: first.buildId,
					currentBuildId: null,
					contentRevision: 1,
				});

				const view = await getGlossyEdition({
					documentId,
					projectId: PA,
				});
				expect(view?.publishedBuild?.id).toBe(first.buildId);
				expect(view?.currentBuild).toBeNull();
				expect(view?.latestAttempt).toMatchObject({
					id: second.buildId,
					status: "FAILED",
					errorCode: "MODEL_ERROR",
				});
				// `get` never loads a snapshot.
				expect(view?.latestAttempt).not.toHaveProperty("sourceContent");

				for (const buildId of [second.buildId, first.buildId]) {
					expect(
						await failGlossyBuild({
							buildId,
							errorCode: "LATE",
							errorMessage: "late",
						}),
					).toBe("superseded");
				}
				expect(await editionRow(documentId)).toEqual({
					content: { v: 1 },
					publishedBuildId: first.buildId,
					currentBuildId: null,
					contentRevision: 1,
				});
			});

			it("prune keeps a row written after the claim and a row the build used, and deletes an unused row older than the claim", async () => {
				const documentId = await freshDocument();
				const claimAt = new Date(Date.now() - 60_000);
				const before = new Date(claimAt.getTime() - 10 * 60_000);
				for (const cacheKey of ["old-unused", "old-used"]) {
					await putCacheEntry({
						documentId,
						projectId: PA,
						kind: "REWRITE",
						cacheKey,
						output: { text: cacheKey },
						now: before,
					});
				}
				const build = await claimed(documentId, { now: claimAt });
				// An Align-first detection running while the build does.
				await putCacheEntry({
					documentId,
					projectId: PA,
					kind: "DETECTION",
					cacheKey: "after-claim",
					output: { opportunities: [] },
					now: new Date(claimAt.getTime() + 1_000),
				});
				expect(
					await putCacheEntry({
						documentId,
						projectId: PA,
						kind: "REWRITE",
						cacheKey: "by-the-build",
						output: { text: "rewritten" },
						buildId: build.buildId,
						now: new Date(claimAt.getTime() + 2_000),
					}),
				).toBe("applied");

				await finalize(
					build.buildId,
					{ v: 1 },
					{
						usedCacheKeys: [
							{ kind: "REWRITE", cacheKey: "old-used" },
						],
					},
				);
				const remaining = await db.glossySegmentCache.findMany({
					where: { documentId },
					select: { cacheKey: true },
					orderBy: { cacheKey: "asc" },
				});
				expect(remaining.map((r) => r.cacheKey)).toEqual([
					"after-claim",
					"by-the-build",
					"old-used",
				]);
			});

			it("a decision for a section that still exists survives a build whose content omits the visual", async () => {
				const documentId = await freshDocument();
				const first = await claimed(documentId);
				await finalize(
					first.buildId,
					{ v: 1 },
					{ sectionKeys: ["s1", "s2"] },
				);
				await upsertVisualDecision({
					documentId,
					projectId: PA,
					visualKey: "visual-s1",
					sectionKey: "s1",
					decision: "DISCARDED",
					decidedById: USERS.owner,
				});
				await upsertVisualDecision({
					documentId,
					projectId: PA,
					visualKey: "visual-s2",
					sectionKey: "s2",
					decision: "ACCEPTED",
					specHash: "spec-1",
					decidedById: USERS.guest,
				});

				const second = await claimed(documentId);
				await finalize(
					second.buildId,
					{ v: 2 },
					{ sectionKeys: ["s1"] },
				);

				const decisions = await db.glossyVisualDecision.findMany({
					where: { edition: { documentId } },
					select: { visualKey: true, organizationId: true },
				});
				expect(decisions).toEqual([
					{ visualKey: "visual-s1", organizationId: ORG_A },
				]);
				// Finalize also dropped the superseded attempt rows.
				expect(
					(
						await db.glossyBuild.findMany({
							where: { documentId },
							select: { id: true },
						})
					).map((r) => r.id),
				).toEqual([second.buildId]);

				// Restore removes the decision; a second restore finds none.
				const restore = () =>
					clearVisualDecision({
						documentId,
						projectId: PA,
						visualKey: "visual-s1",
					});
				expect(await restore()).toBe(true);
				expect(await restore()).toBe(false);
			});

			it("a cache write that arrives while finalize holds the attempt waits for it, then is superseded", async () => {
				const documentId = await freshDocument();
				const build = await claimed(documentId);

				// A third session holds the edition row, so finalize stops
				// after its first statement (the attempt lock) and before its
				// swap: the gap a late cache write could once slip through.
				const locked = deferred<number>();
				const release = deferred();
				const holder = db.$transaction(
					async (tx) => {
						const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`
							SELECT pg_backend_pid() AS pid`;
						await tx.$queryRaw`SELECT 1 FROM "glossy_edition"
							WHERE "documentId" = ${documentId} FOR UPDATE`;
						locked.resolve(pid);
						await release.promise;
					},
					{ timeout: 20_000 },
				);
				const holderPid = await Promise.race([
					locked.promise,
					holder.then(() => null),
				]);
				if (holderPid === null) {
					throw new Error("the holder ended before locking");
				}

				const finalizing = finalize(build.buildId, { v: 1 });
				let caching: Promise<GlossyGuardedOutcome> | undefined;
				try {
					await untilBlockedBy(holderPid, "directly");
					caching = putCacheEntry({
						documentId,
						projectId: PA,
						kind: "REWRITE",
						cacheKey: "during-finalize",
						output: { text: "late" },
						buildId: build.buildId,
					});
					// The cache write waits on finalize, which waits on the holder.
					await untilBlockedBy(holderPid, "via a waiter");
				} finally {
					release.resolve();
					await holder;
				}

				expect(await finalizing).toMatchObject({ outcome: "applied" });
				expect(await caching).toBe("superseded");
				expect(
					await db.glossySegmentCache.count({
						where: { documentId, cacheKey: "during-finalize" },
					}),
				).toBe(0);
			});
		});

		describe("segment cache", () => {
			it("getCacheEntries returns what putCacheEntry stored, for the asked document, kind and keys only", async () => {
				const documentId = await freshDocument();
				const otherDocumentId = await freshDocument();
				const build = await claimed(documentId);
				const put = (
					forDocument: string,
					kind: "REWRITE" | "DETECTION",
					cacheKey: string,
					output: Prisma.InputJsonValue,
					buildId?: string,
				) =>
					putCacheEntry({
						documentId: forDocument,
						projectId: PA,
						kind,
						cacheKey,
						output,
						buildId,
					});

				expect(
					await put(
						documentId,
						"REWRITE",
						"k1",
						{ text: "one" },
						build.buildId,
					),
				).toBe("applied");
				await put(documentId, "REWRITE", "k2", { text: "two" });
				await put(documentId, "REWRITE", "k2", { text: "two, again" });
				await put(documentId, "DETECTION", "k1", { opportunities: [] });
				await put(otherDocumentId, "REWRITE", "k3", { text: "other" });

				expect(
					await getCacheEntries({
						documentId,
						kind: "REWRITE",
						cacheKeys: ["k1", "k2", "k3", "missing"],
					}),
				).toEqual(
					new Map([
						["k1", { text: "one" }],
						["k2", { text: "two, again" }],
					]),
				);
				expect(
					await getCacheEntries({
						documentId,
						kind: "DETECTION",
						cacheKeys: ["k1"],
					}),
				).toEqual(new Map([["k1", { opportunities: [] }]]));
			});
		});

		describe("regenerate", () => {
			it("a stale contentRevision, or a rebuild claimed in between, returns superseded and writes no cache row", async () => {
				const documentId = await freshDocument();
				const first = await claimed(documentId);
				await finalize(first.buildId, { v: 1 });
				await upsertVisualDecision({
					documentId,
					projectId: PA,
					visualKey: "visual-1",
					sectionKey: "s1",
					decision: "ACCEPTED",
					specHash: "spec-1",
					decidedById: USERS.owner,
				});

				const regenerate = (revision: number, cacheKey: string) =>
					applyVisualRegeneration({
						documentId,
						projectId: PA,
						expectedPublishedBuildId: first.buildId,
						expectedContentRevision: revision,
						content: { v: 1, regenerated: cacheKey },
						visualKey: "visual-1",
						cacheEntry: {
							cacheKey,
							sectionKey: "s1",
							output: { spec: cacheKey },
						},
					});
				const cacheRows = (cacheKey: string) =>
					db.glossySegmentCache.count({
						where: { documentId, kind: "EXTRACTION", cacheKey },
					});

				expect(await regenerate(0, "stale-revision")).toEqual({
					outcome: "superseded",
				});
				expect(await cacheRows("stale-revision")).toBe(0);

				expect(await regenerate(1, "fresh")).toEqual({
					outcome: "applied",
					contentRevision: 2,
				});
				expect(await cacheRows("fresh")).toBe(1);
				// The acceptance approved the old spec, so it is cleared.
				expect(
					await db.glossyVisualDecision.count({
						where: {
							edition: { documentId },
							visualKey: "visual-1",
						},
					}),
				).toBe(0);

				await claimed(documentId);
				expect(await regenerate(2, "during-rebuild")).toEqual({
					outcome: "superseded",
				});
				expect(await cacheRows("during-rebuild")).toBe(0);
				expect((await editionRow(documentId)).contentRevision).toBe(2);
			});

			it("two regenerates of different visuals racing on one revision: one applies, the other writes nothing until it re-applies its splice to the fresh revision, and both persist", async () => {
				const documentId = await freshDocument();
				const first = await claimed(documentId);
				await finalize(first.buildId, {
					visuals: { a: "old-a", b: "old-b" },
				});
				const regenerate = (
					revision: number,
					visuals: Record<string, string>,
					visualKey: "a" | "b",
				) =>
					applyVisualRegeneration({
						documentId,
						projectId: PA,
						expectedPublishedBuildId: first.buildId,
						expectedContentRevision: revision,
						content: { visuals },
						visualKey,
						cacheEntry: {
							cacheKey: `extract-${visualKey}`,
							sectionKey: `s-${visualKey}`,
							output: { spec: `new-${visualKey}` },
						},
					});
				const cacheRows = (visualKey: "a" | "b") =>
					db.glossySegmentCache.count({
						where: {
							documentId,
							kind: "EXTRACTION",
							cacheKey: `extract-${visualKey}`,
						},
					});

				// Both spliced into the revision they read (1).
				const [a, b] = await Promise.all([
					regenerate(1, { a: "new-a", b: "old-b" }, "a"),
					regenerate(1, { a: "old-a", b: "new-b" }, "b"),
				]);
				expect([a.outcome, b.outcome].sort()).toEqual([
					"applied",
					"superseded",
				]);
				const loser = a.outcome === "superseded" ? "a" : "b";
				const winner = loser === "a" ? "b" : "a";
				expect(await cacheRows(winner)).toBe(1);
				expect(await cacheRows(loser)).toBe(0);

				// The loser re-reads, splices its one visual into the fresh
				// content, and writes again: no lost update.
				const fresh = await editionRow(documentId);
				expect(fresh.contentRevision).toBe(2);
				const { visuals } = fresh.content as {
					visuals: Record<string, string>;
				};
				expect(
					await regenerate(
						2,
						{ ...visuals, [loser]: `new-${loser}` },
						loser,
					),
				).toEqual({ outcome: "applied", contentRevision: 3 });
				expect((await editionRow(documentId)).content).toEqual({
					visuals: { a: "new-a", b: "new-b" },
				});
				expect(await cacheRows(loser)).toBe(1);
			});
		});

		describe("review", () => {
			it("a discard survives a regenerate of its visual and a rebuild of its unchanged section; restore makes it pending again", async () => {
				const documentId = await freshDocument();
				const first = await claimed(documentId);
				await finalize(
					first.buildId,
					{ v: 1 },
					{ sectionKeys: ["s-exec", "s-team"] },
				);
				await upsertVisualDecision({
					documentId,
					projectId: PA,
					visualKey: "visual-team",
					sectionKey: "s-team",
					decision: "DISCARDED",
					decidedById: USERS.guest,
				});
				const decisions = async () =>
					(await getGlossyEdition({ documentId, projectId: PA }))
						?.decisions ?? [];

				// A regenerate clears an acceptance only; a discard stays.
				expect(
					await applyVisualRegeneration({
						documentId,
						projectId: PA,
						expectedPublishedBuildId: first.buildId,
						expectedContentRevision: 1,
						content: { v: 1, regenerated: true },
						visualKey: "visual-team",
						cacheEntry: {
							cacheKey: "extract-team",
							sectionKey: "s-team",
							output: { spec: "regenerated" },
						},
					}),
				).toEqual({ outcome: "applied", contentRevision: 2 });

				// A rebuild whose sections are unchanged, so the visual keeps
				// its key and the decision its section.
				const rebuild = await claimed(documentId, {
					snapshot: snapshot(2),
				});
				await finalize(
					rebuild.buildId,
					{ v: 2 },
					{ sectionKeys: ["s-exec", "s-team"] },
				);
				expect(
					(await getGlossyEdition({ documentId, projectId: PA }))
						?.publishedBuildId,
				).toBe(rebuild.buildId);
				expect(await decisions()).toEqual([
					expect.objectContaining({
						visualKey: "visual-team",
						sectionKey: "s-team",
						decision: "DISCARDED",
						specHash: null,
						decidedById: USERS.guest,
					}),
				]);

				expect(
					await clearVisualDecision({
						documentId,
						projectId: PA,
						visualKey: "visual-team",
					}),
				).toBe(true);
				expect(await decisions()).toEqual([]);
			});
		});

		describe("Brand kit", () => {
			it("keeps one row per organization, updates it in place, validates accents, and leaves organization metadata alone", async () => {
				const created = await upsertBrandKit({
					organizationId: ORG_A,
					accentColors: ["#AABBCC"],
					guidance: "  Calm, factual tone.  ",
					updatedById: USERS.owner,
				});
				expect(created.brandKit).toMatchObject({
					organizationId: ORG_A,
					accentColors: ["#aabbcc"],
					guidance: "Calm, factual tone.",
				});
				expect(created.changedFields).toEqual([
					"accentColors",
					"guidance",
				]);

				const updated = await upsertBrandKit({
					organizationId: ORG_A,
					accentColors: ["#112233", "#445566"],
					guidance: "Calm, factual tone.",
					updatedById: USERS.owner,
				});
				expect(updated.changedFields).toEqual(["accentColors"]);
				expect(
					await db.organizationBrandKit.count({
						where: { organizationId: ORG_A },
					}),
				).toBe(1);

				await expect(
					upsertBrandKit({
						organizationId: ORG_A,
						accentColors: [
							"#111111",
							"#222222",
							"#333333",
							"#444444",
						],
						updatedById: USERS.owner,
					}),
				).rejects.toBeInstanceOf(BrandKitValidationError);
				await expect(
					upsertBrandKit({
						organizationId: ORG_A,
						accentColors: ["teal"],
						updatedById: USERS.owner,
					}),
				).rejects.toBeInstanceOf(BrandKitValidationError);
				// The database refuses the same values without the query layer.
				await expect(
					db.organizationBrandKit.update({
						where: { organizationId: ORG_A },
						data: { accentColors: ["#AABBCC"] },
					}),
				).rejects.toThrow();

				const kit = await db.organizationBrandKit.findUniqueOrThrow({
					where: { organizationId: ORG_A },
					select: { accentColors: true },
				});
				expect(kit.accentColors).toEqual(["#112233", "#445566"]);
				const org = await db.organization.findUniqueOrThrow({
					where: { id: ORG_A },
					select: { metadata: true },
				});
				expect(org.metadata).toBe(ORG_A_METADATA);
			});

			it("getBrandKitForProject returns the kit of the project's own organization and nothing for an unknown project", async () => {
				await upsertBrandKit({
					organizationId: ORG_B,
					accentColors: ["#0a0b0c"],
					updatedById: USERS.ownerB,
				});
				expect((await getBrandKitForProject(PA))?.organizationId).toBe(
					ORG_A,
				);
				expect((await getBrandKitForProject(PB))?.organizationId).toBe(
					ORG_B,
				);
				expect(
					await getBrandKitForProject(id("no-such-project")),
				).toBeNull();
			});
		});

		describe("recipient brand", () => {
			it("confirms by compare-and-set on version; a stale version conflicts and writes nothing", async () => {
				const logo = (promotionId: string) =>
					`project-brand/${PA}/recipient-brand/current/${promotionId}.png`;
				const confirm = (
					expectedVersion: number,
					promotionId: string,
				) =>
					confirmRecipientBrand({
						projectId: PA,
						expectedVersion,
						name: "Example Client",
						website: "https://Example.com/",
						logoKey: logo(promotionId),
						colors: ["#0055AA"],
						updatedById: USERS.guest,
					});

				expect(await confirm(0, "first")).toEqual({
					outcome: "applied",
					version: 1,
					previousLogoKey: null,
				});
				expect(await confirm(0, "racing-first")).toEqual({
					outcome: "conflict",
				});
				expect(await confirm(1, "second")).toEqual({
					outcome: "applied",
					version: 2,
					previousLogoKey: logo("first"),
				});
				expect(await confirm(1, "stale")).toEqual({
					outcome: "conflict",
				});

				const row = await db.projectRecipientBrand.findUniqueOrThrow({
					where: { projectId: PA },
					select: {
						version: true,
						logoKey: true,
						website: true,
						colors: true,
						organizationId: true,
					},
				});
				expect(row).toEqual({
					version: 2,
					logoKey: logo("second"),
					website: "https://example.com",
					colors: ["#0055aa"],
					organizationId: ORG_A,
				});

				// Another project's logo key is unrepresentable in the database.
				await expect(
					db.projectRecipientBrand.update({
						where: { projectId: PA },
						data: {
							logoKey: `project-brand/${PB}/recipient-brand/current/x.png`,
						},
					}),
				).rejects.toThrow();
			});
		});

		describe("row-level security (restricted role)", () => {
			const guest: TenantCtx = {
				type: "personal",
				tenantId: USERS.guest,
				userId: USERS.guest,
			};
			const otherGuest: TenantCtx = {
				type: "personal",
				tenantId: USERS.otherGuest,
				userId: USERS.otherGuest,
			};
			const expired: TenantCtx = {
				type: "personal",
				tenantId: USERS.expired,
				userId: USERS.expired,
			};
			const pending: TenantCtx = {
				type: "personal",
				tenantId: USERS.pending,
				userId: USERS.pending,
			};
			const orgA: TenantCtx = {
				type: "organization",
				tenantId: ORG_A,
				userId: USERS.owner,
			};
			const orgB: TenantCtx = {
				type: "organization",
				tenantId: ORG_B,
				userId: USERS.ownerB,
			};

			let documentId: string;
			let spareDocumentId: string;
			let editionId: string;

			class Rollback extends Error {}

			/** Run `fn` under RLS and roll it back; report whether RLS denied it. */
			async function attempt(
				ctx: TenantCtx,
				fn: (tx: Prisma.TransactionClient) => Promise<unknown>,
			): Promise<"ok" | "denied"> {
				try {
					await asRlsRole(ctx, async (tx) => {
						await fn(tx);
						throw new Rollback();
					});
				} catch (error) {
					if (error instanceof Rollback) {
						return "ok";
					}
					if (
						/row-level security/i.test(
							String((error as Error).message),
						)
					) {
						return "denied";
					}
					throw error;
				}
				return "ok";
			}

			beforeAll(async () => {
				const policies = await db.$queryRaw<{ policyname: string }[]>`
					SELECT policyname::text AS policyname FROM pg_policies
					WHERE tablename = 'organization_brand_kit'`;
				const names = policies.map((p) => p.policyname).sort();
				if (!names.includes("project_guest_read")) {
					throw new Error(
						"Brand kit RLS policies are missing: run apply:rls against this database first",
					);
				}
				await ensureRlsTestRole();

				documentId = await freshDocument();
				spareDocumentId = await freshDocument();
				const build = await claimed(documentId);
				editionId = (
					await ensureGlossyEdition({ documentId, projectId: PA })
				).id;
				await upsertVisualDecision({
					documentId,
					projectId: PA,
					visualKey: "rls-visual",
					sectionKey: "s1",
					decision: "DISCARDED",
					decidedById: USERS.owner,
				});
				await putCacheEntry({
					documentId,
					projectId: PA,
					kind: "REWRITE",
					cacheKey: "rls-row",
					output: { text: "cached" },
					buildId: build.buildId,
				});
				await db.projectRecipientBrand.deleteMany({
					where: { projectId: PA },
				});
				await confirmRecipientBrand({
					projectId: PA,
					expectedVersion: 0,
					name: "Example Client",
					updatedById: USERS.owner,
				});
				await upsertBrandKit({
					organizationId: ORG_A,
					accentColors: ["#123456"],
					updatedById: USERS.owner,
				});
				await upsertBrandKit({
					organizationId: ORG_B,
					accentColors: ["#654321"],
					updatedById: USERS.ownerB,
				});
			});

			type Table = {
				name: string;
				count: (tx: Prisma.TransactionClient) => Promise<number>;
				insert: (
					tx: Prisma.TransactionClient,
					organizationId: string,
				) => Promise<unknown>;
				retenant: (
					tx: Prisma.TransactionClient,
					organizationId: string,
				) => Promise<unknown>;
			};

			const tables: Table[] = [
				{
					name: "glossy_edition",
					count: (tx) =>
						tx.glossyEdition.count({ where: { projectId: PA } }),
					insert: (tx, organizationId) =>
						tx.glossyEdition.create({
							data: {
								documentId: spareDocumentId,
								projectId: PA,
								organizationId,
							},
						}),
					retenant: (tx, organizationId) =>
						tx.glossyEdition.updateMany({
							where: { projectId: PA },
							data: { organizationId },
						}),
				},
				{
					name: "glossy_build",
					count: (tx) =>
						tx.glossyBuild.count({ where: { projectId: PA } }),
					insert: (tx, organizationId) =>
						tx.glossyBuild.create({
							data: {
								documentId,
								projectId: PA,
								organizationId,
								status: "FAILED",
								options: {},
								sourceTitle: "t",
								sourceContent: "c",
								sourceVersion: 1,
								sourceContentHash: "h",
							},
						}),
					retenant: (tx, organizationId) =>
						tx.glossyBuild.updateMany({
							where: { projectId: PA },
							data: { organizationId },
						}),
				},
				{
					name: "glossy_visual_decision",
					count: (tx) =>
						tx.glossyVisualDecision.count({
							where: { projectId: PA },
						}),
					insert: (tx, organizationId) =>
						tx.glossyVisualDecision.create({
							data: {
								editionId,
								projectId: PA,
								organizationId,
								visualKey: `rls-insert-${organizationId}`,
								sectionKey: "s1",
								decision: "DISCARDED",
							},
						}),
					retenant: (tx, organizationId) =>
						tx.glossyVisualDecision.updateMany({
							where: { projectId: PA },
							data: { organizationId },
						}),
				},
				{
					name: "glossy_segment_cache",
					count: (tx) =>
						tx.glossySegmentCache.count({
							where: { projectId: PA },
						}),
					insert: (tx, organizationId) =>
						tx.glossySegmentCache.create({
							data: {
								documentId,
								projectId: PA,
								organizationId,
								kind: "REWRITE",
								cacheKey: `rls-insert-${organizationId}`,
								output: {},
							},
						}),
					retenant: (tx, organizationId) =>
						tx.glossySegmentCache.updateMany({
							where: { projectId: PA },
							data: { organizationId },
						}),
				},
				{
					name: "project_recipient_brand",
					count: (tx) =>
						tx.projectRecipientBrand.count({
							where: { projectId: PA },
						}),
					// PA2: same organization, the guest is a member, and it has
					// no recipient brand yet (one row per project).
					insert: (tx, organizationId) =>
						tx.projectRecipientBrand.create({
							data: {
								projectId: PA2,
								organizationId,
								name: "Example",
							},
						}),
					retenant: (tx, organizationId) =>
						tx.projectRecipientBrand.updateMany({
							where: { projectId: PA },
							data: { organizationId },
						}),
				},
			];

			it.each(tables)(
				"$name: the tenant and an accepted guest read; other guests, expired or pending members, and other tenants do not",
				async (table) => {
					const read = (ctx: TenantCtx) =>
						asRlsRole(ctx, table.count);
					expect(await read(guest)).toBeGreaterThan(0);
					expect(await read(orgA)).toBeGreaterThan(0);
					expect(await read(otherGuest)).toBe(0);
					expect(await read(expired)).toBe(0);
					expect(await read(pending)).toBe(0);
					expect(await read(orgB)).toBe(0);
				},
			);

			it.each(tables)(
				"$name: a write must carry the parent project's organizationId, for guests and members alike",
				async (table) => {
					expect(
						await attempt(guest, (tx) => table.insert(tx, ORG_A)),
					).toBe("ok");
					expect(
						await attempt(orgA, (tx) => table.insert(tx, ORG_A)),
					).toBe("ok");
					expect(
						await attempt(guest, (tx) => table.insert(tx, ORG_B)),
					).toBe("denied");
					expect(
						await attempt(orgA, (tx) => table.insert(tx, ORG_B)),
					).toBe("denied");
					expect(
						await attempt(otherGuest, (tx) =>
							table.insert(tx, ORG_A),
						),
					).toBe("denied");
					expect(
						await attempt(guest, (tx) => table.retenant(tx, ORG_B)),
					).toBe("denied");
					expect(
						await attempt(orgA, (tx) => table.retenant(tx, ORG_B)),
					).toBe("denied");
				},
			);

			it("a guest with no organization membership reads the Brand kit of the project's organization and no other", async () => {
				const kitsOf = (ctx: TenantCtx, organizationId: string) =>
					asRlsRole(ctx, (tx) =>
						tx.organizationBrandKit.count({
							where: { organizationId },
						}),
					);
				expect(await kitsOf(guest, ORG_A)).toBe(1);
				expect(await kitsOf(guest, ORG_B)).toBe(0);
				expect(await kitsOf(otherGuest, ORG_B)).toBe(1);
				expect(await kitsOf(otherGuest, ORG_A)).toBe(0);
				expect(await kitsOf(expired, ORG_A)).toBe(0);
				expect(await kitsOf(pending, ORG_A)).toBe(0);
				expect(await kitsOf(orgA, ORG_A)).toBe(1);
				expect(await kitsOf(orgA, ORG_B)).toBe(0);
			});

			it("the organization writes its own Brand kit; a guest cannot write, delete or create one", async () => {
				const updateAccents = (ctx: TenantCtx) =>
					asRlsRole(ctx, (tx) =>
						tx.organizationBrandKit.updateMany({
							where: { organizationId: ORG_A },
							data: { accentColors: ["#999999"] },
						}),
					);
				// Guest UPDATE and DELETE see no row to act on.
				expect((await updateAccents(guest)).count).toBe(0);
				expect(
					(
						await asRlsRole(guest, (tx) =>
							tx.organizationBrandKit.deleteMany({
								where: { organizationId: ORG_A },
							}),
						)
					).count,
				).toBe(0);
				expect(
					await attempt(guest, (tx) =>
						tx.organizationBrandKit.create({
							data: { organizationId: ORG_C, accentColors: [] },
						}),
					),
				).toBe("denied");
				expect(
					await attempt(orgA, (tx) =>
						tx.organizationBrandKit.create({
							data: { organizationId: ORG_C, accentColors: [] },
						}),
					),
				).toBe("denied");
				expect(
					(
						await db.organizationBrandKit.findUniqueOrThrow({
							where: { organizationId: ORG_A },
							select: { accentColors: true },
						})
					).accentColors,
				).toEqual(["#123456"]);

				expect(
					await attempt(orgA, async (tx) => {
						const { count } =
							await tx.organizationBrandKit.updateMany({
								where: { organizationId: ORG_A },
								data: { accentColors: ["#999999"] },
							});
						expect(count).toBe(1);
					}),
				).toBe("ok");
			});
		});
	},
);
