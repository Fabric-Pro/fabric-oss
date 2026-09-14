/**
 * Contributor name lookup shared by the publishing generation families.
 *
 * Not an activity, and deliberately not reachable from the worker's activity
 * barrel: it is a set of bare database reads keyed by a caller-supplied project
 * id, and registering it would hand Temporal a schedulable name lookup whose
 * only guard is that id.
 */

import { db } from "@repo/database";

/**
 * Display names for the topic's already-resolved contributors, fenced to the
 * people who still have access to the project.
 *
 * The ids come from `effectiveContributorUserIds` — either the 1A resolver's
 * answer from the project's own stories, documents and PR authors, or a user
 * override. Neither source prunes itself when someone leaves: the resolver
 * derives its answer from the work, so the next resolve puts a departed author
 * straight back, and the override is checked only at WRITE time. Before this
 * fence that meant a person removed from a project kept having their name sent
 * to the configured AI provider on every subsequent generation for a topic they
 * had once contributed to. Eight generators call this helper, which is why the
 * fence is here and not in each of them.
 *
 * ## The three rungs, and why this ladder
 *
 * The predicate mirrors `resolveProjectAccess`
 * (`packages/database/prisma/queries/projects/projects.ts`) — the same ladder
 * the suite's own runtime re-check already asks through
 * `checkPublishingGenerationActor`:
 *
 *   A. the owner of a PERSONAL project, who may hold no `ProjectMember` row at
 *      all;
 *   C. an accepted, unexpired `ProjectMember` row — the project-scoped guest
 *      included;
 *   B. otherwise, membership of the project's host organization, which is what
 *      carries an organization's own staff (and the owner of an organization
 *      project, who has no rung A).
 *
 * All three, and in that shape, because the failure mode of getting this wrong
 * is asymmetric: a stale name is present and wrong, whereas a real author
 * dropped from attribution is invisible. A fence written as a bare
 * `ProjectMember` lookup passes every "former member is gone" case and
 * silently deletes both project owners and every org-role colleague from the
 * credits of all eight generators. `contributor-names.test.ts` holds an
 * over-fence guard for each rung.
 *
 * Rung C is not consulted before B as a veto: an EXPIRED project row does not
 * subtract the access an organization role already grants, matching
 * `resolveProjectAccess`'s fall-through exactly.
 *
 * ## What it costs, and what it deliberately does not do
 *
 * At most three queries for a personal project and four for an organization
 * one, whatever the contributor count — never a per-user access helper in a
 * loop, which across eight generators would be N round trips per generation.
 * Fewer when a read ends it early: a missing project stops after the first,
 * and when nobody survives the fence the name read is skipped.
 *
 * The accepted cost: a contributor who no longer has project access is now
 * absent from the prompt rather than named in it. That includes an id the 1A
 * resolver reached through a linked GitHub account without the person ever
 * being a project member (its design decision D3) — attribution is narrower
 * than authorship on purpose, because the name of someone with no standing on
 * the project is exactly what should not leave the database.
 *
 * A missing project row yields no names at all rather than falling back to an
 * unscoped read: there is nothing left to be a member of.
 *
 * Skipped entirely when the list is empty, which is both common and valid — no
 * query runs at all.
 *
 * ## What the fence replaced
 *
 * This read used to be justified by `updateTopicContributors` admitting into
 * an override only ids that were project members at write time, with that
 * check called out as the ONLY thing standing between this helper and a
 * name-disclosure oracle for arbitrary user ids. It no longer carries that
 * weight alone: a future writer of `userContributorUserIds` that skips the
 * write-time check cannot turn this into a directory query, because the fence
 * bounds the lookup independently of how the ids got there.
 */
export async function resolveContributorNames({
	contributorUserIds,
	projectId,
}: {
	contributorUserIds: string[];
	projectId: string;
}): Promise<{ id: string; name: string | null }[]> {
	if (contributorUserIds.length === 0) {
		return [];
	}

	const project = await db.project.findUnique({
		where: { id: projectId },
		select: { userId: true, organizationId: true },
	});
	if (!project) {
		return [];
	}

	const organizationId = project.organizationId;
	const [activeMemberships, orgMemberships] = await Promise.all([
		db.projectMember.findMany({
			where: {
				projectId,
				userId: { in: contributorUserIds },
				acceptedAt: { not: null },
				OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
			},
			select: { userId: true },
		}),
		organizationId === null
			? Promise.resolve([] as { userId: string }[])
			: db.member.findMany({
					where: {
						organizationId,
						userId: { in: contributorUserIds },
					},
					select: { userId: true },
				}),
	]);

	const projectMemberIds = new Set(activeMemberships.map((m) => m.userId));
	const orgMemberIds = new Set(orgMemberships.map((m) => m.userId));

	const withAccess = contributorUserIds.filter(
		(id) =>
			// A — personal-project owner
			(organizationId === null && id === project.userId) ||
			// C — accepted, unexpired project membership
			projectMemberIds.has(id) ||
			// B — membership of the project's host organization
			orgMemberIds.has(id),
	);
	if (withAccess.length === 0) {
		return [];
	}

	const users = await db.user.findMany({
		where: { id: { in: withAccess } },
		select: { id: true, name: true },
	});
	return users.map((u) => ({ id: u.id, name: u.name ?? null }));
}
