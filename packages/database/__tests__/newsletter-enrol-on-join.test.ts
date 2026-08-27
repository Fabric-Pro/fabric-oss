/**
 * Real-DB tests for newsletter enrol-on-join (Fizzy #2290).
 *
 * The sibling wiring tests prove that `acceptProjectInvitation` *calls* the
 * enrolment helper. That is not the same claim as "a subscriber row lands",
 * and adversarial review flagged the gap: a mock-based suite stays green
 * while the write it stands for never happens. These tests drive the real
 * accept path against Postgres and read the subscriber table back.
 *
 * What they pin, beyond the happy path:
 *  - the XOR tenant fields on the created row, in both personal and
 *    organization context — a subscriber written under the wrong tenant is a
 *    leak, not a cosmetic defect;
 *  - that a prior UNSUBSCRIBED row survives a re-join, because enrolment goes
 *    through `createMany({ skipDuplicates })` and must never resurrect an
 *    opt-out;
 *  - that an accept which finds the membership already there still enrols.
 *    That is why enrolment hangs off every returning path rather than the
 *    create alone: two runners race, one commits the membership and the other
 *    resolves to it, and if only the winner enrolled then a crash on the
 *    winner would lose the row entirely.
 *
 * Self-skips via `hasReachableDatabaseUrl()` when no real Postgres is
 * reachable (default CI run), matching the sibling suites.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../prisma/client";
import { acceptProjectInvitation } from "../prisma/queries/projects/members";
import { hasReachableDatabaseUrl } from "./_helpers/db-availability";

const NOW = new Date("2026-06-01T12:00:00.000Z");

const OWNER_ID = "test-nlenrol-owner";
const OWNER_EMAIL = "nlenrol-owner@example.com";
const INVITEE_ID = "test-nlenrol-invitee";
const INVITEE_EMAIL = "nlenrol-invitee@example.com";
// A second joiner with no opt-out history, used as the live control in the
// tombstone test: it proves enrolment actually ran in that fixture rather
// than silently never firing.
const OTHER_ID = "test-nlenrol-other";
const OTHER_EMAIL = "nlenrol-other@example.com";
const PERSONAL_PROJECT_ID = "test-nlenrol-personal";
const ORG_PROJECT_ID = "test-nlenrol-org";
const ORG_ID = "test-nlenrol-org-id";

function futureDate() {
	return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
}

async function createInvitation(projectId: string, email = INVITEE_EMAIL) {
	return db.projectInvitation.create({
		data: {
			projectId,
			email,
			role: "EDITOR",
			status: "PENDING",
			invitedBy: OWNER_ID,
			expiresAt: futureDate(),
			createdAt: NOW,
		},
	});
}

async function enableNewsletter(
	projectId: string,
	tenant: { userId: string | null; organizationId: string | null },
) {
	await db.newsletterSettings.upsert({
		where: { projectId },
		update: { enabled: true },
		create: {
			projectId,
			enabled: true,
			userId: tenant.userId,
			organizationId: tenant.organizationId,
			createdByUserId: OWNER_ID,
		},
	});
}

async function subscriberFor(projectId: string, email: string) {
	return db.newsletterSubscriber.findUnique({
		where: { projectId_email: { projectId, email } },
	});
}

describe.skipIf(!hasReachableDatabaseUrl())("newsletter enrol-on-join", () => {
	beforeAll(async () => {
		await db.user.upsert({
			where: { id: OWNER_ID },
			update: {},
			create: {
				id: OWNER_ID,
				name: "Enrol Owner",
				email: OWNER_EMAIL,
				emailVerified: true,
				onboardingComplete: false,
				createdAt: NOW,
				updatedAt: NOW,
			},
		});
		await db.user.upsert({
			where: { id: INVITEE_ID },
			update: {},
			create: {
				id: INVITEE_ID,
				name: "Enrol Invitee",
				email: INVITEE_EMAIL,
				emailVerified: true,
				onboardingComplete: false,
				createdAt: NOW,
				updatedAt: NOW,
			},
		});
		await db.user.upsert({
			where: { id: OTHER_ID },
			update: {},
			create: {
				id: OTHER_ID,
				name: "Enrol Other",
				email: OTHER_EMAIL,
				emailVerified: true,
				onboardingComplete: false,
				createdAt: NOW,
				updatedAt: NOW,
			},
		});
		await db.organization.upsert({
			where: { id: ORG_ID },
			update: {},
			create: {
				id: ORG_ID,
				name: "Enrol Org",
				slug: "enrol-org-test",
				createdAt: NOW,
			},
		});
		await db.project.upsert({
			where: { id: PERSONAL_PROJECT_ID },
			update: {},
			create: {
				id: PERSONAL_PROJECT_ID,
				name: "Enrol Personal Project",
				userId: OWNER_ID,
				techStack: [],
				features: [],
				tags: [],
				createdAt: NOW,
				updatedAt: NOW,
			},
		});
		await db.project.upsert({
			where: { id: ORG_PROJECT_ID },
			update: {},
			create: {
				id: ORG_PROJECT_ID,
				name: "Enrol Org Project",
				userId: OWNER_ID,
				organizationId: ORG_ID,
				techStack: [],
				features: [],
				tags: [],
				createdAt: NOW,
				updatedAt: NOW,
			},
		});
	});

	beforeEach(async () => {
		for (const projectId of [PERSONAL_PROJECT_ID, ORG_PROJECT_ID]) {
			await db.newsletterSubscriber.deleteMany({
				where: { projectId },
			});
			await db.newsletterSettings.deleteMany({ where: { projectId } });
			await db.projectMember.deleteMany({ where: { projectId } });
			await db.projectInvitation.deleteMany({ where: { projectId } });
		}
	});

	afterAll(async () => {
		for (const projectId of [PERSONAL_PROJECT_ID, ORG_PROJECT_ID]) {
			await db.newsletterSubscriber.deleteMany({
				where: { projectId },
			});
			await db.newsletterSettings.deleteMany({ where: { projectId } });
			await db.projectMember.deleteMany({ where: { projectId } });
			await db.projectInvitation.deleteMany({ where: { projectId } });
		}
		await db.project.deleteMany({
			where: { id: { in: [PERSONAL_PROJECT_ID, ORG_PROJECT_ID] } },
		});
		await db.organization.deleteMany({ where: { id: ORG_ID } });
		await db.user.deleteMany({
			where: { id: { in: [OWNER_ID, INVITEE_ID, OTHER_ID] } },
		});
	});

	it("writes an ACTIVE subscriber for the joining member (personal project)", async () => {
		await enableNewsletter(PERSONAL_PROJECT_ID, {
			userId: OWNER_ID,
			organizationId: null,
		});
		const invitation = await createInvitation(PERSONAL_PROJECT_ID);

		await acceptProjectInvitation(invitation.id, INVITEE_ID, INVITEE_EMAIL);

		const row = await subscriberFor(PERSONAL_PROJECT_ID, INVITEE_EMAIL);
		expect(row).not.toBeNull();
		expect(row).toMatchObject({
			status: "ACTIVE",
			// XOR: personal context => userId is the project owner,
			// organizationId null.
			userId: OWNER_ID,
			organizationId: null,
		});
		// The audit actor is the admin who configured the newsletter, not
		// the member who just joined.
		expect(row?.createdByUserId).toBe(OWNER_ID);
		expect(row?.unsubscribeToken).toBeTruthy();
	});

	it("writes the org tenant fields when the project is org-owned", async () => {
		await enableNewsletter(ORG_PROJECT_ID, {
			userId: null,
			organizationId: ORG_ID,
		});
		const invitation = await createInvitation(ORG_PROJECT_ID);

		await acceptProjectInvitation(invitation.id, INVITEE_ID, INVITEE_EMAIL);

		const row = await subscriberFor(ORG_PROJECT_ID, INVITEE_EMAIL);
		expect(row).toMatchObject({
			status: "ACTIVE",
			// XOR: org context => organizationId set, userId null. The
			// tenant field is the ORG, never the joining member's id.
			organizationId: ORG_ID,
			userId: null,
		});
	});

	it("writes nothing when the newsletter is disabled", async () => {
		const invitation = await createInvitation(PERSONAL_PROJECT_ID);

		await acceptProjectInvitation(invitation.id, INVITEE_ID, INVITEE_EMAIL);

		expect(
			await subscriberFor(PERSONAL_PROJECT_ID, INVITEE_EMAIL),
		).toBeNull();
		// And the membership itself still exists — enrolment is a side
		// effect, never a precondition.
		expect(
			await db.projectMember.findUnique({
				where: {
					projectId_userId: {
						projectId: PERSONAL_PROJECT_ID,
						userId: INVITEE_ID,
					},
				},
			}),
		).not.toBeNull();
	});

	it("leaves a prior opt-out UNSUBSCRIBED when the member re-joins", async () => {
		await enableNewsletter(PERSONAL_PROJECT_ID, {
			userId: OWNER_ID,
			organizationId: null,
		});
		const unsubscribedAt = new Date("2026-05-01T00:00:00.000Z");
		await db.newsletterSubscriber.create({
			data: {
				projectId: PERSONAL_PROJECT_ID,
				email: INVITEE_EMAIL,
				status: "UNSUBSCRIBED",
				unsubscribedAt,
				unsubscribeToken: "test-nlenrol-token-optout",
				userId: OWNER_ID,
				createdByUserId: OWNER_ID,
			},
		});
		const invitation = await createInvitation(PERSONAL_PROJECT_ID);

		await acceptProjectInvitation(invitation.id, INVITEE_ID, INVITEE_EMAIL);

		const row = await subscriberFor(PERSONAL_PROJECT_ID, INVITEE_EMAIL);
		// Consent is email-level and survives re-joining the project.
		expect(row?.status).toBe("UNSUBSCRIBED");
		expect(row?.unsubscribedAt?.toISOString()).toBe(
			unsubscribedAt.toISOString(),
		);
		// Pin the precondition too. Asserting only that the tombstone
		// survived would stay green if enrolment had never run at all,
		// which would make this a test of nothing. A second joiner with no
		// opt-out history, in the same project and the same fixture state,
		// must come out ACTIVE — so enrolment demonstrably ran here and
		// skipped only the address that had opted out.
		const otherInvitation = await createInvitation(
			PERSONAL_PROJECT_ID,
			OTHER_EMAIL,
		);
		await acceptProjectInvitation(
			otherInvitation.id,
			OTHER_ID,
			OTHER_EMAIL,
		);
		expect(
			await subscriberFor(PERSONAL_PROJECT_ID, OTHER_EMAIL),
		).toMatchObject({ status: "ACTIVE" });
	});

	it("enrols when a concurrent writer already won the membership", async () => {
		await enableNewsletter(PERSONAL_PROJECT_ID, {
			userId: OWNER_ID,
			organizationId: null,
		});
		const invitation = await createInvitation(PERSONAL_PROJECT_ID);
		// Stands in for the reconciliation runner that commits the
		// membership first while leaving the invite live. The accept then
		// takes its already-a-member early return, which under the
		// original design would not have enrolled anyone. The sibling
		// P2002 interleaving — where the loser's existence check ran
		// before the winner committed — cannot be forced deterministically
		// here; it is covered in the wiring suite with a mocked collision.
		await db.projectMember.create({
			data: {
				projectId: PERSONAL_PROJECT_ID,
				userId: INVITEE_ID,
				role: "EDITOR",
				invitedBy: OWNER_ID,
				acceptedAt: new Date(),
			},
		});

		await acceptProjectInvitation(invitation.id, INVITEE_ID, INVITEE_EMAIL);

		expect(
			await subscriberFor(PERSONAL_PROJECT_ID, INVITEE_EMAIL),
		).toMatchObject({ status: "ACTIVE" });
	});
});
