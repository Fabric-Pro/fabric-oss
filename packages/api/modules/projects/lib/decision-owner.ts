/**
 * Decision ownership: who is accountable for a decision, and how they are told.
 *
 * Lives beside the other project libs rather than in the procedures directory —
 * both the CRUD handlers and the meeting-ingestion flow route through it, and a
 * procedure importing a sibling procedure is the wrong direction of dependency.
 */

import { db } from "@repo/database";
import { logger } from "@repo/logs";
import { createNotification } from "../../../lib/notification-service";

/**
 * Active membership, matching what the project roster (`getProjectMembers`)
 * actually treats as a member — which is TWO things, not one:
 *
 *  - the project's creator/owner, who is synthesized into the roster and has
 *    NO ProjectMember row at all (checking only the table rejects the owner of
 *    the project — found on staging, where the owner could be offered in the
 *    Owner picker and then refused on save);
 *  - accepted, unexpired ProjectMember rows — so a pending invitation or a
 *    lapsed guest is still not a member.
 *
 * Anyone outside those two cannot be made accountable for a decision, nor
 * receive the notification that names it.
 */
export async function isActiveProjectMember(
	projectId: string,
	userId: string,
): Promise<boolean> {
	const project = await db.project.findFirst({
		where: { id: projectId, userId },
		select: { id: true },
	});
	if (project) {
		return true;
	}
	const member = await db.projectMember.findFirst({
		where: {
			projectId,
			userId,
			acceptedAt: { not: null },
			OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
		},
		select: { id: true },
	});
	return member !== null;
}

/**
 * Route a decision to its accountable owner: notify when someone is assigned
 * owner, and when an owned decision is edited by someone else. Best-effort and
 * self-skipping — a notification dispatch never blocks the save.
 */
export async function notifyDecisionOwner(
	decision: {
		id: string;
		projectId: string;
		identifier: string;
		title: string;
		ownerUserId: string | null;
	},
	actor: { id: string; name?: string | null; email?: string | null },
	organizationId: string | undefined,
	assigned: boolean,
): Promise<void> {
	if (!decision.ownerUserId || decision.ownerUserId === actor.id) {
		return;
	}
	try {
		let link = `/app/projects/${decision.projectId}?tab=decisions`;
		if (organizationId) {
			const org = await db.organization.findUnique({
				where: { id: organizationId },
				select: { slug: true },
			});
			if (org?.slug) {
				link = `/app/${org.slug}/projects/${decision.projectId}?tab=decisions`;
			}
		}
		const actorName = actor.name || actor.email || "Someone";
		await createNotification({
			userId: decision.ownerUserId,
			organizationId: organizationId ?? null,
			type: assigned
				? "DECISION_OWNER_ASSIGNED"
				: "DECISION_OWNER_UPDATED",
			category: assigned
				? "DECISION_OWNER_ASSIGNED"
				: "DECISION_OWNER_UPDATED",
			title: assigned
				? `${actorName} made you the owner of ${decision.identifier}`
				: `${actorName} updated ${decision.identifier}, which you own`,
			snippet: decision.title,
			link,
			source: {
				projectId: decision.projectId,
				actorUserId: actor.id,
			},
			payload: {
				decisionId: decision.id,
				projectId: decision.projectId,
				identifier: decision.identifier,
				actorUserId: actor.id,
			},
			// Stable across saves on purpose: the version bumps on EVERY save, so a
			// version-keyed dedupe never coalesces and each edit re-emails/re-webhooks
			// the owner. Keyed on (decision, owner) it collapses a burst of edits into
			// one unread row until they read it — the fanOut.subscriptionUpdate pattern.
			dedupeKey: `decision-owner:${decision.id}:${decision.ownerUserId}`,
		});
	} catch (error) {
		logger.warn(
			`[ADL] Failed to notify decision owner for ${decision.id}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}
