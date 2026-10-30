/**
 * Real-Postgres regression tests for the verdict cache
 * (`recordDistinctVerdict` + `listVerdictValidPairKeys`).
 *
 * The load-bearing invariant: EVERY completed verification stamps the pair's
 * current content hashes, so the pair is excluded from the next scan and paid
 * for at most once per content change. The dangerous edge — the one this suite
 * pins — is a distinct verdict landing on a pair that ALREADY has a PENDING
 * row (every link written before the hash columns existed carries NULL
 * hashes). If that PENDING row is not stamped, the pair is re-selected and
 * re-billed on every scan forever and permanently occupies candidate-cap
 * slots. A distinct verdict CLEARS an unreviewed PENDING flag (a deliberate,
 * owner-approved change: such a flag is a stale false positive under the
 * current logic), while a DISMISSED/RESOLVED pair — a human decision — keeps
 * its status and display fields and is never resurrected.
 *
 * No mocks — hits the live Postgres via the shared Prisma singleton.
 * Self-skips when DATABASE_URL is unset or the CI placeholder.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { hasReachableDatabaseUrl } from "../../../../__tests__/_helpers/db-availability";
import { db, type FeatureDraftingStage, Prisma } from "../../../client";
import { canonicalPair } from "../duplicate-detection";
import {
	listStoryDuplicateFocusEmbeddings,
	upsertStoryDuplicateFocusEmbeddings,
} from "../duplicate-embeddings";
import {
	getDuplicateLinkState,
	listPendingDuplicatePairs,
	listVerdictValidPairKeys,
	recordDistinctVerdict,
	refreshPendingDuplicateSimilarities,
	stampVerifiedHashes,
	upsertPendingDuplicateLink,
	withdrawPendingDuplicateLinks,
} from "../duplicate-links";

const RUN_ID = `${Date.now()}-${process.pid}`;
const ORG_ID = `test-verdict-org-${RUN_ID}`;
const USER_ID = `test-verdict-user-${RUN_ID}`;

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

describe.skipIf(!hasReachableDatabaseUrl())(
	"duplicate verdict cache (real Postgres)",
	() => {
		let storyCounter = 0;

		beforeAll(async () => {
			const now = new Date();
			await db.$executeRaw(Prisma.sql`
				INSERT INTO "user" (id, name, email, "emailVerified", "onboardingComplete", "createdAt", "updatedAt")
				VALUES (${USER_ID}, ${"Verdict User"}, ${`${USER_ID}@test.com`}, true, false, ${now}, ${now})
				ON CONFLICT (id) DO NOTHING
			`);
			await db.$executeRaw(Prisma.sql`
				INSERT INTO "organization" (id, name, slug, "createdAt")
				VALUES (${ORG_ID}, ${"Verdict Org"}, ${ORG_ID}, ${now})
				ON CONFLICT (id) DO NOTHING
			`);
		});

		afterEach(async () => {
			await db.userStory.deleteMany({ where: { createdById: USER_ID } });
			await db.projectStoryStatus.deleteMany({
				where: { project: { userId: USER_ID } },
			});
			await db.project.deleteMany({ where: { userId: USER_ID } });
		});

		async function seedProjectWithPair() {
			const project = await db.project.create({
				data: {
					name: "Verdict Project",
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
			const mk = async (title: string) => {
				storyCounter += 1;
				return db.userStory.create({
					data: {
						projectId: project.id,
						statusId: status.id,
						createdById: USER_ID,
						identifier: `F-${RUN_ID}-${storyCounter}`,
						title,
						draftingStage: "PLACEHOLDER" as FeatureDraftingStage,
					},
				});
			};
			const a = await mk("Story A");
			const b = await mk("Story B");
			const [storyAId, storyBId] = canonicalPair(a.id, b.id);
			return { projectId: project.id, storyAId, storyBId };
		}

		it("stamps hashes onto a pre-existing PENDING row (NULL hashes) and clears the stale flag", async () => {
			const { projectId, storyAId, storyBId } =
				await seedProjectWithPair();
			// A pre-deploy PENDING link: no verified hashes.
			await db.storyDuplicateLink.create({
				data: {
					projectId,
					storyAId,
					storyBId,
					similarity: 0.82,
					confidence: 0.9,
					status: "PENDING",
					linkType: "OVERLAP",
				},
			});

			// Before: the pair is NOT verdict-valid (NULL hashes) — it would be
			// re-verified on the next scan.
			const currentHashes = new Map([
				[storyAId, HASH_A],
				[storyBId, HASH_B],
			]);
			expect(
				await listVerdictValidPairKeys(projectId, currentHashes),
			).not.toContain(`${storyAId}:${storyBId}`);

			// The verifier re-runs and now judges the pair distinct.
			await recordDistinctVerdict({
				projectId,
				storyAId,
				storyBId,
				similarity: 0.64,
				confidence: 0.55,
				reasoning: "actually different on re-read",
				contentHashA: HASH_A,
				contentHashB: HASH_B,
				clearsPendingFlag: true,
			});

			const row = await db.storyDuplicateLink.findUnique({
				where: { storyAId_storyBId: { storyAId, storyBId } },
			});
			// Hashes stamped → excluded from the next scan (the fix).
			expect(row?.verifiedContentHashA).toBe(HASH_A);
			expect(row?.verifiedContentHashB).toBe(HASH_B);
			// Deliberate, owner-approved behaviour change: an unreviewed PENDING
			// flag that re-verification judges distinct is a stale false
			// positive, so it is cleared rather than left for someone to review.
			// It cannot flap: re-verification only happens when a side's text
			// changes or the detection version moves.
			expect(row?.status).toBe("NOT_DUPLICATE");
			// The display fields now describe the verdict that cleared it.
			expect(row?.similarity).toBe(0.64);
			expect(row?.confidence).toBe(0.55);
			expect(row?.reasoning).toBe("actually different on re-read");

			expect(
				await listVerdictValidPairKeys(projectId, currentHashes),
			).toContain(`${storyAId}:${storyBId}`);
		});

		it("keeps a PENDING flag through an unsure re-check, stamping only its hashes", async () => {
			const { projectId, storyAId, storyBId } =
				await seedProjectWithPair();
			await db.storyDuplicateLink.create({
				data: {
					projectId,
					storyAId,
					storyBId,
					similarity: 0.82,
					confidence: 0.9,
					reasoning: "same checklist",
					status: "PENDING",
					linkType: "DUPLICATE",
				},
			});

			// Re-verified as the same work, but under the confidence bar.
			await recordDistinctVerdict({
				projectId,
				storyAId,
				storyBId,
				similarity: 0.8,
				confidence: 0.6,
				reasoning: "probably the same checklist",
				contentHashA: HASH_A,
				contentHashB: HASH_B,
				clearsPendingFlag: false,
			});

			const row = await db.storyDuplicateLink.findUnique({
				where: { storyAId_storyBId: { storyAId, storyBId } },
			});
			expect(row?.status).toBe("PENDING");
			expect(row?.confidence).toBe(0.9);
			expect(row?.reasoning).toBe("same checklist");
			expect(row?.verifiedContentHashA).toBe(HASH_A);
			expect(
				await listVerdictValidPairKeys(
					projectId,
					new Map([
						[storyAId, HASH_A],
						[storyBId, HASH_B],
					]),
				),
			).toContain(`${storyAId}:${storyBId}`);
		});

		it("creates a NOT_DUPLICATE row with hashes for a brand-new distinct pair", async () => {
			const { projectId, storyAId, storyBId } =
				await seedProjectWithPair();
			await recordDistinctVerdict({
				projectId,
				storyAId,
				storyBId,
				similarity: 0.71,
				confidence: 0.9,
				reasoning: "different work",
				contentHashA: HASH_A,
				contentHashB: HASH_B,
				clearsPendingFlag: true,
			});
			const row = await db.storyDuplicateLink.findUnique({
				where: { storyAId_storyBId: { storyAId, storyBId } },
			});
			expect(row?.status).toBe("NOT_DUPLICATE");
			expect(row?.verifiedContentHashA).toBe(HASH_A);
			expect(row?.confidence).toBe(0.9);
			expect(
				await listVerdictValidPairKeys(
					projectId,
					new Map([
						[storyAId, HASH_A],
						[storyBId, HASH_B],
					]),
				),
			).toContain(`${storyAId}:${storyBId}`);
		});

		it.each(["DISMISSED", "RESOLVED"] as const)(
			"never rewrites a %s row — a human decision (stamps its hash only)",
			async (status) => {
				const { projectId, storyAId, storyBId } =
					await seedProjectWithPair();
				await db.storyDuplicateLink.create({
					data: {
						projectId,
						storyAId,
						storyBId,
						similarity: 0.8,
						confidence: 0.9,
						reasoning: "what the reviewer saw",
						status,
					},
				});
				await recordDistinctVerdict({
					projectId,
					storyAId,
					storyBId,
					similarity: 0.6,
					confidence: 0.7,
					reasoning: "re-verified distinct",
					contentHashA: HASH_A,
					contentHashB: HASH_B,
					clearsPendingFlag: true,
				});
				const row = await db.storyDuplicateLink.findUnique({
					where: { storyAId_storyBId: { storyAId, storyBId } },
				});
				expect(row?.status).toBe(status);
				expect(row?.similarity).toBe(0.8);
				expect(row?.confidence).toBe(0.9);
				expect(row?.reasoning).toBe("what the reviewer saw");
				expect(row?.verifiedContentHashA).toBe(HASH_A);
			},
		);

		it("a stale-hash PENDING pair (text edited) is NOT verdict-valid until re-stamped", async () => {
			const { projectId, storyAId, storyBId } =
				await seedProjectWithPair();
			await upsertPendingDuplicateLink({
				projectId,
				storyAId,
				storyBId,
				similarity: 0.9,
				confidence: 0.9,
				linkType: "DUPLICATE",
				contentHashA: HASH_A,
				contentHashB: HASH_B,
			});
			// Same pair, but story A's text changed → new hash. The stored
			// verdict (HASH_A) no longer matches, so the pair must be re-verified.
			const editedHashes = new Map([
				[storyAId, "c".repeat(64)],
				[storyBId, HASH_B],
			]);
			expect(
				await listVerdictValidPairKeys(projectId, editedHashes),
			).not.toContain(`${storyAId}:${storyBId}`);
			// Unchanged hashes → still valid (excluded).
			expect(
				await listVerdictValidPairKeys(
					projectId,
					new Map([
						[storyAId, HASH_A],
						[storyBId, HASH_B],
					]),
				),
			).toContain(`${storyAId}:${storyBId}`);
		});

		it("withdraws a listed PENDING flag and clears its hashes so the pair is verified afresh", async () => {
			const { projectId, storyAId, storyBId } =
				await seedProjectWithPair();
			await upsertPendingDuplicateLink({
				projectId,
				storyAId,
				storyBId,
				similarity: 0.5,
				confidence: 0.85,
				reasoning: "both touch onboarding",
				linkType: "OVERLAP",
				contentHashA: HASH_A,
				contentHashB: HASH_B,
			});
			expect(await listPendingDuplicatePairs(projectId)).toEqual([
				{ storyAId, storyBId, similarity: 0.5 },
			]);

			expect(
				await withdrawPendingDuplicateLinks(projectId, [
					{ storyAId, storyBId },
				]),
			).toBe(1);

			const row = await db.storyDuplicateLink.findUnique({
				where: { storyAId_storyBId: { storyAId, storyBId } },
			});
			expect(row?.status).toBe("NOT_DUPLICATE");
			expect(row?.verifiedContentHashA).toBeNull();
			expect(row?.verifiedContentHashB).toBeNull();
			expect(await listPendingDuplicatePairs(projectId)).toEqual([]);
			// Not read as a cached negative verdict the verifier never gave.
			expect(
				await listVerdictValidPairKeys(
					projectId,
					new Map([
						[storyAId, HASH_A],
						[storyBId, HASH_B],
					]),
				),
			).not.toContain(`${storyAId}:${storyBId}`);
		});

		it("never withdraws a DISMISSED or RESOLVED row", async () => {
			const { projectId, storyAId, storyBId } =
				await seedProjectWithPair();
			await db.storyDuplicateLink.create({
				data: {
					projectId,
					storyAId,
					storyBId,
					similarity: 0.8,
					confidence: 0.9,
					status: "RESOLVED",
					verifiedContentHashA: HASH_A,
					verifiedContentHashB: HASH_B,
				},
			});

			expect(
				await withdrawPendingDuplicateLinks(projectId, [
					{ storyAId, storyBId },
				]),
			).toBe(0);

			const row = await db.storyDuplicateLink.findUnique({
				where: { storyAId_storyBId: { storyAId, storyBId } },
			});
			expect(row?.status).toBe("RESOLVED");
			expect(row?.verifiedContentHashA).toBe(HASH_A);
		});

		it("reads a pair's state within its project only", async () => {
			const { projectId, storyAId, storyBId } =
				await seedProjectWithPair();
			expect(
				await getDuplicateLinkState(projectId, storyAId, storyBId),
			).toBeNull();
			await upsertPendingDuplicateLink({
				projectId,
				storyAId,
				storyBId,
				similarity: 0.8,
				confidence: 0.9,
				linkType: "OVERLAP",
				contentHashA: HASH_A,
				contentHashB: HASH_B,
			});

			expect(
				await getDuplicateLinkState(projectId, storyAId, storyBId),
			).toEqual({
				status: "PENDING",
				linkType: "OVERLAP",
				verifiedContentHashA: HASH_A,
				verifiedContentHashB: HASH_B,
			});
			expect(
				await getDuplicateLinkState(
					"other-project",
					storyAId,
					storyBId,
				),
			).toBeNull();
		});

		it("stamps verified hashes without touching status, tier or the shown fields", async () => {
			const { projectId, storyAId, storyBId } =
				await seedProjectWithPair();
			await upsertPendingDuplicateLink({
				projectId,
				storyAId,
				storyBId,
				similarity: 0.8,
				confidence: 0.9,
				reasoning: "same capability",
				linkType: "DUPLICATE",
				contentHashA: HASH_A,
				contentHashB: HASH_A,
			});

			await stampVerifiedHashes({
				projectId,
				storyAId,
				storyBId,
				contentHashA: HASH_B,
				contentHashB: HASH_B,
			});
			// Another project's stamp reaches nothing.
			await stampVerifiedHashes({
				projectId: "other-project",
				storyAId,
				storyBId,
				contentHashA: HASH_A,
				contentHashB: HASH_A,
			});

			const row = await db.storyDuplicateLink.findUnique({
				where: { storyAId_storyBId: { storyAId, storyBId } },
			});
			expect(row).toMatchObject({
				status: "PENDING",
				linkType: "DUPLICATE",
				similarity: 0.8,
				confidence: 0.9,
				reasoning: "same capability",
				verifiedContentHashA: HASH_B,
				verifiedContentHashB: HASH_B,
			});
		});

		it("refreshes the score of a PENDING flag only", async () => {
			const { projectId, storyAId, storyBId } =
				await seedProjectWithPair();
			await upsertPendingDuplicateLink({
				projectId,
				storyAId,
				storyBId,
				similarity: 0.645,
				confidence: 0.9,
				linkType: "OVERLAP",
				contentHashA: HASH_A,
				contentHashB: HASH_B,
			});

			expect(
				await refreshPendingDuplicateSimilarities(projectId, [
					{ storyAId, storyBId, similarity: 0.72 },
				]),
			).toBe(1);
			expect(await listPendingDuplicatePairs(projectId)).toEqual([
				{ storyAId, storyBId, similarity: 0.72 },
			]);

			await db.storyDuplicateLink.updateMany({
				where: { projectId, storyAId, storyBId },
				data: { status: "DISMISSED" },
			});
			expect(
				await refreshPendingDuplicateSimilarities(projectId, [
					{ storyAId, storyBId, similarity: 0.9 },
				]),
			).toBe(0);
			const row = await db.storyDuplicateLink.findUnique({
				where: { storyAId_storyBId: { storyAId, storyBId } },
			});
			expect(row?.similarity).toBe(0.72);
		});

		it("caches feature-section vectors per story and section, replacing a changed one", async () => {
			const { projectId, storyAId, storyBId } =
				await seedProjectWithPair();
			await upsertStoryDuplicateFocusEmbeddings(projectId, [
				{
					storyId: storyAId,
					kind: "scope",
					contentHash: HASH_A,
					model: "text-embedding-3-small",
					embedding: [0.1, 0.2],
				},
				{
					storyId: storyAId,
					kind: "acceptance_criteria",
					contentHash: HASH_B,
					model: "text-embedding-3-small",
					embedding: [0.3, 0.4],
				},
				{
					storyId: storyBId,
					kind: "scope",
					contentHash: HASH_B,
					model: "text-embedding-3-small",
					embedding: [0.5, 0.6],
				},
			]);
			// A's Scope changed: same story and section, new text and vector.
			await upsertStoryDuplicateFocusEmbeddings(projectId, [
				{
					storyId: storyAId,
					kind: "scope",
					contentHash: "c".repeat(64),
					model: "text-embedding-3-large",
					embedding: [0.7, 0.8],
				},
			]);

			const rows = await listStoryDuplicateFocusEmbeddings(projectId);
			const byKey = new Map(
				rows.map((r) => [`${r.storyId}:${r.kind}`, r]),
			);
			expect(rows).toHaveLength(3);
			expect(byKey.get(`${storyAId}:scope`)).toEqual({
				storyId: storyAId,
				kind: "scope",
				contentHash: "c".repeat(64),
				model: "text-embedding-3-large",
				embedding: [0.7, 0.8],
			});
			expect(
				byKey.get(`${storyAId}:acceptance_criteria`)?.embedding,
			).toEqual([0.3, 0.4]);
			expect(byKey.get(`${storyBId}:scope`)?.contentHash).toBe(HASH_B);
		});
	},
);
