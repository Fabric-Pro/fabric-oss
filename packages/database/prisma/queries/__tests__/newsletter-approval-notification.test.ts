/**
 * Coverage for the Fizzy 1869 approval-gate NEWSLETTER_APPROVAL_PENDING
 * in-app notification (`packages/database/prisma/queries/newsletter-approval-notification.ts`):
 *
 *   1. `buildApprovalNotificationRow` (pure) — the per-recipient row shape:
 *      SYSTEM category, the `projects/{projectId}?tab=settings&settingsTab=newsletter`
 *      deep link (Codex final-review — a bare "settings/newsletter" would NOT
 *      land on the review UI), the `{sendId, projectId}` payload matching the
 *      registered NEWSLETTER_APPROVAL_PENDING schema in
 *      @repo/api notifications/lib/payloads.ts, and the
 *      `newsletter-approval:<sendId>:<userId>` dedupeKey. Runs unconditionally
 *      (no DB).
 *   2. `emitNewsletterApprovalPendingNotification` — a PENDING_APPROVAL send
 *      with two project admins produces two notification rows with distinct
 *      dedupeKeys; a second call inserts nothing new (P2002 swallowed); a
 *      non-PENDING_APPROVAL send produces none. This needs a live Postgres
 *      (real admin-resolution joins + unique-dedupeKey semantics can't be
 *      faithfully mocked), so it self-skips when DATABASE_URL is unset or is
 *      the CI placeholder (`hasReachableDatabaseUrl`), mirroring the sibling
 *      integration suites under `prisma/queries/projects/__tests__`.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { hasReachableDatabaseUrl } from "../../../__tests__/_helpers/db-availability";
import { db, Prisma } from "../../client";
import {
	buildApprovalNotificationRow,
	emitNewsletterApprovalPendingNotification,
} from "../newsletter-approval-notification";

describe("buildApprovalNotificationRow", () => {
	const send = {
		id: "send-1",
		projectId: "proj-1",
		organizationId: "org-1",
		project: { name: "Acme" },
	};

	it("builds the SYSTEM-category row with title, snippet, and settings deep link", () => {
		const row = buildApprovalNotificationRow(send, "user-1");
		expect(row).toMatchObject({
			userId: "user-1",
			organizationId: "org-1",
			type: "NEWSLETTER_APPROVAL_PENDING",
			category: "SYSTEM",
			title: 'Newsletter for "Acme" awaits review',
			snippet: "Review and approve the release notes before they're sent",
			projectId: "proj-1",
		});
	});

	it("uses the settingsTab deep link so the row lands on the review UI, not a bare settings tab", () => {
		const row = buildApprovalNotificationRow(send, "user-1");
		expect(row.link).toBe(
			"projects/proj-1?tab=settings&settingsTab=newsletter",
		);
	});

	it("payload carries exactly {sendId, projectId} — matching the registered schema", () => {
		const row = buildApprovalNotificationRow(send, "user-1");
		expect(row.payload).toEqual({ sendId: "send-1", projectId: "proj-1" });
		expect(Object.keys(row.payload)).toEqual(["sendId", "projectId"]);
	});

	it("scopes dedupeKey per (send, recipient)", () => {
		const rowA = buildApprovalNotificationRow(send, "user-1");
		const rowB = buildApprovalNotificationRow(send, "user-2");
		expect(rowA.dedupeKey).toBe("newsletter-approval:send-1:user-1");
		expect(rowB.dedupeKey).toBe("newsletter-approval:send-1:user-2");
		expect(rowA.dedupeKey).not.toBe(rowB.dedupeKey);
	});

	it("carries a null organizationId through for a personal-project send", () => {
		const row = buildApprovalNotificationRow(
			{ ...send, organizationId: null },
			"user-1",
		);
		expect(row.organizationId).toBeNull();
	});
});

describe.skipIf(!hasReachableDatabaseUrl())(
	"emitNewsletterApprovalPendingNotification (real Postgres)",
	() => {
		const RUN_ID = `${Date.now()}-${process.pid}`;
		const OWNER_ID = `test-newsletter-approval-owner-${RUN_ID}`;
		const ADMIN_ID = `test-newsletter-approval-admin-${RUN_ID}`;
		const VIEWER_ID = `test-newsletter-approval-viewer-${RUN_ID}`;
		const ORG_ID = `test-newsletter-approval-org-${RUN_ID}`;
		let projectCounter = 0;
		let dedupeCounter = 0;

		beforeAll(async () => {
			const now = new Date();
			for (const id of [OWNER_ID, ADMIN_ID, VIEWER_ID]) {
				await db.$executeRaw(Prisma.sql`
					INSERT INTO "user" (id, name, email, "emailVerified", "onboardingComplete", "createdAt", "updatedAt")
					VALUES (${id}, ${"Newsletter Approval User"}, ${`${id}@test.com`}, true, false, ${now}, ${now})
					ON CONFLICT (id) DO NOTHING
				`);
			}
			// An organization is required for any test that expects more than one
			// reviewer: the resolver short-circuits a personal project to exactly
			// its owner, so a second recipient can only come from an org role.
			await db.$executeRaw(Prisma.sql`
				INSERT INTO "organization" (id, name, slug, "createdAt")
				VALUES (${ORG_ID}, ${"Newsletter Approval Org"}, ${ORG_ID}, ${now})
				ON CONFLICT (id) DO NOTHING
			`);
			await db.member.create({
				data: {
					organizationId: ORG_ID,
					userId: OWNER_ID,
					role: "owner",
					createdAt: now,
				},
			});
		});

		afterAll(async () => {
			// Cascades the member row.
			await db.organization.deleteMany({ where: { id: ORG_ID } });
		});

		afterEach(async () => {
			// Deleting the project cascades its newsletter sends + members
			// (onDelete: Cascade), which cascades notifications tied to the project.
			await db.project.deleteMany({ where: { userId: OWNER_ID } });
		});

		/** Personal project — resolves to exactly one reviewer, its owner. */
		async function seedProject() {
			projectCounter += 1;
			return db.project.create({
				data: {
					name: `Newsletter Approval Project ${projectCounter}`,
					userId: OWNER_ID,
				},
			});
		}

		/**
		 * Organization-owned project, for the cases that need more than one
		 * reviewer. Both resolver paths then contribute: the project admin via
		 * their project role, and the org owner — who has no project row — via
		 * their org role.
		 */
		async function seedOrgProject() {
			projectCounter += 1;
			return db.project.create({
				data: {
					name: `Newsletter Approval Org Project ${projectCounter}`,
					userId: OWNER_ID,
					organizationId: ORG_ID,
				},
			});
		}

		function nextDedupeKey() {
			dedupeCounter += 1;
			return `manual:${RUN_ID}:${dedupeCounter}`;
		}

		async function seedSend(projectId: string, status: string) {
			return db.newsletterSend.create({
				data: {
					projectId,
					organizationId: null,
					userId: null,
					dedupeKey: nextDedupeKey(),
					status,
					trigger: "MANUAL",
					timeWindowStart: new Date(0),
					timeWindowEnd: new Date(1),
					triggeredByUserId: OWNER_ID,
					detailLevel: "STANDARD",
				},
			});
		}

		async function addAdmin(projectId: string, userId: string) {
			await db.projectMember.create({
				data: {
					projectId,
					userId,
					role: "PROJECT_ADMIN",
					invitedBy: OWNER_ID,
					acceptedAt: new Date(),
				},
			});
		}

		async function notificationsFor(sendId: string) {
			return db.notification
				.findMany({
					where: { type: "NEWSLETTER_APPROVAL_PENDING" },
					orderBy: { dedupeKey: "asc" },
				})
				.then((rows) =>
					rows.filter(
						(r) =>
							(r.payload as { sendId?: string })?.sendId ===
							sendId,
					),
				);
		}

		it("notifies two project admins with distinct dedupeKeys and the settings deep link", async () => {
			const project = await seedOrgProject();
			await addAdmin(project.id, ADMIN_ID);
			const send = await seedSend(project.id, "PENDING_APPROVAL");

			await emitNewsletterApprovalPendingNotification({
				sendId: send.id,
			});

			const notifications = await notificationsFor(send.id);
			expect(notifications).toHaveLength(2);

			const recipients = notifications.map((n) => n.userId).sort();
			expect(recipients).toEqual([ADMIN_ID, OWNER_ID].sort());

			const dedupeKeys = notifications.map((n) => n.dedupeKey);
			expect(new Set(dedupeKeys).size).toBe(2);
			for (const n of notifications) {
				expect(n.link).toBe(
					`projects/${project.id}?tab=settings&settingsTab=newsletter`,
				);
				expect(n.category).toBe("SYSTEM");
				expect(n.dedupeKey).toBe(
					`newsletter-approval:${send.id}:${n.userId}`,
				);
			}
		});

		it("does not notify a VIEWER-role project member", async () => {
			const project = await seedProject();
			await db.projectMember.create({
				data: {
					projectId: project.id,
					userId: VIEWER_ID,
					role: "VIEWER",
					invitedBy: OWNER_ID,
					acceptedAt: new Date(),
				},
			});
			const send = await seedSend(project.id, "PENDING_APPROVAL");

			await emitNewsletterApprovalPendingNotification({
				sendId: send.id,
			});

			const notifications = await notificationsFor(send.id);
			const recipients = notifications.map((n) => n.userId);
			expect(recipients).not.toContain(VIEWER_ID);
			// Only the personal-project owner (no org admins seeded) is notified.
			expect(recipients).toEqual([OWNER_ID]);
		});

		it("a second call inserts nothing new — P2002 dedupe collisions are swallowed", async () => {
			const project = await seedOrgProject();
			await addAdmin(project.id, ADMIN_ID);
			const send = await seedSend(project.id, "PENDING_APPROVAL");

			await emitNewsletterApprovalPendingNotification({
				sendId: send.id,
			});
			const firstRun = await notificationsFor(send.id);
			expect(firstRun).toHaveLength(2);

			await expect(
				emitNewsletterApprovalPendingNotification({ sendId: send.id }),
			).resolves.toBeUndefined();

			const secondRun = await notificationsFor(send.id);
			expect(secondRun).toHaveLength(2);
		});

		it("produces no notifications for a non-PENDING_APPROVAL send", async () => {
			const project = await seedProject();
			await addAdmin(project.id, ADMIN_ID);
			const send = await seedSend(project.id, "SENT");

			await emitNewsletterApprovalPendingNotification({
				sendId: send.id,
			});

			const notifications = await notificationsFor(send.id);
			expect(notifications).toHaveLength(0);
		});

		it("no-ops when the send does not exist", async () => {
			await expect(
				emitNewsletterApprovalPendingNotification({
					sendId: "does-not-exist",
				}),
			).resolves.toBeUndefined();
		});
	},
);
