/**
 * Real-DB regression tests for the idempotent `acceptProjectInvitation`.
 *
 * Signup/sign-in invite reconciliation can create the membership and consume
 * a project invitation while the invite-link flow is mid-way through. The
 * accept path must treat those interleavings as success (return the existing
 * member) instead of throwing — otherwise the invite-link flows surface an
 * error toast to a user who already holds the invited access. A PENDING-but-
 * expired invitation with an existing membership also resolves with the
 * member, but the row stays untouched (pending-but-expired rows are READ-ONLY
 * everywhere — the reconciliation invariant). Genuinely invalid invitations
 * (wrong email, unknown id, expired with no membership, declined, accepted
 * with no surviving membership) keep the original error behavior.
 *
 * Self-skips via `hasReachableDatabaseUrl()` when no real Postgres is
 * reachable (default CI run) — the lazy Prisma proxy keeps the import
 * side-effect-free, so the suite loads cleanly without a database.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, Prisma } from "../prisma/client";
import { acceptProjectInvitation } from "../prisma/queries/projects/members";
import { hasReachableDatabaseUrl } from "./_helpers/db-availability";

const NOW = new Date("2026-06-01T12:00:00.000Z");
const INVITER_ID = "test-invacc-inviter";
const INVITEE_ID = "test-invacc-invitee";
const INVITEE_EMAIL = "invacc-invitee@example.com";
const PROJECT_ID = "test-invacc-project";

const ERROR_MESSAGE =
	"Invitation not found, expired, or issued to a different email";

function futureDate() {
	return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
}

function pastDate() {
	return new Date(Date.now() - 60 * 60 * 1000);
}

async function createInvitation(
	overrides: Partial<{
		status: "PENDING" | "ACCEPTED" | "DECLINED" | "EXPIRED";
		expiresAt: Date;
		respondedAt: Date | null;
		role: "OWNER" | "PROJECT_ADMIN" | "EDITOR" | "COMMENTER" | "VIEWER";
	}> = {},
) {
	return db.projectInvitation.create({
		data: {
			projectId: PROJECT_ID,
			email: INVITEE_EMAIL,
			role: overrides.role ?? "EDITOR",
			status: overrides.status ?? "PENDING",
			invitedBy: INVITER_ID,
			expiresAt: overrides.expiresAt ?? futureDate(),
			respondedAt: overrides.respondedAt ?? null,
			createdAt: NOW,
		},
	});
}

async function createMember(
	overrides: Partial<{
		role: "OWNER" | "PROJECT_ADMIN" | "EDITOR" | "COMMENTER" | "VIEWER";
	}> = {},
) {
	return db.projectMember.create({
		data: {
			projectId: PROJECT_ID,
			userId: INVITEE_ID,
			role: overrides.role ?? "EDITOR",
			invitedBy: INVITER_ID,
			acceptedAt: NOW,
		},
	});
}

/**
 * Mirrors what the signup/sign-in invite-reconciliation transaction does for
 * a single project invitation: check membership, create the member, consume
 * the invite — with the P2002 fallback consuming non-transactionally. Used
 * to race a real `acceptProjectInvitation` call against a reconciliation-
 * shaped concurrent writer.
 */
async function simulateReconciliation(invitationId: string) {
	const consume = () =>
		db.projectInvitation.updateMany({
			where: { id: invitationId, status: "PENDING" },
			data: { status: "ACCEPTED", respondedAt: new Date() },
		});

	try {
		await db.$transaction(async (tx) => {
			const existing = await tx.projectMember.findUnique({
				where: {
					projectId_userId: {
						projectId: PROJECT_ID,
						userId: INVITEE_ID,
					},
				},
			});
			if (existing) {
				await tx.projectInvitation.updateMany({
					where: { id: invitationId, status: "PENDING" },
					data: { status: "ACCEPTED", respondedAt: new Date() },
				});
				return;
			}
			await tx.projectMember.create({
				data: {
					projectId: PROJECT_ID,
					userId: INVITEE_ID,
					role: "EDITOR",
					invitedBy: INVITER_ID,
					acceptedAt: new Date(),
				},
			});
			await tx.projectInvitation.updateMany({
				where: { id: invitationId, status: "PENDING" },
				data: { status: "ACCEPTED", respondedAt: new Date() },
			});
		});
	} catch (error) {
		if (
			error instanceof Prisma.PrismaClientKnownRequestError &&
			error.code === "P2002"
		) {
			await consume();
			return;
		}
		throw error;
	}
}

describe.skipIf(!hasReachableDatabaseUrl())(
	"acceptProjectInvitation (idempotent)",
	() => {
		beforeAll(async () => {
			await db.user.upsert({
				where: { id: INVITER_ID },
				update: {},
				create: {
					id: INVITER_ID,
					name: "Invacc Inviter",
					email: "invacc-inviter@example.com",
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
					name: "Invacc Invitee",
					email: INVITEE_EMAIL,
					emailVerified: true,
					onboardingComplete: false,
					createdAt: NOW,
					updatedAt: NOW,
				},
			});

			await db.project.upsert({
				where: { id: PROJECT_ID },
				update: {},
				create: {
					id: PROJECT_ID,
					name: "Invacc Project",
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
			await db.projectMember.deleteMany({
				where: { projectId: PROJECT_ID },
			});
			await db.projectInvitation.deleteMany({
				where: { projectId: PROJECT_ID },
			});
		});

		afterAll(async () => {
			await db.projectMember.deleteMany({
				where: { projectId: PROJECT_ID },
			});
			await db.projectInvitation.deleteMany({
				where: { projectId: PROJECT_ID },
			});
			await db.project.deleteMany({ where: { id: PROJECT_ID } });
			await db.user.deleteMany({
				where: { id: { in: [INVITER_ID, INVITEE_ID] } },
			});
		});

		it("accepts a pending invitation: creates the member and consumes the invite (baseline)", async () => {
			const invitation = await createInvitation();

			const member = await acceptProjectInvitation(
				invitation.id,
				INVITEE_ID,
				INVITEE_EMAIL,
			);

			expect(member.projectId).toBe(PROJECT_ID);
			expect(member.userId).toBe(INVITEE_ID);
			expect(member.role).toBe("EDITOR");
			expect(member.invitedBy).toBe(INVITER_ID);
			expect(member.acceptedAt).not.toBeNull();

			const after = await db.projectInvitation.findUniqueOrThrow({
				where: { id: invitation.id },
			});
			expect(after.status).toBe("ACCEPTED");
			expect(after.respondedAt).not.toBeNull();

			const members = await db.projectMember.findMany({
				where: { projectId: PROJECT_ID, userId: INVITEE_ID },
			});
			expect(members).toHaveLength(1);
		});

		it("resolves with the existing member when the invitation is already ACCEPTED (invitation untouched, role preserved)", async () => {
			const respondedAt = new Date("2026-06-02T08:00:00.000Z");
			const invitation = await createInvitation({
				status: "ACCEPTED",
				respondedAt,
				role: "EDITOR",
			});
			// Existing membership deliberately holds a DIFFERENT role than the
			// invitation — accept must return it as-is, never re-apply the
			// invite role.
			const existing = await createMember({ role: "VIEWER" });

			// Mixed-case, padded email exercises the normalization path.
			const member = await acceptProjectInvitation(
				invitation.id,
				INVITEE_ID,
				"  Invacc-Invitee@Example.COM  ",
			);

			expect(member.id).toBe(existing.id);
			expect(member.role).toBe("VIEWER");

			const memberRows = await db.projectMember.findMany({
				where: { projectId: PROJECT_ID, userId: INVITEE_ID },
			});
			expect(memberRows).toHaveLength(1);
			expect(memberRows[0].role).toBe("VIEWER");

			const after = await db.projectInvitation.findUniqueOrThrow({
				where: { id: invitation.id },
			});
			expect(after.status).toBe("ACCEPTED");
			expect(after.respondedAt?.getTime()).toBe(respondedAt.getTime());
		});

		it("resolves and consumes the invitation when it is PENDING but the membership already exists", async () => {
			const invitation = await createInvitation({ status: "PENDING" });
			const existing = await createMember({ role: "COMMENTER" });

			const member = await acceptProjectInvitation(
				invitation.id,
				INVITEE_ID,
				INVITEE_EMAIL,
			);

			expect(member.id).toBe(existing.id);
			expect(member.role).toBe("COMMENTER");

			const after = await db.projectInvitation.findUniqueOrThrow({
				where: { id: invitation.id },
			});
			expect(after.status).toBe("ACCEPTED");
			expect(after.respondedAt).not.toBeNull();

			const memberRows = await db.projectMember.findMany({
				where: { projectId: PROJECT_ID, userId: INVITEE_ID },
			});
			expect(memberRows).toHaveLength(1);
		});

		it("resolves with the existing member for a PENDING-but-expired invitation and leaves the row untouched", async () => {
			const invitation = await createInvitation({
				status: "PENDING",
				expiresAt: pastDate(),
			});
			const existing = await createMember({ role: "COMMENTER" });

			const member = await acceptProjectInvitation(
				invitation.id,
				INVITEE_ID,
				INVITEE_EMAIL,
			);

			// The member already holds the invited access — success, not an
			// error toast.
			expect(member.id).toBe(existing.id);
			expect(member.role).toBe("COMMENTER");

			// Reconciliation invariant: pending-but-expired rows are READ-ONLY
			// — never flipped to ACCEPTED, not even by the accept path. The
			// re-invite flows revive pending rows in place, so a consumed
			// expired row would break them.
			const after = await db.projectInvitation.findUniqueOrThrow({
				where: { id: invitation.id },
			});
			expect(after.status).toBe("PENDING");
			expect(after.respondedAt).toBeNull();

			const memberRows = await db.projectMember.findMany({
				where: { projectId: PROJECT_ID, userId: INVITEE_ID },
			});
			expect(memberRows).toHaveLength(1);
		});

		it("throws the unchanged message for a wrong email regardless of status", async () => {
			const pending = await createInvitation({ status: "PENDING" });

			await expect(
				acceptProjectInvitation(
					pending.id,
					INVITEE_ID,
					"someone-else@example.com",
				),
			).rejects.toThrow(ERROR_MESSAGE);

			// Wrong email beats every idempotent path: even an ACCEPTED
			// invitation with an existing membership stays unreachable.
			await db.projectInvitation.update({
				where: { id: pending.id },
				data: { status: "ACCEPTED", respondedAt: new Date() },
			});
			await createMember();

			await expect(
				acceptProjectInvitation(
					pending.id,
					INVITEE_ID,
					"someone-else@example.com",
				),
			).rejects.toThrow(ERROR_MESSAGE);
		});

		it("throws for an unknown invitation id", async () => {
			await expect(
				acceptProjectInvitation(
					"test-invacc-missing-id",
					INVITEE_ID,
					INVITEE_EMAIL,
				),
			).rejects.toThrow(ERROR_MESSAGE);
		});

		it("throws for a pending-but-expired invitation and leaves the row pending", async () => {
			const invitation = await createInvitation({
				status: "PENDING",
				expiresAt: pastDate(),
			});

			await expect(
				acceptProjectInvitation(
					invitation.id,
					INVITEE_ID,
					INVITEE_EMAIL,
				),
			).rejects.toThrow(ERROR_MESSAGE);

			// Expired rows are read-only: never flipped to a terminal status.
			const after = await db.projectInvitation.findUniqueOrThrow({
				where: { id: invitation.id },
			});
			expect(after.status).toBe("PENDING");

			const memberRows = await db.projectMember.findMany({
				where: { projectId: PROJECT_ID, userId: INVITEE_ID },
			});
			expect(memberRows).toHaveLength(0);
		});

		it("throws for a DECLINED invitation", async () => {
			const invitation = await createInvitation({
				status: "DECLINED",
				respondedAt: NOW,
			});

			await expect(
				acceptProjectInvitation(
					invitation.id,
					INVITEE_ID,
					INVITEE_EMAIL,
				),
			).rejects.toThrow(ERROR_MESSAGE);

			const after = await db.projectInvitation.findUniqueOrThrow({
				where: { id: invitation.id },
			});
			expect(after.status).toBe("DECLINED");
		});

		it("throws for an ACCEPTED invitation when the caller is no longer a member", async () => {
			const invitation = await createInvitation({
				status: "ACCEPTED",
				respondedAt: NOW,
			});

			await expect(
				acceptProjectInvitation(
					invitation.id,
					INVITEE_ID,
					INVITEE_EMAIL,
				),
			).rejects.toThrow(ERROR_MESSAGE);

			const memberRows = await db.projectMember.findMany({
				where: { projectId: PROJECT_ID, userId: INVITEE_ID },
			});
			expect(memberRows).toHaveLength(0);
		});

		it("concurrent accept + reconciliation both succeed with exactly one membership", async () => {
			const invitation = await createInvitation({ status: "PENDING" });

			const [member] = await Promise.all([
				acceptProjectInvitation(
					invitation.id,
					INVITEE_ID,
					INVITEE_EMAIL,
				),
				simulateReconciliation(invitation.id),
			]);

			expect(member.projectId).toBe(PROJECT_ID);
			expect(member.userId).toBe(INVITEE_ID);

			const memberRows = await db.projectMember.findMany({
				where: { projectId: PROJECT_ID, userId: INVITEE_ID },
			});
			expect(memberRows).toHaveLength(1);

			const after = await db.projectInvitation.findUniqueOrThrow({
				where: { id: invitation.id },
			});
			expect(after.status).toBe("ACCEPTED");
			expect(after.respondedAt).not.toBeNull();
		});

		it("two parallel accepts (parallel tabs) both succeed with exactly one membership", async () => {
			const invitation = await createInvitation({ status: "PENDING" });

			const [first, second] = await Promise.all([
				acceptProjectInvitation(
					invitation.id,
					INVITEE_ID,
					INVITEE_EMAIL,
				),
				acceptProjectInvitation(
					invitation.id,
					INVITEE_ID,
					INVITEE_EMAIL,
				),
			]);

			expect(first.projectId).toBe(PROJECT_ID);
			expect(second.projectId).toBe(PROJECT_ID);
			expect(first.id).toBe(second.id);

			const memberRows = await db.projectMember.findMany({
				where: { projectId: PROJECT_ID, userId: INVITEE_ID },
			});
			expect(memberRows).toHaveLength(1);

			const after = await db.projectInvitation.findUniqueOrThrow({
				where: { id: invitation.id },
			});
			expect(after.status).toBe("ACCEPTED");
		});
	},
);
