/**
 * Coverage for the Fizzy 1869 approval-gate send-row transitions in
 * `packages/database/prisma/queries/projects/newsletter.ts`:
 *
 *   1. `approveNewsletterSend` / `rejectNewsletterSend` only ever transition a
 *      `PENDING_APPROVAL` row — any other status is a no-op that returns
 *      `{approved:false}` / `{rejected:false}` and leaves the row untouched.
 *   2. The reviewer decision AND its `newsletter.send.approved` /
 *      `newsletter.send.rejected` audit row commit atomically in ONE
 *      transaction: a successful transition writes exactly one audit_log row;
 *      a no-op transition writes none (Codex final-review — a fire-and-forget
 *      audit after commit could drop the trail for a security-relevant
 *      external-publication decision).
 *   3. The guarded `finalizeNewsletterSend({ expectStatus })` no-ops when the
 *      row is not in the expected status (e.g. already REJECTED), returning
 *      `{finalized:false}` without mutating the row.
 *
 * This suite needs a live Postgres (real transaction + unique/atomicity
 * semantics can't be faithfully mocked), so it self-skips when DATABASE_URL is
 * unset or is the CI placeholder (`hasReachableDatabaseUrl`), mirroring the
 * sibling integration suite `newsletter-create-send.test.ts`.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { hasReachableDatabaseUrl } from "../../../../__tests__/_helpers/db-availability";
import { db, Prisma } from "../../../client";
import {
	approveNewsletterSend,
	buildCreateSendData,
	type CreateNewsletterSendInput,
	finalizeNewsletterSend,
	rejectNewsletterSend,
} from "../newsletter";

interface SeedSendOverrides {
	reviewedByUserId?: string | null;
	reviewedAt?: Date | null;
	rejectionReason?: string | null;
	completedAt?: Date | null;
}

describe.skipIf(!hasReachableDatabaseUrl())(
	"newsletter send-row transitions (real Postgres)",
	() => {
		const RUN_ID = `${Date.now()}-${process.pid}`;
		const USER_ID = `test-newsletter-transitions-user-${RUN_ID}`;
		const REVIEWER_ID = `test-newsletter-transitions-reviewer-${RUN_ID}`;
		let projectCounter = 0;
		let dedupeCounter = 0;

		beforeAll(async () => {
			const now = new Date();
			for (const id of [USER_ID, REVIEWER_ID]) {
				await db.$executeRaw(Prisma.sql`
					INSERT INTO "user" (id, name, email, "emailVerified", "onboardingComplete", "createdAt", "updatedAt")
					VALUES (${id}, ${"Newsletter Transitions User"}, ${`${id}@test.com`}, true, false, ${now}, ${now})
					ON CONFLICT (id) DO NOTHING
				`);
			}
		});

		afterEach(async () => {
			// Deleting the project cascades its newsletter sends (onDelete: Cascade).
			await db.project.deleteMany({ where: { userId: USER_ID } });
		});

		async function seedProject() {
			projectCounter += 1;
			return db.project.create({
				data: {
					name: `Newsletter Transitions Project ${projectCounter}`,
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
				trigger: "MANUAL",
				timeWindowStart: new Date(0),
				timeWindowEnd: new Date(1),
				triggeredByUserId: USER_ID,
				detailLevel: "STANDARD",
			} satisfies Omit<CreateNewsletterSendInput, "dedupeKey">;
			return db.newsletterSend.create({
				data: {
					...buildCreateSendData({
						...baseInput,
						dedupeKey: nextDedupeKey("manual"),
					}),
					status,
					...overrides,
				},
			});
		}

		async function countAuditRows(sendId: string, action: string) {
			return db.auditLog.count({
				where: { action, resourceId: sendId },
			});
		}

		const auditActor = (project: {
			id: string;
			organizationId: string | null;
		}) => ({
			reviewedByUserId: REVIEWER_ID,
			actorEmail: "reviewer@test.com",
			actorName: "Reviewer",
			organizationId: project.organizationId,
			projectId: project.id,
		});

		describe("approveNewsletterSend", () => {
			it("transitions a PENDING_APPROVAL row to APPROVED and returns {approved:true}", async () => {
				const project = await seedProject();
				const send = await seedSend(project.id, "PENDING_APPROVAL");

				const result = await approveNewsletterSend({
					sendId: send.id,
					removedHighlightIndexes: [1, 3],
					audit: auditActor(project),
				});

				expect(result).toEqual({ approved: true });
				const persisted = await db.newsletterSend.findUniqueOrThrow({
					where: { id: send.id },
				});
				expect(persisted.status).toBe("APPROVED");
				expect(persisted.reviewedByUserId).toBe(REVIEWER_ID);
				expect(persisted.reviewedAt).not.toBeNull();
				expect(persisted.removedHighlightIndexes).toEqual([1, 3]);
			});

			it("writes exactly one newsletter.send.approved audit_log row in the same transaction", async () => {
				const project = await seedProject();
				const send = await seedSend(project.id, "PENDING_APPROVAL");

				await approveNewsletterSend({
					sendId: send.id,
					removedHighlightIndexes: [],
					audit: auditActor(project),
				});

				const count = await countAuditRows(
					send.id,
					"newsletter.send.approved",
				);
				expect(count).toBe(1);
			});

			it("no-ops on a non-PENDING_APPROVAL row: returns {approved:false}, does not change it, writes no audit row", async () => {
				const project = await seedProject();
				const send = await seedSend(project.id, "APPROVED", {
					reviewedByUserId: "someone-else",
					reviewedAt: new Date(),
				});

				const result = await approveNewsletterSend({
					sendId: send.id,
					removedHighlightIndexes: [0],
					audit: auditActor(project),
				});

				expect(result).toEqual({ approved: false });
				const persisted = await db.newsletterSend.findUniqueOrThrow({
					where: { id: send.id },
				});
				// Unchanged — still attributed to the original reviewer, not clobbered.
				expect(persisted.status).toBe("APPROVED");
				expect(persisted.reviewedByUserId).toBe("someone-else");
				expect(persisted.removedHighlightIndexes).toBeNull();

				const count = await countAuditRows(
					send.id,
					"newsletter.send.approved",
				);
				expect(count).toBe(0);
			});
		});

		describe("rejectNewsletterSend", () => {
			it("transitions a PENDING_APPROVAL row to REJECTED and returns {rejected:true}", async () => {
				const project = await seedProject();
				const send = await seedSend(project.id, "PENDING_APPROVAL");

				const result = await rejectNewsletterSend({
					sendId: send.id,
					reason: "Not ready",
					audit: auditActor(project),
				});

				expect(result).toEqual({ rejected: true });
				const persisted = await db.newsletterSend.findUniqueOrThrow({
					where: { id: send.id },
				});
				expect(persisted.status).toBe("REJECTED");
				expect(persisted.reviewedByUserId).toBe(REVIEWER_ID);
				expect(persisted.reviewedAt).not.toBeNull();
				expect(persisted.rejectionReason).toBe("Not ready");
				expect(persisted.completedAt).not.toBeNull();
			});

			it("writes exactly one newsletter.send.rejected audit_log row in the same transaction", async () => {
				const project = await seedProject();
				const send = await seedSend(project.id, "PENDING_APPROVAL");

				await rejectNewsletterSend({
					sendId: send.id,
					reason: null,
					audit: auditActor(project),
				});

				const count = await countAuditRows(
					send.id,
					"newsletter.send.rejected",
				);
				expect(count).toBe(1);
			});

			it("no-ops on a non-PENDING_APPROVAL row: returns {rejected:false}, does not change it, writes no audit row", async () => {
				const project = await seedProject();
				const send = await seedSend(project.id, "SENT");

				const result = await rejectNewsletterSend({
					sendId: send.id,
					reason: "too late",
					audit: auditActor(project),
				});

				expect(result).toEqual({ rejected: false });
				const persisted = await db.newsletterSend.findUniqueOrThrow({
					where: { id: send.id },
				});
				expect(persisted.status).toBe("SENT");
				expect(persisted.rejectionReason).toBeNull();

				const count = await countAuditRows(
					send.id,
					"newsletter.send.rejected",
				);
				expect(count).toBe(0);
			});
		});

		describe("finalizeNewsletterSend (guarded)", () => {
			it("no-ops when expectStatus does not match the row's current status", async () => {
				const project = await seedProject();
				const send = await seedSend(project.id, "REJECTED", {
					rejectionReason: "already rejected",
					completedAt: new Date(),
				});

				const result = await finalizeNewsletterSend({
					sendId: send.id,
					status: "SENT",
					expectStatus: "APPROVED",
				});

				expect(result).toEqual({ finalized: false });
				const persisted = await db.newsletterSend.findUniqueOrThrow({
					where: { id: send.id },
				});
				// Untouched: still REJECTED, not overwritten to SENT.
				expect(persisted.status).toBe("REJECTED");
			});

			it("finalizes when expectStatus matches the row's current status", async () => {
				const project = await seedProject();
				const send = await seedSend(project.id, "APPROVED", {
					reviewedByUserId: REVIEWER_ID,
					reviewedAt: new Date(),
				});

				const result = await finalizeNewsletterSend({
					sendId: send.id,
					status: "SENT",
					recipientCount: 3,
					sentCount: 3,
					expectStatus: "APPROVED",
				});

				expect(result).toEqual({ finalized: true });
				const persisted = await db.newsletterSend.findUniqueOrThrow({
					where: { id: send.id },
				});
				expect(persisted.status).toBe("SENT");
				expect(persisted.sentCount).toBe(3);
			});

			it("keeps the unconditional legacy behavior when expectStatus is omitted", async () => {
				const project = await seedProject();
				const send = await seedSend(project.id, "PENDING");

				const result = await finalizeNewsletterSend({
					sendId: send.id,
					status: "FAILED",
					errorMessage: "boom",
				});

				expect(result).toEqual({ finalized: true });
				const persisted = await db.newsletterSend.findUniqueOrThrow({
					where: { id: send.id },
				});
				expect(persisted.status).toBe("FAILED");
				expect(persisted.errorMessage).toBe("boom");
			});
		});
	},
);
