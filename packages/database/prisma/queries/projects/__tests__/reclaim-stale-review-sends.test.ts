/**
 * Coverage for `reclaimStaleReviewSends` (Fizzy 1869 Task 4/9) in
 * `packages/database/prisma/queries/projects/newsletter.ts`: frees a
 * project's active-send slot by terminalizing a stale review send so the
 * scheduled dispatch (`dispatchNewsletterSendActivity`, Task 9) never wedges
 * behind an abandoned draft or a dead approved send.
 *
 *   1. A `PENDING_APPROVAL` row older than `STALE_APPROVAL_TTL_MS` (14d) →
 *      `EXPIRED`.
 *   2. An `APPROVED` row whose `reviewedAt` is older than `STALE_APPROVED_MS`
 *      (1h) → `FAILED`.
 *   3. A 1-day-old `PENDING_APPROVAL` row is untouched (well within the TTL).
 *   4. An `APPROVED` row `reviewedAt` 10 minutes ago is untouched.
 *   5. Regression (Codex final-review): an `APPROVED` row with a 15-day-old
 *      `createdAt` but `reviewedAt` = now (an old draft that was *just*
 *      approved) must stay `APPROVED` — staleness keys off `reviewedAt`, not
 *      `createdAt`.
 *   6. `lastSentAt` on the parent newsletter settings is never advanced by a
 *      reclaim.
 *
 * This suite needs a live Postgres (real `updateMany` conditional-write
 * semantics can't be faithfully mocked), so it self-skips when DATABASE_URL is
 * unset or is the CI placeholder (`hasReachableDatabaseUrl`), mirroring the
 * sibling suite `newsletter-transitions.test.ts`.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { hasReachableDatabaseUrl } from "../../../../__tests__/_helpers/db-availability";
import { db } from "../../../client";
import {
	buildCreateSendData,
	type CreateNewsletterSendInput,
	reclaimStaleReviewSends,
} from "../newsletter";

interface SeedSendOverrides {
	createdAt?: Date;
	reviewedByUserId?: string | null;
	reviewedAt?: Date | null;
}

describe.skipIf(!hasReachableDatabaseUrl())(
	"reclaimStaleReviewSends (real Postgres)",
	() => {
		const RUN_ID = `${Date.now()}-${process.pid}`;
		const USER_ID = `test-reclaim-stale-review-user-${RUN_ID}`;
		let projectCounter = 0;
		let dedupeCounter = 0;

		beforeAll(async () => {
			const now = new Date();
			await db.$executeRaw`
				INSERT INTO "user" (id, name, email, "emailVerified", "onboardingComplete", "createdAt", "updatedAt")
				VALUES (${USER_ID}, ${"Reclaim Stale Review User"}, ${`${USER_ID}@test.com`}, true, false, ${now}, ${now})
				ON CONFLICT (id) DO NOTHING
			`;
		});

		afterEach(async () => {
			// Deleting the project cascades its newsletter sends (onDelete: Cascade).
			await db.project.deleteMany({ where: { userId: USER_ID } });
		});

		async function seedProject() {
			projectCounter += 1;
			return db.project.create({
				data: {
					name: `Reclaim Stale Review Project ${projectCounter}`,
					userId: USER_ID,
				},
			});
		}

		function nextDedupeKey(prefix: string) {
			dedupeCounter += 1;
			return `${prefix}:${RUN_ID}:${dedupeCounter}`;
		}

		async function seedSend(
			projectId: string,
			status: string,
			overrides: SeedSendOverrides = {},
		) {
			const baseInput = {
				projectId,
				organizationId: null,
				userId: null,
				trigger: "SCHEDULED",
				timeWindowStart: new Date(0),
				timeWindowEnd: new Date(1),
				triggeredByUserId: USER_ID,
				detailLevel: "STANDARD",
			} satisfies Omit<CreateNewsletterSendInput, "dedupeKey">;
			return db.newsletterSend.create({
				data: {
					...buildCreateSendData({
						...baseInput,
						dedupeKey: nextDedupeKey("reclaim"),
					}),
					status,
					...overrides,
				},
			});
		}

		function daysAgo(days: number): Date {
			return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
		}

		function hoursAgo(hours: number): Date {
			return new Date(Date.now() - hours * 60 * 60 * 1000);
		}

		function minutesAgo(minutes: number): Date {
			return new Date(Date.now() - minutes * 60 * 1000);
		}

		it("expires a PENDING_APPROVAL draft older than the 14-day TTL", async () => {
			const project = await seedProject();
			const stale = await seedSend(project.id, "PENDING_APPROVAL", {
				createdAt: daysAgo(15),
			});

			const result = await reclaimStaleReviewSends(project.id);

			expect(result.expiredDraftId).toBe(stale.id);
			expect(result.failedApprovedId).toBeNull();
			const persisted = await db.newsletterSend.findUniqueOrThrow({
				where: { id: stale.id },
			});
			expect(persisted.status).toBe("EXPIRED");
			expect(persisted.completedAt).not.toBeNull();
		});

		it("fails an APPROVED send whose reviewedAt is older than the 1-hour TTL", async () => {
			const project = await seedProject();
			const dead = await seedSend(project.id, "APPROVED", {
				reviewedByUserId: USER_ID,
				reviewedAt: hoursAgo(2),
			});

			const result = await reclaimStaleReviewSends(project.id);

			expect(result.failedApprovedId).toBe(dead.id);
			expect(result.expiredDraftId).toBeNull();
			const persisted = await db.newsletterSend.findUniqueOrThrow({
				where: { id: dead.id },
			});
			expect(persisted.status).toBe("FAILED");
			expect(persisted.errorMessage).toBe(
				"Send workflow did not finalize before timeout",
			);
			expect(persisted.completedAt).not.toBeNull();
		});

		it("leaves a 1-day-old PENDING_APPROVAL draft untouched", async () => {
			const project = await seedProject();
			const fresh = await seedSend(project.id, "PENDING_APPROVAL", {
				createdAt: daysAgo(1),
			});

			const result = await reclaimStaleReviewSends(project.id);

			expect(result.expiredDraftId).toBeNull();
			expect(result.failedApprovedId).toBeNull();
			const persisted = await db.newsletterSend.findUniqueOrThrow({
				where: { id: fresh.id },
			});
			expect(persisted.status).toBe("PENDING_APPROVAL");
		});

		it("leaves an APPROVED send reviewed 10 minutes ago untouched (still a live send)", async () => {
			const project = await seedProject();
			const live = await seedSend(project.id, "APPROVED", {
				reviewedByUserId: USER_ID,
				reviewedAt: minutesAgo(10),
			});

			const result = await reclaimStaleReviewSends(project.id);

			expect(result.failedApprovedId).toBeNull();
			expect(result.expiredDraftId).toBeNull();
			const persisted = await db.newsletterSend.findUniqueOrThrow({
				where: { id: live.id },
			});
			expect(persisted.status).toBe("APPROVED");
		});

		it("regression: an APPROVED send with a 15-day-old createdAt but reviewedAt=now stays APPROVED (staleness keys off reviewedAt, not createdAt)", async () => {
			const project = await seedProject();
			const justApproved = await seedSend(project.id, "APPROVED", {
				createdAt: daysAgo(15),
				reviewedByUserId: USER_ID,
				reviewedAt: new Date(),
			});

			const result = await reclaimStaleReviewSends(project.id);

			expect(result.failedApprovedId).toBeNull();
			const persisted = await db.newsletterSend.findUniqueOrThrow({
				where: { id: justApproved.id },
			});
			expect(persisted.status).toBe("APPROVED");
		});

		// A project holds at most one active send: `newsletter_send_active` is a
		// partial unique index over PENDING / PENDING_APPROVAL / APPROVED, added
		// so "a second draft cannot stack". An expiring draft and a failing
		// approved send therefore cannot share a project, and this case gives
		// each its own — which also means both reclaim paths are exercised
		// rather than only whichever one a single project could hold.
		it("never advances NewsletterSettings.lastSentAt", async () => {
			const fixedLastSentAt = daysAgo(30);

			async function projectWithLastSentAt() {
				const project = await seedProject();
				await db.newsletterSettings.create({
					data: {
						projectId: project.id,
						createdByUserId: USER_ID,
						lastSentAt: fixedLastSentAt,
					},
				});
				return project;
			}

			const expiringDraft = await projectWithLastSentAt();
			await seedSend(expiringDraft.id, "PENDING_APPROVAL", {
				createdAt: daysAgo(15),
			});

			const failingApproved = await projectWithLastSentAt();
			await seedSend(failingApproved.id, "APPROVED", {
				reviewedByUserId: USER_ID,
				reviewedAt: hoursAgo(2),
			});

			await reclaimStaleReviewSends(expiringDraft.id);
			await reclaimStaleReviewSends(failingApproved.id);

			for (const project of [expiringDraft, failingApproved]) {
				const settings = await db.newsletterSettings.findUniqueOrThrow({
					where: { projectId: project.id },
					select: { lastSentAt: true },
				});
				expect(settings.lastSentAt?.getTime()).toBe(
					fixedLastSentAt.getTime(),
				);
			}
		});
	},
);
