/**
 * Real-Postgres integration tests for `reconcilePendingInvitesForUser`.
 *
 * Exercises the core signup/sign-in invite-reconciliation module against
 * the actual Aspire-spun-up dev Postgres + Prisma client (no mocks):
 * pending org/project invite resolution, role rules, read-only expiry
 * skips, terminal-status exclusion, already-member consumption,
 * idempotency, and the concurrent-run P2002 path.
 *
 * Self-skips when DATABASE_URL is unset or points at the CI placeholder
 * (see `_helpers/db-availability.ts`) so the default CI run loads the
 * suite cleanly without touching a database.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	db,
	type ProjectInvitationStatus,
	type ProjectMemberRole,
} from "../prisma/client";
import { reconcilePendingInvitesForUser } from "../prisma/queries/invite-reconciliation";
import { hasReachableDatabaseUrl } from "./_helpers/db-availability";

const RUN_ID = `${Date.now()}-${process.pid}`;
const FIXTURE_DATE = new Date("2026-06-01T00:00:00.000Z");
const FUTURE_EXPIRY = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
const PAST_EXPIRY = new Date(Date.now() - 60 * 60 * 1000);

const USER_ID = `test-invrec-user-${RUN_ID}`;
const INVITER_ID = `test-invrec-inviter-${RUN_ID}`;
const ORG_A_ID = `test-invrec-org-a-${RUN_ID}`;
const ORG_B_ID = `test-invrec-org-b-${RUN_ID}`;
const PROJECT_A_ID = `test-invrec-project-a-${RUN_ID}`;
const PROJECT_B_ID = `test-invrec-project-b-${RUN_ID}`;
const PROJECT_C_ID = `test-invrec-project-c-${RUN_ID}`;
const ALL_PROJECT_IDS = [PROJECT_A_ID, PROJECT_B_ID, PROJECT_C_ID];
const ALL_ORG_IDS = [ORG_A_ID, ORG_B_ID];
const INVITEE_EMAIL = `test-invrec-invitee-${RUN_ID}@example.com`;

function seedOrgInvite(
	overrides: {
		organizationId?: string;
		email?: string;
		role?: string | null;
		status?: string;
		teamId?: string;
		expiresAt?: Date;
		createdAt?: Date;
	} = {},
) {
	return db.invitation.create({
		data: {
			organizationId: overrides.organizationId ?? ORG_A_ID,
			email: overrides.email ?? INVITEE_EMAIL,
			role: overrides.role === undefined ? "member" : overrides.role,
			status: overrides.status ?? "pending",
			teamId: overrides.teamId,
			expiresAt: overrides.expiresAt ?? FUTURE_EXPIRY,
			inviterId: INVITER_ID,
			createdAt: overrides.createdAt ?? new Date(),
		},
	});
}

function seedProjectInvite(
	overrides: {
		projectId?: string;
		email?: string;
		role?: ProjectMemberRole;
		status?: ProjectInvitationStatus;
		expiresAt?: Date;
	} = {},
) {
	return db.projectInvitation.create({
		data: {
			projectId: overrides.projectId ?? PROJECT_A_ID,
			email: overrides.email ?? INVITEE_EMAIL,
			role: overrides.role ?? "EDITOR",
			status: overrides.status ?? "PENDING",
			invitedBy: INVITER_ID,
			expiresAt: overrides.expiresAt ?? FUTURE_EXPIRY,
		},
	});
}

describe.skipIf(!hasReachableDatabaseUrl())(
	"reconcilePendingInvitesForUser (real Postgres)",
	() => {
		beforeAll(async () => {
			await db.user.upsert({
				where: { id: USER_ID },
				update: {},
				create: {
					id: USER_ID,
					name: "Invite Reconciliation User",
					email: INVITEE_EMAIL,
					emailVerified: true,
					onboardingComplete: false,
					createdAt: FIXTURE_DATE,
					updatedAt: FIXTURE_DATE,
				},
			});

			await db.user.upsert({
				where: { id: INVITER_ID },
				update: {},
				create: {
					id: INVITER_ID,
					name: "Invite Reconciliation Inviter",
					email: `test-invrec-inviter-${RUN_ID}@example.com`,
					emailVerified: true,
					onboardingComplete: false,
					createdAt: FIXTURE_DATE,
					updatedAt: FIXTURE_DATE,
				},
			});

			await db.organization.upsert({
				where: { id: ORG_A_ID },
				update: {},
				create: {
					id: ORG_A_ID,
					name: "Invite Reconciliation Org A",
					slug: ORG_A_ID,
					createdAt: FIXTURE_DATE,
				},
			});

			await db.organization.upsert({
				where: { id: ORG_B_ID },
				update: {},
				create: {
					id: ORG_B_ID,
					name: "Invite Reconciliation Org B",
					slug: ORG_B_ID,
					createdAt: FIXTURE_DATE,
				},
			});

			for (const projectId of ALL_PROJECT_IDS) {
				await db.project.upsert({
					where: { id: projectId },
					update: {},
					create: {
						id: projectId,
						name: `Invite Reconciliation Project ${projectId}`,
						userId: INVITER_ID,
						organizationId: ORG_A_ID,
						techStack: [],
						features: [],
						tags: [],
						createdAt: FIXTURE_DATE,
						updatedAt: FIXTURE_DATE,
					},
				});
			}
		});

		beforeEach(async () => {
			await db.invitation.deleteMany({
				where: { organizationId: { in: ALL_ORG_IDS } },
			});
			await db.projectInvitation.deleteMany({
				where: { projectId: { in: ALL_PROJECT_IDS } },
			});
			await db.member.deleteMany({ where: { userId: USER_ID } });
			await db.projectMember.deleteMany({ where: { userId: USER_ID } });
		});

		afterAll(async () => {
			await db.invitation.deleteMany({
				where: { organizationId: { in: ALL_ORG_IDS } },
			});
			await db.projectInvitation.deleteMany({
				where: { projectId: { in: ALL_PROJECT_IDS } },
			});
			await db.projectMember.deleteMany({
				where: { projectId: { in: ALL_PROJECT_IDS } },
			});
			await db.member.deleteMany({
				where: { organizationId: { in: ALL_ORG_IDS } },
			});
			await db.project.deleteMany({
				where: { id: { in: ALL_PROJECT_IDS } },
			});
			await db.organization.deleteMany({
				where: { id: { in: ALL_ORG_IDS } },
			});
			await db.user.deleteMany({
				where: { id: { in: [USER_ID, INVITER_ID] } },
			});
		});

		it("resolves a single pending org invite: member at invite role, invite accepted, explicit createdAt", async () => {
			const invite = await seedOrgInvite({ role: "admin" });

			const result = await reconcilePendingInvitesForUser({
				userId: USER_ID,
				email: INVITEE_EMAIL,
			});

			expect(result.orgInvitesFound).toBe(1);
			expect(result.orgMembershipsCreated).toBe(1);
			expect(result.projectInvitesFound).toBe(0);
			expect(result.skipped).toEqual([]);
			expect(result.createdOrgMemberships).toHaveLength(1);
			const grant = result.createdOrgMemberships[0];
			expect(grant?.organizationId).toBe(ORG_A_ID);
			expect(grant?.role).toBe("admin");
			expect(grant?.invitationIds).toEqual([invite.id]);

			const member = await db.member.findUnique({
				where: {
					organizationId_userId: {
						organizationId: ORG_A_ID,
						userId: USER_ID,
					},
				},
			});
			expect(member).not.toBeNull();
			expect(member?.id).toBe(grant?.memberId);
			expect(member?.role).toBe("admin");
			// The member model has no Prisma default on createdAt — the
			// module must set it explicitly; a fresh timestamp proves it.
			expect(member?.createdAt).toBeInstanceOf(Date);
			expect(
				Math.abs(Date.now() - (member?.createdAt.getTime() ?? 0)),
			).toBeLessThan(60_000);

			const consumed = await db.invitation.findUnique({
				where: { id: invite.id },
			});
			expect(consumed?.status).toBe("accepted");
		});

		it("defaults a null org invite role to 'member'", async () => {
			await seedOrgInvite({ role: null });

			const result = await reconcilePendingInvitesForUser({
				userId: USER_ID,
				email: INVITEE_EMAIL,
			});

			expect(result.orgMembershipsCreated).toBe(1);
			expect(result.createdOrgMemberships[0]?.role).toBe("member");

			const member = await db.member.findUnique({
				where: {
					organizationId_userId: {
						organizationId: ORG_A_ID,
						userId: USER_ID,
					},
				},
			});
			expect(member?.role).toBe("member");
		});

		it("resolves a pending project invite: member with non-null acceptedAt, role and invitedBy carried, invite ACCEPTED + respondedAt", async () => {
			const invite = await seedProjectInvite({ role: "EDITOR" });

			const result = await reconcilePendingInvitesForUser({
				userId: USER_ID,
				email: INVITEE_EMAIL,
			});

			expect(result.projectInvitesFound).toBe(1);
			expect(result.projectMembershipsCreated).toBe(1);
			expect(result.skipped).toEqual([]);
			expect(result.createdProjectMemberships).toEqual([
				{
					projectId: PROJECT_A_ID,
					memberId: expect.any(String),
					role: "EDITOR",
					invitationId: invite.id,
				},
			]);

			const member = await db.projectMember.findUnique({
				where: {
					projectId_userId: {
						projectId: PROJECT_A_ID,
						userId: USER_ID,
					},
				},
			});
			expect(member?.role).toBe("EDITOR");
			expect(member?.invitedBy).toBe(INVITER_ID);
			// Null acceptedAt would make the membership invisible everywhere.
			expect(member?.acceptedAt).not.toBeNull();

			const consumed = await db.projectInvitation.findUnique({
				where: { id: invite.id },
			});
			expect(consumed?.status).toBe("ACCEPTED");
			expect(consumed?.respondedAt).not.toBeNull();
		});

		it("resolves mixed org + project invites in one pass with correct counts and detail arrays", async () => {
			const orgInvite = await seedOrgInvite({ role: "member" });
			const projectInvite = await seedProjectInvite({ role: "VIEWER" });

			const result = await reconcilePendingInvitesForUser({
				userId: USER_ID,
				email: INVITEE_EMAIL,
			});

			expect(result).toMatchObject({
				orgInvitesFound: 1,
				orgMembershipsCreated: 1,
				projectInvitesFound: 1,
				projectMembershipsCreated: 1,
			});
			expect(result.skipped).toEqual([]);
			expect(result.createdOrgMemberships).toHaveLength(1);
			expect(result.createdOrgMemberships[0]?.invitationIds).toEqual([
				orgInvite.id,
			]);
			expect(result.createdProjectMemberships).toHaveLength(1);
			expect(result.createdProjectMemberships[0]?.invitationId).toBe(
				projectInvite.id,
			);
		});

		it("skips pending-but-expired invites read-only: reason 'expired', rows stay pending", async () => {
			const orgInvite = await seedOrgInvite({ expiresAt: PAST_EXPIRY });
			const projectInvite = await seedProjectInvite({
				expiresAt: PAST_EXPIRY,
			});

			const result = await reconcilePendingInvitesForUser({
				userId: USER_ID,
				email: INVITEE_EMAIL,
			});

			expect(result.orgInvitesFound).toBe(1);
			expect(result.projectInvitesFound).toBe(1);
			expect(result.orgMembershipsCreated).toBe(0);
			expect(result.projectMembershipsCreated).toBe(0);
			expect(result.skipped).toHaveLength(2);
			expect(result.skipped).toEqual(
				expect.arrayContaining([
					{
						type: "organization",
						invitationId: orgInvite.id,
						reason: "expired",
					},
					{
						type: "project",
						invitationId: projectInvite.id,
						reason: "expired",
					},
				]),
			);

			// Read-only skip: rows keep their pending status (never flipped
			// to a terminal status — re-invites revive pending rows).
			const orgRow = await db.invitation.findUnique({
				where: { id: orgInvite.id },
			});
			expect(orgRow?.status).toBe("pending");
			const projectRow = await db.projectInvitation.findUnique({
				where: { id: projectInvite.id },
			});
			expect(projectRow?.status).toBe("PENDING");
			expect(projectRow?.respondedAt).toBeNull();

			expect(await db.member.count({ where: { userId: USER_ID } })).toBe(
				0,
			);
			expect(
				await db.projectMember.count({ where: { userId: USER_ID } }),
			).toBe(0);
		});

		it("never selects or mutates terminal-status invites", async () => {
			await seedOrgInvite({ status: "accepted" });
			await seedOrgInvite({ status: "rejected" });
			await seedOrgInvite({ status: "canceled" });
			await seedProjectInvite({
				projectId: PROJECT_A_ID,
				status: "ACCEPTED",
			});
			await seedProjectInvite({
				projectId: PROJECT_B_ID,
				status: "DECLINED",
			});
			await seedProjectInvite({
				projectId: PROJECT_C_ID,
				status: "EXPIRED",
			});

			const result = await reconcilePendingInvitesForUser({
				userId: USER_ID,
				email: INVITEE_EMAIL,
			});

			expect(result).toMatchObject({
				orgInvitesFound: 0,
				orgMembershipsCreated: 0,
				projectInvitesFound: 0,
				projectMembershipsCreated: 0,
			});
			expect(result.skipped).toEqual([]);

			const orgStatuses = await db.invitation.findMany({
				where: { organizationId: ORG_A_ID },
				select: { status: true },
			});
			expect(orgStatuses.map((row) => row.status).sort()).toEqual([
				"accepted",
				"canceled",
				"rejected",
			]);
			const projectStatuses = await db.projectInvitation.findMany({
				where: { projectId: { in: ALL_PROJECT_IDS } },
				select: { status: true },
			});
			expect(projectStatuses.map((row) => row.status).sort()).toEqual([
				"ACCEPTED",
				"DECLINED",
				"EXPIRED",
			]);

			expect(await db.member.count({ where: { userId: USER_ID } })).toBe(
				0,
			);
			expect(
				await db.projectMember.count({ where: { userId: USER_ID } }),
			).toBe(0);
		});

		it("consumes invites for an existing member without touching the existing role (no P2002 escape)", async () => {
			await db.member.create({
				data: {
					organizationId: ORG_A_ID,
					userId: USER_ID,
					role: "owner",
					createdAt: new Date(),
				},
			});
			await db.projectMember.create({
				data: {
					projectId: PROJECT_A_ID,
					userId: USER_ID,
					role: "VIEWER",
					invitedBy: INVITER_ID,
					acceptedAt: new Date(),
				},
			});
			const orgInvite = await seedOrgInvite({ role: "member" });
			const projectInvite = await seedProjectInvite({
				role: "PROJECT_ADMIN",
			});

			const result = await reconcilePendingInvitesForUser({
				userId: USER_ID,
				email: INVITEE_EMAIL,
			});

			expect(result.orgInvitesFound).toBe(1);
			expect(result.projectInvitesFound).toBe(1);
			expect(result.orgMembershipsCreated).toBe(0);
			expect(result.projectMembershipsCreated).toBe(0);
			expect(result.skipped).toEqual(
				expect.arrayContaining([
					{
						type: "organization",
						invitationId: orgInvite.id,
						reason: "already_member",
					},
					{
						type: "project",
						invitationId: projectInvite.id,
						reason: "already_member",
					},
				]),
			);

			// Existing roles are never changed.
			const member = await db.member.findUnique({
				where: {
					organizationId_userId: {
						organizationId: ORG_A_ID,
						userId: USER_ID,
					},
				},
			});
			expect(member?.role).toBe("owner");
			const projectMember = await db.projectMember.findUnique({
				where: {
					projectId_userId: {
						projectId: PROJECT_A_ID,
						userId: USER_ID,
					},
				},
			});
			expect(projectMember?.role).toBe("VIEWER");

			// Invites are still consumed.
			const consumedOrg = await db.invitation.findUnique({
				where: { id: orgInvite.id },
			});
			expect(consumedOrg?.status).toBe("accepted");
			const consumedProject = await db.projectInvitation.findUnique({
				where: { id: projectInvite.id },
			});
			expect(consumedProject?.status).toBe("ACCEPTED");
			expect(consumedProject?.respondedAt).not.toBeNull();

			// Exactly one membership row each — no duplicates.
			expect(
				await db.member.count({
					where: { organizationId: ORG_A_ID, userId: USER_ID },
				}),
			).toBe(1);
			expect(
				await db.projectMember.count({
					where: { projectId: PROJECT_A_ID, userId: USER_ID },
				}),
			).toBe(1);
		});

		it("multiple pending invites for the same org: newest-createdAt role wins, all consumed, exactly one member row", async () => {
			const oldest = await seedOrgInvite({
				role: "member",
				createdAt: new Date("2026-06-01T00:00:00.000Z"),
			});
			const middle = await seedOrgInvite({
				role: null,
				createdAt: new Date("2026-06-02T00:00:00.000Z"),
			});
			const newest = await seedOrgInvite({
				role: "admin",
				createdAt: new Date("2026-06-03T00:00:00.000Z"),
			});

			const result = await reconcilePendingInvitesForUser({
				userId: USER_ID,
				email: INVITEE_EMAIL,
			});

			expect(result.orgInvitesFound).toBe(3);
			expect(result.orgMembershipsCreated).toBe(1);
			const grant = result.createdOrgMemberships[0];
			expect(grant?.role).toBe("admin");
			expect([...(grant?.invitationIds ?? [])].sort()).toEqual(
				[oldest.id, middle.id, newest.id].sort(),
			);

			const rows = await db.invitation.findMany({
				where: { id: { in: [oldest.id, middle.id, newest.id] } },
				select: { status: true },
			});
			expect(rows).toHaveLength(3);
			expect(rows.every((row) => row.status === "accepted")).toBe(true);

			const members = await db.member.findMany({
				where: { organizationId: ORG_A_ID, userId: USER_ID },
			});
			expect(members).toHaveLength(1);
			expect(members[0]?.role).toBe("admin");
		});

		it("matches case-mismatched emails in both directions", async () => {
			// Direction 1: legacy mixed-case stored row, lowercase input.
			const mixedStoredEmail = `Test-InvRec-Mixed-${RUN_ID}@Example.COM`;
			await seedOrgInvite({ email: mixedStoredEmail });

			const first = await reconcilePendingInvitesForUser({
				userId: USER_ID,
				email: mixedStoredEmail.toLowerCase(),
			});
			expect(first.orgInvitesFound).toBe(1);
			expect(first.orgMembershipsCreated).toBe(1);

			// Direction 2: normalized stored row, mixed-case padded input.
			await seedProjectInvite({});
			const second = await reconcilePendingInvitesForUser({
				userId: USER_ID,
				email: `  ${INVITEE_EMAIL.toUpperCase()}  `,
			});
			expect(second.projectInvitesFound).toBe(1);
			expect(second.projectMembershipsCreated).toBe(1);
		});

		it("double run: the second run is a pure no-op", async () => {
			await seedOrgInvite({});
			await seedProjectInvite({});

			const first = await reconcilePendingInvitesForUser({
				userId: USER_ID,
				email: INVITEE_EMAIL,
			});
			expect(first.orgMembershipsCreated).toBe(1);
			expect(first.projectMembershipsCreated).toBe(1);

			const second = await reconcilePendingInvitesForUser({
				userId: USER_ID,
				email: INVITEE_EMAIL,
			});
			expect(second).toEqual({
				orgInvitesFound: 0,
				orgMembershipsCreated: 0,
				projectInvitesFound: 0,
				projectMembershipsCreated: 0,
				createdOrgMemberships: [],
				createdProjectMemberships: [],
				skipped: [],
				warnings: [],
			});

			expect(await db.member.count({ where: { userId: USER_ID } })).toBe(
				1,
			);
			expect(
				await db.projectMember.count({ where: { userId: USER_ID } }),
			).toBe(1);
		});

		it("concurrent runs both resolve and create exactly one membership (P2002 path)", async () => {
			await seedOrgInvite({});
			await seedProjectInvite({});

			const [first, second] = await Promise.all([
				reconcilePendingInvitesForUser({
					userId: USER_ID,
					email: INVITEE_EMAIL,
				}),
				reconcilePendingInvitesForUser({
					userId: USER_ID,
					email: INVITEE_EMAIL,
				}),
			]);

			expect(
				first.orgMembershipsCreated + second.orgMembershipsCreated,
			).toBe(1);
			expect(
				first.projectMembershipsCreated +
					second.projectMembershipsCreated,
			).toBe(1);
			// Neither run surfaced an unexpected per-group error.
			expect(
				[...first.skipped, ...second.skipped].filter(
					(skip) => skip.reason === "error",
				),
			).toEqual([]);

			expect(
				await db.member.count({
					where: { organizationId: ORG_A_ID, userId: USER_ID },
				}),
			).toBe(1);
			expect(
				await db.projectMember.count({
					where: { projectId: PROJECT_A_ID, userId: USER_ID },
				}),
			).toBe(1);
		});

		it("returns an empty no-op summary when no invites exist (and bails on an empty email)", async () => {
			const emptySummary = {
				orgInvitesFound: 0,
				orgMembershipsCreated: 0,
				projectInvitesFound: 0,
				projectMembershipsCreated: 0,
				createdOrgMemberships: [],
				createdProjectMemberships: [],
				skipped: [],
				warnings: [],
			};

			const noInvites = await reconcilePendingInvitesForUser({
				userId: USER_ID,
				email: `test-invrec-nobody-${RUN_ID}@example.com`,
			});
			expect(noInvites).toEqual(emptySummary);

			const emptyEmail = await reconcilePendingInvitesForUser({
				userId: USER_ID,
				email: "   ",
			});
			expect(emptyEmail).toEqual(emptySummary);
		});

		it("a project invite grants guest access only — no org member row is created", async () => {
			// PROJECT_A is an org project (ORG_A). Only a project invite is
			// pending; reconciliation must not infer org membership from it.
			await seedProjectInvite({ role: "COMMENTER" });

			const result = await reconcilePendingInvitesForUser({
				userId: USER_ID,
				email: INVITEE_EMAIL,
			});

			expect(result.projectMembershipsCreated).toBe(1);
			expect(result.orgMembershipsCreated).toBe(0);
			expect(result.createdOrgMemberships).toEqual([]);

			const projectMember = await db.projectMember.findUnique({
				where: {
					projectId_userId: {
						projectId: PROJECT_A_ID,
						userId: USER_ID,
					},
				},
			});
			expect(projectMember?.role).toBe("COMMENTER");
			expect(projectMember?.acceptedAt).not.toBeNull();

			const orgMember = await db.member.findUnique({
				where: {
					organizationId_userId: {
						organizationId: ORG_A_ID,
						userId: USER_ID,
					},
				},
			});
			expect(orgMember).toBeNull();
			expect(await db.member.count({ where: { userId: USER_ID } })).toBe(
				0,
			);
		});

		it("surfaces a non-null teamId as a warning without blocking the grant", async () => {
			const invite = await seedOrgInvite({
				role: "member",
				teamId: `test-invrec-team-${RUN_ID}`,
			});

			const result = await reconcilePendingInvitesForUser({
				userId: USER_ID,
				email: INVITEE_EMAIL,
			});

			expect(result.orgMembershipsCreated).toBe(1);
			expect(result.warnings).toEqual([
				{
					type: "organization",
					invitationId: invite.id,
					organizationId: ORG_A_ID,
					code: "team_id_present",
					teamId: `test-invrec-team-${RUN_ID}`,
				},
			]);
		});
	},
);
