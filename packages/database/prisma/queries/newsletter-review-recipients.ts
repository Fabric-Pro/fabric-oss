/**
 * Who may approve a parked release-notes draft (Fizzy #2172).
 *
 * One resolver, two channels. The in-app notification and the reviewer email
 * both read from here so they cannot drift into notifying different people.
 *
 * ## The rule, and why it is duplicated
 *
 * `resolveEffectiveProjectPermissions` in `@repo/api` is the authority, and it
 * cannot be imported here: `@repo/api` depends on `@repo/database`, not the
 * other way round — the same workspace cycle that put the notification emitter
 * in this package. The precedence is therefore reproduced, and
 * `selectReviewRecipientIds` is pure so the cases that distinguish it are a
 * plain table test rather than a hope. If the authority changes, change both;
 * each side carries a comment pointing at the other.
 *
 *   A. personal-project owner → OWNER permissions
 *   C. an ACTIVE (accepted, unexpired) ProjectMember row is AUTHORITATIVE — its
 *      role decides and the org role is NOT consulted
 *   B. otherwise the caller's role on the host organization decides
 *
 * The half that is easy to lose is C's negative side. "Active" is doing real
 * work: an unaccepted or expired row is *not* active, so it is not
 * authoritative either, and such a user still reaches B. An org admin whose
 * project invitation lapsed can still approve, and must still be told.
 */

import {
	Permissions,
	resolveOrgPermissions,
	resolveProjectPermissions,
} from "@repo/permissions";
import { db } from "../client";

export interface ReviewProjectMemberRow {
	userId: string;
	role: string;
	acceptedAt: Date | null;
	expiresAt: Date | null;
}

export interface ReviewOrgMemberRow {
	userId: string;
	role: string;
}

export interface ReviewRecipient {
	userId: string;
	email: string | null;
	/** EMAIL-channel opt-out. The in-app channel ignores this. */
	reviewEmails: boolean;
}

export interface ReviewRecipientContext {
	sendId: string;
	projectId: string;
	projectName: string;
	organizationId: string | null;
	organizationSlug: string | null;
	recipients: ReviewRecipient[];
}

function canEditProjectSettings(permissions: readonly string[]): boolean {
	return permissions.includes(Permissions.PROJECT_SETTINGS_EDIT);
}

function isActive(member: ReviewProjectMemberRow, now: Date): boolean {
	return (
		member.acceptedAt !== null &&
		(member.expiresAt === null || member.expiresAt > now)
	);
}

/**
 * Pure core: rows in, recipient ids out. No database, no clock of its own —
 * `now` is passed so expiry is deterministic under test.
 */
export function selectReviewRecipientIds(input: {
	project: { organizationId: string | null; userId: string | null };
	members: ReviewProjectMemberRow[];
	orgMembers: ReviewOrgMemberRow[];
	now: Date;
}): string[] {
	const { project, members, orgMembers, now } = input;

	// Path A — a personal project has exactly one reviewer, its owner.
	if (project.organizationId === null) {
		return project.userId ? [project.userId] : [];
	}

	const active = members.filter((m) => isActive(m, now));
	const activeIds = new Set(active.map((m) => m.userId));

	const recipients: string[] = [];
	for (const member of active) {
		if (canEditProjectSettings(resolveProjectPermissions(member.role))) {
			recipients.push(member.userId);
		}
	}

	// Path B — org role, but ONLY for users without an active project row.
	// Excluding the inactive ones too would drop an org admin whose project
	// invitation expired, who can still approve.
	for (const orgMember of orgMembers) {
		if (activeIds.has(orgMember.userId)) {
			continue;
		}
		if (canEditProjectSettings(resolveOrgPermissions(orgMember.role))) {
			recipients.push(orgMember.userId);
		}
	}

	return [...new Set(recipients)];
}

/**
 * Resolve the reviewers for a send, with the context both channels need.
 *
 * Returns `null` — "notify nobody" — only when the send is gone or is no longer
 * awaiting review.
 *
 * `organizationSlug` is reported, never enforced. `Organization.slug` is
 * nullable and the workspace route is `/app/{slug}/…`, so an absent slug makes
 * a correct absolute link impossible — but that is the EMAIL's problem, and the
 * email skips on it. Enforcing it here would take the in-app notification away
 * from a slugless organization too, which is a channel that works fine: its
 * link is context-relative and never interpolates a slug in this package.
 */
export async function resolveNewsletterReviewRecipients(
	sendId: string,
): Promise<ReviewRecipientContext | null> {
	const send = await db.newsletterSend.findUnique({
		where: { id: sendId },
		select: {
			id: true,
			status: true,
			projectId: true,
			organizationId: true,
			project: {
				select: { name: true, organizationId: true, userId: true },
			},
			organization: { select: { slug: true } },
		},
	});
	if (!send?.project || send.status !== "PENDING_APPROVAL") {
		return null;
	}

	const members = await db.projectMember.findMany({
		where: { projectId: send.projectId },
		select: {
			userId: true,
			role: true,
			acceptedAt: true,
			expiresAt: true,
		},
	});
	const orgMembers = send.project.organizationId
		? await db.member.findMany({
				where: { organizationId: send.project.organizationId },
				select: { userId: true, role: true },
			})
		: [];

	const userIds = selectReviewRecipientIds({
		project: {
			organizationId: send.project.organizationId,
			userId: send.project.userId,
		},
		members,
		orgMembers,
		now: new Date(),
	});

	const context: ReviewRecipientContext = {
		sendId: send.id,
		projectId: send.projectId,
		projectName: send.project.name,
		organizationId: send.organizationId,
		organizationSlug: send.organization?.slug ?? null,
		recipients: [],
	};
	if (userIds.length === 0) {
		return context;
	}

	const [users, prefs] = await Promise.all([
		db.user.findMany({
			where: { id: { in: userIds } },
			select: { id: true, email: true },
		}),
		db.notificationPreference.findMany({
			where: { userId: { in: userIds }, organizationId: "" },
			select: { userId: true, reviewEmails: true },
		}),
	]);
	const emailById = new Map(users.map((u) => [u.id, u.email ?? null]));
	// Opt-out model: a missing preference row means enabled, so only an
	// explicit false suppresses the email.
	const optedOut = new Set(
		prefs.filter((p) => p.reviewEmails === false).map((p) => p.userId),
	);

	context.recipients = userIds.map((userId) => ({
		userId,
		email: emailById.get(userId) ?? null,
		reviewEmails: !optedOut.has(userId),
	}));
	return context;
}
