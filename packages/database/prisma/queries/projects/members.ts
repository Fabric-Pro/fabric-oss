/**
 * Database queries for Project Members (collaboration).
 *
 * Handles project invitations and member management. External guests are
 * supported: users from another Fabric organization and users with no
 * Fabric account may both be invited. Authorization is enforced by the
 * calling procedure's permission middleware (PROJECT_MEMBERS_MANAGE), and
 * accept/decline helpers additionally verify that the invitation email
 * matches the authenticated user's email.
 */

import { logger } from "@repo/logs";
import { db, Prisma, type ProjectMemberRole } from "../../client";
// Both of these import back from this module (`function-tags.ts` and
// `newsletter.ts` each pull in `getProjectMembers`), so both edges are import
// cycles. The function-tags one predates this file's current shape and ships
// today; the newsletter one was added alongside enrol-on-join.
//
// They are safe because no cyclic binding is touched during module evaluation
// — every use is inside an async function body, by which point both modules
// are fully initialized and ESM's live bindings resolve. Breaking them would
// mean extracting `getProjectMembers` into a third module, which is a
// repo-wide change to a shared query surface rather than anything local to a
// caller. Do that deliberately if it is ever wanted, not as a side effect.
import { applyGlobalDefaultFunctionTags } from "./function-tags";
import { enrollProjectMemberIfNewsletterEnabled } from "./newsletter";

/**
 * Invite a user to collaborate on a project.
 *
 * Idempotent on the `@@unique([projectId, email])` constraint: if an
 * invitation row already exists for that pair — in ANY status (a prior
 * ACCEPTED / DECLINED / EXPIRED invite, or an expired PENDING one) — it is
 * revived back into a fresh PENDING invitation instead of colliding with the
 * constraint. Without this, re-inviting anyone who was ever invited before
 * throws a P2002 error that surfaces to the caller as an unhandled 500.
 *
 * Returns the created or revived invitation.
 */
export async function createProjectInvitation(data: {
	projectId: string;
	email: string;
	role: ProjectMemberRole;
	invitedBy: string;
	message?: string;
	expiresInDays?: number;
}) {
	const expiresAt = new Date();
	expiresAt.setDate(expiresAt.getDate() + (data.expiresInDays ?? 7));
	const normalizedEmail = data.email.trim().toLowerCase();

	const where = {
		projectId_email: {
			projectId: data.projectId,
			email: normalizedEmail,
		},
	};
	// Fields applied when reviving an existing row. `message` is overwritten
	// (not merged): re-inviting with no message clears any stale message.
	const revivedFields = {
		role: data.role,
		invitedBy: data.invitedBy,
		message: data.message ?? null,
		expiresAt,
		status: "PENDING" as const,
		respondedAt: null,
	};

	try {
		return await db.projectInvitation.upsert({
			where,
			create: {
				projectId: data.projectId,
				email: normalizedEmail,
				role: data.role,
				invitedBy: data.invitedBy,
				message: data.message,
				expiresAt,
				status: "PENDING",
			},
			update: revivedFields,
		});
	} catch (error: any) {
		// A concurrent invite for the same (projectId, email) raced us: both
		// requests took the upsert's `create` branch and one lost the unique
		// constraint. The row exists now — revive it with a plain update.
		if (error?.code === "P2002") {
			return await db.projectInvitation.update({
				where,
				data: revivedFields,
			});
		}
		throw error;
	}
}

/**
 * Whether the given email has a still-valid PENDING project invitation.
 *
 * Used by the invitation-only signup gate (packages/auth) so that a user
 * invited ONLY to a project (no org-level invitation) can still create an
 * account when global signup is disabled. Mirrors the org-level
 * `getPendingInvitationByEmail`. Emails are stored normalized (lowercased)
 * by `createProjectInvitation`, so an exact match is sufficient.
 */
export async function getPendingProjectInvitationByEmail(email: string) {
	const normalized = email.trim().toLowerCase();
	return db.projectInvitation.findFirst({
		where: {
			email: normalized,
			status: "PENDING",
			expiresAt: { gt: new Date() },
		},
	});
}

/**
 * Get pending invitations for a project
 */
export async function getProjectInvitations(projectId: string) {
	return await db.projectInvitation.findMany({
		where: {
			projectId,
			status: "PENDING",
			expiresAt: { gt: new Date() },
		},
		orderBy: { createdAt: "desc" },
	});
}

/**
 * Get pending invitations for a user's email, filtered by tenant context.
 *
 * Uses XOR pattern for proper tenant isolation:
 * - organizationId provided: only invitations for that org's projects
 * - organizationId undefined/null: only invitations for personal projects
 */
export async function getUserPendingInvitations(
	email: string,
	organizationId?: string | null,
) {
	// XOR pattern: filter by org context or personal context
	const tenantFilter = organizationId
		? { organizationId }
		: { organizationId: null };

	return await db.projectInvitation.findMany({
		where: {
			email,
			status: "PENDING",
			expiresAt: { gt: new Date() },
			project: tenantFilter,
		},
		include: {
			project: {
				select: {
					id: true,
					name: true,
					description: true,
					userId: true,
					organizationId: true,
					user: {
						select: {
							name: true,
							image: true,
						},
					},
				},
			},
		},
		orderBy: { createdAt: "desc" },
	});
}

/**
 * Fetch a project invitation by ID with only the fields needed to render the
 * public acceptance page. Intentionally bypasses tenant filtering — the caller
 * may be unauthenticated or a cross-org user.
 *
 * SECURITY: does NOT return the invitee's email. Callers that need the email
 * for state decisions (authenticated email vs invitation email) must use
 * `getProjectInvitationByIdWithEmail` in a trusted server-side context.
 */
export async function getProjectInvitationById(invitationId: string) {
	return await db.projectInvitation.findUnique({
		where: { id: invitationId },
		select: {
			id: true,
			role: true,
			message: true,
			status: true,
			expiresAt: true,
			createdAt: true,
			project: {
				select: {
					id: true,
					name: true,
					description: true,
					organizationId: true,
					organization: { select: { slug: true, name: true } },
				},
			},
			invitedBy: true,
		},
	});
}

/**
 * Internal variant of `getProjectInvitationById` that also returns the invitee
 * email. Only use from server components that need to compare the authenticated
 * user's email against the invited email (e.g. the acceptance page's state
 * resolver). Never return the email to a client payload.
 */
export async function getProjectInvitationWithEmail(invitationId: string) {
	return await db.projectInvitation.findUnique({
		where: { id: invitationId },
		select: {
			id: true,
			email: true,
			role: true,
			status: true,
			expiresAt: true,
			project: {
				select: {
					id: true,
					name: true,
					organizationId: true,
					organization: { select: { slug: true } },
				},
			},
		},
	});
}

/**
 * Race-safe consumption of a PENDING project invitation: a conditional
 * update that only flips PENDING → ACCEPTED. A 0-count result means another
 * runner — signup/sign-in invite reconciliation, or a parallel accept —
 * consumed the row first; that is not an error.
 */
async function consumePendingProjectInvitation(
	client: Pick<Prisma.TransactionClient, "projectInvitation">,
	invitationId: string,
) {
	await client.projectInvitation.updateMany({
		where: { id: invitationId, status: "PENDING" },
		data: {
			status: "ACCEPTED",
			respondedAt: new Date(),
		},
	});
}

/**
 * Accept a project invitation, then enrol the project's members into its
 * newsletter if one is enabled (Fizzy #2290).
 *
 * The enrolment runs on EVERY path that yields a membership — the genuine
 * create, both idempotent already-a-member returns, and the P2002 recovery
 * branch — not only on the create. Two runners can both see no member; one
 * commits and the other lands in P2002. If only the winner enrolled and it
 * then died, nobody would write the subscriber row, and the member would stay
 * missing from the settings recipient list until the next send. Enrolment is
 * idempotent, so the redundant attempts cost a couple of indexed reads.
 *
 * It runs AFTER the transaction commits, and best-effort. A membership is the
 * user's access to the project; a newsletter outage must not be able to take
 * it away. Placing the call inside the transaction would not help either — in
 * PostgreSQL a failed statement aborts the enclosing transaction whatever the
 * surrounding try/catch does.
 *
 * Residual, accepted: if this process exits between the commit and the
 * enrolment call, no subscriber row is written until the next send. That is
 * the pre-#2290 state — the member still receives the newsletter, because the
 * send activity reconciles members before every send; only the settings list
 * is briefly stale, and it self-heals on the next send.
 */
export async function acceptProjectInvitation(
	invitationId: string,
	userId: string,
	userEmail: string,
) {
	const member = await acceptProjectInvitationCore(
		invitationId,
		userId,
		userEmail,
	);

	try {
		await enrollProjectMemberIfNewsletterEnabled({
			projectId: member.projectId,
			email: userEmail,
		});
	} catch (error) {
		logger.error("newsletter: member enrolment on project join failed", {
			projectId: member.projectId,
			userId,
			error,
		});
	}

	return member;
}

/**
 * Accept a project invitation.
 *
 * SECURITY: requires `userEmail` (the authenticated user's verified email).
 * The invitation is only matched if its email equals `userEmail` — this
 * prevents anyone who learns an `invitationId` from accepting invitations
 * that were not issued to them.
 *
 * Idempotent: signup/sign-in invite reconciliation (or a parallel tab) may
 * have already created the membership and/or consumed this invitation while
 * the invite-link flow was mid-way through. Those interleavings resolve with
 * the existing member instead of throwing, so the flows never surface an
 * error to a user who already holds the access this invitation grants.
 * A PENDING-but-expired invitation with an existing membership also resolves
 * with the member, but the row is left untouched — pending-but-expired rows
 * are READ-ONLY everywhere (the reconciliation invariant: re-invite flows
 * revive pending rows in place, so they must never be flipped to a terminal
 * status). Genuinely invalid invitations — wrong email, unknown id, expired
 * with no membership, declined, or accepted with no surviving membership —
 * keep the original error behavior (same message).
 */
async function acceptProjectInvitationCore(
	invitationId: string,
	userId: string,
	userEmail: string,
) {
	const normalizedEmail = userEmail.trim().toLowerCase();

	// Email match is always enforced first, regardless of status: the
	// invitation must have been issued to the authenticated user's email.
	const invitation = await db.projectInvitation.findFirst({
		where: {
			id: invitationId,
			email: normalizedEmail,
		},
	});

	if (!invitation) {
		throw new Error(
			"Invitation not found, expired, or issued to a different email",
		);
	}

	const existingMember = await db.projectMember.findUnique({
		where: {
			projectId_userId: {
				projectId: invitation.projectId,
				userId,
			},
		},
	});

	if (existingMember) {
		// Idempotent success paths: the membership already exists (created
		// by invite reconciliation at signup/sign-in, or by a parallel tab).
		if (invitation.status === "ACCEPTED") {
			return existingMember;
		}
		if (invitation.status === "PENDING") {
			// Membership exists but the invitation was never consumed (e.g.
			// a crash window between member creation and invite consumption,
			// or a concurrent runner that has not committed yet). Only a
			// LIVE pending row is consumed: pending-but-expired rows are
			// READ-ONLY everywhere (the reconciliation invariant — re-invite
			// flows revive pending rows in place), so an expired row is left
			// untouched while the user keeps the access they already hold.
			if (invitation.expiresAt.getTime() > Date.now()) {
				await consumePendingProjectInvitation(db, invitationId);
			}
			return existingMember;
		}
	}

	// Genuinely invalid — unchanged error behavior. Covers DECLINED,
	// EXPIRED, pending-but-expired, and ACCEPTED with no surviving
	// membership (e.g. accepted then removed from the project — requires
	// a re-invite).
	if (
		invitation.status !== "PENDING" ||
		invitation.expiresAt.getTime() <= Date.now()
	) {
		throw new Error(
			"Invitation not found, expired, or issued to a different email",
		);
	}

	// Happy path: create the member and consume the invitation atomically.
	// The member create runs FIRST so this transaction takes its locks in
	// the same order as invite reconciliation (member insert, then invite
	// row) — opposite ordering between the two concurrent writers could
	// deadlock. Statement order does not change the committed outcome.
	try {
		return await db.$transaction(async (tx) => {
			const member = await tx.projectMember.create({
				data: {
					projectId: invitation.projectId,
					userId,
					role: invitation.role,
					invitedBy: invitation.invitedBy,
					acceptedAt: new Date(),
				},
			});

			await applyGlobalDefaultFunctionTags(tx, {
				projectId: invitation.projectId,
				userId,
			});

			await consumePendingProjectInvitation(tx, invitationId);

			return member;
		});
	} catch (error) {
		// A concurrent runner (invite reconciliation, or a parallel accept)
		// created the membership between our existence check and the create.
		// Treat it as success: re-read the member, make sure the invitation
		// is consumed, and return the existing membership.
		if (
			error instanceof Prisma.PrismaClientKnownRequestError &&
			error.code === "P2002"
		) {
			const member = await db.projectMember.findUnique({
				where: {
					projectId_userId: {
						projectId: invitation.projectId,
						userId,
					},
				},
			});
			if (member) {
				await consumePendingProjectInvitation(db, invitationId);
				return member;
			}
		}
		throw error;
	}
}

/**
 * Decline a project invitation.
 *
 * SECURITY: requires `userEmail` (the authenticated user's verified email).
 * Only matches if the invitation email equals `userEmail` — prevents anyone
 * who learns an `invitationId` from declining invitations they were not sent.
 */
export async function declineProjectInvitation(
	invitationId: string,
	userEmail: string,
) {
	const normalizedEmail = userEmail.trim().toLowerCase();
	const result = await db.projectInvitation.updateMany({
		where: {
			id: invitationId,
			email: normalizedEmail,
			status: "PENDING",
		},
		data: {
			status: "DECLINED",
			respondedAt: new Date(),
		},
	});
	if (result.count === 0) {
		throw new Error(
			"Invitation not found, expired, or issued to a different email",
		);
	}
	return result;
}

/**
 * Remove a project member
 */
export async function removeProjectMember(projectId: string, userId: string) {
	return await db.projectMember.delete({
		where: {
			projectId_userId: {
				projectId,
				userId,
			},
		},
	});
}

/**
 * Update a member's role
 */
export async function updateProjectMemberRole(
	projectId: string,
	userId: string,
	role: ProjectMemberRole,
) {
	return await db.projectMember.update({
		where: {
			projectId_userId: {
				projectId,
				userId,
			},
		},
		data: { role },
	});
}

/**
 * Get project members
 */
export async function getProjectMembers(projectId: string) {
	// Two queries instead of four: first fetch the project + creator +
	// nested ProjectMember rows in a single round-trip, then resolve the
	// member users in a second query. (`ProjectMember` has no user relation
	// in the schema — just a scalar `userId` — so Prisma can't include the
	// users inline.)
	const project = await db.project.findUnique({
		where: { id: projectId },
		select: {
			userId: true,
			organizationId: true,
			user: {
				select: {
					id: true,
					name: true,
					email: true,
					image: true,
				},
			},
			members: {
				where: {
					acceptedAt: { not: null },
					OR: [
						{ expiresAt: null },
						{ expiresAt: { gt: new Date() } },
					],
				},
				select: {
					userId: true,
					role: true,
					invitedAt: true,
					acceptedAt: true,
					expiresAt: true,
				},
			},
		},
	});

	const members = project?.members ?? [];
	const memberUserIds = members.map((m) => m.userId);
	const users =
		memberUserIds.length > 0
			? await db.user.findMany({
					where: { id: { in: memberUserIds } },
					select: { id: true, name: true, email: true, image: true },
				})
			: [];
	const userMap = new Map(users.map((u) => [u.id, u]));

	// Determine which members are guests — a guest is a member with no
	// OrganizationMember row in the project's host org. Personal projects
	// (no organizationId) have no guest concept. This third query is
	// unavoidable because Fabric stores org membership in a separate table
	// (Better Auth `member`) that ProjectMember doesn't relate to.
	const guestUserIds = new Set<string>();
	if (project?.organizationId && memberUserIds.length > 0) {
		const orgMemberships = await db.member.findMany({
			where: {
				organizationId: project.organizationId,
				userId: { in: memberUserIds },
			},
			select: { userId: true },
		});
		const orgMemberUserIds = new Set(orgMemberships.map((m) => m.userId));
		for (const id of memberUserIds) {
			if (!orgMemberUserIds.has(id)) {
				guestUserIds.add(id);
			}
		}
	}

	// Combine owner and members
	const result: Array<{
		userId: string;
		role: string;
		user: {
			id: string;
			name: string | null;
			email: string;
			image: string | null;
		};
		isOwner: boolean;
		isCreator: boolean;
		isGuest: boolean;
		invitedAt: Date | null;
		acceptedAt: Date | null;
		expiresAt: Date | null;
	}> = [];

	// Add project creator first — never a guest (they own it).
	if (project?.user) {
		result.push({
			userId: project.userId,
			role: "OWNER",
			user: project.user,
			isOwner: true,
			isCreator: true,
			isGuest: false,
			invitedAt: null,
			acceptedAt: null,
			expiresAt: null,
		});
	}

	// Add members
	for (const member of members) {
		const user = userMap.get(member.userId);
		if (user) {
			result.push({
				userId: member.userId,
				role: member.role,
				user,
				isOwner: member.role === "OWNER",
				isCreator: false,
				isGuest: guestUserIds.has(member.userId),
				invitedAt: member.invitedAt,
				acceptedAt: member.acceptedAt,
				expiresAt: member.expiresAt,
			});
		}
	}

	return result;
}

/**
 * Check if a user can be invited to a project as a guest.
 *
 * External guest invites are allowed:
 *  - Users from another Fabric organization CAN be invited.
 *  - Users without any Fabric account CAN be invited (account will be created
 *    via magic link at acceptance time).
 *
 * Remaining restrictions:
 *  - The inviter must be the project owner OR hold PROJECT_MEMBERS_MANAGE
 *    (enforced by the permission middleware on the calling procedure — this
 *    function does not duplicate that check).
 *  - Cannot invite a user who is already an accepted project member.
 *  - Cannot invite a user who already has a pending invitation.
 *  - Cannot invite the project creator (the permanent owner).
 */
export async function canInviteUser(
	projectId: string,
	_inviterUserId: string,
	inviteeEmail: string,
): Promise<{ canInvite: boolean; reason?: string }> {
	const normalizedEmail = inviteeEmail.trim().toLowerCase();

	// Get project details
	const project = await db.project.findUnique({
		where: { id: projectId },
		select: {
			userId: true,
			organizationId: true,
		},
	});

	if (!project) {
		return { canInvite: false, reason: "Project not found" };
	}

	// NB: Inviter permission is enforced by the permission middleware on the
	// calling procedure (`PROJECT_MEMBERS_MANAGE`). This function intentionally
	// does NOT duplicate that check so that any role granting the permission
	// (project owner, project admin, org admin, org owner) can invite.

	// Get the invitee user
	const invitee = await db.user.findUnique({
		where: { email: normalizedEmail },
		select: { id: true },
	});

	if (!invitee) {
		// External invite — the user doesn't have a Fabric account yet. They
		// will be prompted to create one via magic link at acceptance time.
		return { canInvite: true };
	}

	// The project creator is the permanent owner and must not be demoted into a
	// ProjectMember row via a self-invite.
	if (invitee.id === project.userId) {
		return { canInvite: false, reason: "Cannot invite the project owner" };
	}

	// Check if already a member
	const existingMember = await db.projectMember.findFirst({
		where: {
			projectId,
			userId: invitee.id,
		},
	});

	if (existingMember) {
		return { canInvite: false, reason: "User is already a project member" };
	}

	// Check if already invited
	const existingInvitation = await db.projectInvitation.findFirst({
		where: {
			projectId,
			email: normalizedEmail,
			status: "PENDING",
			expiresAt: { gt: new Date() },
		},
	});

	if (existingInvitation) {
		return {
			canInvite: false,
			reason: "User already has a pending invitation",
		};
	}

	// Cross-org and personal-to-org invites are allowed. The invitee will get
	// project-scoped access only — they will not become a full org member.
	return { canInvite: true };
}

/**
 * Shape returned for the dashboard "New Project" welcome widget.
 * The client decides headline/visual fallbacks from these raw fields.
 */
type WelcomeWidgetCommon = {
	projectId: string;
	projectName: string;
	projectDescription: string | null;
	heroImageUrl: string | null;
	heroEmojis: string[];
	icon: string | null;
	color: string | null;
	organizationId: string | null;
	organizationSlug: string | null;
	inviter: { name: string; image: string | null; banned: boolean } | null;
	role: ProjectMemberRole;
};

/** A pending invite the user can accept, or a project they were recently added to. */
export type WelcomeWidgetEntry =
	| (WelcomeWidgetCommon & {
			kind: "invite";
			invitationId: string;
			expiresAt: Date;
	  })
	| (WelcomeWidgetCommon & { kind: "member"; acceptedAt: Date });

/** How long after joining a project the "you were added" widget keeps showing. */
const RECENT_MEMBER_WINDOW_MS = 48 * 60 * 60 * 1000;

/**
 * Project filter for a widget read.
 * - Org context: strict XOR to that org.
 * - Personal context (the guest's home): personal projects PLUS guest
 *   memberships — projects in orgs the user is NOT a member of. Surfacing the
 *   caller's own email/userId-addressed rows is not a tenant leak. `notIn: []`
 *   is unsafe in Prisma, so a zero-org guest gets an unconstrained `{}`.
 */
async function buildWidgetProjectScope(
	userId: string,
	organizationId?: string | null,
): Promise<Prisma.ProjectWhereInput> {
	if (organizationId) {
		return { organizationId };
	}
	const memberships = await db.member.findMany({
		where: { userId },
		select: { organizationId: true },
	});
	const userOrgIds = memberships.map((m) => m.organizationId);
	if (userOrgIds.length === 0) {
		return {};
	}
	return {
		OR: [
			{ organizationId: null },
			{ organizationId: { notIn: userOrgIds } },
		],
	};
}

/**
 * The single most-relevant widget entry for `email`/`userId` in the given tenant
 * scope, plus the total count of in-scope, non-dismissed entries. Two sources:
 *
 *  1. PENDING `ProjectInvitation` rows the user can accept ("invite" kind).
 *  2. Recently-accepted `ProjectMember` rows on projects the user does NOT own
 *     ("member" kind) — covers auto-accepted invites. A membership only counts
 *     while its `acceptedAt` is within `RECENT_MEMBER_WINDOW_MS`.
 *
 * - Tenant scope via `buildWidgetProjectScope`: strict XOR in org context, but
 *   in personal context it ALSO surfaces guest memberships/invites (projects in
 *   orgs the user is not a member of) — a user seeing their own row is not a
 *   tenant leak.
 * - Dismissal is a watermark per (project, user). Invites compare
 *   `expiresAt` > `inviteWidgetDismissedInviteExpiry`; memberships compare
 *   `acceptedAt` > `inviteWidgetDismissedAt`. A re-invite/re-add bumps the
 *   timestamp past the watermark, so the widget re-surfaces.
 * - Dedup: an invite and a membership for the same project collapse to the
 *   invite (the actionable one wins).
 * - Ranking: an actionable invite always outranks a passive membership. Within
 *   each source, most-recent first, with a total order ending in `project.id`
 *   for deterministic tie-breaks.
 * - The inviter (`invitedBy`) is a bare string (no FK), so it is fetched
 *   separately for the top entry only; a deleted inviter yields `inviter: null`.
 */
export async function getInviteWelcomeWidgetData(
	email: string,
	userId: string,
	organizationId?: string | null,
): Promise<{ mostRecent: WelcomeWidgetEntry | null; totalCount: number }> {
	const normalizedEmail = email.trim().toLowerCase();
	const projectScope = await buildWidgetProjectScope(userId, organizationId);
	const now = new Date();

	const projectSelect = {
		id: true,
		name: true,
		description: true,
		heroImageUrl: true,
		heroEmojis: true,
		icon: true,
		color: true,
		organizationId: true,
		organization: { select: { slug: true } },
	} as const;

	const [inviteRows, memberRows] = await Promise.all([
		db.projectInvitation.findMany({
			where: {
				email: normalizedEmail,
				status: "PENDING",
				expiresAt: { gt: now },
				project: projectScope,
			},
			include: {
				project: {
					select: {
						...projectSelect,
						userPreferences: {
							where: { userId },
							select: { inviteWidgetDismissedInviteExpiry: true },
						},
					},
				},
			},
		}),
		db.projectMember.findMany({
			where: {
				userId,
				acceptedAt: {
					not: null,
					gt: new Date(now.getTime() - RECENT_MEMBER_WINDOW_MS),
				},
				OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
				project: { ...projectScope, userId: { not: userId } },
			},
			include: {
				project: {
					select: {
						...projectSelect,
						userPreferences: {
							where: { userId },
							select: { inviteWidgetDismissedAt: true },
						},
					},
				},
			},
		}),
	]);

	const common = (p: {
		id: string;
		name: string;
		description: string | null;
		heroImageUrl: string | null;
		heroEmojis: string[];
		icon: string | null;
		color: string | null;
		organizationId: string | null;
		organization: { slug: string | null } | null;
	}) => ({
		projectId: p.id,
		projectName: p.name,
		projectDescription: p.description,
		heroImageUrl: p.heroImageUrl,
		heroEmojis: p.heroEmojis,
		icon: p.icon,
		color: p.color,
		organizationId: p.organizationId,
		organizationSlug: p.organization?.slug ?? null,
	});

	const visibleInvites = inviteRows
		.filter((r) => {
			const wm =
				r.project.userPreferences[0]
					?.inviteWidgetDismissedInviteExpiry ?? null;
			return wm === null || r.expiresAt > wm;
		})
		.sort(
			(a, b) =>
				b.expiresAt.getTime() - a.expiresAt.getTime() ||
				b.createdAt.getTime() - a.createdAt.getTime() ||
				a.project.name.localeCompare(b.project.name) ||
				a.project.id.localeCompare(b.project.id),
		);

	const inviteProjectIds = new Set(visibleInvites.map((r) => r.project.id));
	const visibleMembers = memberRows
		.filter(
			(r) => r.acceptedAt !== null && !inviteProjectIds.has(r.project.id),
		)
		.filter((r) => {
			const wm =
				r.project.userPreferences[0]?.inviteWidgetDismissedAt ?? null;
			return wm === null || (r.acceptedAt as Date) > wm;
		})
		.sort(
			(a, b) =>
				(b.acceptedAt as Date).getTime() -
					(a.acceptedAt as Date).getTime() ||
				a.project.name.localeCompare(b.project.name) ||
				a.project.id.localeCompare(b.project.id),
		);

	const totalCount = visibleInvites.length + visibleMembers.length;

	const topInvite = visibleInvites[0];
	const topMember = visibleMembers[0];
	const topInvitedBy = topInvite?.invitedBy ?? topMember?.invitedBy ?? null;

	let inviter: WelcomeWidgetCommon["inviter"] = null;
	if (topInvitedBy) {
		const users = await db.user.findMany({
			where: { id: topInvitedBy },
			select: { id: true, name: true, image: true, banned: true },
		});
		const u = users[0];
		inviter = u
			? { name: u.name, image: u.image, banned: u.banned ?? false }
			: null;
	}

	let mostRecent: WelcomeWidgetEntry | null = null;
	if (topInvite) {
		mostRecent = {
			kind: "invite",
			...common(topInvite.project),
			inviter,
			role: topInvite.role,
			invitationId: topInvite.id,
			expiresAt: topInvite.expiresAt,
		};
	} else if (topMember) {
		mostRecent = {
			kind: "member",
			...common(topMember.project),
			inviter,
			role: topMember.role,
			acceptedAt: topMember.acceptedAt as Date,
		};
	}

	return { mostRecent, totalCount };
}

/**
 * The current user's in-scope PENDING invite for a single project, or null.
 * Authorization gate for the dismiss procedure — prevents writing a dismissal
 * preference for a project the user has no pending invite to.
 */
export async function getUserPendingInviteForProject(
	email: string,
	userId: string,
	projectId: string,
	organizationId?: string | null,
): Promise<{
	id: string;
	expiresAt: Date;
	projectOrganizationId: string | null;
} | null> {
	const normalizedEmail = email.trim().toLowerCase();
	const projectScope = await buildWidgetProjectScope(userId, organizationId);

	const invite = await db.projectInvitation.findFirst({
		where: {
			projectId,
			email: normalizedEmail,
			status: "PENDING",
			expiresAt: { gt: new Date() },
			project: projectScope,
		},
		select: {
			id: true,
			expiresAt: true,
			project: { select: { organizationId: true } },
		},
	});
	if (!invite) {
		return null;
	}
	return {
		id: invite.id,
		expiresAt: invite.expiresAt,
		projectOrganizationId: invite.project.organizationId,
	};
}

/**
 * The current user's in-scope recent membership for a single project, or null.
 * Authorization gate for the dismiss procedure when the widget entry is a
 * "member" kind (not a pending invite). Mirrors the recent-member source in
 * `getInviteWelcomeWidgetData`: the membership must be accepted within
 * `RECENT_MEMBER_WINDOW_MS`, still live, on a project the user does NOT own,
 * and in tenant scope. Returns the `acceptedAt` so the caller can decide
 * whether to also advance the invite watermark (it should NOT — member-only
 * dismissals omit the expiry; see `dismissInviteWelcomeWidget`).
 */
export async function getUserRecentMemberForProject(
	userId: string,
	projectId: string,
	organizationId?: string | null,
): Promise<{ acceptedAt: Date; projectOrganizationId: string | null } | null> {
	const projectScope = await buildWidgetProjectScope(userId, organizationId);
	const now = new Date();
	const member = await db.projectMember.findFirst({
		where: {
			projectId,
			userId,
			acceptedAt: {
				not: null,
				gt: new Date(now.getTime() - RECENT_MEMBER_WINDOW_MS),
			},
			OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
			project: { ...projectScope, userId: { not: userId } },
		},
		select: {
			acceptedAt: true,
			project: { select: { organizationId: true } },
		},
	});
	return member?.acceptedAt
		? {
				acceptedAt: member.acceptedAt,
				projectOrganizationId: member.project.organizationId,
			}
		: null;
}

/**
 * Persist the welcome-widget dismissal watermark for (project, user). The
 * organizationId is the project's real org (null for personal), keeping the
 * preference row's tenant scope aligned with the project.
 */
export async function dismissInviteWelcomeWidget(params: {
	projectId: string;
	userId: string;
	organizationId: string | null;
	/** Omit for member-only dismissals — never lower an existing invite watermark. */
	dismissedInviteExpiry?: Date | null;
}) {
	const { projectId, userId, organizationId, dismissedInviteExpiry } = params;
	const now = new Date();
	// A member-only dismissal (no expiry) must NOT touch the invite watermark:
	// a member's past `acceptedAt` could otherwise replace a higher invite
	// watermark and resurface a previously-dismissed live invite. Member hiding
	// keys off `inviteWidgetDismissedAt` alone.
	const expiryData =
		dismissedInviteExpiry !== undefined
			? { inviteWidgetDismissedInviteExpiry: dismissedInviteExpiry }
			: {};
	return db.projectUserPreference.upsert({
		where: { projectId_userId: { projectId, userId } },
		create: {
			projectId,
			userId,
			organizationId,
			inviteWidgetDismissedAt: now,
			...expiryData,
		},
		update: {
			// Realign tenant scope on existing rows (e.g. a kanban-pref row that
			// predates dismissal); matches the kanban upsert convention.
			organizationId,
			inviteWidgetDismissedAt: now,
			...expiryData,
		},
	});
}
