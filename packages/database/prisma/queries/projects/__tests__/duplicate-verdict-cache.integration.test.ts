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
 * slots. The status must be preserved either way: a PENDING pair stays flagged
 * for the user, a DISMISSED/RESOLVED pair is never resurrected.
 *
 * No mocks — hits the live Postgres via the shared Prisma singleton.
 * Self-skips when DATABASE_URL is unset or the CI placeholder.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { hasReachableDatabaseUrl } from "../../../../__tests__/_helpers/db-availability";
import { db, type FeatureDraftingStage, Prisma } from "../../../client";
import { canonicalPair } from "../duplicate-detection";
import {
	listVerdictValidPairKeys,
	recordDistinctVerdict,
	upsertPendingDuplicateLink,
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

		it("stamps hashes onto a pre-existing PENDING row (NULL hashes) so it is not re-verified forever", async () => {
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
				similarity: 0.82,
				confidence: 0.55,
				reasoning: "actually different on re-read",
				contentHashA: HASH_A,
				contentHashB: HASH_B,
			});

			const row = await db.storyDuplicateLink.findUnique({
				where: { storyAId_storyBId: { storyAId, storyBId } },
			});
			// Hashes stamped → excluded from the next scan (the fix).
			expect(row?.verifiedContentHashA).toBe(HASH_A);
			expect(row?.verifiedContentHashB).toBe(HASH_B);
			// Status preserved — the user still sees the flag, we don't un-flag.
			expect(row?.status).toBe("PENDING");
			// The user-facing display fields are NOT overwritten on a PENDING row.
			expect(row?.confidence).toBe(0.9);

			expect(
				await listVerdictValidPairKeys(projectId, currentHashes),
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

		it("never resurrects a DISMISSED row (stamps its hash, keeps it DISMISSED)", async () => {
			const { projectId, storyAId, storyBId } =
				await seedProjectWithPair();
			await db.storyDuplicateLink.create({
				data: {
					projectId,
					storyAId,
					storyBId,
					similarity: 0.8,
					confidence: 0.9,
					status: "DISMISSED",
				},
			});
			await recordDistinctVerdict({
				projectId,
				storyAId,
				storyBId,
				similarity: 0.8,
				confidence: 0.9,
				contentHashA: HASH_A,
				contentHashB: HASH_B,
			});
			const row = await db.storyDuplicateLink.findUnique({
				where: { storyAId_storyBId: { storyAId, storyBId } },
			});
			expect(row?.status).toBe("DISMISSED");
			expect(row?.verifiedContentHashA).toBe(HASH_A);
		});

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
	},
);
