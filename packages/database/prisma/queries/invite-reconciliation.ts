/**
 * Signup / sign-in invite reconciliation — core DB module.
 *
 * Resolves pending organization invitations (`invitation`, the Better Auth
 * organization-plugin table) and project invitations (`project_invitation`)
 * for a user by normalized email match: creates the membership at the role
 * stored on the invite and consumes the invite rows. Pure data layer by
 * design — no logging and no side effects beyond rows; the auth-layer
 * wrapper drives the org-grant side effects (MCP seeding, audit, seats)
 * and structured logging from the returned summary.
 *
 * Guarantees:
 * - Only live-pending rows are ever selected (org `status: "pending"`,
 *   project `status: "PENDING"`); terminal rows (`accepted` / `rejected` /
 *   `canceled`, `ACCEPTED` / `DECLINED` / `EXPIRED`) are never read or
 *   mutated.
 * - Pending-but-expired rows are skipped READ-ONLY — they keep their
 *   pending status, because the re-invite flows revive pending rows in
 *   place and Better Auth assumes pending rows stay pending.
 * - Idempotent and concurrency-safe: an in-transaction existence check,
 *   the `member(organizationId, userId)` / `project_member(projectId,
 *   userId)` unique constraints, and P2002 handling guarantee at most one
 *   membership per target across any number of concurrent runners. Invite
 *   consumption is a conditional `updateMany`; a 0-count result means
 *   another runner consumed the row first — benign, not an error.
 * - An existing membership is never modified: the invites are consumed and
 *   the existing role is left untouched.
 * - A project invite grants project-scoped (guest) access ONLY — it never
 *   creates an org `member` row.
 */
import { db, Prisma, type ProjectMemberRole } from "../client";
import { applyGlobalDefaultFunctionTags } from "./projects/function-tags";

/**
 * Why a qualifying invite was not converted into a membership.
 *
 * This module only emits `expired` (pending-but-past-expiry, read-only),
 * `already_member` (membership existed or a concurrent runner won the
 * create), and `error` (per-group/per-row isolation). The remaining
 * reasons exist in the shared type for the idempotent-accept path and
 * race-y conditional-update outcomes in callers.
 */
export type InviteSkipReason =
	| "expired"
	| "already_member"
	| "already_accepted"
	| "declined" // project DECLINED
	| "rejected" // org rejected
	| "canceled" // org canceled (revoked)
	| "error"; // per-group isolation — unexpected failure, run continued

export interface ReconcileSkippedInvite {
	type: "organization" | "project";
	invitationId: string;
	reason: InviteSkipReason;
	/**
	 * Present only for `reason: "error"` — the isolated failure's message,
	 * so the caller can log it (this layer never logs).
	 */
	message?: string;
}

export interface ReconcileCreatedOrgMembership {
	organizationId: string;
	memberId: string;
	/** Resolved role actually written (newest invite's `role ?? "member"`). */
	role: string;
	/** All consumed invitation rows for this org. */
	invitationIds: string[];
}

export interface ReconcileCreatedProjectMembership {
	projectId: string;
	memberId: string;
	role: ProjectMemberRole;
	invitationId: string;
}

/**
 * Anomaly surfaced to the caller for logging — never blocks a grant.
 * Currently only emitted for an org invitation carrying a non-null
 * `teamId`: the teams feature is not enabled in this app, so the value is
 * unexpected; the membership is still created org-scoped.
 */
export interface ReconcileInviteWarning {
	type: "organization";
	invitationId: string;
	organizationId: string;
	code: "team_id_present";
	teamId: string;
}

export interface ReconcilePendingInvitesResult {
	orgInvitesFound: number;
	orgMembershipsCreated: number;
	projectInvitesFound: number;
	projectMembershipsCreated: number;
	createdOrgMemberships: ReconcileCreatedOrgMembership[];
	createdProjectMemberships: ReconcileCreatedProjectMembership[];
	skipped: ReconcileSkippedInvite[];
	/** Non-blocking anomalies for the caller to log at `warn`. */
	warnings: ReconcileInviteWarning[];
}

interface PendingOrgInviteRow {
	id: string;
	organizationId: string;
	role: string | null;
	teamId: string | null;
	expiresAt: Date;
	createdAt: Date;
}

interface PendingProjectInviteRow {
	id: string;
	projectId: string;
	role: ProjectMemberRole;
	invitedBy: string;
	expiresAt: Date;
}

function isUniqueConstraintViolation(error: unknown): boolean {
	return (
		error instanceof Prisma.PrismaClientKnownRequestError &&
		error.code === "P2002"
	);
}

/**
 * Internal transaction sentinel: thrown after a membership create when the
 * conditional consume matches zero rows — i.e. every invite in the group was
 * moved off `pending` (revoked / canceled / rejected) AFTER the initial bulk
 * read but before this transaction committed. Throwing rolls the just-created
 * membership back so a withdrawn invitation is never honored. Caught locally
 * and never propagated.
 */
class NoLiveInviteError extends Error {}

type OrgGroupOutcome =
	| { kind: "created"; grant: ReconcileCreatedOrgMembership }
	| { kind: "already_member" }
	| { kind: "no_live_invite" };

type ProjectInviteOutcome =
	| { kind: "created"; grant: ReconcileCreatedProjectMembership }
	| { kind: "already_member" }
	| { kind: "no_live_invite" };

/**
 * Flip still-pending org invitation rows to `accepted` (the model has no
 * `acceptedAt` column). Conditional on `status: "pending"` so the
 * transition is race-safe: a 0-count update means another runner — a
 * concurrent reconciliation, or the user clicking Accept on the invitation
 * page in the same instant — consumed the row first, which is benign.
 *
 * The inverse ms-scale race (a manual Accept click landing right after we
 * consume here) is accepted by design: Better Auth's accept endpoint is
 * deliberately not patched, and the user's retry/refresh lands on the
 * invitation page's `accepted` terminal state.
 */
async function consumeOrgInvitations(
	client: Prisma.TransactionClient,
	invitationIds: string[],
): Promise<number> {
	const { count } = await client.invitation.updateMany({
		where: { id: { in: invitationIds }, status: "pending" },
		data: { status: "accepted" },
	});
	return count;
}

/**
 * Consume a project invitation exactly like the manual accept path does:
 * `ACCEPTED` + `respondedAt`, conditional on the row still being PENDING
 * (0-count = another runner consumed it — benign).
 */
async function consumeProjectInvitation(
	client: Prisma.TransactionClient,
	invitationId: string,
): Promise<number> {
	const { count } = await client.projectInvitation.updateMany({
		where: { id: invitationId, status: "PENDING" },
		data: { status: "ACCEPTED", respondedAt: new Date() },
	});
	return count;
}

/**
 * Resolve one organization's group of qualifying pending invites
 * (newest `createdAt` first — the newest row's role wins; all rows are
 * consumed). Returns the grant, or `null` when the user was already a
 * member (including the P2002 concurrent-create case) — the caller
 * records `already_member` skips for the group.
 */
async function resolveOrgGroup(params: {
	userId: string;
	organizationId: string;
	invites: PendingOrgInviteRow[];
}): Promise<OrgGroupOutcome> {
	const { userId, organizationId, invites } = params;
	// Newest invite's role wins; the column is nullable and Better Auth's
	// default invite role is "member".
	const role = invites[0]?.role ?? "member";
	const invitationIds = invites.map((invite) => invite.id);

	try {
		const created = await db.$transaction(async (tx) => {
			const existing = await tx.member.findUnique({
				where: {
					organizationId_userId: { organizationId, userId },
				},
			});
			if (existing) {
				// Already a member: consume the invites, never touch the
				// existing role.
				await consumeOrgInvitations(tx, invitationIds);
				return null;
			}
			const member = await tx.member.create({
				data: {
					organizationId,
					userId,
					role,
					// REQUIRED: the Better Auth-managed model has no Prisma
					// default on createdAt — direct creates must set it.
					createdAt: new Date(),
				},
			});
			// Gate the grant on the consume: if not a single invite in this
			// group is still pending, every one was revoked/canceled/rejected
			// between the bulk read and now — roll the membership back rather
			// than honor a withdrawn invitation.
			const consumed = await consumeOrgInvitations(tx, invitationIds);
			if (consumed === 0) {
				throw new NoLiveInviteError();
			}
			return member;
		});

		if (!created) {
			return { kind: "already_member" };
		}
		return {
			kind: "created",
			grant: {
				organizationId,
				memberId: created.id,
				role,
				invitationIds,
			},
		};
	} catch (error) {
		if (error instanceof NoLiveInviteError) {
			return { kind: "no_live_invite" };
		}
		if (isUniqueConstraintViolation(error)) {
			// A concurrent runner (parallel trigger or an invite-link accept)
			// won the membership create and rolled our transaction back.
			// Treat as already-member: consume outside the transaction.
			await consumeOrgInvitations(db, invitationIds);
			return { kind: "already_member" };
		}
		throw error;
	}
}

/**
 * Resolve a single qualifying pending project invite. Returns the grant,
 * or `null` when the user was already a project member (including the
 * P2002 concurrent-create case). Never touches org membership — project
 * invites are guest-scoped by design.
 */
async function resolveProjectInvite(params: {
	userId: string;
	invite: PendingProjectInviteRow;
}): Promise<ProjectInviteOutcome> {
	const { userId, invite } = params;

	try {
		const created = await db.$transaction(async (tx) => {
			const existing = await tx.projectMember.findUnique({
				where: {
					projectId_userId: { projectId: invite.projectId, userId },
				},
			});
			if (existing) {
				await consumeProjectInvitation(tx, invite.id);
				return null;
			}
			const member = await tx.projectMember.create({
				data: {
					projectId: invite.projectId,
					userId,
					role: invite.role,
					invitedBy: invite.invitedBy,
					// REQUIRED: a null acceptedAt makes the membership
					// invisible to every read path (listProjects,
					// getProjectMembers, guest checks).
					acceptedAt: new Date(),
				},
			});

			await applyGlobalDefaultFunctionTags(tx, {
				projectId: invite.projectId,
				userId,
			});
			// Gate the grant on the consume: a 0-count means the invite was
			// revoked (project revoke = row delete) or otherwise left PENDING
			// after the bulk read — roll the membership back.
			const consumed = await consumeProjectInvitation(tx, invite.id);
			if (consumed === 0) {
				throw new NoLiveInviteError();
			}
			return member;
		});

		if (!created) {
			return { kind: "already_member" };
		}
		return {
			kind: "created",
			grant: {
				projectId: invite.projectId,
				memberId: created.id,
				role: created.role,
				invitationId: invite.id,
			},
		};
	} catch (error) {
		if (error instanceof NoLiveInviteError) {
			return { kind: "no_live_invite" };
		}
		if (isUniqueConstraintViolation(error)) {
			await consumeProjectInvitation(db, invite.id);
			return { kind: "already_member" };
		}
		throw error;
	}
}

/**
 * Resolve every qualifying pending org and project invitation for the
 * given email into memberships for `userId`, consuming the invite rows.
 *
 * The caller is responsible for any gating (e.g. only running for users
 * with a verified email) — this function trusts its inputs and only
 * matches by email. Org and project invites reconcile independently; both
 * for the same email is valid. Errors resolving one org group / project
 * row are isolated (skip reason `"error"`) and never abort the rest of
 * the run.
 */
export async function reconcilePendingInvitesForUser(params: {
	userId: string;
	email: string;
}): Promise<ReconcilePendingInvitesResult> {
	const { userId } = params;
	const normalizedEmail = params.email.trim().toLowerCase();

	const result: ReconcilePendingInvitesResult = {
		orgInvitesFound: 0,
		orgMembershipsCreated: 0,
		projectInvitesFound: 0,
		projectMembershipsCreated: 0,
		createdOrgMemberships: [],
		createdProjectMemberships: [],
		skipped: [],
		warnings: [],
	};

	if (!normalizedEmail) {
		return result;
	}

	const now = new Date();

	// ---- Organization invitations ----
	// Stored emails are already lowercased at every write site; the
	// insensitive mode is robustness against legacy mixed-case rows.
	const orgInvites = await db.invitation.findMany({
		where: {
			email: { equals: normalizedEmail, mode: "insensitive" },
			status: "pending",
		},
		orderBy: { createdAt: "desc" },
		select: {
			id: true,
			organizationId: true,
			role: true,
			teamId: true,
			expiresAt: true,
			createdAt: true,
		},
	});
	result.orgInvitesFound = orgInvites.length;

	// Group qualifying rows per organization (multiple pending rows for
	// the same org+email are possible — the table has no unique
	// constraint). The query ordering keeps each group newest-first,
	// which decides the role.
	const qualifyingByOrg = new Map<string, PendingOrgInviteRow[]>();
	for (const invite of orgInvites) {
		if (invite.expiresAt <= now) {
			// Read-only skip: pending-but-expired rows keep their pending
			// status (re-invite flows revive pending rows in place).
			result.skipped.push({
				type: "organization",
				invitationId: invite.id,
				reason: "expired",
			});
			continue;
		}
		if (invite.teamId !== null) {
			// Teams are not enabled in this app — surface the anomaly for
			// the caller to log, but never block the grant (the membership
			// is created org-scoped).
			result.warnings.push({
				type: "organization",
				invitationId: invite.id,
				organizationId: invite.organizationId,
				code: "team_id_present",
				teamId: invite.teamId,
			});
		}
		const group = qualifyingByOrg.get(invite.organizationId);
		if (group) {
			group.push(invite);
		} else {
			qualifyingByOrg.set(invite.organizationId, [invite]);
		}
	}

	for (const [organizationId, invites] of qualifyingByOrg) {
		try {
			const outcome = await resolveOrgGroup({
				userId,
				organizationId,
				invites,
			});
			if (outcome.kind === "created") {
				result.createdOrgMemberships.push(outcome.grant);
				result.orgMembershipsCreated += 1;
			} else {
				// "no_live_invite" → every invite in the group was withdrawn
				// (canceled/rejected) concurrently; "already_member" → the
				// user already belonged. Either way nothing was granted.
				const reason: InviteSkipReason =
					outcome.kind === "no_live_invite"
						? "canceled"
						: "already_member";
				for (const invite of invites) {
					result.skipped.push({
						type: "organization",
						invitationId: invite.id,
						reason,
					});
				}
			}
		} catch (error) {
			// Per-group isolation: one failing org must not abort the rest
			// of the run.
			for (const invite of invites) {
				result.skipped.push({
					type: "organization",
					invitationId: invite.id,
					reason: "error",
					message:
						error instanceof Error ? error.message : String(error),
				});
			}
		}
	}

	// ---- Project invitations ----
	const projectInvites = await db.projectInvitation.findMany({
		where: {
			email: { equals: normalizedEmail, mode: "insensitive" },
			status: "PENDING",
		},
		select: {
			id: true,
			projectId: true,
			role: true,
			invitedBy: true,
			expiresAt: true,
		},
	});
	result.projectInvitesFound = projectInvites.length;

	for (const invite of projectInvites) {
		if (invite.expiresAt <= now) {
			result.skipped.push({
				type: "project",
				invitationId: invite.id,
				reason: "expired",
			});
			continue;
		}
		try {
			const outcome = await resolveProjectInvite({ userId, invite });
			if (outcome.kind === "created") {
				result.createdProjectMemberships.push(outcome.grant);
				result.projectMembershipsCreated += 1;
			} else {
				// "no_live_invite" → the invite was revoked (deleted)
				// concurrently; "already_member" → already a project member.
				const reason: InviteSkipReason =
					outcome.kind === "no_live_invite"
						? "canceled"
						: "already_member";
				result.skipped.push({
					type: "project",
					invitationId: invite.id,
					reason,
				});
			}
		} catch (error) {
			// Per-row isolation mirrors the org-group handling above.
			result.skipped.push({
				type: "project",
				invitationId: invite.id,
				reason: "error",
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}

	return result;
}
