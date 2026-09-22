import { db } from "@repo/database";
import {
	type Permission,
	resolveOrgPermissions,
	resolveProjectPermissions,
} from "@repo/permissions";

export type EffectiveProjectAccess = {
	/** The caller's effective project permissions, project-authoritative. */
	permissions: readonly Permission[];
	/** Which path granted them — for side-effect decisions in the middleware. */
	source: "owner" | "project-member" | "org" | "none";
	organizationId: string | null;
};

/**
 * Resolve the caller's effective project permissions with the SAME precedence
 * as `requireProjectPermission` (the project-authoritative model):
 *   A. personal-project owner → OWNER permissions
 *   C. an active (accepted, non-expired) ProjectMember row is AUTHORITATIVE —
 *      its role decides, and the org role is NOT consulted
 *   B. otherwise, fall back to the caller's org role on the project's host org
 *
 * Returns `null` when the project does not exist. This is the shared resolver
 * the middleware and `tags.remove` both use — do NOT reintroduce the org-first
 * `userHasProjectPermission` for authoritative project decisions.
 *
 * ## Two duplicates live in @repo/database — change them WITH this one
 *
 * `@repo/api` depends on `@repo/database` and not the reverse, so background and
 * in-database callers cannot import this function and re-implement the A → C → B
 * precedence above instead:
 *
 *   - `packages/database/prisma/queries/newsletter-review-recipients.ts`
 *     (`selectReviewRecipientIds`, predicate `PROJECT_SETTINGS_EDIT`)
 *   - `packages/database/prisma/queries/projects/publishing-recipients.ts`
 *     (`selectPublishingRecipientIds`, predicate `PUBLISHING_TOPIC_CREATE`)
 *
 * Both say so at their top and point back here. This pointer is the other half of
 * that arrangement and the half that actually makes it work: the duplication is
 * only defensible if a change made HERE — where the authority lives, and where
 * nobody is thinking about background recipients — is discoverable. Changing the
 * precedence, the paths, or what an "active" ProjectMember means without updating
 * both files silently gives notifications a different answer than the API.
 */
export async function resolveEffectiveProjectPermissions(
	projectId: string,
	userId: string,
): Promise<EffectiveProjectAccess | null> {
	// The project row and the caller's ProjectMember row are keyed by the same two
	// arguments and neither reads the other, so they go out together. This runs on
	// every project-scoped request, and serially it cost two round trips before the
	// common case (an organization project whose caller has a member row) could be
	// decided at all.
	//
	// The trade is one wasted point-lookup on the personal-owner path below, which
	// returns before it would have needed `member`. That path keeps its single
	// round trip — it just also issues an indexed lookup it discards. Latency is
	// equal or better everywhere; only that one path pays a query for it.
	const [project, member] = await Promise.all([
		db.project.findUnique({
			where: { id: projectId },
			select: { id: true, organizationId: true, userId: true },
		}),
		db.projectMember.findUnique({
			where: { projectId_userId: { projectId, userId } },
			select: { role: true, acceptedAt: true, expiresAt: true },
		}),
	]);
	if (!project) {
		return null;
	}

	// PATH 1 — PERSONAL-PROJECT OWNER. Named, not lettered: this file and
	// `../orpc/middleware/require-permission.ts` used to letter the same three
	// paths differently, and "path C" meant opposite rules in the two. See that
	// file's docblock.
	//
	// Note the second conjunct: an ORGANIZATION project's creator does NOT
	// arrive here, and `createProject` writes them no member row either, so
	// they reach path 3 and nothing else.
	if (project.userId === userId && project.organizationId === null) {
		return {
			permissions: resolveProjectPermissions("OWNER"),
			source: "owner",
			organizationId: null,
		};
	}

	// PATH 2 — ACTIVE PROJECT MEMBER, authoritative, checked BEFORE the org
	// fallback. Fetched above; the precedence is unchanged, only the fetch
	// moved.
	const memberActive =
		member !== null &&
		member.acceptedAt !== null &&
		(member.expiresAt === null || member.expiresAt > new Date());
	if (memberActive) {
		return {
			permissions: resolveProjectPermissions(member.role),
			source: "project-member",
			organizationId: project.organizationId,
		};
	}

	// PATH 3 — ORG-ROLE FALLBACK, and also the BOOTSTRAP. A freshly created
	// organization project has zero `ProjectMember` rows (the only two places
	// one is ever created are invitation acceptance), and path 1 cannot fire
	// for an organization project — so this is the only path by which ANY
	// caller, the project's creator included, holds any permission on a new
	// organization project at all. It is what lets someone reach
	// `PROJECT_MEMBERS_MANAGE` and create the first member row. Deleting it as
	// "just a fallback" would make every organization project inert from
	// birth.
	if (project.organizationId) {
		const orgMember = await db.member.findFirst({
			where: { organizationId: project.organizationId, userId },
			select: { role: true },
		});
		if (orgMember) {
			return {
				permissions: resolveOrgPermissions(orgMember.role),
				source: "org",
				organizationId: project.organizationId,
			};
		}
	}

	return {
		permissions: [],
		source: "none",
		organizationId: project.organizationId,
	};
}
