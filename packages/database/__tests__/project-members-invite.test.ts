import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../prisma/client";
import {
	canInviteUser,
	createProjectInvitation,
} from "../prisma/queries/projects/members";

const NOW = new Date("2026-04-02T12:00:00.000Z");
const INVITER_ID = "test-project-inviter";
const ORG_MEMBER_ID = "test-project-org-member";
const EXTERNAL_USER_ID = "test-project-external-user";
const ORG_ID = "test-project-org";
const ORG_PROJECT_ID = "test-project-org-project";
const PERSONAL_PROJECT_ID = "test-project-personal-project";

describe("project member invitations", () => {
	beforeAll(async () => {
		await db.user.upsert({
			where: { id: INVITER_ID },
			update: {},
			create: {
				id: INVITER_ID,
				name: "Project Inviter",
				email: "project-inviter@example.com",
				emailVerified: true,
				onboardingComplete: false,
				createdAt: NOW,
				updatedAt: NOW,
			},
		});

		await db.user.upsert({
			where: { id: ORG_MEMBER_ID },
			update: {},
			create: {
				id: ORG_MEMBER_ID,
				name: "Org Member",
				email: "org-member@example.com",
				emailVerified: true,
				onboardingComplete: false,
				createdAt: NOW,
				updatedAt: NOW,
			},
		});

		await db.user.upsert({
			where: { id: EXTERNAL_USER_ID },
			update: {},
			create: {
				id: EXTERNAL_USER_ID,
				name: "External User",
				email: "external-user@example.com",
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
				name: "Project Invite Org",
				slug: ORG_ID,
				createdAt: NOW,
			},
		});

		await db.member.upsert({
			where: {
				organizationId_userId: {
					organizationId: ORG_ID,
					userId: INVITER_ID,
				},
			},
			update: {},
			create: {
				organizationId: ORG_ID,
				userId: INVITER_ID,
				role: "owner",
				createdAt: NOW,
			},
		});

		await db.member.upsert({
			where: {
				organizationId_userId: {
					organizationId: ORG_ID,
					userId: ORG_MEMBER_ID,
				},
			},
			update: {},
			create: {
				organizationId: ORG_ID,
				userId: ORG_MEMBER_ID,
				role: "member",
				createdAt: NOW,
			},
		});

		await db.project.upsert({
			where: { id: ORG_PROJECT_ID },
			update: {},
			create: {
				id: ORG_PROJECT_ID,
				name: "Org Project",
				userId: INVITER_ID,
				organizationId: ORG_ID,
				techStack: [],
				features: [],
				tags: [],
				createdAt: NOW,
				updatedAt: NOW,
			},
		});

		await db.project.upsert({
			where: { id: PERSONAL_PROJECT_ID },
			update: {},
			create: {
				id: PERSONAL_PROJECT_ID,
				name: "Personal Project",
				userId: INVITER_ID,
				techStack: [],
				features: [],
				tags: [],
				createdAt: NOW,
				updatedAt: NOW,
			},
		});
	});

	beforeEach(async () => {
		await db.projectInvitation.deleteMany({
			where: {
				projectId: { in: [ORG_PROJECT_ID, PERSONAL_PROJECT_ID] },
			},
		});
	});

	afterAll(async () => {
		await db.projectInvitation.deleteMany({
			where: {
				projectId: { in: [ORG_PROJECT_ID, PERSONAL_PROJECT_ID] },
			},
		});
		await db.project.deleteMany({
			where: { id: { in: [ORG_PROJECT_ID, PERSONAL_PROJECT_ID] } },
		});
		await db.member.deleteMany({
			where: {
				organizationId: ORG_ID,
				userId: { in: [INVITER_ID, ORG_MEMBER_ID] },
			},
		});
		await db.organization.deleteMany({
			where: { id: ORG_ID },
		});
		await db.user.deleteMany({
			where: {
				id: { in: [INVITER_ID, ORG_MEMBER_ID, EXTERNAL_USER_ID] },
			},
		});
	});

	// Guest model (see the members.ts file header): external guests are
	// deliberately supported — emails with no Fabric account and users from
	// another organization may both be invited to an org project. They get
	// project-scoped access only; they never become org members.
	it("allows org-project invites for external emails with no Fabric account (guest model)", async () => {
		const result = await canInviteUser(
			ORG_PROJECT_ID,
			INVITER_ID,
			"new-external@example.com",
		);

		expect(result).toEqual({ canInvite: true });
	});

	it("allows inviting an existing outside-the-org user by case-insensitive email (guest model)", async () => {
		const result = await canInviteUser(
			ORG_PROJECT_ID,
			INVITER_ID,
			"External-User@Example.com",
		);

		expect(result).toEqual({ canInvite: true });
	});

	it("stores invitations with normalized email casing", async () => {
		const invitation = await createProjectInvitation({
			projectId: PERSONAL_PROJECT_ID,
			email: "MixedCase@Example.com",
			role: "VIEWER",
			invitedBy: INVITER_ID,
		});

		expect(invitation.email).toBe("mixedcase@example.com");
	});

	it("revives a non-pending invitation instead of throwing a unique-constraint error", async () => {
		const first = await createProjectInvitation({
			projectId: PERSONAL_PROJECT_ID,
			email: "revive-me@example.com",
			role: "VIEWER",
			invitedBy: INVITER_ID,
			message: "first message",
		});

		// Simulate the invitation completing its lifecycle: the row lingers
		// in a non-PENDING state (accepted / declined / expired) and is never
		// cleaned up. A naive create() here collides with the
		// @@unique([projectId, email]) constraint and 500s.
		await db.projectInvitation.update({
			where: { id: first.id },
			data: { status: "ACCEPTED", respondedAt: NOW },
		});

		const second = await createProjectInvitation({
			projectId: PERSONAL_PROJECT_ID,
			email: "revive-me@example.com",
			role: "EDITOR",
			invitedBy: INVITER_ID,
		});

		// Same row, revived back into a fresh PENDING invitation.
		expect(second.id).toBe(first.id);
		expect(second.status).toBe("PENDING");
		expect(second.role).toBe("EDITOR");
		expect(second.respondedAt).toBeNull();
		// Re-invite with no message clears the stale one.
		expect(second.message).toBeNull();
	});

	it("is idempotent when re-inviting an email that still has a pending invitation", async () => {
		const first = await createProjectInvitation({
			projectId: PERSONAL_PROJECT_ID,
			email: "still-pending@example.com",
			role: "VIEWER",
			invitedBy: INVITER_ID,
		});

		const second = await createProjectInvitation({
			projectId: PERSONAL_PROJECT_ID,
			email: "still-pending@example.com",
			role: "VIEWER",
			invitedBy: INVITER_ID,
		});

		expect(second.id).toBe(first.id);
		expect(second.status).toBe("PENDING");

		const rows = await db.projectInvitation.findMany({
			where: {
				projectId: PERSONAL_PROJECT_ID,
				email: "still-pending@example.com",
			},
		});
		expect(rows).toHaveLength(1);
	});
});
